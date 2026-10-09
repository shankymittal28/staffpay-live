-- ============================================================================
-- StaffPay N1 - weekly settlements in order (on top of d3_weekly_hisab_v1.sql)
-- ----------------------------------------------------------------------------
-- Owner-approved rule (R1 + R2), per worker:
--   R1  a week can be settled only when every earlier StaffPay week (weeks after
--       the Old Hisab date) already has a settlement record: settled (Rs 0
--       weekly closures included) or corrected.
--   R2  an earlier week cannot be settled once a later week is settled.
-- Only "settle" is restricted; "change" and "correct" are unchanged. Both
-- checks run after the operation-log replay and under the per-worker lock.
-- The report adds latest_settled_week so the screen can say why.
--
-- No table, constraint or data change. Production keeps this guard on any
-- rollback (older pages are refused with a plain message); there is no
-- production down script.
-- ============================================================================

create or replace function public.staff_settlement_apply(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_owner uuid := auth.uid(); v_op uuid; v_staff uuid; v_week date; v_sun date; v_act text;
  v_cash numeric; v_ver int; v_r jsonb; e record; s record; v_calc jsonb; w jsonb; v_seen jsonb;
  v_newver int; v_pay text; v_res jsonb; v_reason text; v_ts timestamptz; v_ids jsonb;
  v_m date; v_later text;
begin
  if v_owner is null then return jsonb_build_object('ok', false, 'error', 'not signed in'); end if;
  begin
    v_op := (p ->> 'op_id')::uuid; v_staff := (p ->> 'staff_id')::uuid; v_week := (p ->> 'week')::date;
    v_act := p ->> 'action'; v_cash := (p ->> 'cash')::numeric; v_ver := (p ->> 'expected_version')::int;
  exception when others then return jsonb_build_object('ok', false, 'error', 'bad request'); end;
  if v_op is null or v_staff is null or v_week is null or v_act not in ('settle', 'change', 'correct') then
    return jsonb_build_object('ok', false, 'error', 'bad request');
  end if;
  v_r := staffpay_d3.op_begin(v_owner, v_op, v_staff, p);
  if v_r is not null then return v_r; end if;

  select * into e from public.staff_employee where id = v_staff and owner_id = v_owner for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not found'); end if;
  if e.work_group <> 'workshop' or e.opening_balance_date is null then
    return jsonb_build_object('ok', false, 'error', 'Old Hisab not entered for this workshop worker');
  end if;
  if extract(isodow from v_week) <> 1 then return jsonb_build_object('ok', false, 'error', 'week must start on Monday'); end if;
  v_sun := v_week + 6;
  if v_sun <= e.opening_balance_date then return jsonb_build_object('ok', false, 'error', 'this week is before the Old Hisab date'); end if;
  if staffpay_d3.today() < v_sun then
    return jsonb_build_object('ok', false, 'error', 'settlement opens on Sunday ' || v_sun);
  end if;

  select * into s from public.staff_settlement
   where owner_id = v_owner and legacy_id = 'stl_' || v_staff || '_' || to_char(v_week, 'YYYY-MM-DD') for update;
  if v_act = 'settle' then
    if found and s.state = 'settled' then
      return jsonb_build_object('ok', false, 'error', 'already settled', 'version', s.version, 'cash', s.cash_paid);
    end if;
    if (not found and v_ver is not null) or (found and v_ver is distinct from s.version) then
      return jsonb_build_object('ok', false, 'error', 'version mismatch', 'version', case when found then s.version end);
    end if;
    -- N1: weeks are settled in order. R1: every earlier StaffPay week must
    -- already have a settlement record (settled, Rs 0 included, or corrected),
    -- so no week is left without a frozen rate behind a settled one.
    v_m := (e.opening_balance_date + 1) - (extract(isodow from e.opening_balance_date + 1)::int - 1);
    while v_m < v_week loop
      if not exists (select 1 from public.staff_settlement x
                      where x.owner_id = v_owner and x.legacy_id = 'stl_' || v_staff || '_' || to_char(v_m, 'YYYY-MM-DD')) then
        return jsonb_build_object('ok', false, 'error', 'earlier week not settled', 'week', v_m,
          'message', 'Settle the week of ' || to_char(v_m, 'DD Mon') || ' first. Weeks are settled in order; '
                  || '₹0 is fine if no cash was given that Sunday.');
      end if;
      v_m := v_m + 7;
    end loop;
    -- R2: once a later week is settled, its settlement already carried this
    -- week's balance; settling this week now would pay that balance twice.
    select max(x.week_key) into v_later from public.staff_settlement x
     where x.owner_id = v_owner and x.legacy_id like 'stl\_' || v_staff || '\_%' and x.state = 'settled'
       and x.week_key > to_char(v_week, 'YYYY-MM-DD');
    if v_later is not null then
      return jsonb_build_object('ok', false, 'error', 'later week settled', 'later_week', v_later,
        'message', 'The week of ' || to_char(v_later::date, 'DD Mon') || ' is already settled and carried this week''s balance. '
                || 'Cash given on another day is recorded as a payment on that day.');
    end if;
  else
    if not found or s.state <> 'settled' then return jsonb_build_object('ok', false, 'error', 'not settled'); end if;
    if v_ver is distinct from s.version then
      return jsonb_build_object('ok', false, 'error', 'version mismatch', 'version', s.version, 'cash', s.cash_paid);
    end if;
  end if;

  if v_act = 'correct' then
    v_reason := btrim(coalesce(p ->> 'reason', ''));
    if v_reason = '' or coalesce((p ->> 'cash_not_given')::boolean, false) is not true then
      return jsonb_build_object('ok', false, 'error', 'a reason and "cash was NOT given" are required');
    end if;
    if s.payment_legacy_id is not null then
      perform staffpay_d3.void_payment(v_owner, s.payment_legacy_id, v_reason, v_op);
    end if;
    update public.staff_settlement set state = 'corrected', version = s.version + 1, cash_paid = 0,
           payment_legacy_id = null,
           detail = coalesce(s.detail, '{}'::jsonb) || jsonb_build_object('corrected_at', now(), 'correct_reason', v_reason, 'correct_op', v_op)
     where id = s.id;
    v_res := jsonb_build_object('ok', true, 'action', v_act, 'state', 'corrected', 'version', s.version + 1, 'cash', 0);
    return staffpay_d3.op_log(v_owner, v_op, 'settlement', v_staff, to_char(v_week, 'YYYY-MM-DD'), v_act, p, v_res);
  end if;

  if v_cash is null or v_cash < 0 then return jsonb_build_object('ok', false, 'error', 'cash must be 0 or more'); end if;
  if coalesce((p ->> 'sunday_done')::boolean, false) is not true or coalesce((p ->> 'advances_complete')::boolean, false) is not true then
    return jsonb_build_object('ok', false, 'error', 'confirm Sunday''s work is finished and every advance is entered');
  end if;

  -- the calculation, after the locks, in this statement's snapshot
  v_calc := staffpay_d3.calc(v_owner, v_staff, v_sun, null);
  if not (v_calc ->> 'ok')::boolean then return v_calc; end if;
  if (v_calc ->> 'cutoff')::date < v_sun or jsonb_array_length(v_calc -> 'withheld') > 0 then
    return jsonb_build_object('ok', false, 'error', 'balance withheld', 'withheld', v_calc -> 'withheld');
  end if;
  select x into w from jsonb_array_elements(v_calc -> 'weeks') x where (x ->> 'monday')::date = v_week;
  v_seen := p -> 'seen';
  if v_seen is null
     or (v_seen ->> 'days')::numeric     is distinct from (w ->> 'days_worked')::numeric
     or (v_seen ->> 'rate')::numeric     is distinct from (w ->> 'rate')::numeric
     or (v_seen ->> 'earned')::numeric   is distinct from (w ->> 'earned')::numeric
     or (v_seen ->> 'previous')::numeric is distinct from (w ->> 'previous')::numeric
     or (v_seen ->> 'advances')::numeric is distinct from (w ->> 'advances_total')::numeric then
    return jsonb_build_object('ok', false, 'error', 'figures changed', 'week', w);
  end if;

  v_newver := coalesce(s.version, 0) + 1;
  -- always dated that Sunday (Asia/Kolkata): the time of day now when entered
  -- on the Sunday itself, 21:00 when the Sunday cash is entered later
  v_ts := case when staffpay_d3.today() = v_sun
               then ((v_sun::timestamp + (now() at time zone 'Asia/Kolkata')::time) at time zone 'Asia/Kolkata')
               else ((v_sun::timestamp + time '21:00') at time zone 'Asia/Kolkata') end;
  select coalesce(jsonb_agg(x ->> 'id'), '[]'::jsonb) into v_ids from jsonb_array_elements(w -> 'advances') x;

  if v_act = 'change' and s.payment_legacy_id is not null then
    if v_cash > 0 then
      update public.staff_payment set amount = v_cash where owner_id = v_owner and legacy_id = s.payment_legacy_id;
      v_pay := s.payment_legacy_id;
    else
      perform staffpay_d3.void_payment(v_owner, s.payment_legacy_id, 'settlement changed to Rs 0', v_op);
      v_pay := null;
    end if;
  elsif v_cash > 0 then
    v_pay := 'stl_' || v_staff || '_' || to_char(v_week, 'YYYY-MM-DD') || '_v' || v_newver;
    insert into public.staff_payment (owner_id, legacy_id, staff_id, staff_legacy_id, name, amount, note, date, month_key, device)
    values (v_owner, v_pay, v_staff, e.legacy_id, e.name, v_cash,
            'Weekly settlement ' || to_char(v_week, 'DD Mon') || ' - ' || to_char(v_sun, 'DD Mon'),
            v_ts, to_char(v_sun, 'YYYY-MM'), 'd3-settlement');
  else
    v_pay := null;
  end if;

  insert into public.staff_settlement as t (owner_id, legacy_id, staff_id, name, week_key, days_worked, daily_wage,
         cash_paid, settled_at, device, version, state, payment_legacy_id, detail)
  values (v_owner, 'stl_' || v_staff || '_' || to_char(v_week, 'YYYY-MM-DD'), v_staff, e.name,
          to_char(v_week, 'YYYY-MM-DD'), (w ->> 'days_worked')::numeric, (w ->> 'rate')::numeric, v_cash, now(),
          'd3-settlement', v_newver, 'settled', v_pay,
          jsonb_build_object('rate', (w ->> 'rate')::numeric, 'days', w -> 'attendance',
            'earned', (w ->> 'earned')::numeric, 'previous', (w ->> 'previous')::numeric,
            'advance_ids', v_ids, 'advances_total', (w ->> 'advances_total')::numeric,
            'cash', v_cash, 'sunday_done', true, 'advances_complete', true, 'paid_on', v_sun,
            'entered_at', now(), 'op', v_op))
  on conflict (owner_id, legacy_id) do update
     set days_worked = excluded.days_worked, cash_paid = excluded.cash_paid, settled_at = excluded.settled_at,
         version = excluded.version, state = 'settled', payment_legacy_id = excluded.payment_legacy_id,
         detail = excluded.detail || jsonb_build_object('rate', t.daily_wage),
         daily_wage = t.daily_wage;                      -- the frozen rate never changes
  v_res := jsonb_build_object('ok', true, 'action', v_act, 'state', 'settled', 'version', v_newver,
                              'cash', v_cash, 'payment_id', v_pay);
  return staffpay_d3.op_log(v_owner, v_op, 'settlement', v_staff, to_char(v_week, 'YYYY-MM-DD'), v_act, p, v_res);
end $$;

-- ---- read API: report for one worker, plus the latest settled week (R2) -----
create or replace function public.staff_workshop_report(p jsonb)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_owner uuid := auth.uid(); v_r jsonb; v_staff uuid;
begin
  if v_owner is null then return jsonb_build_object('ok', false, 'error', 'not signed in'); end if;
  v_staff := (p ->> 'staff_id')::uuid;
  v_r := staffpay_d3.calc(v_owner, v_staff, (p ->> 'to')::date, (p ->> 'from')::date);
  if coalesce((v_r ->> 'ok')::boolean, false) then
    v_r := v_r || jsonb_build_object('latest_settled_week',
      (select max(x.week_key) from public.staff_settlement x
        where x.owner_id = v_owner and x.legacy_id like 'stl\_' || v_staff || '\_%' and x.state = 'settled'));
  end if;
  return v_r;
exception when invalid_text_representation or invalid_datetime_format then
  return jsonb_build_object('ok', false, 'error', 'bad request');
end $$;
