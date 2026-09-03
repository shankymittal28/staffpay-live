# 03 — RESTORE EXECUTOR SPECIFICATION

**Artifact name:** `apply017`
**Design principle:** the executor does not transform, does not validate business
meaning, and does not think. It applies one approved artifact, or it refuses.

Separating the generator (§01) from the executor is deliberate: the component
that *decides what the data should be* and the component that *changes production*
must never be the same thing. A single combined step would mean a transformation
bug reaches the database before any human or independent check sees the output.

---

## 1. Responsibilities (the complete list)

1. Load `manifest.json`, `manifest.sha256`, and `approval-record.md`.
2. Recompute the manifest hash and verify all three agree (§2).
3. Verify the pre-conditions (§3).
4. Apply the manifest's rows in the fixed order (§4).
5. Emit an execution log (§6).
6. On any abort after the first write, invoke rollback (§05).

Anything not on this list is out of scope for the executor, permanently.

## 2. Hash pinning

- Recompute SHA-256 over the manifest per §02 §4.
- Require: computed hash **==** `manifest.sha256` **==** the hash quoted in
  `approval-record.md`. Any disagreement → **REFUSE, no writes.**
- The approval record must name this specific incident and be signed by the
  owner. An approval that does not quote a hash is void by §02 §5.
- The executor accepts no override flag for this check. There is no `--force`.

## 3. Pre-conditions (all verified before the first write)

| # | Pre-condition | Failure action |
|---|---|---|
| P1 | Manifest status is `APPROVED` | REFUSE |
| P2 | Hash triple-match (§2) | REFUSE |
| P3 | Authenticated as the owner account; the session's user id matches the incident's recorded owner | REFUSE |
| P4 | `staff_employee`, `staff_payment`, `staff_attendance`, `staff_settlement` each return **0 rows** for this owner | REFUSE — a non-empty table means the world changed since the manifest was approved; a human must re-evaluate |
| P5 | Owner has confirmed the second backup copy (JSON) is in hand | REFUSE (playbook step 0) |
| P6 | The rollback rehearsal (§05 §6) has been completed and logged | REFUSE |

P4 is what makes "no duplicates" structural rather than hopeful: the executor
only ever writes into a proven-empty target, and it writes on a unique key.

## 4. Execution order (fixed, not configurable)

1. `staff_employee` — all 28 rows, one batch, upsert on `(owner_id, legacy_id)`.
2. Read-back checkpoint: 28 rows present.
3. `staff_attendance` — all 10 rows, one batch, upsert on `(owner_id, legacy_id)`.
4. Read-back checkpoint: 10 rows present.

Staff precede attendance so that the roster exists before records that reference
it by name. Each batch is a single operation: partial application within a table
is either prevented by the server's batch semantics or detected at the read-back
checkpoint and rolled back (§08 F9).

The executor performs **no** transformation between reading the manifest and
sending the row. Bytes in the manifest are the bytes sent, with the single
documented exception that `owner_id` is *omitted* and supplied by the database
default — the executor never sets it, which is what prevents cross-account writes.

## 5. Abort conditions

Any of the following aborts immediately:

- Hash mismatch or missing/void approval (§2).
- Any pre-condition P1–P6 unmet (§3).
- Any non-2xx response from the database.
- A read-back checkpoint returning a count other than the expected one.
- Any row rejected by a constraint.
- Loss of connectivity mid-batch.
- Any duplicate detected at a checkpoint.

There is no retry loop that could mask a failure. A transient network error is
treated as an abort; re-running after rollback is safe **because** re-application
is idempotent — retrying blindly is not, and is therefore forbidden.

## 6. Evidence produced

`execution-log.txt`, containing: start/end timestamps, operator identity, the
three hashes, each pre-condition result, each batch's request summary and
response status, each read-back count, and the final disposition
(`APPLIED` | `REFUSED` | `ABORTED+ROLLED_BACK`). The log is append-only and is
part of the evidence package (§06).

## 7. Rollback trigger

**Rollback is triggered automatically by any abort that occurs after the first
successful write**, and is pre-authorised by the same approval that authorises
execution (§05 §5). Rationale: requiring a fresh human approval to undo a
half-applied state would leave production in the worst possible condition while
waiting for a signature. Undo is always permitted; only *doing* requires
approval.

If rollback itself fails, the executor stops, writes `ROLLBACK FAILED` with the
exact remaining row identifiers to the log, and escalates to a human. It does not
attempt creative repair.
