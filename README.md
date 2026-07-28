# staffpay-live

**The canonical StaffPay application, preparing for first real use** (owner
decision, 2026-07-28). This is the one real StaffPay — its interface, workflows
and calculations are the approved ones — but the business has **not yet run
real payroll through it**: any data currently inside it is demo/test data
unless Shanky says otherwise. Installable to the phone home screen (PWA).

- This repo = the live app (what owner + heads open on their phones).
- The private `staffpay` repo and earlier Supabase rebuilds are **experiments /
  history**, not the source of truth for StaffPay behaviour or data. All future
  StaffPay work evolves *this* app in small additive steps.

## Where the data lives — read this

**All data (staff, attendance, payments, advances, weekly settlements) is
stored inside the browser of the phone using the app** (localStorage). It is
**not** in any cloud database, and it is **not** shared between phones — each
phone that enters data holds its own separate copy.

Today that is a *future* risk, not a current emergency — no real payroll
history exists yet. But from the very first real entry onward, clearing the
browser's site data or losing the phone destroys that phone's records unless a
**Full Backup** has been saved off the phone. **Before first real use, read
[`RECOVERY.md`](RECOVERY.md)** — and ideally, cloud persistence, stable staff
IDs and real authentication should be added (additively, underneath this app)
*before* real operations begin, precisely because there is no live data to
migrate yet.

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
