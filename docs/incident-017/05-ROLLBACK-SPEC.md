# 05 — ROLLBACK SPECIFICATION

Rollback is specified with the same rigour as recovery, because an unrehearsed
rollback is not a safety net — it is a second, worse incident performed under
pressure.

---

## 1. The reversibility guarantee is structural, not procedural

Reversibility here does not depend on anyone behaving correctly under stress. It
follows from four design properties, each independently verifiable:

1. **Exactly one state-changing step exists** (Gate B's write), so "halfway" is a
   precisely defined position, not a guess.
2. **The write is additive into proven-empty tables** (pre-condition P4), so
   removing the added rows returns the system to its prior state exactly — there
   is no prior state to reconstruct.
3. **Every written row is enumerated in advance** by the manifest, so reversal is
   a lookup, not a search.
4. **Nothing else changes before Gate C** — no phone, no code, no schema — so the
   guarantee cannot decay over time.

## 2. Rollback artifact

`rollback-list.txt` — the 38 identifiers (28 `stf_*` + 10 numeric attendance
ids), **extracted from the approved manifest, never re-derived from the backup**.

This distinction matters: re-deriving could produce a different list if the tool
or the evidence changed, and a rollback that deletes something it did not write
is a data-loss event. The list is generated at the same moment as the manifest,
carries the same `MANIFEST_HASH`, and is stored beside it.

## 3. Rollback executor

**Artifact:** `rollback017`. Responsibilities:

1. Verify the rollback list's `MANIFEST_HASH` matches the manifest that was applied.
2. Delete **only** the enumerated identifiers, scoped to this owner, in reverse
   execution order: `staff_attendance` first, then `staff_employee`.
3. Emit `rollback-log.txt`.

**Forbidden absolutely:** table truncation; deletion by wildcard, date range, or
"everything created today"; touching `staff_payment`, `staff_settlement`,
`staff_device_backup`, or any table outside the two written; deleting any row not
on the list; deleting anything on another account.

Reverse order (attendance before staff) mirrors the write order so that no
referential state is left dangling at any intermediate moment.

## 4. Rollback verification (its own gate)

| Check | Success criterion |
|---|---|
| Counts | `staff_employee` = 0, `staff_attendance` = 0 for this owner |
| Collateral | `staff_payment` = 0 and `staff_settlement` = 0 (unchanged); no other table's counts altered |
| Vault | The backup row is present and its `BACKUP_HASH` still matches |
| Devices | Both phones untouched — guaranteed by the freeze; asserted explicitly in the log |
| Residue | The 38 identifiers return zero rows |

Failure of any check stops everything and escalates to a human with the exact
remaining identifiers named. The rollback executor never improvises.

## 5. Rollback approval

**Rollback is pre-authorised by the same owner approval that authorises
execution.** The approval record states this explicitly.

Rationale: requiring a fresh signature to *undo* would strand production in a
half-applied state while waiting for a human — the worst of all outcomes.
Asymmetry is deliberate and is the correct safety posture: **doing requires
approval; undoing never does.**

A *deliberate* rollback after a successful execution (as opposed to an
abort-driven one) does require a fresh owner decision, because at that point the
system is in a good state and leaving it is a choice.

## 6. Rollback rehearsal (mandatory pre-condition P6)

Before any production execution, the full cycle is rehearsed in the sealed
harness against a mock database: write 38 → verify 38 → roll back → verify 0 →
verify the backup and mock phones untouched. The rehearsal produces
`rollback-rehearsal-report.txt`, and the executor refuses to run without it.

An unrehearsed rollback path is treated as a non-existent rollback path.

## 7. What survives every possible outcome

| Artifact | Survives? | Why |
|---|---|---|
| Vault backup row | **Always** | Write-once by grant design: the app role holds INSERT and SELECT only — no UPDATE, no DELETE. Nothing in this package can alter it |
| Owner's downloaded JSON | **Always** | Off-system, in the owner's possession |
| Manifest + hashes | Always | Content-addressed; superseded copies retained |
| Incident log and gate reports | Always | Append-only evidence |
| Both phones' data | Always, up to Gate C | Total freeze; nothing in recovery reads or writes a device |
| Application code | Always | Recovery ships no code (Rule 8) |
| Schema | Always | Recovery creates no tables and alters no columns |
| Project Zero | Always | Out of scope entirely |

## 8. After Gate E: rollback is retired

Once the phones are reintegrated and authority has transferred to the cloud,
rolling back would delete rows that the phones have since confirmed and possibly
built upon. From that point corrections are **forward operations** performed in
the app by the owner, exactly like any ordinary business correction. The rollback
artifacts are archived, and the incident log records the retirement explicitly so
no future engineer mistakes them for a live capability.
