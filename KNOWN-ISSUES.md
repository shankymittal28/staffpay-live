# Known issues (recorded, not yet fixed)

## Ordinary payment amounts are not fully validated (reported 2026-10-13)

Found during the independent review of the receipts work (commit b33e650).
Present in the live D3 code since rc10; **not** changed by the receipts work,
by owner decision. It needs its own decision and fix.

- `staff_payment_correct` (sql/d3_weekly_hisab_v1.sql), for an ordinary
  outgoing payment, checks only "amount > 0". PostgreSQL ranks NaN above every
  number, so a direct request with the amount "NaN" is accepted, and so is an
  amount with more than two decimals (e.g. 100.001).
- The ordinary phone upload route (inserting into `staff_payment`) has no
  database check on the amount, so a malformed upload can store "NaN".
- A NaN amount makes the workshop report's balance "NaN" while it still
  answers ok.

Reproduced in the disposable test database (not production). The phone's own
forms do not produce these values. Receipts ("Wapas mila") are covered by
`staffpay_d3.receipt_amount_ok` in sql/d3_receipts_v1.sql.
`test_d3/test_receipts_db.js` check A9 confirms ordinary corrections still
behave as before.
