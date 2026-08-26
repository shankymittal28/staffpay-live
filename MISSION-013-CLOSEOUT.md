# Mission 013 — Closeout

**Status: INFRASTRUCTURE COMPLETE — Awaiting Real Production Source**

Reclassified from "First Real Migration" to **"Migration infrastructure
successfully built and validated, but production migration not required."**

## Why reclassified
`staffpay-live` is a **pre-production** application. Its browser localStorage holds
no real production Staff data. There was therefore nothing meaningful to migrate.
The migration itself was never run, and no empty/test data was imported.

## What was engineered and validated (retained on this dev branch)
- **Verified cloud schema** (KEPT in Supabase project `bsjrihrekfsxmajdsyhc`):
  `staff_employee`, `staff_payment`, `staff_attendance`, `staff_settlement` —
  RLS owner-scoped, idempotent-import key `unique(owner_id, legacy_id)`, FK
  integrity, verified column-for-column against spec (Mission 012.6).
- **Migration engine** (`staff-migrate.js`) + **operator page** (`staff-migrate.html`):
  Backup -> Verify Backup -> Import -> Verify Import, STOP-on-mismatch, no SWITCH.
- **Offline proofs** (representative data): backup round-trip exact; import
  idempotent (run twice, zero duplicates); VERIFY IMPORT all checks pass
  (counts, exact rupee total, every legacy_id, every staff link); the verifier
  provably CATCHES dropped/altered/duplicated/mis-linked records.

## Production state after closeout
- Production branch `main`: migration tooling **removed**; app `index.html`
  untouched (frozen baseline). Production contains only production code.
- Cloud schema: **kept** (empty, awaiting a real source).
- Tooling: retained on this dev branch for reuse against the real source.

## Not done (correctly)
- No cutover / SWITCH (that is a separate future mission).
- No import of empty or test data.

## Open item (out of scope, separately tracked)
- Supabase project `mittal-hardware` has RLS-disabled `pz_*` (Collections)
  tables — a pre-existing issue parked as a separate **Security Audit mission**.
