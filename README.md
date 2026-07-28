# staffpay-live

**The canonical StaffPay application** — the real interface, workflows,
calculations and data the business runs on (owner decision, 2026-07-28).
Installable to the phone home screen (PWA).

- This repo = the live app (what owner + heads open on their phones).
- The private `staffpay` repo and earlier Supabase rebuilds are **experiments /
  history**, not the source of truth for StaffPay behaviour or data. All future
  StaffPay work evolves *this* app in small additive steps.

## Where the data lives — read this

**All real data (staff, attendance, payments, advances, weekly settlements) is
stored inside the browser of the phone using the app** (localStorage). It is
**not** in any cloud database yet, and it is **not** shared between phones —
each phone that enters data holds its own separate copy.

That means: clearing the browser's site data, or losing the phone, destroys that
phone's records — unless a **Full Backup** has been saved off the phone.
**The backup ritual is not optional. See [`RECOVERY.md`](RECOVERY.md).**

The login screen is a privacy door for the household/shop, not data security,
and the Supabase anon key here is used for that login only — no business data
is stored in Supabase by this app today.

## What it does
- Monthly payroll: staff, attendance (P / half / absent / leave), payments and
  advances, salary slips, WhatsApp share, CSV export.
- Weekly Hisab (workshop): daily-wage settlements with running advance.
- Backup & Restore: full JSON backup, additive restore, backup reminders.

Cloud storage, stable staff IDs and true multi-phone sync are future layers —
to be added *underneath* this app gradually, never by replacing it.
