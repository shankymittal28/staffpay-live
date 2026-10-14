-- ============================================================================
-- StaffPay R2 - money returned by SHOP staff too (on top of d3_receipts_v1.sql)
-- ----------------------------------------------------------------------------
-- d3_receipts_v1.sql is applied and stays as it is; this file only replaces
-- public.staff_receipt_add and adds one read-only function.
--
--   * staff_receipt_add accepts Shop staff as well as Workshop workers. Same
--     Payments ledger (minus row rcv_<op_id>), same amount rule, same retry by
--     op_id, same per-worker lock and operation log. Workshop keeps its Old
--     Hisab requirement and boundary. Shop has no Old Hisab: any actual day up
--     to today. Receipt guards, corrections and removal are unchanged (they
--     already cover every rcv_ row).
--   * staff_shop_month: one Shop worker's figures for one month straight from
--     the database (payments given / returned / count, attendance counts), so
--     a phone can confirm its own month figures are complete before showing
--     them. Read only.
--
-- No table, column or data change. App rollback keeps this file applied.
-- ============================================================================

begin;

-- ---- record money returned by a worker (Workshop or Shop) --------------------
create or replace function public.staff_receipt_add(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_owner uuid := auth.uid(); v_op uuid; v_staff uuid; v_amt numeric; v_day date; v_note text;
  v_r jsonb; e record; v_ts timestamptz; v_id text; v_res jsonb;
begin
  if v_owner is null then return jsonb_build_object('ok', false, 'error', 'not signed in'); end if;
  begin
    v_op := (p ->> 'op_id')::uuid; v_staff := (p ->> 'staff_id')::uuid;
    v_amt := (p ->> 'amount')::numeric; v_day := (p ->> 'day')::date;
  exception when others then return jsonb_build_object('ok', false, 'error', 'bad request'); end;
  if v_op is null or v_staff is null or v_day is null then
    return jsonb_build_object('ok', false, 'error', 'bad request');
  end if;
  v_note := btrim(coalesce(p ->> 'note', ''));
  v_r := staffpay_d3.op_begin(v_owner, v_op, v_staff, p);
  if v_r is not null then return v_r; end if;

  select * into e from public.staff_employee where id = v_staff and owner_id = v_owner for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not found'); end if;
  -- Workshop: weekly hisab from the Old Hisab date (unchanged). Shop: monthly
  -- accounting, no Old Hisab boundary.
  if e.work_group not in ('workshop', 'shop') then
    return jsonb_build_object('ok', false, 'error', 'not a shop or workshop worker');
  end if;
  if e.work_group = 'workshop' and e.opening_balance_date is null then
    return jsonb_build_object('ok', false, 'error', 'Old Hisab not entered for this workshop worker');
  end if;
  if not staffpay_d3.receipt_amount_ok(v_amt) then
    return jsonb_build_object('ok', false, 'error', 'bad amount',
      'message', 'Amount 0 se zyada, 2 decimal tak aur ₹1 crore se kam likhein.');
  end if;
  if e.work_group = 'workshop' and v_day <= e.opening_balance_date then
    return jsonb_build_object('ok', false, 'error', 'that date is before the Old Hisab date');
  end if;
  if v_day > staffpay_d3.today() then return jsonb_build_object('ok', false, 'error', 'future date'); end if;

  -- dated that day (Asia/Kolkata): the time now when entered the same day,
  -- noon when entered later
  v_ts := case when v_day = staffpay_d3.today()
               then ((v_day::timestamp + (now() at time zone 'Asia/Kolkata')::time) at time zone 'Asia/Kolkata')
               else ((v_day::timestamp + time '12:00') at time zone 'Asia/Kolkata') end;
  v_id := 'rcv_' || v_op;
  insert into public.staff_payment (owner_id, legacy_id, staff_id, staff_legacy_id, name, amount, note, date, month_key, device)
  values (v_owner, v_id, v_staff, e.legacy_id, e.name, -v_amt,
          case when v_note = '' then 'Wapas mila' else v_note end,
          v_ts, to_char(v_day, 'YYYY-MM'), 'd3-receipt');
  v_res := jsonb_build_object('ok', true, 'action', 'receipt', 'payment_id', v_id, 'staff_id', v_staff,
                              'amount', v_amt, 'day', v_day, 'group', e.work_group);
  return staffpay_d3.op_log(v_owner, v_op, 'payment', v_staff, v_id, 'receipt', p, v_res);
end $$;

-- ---- read API: one Shop worker's month, for the phone to confirm its figures --
create or replace function public.staff_shop_month(p jsonb)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_owner uuid := auth.uid(); v_staff uuid; v_month text; e record; v_pay record; v_att record;
begin
  if v_owner is null then return jsonb_build_object('ok', false, 'error', 'not signed in'); end if;
  v_staff := (p ->> 'staff_id')::uuid; v_month := p ->> 'month';
  if v_staff is null or coalesce(v_month, '') !~ '^\d{4}-\d{2}$' then return jsonb_build_object('ok', false, 'error', 'bad request'); end if;
  select * into e from public.staff_employee where id = v_staff and owner_id = v_owner;
  if not found then return jsonb_build_object('ok', false, 'error', 'not found'); end if;
  if e.work_group <> 'shop' then return jsonb_build_object('ok', false, 'error', 'not a shop worker'); end if;
  select count(*) n, coalesce(sum(x.amount) filter (where x.amount > 0), 0) g,
         coalesce(-sum(x.amount) filter (where x.amount < 0), 0) r
    into v_pay from public.staff_payment x
   where x.owner_id = v_owner and x.month_key = v_month
     and staffpay_d3.payment_worker(x.owner_id, x.staff_id, x.staff_legacy_id) = v_staff;
  select count(*) filter (where a.status = 'Present') pr, count(*) filter (where a.status = 'Half-Day') hd,
         count(*) filter (where a.status = 'Absent') ab
    into v_att from public.staff_attendance a
   where a.owner_id = v_owner and a.staff_id = v_staff and a.month_key = v_month;
  return jsonb_build_object('ok', true, 'staff_id', v_staff, 'month', v_month,
    'payments', jsonb_build_object('count', v_pay.n, 'given', v_pay.g, 'received', v_pay.r),
    'attendance', jsonb_build_object('present', v_att.pr, 'half', v_att.hd, 'absent', v_att.ab));
exception when invalid_text_representation then
  return jsonb_build_object('ok', false, 'error', 'bad request');
end $$;

-- ---- who may call what ----------------------------------------------------------
revoke all on function public.staff_shop_month(jsonb) from public, anon;
grant execute on function public.staff_shop_month(jsonb) to authenticated;

commit;
