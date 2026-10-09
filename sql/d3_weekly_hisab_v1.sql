-- ============================================================================
-- StaffPay D3 - Workshop weekly hisab on one money ledger (rc10-d3)
-- ----------------------------------------------------------------------------
-- Accounting rules (owner-approved):
--   * staff_payment is the only cash ledger.
--   * Old Hisab = (amount, date): the complete balance at the END of that
--     Asia/Kolkata day. + shop owes worker, - worker owes shop. Only records
--     dated AFTER that day count. No date = Old Hisab not entered (not Rs 0).
--   * Days come only from attendance (Present 1, Half-Day 0.5, Absent 0).
--     A missing day is unknown: balances and settlement are withheld.
--   * Settlement: on/after that week's Sunday (Asia/Kolkata), after the owner
--     confirms Sunday's work is finished; the settlement payment is dated Sunday.
--   * A week's rate is frozen at its first settlement and survives corrections.
--     Temporary release limitation (Q2 open): a workshop rate may change only
--     when every day since the Old Hisab up to today lies in a frozen week.
--
-- Production rollback is NOT this file's down script: deploy rc9-safe and keep
-- every object created here (guards, settlement records, operation log,
-- correction records). See d3_weekly_hisab_v1_down.sql for its limited use.
-- ============================================================================

begin;

-- ---- columns ----------------------------------------------------------------
alter table public.staff_employee add column opening_balance_date date;
alter table public.staff_employee add column terms_version int not null default 0;
-- stable worker reference sent by the app with every payment (the registry's
-- legacy id never changes on rename); lets the database link a payment whose
-- uuid link could not be resolved on the phone (e.g. offline start)
alter table public.staff_payment add column staff_legacy_id text;
alter table public.staff_settlement add column version int not null default 0;
alter table public.staff_settlement add column state text
  check (state is null or state in ('settled', 'corrected'));
alter table public.staff_settlement add column payment_legacy_id text;
alter table public.staff_settlement add column detail jsonb;

create index staff_payment_owner_staff_date_idx on public.staff_payment (owner_id, staff_id, date);
create index staff_payment_unlinked_idx on public.staff_payment (owner_id, date) where staff_id is null;
create index staff_attendance_owner_staff_day_idx on public.staff_attendance (owner_id, staff_id, day_key);

-- ---- operation log (retries, status checks, history of every D3 change) ------
create table public.staff_d3_op (
  op_id        uuid primary key,
  owner_id     uuid not null references auth.users(id) on delete cascade,
  kind         text not null check (kind in ('settlement', 'terms', 'payment')),
  staff_id     uuid,
  ref          text,
  action       text not null,
  request_hash text not null,
  request      jsonb not null,
  result       jsonb not null,
  created_at   timestamptz not null default now());
alter table public.staff_d3_op enable row level security;
create policy staff_d3_op_owner_read on public.staff_d3_op for select to authenticated using (owner_id = auth.uid());
grant select on public.staff_d3_op to authenticated;

-- ---- correction record: a payment removed as a mistaken entry ---------------
create table public.staff_payment_void (
  id         bigserial primary key,
  owner_id   uuid not null references auth.users(id) on delete cascade,
  legacy_id  text not null,
  staff_id   uuid,
  original   jsonb not null,
  reason     text not null,
  op_id      uuid not null,
  voided_at  timestamptz not null default now(),
  unique (owner_id, legacy_id));
alter table public.staff_payment_void enable row level security;
create policy staff_payment_void_owner_read on public.staff_payment_void for select to authenticated using (owner_id = auth.uid());
grant select on public.staff_payment_void to authenticated;

-- ---- private helpers (schema not exposed by the API) --------------------------
create schema staffpay_d3;
revoke all on schema staffpay_d3 from public;
grant usage on schema staffpay_d3 to authenticated;
create function staffpay_d3.today() returns date language sql stable
  as $$ select (now() at time zone 'Asia/Kolkata')::date $$;
create function staffpay_d3.ist_day(ts timestamptz) returns date language sql stable
  as $$ select (ts at time zone 'Asia/Kolkata')::date $$;

-- Resolve only this owner's worker: a foreign uuid is unresolved, never a
-- shortcut around owner checks or a reason to guess from a name.
create function staffpay_d3.payment_worker(p_owner uuid, p_staff uuid, p_legacy text)
returns uuid language sql stable set search_path = public, pg_temp as $$
  select e.id from public.staff_employee e
   where e.owner_id = p_owner
     and case when p_staff is not null then e.id = p_staff
              else p_legacy is not null and e.legacy_id = p_legacy end
   limit 1
$$;

-- is a payment (worker, date) inside a workshop worker's StaffPay period?
create function staffpay_d3.protected(p_owner uuid, p_worker uuid, p_date timestamptz, p_legacy_id text)
returns boolean language sql stable set search_path = public, pg_temp as $$
  select coalesce(p_legacy_id like 'stl\_%', false)
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

-- ---- guards: ordinary phone saves (role "authenticated") ---------------------
-- They never raise: an error would jam that phone's upload queue (D10). A
-- refused change is silently kept as stored; the phone shows the database's
-- value at its next refresh. Approved functions run as their owner and pass.
create function staffpay_d3.guard_employee() returns trigger language plpgsql as $$
begin
  if current_user <> 'authenticated' then return new; end if;
  if tg_op = 'INSERT' then
    new.opening_balance_date := null; new.terms_version := 0; return new;
  end if;
  new.opening_balance_date := old.opening_balance_date;
  new.terms_version := old.terms_version;
  if old.opening_balance_date is not null then
    new.opening_balance := old.opening_balance;
    new.salary := old.salary;
    new.wage_type := old.wage_type;
    new.work_group := old.work_group;
  end if;
  return new;
end $$;
create trigger staff_d3_guard_employee before insert or update on public.staff_employee
  for each row execute function staffpay_d3.guard_employee();

create function staffpay_d3.guard_payment() returns trigger language plpgsql as $$
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
  if staffpay_d3.protected(old.owner_id, v_old_w, old.date, old.legacy_id)
     or staffpay_d3.protected(new.owner_id, v_new_w, new.date, new.legacy_id) then
    new.amount := old.amount; new.date := old.date; new.month_key := old.month_key;
    new.staff_id := old.staff_id; new.staff_legacy_id := old.staff_legacy_id;
    new.legacy_id := old.legacy_id; new.owner_id := old.owner_id;
  end if;
  return new;
end $$;
create trigger staff_d3_guard_payment before insert or update or delete on public.staff_payment
  for each row execute function staffpay_d3.guard_payment();

create function staffpay_d3.guard_settlement() returns trigger language plpgsql as $$
begin
  if current_user <> 'authenticated' then return case when tg_op = 'DELETE' then old else new end; end if;
  if tg_op = 'DELETE' then
    if old.legacy_id like 'stl\_%' then return null; end if; return old;
  end if;
  if new.legacy_id like 'stl\_%' or (tg_op = 'UPDATE' and old.legacy_id like 'stl\_%') then
    if tg_op = 'INSERT' then return null; end if;
    return old;
  end if;
  return new;
end $$;
create trigger staff_d3_guard_settlement before insert or update or delete on public.staff_settlement
  for each row execute function staffpay_d3.guard_settlement();

-- ---- the one calculation ------------------------------------------------------
-- Internal; reads everything inside the caller's single snapshot (STABLE).
-- p_to: reporting date (capped at today). p_from: optional start of a period
-- whose own earnings/payments are reported separately (Payroll month view).
create function staffpay_d3.calc(p_owner uuid, p_staff uuid, p_to date, p_from date default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  e record; v_today date := staffpay_d3.today(); v_b date; v_c date; v_today_unmarked boolean := false;
  v_withheld jsonb := '[]'::jsonb; v_missing jsonb := '[]'::jsonb; v_weeks jsonb := '[]'::jsonb;
  v_m date; v_s date; v_lo date; v_hi date; d date; st text;
  v_p int; v_h int; v_a int; v_rate numeric; v_frozen boolean; v_earn numeric;
  v_adv jsonb; v_adv_t numeric; v_stl_t numeric; v_set record; v_prev numeric; v_close numeric;
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
      v_adv := '[]'::jsonb; v_adv_t := 0; v_stl_t := 0; v_after := '[]'::jsonb;
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

-- ---- read API: report for one worker (one snapshot, one JSON value) ----------
create function public.staff_workshop_report(p jsonb)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_owner uuid := auth.uid();
begin
  if v_owner is null then return jsonb_build_object('ok', false, 'error', 'not signed in'); end if;
  return staffpay_d3.calc(v_owner, (p ->> 'staff_id')::uuid, (p ->> 'to')::date, (p ->> 'from')::date);
exception when invalid_text_representation or invalid_datetime_format then
  return jsonb_build_object('ok', false, 'error', 'bad request');
end $$;

-- ---- read API: complete workshop payment totals/counts for History/Summary ---
create function public.staff_workshop_payments(p jsonb)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_owner uuid := auth.uid(); v_from date; v_to date; v_rows jsonb; v_unres int; v_count int; v_total numeric;
begin
  if v_owner is null then return jsonb_build_object('ok', false, 'error', 'not signed in'); end if;
  v_from := (p ->> 'from')::date; v_to := (p ->> 'to')::date;
  with pay as (
    select staffpay_d3.payment_worker(p2.owner_id, p2.staff_id, p2.staff_legacy_id) as w, p2.amount
      from public.staff_payment p2
     where p2.owner_id = v_owner and staffpay_d3.ist_day(p2.date) between v_from and v_to)
  select coalesce(jsonb_agg(jsonb_build_object('staff_id', e.id, 'legacy_id', e.legacy_id, 'name', e.name,
                                               'count', x.n, 'total', x.t) order by e.name), '[]'::jsonb),
         coalesce(sum(x.n), 0), coalesce(sum(x.t), 0)
    into v_rows, v_count, v_total
    from (select w, count(*) n, sum(amount) t from pay where w is not null group by w) x
    join public.staff_employee e on e.id = x.w and e.owner_id = v_owner and e.work_group = 'workshop';
  select count(*) into v_unres from public.staff_payment p2
   where p2.owner_id = v_owner and staffpay_d3.ist_day(p2.date) between v_from and v_to
     and staffpay_d3.payment_worker(p2.owner_id, p2.staff_id, p2.staff_legacy_id) is null;
  return jsonb_build_object('ok', true, 'from', v_from, 'to', v_to, 'workers', v_rows,
                            'count', v_count, 'total', v_total, 'unknown_worker_count', v_unres);
exception when invalid_text_representation or invalid_datetime_format then
  return jsonb_build_object('ok', false, 'error', 'bad request');
end $$;

-- ---- operation status (after a lost reply) ----------------------------------
create function public.staff_d3_op_status(p jsonb)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_owner uuid := auth.uid(); r record;
begin
  if v_owner is null then return jsonb_build_object('ok', false, 'error', 'not signed in'); end if;
  select * into r from public.staff_d3_op where op_id = (p ->> 'op_id')::uuid and owner_id = v_owner;
  if not found then return jsonb_build_object('ok', true, 'found', false); end if;
  return jsonb_build_object('ok', true, 'found', true, 'kind', r.kind, 'action', r.action, 'result', r.result);
exception when invalid_text_representation then
  return jsonb_build_object('ok', false, 'error', 'bad request');
end $$;

-- shared opening steps for write operations: auth, lock, replay
create function staffpay_d3.op_begin(p_owner uuid, p_op uuid, p_staff uuid, p_req jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare r record;
begin
  perform pg_advisory_xact_lock(hashtext('staffpay-d3'), hashtext(coalesce(p_staff::text, '')));
  select * into r from public.staff_d3_op where op_id = p_op;
  if found then
    if r.owner_id <> p_owner then return jsonb_build_object('ok', false, 'error', 'operation mismatch'); end if;
    if r.request_hash = md5(p_req::text) then return r.result || jsonb_build_object('replayed', true); end if;
    return jsonb_build_object('ok', false, 'error', 'operation mismatch');
  end if;
  return null;
end $$;
revoke all on function staffpay_d3.op_begin(uuid, uuid, uuid, jsonb) from public, anon, authenticated;

create function staffpay_d3.op_log(p_owner uuid, p_op uuid, p_kind text, p_staff uuid, p_ref text, p_action text, p_req jsonb, p_res jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.staff_d3_op (op_id, owner_id, kind, staff_id, ref, action, request_hash, request, result)
  values (p_op, p_owner, p_kind, p_staff, p_ref, p_action, md5(p_req::text), p_req, p_res);
  return p_res;
end $$;
revoke all on function staffpay_d3.op_log(uuid, uuid, text, uuid, text, text, jsonb, jsonb) from public, anon, authenticated;

create function staffpay_d3.void_payment(p_owner uuid, p_legacy text, p_reason text, p_op uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare r record;
begin
  select * into r from public.staff_payment where owner_id = p_owner and legacy_id = p_legacy for update;
  if not found then return; end if;
  insert into public.staff_payment_void (owner_id, legacy_id, staff_id, original, reason, op_id)
  values (p_owner, p_legacy, r.staff_id, to_jsonb(r), p_reason, p_op);
  delete from public.staff_payment where id = r.id;
end $$;
revoke all on function staffpay_d3.void_payment(uuid, text, text, uuid) from public, anon, authenticated;

-- ---- settlement: Settle / Change amount / Correct mistaken entry -------------
create function public.staff_settlement_apply(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_owner uuid := auth.uid(); v_op uuid; v_staff uuid; v_week date; v_sun date; v_act text;
  v_cash numeric; v_ver int; v_r jsonb; e record; s record; v_calc jsonb; w jsonb; v_seen jsonb;
  v_newver int; v_pay text; v_res jsonb; v_reason text; v_ts timestamptz; v_ids jsonb;
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

-- ---- worker terms: Old Hisab and workshop rate -------------------------------
create function public.staff_workshop_terms_set(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_owner uuid := auth.uid(); v_op uuid; v_staff uuid; v_ver int; v_r jsonb; e record;
  v_amt numeric; v_date date; v_rate numeric; v_today date := staffpay_d3.today();
  v_m date; v_res jsonb; v_preview boolean; v_lo date; v_hi date; v_earn jsonb; v_pay jsonb;
  v_set_ob boolean; v_set_rate boolean; v_rate_boundary date;
begin
  if v_owner is null then return jsonb_build_object('ok', false, 'error', 'not signed in'); end if;
  begin
    v_op := (p ->> 'op_id')::uuid; v_staff := (p ->> 'staff_id')::uuid; v_ver := (p ->> 'expected_terms_version')::int;
    v_amt := (p -> 'set' ->> 'opening_balance')::numeric; v_date := (p -> 'set' ->> 'opening_balance_date')::date;
    v_rate := (p -> 'set' ->> 'salary')::numeric; v_preview := coalesce((p ->> 'preview')::boolean, false);
  exception when others then return jsonb_build_object('ok', false, 'error', 'bad request'); end;
  if v_op is null or v_staff is null or v_ver is null then return jsonb_build_object('ok', false, 'error', 'bad request'); end if;
  v_set_ob := coalesce((p -> 'set') ? 'opening_balance' or (p -> 'set') ? 'opening_balance_date', false);
  v_set_rate := coalesce((p -> 'set') ? 'salary', false);
  if not v_preview then
    v_r := staffpay_d3.op_begin(v_owner, v_op, v_staff, p);
    if v_r is not null then return v_r; end if;
  end if;
  select * into e from public.staff_employee where id = v_staff and owner_id = v_owner for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not found'); end if;
  if e.work_group <> 'workshop' then return jsonb_build_object('ok', false, 'error', 'not a workshop worker'); end if;
  if v_ver <> e.terms_version then
    return jsonb_build_object('ok', false, 'error', 'changed elsewhere', 'terms_version', e.terms_version,
      'opening_balance', e.opening_balance, 'opening_balance_date', e.opening_balance_date, 'salary', e.salary);
  end if;

  if v_set_ob then
    if v_amt is null or v_date is null then return jsonb_build_object('ok', false, 'error', 'Old Hisab needs an amount and a date'); end if;
    if v_date > v_today then return jsonb_build_object('ok', false, 'error', 'Old Hisab date cannot be in the future'); end if;
    if e.wage_type <> 'daily' then return jsonb_build_object('ok', false, 'error', 'set pay type to Daily first'); end if;
    if exists (select 1 from public.staff_settlement s where s.owner_id = v_owner and s.staff_id = v_staff and s.legacy_id like 'stl\_%') then
      return jsonb_build_object('ok', false, 'error', 'locked',
        'message', 'Locked: weekly settlements exist after this Old Hisab. A correction needs review.');
    end if;
    if e.opening_balance_date is not null and v_date <> e.opening_balance_date then
      v_lo := least(e.opening_balance_date, v_date) + 1; v_hi := greatest(e.opening_balance_date, v_date);
      select jsonb_build_object('present', count(*) filter (where status = 'Present'), 'half', count(*) filter (where status = 'Half-Day'))
        into v_earn from public.staff_attendance a
       where a.owner_id = v_owner and a.staff_id = v_staff and a.day_key between to_char(v_lo, 'YYYY-MM-DD') and to_char(v_hi, 'YYYY-MM-DD');
      select jsonb_build_object('count', count(*), 'total', coalesce(sum(amount), 0)) into v_pay from public.staff_payment pp
       where pp.owner_id = v_owner and staffpay_d3.payment_worker(pp.owner_id, pp.staff_id, pp.staff_legacy_id) = v_staff
         and staffpay_d3.ist_day(pp.date) between v_lo and v_hi;
    end if;
  end if;

  if v_set_rate then
    if v_rate is null or v_rate < 0 then return jsonb_build_object('ok', false, 'error', 'bad rate'); end if;
    v_rate_boundary := case when v_set_ob then v_date else e.opening_balance_date end;
    if v_rate_boundary is not null and v_rate_boundary < v_today then
      v_m := (v_rate_boundary + 1) - ((extract(isodow from v_rate_boundary + 1)::int) - 1);
      while v_m <= v_today loop
        if not exists (select 1 from public.staff_settlement s
                        where s.owner_id = v_owner and s.legacy_id = 'stl_' || v_staff || '_' || to_char(v_m, 'YYYY-MM-DD')) then
          return jsonb_build_object('ok', false, 'error', 'rate change not allowed yet',
            'message', 'Days from ' || greatest(v_m, v_rate_boundary + 1) || ' are not in a settled week yet. '
                    || 'A workshop rate can change only after all work so far is settled (mid-week rate changes await a decision).');
        end if;
        v_m := v_m + 7;
      end loop;
    end if;
  end if;

  -- Every requested field is validated before the first write. A plain
  -- ok=false return commits a function call, so it must never follow a
  -- partial terms update. Combined changes use one version and one log.
  if v_preview then
    if v_set_ob then
      return jsonb_build_object('ok', true, 'preview', true, 'moved_days', v_earn, 'moved_payments', v_pay,
        'direction', case when v_lo is null then null when v_date > e.opening_balance_date then 'out_of_staffpay' else 'into_staffpay' end,
        'from', v_lo, 'to', v_hi);
    end if;
    return jsonb_build_object('ok', true, 'preview', true);
  end if;
  if v_set_ob or v_set_rate then
    update public.staff_employee set
      opening_balance = case when v_set_ob then v_amt else opening_balance end,
      opening_balance_date = case when v_set_ob then v_date else opening_balance_date end,
      salary = case when v_set_rate then v_rate else salary end,
      terms_version = terms_version + 1, updated_at = now()
    where id = v_staff;
  end if;

  select jsonb_build_object('ok', true, 'terms_version', terms_version, 'opening_balance', opening_balance,
                            'opening_balance_date', opening_balance_date, 'salary', salary)
    into v_res from public.staff_employee where id = v_staff;
  return staffpay_d3.op_log(v_owner, v_op, 'terms', v_staff, null, 'terms', p, v_res);
end $$;

-- ---- controlled correction of a protected payment ----------------------------
create function public.staff_payment_correct(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_owner uuid := auth.uid(); v_op uuid; v_id text; v_act text; v_r jsonb; r record; v_w uuid; ex jsonb;
  v_amt numeric; v_date date; v_reason text; v_res jsonb; v_ts timestamptz; e record;
begin
  if v_owner is null then return jsonb_build_object('ok', false, 'error', 'not signed in'); end if;
  begin
    v_op := (p ->> 'op_id')::uuid; v_id := p ->> 'payment_id'; v_act := p ->> 'action'; ex := p -> 'expected';
    v_amt := (p -> 'new' ->> 'amount')::numeric; v_date := (p -> 'new' ->> 'day')::date;
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
    select * into e from public.staff_employee where id = v_w;
    if v_date is null then v_date := staffpay_d3.ist_day(r.date); end if;
    if v_date <= e.opening_balance_date then
      return jsonb_build_object('ok', false, 'error', 'that date is before the Old Hisab date');
    end if;
    if v_date > staffpay_d3.today() then return jsonb_build_object('ok', false, 'error', 'future date'); end if;
    v_ts := ((v_date::timestamp + ((r.date at time zone 'Asia/Kolkata')::time)) at time zone 'Asia/Kolkata');
    update public.staff_payment set amount = v_amt, date = v_ts, month_key = to_char(v_date, 'YYYY-MM'),
           note = coalesce(p -> 'new' ->> 'note', note) where id = r.id;
    v_res := jsonb_build_object('ok', true, 'action', 'change', 'payment_id', v_id, 'amount', v_amt, 'day', v_date);
  end if;
  return staffpay_d3.op_log(v_owner, v_op, 'payment', v_w, v_id, v_act, p, v_res);
end $$;

-- ---- who may call what ----------------------------------------------------------
revoke all on function public.staff_workshop_report(jsonb), public.staff_workshop_payments(jsonb),
  public.staff_d3_op_status(jsonb), public.staff_settlement_apply(jsonb),
  public.staff_workshop_terms_set(jsonb), public.staff_payment_correct(jsonb) from public, anon;
grant execute on function public.staff_workshop_report(jsonb), public.staff_workshop_payments(jsonb),
  public.staff_d3_op_status(jsonb), public.staff_settlement_apply(jsonb),
  public.staff_workshop_terms_set(jsonb), public.staff_payment_correct(jsonb) to authenticated;
grant execute on function staffpay_d3.today(), staffpay_d3.ist_day(timestamptz),
  staffpay_d3.payment_worker(uuid, uuid, text), staffpay_d3.protected(uuid, uuid, timestamptz, text) to authenticated;

commit;
