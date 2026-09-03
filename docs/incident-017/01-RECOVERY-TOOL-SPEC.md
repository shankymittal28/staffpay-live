# 01 — RECOVERY TOOL SPECIFICATION

**Artifact name:** `recover017` (one-time, incident-scoped)
**Classification:** NOT production code. NOT deployable. NOT reusable.

---

## 1. Why a dedicated tool, and not the application's migration logic

The decision was re-derived four times independently and reaches the same
conclusion every time. Evaluated across the seven axes that matter:

| Axis | Application migration logic | Dedicated tool |
|---|---|---|
| **Trust boundary** | Sits *inside* this incident's failure boundary — markers, mirrors and boot order are what caused the loss | Sits entirely outside every implicated component |
| **Determinism** | **Provably impossible.** `newStaffId()` (staff-module.html:1940) is `'stf_' + Date.now().toString(36) + '_' + seq + random`. Clock and randomness in every identifier | Pure function of the backup; byte-identical across runs |
| **Auditability** | Behaviour entangled with ambient device state; cannot be read as a transformation | 38 rows × explicitly enumerated fields; reviewable line by line |
| **Dependency graph** | Depends on browser, localStorage, schema markers, boot order — 4 nodes, 3 of which already failed | Depends on 1 node: the immutable backup |
| **Repeatability** | Output varies with device state | Re-runnable against the sealed backup indefinitely |
| **Operational risk** | Requires the live device to participate | Runs offline on any machine |
| **Blast radius** | The production phone holding the only live copy | A file on disk |

**Self-challenge.** The strongest case for the migration logic is *fidelity*: it
already knows the app's defaulting rules. That case fails, because those rules
are six lines of documented behaviour (§4.4) which this tool replicates **with
source citations**, and which are independently re-confirmed at Gate C by the
unmodified application itself. The fidelity benefit is captured in full, at none
of the risk. The determinism row alone is disqualifying: Rule 5 cannot be
satisfied by code that mints identifiers from `Date.now()` and `Math.random()`.

---

## 2. Responsibilities

1. Read the verified backup from the vault, addressed by row id.
2. Verify the backup's integrity against a recorded hash before using it.
3. Perform the enumerated transformation in §4.
4. Emit exactly two outputs: the Recovery Manifest and its content hash.
5. Abort — producing **no output file at all** — on any assumption violation.

## 3. Explicit NON-responsibilities

The tool does **not**: validate its own output (Gate A1 is separate code);
write to any database; apply anything; contact any phone; decide anything;
retry anything; interpret ambiguity. Where the evidence is ambiguous it aborts.
It has no "best effort" mode. Silence and partial success are both forbidden.

## 4. Inputs, algorithm, outputs

### 4.1 Inputs (exactly one)

- The vault backup row `b62e47f3-dda9-440a-93ce-77d829ad89ec` from
  `staff_device_backup`, read-only, in project `bsjrihrekfsxmajdsyhc`.
- No other input. No configuration. No flags that alter output.

### 4.2 Deterministic algorithm

Each step is mandatory and ordered. Any ABORT terminates with no output.

**Step 1 — Source integrity.** Fetch the row. Assert `payload.kind` is exactly
the literal `device_backup_raw_v1`. Canonically serialise `payload` (§02 rules)
and compute SHA-256 → `BACKUP_HASH`. If a
`BACKUP_HASH` is already recorded in the incident log, it must match, else ABORT.
If none is recorded, this run records it as the reference for all future runs.

**Step 2 — Source extraction.** Read exactly three keys from `payload.keys`:
- `P` = `sp_cloud_cache:staffpay_profiles_v1` (object, name → profile)
- `M` = `sp_cloud_cache:staffpay_staff_master_v1` (array of names)
- `Q` = `sp_cloud_outbox` (array of queued operations)

Additionally read `A` = `sp_cloud_cache:staffpay_attendance_v1` for cross-checking
only (never as a source of manifest rows). Parse each as JSON; a parse failure is
an ABORT. **No other key participates in the manifest.**

*Why the cache keys and not the legacy keys:* the app writes through the storage
seam, which persists to the cache slots. The legacy slots (`staffpay_v4`,
`staffpay_staff_master_v1`, …) contain `[]` and are historical debris of the
pre-cloud era. This distinction is the single most important fact in the tool;
choosing wrong yields an empty, silently "successful" recovery.

**Step 3 — Roster reconciliation.** Assert `set(keys(P)) == set(M)` exactly.
Neither a union nor an intersection is permitted: an asymmetry means the evidence
is internally inconsistent and a human must decide. ABORT on any difference,
naming the differing entries.
*Expected at time of writing: both are the same 28 names.*

**Step 4 — Staff row construction.** Process names in ascending Unicode order of
their canonical form (deterministic ordering, independent of source order).

*Canonical form:* trim; collapse internal whitespace runs to one space;
lowercase; replace space with `_`; remove any character outside `[a-z0-9_]`.

*Identifier:* `legacy_id = "stf_" + canonical(name)`.
Assert all 28 identifiers are distinct. A collision means two staff differ only
by case or spacing — a business question, never a machine decision. ABORT.

*Row fields* (mapping cited from `staff-cloud.js` `Map2.employeeRow` and
`Map2.employeesToProfiles`, so the app reads back exactly what it would write):

| Field | Value | Source citation |
|---|---|---|
| `legacy_id` | as above | deterministic (§4.2 Step 4) |
| `name` | verbatim from `M` (never canonicalised) | master list |
| `work_group` | `P[name].group === "workshop" ? "workshop" : "shop"` | employeeRow |
| `phone` | `P[name].phone \|\| ""` | employeeRow |
| `active` | `P[name].active !== false` | employeeRow |
| `salary` | `Number(P[name].salary) \|\| 0` (integer) | employeeRow |
| `wage_type` | `P[name].wageType === "daily" ? "daily" : "monthly"` | employeeRow |
| `opening_balance` | `round(Number(P[name].openingBalance) \|\| 0)` | employeeRow (RC3) |
| `source` | `"staff"` | app convention for master-listed staff |
| `removed` | `false` | no staff was ever deleted (verified: no blocklist key exists) |
| `device` | `"recovery-017"` | provenance marker, non-business field |

**`owner_id` is deliberately absent from every manifest row.** It is supplied by
the database column default (`auth.uid()`) at apply time. Consequence: the
manifest is structurally incapable of addressing any account other than the one
executing it. This is a security property, not an omission.

**Step 5 — Attendance row construction.** For each element of `Q` with
`table == "staff_attendance"` and `op == "upsert"`, take `row` **verbatim**:
`legacy_id`, `staff_id`, `name`, `status`, `note`, `date`, `month_key`,
`day_key`, `device`. No field is recomputed.

`staff_id` is `null` in every queued row and **remains null in the manifest.**

> **Design correction, recorded deliberately.** An earlier architecture draft
> described attendance rows as carrying "staff-identifier links". That was wrong
> and is superseded here. `staff_attendance.staff_id` is a UUID foreign key to
> `staff_employee.id`, which is generated server-side and therefore unknowable at
> manifest time. Linking would require the executor to read back UUIDs and
> re-transform — making the executor "think" and destroying determinism. Leaving
> `staff_id` null is not a compromise: it makes each manifest row **byte-identical
> to the operation the phone itself has queued**, which is precisely what
> guarantees the later queue flush merges instead of duplicating. The app matches
> attendance to staff by name (`staffMatcher`) and re-stamps ids on a later boot.

*Cross-check:* the set of `legacy_id` in `Q` must equal the set of `id` (as
strings) in `A`. ABORT on mismatch — it would mean the queue and the local
attendance record disagree, which no automated rule may resolve.
*Expected at time of writing: 10 ↔ 10.*

**Step 6 — Assembly.** Build the manifest per §02: provenance header, staff rows
(ordered by `legacy_id`), attendance rows (ordered by `legacy_id`), expected
counts, per-table content hashes. Canonically serialise; compute SHA-256 →
`MANIFEST_HASH`.

**Step 7 — Emission.** Write `manifest.json` and `manifest.sha256`. Print the
hash. Exit. The tool performs no further action, ever.

### 4.3 Outputs

- `manifest.json` — the canonical recovery artifact (§02).
- `manifest.sha256` — its content hash, the value all later stages pin to.
- A human-readable console summary (counts + the roster table) — **advisory
  only; it is not evidence and no gate may cite it.** (Rationale: the backup
  page's summary card was wrong once already in this very incident, while its
  raw capture was correct. Summaries are never trusted.)

### 4.4 Forbidden operations (hard constraints)

Network writes of any kind · any database write · reading localStorage, the
phone, or any live device · importing or invoking application code · using
`Date.now()`, clocks, randomness, locale, or environment in output · mutating
the backup · running unattended, scheduled, or in CI · emitting partial output ·
"fixing" inconsistent evidence.

## 5. Assumptions, each with its verification

| ID | Assumption | Verified by |
|---|---|---|
| T-A1 | The vault row is the correct, unaltered backup | Step 1 hash comparison |
| T-A2 | Profiles and master describe the same roster | Step 3 (ABORT) |
| T-A3 | Names are distinct after canonicalisation | Step 4 (ABORT) |
| T-A4 | Queue and attendance cache agree | Step 5 (ABORT) |
| T-A5 | The app's defaulting rules are as cited | Gate C — the app itself, independently |
| T-A6 | Target tables are empty | **Not the tool's business** — executor precondition (§03) |

## 6. Failure conditions

Any ABORT produces: a non-zero exit, a diagnostic naming the failed step and the
offending data, and **no manifest file**. There is no partial manifest, no
warning-and-continue, and no operator override inside the tool. A disputed ABORT
is resolved by a human amending the evidence or the specification — never by
re-running with different flags, of which there are none.

## 7. Retirement procedure

1. After Gate E closes, append to the tool's header: `EXECUTED`, the execution
   date, `BACKUP_HASH`, `MANIFEST_HASH`.
2. Move it to `docs/incident-017/executed/`.
3. It is never invoked again. A future incident gets fresh evidence and a fresh
   instrument.

**Why it must never become production code:** the tool is *assumption-frozen* —
empty cloud, no pre-existing identifiers, these exact 28 names. Those are
verified facts today and unverified hazards on any other day. Production code
must either be assumption-free or assumption-checking; this tool embodies its
assumptions instead. **Why it must never be auto-reused:** automatic reuse is
frozen assumptions meeting unverified live state — the exact failure pattern
that produced this incident.
