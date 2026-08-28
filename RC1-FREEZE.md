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
