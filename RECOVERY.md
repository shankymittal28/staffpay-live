# StaffPay — Backup & Recovery (plain English)

**Why this matters.** Every wage, advance, attendance mark and weekly settlement
lives **only inside the browser of the phone that entered it**. There is no
cloud copy. One "clear browsing data", a lost phone, or the phone's browser
quietly evicting old site storage = that phone's entire payroll history is gone.
The Full Backup file is the only safety net.

**Important: every phone counts.** If the owner and a head each mark things on
their own phones, each phone holds **different data**. The backup ritual below
must be done **on every phone that enters data**.

---

## 1. Taking a Full Backup (on the phone, ~30 seconds)

1. Open StaffPay and log in.
2. On the main screen, scroll to the bottom — the **"Backup & Restore"** section.
3. Tap **"💾 Full Backup — save everything (.json)"**.
4. The phone downloads a file named like `StaffPay_FullBackup_2026-07-28.json`
   (it lands in the phone's **Downloads** folder).
5. **Move that file off the phone** to the approved backup destination
   (being chosen in Mission 011A — until then, at minimum also keep a copy
   anywhere that is not this phone).

What the file contains — all seven data areas: payments/advances, attendance,
staff master list, name history, wage profiles, weekly settlements, and the
removed-staff list. (The internal staff-ID registry is rebuilt automatically by
the app after a restore, and the login session is deliberately not included.)

The app reminds you when a backup is overdue (more than 7 days, or 20+ new
records). **Don't dismiss that reminder — tap it.**

## 2. Proving a backup works (restore drill — do this at least once)

Restores in StaffPay are **additive** (they merge records in; they never wipe
what's there), but drills must still never be done on the real phone's app.
Use a browser that has no StaffPay data:

1. On a PC — or in a **different browser** on the phone that never opened
   StaffPay — open the StaffPay app URL.
2. Log in, scroll to **Backup & Restore**, tap **"⬆ Restore from Backup"**,
   pick the backup file.
3. It reports what it restored (e.g. `+120 payments, +240 attendance, +8 staff`).
4. Compare with the real phone: same staff count, same "this month" totals on
   the summary screen.
5. Close that browser when done (or clear its site data). It never syncs
   anywhere, so nothing can leak back into the real app.

A backup file that has never been through this drill is a hope, not a backup.

## 3. Restoring for real (after a lost/reset phone)

1. On the new phone, open the app URL, log in, install to home screen.
2. **Backup & Restore → "⬆ Restore from Backup"** → pick the **newest
   drill-tested** backup file.
3. Check staff list and current-month totals against expectations.
4. Take a fresh Full Backup from the new phone to confirm the loop works.

## 4. The rhythm

- **Weekly** (or after any heavy data-entry day): Full Backup on every phone
  that enters data, file moved off the phone.
- **Keep old backup files.** Never overwrite or delete previous ones — they are
  your recovery points if a newer file turns out damaged.
- **Monthly:** one restore drill on the newest file.

---
*Written in Mission 011A (2026-07-28 IST). Canonical-app note: `staffpay-live`
is the one real StaffPay; other implementations are experiments and must not be
used as data models or restore targets.*
