# 04 — VERIFICATION SPECIFICATION

Verification is designed as an **independent system**, not as a step that happens
afterwards. The governing rule: **no stage may verify itself.** Each gate's
validator is a different kind of authority from the thing it judges — separate
code, the database's own constraints, the pre-existing application, a human, or
production reality.

```
BACKUP ─A1─▶ MANIFEST ─A2─▶ APPROVAL ─B─▶ DATABASE ─C─▶ APPLICATION ║ ─D0─▶ ─D─▶ PHONE 1 ─E─▶ PHONE 2
        (checker)    (human)      (database)    (frozen app)  ║  (backup page)(logs+owner)  (Raj+audit)
                                                              ║
                                            RECOVERY COMPLETE ║ REINTEGRATION BEGINS
```

Everything left of the double bar is app-free. Recovery is **declared complete at
Gate C**, before any phone is involved.

---

## Gate A1 — Backup → Manifest

- **Purpose:** prove the manifest is a faithful, complete, deterministic function of the backup.
- **Inputs:** backup payload; `manifest.json`; `manifest.sha256`.
- **Validator:** the **checker** — a separate code path from the generator, which re-derives its expectations directly from the backup rather than reading the generator's intermediate state.
- **Success criteria:** every backup name appears exactly once in the manifest (28/28); salary, wage type and group match profile-for-profile; all 10 attendance rows byte-equal their queue originals; identifiers unique; `staff_id` null on all attendance rows; no `owner_id` present anywhere; regenerating the manifest yields an **identical hash** (determinism proof); row-set hashes match the manifest's own expectations block.
- **Failure criteria:** any diff whatsoever; any hash mismatch; a second generation producing a different hash.
- **Evidence:** `gate-A1-report.txt` (diff output + both generation hashes).
- **Rollback point:** none required — nothing has changed.
- **Approvals:** none (machine gate).

## Gate A2 — Manifest → Approval (human)

- **Purpose:** validate **business truth**, which no machine in this system holds. Only the owner knows that Lakeshwar earns ₹930/day.
- **Inputs:** the human-readable roster table (Appendix A format): 28 names, salary, wage type, group.
- **Validator:** **the owner.** No JSON is presented; approval is of meaning, not syntax.
- **Success criteria:** the owner confirms every name belongs, no one is missing, and every salary/group/wage type is correct; the owner records written approval quoting `MANIFEST_HASH`.
- **Failure criteria:** any name, salary, group or wage type disputed; any absent staff member; approval given without a hash (void).
- **Evidence:** `approval-record.md`.
- **Rollback point:** none required — nothing has changed.
- **Approvals:** this gate *is* the approval.

> If the owner finds an error here, that is a **success of the process**: it means
> the phone's data was wrong before the incident, and it is corrected in a
> superseding manifest — never by hand-editing the database later.

## Gate B — Manifest → Database

- **Purpose:** prove the database contains exactly the approved manifest and nothing else.
- **Inputs:** post-write database contents; `manifest.json`.
- **Validator:** **the database itself** — full read-back and constraint state, not the executor's own claims of success.
- **Success criteria:** `staff_employee` = 28 rows and `staff_attendance` = 10 rows for this owner; a field-by-field diff against the manifest yields **zero** differences; duplicate check on `(owner_id, legacy_id)` returns none; **every row's `owner_id` equals the incident's recorded owner id**; `staff_payment` and `staff_settlement` remain at 0.
- **Failure criteria:** any count mismatch, any field difference, any duplicate, any row owned by another account.
- **Evidence:** `gate-B-report.txt` (counts, diff result, duplicate query result, owner-stamp assertion).
- **Rollback point:** **first rollback point.** On failure, delete the 38 manifest identifiers (§05).
- **Approvals:** none (machine gate), but a failure escalates to the owner.

## Gate C — Database → Application

- **Purpose:** prove the **application** can read the restored data correctly. The database being right is necessary but not sufficient; the app is the consumer.
- **Inputs:** a sealed **copy** of the restored data; the unmodified shipping artifact (`rc4-20260902`).
- **Validator:** **the production application itself**, executed offline in the harness against a mock cloud — as a judge only. It touches nothing real.
- **Success criteria:** the app displays exactly the 28 staff with exact salaries, groups and wage types; a simulated **fresh device** (empty local storage — i.e. Raj's situation) hydrates to an identical list; workshop weekly calculations resolve; no legacy-naming or schema errors.
- **Failure criteria:** any discrepancy between what the app shows and the approved roster; a fresh-device view differing from the owner-device view.
- **Evidence:** `gate-C-report.txt` (harness output, pass/fail per assertion).
- **Rollback point:** delete the 38 identifiers (§05).
- **Approvals:** **owner declares RECOVERY COMPLETE.** Reintegration may not begin without it.

## Gate D0 — Drift check (first gate of REINTEGRATION)

- **Purpose:** detect anything the phone gained after the backup was captured. This gate exists because ASSUME-1 (no use since capture) is *not* provable from the backup, and because the freeze is enforced by human discipline alone.
- **Inputs:** a **second** read-only snapshot taken with `backup.html` immediately before the phone opens StaffPay; the original sealed backup.
- **Validator:** the **backup page** (read-only) plus a diff of the two captures.
- **Success criteria:** no difference in any StaffPay data key (staff, profiles, attendance, queue) between the two captures.
- **Failure criteria:** any drift. **HALT reintegration.** The new data is folded into a superseding manifest (new hash, new Gate A1/A2/B/C cycle) before any phone opens the app.
- **Evidence:** `gate-D0-report.txt` (second backup row id + diff).
- **Rollback point:** delete the 38 identifiers if a superseding restore is needed.
- **Approvals:** owner acknowledges the drift result.

## Gate D — Phone 1 (owner) reintegration

- **Purpose:** prove the real production path works end-to-end on the device that holds the data.
- **Inputs:** owner's phone opening StaffPay once, online.
- **Validator:** **production request logs + the owner's screen** — two independent witnesses, neither of which is the application's own internal state.
- **Success criteria:** all staff requests return success (no 403/4xx/5xx); the pending queue drains to zero; cloud counts remain 28/10 (the flush merges, it does not add); the screen shows all 28 staff with correct salaries.
- **Failure criteria:** any failed request; a queue that does not drain; any count change; a wrong or partial roster on screen.
- **Evidence:** `gate-D-report.txt` (log extract, post-flush counts, duplicate check, owner's confirmation).
- **Rollback point:** the restore itself remains valid; investigate before proceeding to Raj. Do **not** roll back a healthy cloud because of a device-side symptom.
- **Approvals:** owner confirms the roster on screen.

## Gate E — Phone 2 (Raj) + closure

- **Purpose:** prove multi-device truth — the original failure was only visible on a second device, so closure must be proven there.
- **Inputs:** Raj's phone refreshing StaffPay.
- **Validator:** **Raj's screen + a final independent audit sweep** of the database.
- **Success criteria:** Raj sees the identical 28 staff; attendance visible; duplicates zero; counts stable; no failed requests in the window.
- **Failure criteria:** any difference between the two devices; any duplicate; any error.
- **Evidence:** `gate-E-report.txt`; the sealed evidence package (§06).
- **Rollback point:** none — by this point rollback would destroy live truth. Corrections from here are ordinary forward operations.
- **Approvals:** **owner declares INCIDENT CLOSED**; authority transfers from the backup to the cloud (sunset clause, §README).

---

## Independence audit of the validator set

| Gate | Thing being judged | Judge | Independent? |
|---|---|---|---|
| A1 | generator output | separate checker code | Yes — different code path, re-derives from source |
| A2 | business correctness | the owner | Yes — the only holder of that truth |
| B | executor's writes | the database's own read-back and constraints | Yes — not the executor's report |
| C | data as the app sees it | the frozen pre-incident app | Yes — written before the manifest existed |
| D0 | assumption of no drift | a second physical capture | Yes — new evidence, not reasoning |
| D | end-to-end path | server logs + human eyes | Yes — two witnesses outside the app's claims |
| E | multi-device truth | second device + audit sweep | Yes — the device class that exposed the defect |

**Known residual (stated, not hidden):** the generator and the checker are
authored by the same engineer, so a shared *conceptual* error could survive Gate
A1. It is mitigated — not eliminated — by the diversity of the later judges: the
database's constraints, an application written before this incident, and a human
who knows the business. This residual is accepted and recorded rather than
papered over; in a larger team the correct control is a second author for the
checker.
