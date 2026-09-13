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
