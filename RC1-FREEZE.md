# Staff Module — Release Candidate 1 (RC1) · Freeze Record

**Frozen:** 2026-08-27 (Mission 014.6)
**Status:** FROZEN — awaiting owner acceptance (Mission 014.5 checklist)

## RC1 identity (the exact bits under test)
| Artifact | Identity |
|---|---|
| `staff-module.html` | git blob `a7c91508f6692cb663b12c70ca328c416fdd2d9b` |
| `staff-cloud.js` | git blob `97ff126f1fb6f62dd087c74210c34a6201f83390` |
| Dev commit | `8590000` on `claude/warehouse-session-hang-3t3lov` |
| Deployed via | PR #2, merge `0c3650a` on `main` · Pages build run #12 success |
| Acceptance URL | https://shankymittal28.github.io/staffpay-live/staff-module.html |
| Database | Supabase `mittal-hardware` (`bsjrihrekfsxmajdsyhc`), Postgres 17.6.1.127 |
| Schema state | 4 `staff_` tables, RLS owner-scoped, + `staff_employee.removed` (defect fix, Mission 014.5); all tables empty |
| Production app | `index.html` blob `2ff7f4843a…` — UNTOUCHED, still the frozen local-storage baseline |
| Pre-flight evidence | 25/25 shipping-artifact proofs (the artifact's own app script on the real store vs mock cloud) |

## Freeze rules (in force until acceptance concludes)
**Allowed:** critical defects discovered during acceptance · diagnostics/logging needed to identify a failure · documentation.
**Not allowed:** refactoring · architecture improvements · UI polish · performance tuning · new features · database redesign · code cleanup · any change made because it "feels better."

## Change protocol (every code change from now on must state)
1. Why the acceptance test required it.
2. Which acceptance step failed.
3. Why the fix is the minimum possible correction.
4. Confirmation that no other behaviour changed.

## Outcomes
- **Acceptance passes with no critical defect →** RC1 is promoted to Production (`staff-module.html` becomes `index.html`) — a separate, owner-approved promotion step.
- **Acceptance fails →** record the defect · fix only that defect · restart acceptance from the affected step.
- No feature work resumes until RC1 has passed or been rejected.

## Operating mode from RC1 onward (owner directive, 2026-08-28)
**Evidence is more valuable than thinking. Production reality is the highest authority.**
- No improvement may be proposed unless a concrete production observation requires it.
- Every future architectural change must cite a specific production observation that the
  current architecture cannot explain. No such observation → no redesign.
- The design-ahead phase of this project is over; from here the system changes only in
  response to what production actually does.

## Law of Production Evidence (owner directive, 2026-08-28)
Every production observation must be classified — exactly one class — before any change is considered:
1. **DEFECT** — the system behaved incorrectly → fix the defect.
2. **FEATURE** — the system behaved correctly; a new capability is desired → add to backlog.
3. **EXPECTED** — the system behaved exactly as designed → record if needed; no change.
4. **OPERATOR** — the issue arose from operator misunderstanding or workflow → improve UX or documentation.
5. **UNKNOWN** — insufficient evidence → gather more observations before changing anything.

No redesign may begin without an observation. No observation may remain unclassified.

## RC2 (supersedes RC1 before acceptance began) — Monday-week FEATURE
**Production observation (owner, 2026-08-28, class FEATURE):** the weekly settlement
cycle ran Sunday→Saturday; the business week is Monday→Sunday.
**Change protocol statement:**
1. Required because the owner classified and ordered this FEATURE change before acceptance began.
2. No acceptance step failed — acceptance had not started; RC1 was never tested and is superseded.
3. Minimal correction: the entire week boundary derives from the single function `weekStart()`;
   the fix is one line of logic there, plus one visible label and three comments. No other code path defines a week.
4. No other behaviour changed: all 25 pre-existing artifact proofs still pass unchanged;
   14 new week tests prove Monday start, Sunday end, cross-month totals, and old-boundary exclusion.
**Data compatibility:** staff_settlement is empty (pre-production, Mission 013) — no record can be
orphaned; hypothetical old Sunday-keyed settlements would still order correctly in the running-advance sum.
RC2 identity is the dev-branch blobs of this commit; acceptance (Mission 014.5 checklist) now applies to RC2.

## RC2.1 — DEFECT fix: stale build served/retained on device
**Observation (owner, 2026-08-28, class DEFECT):** Attend screen showed `23 Aug – 29 Aug 2026`
for 28 Aug on "RC2". Investigation proved the deployed blob was correct (only one getDay()
in the file, Monday-based; label path is updateMonthLabels→getPeriod→weekLabel→weekStart, no
independent calculation) and the displayed string is byte-for-byte RC1 output → the device was
running stale RC1 bits (GitHub Pages max-age=600 HTTP cache and/or a never-reloaded open
tab/PWA instance from the RC1 era). Deeper defect: no build identifier existed, so stale
could not be distinguished from fresh on screen.
**Change protocol:**
1. Required by the acceptance DEFECT above (stale running instance; undiagnosable).
2. Failed step: acceptance pre-check of the Monday-week display on device.
3. Minimal correction: build stamp (meta + visible on sign-in card), cache-busted JS include,
   and a loop-guarded stale-build self-heal (on foreground/boot, compare server build; reload
   once via cache-busted URL). App script block untouched; no schema, no UX flow change.
4. Nothing else changed: all 25 original proofs + 14 week proofs pass unchanged; new 40th
   check pins the owner's exact case (28 Aug → 24 Aug – 30 Aug 2026).
**One-time manual step:** the stale RC1 instance on the device predates the self-heal and
cannot fix itself — one fresh open/hard-refresh of the URL is required. All future deploys
self-converge.

## PROMOTED TO PRODUCTION — 2026-08-28
Owner acceptance PASSED on RC2.1 (on-device: sign-in works; Monday→Sunday week
verified). Promotion executed byte-for-byte: index.html := accepted artifact
(blob 8b38ede, build rc2.1-20260828); duplicate staff-module.html removed
(one-implementation rule). Production commit: bb8b54f (PR #5).
Rollback: branch `rollback/pre-cloud-production` = caa81dd (pre-cloud baseline);
restoring = revert index.html to that ref's copy.
StaffPay production is now the cloud-backed Staff module: Supabase source of
truth (staff_ tables, RLS owner-scoped), local cache + offline outbox, one-time
sign-in per device, payment-first UX preserved.

## RC3 — Opening Balance (Old Hisab) · Mission 015
**Classifications:** workshop cloud persistence = DEFECT (profile.openingAdvance was
wiped on every hydrate — never reached the cloud); Opening Balance semantics = FEATURE.
**Semantic ruling (owner):** Opening Balance is historical state before StaffPay, NOT a
payment/settlement/advance event; never recorded as one. Terminology standardized:
DB `opening_balance` · model `openingBalance` · UI "Opening Balance (Old Hisab)";
legacy `openingAdvance` naming removed entirely.
**Implementation:** additive column staff_employee.opening_balance (default 0); field
carried through employeeRow/employeesToProfiles/employeesToRegistry, saveProfile bridge
and regEntryFor; staff-editor input + read-only provenance line in staff detail
(non-zero only); hisab label renamed. Workshop running balance = openingBalance +
Σ(cash − earned): calculation untouched. Monthly payroll model untouched — monthly
opening balances are stored/displayed but explicitly DEFERRED from any monthly
arithmetic until a production observation demands carry-forward.
**Proofs:** 51/51 (monthly payrollFor byte-identical with opening set; cloud carry;
fresh-device hydrate; running balance starts/moves/edits correctly; zero legacy naming).
