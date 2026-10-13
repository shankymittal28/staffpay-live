-- ============================================================================
-- StaffPay R1 - money returned by a workshop worker ("Wapas mila")
-- (on top of d3_weekly_hisab_v1.sql and d3_settlement_order_v1.sql)
-- ----------------------------------------------------------------------------
-- Owner-approved rules:
--   * staff_payment stays the only cash ledger. Money a worker gives back is a
--     row there with a MINUS amount and legacy id rcv_<op_id>, linked to the
--     worker the owner chose by permanent id (uuid), never by name.
--   * Only staff_receipt_add creates one: workshop workers with Old Hisab,
--     dated after the Old Hisab date and not in the future, amount > 0 stored
--     negative, retried safely by op_id, under the same per-worker lock as
--     settlements and corrections.
--   * Every receipt is protected. Ordinary phone saves cannot insert a minus
--     amount or an rcv_ id, cannot turn a payment negative, and cannot edit or
--     delete a receipt (silently kept, like every other guard here).
--   * Changing or removing a receipt goes through staff_payment_correct and
--     needs a page that knows receipts (receipts_ok); older pages are refused
--     with "App update karein".
--   * Weeks keep the net advances_total and gain advances_out_total (money
--     given) and receipts_total (money returned, positive). A page that knows
--     receipts confirms both when settling; older pages keep working for weeks
--     without receipts and are refused for weeks with one.
--   * Reports and month totals for older pages are withheld when a receipt
--     falls in what they show, so no page shows a receipt as a payment.
--
-- No table or column change; no existing data changes. Production rollback of
-- the app (rc14 or rc9-safe) keeps this file applied: its guards keep every
-- receipt safe from older pages. There is no production down script.
-- ============================================================================

begin;

-- is a payment (worker, date) inside a workshop worker's StaffPay period?
create or replace function staffpay_d3.protected(p_owner uuid, p_worker uuid, p_date timestamptz, p_legacy_id text)
returns boolean language sql stable set search_path = public, pg_temp as $$
  select coalesce(p_legacy_id like 'stl\_%' or p_legacy_id like 'rcv\_%', false)
      or exists (select 1 from public.staff_employee e
                  where e.id = p_worker and e.owner_id = p_owner
                    and e.work_group = 'workshop' and e.opening_balance_date is not null
                    and staffpay_d3.ist_day(p_date) > e.opening_balance_date)
      -- a payment whose worker cannot be established is protected whenever it
      -- could belong to any workshop worker's StaffPay period (fail safe)
      or (p_worker is null and exists (select 1 from public.staff_employee e
                  where e.owner_id = p_owner and e.work_group = 'workshop'
                    and e.opening_balance_date is not null
                    and staffpay_d3.ist_day(p_date) > e.opening_balance_date))
$$;

create or replace function staffpay_d3.guard_payment() returns trigger language plpgsql as $$
declare v_old_w uuid; v_new_w uuid;
begin
  if tg_op <> 'DELETE' and new.staff_id is null and new.staff_legacy_id is not null then
    new.staff_id := staffpay_d3.payment_worker(new.owner_id, null, new.staff_legacy_id);
  end if;
  if current_user <> 'authenticated' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'INSERT' then
    if new.legacy_id like 'stl\_%' then return null; end if;                 -- only the settlement function creates these
    if new.legacy_id like 'rcv\_%' or new.amount < 0 then return null; end if; -- only staff_receipt_add records money returned
    if exists (select 1 from public.staff_payment_void v
                where v.owner_id = new.owner_id and v.legacy_id = new.legacy_id) then
      return null;                                                          -- a corrected entry never comes back
    end if;
    return new;                                                             -- a genuinely new payment
  end if;
  v_old_w := staffpay_d3.payment_worker(old.owner_id, old.staff_id, old.staff_legacy_id);
  if tg_op = 'DELETE' then
    if staffpay_d3.protected(old.owner_id, v_old_w, old.date, old.legacy_id) then return null; end if;
    return old;
  end if;
  v_new_w := staffpay_d3.payment_worker(new.owner_id, new.staff_id, new.staff_legacy_id);
  if new.amount < 0 and old.amount >= 0 then new.amount := old.amount; end if; -- a payment never turns into a receipt
  if staffpay_d3.protected(old.owner_id, v_old_w, old.date, old.legacy_id)
     or staffpay_d3.protected(new.owner_id, v_new_w, new.date, new.legacy_id) then
    new.amount := old.amount; new.date := old.date; new.month_key := old.month_key;
    new.staff_id := old.staff_id; new.staff_legacy_id := old.staff_legacy_id;
    new.legacy_id := old.legacy_id; new.owner_id := old.owner_id;
  end if;
  return new;
end $$;


-- ---- the one calculation: adds gross given / returned per week ---------------
create or replace function staffpay_d3.calc(p_owner uuid, p_staff uuid, p_to date, p_from date default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  e record; v_today date := staffpay_d3.today(); v_b date; v_c date; v_today_unmarked boolean := false;
  v_withheld jsonb := '[]'::jsonb; v_missing jsonb := '[]'::jsonb; v_weeks jsonb := '[]'::jsonb;
  v_m date; v_s date; v_lo date; v_hi date; d date; st text;
  v_p int; v_h int; v_a int; v_rate numeric; v_frozen boolean; v_earn numeric;
  v_adv jsonb; v_adv_t numeric; v_out_t numeric; v_rcv_t numeric; v_stl_t numeric; v_set record; v_prev numeric; v_close numeric;
  v_earn_tot numeric := 0; v_paid_tot numeric := 0; v_per_earn numeric := 0; v_per_paid numeric := 0;
  v_unres int; v_unres_att int; v_wmiss jsonb; v_after jsonb; v_attchg jsonb; v_days jsonb; pr record;
begin
  select * into e from public.staff_employee where id = p_staff and owner_id = p_owner;
  if not found then return jsonb_build_object('ok', false, 'error', 'not found'); end if;
  v_b := e.opening_balance_date;
  if e.work_group <> 'workshop' then
    return jsonb_build_object('ok', false, 'error', 'not a workshop worker');
  end if;
  if v_b is null then
    return jsonb_build_object('ok', true, 'worker', jsonb_build_object('id', e.id, 'legacy_id', e.legacy_id, 'name', e.name,
        'rate', e.salary, 'wage_type', e.wage_type, 'terms_version', e.terms_version, 'active', e.active),
      'old_hisab', null, 'withheld', jsonb_build_array('Old Hisab not entered'));
  end if;
  if e.wage_type <> 'daily' then v_withheld := v_withheld || to_jsonb('Pay type must be Daily for weekly hisab'::text); end if;
  v_c := least(coalesce(p_to, v_today), v_today);
  -- today not yet marked: report up to yesterday and say so
  if v_c = v_today and v_c > v_b and not exists (select 1 from public.staff_attendance a
       where a.owner_id = p_owner and a.staff_id = p_staff and a.day_key = to_char(v_c, 'YYYY-MM-DD')) then
    v_c := v_c - 1; v_today_unmarked := true;
  end if;
  -- payments whose worker cannot be established could belong to anyone
  select count(*) into v_unres from public.staff_payment p
   where p.owner_id = p_owner
     and staffpay_d3.payment_worker(p.owner_id, p.staff_id, p.staff_legacy_id) is null
     and staffpay_d3.ist_day(p.date) > v_b and staffpay_d3.ist_day(p.date) <= v_c;
  if v_unres > 0 then
    v_withheld := v_withheld || to_jsonb(v_unres || ' payment(s) after the Old Hisab date have no recorded worker');
  end if;
  select count(*) into v_unres_att from public.staff_attendance a
   where a.owner_id = p_owner and a.staff_id is null
     and a.day_key > to_char(v_b, 'YYYY-MM-DD') and a.day_key <= to_char(v_c, 'YYYY-MM-DD');
  if v_unres_att > 0 then
    v_withheld := v_withheld || to_jsonb(v_unres_att || ' attendance record(s) after the Old Hisab date have no recorded worker');
  end if;

  v_prev := e.opening_balance;
  if v_c > v_b then
    v_m := (v_b + 1) - ((extract(isodow from v_b + 1)::int) - 1);
    while v_m <= v_c loop
      v_s := v_m + 6; v_lo := greatest(v_m, v_b + 1); v_hi := least(v_s, v_c);
      v_p := 0; v_h := 0; v_a := 0; v_wmiss := '[]'::jsonb; v_days := '{}'::jsonb;
      d := v_lo;
      while d <= v_hi loop
        select a.status into st from public.staff_attendance a
         where a.owner_id = p_owner and a.staff_id = p_staff and a.day_key = to_char(d, 'YYYY-MM-DD')
         order by a.created_at desc limit 1;
        if st is null then v_wmiss := v_wmiss || to_jsonb(to_char(d, 'YYYY-MM-DD'));
        else
          v_days := v_days || jsonb_build_object(to_char(d, 'YYYY-MM-DD'), st);
          if st = 'Present' then v_p := v_p + 1; elsif st = 'Half-Day' then v_h := v_h + 1; else v_a := v_a + 1; end if;
        end if;
        st := null; d := d + 1;
      end loop;
      v_missing := v_missing || v_wmiss;
      select * into v_set from public.staff_settlement s
       where s.owner_id = p_owner and s.legacy_id = 'stl_' || p_staff || '_' || to_char(v_m, 'YYYY-MM-DD');
      if found then v_rate := v_set.daily_wage; v_frozen := true; else v_rate := e.salary; v_frozen := false; end if;
      v_earn := v_rate * (v_p + 0.5 * v_h);
      v_adv := '[]'::jsonb; v_adv_t := 0; v_out_t := 0; v_rcv_t := 0; v_stl_t := 0; v_after := '[]'::jsonb;
      for pr in select p.legacy_id, p.amount, p.note, staffpay_d3.ist_day(p.date) as day from public.staff_payment p
                 where p.owner_id = p_owner
                   and staffpay_d3.payment_worker(p.owner_id, p.staff_id, p.staff_legacy_id) = p_staff
                   and staffpay_d3.ist_day(p.date) between v_lo and v_hi
                 order by p.date, p.legacy_id loop
        if pr.legacy_id like 'stl\_' || p_staff || '\_' || to_char(v_m, 'YYYY-MM-DD') || '\_%' then
          v_stl_t := v_stl_t + pr.amount;
        else
          v_adv := v_adv || jsonb_build_object('id', pr.legacy_id, 'day', pr.day, 'amount', pr.amount, 'note', pr.note);
          v_adv_t := v_adv_t + pr.amount;
          -- gross figures beside the net: money given out, money returned (positive)
          if pr.amount < 0 then v_rcv_t := v_rcv_t - pr.amount; else v_out_t := v_out_t + pr.amount; end if;
          if v_set.state = 'settled' and not coalesce((v_set.detail -> 'advance_ids') ? pr.legacy_id, false) then
            v_after := v_after || jsonb_build_object('id', pr.legacy_id, 'day', pr.day, 'amount', pr.amount);
          end if;
        end if;
      end loop;
      v_attchg := '[]'::jsonb;
      if v_set.state = 'settled' and v_set.detail ? 'days' then
        select coalesce(jsonb_agg(jsonb_build_object('day', k, 'was', v_set.detail -> 'days' ->> k, 'now', v_days ->> k)), '[]'::jsonb)
          into v_attchg
          from (select jsonb_object_keys(v_days || (v_set.detail -> 'days')) k) q
         where (v_set.detail -> 'days' ->> k) is distinct from (v_days ->> k);
      end if;
      v_close := v_prev + v_earn - v_adv_t - v_stl_t;
      v_weeks := v_weeks || jsonb_build_object(
        'monday', v_m, 'sunday', v_s, 'from', v_lo, 'to', v_hi,
        'present', v_p, 'half', v_h, 'absent', v_a, 'days_worked', v_p + 0.5 * v_h,
        'attendance', v_days, 'missing', v_wmiss, 'rate', v_rate, 'rate_frozen', v_frozen,
        'earned', v_earn, 'previous', v_prev, 'advances', v_adv, 'advances_total', v_adv_t,
        'advances_out_total', v_out_t, 'receipts_total', v_rcv_t,
        'settlement_cash', v_stl_t, 'closing', v_close,
        'settlement', case when v_set.legacy_id is null then null else jsonb_build_object(
            'state', v_set.state, 'version', v_set.version, 'cash', v_set.cash_paid,
            'payment_id', v_set.payment_legacy_id, 'settled_at', v_set.settled_at, 'detail', v_set.detail) end,
        'added_after_settlement', v_after, 'attendance_changed_after_settlement', v_attchg);
      v_earn_tot := v_earn_tot + v_earn; v_paid_tot := v_paid_tot + v_adv_t + v_stl_t;
      if p_from is not null then
        -- period figures count only days on/after p_from (weeks may cross it)
        if v_hi >= p_from then
          if v_lo >= p_from then
            v_per_earn := v_per_earn + v_earn; v_per_paid := v_per_paid + v_adv_t + v_stl_t;
          else
            v_per_earn := v_per_earn + v_rate * (
              (select count(*) from jsonb_each_text(v_days) j where j.key::date >= p_from and j.value = 'Present')
              + 0.5 * (select count(*) from jsonb_each_text(v_days) j where j.key::date >= p_from and j.value = 'Half-Day'));
            v_per_paid := v_per_paid + coalesce((select sum(p.amount) from public.staff_payment p
               where p.owner_id = p_owner
                 and staffpay_d3.payment_worker(p.owner_id, p.staff_id, p.staff_legacy_id) = p_staff
                 and staffpay_d3.ist_day(p.date) between p_from and v_hi), 0);
          end if;
        end if;
      end if;
      v_prev := v_close; v_m := v_m + 7;
    end loop;
  end if;
  if jsonb_array_length(v_missing) > 0 then
    v_withheld := v_withheld || to_jsonb('Attendance not marked: ' || (select string_agg(x, ', ') from jsonb_array_elements_text(v_missing) x));
  end if;
  return jsonb_build_object('ok', true,
    'worker', jsonb_build_object('id', e.id, 'legacy_id', e.legacy_id, 'name', e.name, 'rate', e.salary,
                                 'wage_type', e.wage_type, 'terms_version', e.terms_version, 'active', e.active),
    'old_hisab', jsonb_build_object('amount', e.opening_balance, 'date', v_b),
    'today', v_today, 'cutoff', v_c, 'today_unmarked', v_today_unmarked,
    'weeks', v_weeks, 'missing', v_missing, 'withheld', v_withheld,
    'earned_total', v_earn_tot, 'paid_total', v_paid_tot,
    'balance', e.opening_balance + v_earn_tot - v_paid_tot,
    'period', case when p_from is null then null else jsonb_build_object('from', p_from,
        'earned', v_per_earn, 'paid', v_per_paid,
        'brought_forward', e.opening_balance + v_earn_tot - v_paid_tot - v_per_earn + v_per_paid) end);
end $$;
revoke all on function staffpay_d3.calc(uuid, uuid, date, date) from public, anon, authenticated;

-- ---- the amount rule for money returned (creation and correction alike) -------
-- a real figure: not null, not NaN, not +/-Infinity; more than 0; below
-- Rs 1,00,00,000; at most two decimal places (PostgreSQL ranks NaN above
-- every number, so it is excluded by name)
create or replace function staffpay_d3.receipt_amount_ok(p numeric)
returns boolean language sql immutable as $$
  select coalesce(p::text not in ('NaN', 'Infinity', '-Infinity') and p > 0 and p < 10000000 and p = round(p, 2), false)
$$;
revoke all on function staffpay_d3.receipt_amount_ok(numeric) from public, anon, authenticated;

-- ---- record money returned by a worker ---------------------------------------
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
  if e.work_group <> 'workshop' then
    return jsonb_build_object('ok', false, 'error', 'not a workshop worker',
      'message', 'Wapas mila paisa sirf workshop worker ke liye likha ja sakta hai.');
  end if;
  if e.opening_balance_date is null then
    return jsonb_build_object('ok', false, 'error', 'Old Hisab not entered for this workshop worker');
  end if;
  if not staffpay_d3.receipt_amount_ok(v_amt) then
    return jsonb_build_object('ok', false, 'error', 'bad amount',
      'message', 'Amount 0 se zyada, 2 decimal tak aur ₹1 crore se kam likhein.');
  end if;
  if v_day <= e.opening_balance_date then
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
                              'amount', v_amt, 'day', v_day);
  return staffpay_d3.op_log(v_owner, v_op, 'payment', v_staff, v_id, 'receipt', p, v_res);
end $$;

-- ---- settlement: as N1, plus the receipt checks --------------------------------
create or replace function public.staff_settlement_apply(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_owner uuid := auth.uid(); v_op uuid; v_staff uuid; v_week date; v_sun date; v_act text;
  v_cash numeric; v_ver int; v_r jsonb; e record; s record; v_calc jsonb; w jsonb; v_seen jsonb;
  v_newver int; v_pay text; v_res jsonb; v_reason text; v_ts timestamptz; v_ids jsonb;
  v_m date; v_later text; v_rok boolean;
begin
  if v_owner is null then return jsonb_build_object('ok', false, 'error', 'not signed in'); end if;
  begin
    v_op := (p ->> 'op_id')::uuid; v_staff := (p ->> 'staff_id')::uuid; v_week := (p ->> 'week')::date;
    v_act := p ->> 'action'; v_cash := (p ->> 'cash')::numeric; v_ver := (p ->> 'expected_version')::int;
    v_rok := coalesce((p ->> 'receipts_ok')::boolean, false);
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
  -- receipts: a week with money returned is settled only by a page that shows
  -- it; such a page also confirms given and returned separately (an equal
  -- extra advance and receipt leave the net unchanged but change the week).
  -- Older pages (no flag) keep the five-figure check for weeks without receipts.
  if (w ->> 'receipts_total')::numeric > 0 and not v_rok then
    return jsonb_build_object('ok', false, 'error', 'upgrade required',
      'message', 'App update karein — is hafte mein wapas mila paisa hai, purani app se ye hafta settle nahi hoga.');
  end if;
  v_seen := p -> 'seen';
  if v_seen is null
     or (v_seen ->> 'days')::numeric     is distinct from (w ->> 'days_worked')::numeric
     or (v_seen ->> 'rate')::numeric     is distinct from (w ->> 'rate')::numeric
     or (v_seen ->> 'earned')::numeric   is distinct from (w ->> 'earned')::numeric
     or (v_seen ->> 'previous')::numeric is distinct from (w ->> 'previous')::numeric
     or (v_seen ->> 'advances')::numeric is distinct from (w ->> 'advances_total')::numeric
     or (v_rok and ((v_seen ->> 'advances_out')::numeric is distinct from (w ->> 'advances_out_total')::numeric
                 or (v_seen ->> 'received')::numeric     is distinct from (w ->> 'receipts_total')::numeric)) then
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
            'advances_out_total', (w ->> 'advances_out_total')::numeric, 'receipts_total', (w ->> 'receipts_total')::numeric,
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


-- ---- controlled correction: receipts need a page that knows them -------------
create or replace function public.staff_payment_correct(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_owner uuid := auth.uid(); v_op uuid; v_id text; v_act text; v_r jsonb; r record; v_w uuid; ex jsonb;
  v_amt numeric; v_date date; v_reason text; v_res jsonb; v_ts timestamptz; e record;
  v_rok boolean; v_rcv boolean;
begin
  if v_owner is null then return jsonb_build_object('ok', false, 'error', 'not signed in'); end if;
  begin
    v_op := (p ->> 'op_id')::uuid; v_id := p ->> 'payment_id'; v_act := p ->> 'action'; ex := p -> 'expected';
    v_amt := (p -> 'new' ->> 'amount')::numeric; v_date := (p -> 'new' ->> 'day')::date;
    v_rok := coalesce((p ->> 'receipts_ok')::boolean, false);
  exception when others then return jsonb_build_object('ok', false, 'error', 'bad request'); end;
  v_reason := btrim(coalesce(p ->> 'reason', ''));
  if v_op is null or v_id is null or v_act not in ('change', 'remove', 'assign') or ex is null then
    return jsonb_build_object('ok', false, 'error', 'bad request');
  end if;
  if v_reason = '' then return jsonb_build_object('ok', false, 'error', 'a reason is required'); end if;
  select * into r from public.staff_payment where owner_id = v_owner and legacy_id = v_id;
  v_w := case when found then staffpay_d3.payment_worker(r.owner_id, r.staff_id, r.staff_legacy_id) end;
  v_r := staffpay_d3.op_begin(v_owner, v_op, v_w, p);
  if v_r is not null then return v_r; end if;
  select * into r from public.staff_payment where owner_id = v_owner and legacy_id = v_id for update;
  if not found then
    if exists (select 1 from public.staff_payment_void where owner_id = v_owner and legacy_id = v_id) then
      return jsonb_build_object('ok', false, 'error', 'already removed');
    end if;
    return jsonb_build_object('ok', false, 'error', 'not found');
  end if;
  if v_id like 'stl\_%' then return jsonb_build_object('ok', false, 'error', 'use the weekly settlement screen'); end if;
  -- money returned by a worker: only a page that shows receipts may change or
  -- remove one (an older page would treat it as a normal payment)
  v_rcv := r.amount < 0 or v_id like 'rcv\_%';
  if v_rcv and not v_rok then
    return jsonb_build_object('ok', false, 'error', 'upgrade required',
      'message', 'App update karein — wapas mila paise ki entry purani app se badli ya hataayi nahi ja sakti.');
  end if;
  v_w := staffpay_d3.payment_worker(r.owner_id, r.staff_id, r.staff_legacy_id);
  if not staffpay_d3.protected(v_owner, v_w, r.date, r.legacy_id) then
    return jsonb_build_object('ok', false, 'error', 'not protected - edit it normally');
  end if;
  if (ex ->> 'amount')::numeric is distinct from r.amount
     or (ex ->> 'day')::date is distinct from staffpay_d3.ist_day(r.date)
     or (ex ->> 'staff_id')::uuid is distinct from v_w then
    return jsonb_build_object('ok', false, 'error', 'payment changed', 'current',
      jsonb_build_object('amount', r.amount, 'day', staffpay_d3.ist_day(r.date), 'staff_id', v_w));
  end if;
  if v_act = 'assign' then
    -- an unlinked payment is linked only by the owner's explicit choice, never by name
    if v_w is not null then return jsonb_build_object('ok', false, 'error', 'payment already has a worker'); end if;
    select * into e from public.staff_employee where owner_id = v_owner and id = (p -> 'new' ->> 'staff_id')::uuid;
    if not found then return jsonb_build_object('ok', false, 'error', 'choose a worker'); end if;
    update public.staff_payment set staff_id = e.id, staff_legacy_id = e.legacy_id where id = r.id;
    v_res := jsonb_build_object('ok', true, 'action', 'assign', 'payment_id', v_id, 'staff_id', e.id);
  elsif v_act = 'remove' then
    if coalesce((p ->> 'cash_not_given')::boolean, false) is not true then
      return jsonb_build_object('ok', false, 'error', 'confirm the money was NOT given');
    end if;
    perform staffpay_d3.void_payment(v_owner, v_id, v_reason, v_op);
    v_res := jsonb_build_object('ok', true, 'action', 'remove', 'payment_id', v_id);
  else
    if v_w is null then return jsonb_build_object('ok', false, 'error', 'assign a worker first'); end if;
    if v_amt is null or v_amt <= 0 then return jsonb_build_object('ok', false, 'error', 'amount must be more than 0'); end if;
    -- a receipt follows the receipt amount rule; ordinary payments are unchanged
    if v_rcv and not staffpay_d3.receipt_amount_ok(v_amt) then
      return jsonb_build_object('ok', false, 'error', 'bad amount',
        'message', 'Amount 0 se zyada, 2 decimal tak aur ₹1 crore se kam likhein.');
    end if;
    select * into e from public.staff_employee where id = v_w;
    if v_date is null then v_date := staffpay_d3.ist_day(r.date); end if;
    if v_date <= e.opening_balance_date then
      return jsonb_build_object('ok', false, 'error', 'that date is before the Old Hisab date');
    end if;
    if v_date > staffpay_d3.today() then return jsonb_build_object('ok', false, 'error', 'future date'); end if;
    v_ts := ((v_date::timestamp + ((r.date at time zone 'Asia/Kolkata')::time)) at time zone 'Asia/Kolkata');
    -- the amount arrives as a positive figure; a receipt stays a receipt
    if v_rcv then v_amt := -abs(v_amt); end if;
    update public.staff_payment set amount = v_amt, date = v_ts, month_key = to_char(v_date, 'YYYY-MM'),
           note = coalesce(p -> 'new' ->> 'note', note) where id = r.id;
    v_res := jsonb_build_object('ok', true, 'action', 'change', 'payment_id', v_id, 'amount', v_amt, 'day', v_date);
  end if;
  return staffpay_d3.op_log(v_owner, v_op, 'payment', v_w, v_id, v_act, p, v_res);
end $$;


-- ---- read API: report for one worker -----------------------------------------
-- As N1 (latest_settled_week). A page that knows receipts sends receipts_ok and
-- also gets period_received. For an older page the figures are withheld when a
-- receipt falls in what it shows (the requested period, or the week of "to").
create or replace function public.staff_workshop_report(p jsonb)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_owner uuid := auth.uid(); v_r jsonb; v_staff uuid; v_rok boolean; v_from date; v_to date;
  v_lo date; v_hi date; v_rcv numeric;
begin
  if v_owner is null then return jsonb_build_object('ok', false, 'error', 'not signed in'); end if;
  v_staff := (p ->> 'staff_id')::uuid; v_from := (p ->> 'from')::date; v_to := (p ->> 'to')::date;
  v_rok := coalesce((p ->> 'receipts_ok')::boolean, false);
  v_r := staffpay_d3.calc(v_owner, v_staff, v_to, v_from);
  if coalesce((v_r ->> 'ok')::boolean, false) then
    v_r := v_r || jsonb_build_object('latest_settled_week',
      (select max(x.week_key) from public.staff_settlement x
        where x.owner_id = v_owner and x.legacy_id like 'stl\_' || v_staff || '\_%' and x.state = 'settled'));
    if v_r ? 'cutoff' then
      v_hi := (v_r ->> 'cutoff')::date;
      if v_rok then
        if v_from is not null then
          select coalesce(-sum(x.amount), 0) into v_rcv from public.staff_payment x
           where x.owner_id = v_owner and x.amount < 0
             and staffpay_d3.payment_worker(x.owner_id, x.staff_id, x.staff_legacy_id) = v_staff
             and staffpay_d3.ist_day(x.date) between v_from and v_hi;
          v_r := v_r || jsonb_build_object('period_received', v_rcv);
        end if;
        v_r := v_r || jsonb_build_object('receipts_ok', true);
      else
        v_to := coalesce(v_to, staffpay_d3.today());
        v_lo := least(coalesce(v_from, v_to - (extract(isodow from v_to)::int - 1)),
                      v_hi - (extract(isodow from v_hi)::int - 1));
        if exists (select 1 from public.staff_payment x
                    where x.owner_id = v_owner and x.amount < 0
                      and staffpay_d3.payment_worker(x.owner_id, x.staff_id, x.staff_legacy_id) = v_staff
                      and staffpay_d3.ist_day(x.date) between v_lo and v_hi) then
          v_r := jsonb_set(v_r, '{withheld}', coalesce(v_r -> 'withheld', '[]'::jsonb)
                   || to_jsonb('Is hafte mein wapas mila paisa hai — app refresh/update karein'::text));
        end if;
      end if;
    end if;
  end if;
  return v_r;
exception when invalid_text_representation or invalid_datetime_format then
  return jsonb_build_object('ok', false, 'error', 'bad request');
end $$;

-- ---- read API: workshop payment totals for History/Summary/Payroll -----------
-- total stays the net. A page that knows receipts also gets given/received per
-- worker and overall; an older page is refused when the range holds a receipt.
create or replace function public.staff_workshop_payments(p jsonb)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_owner uuid := auth.uid(); v_from date; v_to date; v_rows jsonb; v_unres int; v_count int; v_total numeric;
  v_given numeric; v_recv numeric; v_rok boolean;
begin
  if v_owner is null then return jsonb_build_object('ok', false, 'error', 'not signed in'); end if;
  v_from := (p ->> 'from')::date; v_to := (p ->> 'to')::date;
  v_rok := coalesce((p ->> 'receipts_ok')::boolean, false);
  with pay as (
    select staffpay_d3.payment_worker(p2.owner_id, p2.staff_id, p2.staff_legacy_id) as w, p2.amount
      from public.staff_payment p2
     where p2.owner_id = v_owner and staffpay_d3.ist_day(p2.date) between v_from and v_to)
  select coalesce(jsonb_agg(jsonb_build_object('staff_id', e.id, 'legacy_id', e.legacy_id, 'name', e.name,
                                               'count', x.n, 'total', x.t, 'given', x.g, 'received', x.r) order by e.name), '[]'::jsonb),
         coalesce(sum(x.n), 0), coalesce(sum(x.t), 0), coalesce(sum(x.g), 0), coalesce(sum(x.r), 0)
    into v_rows, v_count, v_total, v_given, v_recv
    from (select w, count(*) n, sum(amount) t,
                 coalesce(sum(amount) filter (where amount > 0), 0) g,
                 coalesce(-sum(amount) filter (where amount < 0), 0) r
            from pay where w is not null group by w) x
    join public.staff_employee e on e.id = x.w and e.owner_id = v_owner and e.work_group = 'workshop';
  if not v_rok and v_recv > 0 then
    return jsonb_build_object('ok', false, 'error', 'upgrade required',
      'message', 'App update karein — is samay mein wapas mila paisa hai.');
  end if;
  select count(*) into v_unres from public.staff_payment p2
   where p2.owner_id = v_owner and staffpay_d3.ist_day(p2.date) between v_from and v_to
     and staffpay_d3.payment_worker(p2.owner_id, p2.staff_id, p2.staff_legacy_id) is null;
  if not v_rok then
    -- older pages get exactly the fields they always had
    select coalesce(jsonb_agg(r - 'given' - 'received'), '[]'::jsonb) into v_rows from jsonb_array_elements(v_rows) r;
    return jsonb_build_object('ok', true, 'from', v_from, 'to', v_to, 'workers', v_rows,
                              'count', v_count, 'total', v_total, 'unknown_worker_count', v_unres);
  end if;
  return jsonb_build_object('ok', true, 'from', v_from, 'to', v_to, 'workers', v_rows,
                            'count', v_count, 'total', v_total, 'given', v_given, 'received', v_recv,
                            'unknown_worker_count', v_unres, 'receipts_ok', true);
exception when invalid_text_representation or invalid_datetime_format then
  return jsonb_build_object('ok', false, 'error', 'bad request');
end $$;

-- ---- who may call what ----------------------------------------------------------
revoke all on function public.staff_receipt_add(jsonb) from public, anon;
grant execute on function public.staff_receipt_add(jsonb) to authenticated;

commit;
