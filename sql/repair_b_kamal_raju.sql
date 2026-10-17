-- ============================================================================
-- StaffPay B - one-off repair: Kamal and Raju (reviewed pairs only)
-- ----------------------------------------------------------------------------
-- Requires sql/d3_staff_merge_v1.sql. One transaction: either both pairs are
-- merged exactly as reviewed, or nothing changes. Safe to run again: an
-- already merged pair is reported and left as it is.
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
  '{"retired_rows": 16, "retained_rows": 29, "move": 0, "archive": 16, "acts": 32}') as kamal,
  staffpay_d3.merge_staff(
  (select owner_id from public.staff_employee where id = '095233df-7bcb-4ef8-9b87-3afd74e5335e'),
  '095233df-7bcb-4ef8-9b87-3afd74e5335e', 'f5c05b72-78ce-48cf-a8ea-85c65de63777',
  '{"retired_rows": 16, "retained_rows": 28, "move": 1, "archive": 15, "acts": 31}') as raju;
commit;
