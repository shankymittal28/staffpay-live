-- Disposable mirror of the production StaffPay schema (read from the live
-- catalog on 2026-10-09): staff_* tables with their columns, defaults,
-- constraints, indexes, RLS policies and grants, plus the Supabase pieces
-- they rely on (roles, auth.users, auth.uid()) and Project Zero's
-- attendance door pz_attendance_assert. For tests only.
do $$ begin
  if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select from pg_roles where rolname = 'authenticator') then create role authenticator login password 'auth' noinherit; end if;
end $$;
grant anon, authenticated, service_role to authenticator;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(coalesce(current_setting('request.jwt.claim.sub', true),
                (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')), '')::uuid $$;
grant execute on function auth.uid() to anon, authenticated, service_role;

grant usage on schema public to anon, authenticated, service_role;

create table public.staff_employee (
  id uuid not null default gen_random_uuid() primary key,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  legacy_id text not null, name text not null,
  work_group text not null default 'shop', phone text not null default '',
  active boolean not null default true, salary numeric not null default 0,
  wage_type text not null default 'monthly', source text, device text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  removed boolean not null default false, opening_balance numeric not null default 0,
  constraint staff_employee_owner_legacy_uniq unique (owner_id, legacy_id));
create table public.staff_payment (
  id uuid not null default gen_random_uuid() primary key,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  legacy_id text not null, staff_id uuid references public.staff_employee(id) on delete set null,
  name text not null, amount numeric not null, note text not null default '',
  date timestamptz not null, month_key text, device text,
  created_at timestamptz not null default now(),
  constraint staff_payment_owner_legacy_uniq unique (owner_id, legacy_id));
create index staff_payment_staff_id_idx on public.staff_payment (staff_id);
create table public.staff_attendance (
  id uuid not null default gen_random_uuid() primary key,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  legacy_id text not null, staff_id uuid references public.staff_employee(id) on delete set null,
  name text not null, status text not null, note text not null default '',
  date timestamptz not null, month_key text, day_key text not null, device text,
  created_at timestamptz not null default now(),
  constraint staff_attendance_owner_legacy_uniq unique (owner_id, legacy_id));
create index staff_attendance_staff_id_idx on public.staff_attendance (staff_id);
create unique index staff_attendance_owner_staff_day_uniq on public.staff_attendance (owner_id, staff_id, day_key) where staff_id is not null;
create table public.staff_settlement (
  id uuid not null default gen_random_uuid() primary key,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  legacy_id text not null, staff_id uuid references public.staff_employee(id) on delete set null,
  name text not null, week_key text, days_worked numeric not null default 0,
  daily_wage numeric not null default 0, cash_paid numeric not null default 0,
  settled_at timestamptz, device text, created_at timestamptz not null default now(),
  constraint staff_settlement_owner_legacy_uniq unique (owner_id, legacy_id));
create index staff_settlement_staff_id_idx on public.staff_settlement (staff_id);

alter table public.staff_employee enable row level security;
alter table public.staff_payment enable row level security;
alter table public.staff_attendance enable row level security;
alter table public.staff_settlement enable row level security;
create policy staff_employee_owner_all on public.staff_employee for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy staff_payment_owner_all on public.staff_payment for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy staff_attendance_owner_all on public.staff_attendance for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy staff_settlement_owner_all on public.staff_settlement for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- grants exactly as in production
grant truncate, references, trigger on public.staff_employee, public.staff_payment, public.staff_attendance, public.staff_settlement to anon;
grant insert, select, update, truncate, references, trigger on public.staff_employee to authenticated;
grant select, truncate, references, trigger on public.staff_employee to service_role;
grant insert, select, update, delete, truncate, references, trigger on public.staff_payment to authenticated;
grant truncate, references, trigger on public.staff_payment to service_role;
grant select, truncate, references, trigger on public.staff_attendance to authenticated;
grant truncate, references, trigger on public.staff_attendance to service_role;
grant insert, select, update, delete, truncate, references, trigger on public.staff_settlement to authenticated;
grant truncate, references, trigger on public.staff_settlement to service_role;

create table pz_attendance_act (
  id           bigserial primary key,
  employee_id  uuid not null references public.staff_employee(id),
  business_day date not null,
  status       text not null check (status in ('Present','Half-Day','Absent')),
  prev_status  text check (prev_status is null or prev_status in ('Present','Half-Day','Absent')),
  actor_kind   text not null check (actor_kind in ('owner','head')),
  actor_id     text not null check (length(actor_id) between 1 and 64),
  actor_name   text not null check (length(actor_name) between 1 and 60),
  reason       text check (reason is null or length(reason) between 1 and 200),
  old_row_id   uuid,
  new_row_id   uuid not null,
  client_id    text not null unique check (length(client_id) between 8 and 80),
  created_at   timestamptz not null default now(),
  check (prev_status is null or reason is not null));
create or replace function pz_attendance_assert(
  p_owner uuid, p_employee uuid, p_day date, p_status text,
  p_actor_kind text, p_actor_id text, p_actor_name text,
  p_reason text, p_client_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_act   record;
  v_old   record;
  v_new   uuid;
  v_emp   record;
  v_prev  text := null;
  v_oldid uuid := null;
begin
  if p_status not in ('Present', 'Half-Day', 'Absent') then
    return jsonb_build_object('ok', false, 'error', 'bad status');
  end if;
  if p_actor_kind not in ('owner', 'head') then
    return jsonb_build_object('ok', false, 'error', 'bad actor');
  end if;
  if p_client_id is null or length(p_client_id) < 8 then
    return jsonb_build_object('ok', false, 'error', 'bad client id');
  end if;
  if p_day > v_today then
    return jsonb_build_object('ok', false, 'error', 'future day');
  end if;
  if p_actor_kind = 'head' and p_day <> v_today then
    return jsonb_build_object('ok', false, 'error', 'today only');
  end if;
  select * into v_act from pz_attendance_act where client_id = p_client_id;
  if found then
    return jsonb_build_object('ok', true, 'replayed', true, 'status', v_act.status,
                              'prev_status', v_act.prev_status, 'row_id', v_act.new_row_id);
  end if;
  perform pg_advisory_xact_lock(4213, hashtext(p_employee::text || p_day::text));
  select * into v_act from pz_attendance_act where client_id = p_client_id;   -- again, under the lock
  if found then
    return jsonb_build_object('ok', true, 'replayed', true, 'status', v_act.status,
                              'prev_status', v_act.prev_status, 'row_id', v_act.new_row_id);
  end if;
  select id, name, active, removed into v_emp from public.staff_employee where id = p_employee;
  if not found or not coalesce(v_emp.active, false) or coalesce(v_emp.removed, false) then
    return jsonb_build_object('ok', false, 'error', 'inactive');
  end if;
  select id, status into v_old from public.staff_attendance
   where owner_id = p_owner and staff_id = p_employee and day_key = to_char(p_day, 'YYYY-MM-DD')
   order by created_at desc, id desc limit 1;
  if found then
    if p_reason is null or length(btrim(p_reason)) = 0 then
      return jsonb_build_object('ok', false, 'error', 'reason required', 'prev_status', v_old.status);
    end if;
    v_prev := v_old.status;
    v_oldid := v_old.id;
    delete from public.staff_attendance
     where owner_id = p_owner and staff_id = p_employee and day_key = to_char(p_day, 'YYYY-MM-DD');
  end if;
  insert into public.staff_attendance (owner_id, legacy_id, staff_id, name, status, note, date, month_key, day_key, device)
    values (p_owner, 'pz_' || p_client_id, p_employee, v_emp.name, p_status, '',
            ((p_day::timestamp + (now() at time zone 'Asia/Kolkata')::time) at time zone 'Asia/Kolkata'),
            to_char(p_day, 'YYYY-MM'), to_char(p_day, 'YYYY-MM-DD'), 'pz-server')
    returning id into v_new;
  insert into pz_attendance_act (employee_id, business_day, status, prev_status, actor_kind,
                                 actor_id, actor_name, reason, old_row_id, new_row_id, client_id)
    values (p_employee, p_day, p_status, v_prev, p_actor_kind, p_actor_id, p_actor_name,
            case when v_prev is null then null else left(p_reason, 200) end, v_oldid, v_new, p_client_id);
  return jsonb_build_object('ok', true, 'replayed', false, 'status', p_status,
                            'prev_status', v_prev, 'row_id', v_new);
end $$;
grant execute on function pz_attendance_assert(uuid, uuid, date, text, text, text, text, text, text) to service_role;
revoke execute on function pz_attendance_assert(uuid, uuid, date, text, text, text, text, text, text) from anon, authenticated, public;

