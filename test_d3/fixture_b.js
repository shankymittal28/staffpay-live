/*
 * Shared by the B tests: load the faithful copy of the production rows
 * (fixtures/b_kamal_raju.json) plus unrelated staff with real money, and run
 * the reviewed repair script exactly as it would be run.
 */
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const L = require('./lib.js'), { sql, OWNER } = L;
const FX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'b_kamal_raju.json'), 'utf8'));
const REPAIR = path.join(__dirname, '..', 'sql', 'repair_b_kamal_raju.sql');
const q = s => "'" + String(s).replace(/'/g, "''") + "'";
const lit = v => v == null ? 'null' : typeof v === 'boolean' || typeof v === 'number' ? String(v) : q(v);

function repair() {
  const r = spawnSync('psql', ['-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-h', process.env.PGHOST || '/tmp', '-p', process.env.PGPORT || '54329', '-U', 'postgres', '-d', process.env.D3_DB || 'd3test', '-f', REPAIR], { encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
function load() {
  L.reset(); L.setToday('2026-10-17');
  // test-only stand-ins for Project Zero's link tables and its audit immutability (as in production)
  sql(`do $$ begin
    create table if not exists public.pz_work_credential (id bigserial primary key, employee_id uuid references public.staff_employee(id));
    create table if not exists public.pz_team_member_event (id bigserial primary key, employee_id uuid references public.staff_employee(id));
    create table if not exists public.pz_presence_event (id bigserial primary key, employee_id uuid references public.staff_employee(id));
    create table if not exists public.pz_task_event (id bigserial primary key, employee_id uuid references public.staff_employee(id));
    create table if not exists public.pz_work_access_event (id bigserial primary key, employee_id uuid references public.staff_employee(id));
    create table if not exists public.pz_supplier_access (id bigserial primary key, employee_id uuid references public.staff_employee(id));
    create or replace function public.pz_commitment_immutable() returns trigger language plpgsql as $f$ begin raise exception 'immutable'; end $f$;
    if not exists (select 1 from pg_trigger where tgname = 'pz_attendance_act_no_change') then
      create trigger pz_attendance_act_no_change before delete or update on public.pz_attendance_act for each row execute function public.pz_commitment_immutable();
    end if; end $$`);
  sql(`truncate public.pz_work_credential, public.pz_team_member_event, public.pz_presence_event, public.pz_task_event, public.pz_work_access_event, public.pz_supplier_access;
       truncate staffpay_d3.staff_attendance_archive, staffpay_d3.staff_identity_merge, staffpay_d3.staff_merge_redirect;
       alter table public.pz_attendance_act disable trigger pz_attendance_act_no_change`);
  for (const e of FX.employees) {
    const cols = ['id', 'owner_id', 'legacy_id', 'name', 'work_group', 'phone', 'active', 'salary', 'wage_type', 'source', 'device', 'created_at', 'updated_at', 'removed', 'opening_balance', 'opening_balance_date', 'terms_version'];
    sql(`insert into public.staff_employee (${cols}) values (${cols.map(c => lit(e[c])).join(',')})`);
  }
  const ac = ['id', 'owner_id', 'legacy_id', 'staff_id', 'name', 'status', 'note', 'date', 'month_key', 'day_key', 'device', 'created_at'];
  sql(`insert into public.staff_attendance (${ac}) values ` + FX.attendance.map(a => '(' + ac.map(c => lit(a[c])).join(',') + ')').join(','));
  const xc = ['id', 'employee_id', 'business_day', 'status', 'prev_status', 'actor_kind', 'actor_id', 'actor_name', 'reason', 'old_row_id', 'new_row_id', 'client_id', 'created_at'];
  sql(`insert into public.pz_attendance_act (${xc}) values ` + FX.acts.map(a => '(' + xc.map(c => lit(a[c])).join(',') + ')').join(','));
  sql(`alter table public.pz_attendance_act enable trigger pz_attendance_act_no_change`);
  // unrelated staff with real money
  const mohan = L.emp({ name: 'Mohan', group: 'shop', wage: 'daily', rate: 500, legacy: 'stf_mohan' });
  L.attRange(mohan, '2026-09-01', 'PPPPPAPPPH');
  sql(`insert into staff_payment (owner_id, legacy_id, staff_id, name, amount, note, date, month_key, device)
       values ('${OWNER}', 'pay_mohan_sep', '${mohan}', 'Mohan', 2000, '', '${L.istTs('2026-09-05')}', '2026-09', 'test')`);
  const rohit = L.emp({ name: 'Rohit', rate: 500, ob: 0, obDate: '2026-10-04', legacy: 'stf_rohit' });
  L.attRange(rohit, '2026-10-05', 'PPPPPPA');
  return { mohan, rohit };
}
module.exports = { load, repair, FX, q, lit };
