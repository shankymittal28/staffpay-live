-- ============================================================================
-- StaffPay D3 - undo script. NOT the production rollback.
-- ----------------------------------------------------------------------------
-- Permitted uses only:
--   1. resetting a disposable test database;
--   2. removing the D3 objects from production BEFORE any D3 use.
-- After D3 has been used, the production rollback is: deploy rc9-safe and keep
-- every guard, settlement record, operation-log entry and correction record.
-- This script refuses to run once any D3 business record exists.
-- ============================================================================
begin;
do $$
begin
  if exists (select 1 from public.staff_employee where opening_balance_date is not null)
     or exists (select 1 from public.staff_settlement where legacy_id like 'stl\_%' or state is not null)
     or exists (select 1 from public.staff_d3_op)
     or exists (select 1 from public.staff_payment_void)
     or exists (select 1 from public.staff_payment where legacy_id like 'stl\_%') then
    raise exception 'D3 has been used: this script must not run. Production rollback = deploy rc9-safe and keep the D3 database objects.';
  end if;
end $$;

drop trigger staff_d3_guard_employee on public.staff_employee;
drop trigger staff_d3_guard_payment on public.staff_payment;
drop trigger staff_d3_guard_settlement on public.staff_settlement;
drop function public.staff_workshop_report(jsonb);
drop function public.staff_workshop_payments(jsonb);
drop function public.staff_d3_op_status(jsonb);
drop function public.staff_settlement_apply(jsonb);
drop function public.staff_workshop_terms_set(jsonb);
drop function public.staff_payment_correct(jsonb);
drop schema staffpay_d3 cascade;
drop table public.staff_payment_void;
drop table public.staff_d3_op;
drop index public.staff_payment_owner_staff_date_idx;
drop index public.staff_payment_unlinked_idx;
drop index public.staff_attendance_owner_staff_day_idx;
alter table public.staff_settlement drop column detail, drop column payment_legacy_id, drop column state, drop column version;
alter table public.staff_payment drop column staff_legacy_id;
alter table public.staff_employee drop column terms_version, drop column opening_balance_date;
commit;
