# INCIDENT 017 — StaffPay Cloud Recovery Package

**Status:** SPECIFICATION COMPLETE — NOT EXECUTED
**Owner (sole approver):** Shanky Mittal — shankymittal28@gmail.com
**Prepared:** 2026-09-03
**Production application state at time of writing:** FROZEN (unchanged, RC4 `rc4-20260902`)

---

## What this package is

A complete, self-contained recovery system for Incident 017, written so that **an
engineer with no prior context can execute it months from now** and produce a
defensible result. Nothing in this package has been executed. No production data
has been modified by any document here.

Read the documents in order:

| # | Document | Purpose |
|---|---|---|
| 01 | `01-RECOVERY-TOOL-SPEC.md` | The one-time generator: backup → manifest |
| 02 | `02-RECOVERY-MANIFEST-SPEC.md` | The canonical, hash-addressed recovery artifact |
| 03 | `03-RESTORE-EXECUTOR-SPEC.md` | The applier: manifest → database, nothing else |
| 04 | `04-VERIFICATION-SPEC.md` | Seven independent gates, no stage verifies itself |
| 05 | `05-ROLLBACK-SPEC.md` | Reversal, specified as rigorously as recovery |
| 06 | `06-EVIDENCE-PACKAGE.md` | Exactly what must survive after closure |
| 07 | `07-OPERATIONAL-PLAYBOOK.md` | The execution script for the engineer on the day |
| 08 | `08-FAILURE-ANALYSIS.md` | Every anticipated failure, with containment |
| 09 | `09-FINAL-AUDIT.md` | External-auditor review and conditional sign-off |
| A | `APPENDIX-A-EXPECTED-CONTENT.md` | The 28 staff and 10 attendance records for human review |

---

## The incident in one paragraph

StaffPay was migrated from browser storage to Supabase. The four `staff_*` tables
were created **after** a June 2026 security-hardening migration changed the
database's default privileges, so they were born without `SELECT/INSERT/UPDATE/
DELETE` for the `authenticated` role. Every sync request from the owner's phone
was refused with HTTP 403 **before** row-level security was consulted. The
application's offline design fell back to local cache, so the owner's screen
looked normal for six days while the cloud stayed empty. A second device (Raj's
phone, RC4 attendance window) had no local cache and exposed the truth. Database
permissions were repaired on 2026-09-03; the cloud is correct but empty. All
business data survives on the owner's phone and in a verified immutable backup.

---

## Verified facts (evidence-backed — treat as true)

| Fact | Evidence |
|---|---|
| Cloud `staff_employee`, `staff_payment`, `staff_attendance`, `staff_settlement` = 0 rows | Direct count, re-verified 2026-09-03 |
| Immutable backup exists in vault | `staff_device_backup` row `b62e47f3-dda9-440a-93ce-77d829ad89ec`, captured `2026-09-03T16:04:01.653Z` |
| Second copy exists | JSON file downloaded by owner (owner-held; **must be confirmed present before execution**) |
| Backup contains 28 staff | `sp_cloud_cache:staffpay_staff_master_v1` (28 names) |
| Backup contains 28 salary profiles | `sp_cloud_cache:staffpay_profiles_v1` (28 entries, salary + wage type + group) |
| Backup contains 10 attendance records | `sp_cloud_cache:staffpay_attendance_v1` (2026-08-29) |
| Upload queue holds 10 ops, **all** `staff_attendance` upserts | `sp_cloud_outbox` — zero staff-creation operations |
| Payments / settlements / opening balances never existed | Legacy slots empty `[]`; owner's in-app backup of 2026-09-01 counted 10 records total |
| Cloud permissions repaired and proven | Migration `staff_grant_authenticated_dml_mission017`; 8/8 role-impersonation proofs |
| Owner account | `shankymittal28@gmail.com`, uid `b96b7056-f8da-491b-ba3c-558d620c5010` |

## Stated assumptions (NOT facts — must be re-verified at execution)

| ID | Assumption | How it is verified |
|---|---|---|
| ASSUME-1 | No StaffPay use occurred after the backup capture | Gate D0 drift check (§04) — **not** provable from the backup alone |
| ASSUME-2 | The owner still holds the downloaded JSON copy | Explicit confirmation, playbook step 0 (§07) |
| ASSUME-3 | The vault backup row is unaltered | `BACKUP_HASH` comparison at tool start (§01) |

---

## Non-negotiable rules governing this package

1. Recovery never depends on opening the production app.
2. Recovery never executes application migration logic.
3. Recovery never depends on browser state or localStorage.
4. Recovery never executes production code.
5. Recovery is deterministic — identical input, byte-identical manifest.
6. Recovery is independently auditable.
7. Recovery is reversible.
8. Recovery and application deployment are **separate missions**.
9. The production application may only **verify** recovered data, never generate it.
10. Every state-changing operation is hash-pinned to an approved artifact.
11. Nothing executes automatically. Every gate requires evidence; two require a human.

### Boundary clarification (read this before invoking Rule 4)

The application's **source code is used as written specification** — its field
mappings are cited so the restored rows are shaped exactly as the app expects.
Reading and citing code is not executing it. The app is *executed* only once, at
Gate C, in a sealed offline harness, on a **copy** of the restored data, acting
solely as an independent verifier. It never generates, transforms, or writes.

### Scope boundary: RECOVERY vs REINTEGRATION

- **RECOVERY** (Gates A1 → C) restores the cloud. Entirely app-free. Rules 1–11 hold absolutely. Recovery is DECLARED COMPLETE at Gate C, before any phone is touched.
- **REINTEGRATION** (Gates D0 → E) returns the phones to service. The app necessarily runs — as an ordinary client of an already-healthy cloud, never as a recovery engine.

These are separate missions with separate approvals. Any claim that the phones
can be reconciled without ever running the app is false: "queue empty" and "both
phones show identical staff" are success criteria that only the running app can
satisfy. The honest boundary is drawn above, not hidden.

### Sunset clause (mandatory)

The backup is the Source of Truth **for the duration of this incident only**. At
Gate E the authority transfers to the cloud and is recorded in the incident log.
After that moment, this package is a historical artifact. Restoring from it
against a live cloud would destroy newer data. Any future use requires a fresh
incident, fresh evidence, and a fresh tool.

---

## Standing operational order, in force NOW

**TOTAL FREEZE: neither phone opens StaffPay — online or offline — until Gate D
is announced.** The backup page (`backup.html`) remains safe to open at any time;
it is read-only and touches no application data.

Rationale: the phone still runs the defective build. Any use creates data that
the phone cannot upload and that reintegration may overwrite. The freeze, not
architecture, is what protects the gap — this is the package's single largest
dependency on human discipline, and it is stated plainly rather than buried.
