# 08 — FAILURE ANALYSIS

Every failure anticipated for this recovery. For each: how it is **detected**
(never "we would notice"), its **cause**, **containment**, **recovery**, and
whether **rollback** is required.

The organising principle: a failure that can only be detected by human attention
is a design defect. Each row below names a mechanism.

---

## Class 1 — Evidence failures (before any write)

| ID | Failure | Detection | Cause | Containment | Recovery | Rollback? |
|---|---|---|---|---|---|---|
| F1 | Wrong backup row used | Tool Step 1: row id + capture timestamp + `BACKUP_HASH` must match the incident record | Operator selects a different or newer row | Tool aborts; no output | Re-run with the recorded row id | No |
| F2 | Vault row altered or unreadable | `BACKUP_HASH` mismatch, or read failure | Corruption; someone with database access modified it | Abort. Fall back to the owner's JSON copy as source | Re-derive from the JSON copy; record the substitution in evidence | No |
| F3 | Profiles and master disagree | Tool Step 3 set comparison | Partially-written device state at capture time | Abort, naming the differing names | Human decides the true roster; superseding manifest | No |
| F4 | Identifier collision | Tool Step 4 uniqueness assertion | Two staff differing only by case/spacing | Abort | Owner decides whether they are one person or two; then supersede | No |
| F5 | Queue and attendance cache disagree | Tool Step 5 cross-check | Capture during a write; queue partially flushed | Abort | Human reconciles; superseding manifest | No |
| F6 | Non-deterministic manifest | Gate A1: two generations, different hashes | Clock, randomness, unordered iteration, or locale leaked into output | Abort; **the approach is invalid until fixed** | Fix the tool; regenerate; re-check | No |
| F7 | Owner disputes the roster | Gate A2 | Phone data was wrong before the incident | Approval withheld | Correct the manifest, supersede, re-approve. **Never** correct in the database afterwards | No |

## Class 2 — Authorisation failures

| ID | Failure | Detection | Cause | Containment | Recovery | Rollback? |
|---|---|---|---|---|---|---|
| F8 | Approval hash mismatch | Executor §2 triple-match | Manifest regenerated after approval; wrong file staged | Executor refuses; no writes | Re-approve the exact hash being applied | No |
| F9 | Approval without a hash | Executor §2 / §02 §5 | Informal "go ahead" | Void by specification; refuse | Obtain a hash-quoting approval | No |
| F10 | Executor run by the wrong identity | Pre-condition P3 | Wrong session or account | Refuse | Re-authenticate as the owner | No |

## Class 3 — Execution failures (writes in flight)

| ID | Failure | Detection | Cause | Containment | Recovery | Rollback? |
|---|---|---|---|---|---|---|
| F11 | Target not empty | Pre-condition P4 | Someone opened the app; a prior partial run | Refuse before writing | Investigate what wrote them; re-derive state | No (nothing written) |
| F12 | Permission regression (403) | Non-2xx on first batch | Grants changed since Step 2 | Abort immediately | Repair grants; verify; re-run from Step 1 | Only if a batch partly landed |
| F13 | Partial batch application | Read-back checkpoint count ≠ expected | Network interruption mid-batch | Abort | Roll back the 38 ids; re-run cleanly | **Yes** |
| F14 | Connectivity lost mid-run | Request error / no response | Network | Abort; **no blind retry** | Roll back; re-run | **Yes** if any row landed |
| F15 | Rows stamped with wrong owner | Gate B owner-stamp assertion | JWT/RLS anomaly; wrong session | Detected before any device sees it | Roll back; investigate auth | **Yes** |
| F16 | Duplicates present | Gate B duplicate query | Unique constraint missing or bypassed | Halt | Roll back; verify the constraint exists before retrying | **Yes** |
| F17 | Executor run twice | Second run's P4 fails (table non-empty) | Operator error | Refused by pre-condition | None needed — upsert on the unique key makes a genuine double-apply idempotent anyway | No |

## Class 4 — Verification failures (data written, not yet released)

| ID | Failure | Detection | Cause | Containment | Recovery | Rollback? |
|---|---|---|---|---|---|---|
| F18 | Field mismatch vs manifest | Gate B diff | Executor transformed something it must not | Halt before Gate C | Roll back; fix the executor; re-run | **Yes** |
| F19 | App shows wrong data despite a clean database | Gate C | Field-mapping misunderstanding in the tool (row shape right, meaning wrong) | Halt — caught by the app, exactly the judge chosen for this | Roll back; correct the mapping; supersede | **Yes** |
| F20 | Fresh-device view differs from owner view | Gate C fresh-device assertion | Removed/active flags misapplied | Halt | Roll back; correct; supersede | **Yes** |

## Class 5 — Reintegration failures (devices involved)

| ID | Failure | Detection | Cause | Containment | Recovery | Rollback? |
|---|---|---|---|---|---|---|
| F21 | Post-backup drift on the phone | Gate D0 diff of two captures | The freeze was broken | Halt reintegration **before** the app opens | Fold drift into a superseding manifest; repeat Steps 3–9 | Only to apply the superseding manifest |
| F22 | Queue flush creates duplicates | Gate D duplicate check + count stability | Attendance identifiers changed by the tool (forbidden) | Detected on the first device, before Raj | Remove duplicates by identifier; correct the tool | Targeted, not full |
| F23 | Queue will not drain | Gate D: queue length stays > 0 | Residual permission or payload problem | Stop before the second device | Diagnose from live logs; the cloud restore stays valid | No |
| F24 | Phone storage cleared before reintegration | Second capture at Gate D0 shows empty | Browser eviction; user cleared data | Contained — the restored cloud now holds everything; the device simply hydrates from it | Proceed: this is the scenario the restore was built for | No |
| F25 | Devices disagree at Gate E | Compare both screens | The original defect class recurring | Stop; do not close the incident | Investigate as a new observation under the Law of Production Evidence | No |

## Class 6 — Process failures

| ID | Failure | Detection | Cause | Containment | Recovery | Rollback? |
|---|---|---|---|---|---|---|
| F26 | Steps executed out of order or a gate skipped | Missing gate report in `evidence/`; executor pre-conditions | Time pressure | Pre-conditions block the important cases; the evidence package makes omissions visible at closure | Return to the missing gate; do not close | Situational |
| F27 | Rollback needed but never rehearsed | Pre-condition P6 | Rehearsal skipped | Executor refuses to run at all | Rehearse, then execute | n/a |
| F28 | Rollback itself fails | Rollback verification counts ≠ 0 | Constraint, permission, or partial delete | Executor stops and names the remaining identifiers | Manual, identifier-by-identifier, with a human; **never** a table wipe | n/a |
| F29 | Evidence incomplete at closure | §06 sufficiency test | Rushing | Incident stays open by rule | Produce the missing evidence | n/a |
| F30 | Someone reuses this package for a future incident | Sunset clause in README and final report | Assuming a recovery tool is a general tool | The tool is archived under `executed/` and marked | Run a fresh incident with fresh evidence | n/a |

---

## The failure this design most fears

**F21 — drift during the freeze.** It is the only failure whose *cause* lies
entirely outside the system's control: it depends on two people not opening an
app. Everything else is caught by a hash, a constraint, a count, or an
independent judge. This is why Gate D0 exists, why the freeze is stated in three
separate documents, and why the residual is named plainly in the audit rather
than buried in a risk table.

**The failure this design refuses to permit:** a silent partial success. Every
path terminates in an explicit `APPLIED`, `REFUSED`, or `ABORTED+ROLLED_BACK`.
There is no state in which the system quietly does some of the work — which is,
precisely, the failure mode that created Incident 017.
