-- ============================================================================
-- StaffPay B - merge an accidental duplicate staff record into the real one
-- ----------------------------------------------------------------------------
-- On top of d3_staff_identity_v1.sql; every earlier migration stays as it is.
-- This file only adds the means; the repair itself is a separate, reviewed
-- one-off script (sql/repair_b_kamal_raju.sql) that calls
-- staffpay_d3.merge_staff for named pairs.
--
--   * staff_employee.merged_into: a retired (merged) record points at the
--     retained one. It stays as history (inactive, NOT "removed": removal works
--     by name and would also hide the retained person).
--   * staffpay_d3.staff_attendance_archive: every attendance row taken out of
--     live calculations, kept whole with its original id.
--   * staffpay_d3.staff_identity_merge: one audit row per merge (what moved,
--     what was archived, counts before and after).
--   * staffpay_d3.merge_pins: what the repair was reviewed against (both
--     records' identity, pay terms and flags, plus fingerprints of their
--     attendance rows and Project Zero audit entries). merge_staff compares it
--     under its locks, and also refuses money or links on EITHER record, so a
--     change after review stops the whole repair.
--   * Stale phones and old pages:
--       - merged_into itself is server-controlled: a page upload cannot set,
--         clear or re-point it on any record (new, unrelated, retained or
--         merged);
--       - a merged record cannot be edited, re-activated or renamed by a page
--         upload (its stored values are kept; the upload is still accepted);
--       - a payment or receipt that names a merged record (by uuid or legacy
--         id) is recorded once, on the retained record, with an audit row;
--       - attendance cannot be written for a merged record (refused, never
--         silently moved; Project Zero's door already refuses inactive staff);
--       - name matching and identity holds ignore merged records.
-- Nothing here changes any existing record. App rollback keeps this applied.
-- ============================================================================

begin;

alter table public.staff_employee
  add column if not exists merged_into uuid references public.staff_employee(id);

create table staffpay_d3.staff_attendance_archive (
  id           uuid primary key,                -- the original staff_attendance.id
  owner_id     uuid not null,
  staff_id     uuid not null,                   -- the merged record it was on
  merged_into  uuid not null,
  day_key      text not null,
  status       text not null,
  original     jsonb not null,                  -- the whole original row
  reason       text not null,
  merge_id     bigint not null,
  archived_at  timestamptz not null default now());

create table staffpay_d3.staff_identity_merge (
  id           bigserial primary key,
  owner_id     uuid not null,
  retired      uuid not null unique,
  retained     uuid not null,
  moved        jsonb not null,                  -- attendance row ids moved to the retained record
  archived     jsonb not null,                  -- attendance row ids archived (identical repeats)
  before_after jsonb not null,
  merged_at    timestamptz not null default now());

create table staffpay_d3.staff_merge_redirect (
  payment_legacy_id text not null,
  owner_id     uuid not null,
  from_staff   uuid not null,
  to_staff     uuid not null,
  first_at     timestamptz not null default now(),
  primary key (owner_id, payment_legacy_id));

revoke all on staffpay_d3.staff_attendance_archive, staffpay_d3.staff_identity_merge, staffpay_d3.staff_merge_redirect from public, anon, authenticated;

-- ---- name matching and holds ignore merged records ------------------------------
create or replace function staffpay_d3.name_matches(p_owner uuid, p_name text, p_except uuid)
returns setof public.staff_employee language sql stable as $$
  select * from public.staff_employee e
   where e.owner_id = p_owner and coalesce(e.removed, false) = false and e.merged_into is null
     and staffpay_d3.name_key(e.name) = staffpay_d3.name_key(p_name)
     and (p_except is null or e.id <> p_except)
   order by e.created_at, e.id
$$;

create or replace function staffpay_d3.identity_held(p_owner uuid, p_staff uuid)
returns boolean language sql stable as $$
  select exists (
    select 1 from public.staff_employee me
      join public.staff_employee o
        on o.owner_id = me.owner_id and coalesce(o.removed, false) = false and o.merged_into is null
       and staffpay_d3.name_key(o.name) = staffpay_d3.name_key(me.name)
     where me.id = p_staff and me.owner_id = p_owner and coalesce(me.removed, false) = false and me.merged_into is null
       and exists (select 1 from public.staff_employee x
                    where x.owner_id = me.owner_id and coalesce(x.removed, false) = false and x.merged_into is null
                      and staffpay_d3.name_key(x.name) = staffpay_d3.name_key(me.name)
                      and x.identity_status in ('unresolved', 'same'))
     group by me.id having count(*) > 1)
$$;

-- ---- merged_into is the database's own; a merged record is history -------------
-- Page uploads (new records and edits) can neither set, clear nor re-point a
-- merge marker: only merge_staff, run by the reviewed repair, sets it. A merged
-- record cannot be changed by a page at all. Uploads are still accepted.
create or replace function staffpay_d3.guard_merged_employee() returns trigger language plpgsql as $$
begin
  if current_user <> 'authenticated' then return new; end if;
  if tg_op = 'INSERT' then
    new.merged_into := null;
    return new;
  end if;
  if old.merged_into is not null then
    return old;                                   -- accepted, stored values kept
  end if;
  new.merged_into := old.merged_into;
  return new;
end $$;
create trigger staff_d3_merged_employee before insert or update on public.staff_employee
  for each row execute function staffpay_d3.guard_merged_employee();

-- ---- money naming a merged record lands once on the retained record -------------
-- runs after staff_d3_guard_payment, which has already resolved staff_id from
-- staff_legacy_id; covers page uploads and the receipt function alike
create or replace function staffpay_d3.redirect_merged_payment() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_to uuid; v_from uuid; v_legacy text;
begin
  v_from := staffpay_d3.payment_worker(new.owner_id, new.staff_id, new.staff_legacy_id);
  if v_from is null then return new; end if;
  select e.merged_into into v_to from public.staff_employee e where e.id = v_from and e.owner_id = new.owner_id;
  if v_to is null then return new; end if;
  select legacy_id into v_legacy from public.staff_employee where id = v_to;
  new.staff_id := v_to; new.staff_legacy_id := v_legacy;
  insert into staffpay_d3.staff_merge_redirect (payment_legacy_id, owner_id, from_staff, to_staff)
  values (new.legacy_id, new.owner_id, v_from, v_to) on conflict do nothing;
  return new;
end $$;
create trigger staff_d3_merged_payment before insert or update on public.staff_payment
  for each row execute function staffpay_d3.redirect_merged_payment();

-- ---- no attendance on a merged record --------------------------------------------
create or replace function staffpay_d3.guard_merged_attendance() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.staff_id is not null and exists (select 1 from public.staff_employee e where e.id = new.staff_id and e.merged_into is not null) then
    raise exception 'staff record % was merged into another record; attendance refused', new.staff_id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger staff_d3_merged_attendance before insert or update on public.staff_attendance
  for each row execute function staffpay_d3.guard_merged_attendance();

-- ---- exactly what was reviewed --------------------------------------------------
-- The two records (identity, pay terms, flags), every live attendance row on
-- them (id, day, status, source) and every Project Zero audit entry for them.
-- Read only; the repair script pins the reviewed result and merge_staff
-- compares it under its locks. Owner ids are left out on purpose; times are
-- read in UTC so the result does not depend on the session's settings.
create or replace function staffpay_d3.merge_pins(p_owner uuid, p_keep uuid, p_retire uuid)
returns jsonb language sql stable security definer
set search_path = public, pg_temp set timezone = 'UTC' set datestyle = 'ISO, YMD' as $$
  select jsonb_build_object(
    'keep',   (select jsonb_build_object('id', e.id, 'legacy_id', e.legacy_id, 'name', e.name, 'work_group', e.work_group,
                 'wage_type', e.wage_type, 'salary', e.salary, 'active', e.active, 'removed', coalesce(e.removed, false),
                 'opening_balance', e.opening_balance, 'opening_balance_date', e.opening_balance_date, 'terms_version', e.terms_version,
                 'identity_status', e.identity_status, 'identity_of', e.identity_of, 'merged_into', e.merged_into)
                 from public.staff_employee e where e.id = p_keep and e.owner_id = p_owner),
    'retire', (select jsonb_build_object('id', e.id, 'legacy_id', e.legacy_id, 'name', e.name, 'work_group', e.work_group,
                 'wage_type', e.wage_type, 'salary', e.salary, 'active', e.active, 'removed', coalesce(e.removed, false),
                 'opening_balance', e.opening_balance, 'opening_balance_date', e.opening_balance_date, 'terms_version', e.terms_version,
                 'identity_status', e.identity_status, 'identity_of', e.identity_of, 'merged_into', e.merged_into)
                 from public.staff_employee e where e.id = p_retire and e.owner_id = p_owner),
    'attendance_md5', (select md5(coalesce(string_agg(concat_ws('|', a.id, a.staff_id, a.legacy_id, a.day_key, a.month_key, a.status, a.note, a.date, a.device), ',' order by a.id), ''))
                         from public.staff_attendance a where a.owner_id = p_owner and a.staff_id in (p_keep, p_retire)),
    'acts_md5', (select md5(coalesce(string_agg(concat_ws('|', x.id, x.employee_id, x.business_day, x.status, x.prev_status, x.actor_kind,
                    case when x.actor_id = p_owner::text then 'owner' else x.actor_id end, x.reason, x.old_row_id, x.new_row_id, x.client_id), ',' order by x.id), ''))
                   from public.pz_attendance_act x where x.employee_id in (p_keep, p_retire)))
$$;
revoke all on function staffpay_d3.merge_pins(uuid, uuid, uuid) from public, anon, authenticated;

-- ---- the merge itself (called only by the reviewed repair script) --------------
-- p_expect: {"retired_rows":n, "retained_rows":n, "move":n, "archive":n, "acts":n,
--            "pins": <merge_pins as reviewed>}
-- Every check runs under locks; any surprise raises and nothing is changed.
-- Running it again for an already merged pair changes nothing.
create or replace function staffpay_d3.merge_staff(p_owner uuid, p_keep uuid, p_retire uuid, p_expect jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  k record; r record; a record; v_move uuid[] := '{}'; v_arch uuid[] := '{}'; v_mid bigint;
  v_rr int; v_kr int; v_acts int; v_before jsonb; v_after jsonb; d text;
begin
  -- serialise with staff creation (A), attendance writes (Project Zero) and money.
  -- Same order as Project Zero's door (its per-day lock first, then the table), so
  -- the two can never wait on each other.
  perform staffpay_d3.name_lock(p_owner, (select name from public.staff_employee where id = p_keep));
  for d in select distinct day_key from public.staff_attendance where staff_id in (p_keep, p_retire) order by 1 loop
    perform pg_advisory_xact_lock(4213, hashtext(p_keep::text || d));
    perform pg_advisory_xact_lock(4213, hashtext(p_retire::text || d));
  end loop;
  lock table public.staff_attendance, public.staff_payment, public.staff_settlement in share row exclusive mode;
  select * into k from public.staff_employee where id = p_keep and owner_id = p_owner for update;
  select * into r from public.staff_employee where id = p_retire and owner_id = p_owner for update;
  if k.id is null or r.id is null then raise exception 'merge refused: record not found'; end if;

  if r.merged_into = p_keep then
    if exists (select 1 from public.staff_attendance where staff_id = p_retire) then
      raise exception 'merge refused: % is marked merged but still has attendance', p_retire;
    end if;
    return jsonb_build_object('ok', true, 'already_merged', true, 'retired', p_retire, 'retained', p_keep);
  end if;

  -- identity and terms
  if p_keep = p_retire or k.merged_into is not null or r.merged_into is not null
     or coalesce(k.removed, false) or coalesce(r.removed, false) or not coalesce(k.active, false) then
    raise exception 'merge refused: records are not an active, unmerged pair';
  end if;
  if staffpay_d3.name_key(k.name) <> staffpay_d3.name_key(r.name) or k.work_group <> r.work_group
     or k.wage_type <> r.wage_type or k.salary <> r.salary
     or k.opening_balance_date is not null or r.opening_balance_date is not null then
    raise exception 'merge refused: names or pay terms differ (% %/%/% vs % %/%/%)',
      k.name, k.work_group, k.wage_type, k.salary, r.name, r.work_group, r.wage_type, r.salary;
  end if;

  -- exactly the reviewed records, attendance and audit entries (under the locks above)
  if staffpay_d3.merge_pins(p_owner, p_keep, p_retire) is distinct from (p_expect -> 'pins') then
    raise exception 'merge refused: % / % differ from the reviewed records (identity, pay terms, attendance or audit entries)', p_keep, p_retire;
  end if;

  -- neither record may carry anything but attendance (as reviewed: no money, no links)
  if exists (select 1 from public.staff_payment p where p.owner_id = p_owner
              and (p.staff_id in (p_keep, p_retire) or p.staff_legacy_id in (k.legacy_id, r.legacy_id)
                   or staffpay_d3.payment_worker(p.owner_id, p.staff_id, p.staff_legacy_id) in (p_keep, p_retire)))
     or exists (select 1 from public.staff_payment_void v where v.staff_id in (p_keep, p_retire))
     or exists (select 1 from public.staff_settlement s where s.staff_id in (p_keep, p_retire))
     or exists (select 1 from public.staff_d3_op o where o.staff_id in (p_keep, p_retire))
     or exists (select 1 from public.pz_work_credential x where x.employee_id in (p_keep, p_retire))
     or exists (select 1 from public.pz_team_member_event x where x.employee_id in (p_keep, p_retire))
     or exists (select 1 from public.pz_presence_event x where x.employee_id in (p_keep, p_retire))
     or exists (select 1 from public.pz_task_event x where x.employee_id in (p_keep, p_retire))
     or exists (select 1 from public.pz_work_access_event x where x.employee_id in (p_keep, p_retire))
     or exists (select 1 from public.pz_supplier_access x where x.employee_id in (p_keep, p_retire))
     or exists (select 1 from public.staff_employee x where x.identity_of in (p_keep, p_retire) or x.merged_into in (p_keep, p_retire)) then
    raise exception 'merge refused: % / % have money or links besides attendance', p_keep, p_retire;
  end if;

  -- attendance: identical repeats are archived, days only on the retired record move,
  -- any different mark on the same day stops everything
  for a in select x.id, x.day_key, x.status, (select y.status from public.staff_attendance y
                                               where y.owner_id = p_owner and y.staff_id = p_keep and y.day_key = x.day_key) as kept
             from public.staff_attendance x where x.owner_id = p_owner and x.staff_id = p_retire order by x.day_key loop
    if a.kept is null then v_move := v_move || a.id;
    elsif a.kept = a.status then v_arch := v_arch || a.id;
    else raise exception 'merge refused: % has % on % but the retained record has %', p_retire, a.status, a.day_key, a.kept;
    end if;
  end loop;
  select count(*) into v_rr from public.staff_attendance where staff_id = p_retire;
  select count(*) into v_kr from public.staff_attendance where staff_id = p_keep;
  select count(*) into v_acts from public.pz_attendance_act where employee_id in (p_keep, p_retire);
  if v_rr <> (p_expect ->> 'retired_rows')::int or v_kr <> (p_expect ->> 'retained_rows')::int
     or coalesce(array_length(v_move, 1), 0) <> (p_expect ->> 'move')::int
     or coalesce(array_length(v_arch, 1), 0) <> (p_expect ->> 'archive')::int
     or v_acts <> (p_expect ->> 'acts')::int then
    raise exception 'merge refused: counts differ from the reviewed plan (retired %, retained %, move %, archive %, acts %)',
      v_rr, v_kr, coalesce(array_length(v_move, 1), 0), coalesce(array_length(v_arch, 1), 0), v_acts;
  end if;
  v_before := jsonb_build_object('retired_rows', v_rr, 'retained_rows', v_kr, 'acts', v_acts);

  insert into staffpay_d3.staff_identity_merge (owner_id, retired, retained, moved, archived, before_after)
  values (p_owner, p_retire, p_keep, to_jsonb(v_move), to_jsonb(v_arch), v_before) returning id into v_mid;
  update public.staff_attendance set staff_id = p_keep where id = any (v_move);          -- same row, same id
  insert into staffpay_d3.staff_attendance_archive (id, owner_id, staff_id, merged_into, day_key, status, original, reason, merge_id)
    select x.id, x.owner_id, x.staff_id, p_keep, x.day_key, x.status, to_jsonb(x), 'identical repeat of the retained record''s mark', v_mid
      from public.staff_attendance x where x.id = any (v_arch);
  delete from public.staff_attendance where id = any (v_arch);
  update public.staff_employee set merged_into = p_keep, active = false, updated_at = now() where id = p_retire;

  v_after := jsonb_build_object('retired_rows', (select count(*) from public.staff_attendance where staff_id = p_retire),
                                'retained_rows', (select count(*) from public.staff_attendance where staff_id = p_keep),
                                'acts', (select count(*) from public.pz_attendance_act where employee_id in (p_keep, p_retire)));
  update staffpay_d3.staff_identity_merge set before_after = jsonb_build_object('before', v_before, 'after', v_after) where id = v_mid;
  return jsonb_build_object('ok', true, 'merge_id', v_mid, 'retired', p_retire, 'retained', p_keep,
                            'moved', coalesce(array_length(v_move, 1), 0), 'archived', coalesce(array_length(v_arch, 1), 0),
                            'before', v_before, 'after', v_after);
end $$;
revoke all on function staffpay_d3.merge_staff(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function staffpay_d3.guard_merged_employee() from public, anon;
revoke all on function staffpay_d3.redirect_merged_payment() from public, anon, authenticated;
revoke all on function staffpay_d3.guard_merged_attendance() from public, anon, authenticated;

commit;
