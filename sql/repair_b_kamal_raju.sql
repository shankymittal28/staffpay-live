-- ============================================================================
-- StaffPay B - one-off repair: Kamal and Raju (reviewed pairs only)
-- ----------------------------------------------------------------------------
-- Requires sql/d3_staff_merge_v1.sql. One transaction: either both pairs are
-- merged exactly as reviewed, or nothing changes. Safe to run again: an
-- already merged pair is reported and left as it is.
--
-- "pins" is exactly what was reviewed (read-only from production on
-- 2026-10-17): both records' identity, pay terms and flags, plus fingerprints
-- of every live attendance row and every Project Zero audit entry on them.
-- Any later change (a new mark, an edited rate, a replaced row) stops the
-- whole repair; review again and re-pin before running.
--
--   Kamal: keep 206dc20f-8a3b-4aa8-a237-233f735a87ec, merge a5481eba-7c58-45b5-8826-b9f6d79ffa21
--          16 identical repeats archived, nothing to move, 32 audit entries stay
--   Raju:  keep 095233df-7bcb-4ef8-9b87-3afd74e5335e, merge f5c05b72-78ce-48cf-a8ea-85c65de63777
--          15 identical repeats archived, the 16 Sep Present moved (same row),
--          31 audit entries stay
-- ============================================================================
begin;
select staffpay_d3.merge_staff(
  (select owner_id from public.staff_employee where id = '206dc20f-8a3b-4aa8-a237-233f735a87ec'),
  '206dc20f-8a3b-4aa8-a237-233f735a87ec', 'a5481eba-7c58-45b5-8826-b9f6d79ffa21',
  '{"retired_rows": 16, "retained_rows": 29, "move": 0, "archive": 16, "acts": 32,
  "pins": {
    "keep":   {"id": "206dc20f-8a3b-4aa8-a237-233f735a87ec", "legacy_id": "stf_mtoejiad_25", "name": "Kamal", "work_group": "shop", "wage_type": "daily", "salary": 375, "active": true, "removed": false, "opening_balance": 0, "opening_balance_date": null, "terms_version": 0, "identity_status": null, "identity_of": null, "merged_into": null},
    "retire": {"id": "a5481eba-7c58-45b5-8826-b9f6d79ffa21", "legacy_id": "stf_mtoeaknz_2l", "name": "Kamal", "work_group": "shop", "wage_type": "daily", "salary": 375, "active": true, "removed": false, "opening_balance": 0, "opening_balance_date": null, "terms_version": 0, "identity_status": null, "identity_of": null, "merged_into": null},
    "attendance_md5": "e35a21717735cd49e3e9e8160a1e1d77", "acts_md5": "e2aea7c6f8a80da933dc7da30effe80d"}}') as kamal,
  staffpay_d3.merge_staff(
  (select owner_id from public.staff_employee where id = '095233df-7bcb-4ef8-9b87-3afd74e5335e'),
  '095233df-7bcb-4ef8-9b87-3afd74e5335e', 'f5c05b72-78ce-48cf-a8ea-85c65de63777',
  '{"retired_rows": 16, "retained_rows": 28, "move": 1, "archive": 15, "acts": 31,
  "pins": {
    "keep":   {"id": "095233df-7bcb-4ef8-9b87-3afd74e5335e", "legacy_id": "stf_mtoejcua_12", "name": "Raju", "work_group": "shop", "wage_type": "daily", "salary": 500, "active": true, "removed": false, "opening_balance": 0, "opening_balance_date": null, "terms_version": 0, "identity_status": null, "identity_of": null, "merged_into": null},
    "retire": {"id": "f5c05b72-78ce-48cf-a8ea-85c65de63777", "legacy_id": "stf_mtoeaebl_1t", "name": "Raju", "work_group": "shop", "wage_type": "daily", "salary": 500, "active": true, "removed": false, "opening_balance": 0, "opening_balance_date": null, "terms_version": 0, "identity_status": null, "identity_of": null, "merged_into": null},
    "attendance_md5": "8a046361c5166331e9dca3b88ceef25a", "acts_md5": "f5c3f9314a17bf178160c92fe1177a1a"}}') as raju;
commit;
