# 07 — OPERATIONAL PLAYBOOK

Written for an engineer executing this months from now, with no prior context.
Read `README.md`, `01`, `02`, `03`, `04`, `05` first — this document assumes them.

**Rules of engagement**
- No step assumes the previous one succeeded; each re-verifies.
- Every step produces a file in `evidence/`.
- Every step names its abort condition and its rollback point.
- If a step's outcome is unclear, **stop**. Ambiguity is an abort, not a judgement call.
- Steps 0–8 are RECOVERY. Steps 9–12 are REINTEGRATION, a separate mission with its own go/no-go.

---

## PHASE 0 — Preparation (no system is touched)

### Step 0 — Confirm the standing freeze and the second copy
- **Action:** Confirm with the owner: (a) neither phone has opened StaffPay — online or offline — since the freeze began; (b) the owner still holds the downloaded JSON backup file.
- **Actor:** engineer + owner.
- **Evidence:** `backup-reference.md` (both confirmations, dated).
- **Abort if:** the JSON copy cannot be located → **do not proceed on a single copy.** Take a fresh backup with `backup.html` first, then restart at Step 0.
- **Abort if:** a phone has been used → skip nothing; proceed, but Step 9 (Gate D0) becomes mandatory-blocking rather than confirmatory, and expect a superseding manifest.
- **Rollback point:** n/a.

### Step 1 — Verify the target is still empty
- **Action:** Count rows in all four `staff_*` tables for the owner.
- **Evidence:** counts recorded in `gate-B-report.txt` (pre-section).
- **Abort if:** any table is non-empty → the world changed; re-run the investigation before touching anything. Never write "on top of" unexplained rows.
- **Rollback point:** n/a.

### Step 2 — Verify cloud permissions are still correct
- **Action:** Confirm the `authenticated` role still holds SELECT/INSERT/UPDATE on `staff_employee` and SELECT/INSERT/UPDATE/DELETE on the other three, and that RLS policies remain owner-scoped.
- **Evidence:** appended to `gate-B-report.txt` (pre-section).
- **Abort if:** any grant is missing → recovery would fail mid-flight with 403s. Repair permissions as a separate action, re-verify, then restart at Step 1.
- **Rollback point:** n/a.

---

## PHASE 1 — Generate and check (still nothing written)

### Step 3 — Run the recovery tool
- **Action:** Run `recover017` against vault row `b62e47f3-dda9-440a-93ce-77d829ad89ec`.
- **Evidence:** `manifest.json`, `manifest.sha256`, `rollback-list.txt`.
- **Abort if:** the tool aborts for any reason (§01 §6). Do not re-run with modifications; investigate the evidence.
- **Rollback point:** n/a.

### Step 4 — Gate A1: independent check
- **Action:** Run `check017`. Then run `recover017` a **second** time and compare hashes.
- **Evidence:** `gate-A1-report.txt`.
- **Abort if:** any diff, or the two hashes differ (determinism failure). A determinism failure invalidates the whole approach — stop and fix the tool before anything else.
- **Rollback point:** n/a.

### Step 5 — Gate A2: owner approval
- **Action:** Present `roster-table.md` — 28 names with salary, wage type, group — in plain language. Ask the owner to confirm each is correct and none is missing. Obtain written approval **quoting `MANIFEST_HASH`**.
- **Evidence:** `approval-record.md`.
- **Abort if:** the owner disputes anything → generate a superseding manifest; return to Step 3. Never proceed intending to "fix it later in the app".
- **Rollback point:** n/a.

### Step 6 — Rollback rehearsal
- **Action:** In the sealed harness against a mock database: apply 38 → verify → roll back → verify zero → verify backup and mock devices untouched.
- **Evidence:** `rollback-rehearsal-report.txt`.
- **Abort if:** rehearsal fails in any respect. An unrehearsed rollback path counts as no rollback path.
- **Rollback point:** n/a.

---

## PHASE 2 — Execute (the only state-changing phase)

### Step 7 — Apply the manifest
- **Action:** Run `apply017`. It verifies pre-conditions P1–P6, writes `staff_employee` (28), checkpoints, writes `staff_attendance` (10), checkpoints.
- **Actor:** engineer, attended. Never scheduled, never unattended.
- **Evidence:** `execution-log.txt`.
- **Abort if:** any condition in §03 §5. Rollback triggers automatically and is pre-authorised.
- **Rollback point:** **ACTIVE from the first write onward** — `rollback017` with `rollback-list.txt`.

### Step 8 — Gate B: database verification
- **Action:** Full read-back; field-by-field diff against the manifest; duplicate check; owner-stamp assertion; confirm payments/settlements still 0.
- **Validator:** the database, not the executor's report.
- **Evidence:** `gate-B-report.txt`.
- **Abort if:** any difference → roll back, investigate, do not retry blindly.
- **Rollback point:** active.

### Step 9 — Gate C: application verification (recovery's final gate)
- **Action:** Run the unmodified shipping artifact in the sealed harness against a **copy** of the restored data. Confirm the 28-staff roster, salaries, groups, wage types, and that a simulated fresh device sees the identical list.
- **Evidence:** `gate-C-report.txt`.
- **Abort if:** any discrepancy → roll back. A database that is right but unreadable by the app is not a recovery.
- **Rollback point:** active — **this is the last point at which rollback is clean.**
- **Approval:** owner signs `recovery-complete-declaration.md`.

> **RECOVERY IS COMPLETE HERE.** No phone has been touched. If the mission stops
> at this line, the cloud is correct, both phones are intact, and the backup is
> untouched. Reintegration is a separate decision.

---

## PHASE 3 — Reintegration (separate mission, separate go/no-go)

### Step 10 — Gate D0: drift check
- **Action:** On the owner's phone, open **`backup.html` only** (never the app) and take a second capture. Diff it against the sealed original across all StaffPay data keys.
- **Evidence:** `gate-D0-report.txt`.
- **Abort if:** any drift in staff, profiles, attendance or queue → **halt reintegration**, fold the new data into a superseding manifest, and repeat Steps 3–9 before any phone opens the app.
- **Rollback point:** active (a superseding restore may require removing the current rows first).

### Step 11 — Gate D: owner's phone returns
- **Action:** The owner opens StaffPay once, online, and leaves it open ~30 seconds. Watch the request log live.
- **Expected:** all staff requests succeed; the 10 queued attendance operations flush onto the **same** rows (merge, not insert); counts stay 28/10; the screen shows all 28 staff.
- **Evidence:** `gate-D-report.txt` (log extract, post-flush counts, duplicate check, owner confirmation).
- **Abort if:** any failed request, a queue that will not drain, any count change, or a wrong roster on screen → **do not roll back the cloud**; the fault is device-side. Investigate before involving the second phone.
- **Rollback point:** cloud rollback is no longer the right instrument; escalate instead.

### Step 12 — Gate E: second device and closure
- **Action:** Raj refreshes StaffPay. Confirm an identical 28-staff roster. Run the final audit sweep (counts, duplicates, error scan).
- **Evidence:** `gate-E-report.txt`, then assemble the full evidence package (§06).
- **Abort if:** the two devices disagree in any way → stop and investigate; disagreement between devices is the exact signature of the original defect.
- **Approval:** owner signs `incident-closed-declaration.md`, which records the **authority transfer**: the cloud, not the backup, is now the source of truth.

---

## Post-closure

1. Retire the tools (§01 §7); mark them `EXECUTED` with hashes.
2. Retire the rollback capability (§05 §8) and record it.
3. Write `INCIDENT-017-FINAL-REPORT.md`.
4. Open the follow-on missions as **separate** work: the empty-cloud guard RC, and the Security Audit (second identity + RLS, grant hygiene). Neither may be bundled into this mission — Rule 8.

## Abort summary (memorise)

| Situation | Action |
|---|---|
| Anything unclear | Stop. Ambiguity is an abort |
| Any gate fails before Step 9 | Roll back, investigate, re-derive |
| Any gate fails after Step 9 | Do **not** roll back; escalate — live devices are involved |
| Tool aborts | Never re-run with different inputs to get past it |
| Owner disputes the roster | Superseding manifest, full re-cycle |
| Phone used during freeze | Gate D0 becomes blocking; expect a superseding manifest |
