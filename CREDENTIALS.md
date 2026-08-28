# Staff Module — Credentials & Sign-in Governance

## The identity
| | |
|---|---|
| Sign-in email | `shankymittal28@gmail.com` |
| Auth user id | `b96b7056-f8da-491b-ba3c-558d620c5010` |
| Supabase project | `mittal-hardware` (`bsjrihrekfsxmajdsyhc`) |
| Provider | email + password |
| Created | 2026-07-27 01:25 UTC (July login-gate era; original password never used, never known-good) |
| Password state | ROTATED 2026-08-28 by admin action (Mission 014.5 blocker). Temp password issued to owner; to be rotated to a random unknown value after the owner's devices hold persistent sessions. |

## Password lifecycle (the rule)
1. Passwords are established ONLY by an explicit, recorded action (dashboard reset or admin
   rotation), never assumed from history. The record must say WHO set it and WHEN.
2. The owner stores the current password in their own keeper (phone password manager / notebook).
   It is never stored in this repository.
3. Device sessions persist via refresh tokens, so after every device has signed in once, the
   password may be rotated to a random unknown value ("sessions-only" mode) — signing in a NEW
   device then requires a fresh rotation. Current mode is recorded above.
4. Lost password = admin rotation (Supabase SQL/dashboard), never guessing, never account
   re-creation (re-creation would orphan owner_id-scoped data).

## Acceptance prerequisite (binding on all future deployments)
**No build may enter owner acceptance until a VERIFIED sign-in exists**: the release record
must include evidence that the acceptance credentials were established (who/when) AND that a
real sign-in succeeded (auth.users.last_sign_in_at is non-null) or the temp-credential handoff
is explicitly recorded. "An auth row exists" is NOT sufficient — Mission 014.5 was blocked
exactly because an untouched July-era row (zero sign-ins ever) was mistaken for a working login.
