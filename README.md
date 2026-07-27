# staffpay-live

The **live, hosted** StaffPay app (served free via GitHub Pages).

- This repo = the **open shop** (what heads open on their phones).
- The private `staffpay` repo = the **workshop** (where code is built).

Currently: **Layer 1 — heads' attendance.** A head logs in, sees only their
staff, and marks P / ½ / A / L; the owner sees everyone. Data is stored in the
StaffPay drawer (Supabase), protected by logins. No secrets live in this repo —
only the public "anon" address key (safe by design).
