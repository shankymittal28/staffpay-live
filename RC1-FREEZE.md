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
