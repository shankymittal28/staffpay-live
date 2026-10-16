-- ============================================================================
-- StaffPay A1 - one worker, one record: explicit identity decisions
-- ----------------------------------------------------------------------------
-- On top of d3_receipts_shop_v1.sql; every earlier migration stays as it is.
--
-- The problem: a phone gives every new worker its own permanent id, and the
-- database only refused two rows with the same id, so two phones (or a stale
-- or offline one) could create the same person twice, and both copies then
-- earned wages for the same days.
--
--   * Names are compared with staffpay_d3.name_key (trimmed, spaces collapsed,
--     case ignored), across Shop and Workshop. A name match only asks the
--     owner a question. Nothing is ever moved, merged, deducted or hidden by
--     name.
--   * staff_employee_create: the new page creates staff here. A matching name
--     creates nothing and returns the matches; "different person" is created
--     only after the owner has seen every current match. Retry by op_id.
--   * Records still arriving straight from older or offline pages are always
--     accepted (their payments keep a real reference and their upload never
--     jams), but a matching name marks the arrival 'unresolved'.
--   * While a name has an unresolved (or 'same', awaiting the separate history
--     reconciliation) record, every record with that name is on hold: their
--     attendance, payments and receipts stay visible on their own ids, but the
--     weekly hisab withholds its balance and settlement is refused.
--     Unrelated staff are untouched.
--   * staff_identity_decide: the owner's explicit answer. 'different' clears
--     the hold and each person is calculated on their own again; 'same' keeps
--     the hold until the reviewed reconciliation (not part of this file).
--
-- Additive: two columns, one log kind, new functions and one trigger. The
-- weekly calculation itself is not changed; it is wrapped so a held record's
-- report carries one more "withheld" reason. App rollback keeps this applied.
-- ============================================================================

begin;

alter table public.staff_employee
  add column if not exists identity_status text check (identity_status in ('unresolved', 'same', 'distinct')),
  add column if not exists identity_of uuid references public.staff_employee(id) on delete set null;

alter table public.staff_d3_op drop constraint if exists staff_d3_op_kind_check;
alter table public.staff_d3_op add constraint staff_d3_op_kind_check check (kind in ('settlement', 'terms', 'payment', 'staff'));

-- ---- name comparison -----------------------------------------------------------
create or replace function staffpay_d3.name_key(p text)
returns text language sql immutable as $$ select lower(regexp_replace(btrim(coalesce(p, '')), '\s+', ' ', 'g')) $$;

-- one lock per owner + name, shared by every way a staff record is created
create or replace function staffpay_d3.name_lock(p_owner uuid, p_name text)
returns void language sql as $$
  select pg_advisory_xact_lock(hashtext('staffpay-name'), hashtext(p_owner::text || '|' || staffpay_d3.name_key(p_name)))
$$;

-- other (not removed) records of this owner with the same name
create or replace function staffpay_d3.name_matches(p_owner uuid, p_name text, p_except uuid)
returns setof public.staff_employee language sql stable as $$
  select * from public.staff_employee e
   where e.owner_id = p_owner and coalesce(e.removed, false) = false
     and staffpay_d3.name_key(e.name) = staffpay_d3.name_key(p_name)
     and (p_except is null or e.id <> p_except)
   order by e.created_at, e.id
$$;

-- is this record's money on hold until an identity decision?
create or replace function staffpay_d3.identity_held(p_owner uuid, p_staff uuid)
returns boolean language sql stable as $$
  select exists (
    select 1 from public.staff_employee me
      join public.staff_employee o
        on o.owner_id = me.owner_id and coalesce(o.removed, false) = false
       and staffpay_d3.name_key(o.name) = staffpay_d3.name_key(me.name)
     where me.id = p_staff and me.owner_id = p_owner and coalesce(me.removed, false) = false
       and exists (select 1 from public.staff_employee x
                    where x.owner_id = me.owner_id and coalesce(x.removed, false) = false
                      and staffpay_d3.name_key(x.name) = staffpay_d3.name_key(me.name)
                      and x.identity_status in ('unresolved', 'same'))
     group by me.id having count(*) > 1)
$$;

-- ---- records written straight by a page (older builds, offline queues) -----------
-- Always accepted; the identity fields are the database's own. A new record, a
-- rename or a re-added record whose name matches another worker is unresolved.
-- While a record is held, an ordinary upload cannot rename it or mark it
-- removed (that would release the hold of the other records): its stored name
-- and removed flag are kept; other fields (rate, phone) still apply. Only the
-- owner's decision, or the reviewed reconciliation, releases a hold.
create or replace function staffpay_d3.guard_identity() returns trigger language plpgsql as $$
declare m record;
begin
  if current_user <> 'authenticated' then return new; end if;
  if tg_op = 'UPDATE' then
    new.identity_status := old.identity_status; new.identity_of := old.identity_of;
    if staffpay_d3.identity_held(old.owner_id, old.id) then
      new.name := old.name; new.removed := old.removed;
      return new;
    end if;
    if staffpay_d3.name_key(new.name) = staffpay_d3.name_key(old.name)
       and not (coalesce(old.removed, false) and not coalesce(new.removed, false)) then
      return new;
    end if;
  else
    new.identity_status := null; new.identity_of := null;
  end if;
  if coalesce(new.removed, false) then return new; end if;
  perform staffpay_d3.name_lock(new.owner_id, new.name);
  select * into m from staffpay_d3.name_matches(new.owner_id, new.name, case when tg_op = 'UPDATE' then old.id end) x
   where x.legacy_id <> new.legacy_id limit 1;
  if found then new.identity_status := 'unresolved'; new.identity_of := m.id; end if;
  return new;
end $$;
create trigger staff_d3_identity before insert or update on public.staff_employee
  for each row execute function staffpay_d3.guard_identity();

-- ---- the weekly hisab of a held record carries one more withheld reason ----------
-- (calc itself is unchanged; settlement already refuses any withheld balance)
alter function staffpay_d3.calc(uuid, uuid, date, date) rename to calc_base;
create function staffpay_d3.calc(p_owner uuid, p_staff uuid, p_to date, p_from date default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_r jsonb;
begin
  v_r := staffpay_d3.calc_base(p_owner, p_staff, p_to, p_from);
  if coalesce((v_r ->> 'ok')::boolean, false) and staffpay_d3.identity_held(p_owner, p_staff) then
    v_r := jsonb_set(v_r, '{withheld}', coalesce(v_r -> 'withheld', '[]'::jsonb)
             || to_jsonb('Is naam ke do record hain — pehle StaffPay mein tay karein: ek hi insaan ya alag log'::text))
           || jsonb_build_object('identity_hold', true);
  end if;
  return v_r;
end $$;
revoke all on function staffpay_d3.calc(uuid, uuid, date, date) from public, anon, authenticated;
revoke all on function staffpay_d3.calc_base(uuid, uuid, date, date) from public, anon, authenticated;

-- ---- matches as the owner sees them ----------------------------------------------
create or replace function staffpay_d3.match_list(p_owner uuid, p_name text, p_except uuid)
returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'legacy_id', x.legacy_id, 'name', x.name, 'group', x.work_group,
           'wage_type', x.wage_type, 'salary', x.salary, 'active', x.active, 'created_at', x.created_at,
           'identity_status', x.identity_status) order by x.created_at, x.id), '[]'::jsonb)
    from staffpay_d3.name_matches(p_owner, p_name, p_except) x
$$;

-- every current match was shown to the owner (p_seen holds their ids)?
create or replace function staffpay_d3.all_seen(p_owner uuid, p_name text, p_except uuid, p_seen jsonb)
returns boolean language sql stable as $$
  select not exists (select 1 from staffpay_d3.name_matches(p_owner, p_name, p_except) x
                      where not coalesce(p_seen, '[]'::jsonb) ? x.id::text)
$$;

-- ---- create a staff record (the new page) ---------------------------------------
create or replace function public.staff_employee_create(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_owner uuid := auth.uid(); v_op uuid; v_legacy text; v_name text; v_group text; v_wage text; v_salary numeric;
  v_dec text; v_r jsonb; e record; v_res jsonb;
begin
  if v_owner is null then return jsonb_build_object('ok', false, 'error', 'not signed in'); end if;
  begin
    v_op := (p ->> 'op_id')::uuid; v_salary := coalesce((p ->> 'salary')::numeric, 0);
  exception when others then return jsonb_build_object('ok', false, 'error', 'bad request'); end;
  v_legacy := btrim(coalesce(p ->> 'legacy_id', '')); v_name := btrim(regexp_replace(coalesce(p ->> 'name', ''), '\s+', ' ', 'g'));
  v_group := case when p ->> 'group' = 'workshop' then 'workshop' else 'shop' end;
  v_wage := case when p ->> 'wage_type' = 'daily' then 'daily' else 'monthly' end;
  v_dec := p ->> 'decision';
  if v_op is null or v_legacy = '' or v_name = '' or not (v_salary >= 0 and v_salary < 10000000)
     or coalesce(v_dec, 'none') not in ('none', 'different') then
    return jsonb_build_object('ok', false, 'error', 'bad request');
  end if;
  v_r := staffpay_d3.op_begin(v_owner, v_op, null, p);
  if v_r is not null then return v_r; end if;
  perform staffpay_d3.name_lock(v_owner, v_name);

  select * into e from public.staff_employee where owner_id = v_owner and legacy_id = v_legacy;
  if found then
    if staffpay_d3.name_key(e.name) <> staffpay_d3.name_key(v_name) then
      return jsonb_build_object('ok', false, 'error', 'operation mismatch');
    end if;
    v_res := jsonb_build_object('ok', true, 'staff_id', e.id, 'legacy_id', e.legacy_id, 'created', false);
    return staffpay_d3.op_log(v_owner, v_op, 'staff', e.id, v_legacy, 'create', p, v_res);
  end if;

  if exists (select 1 from staffpay_d3.name_matches(v_owner, v_name, null))
     and (v_dec is distinct from 'different' or not staffpay_d3.all_seen(v_owner, v_name, null, p -> 'seen')) then
    v_res := jsonb_build_object('ok', false, 'error', 'name exists', 'matches', staffpay_d3.match_list(v_owner, v_name, null),
      'message', 'Is naam ka staff pehle se hai. Ek hi insaan hai ya alag?');
    return staffpay_d3.op_log(v_owner, v_op, 'staff', null, v_legacy, 'create', p, v_res);
  end if;

  insert into public.staff_employee (owner_id, legacy_id, name, work_group, phone, active, salary, wage_type, opening_balance, source, device, identity_status)
  values (v_owner, v_legacy, v_name, v_group, btrim(coalesce(p ->> 'phone', '')), true, v_salary, v_wage, 0, 'staff', 'staffpay-create',
          case when v_dec = 'different' and exists (select 1 from staffpay_d3.name_matches(v_owner, v_name, null)) then 'distinct' end)
  returning * into e;
  v_res := jsonb_build_object('ok', true, 'staff_id', e.id, 'legacy_id', e.legacy_id, 'created', true,
                              'distinct', v_dec = 'different');
  return staffpay_d3.op_log(v_owner, v_op, 'staff', e.id, v_legacy, 'create', p, v_res);
exception when invalid_text_representation then
  return jsonb_build_object('ok', false, 'error', 'bad request');
end $$;

-- ---- the owner's decision on an unresolved record ------------------------------
create or replace function public.staff_identity_decide(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_owner uuid := auth.uid(); v_op uuid; v_staff uuid; v_dec text; v_r jsonb; e record; v_res jsonb;
begin
  if v_owner is null then return jsonb_build_object('ok', false, 'error', 'not signed in'); end if;
  begin
    v_op := (p ->> 'op_id')::uuid; v_staff := (p ->> 'staff_id')::uuid;
  exception when others then return jsonb_build_object('ok', false, 'error', 'bad request'); end;
  v_dec := p ->> 'decision';
  if v_op is null or v_staff is null or coalesce(v_dec, '') not in ('different', 'same') then
    return jsonb_build_object('ok', false, 'error', 'bad request');
  end if;
  v_r := staffpay_d3.op_begin(v_owner, v_op, v_staff, p);
  if v_r is not null then return v_r; end if;
  select * into e from public.staff_employee where id = v_staff and owner_id = v_owner;
  if not found then return jsonb_build_object('ok', false, 'error', 'not found'); end if;
  perform staffpay_d3.name_lock(v_owner, e.name);
  select * into e from public.staff_employee where id = v_staff for update;
  if e.identity_status is distinct from 'unresolved' then
    return jsonb_build_object('ok', false, 'error', 'no decision pending', 'identity_status', e.identity_status);
  end if;
  if not staffpay_d3.all_seen(v_owner, e.name, e.id, p -> 'seen') then
    return jsonb_build_object('ok', false, 'error', 'matches changed', 'matches', staffpay_d3.match_list(v_owner, e.name, e.id));
  end if;
  update public.staff_employee set identity_status = case when v_dec = 'different' then 'distinct' else 'same' end, updated_at = now()
   where id = e.id;
  v_res := jsonb_build_object('ok', true, 'staff_id', e.id, 'decision', v_dec,
                              'held', staffpay_d3.identity_held(v_owner, e.id));
  return staffpay_d3.op_log(v_owner, v_op, 'staff', e.id, e.legacy_id, 'identity ' || v_dec, p, v_res);
exception when invalid_text_representation then
  return jsonb_build_object('ok', false, 'error', 'bad request');
end $$;

-- ---- who may call what ------------------------------------------------------------
revoke all on function staffpay_d3.name_key(text) from public, anon;
grant execute on function staffpay_d3.name_key(text) to authenticated;
revoke all on function staffpay_d3.name_lock(uuid, text) from public, anon;
grant execute on function staffpay_d3.name_lock(uuid, text) to authenticated;
revoke all on function staffpay_d3.name_matches(uuid, text, uuid) from public, anon;
grant execute on function staffpay_d3.name_matches(uuid, text, uuid) to authenticated;
revoke all on function staffpay_d3.identity_held(uuid, uuid) from public, anon;
grant execute on function staffpay_d3.identity_held(uuid, uuid) to authenticated;   -- the row trigger runs as the page
revoke all on function staffpay_d3.match_list(uuid, text, uuid) from public, anon, authenticated;
revoke all on function staffpay_d3.all_seen(uuid, text, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.staff_employee_create(jsonb) from public, anon;
grant execute on function public.staff_employee_create(jsonb) to authenticated;
revoke all on function public.staff_identity_decide(jsonb) from public, anon;
grant execute on function public.staff_identity_decide(jsonb) to authenticated;

commit;
