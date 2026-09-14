# staffpay-live

The **live, hosted** StaffPay app — built the same way as **NK Warehouse**:
one clean single-page app, logins, and a shared online brain (Supabase).

- This repo = the **open shop** (what owner + heads open on their phones).
- The private `staffpay` repo = the workshop / history.

## What it does (Layer 1 — attendance)
- **Log in** as Owner, Shop Head, or Workshop Head.
- **Owner** sees all staff (shop + workshop) and marks attendance.
- **Heads** see only their own department's staff.
- Marks (P / half / absent / leave) save to the shared drawer, so the **owner
  sees everything live**. Installable to the home screen (PWA).

Next layers: staff master (add/edit people), payments/payroll — grown the way
the warehouse grew. No secrets in this repo — only the public Supabase anon key.

## Staff Work (2026-09-13) — assign tasks, personal phone access
Under **More → Staff Work** the owner assigns one task to one employee (from
the Staff Master registry, by its permanent id), optionally with a due date and
a reference (customer, bill page or Tally voucher), sees Blocked / Pending /
Done-today tasks, and reassigns / reopens / withdraws with a reason.
**Personal phone access** gives each employee a one-time 8-character code
(shown once, 24 hours, single use) for their own phone; the row shows
No access / Code waiting / Active on one phone, and "Revoke phone" cuts a
lost phone off at once. All of this lives in Project Zero (its `/api/work/*`
routes), which verifies the owner's live sign-in token with Supabase and only
answers the registry's owner. StaffPay's own tables are untouched; nothing
secret is stored in this app. Test: `node test_staff_work.js` (needs
`../project-zero` for the stand-in server).

## Today at Work + audited attendance (2026-09-14) — build rc6-20260914
**Today at Work** on the home screen shows, per team, how many people are at
work, not marked, at lunch and gone, with the last update time; tapping a team
lists the names, times and who recorded each. It is filled by team heads from
their own phones, so the morning telephone call is no longer needed.

**Teams** (More → Staff Work) are Shanky's to create: name the team, pick
members and one or more heads from the Staff Master registry. A team is not the
pay group (Shop / Workshop) and has nothing to do with NK Orders. Two people who
share a display name are shown with a stable short code so the right one is
picked. Removing a head takes their access away on their next tap.

**Attendance is now written by Project Zero, not by this app.** The Attendance
screen looks and works as before, but every mark is sent to the server, which
keeps one row per employee per day, records who asserted it, and requires a
reason when an existing mark is replaced. The screen never says "saved" before
the server confirms, and a retry repeats the same event id so a lost reply can
never create a second row. Payroll and weekly hisab are unchanged in formula;
they now match records by employee id instead of by name.
Tests: `node test_staff_work.js` and `node test_attendance_teams.js` (both need
`../project-zero` for the stand-in server).
