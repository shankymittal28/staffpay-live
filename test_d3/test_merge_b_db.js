/*
 * B - Kamal / Raju duplicate repair, rehearsed on a faithful copy of the
 * production rows (test_d3/fixtures/b_kamal_raju.json: the 4 staff records,
 * their 89 attendance rows and 63 Project Zero audit entries, owner id
 * replaced by the test owner).
 *
 *   test_d3/env.sh up && node test_d3/test_merge_b_db.js
 *
 * Unrelated staff with real money sit alongside: Shop Mohan (Sept attendance,
 * a payment and a receipt) and Workshop Rohit (Old Hisab, a week settled).
 */
const path = require('path'), { spawnSync } = require('child_process');
const L = require('./lib.js'), { check, rpc, sql, OWNER } = L;
const T = L.token(OWNER), SVC = L.token(OWNER, 'service_role');
const n = x => x == null ? x : Number(x);
const K = '206dc20f-8a3b-4aa8-a237-233f735a87ec', KR = 'a5481eba-7c58-45b5-8826-b9f6d79ffa21';
const R = '095233df-7bcb-4ef8-9b87-3afd74e5335e', RR = 'f5c05b72-78ce-48cf-a8ea-85c65de63777';
const { load, repair, q } = require('./fixture_b.js');
const fp = () => sql(`select md5(coalesce((select string_agg(x::text, '|' order by x.id) from public.staff_attendance x), '')) || ':' ||
  md5(coalesce((select string_agg((x.id, x.name, x.active, x.removed, x.salary, x.wage_type, x.work_group, x.merged_into)::text, '|' order by x.id) from public.staff_employee x), '')) || ':' ||
  md5(coalesce((select string_agg(x::text, '|' order by x.legacy_id) from public.staff_payment x), '')) || ':' ||
  (select count(*) from staffpay_d3.staff_attendance_archive) || ':' || (select count(*) from staffpay_d3.staff_identity_merge)`);
const actsFp = () => sql(`select md5(string_agg(x::text, '|' order by x.id)) || ':' || count(*) from public.pz_attendance_act x`);
const cnt = id => n(sql(`select count(*) from staff_attendance where staff_id = '${id}'`));
const month = id => rpc(T, 'staff_shop_month', { staff_id: id, month: '2026-09' });

(async () => {
  let u = load();
  const before = fp(), acts0 = actsFp();
  check('B0 the fixture is the production copy: Kamal 29 + 16 rows, Raju 28 + 16 rows, 63 audit entries',
    cnt(K) === 29 && cnt(KR) === 16 && cnt(R) === 28 && cnt(RR) === 16 && acts0.endsWith(':63'));

  // ---- injected conflicts: each stops the whole repair, nothing changes
  const inject = [
    ['a different mark on a shared day (Raju 20 Sep Absent on the retired copy)', `update staff_attendance set status = 'Absent' where staff_id = '${RR}' and day_key = '2026-09-20'`],
    ['a payment on a retired copy', `insert into staff_payment (owner_id, legacy_id, staff_id, name, amount, note, date, month_key, device) values ('${OWNER}', 'pay_x', '${KR}', 'Kamal', 100, '', now(), '2026-10', 'test')`],
    ['a receipt-style minus row named only by the retired legacy id', `insert into staff_payment (owner_id, legacy_id, staff_id, staff_legacy_id, name, amount, note, date, month_key, device) values ('${OWNER}', 'pay_y', null, 'stf_mtoeaebl_1t', 'Raju', -50, '', now(), '2026-10', 'test')`],
    ['different pay terms (retired Raju ₹550)', `update staff_employee set salary = 550 where id = '${RR}'`],
    ['a Staff Work login on a retired copy', `insert into pz_work_credential (employee_id) values ('${KR}')`],
    ['an extra attendance day on the retired copy (counts differ from the reviewed plan)', `insert into staff_attendance (owner_id, legacy_id, staff_id, name, status, date, month_key, day_key, device) values ('${OWNER}', 'pz_extra', '${KR}', 'Kamal', 'Present', now(), '2026-09', '2026-09-28', 'pz-server')`],
    ['an extra day on the retained record (counts differ)', `insert into staff_attendance (owner_id, legacy_id, staff_id, name, status, date, month_key, day_key, device) values ('${OWNER}', 'pz_extra2', '${R}', 'Raju', 'Present', now(), '2026-09', '2026-09-28', 'pz-server')`],
    ['the retained record inactive', `update staff_employee set active = false where id = '${K}'`],
  ];
  for (const [label, s] of inject) {
    u = load(); sql(s); const b = fp();
    const r = repair();
    check('C ' + label + ': repair refused, nothing changed (neither pair merged)', !r.ok && /merge refused/.test(r.err) && fp() === b
      && n(sql(`select count(*) from staff_employee where merged_into is not null`)) === 0, r.err.slice(0, 200));
  }

  // ---- the repair
  u = load();
  const mohanBefore = JSON.stringify(await month(u.mohan));
  const rohitBefore = JSON.stringify(await rpc(T, 'staff_workshop_report', { staff_id: u.rohit, to: '2026-10-11', receipts_ok: true }));
  const raju16 = sql(`select id from staff_attendance where staff_id = '${RR}' and day_key = '2026-09-16'`);
  const archIds = sql(`select string_agg(x.id::text, ',' order by x.id) from staff_attendance x where x.staff_id in ('${KR}', '${RR}') and x.day_key <> '2026-09-16' or (x.staff_id = '${KR}' and x.day_key = '2026-09-16')`);
  const origRows = sql(`select md5(string_agg(to_jsonb(x)::text, '|' order by x.id)) from staff_attendance x where x.staff_id in ('${KR}', '${RR}') and x.id <> '${raju16}'`);
  let r = repair();
  check('R1 the repair runs in one transaction and reports both pairs (Kamal: 16 archived, 0 moved; Raju: 15 archived, 1 moved)',
    r.ok && /"archived": 16/.test(r.out) && /"moved": 0/.test(r.out) && /"archived": 15/.test(r.out) && /"moved": 1/.test(r.out), r.err || r.out);
  check('R2 live attendance: Kamal 29 rows, Raju 29 rows; the retired copies have none',
    cnt(K) === 29 && cnt(R) === 29 && cnt(KR) === 0 && cnt(RR) === 0);
  check('R3 Raju\'s 16 Sep Present is the same row (same id, same status), now on the retained record',
    sql(`select staff_id || '|' || status from staff_attendance where id = '${raju16}'`) === R + '|Present');
  check('R4 the 31 identical repeats are archived whole with their original ids (16 Kamal, 15 Raju) and match the originals exactly',
    sql(`select string_agg(id::text, ',' order by id) from staffpay_d3.staff_attendance_archive`) === archIds
    && sql(`select md5(string_agg(original::text, '|' order by id)) from staffpay_d3.staff_attendance_archive`) === origRows
    && sql(`select string_agg(staff_id::text || ':' || count, ',' order by staff_id) from (select staff_id, count(*) from staffpay_d3.staff_attendance_archive group by 1) s`) === `${KR}:16,${RR}:15`);
  check('R5 all 63 Project Zero audit entries are unchanged; every entry still points at an existing staff record and at a live or archived row',
    actsFp() === acts0 && n(sql(`select count(*) from pz_attendance_act x where not exists (select 1 from staff_attendance a where a.id = x.new_row_id)
      and not exists (select 1 from staffpay_d3.staff_attendance_archive h where h.id = x.new_row_id)`)) === 0);
  check('R6 retired copies stay as history: merged into the retained record, inactive, NOT removed; retained records unchanged and active',
    sql(`select string_agg(left(id::text, 8) || ':' || coalesce(left(merged_into::text, 8), '-') || ':' || active || ':' || coalesce(removed, false), ',' order by id) from staff_employee where id in ('${K}','${KR}','${R}','${RR}')`)
      === '095233df:-:true:false,206dc20f:-:true:false,a5481eba:206dc20f:false:false,f5c05b72:095233df:false:false');
  check('R7 one audit row per merge with counts before and after',
    sql(`select string_agg(left(retired::text, 8) || ' ' || (before_after -> 'before' ->> 'retired_rows') || '->' || (before_after -> 'after' ->> 'retired_rows') || ' / ' || (before_after -> 'before' ->> 'retained_rows') || '->' || (before_after -> 'after' ->> 'retained_rows'), ', ' order by id) from staffpay_d3.staff_identity_merge`)
      === 'a5481eba 16->0 / 29->29, f5c05b72 16->0 / 28->29');
  const km = await month(K), rm = await month(R);
  const earn = (m, rate) => rate * (n(m.attendance.present) + n(m.attendance.half) * 0.5);
  check('R8 Kamal Sept: 26 Present, 2 Half-Day, 1 Absent → ₹10,125', n(km.attendance.present) === 26 && n(km.attendance.half) === 2 && n(km.attendance.absent) === 1 && earn(km, 375) === 10125 && km.identity.held === false, km.attendance);
  check('R9 Raju Sept: 25 Present, 1 Half-Day, 3 Absent → ₹12,750', n(rm.attendance.present) === 25 && n(rm.attendance.half) === 1 && n(rm.attendance.absent) === 3 && earn(rm, 500) === 12750 && rm.identity.held === false, rm.attendance);
  check('R10 unrelated staff unchanged: Mohan\'s Shop month and Rohit\'s Workshop hisab are identical',
    JSON.stringify(await month(u.mohan)) === mohanBefore
    && JSON.stringify(await rpc(T, 'staff_workshop_report', { staff_id: u.rohit, to: '2026-10-11', receipts_ok: true })) === rohitBefore);

  // ---- a second run changes nothing
  const after1 = fp();
  r = repair();
  check('R11 running the repair again reports "already merged" for both and changes nothing', r.ok && (r.out.match(/already_merged/g) || []).length === 2 && fp() === after1 && actsFp() === acts0, r.err || r.out);

  // ---- stale phones and old pages after the repair
  const row = (id, name, extra) => Object.assign({ owner_id: OWNER, legacy_id: id, name, work_group: 'shop', phone: '', active: true, salary: 999, wage_type: 'monthly', opening_balance: 0, source: 'staff', device: 'old-page' }, extra || {});
  let up = await L.upsert(T, 'staff_employee', [row('stf_mtoeaknz_2l', 'Kamal Restored', { removed: false })]);
  check('S1 an old page uploading the retired Kamal (active, renamed, new rate) is accepted but changes nothing',
    up.status < 300 && sql(`select name || '|' || active || '|' || salary::int || '|' || wage_type || '|' || left(merged_into::text, 8) from staff_employee where id = '${KR}'`) === 'Kamal|false|375|daily|206dc20f');
  const pay = (legacy, staff, staffLegacy, amt) => L.upsert(T, 'staff_payment', [{ owner_id: OWNER, legacy_id: legacy, staff_id: staff, staff_legacy_id: staffLegacy, name: 'Kamal', amount: amt, note: '', date: L.istTs('2026-10-15'), month_key: '2026-10', device: 'old-page' }]);
  up = await pay('1761500000001', KR, 'stf_mtoeaknz_2l', 300);
  const up2 = await pay('1761500000001', KR, 'stf_mtoeaknz_2l', 300);
  check('S2 a stale phone\'s ₹300 for the retired Kamal (by uuid) lands once on the retained Kamal; the retry counts once; one audit row',
    up.status < 300 && up2.status < 300 && sql(`select count(*) || '|' || string_agg(staff_id::text || '/' || staff_legacy_id, ',') from staff_payment where legacy_id = '1761500000001'`) === `1|${K}/stf_mtoejiad_25`
    && sql(`select count(*) || '|' || string_agg(from_staff::text || '>' || to_staff::text, ',') from staffpay_d3.staff_merge_redirect where payment_legacy_id = '1761500000001'`) === `1|${KR}>${K}`);
  up = await pay('1761500000002', null, 'stf_mtoeaebl_1t', 200);
  check('S3 a queued payment naming only the retired Raju\'s legacy id lands once on the retained Raju', up.status < 300
    && sql(`select staff_id from staff_payment where legacy_id = '1761500000002'`) === R);
  const rc = await rpc(T, 'staff_receipt_add', { op_id: L.uuid(), staff_id: RR, amount: 100, day: '2026-10-15', receipts_ok: true });
  check('S4 a stale receipt for the retired Raju is recorded once, on the retained Raju', rc.ok && sql(`select staff_id || '|' || amount::int from staff_payment where legacy_id = '${rc.payment_id}'`) === R + '|-100', rc);
  const pz = (emp, day, reason) => sql(`select (pz_attendance_assert('${OWNER}', '${emp}', '${day}', 'Present', 'owner', 'x', 'Owner', ${reason ? q(reason) : 'null'}, '${L.uuid()}'))::text`);
  check('S5 Project Zero cannot mark the retired copies (inactive), and a direct attendance write for them is refused',
    /inactive/.test(pz(KR, '2026-10-16')) && /inactive/.test(pz(RR, '2026-09-20'))
    && /refused/.test((spawnSync('psql', ['-X', '-q', '-h', '/tmp', '-p', '54329', '-U', 'postgres', '-d', 'd3test', '-c',
      `insert into staff_attendance (owner_id, legacy_id, staff_id, name, status, date, month_key, day_key, device) values ('${OWNER}', 'x1', '${KR}', 'Kamal', 'Present', now(), '2026-10', '2026-10-16', 'test')`], { encoding: 'utf8' }).stderr || '')));
  check('S6 a mark for Raju\'s moved 16 Sep day needs a reason (an old mark cannot silently replace it)', /reason required/.test(pz(R, '2026-09-16')));
  const cr = await rpc(T, 'staff_employee_create', { op_id: L.uuid(), legacy_id: 'stf_new_kamal', name: 'Kamal', group: 'shop', wage_type: 'daily', salary: 375 });
  check('S7 adding "Kamal" again finds only the retained Kamal (the merged copy is not offered)', cr.error === 'name exists' && cr.matches.length === 1 && cr.matches[0].id === K, cr);
  up = await L.upsert(T, 'staff_employee', [row('stf_old_page_kamal', 'Kamal', { salary: 375, wage_type: 'daily' })]);
  check('S8 a new duplicate from an old page is marked unresolved against the retained Kamal (not the merged copy)',
    sql(`select identity_status || '|' || left(identity_of::text, 8) from staff_employee where legacy_id = 'stf_old_page_kamal'`) === 'unresolved|206dc20f');
  check('S9 the audit entries are still unchanged', actsFp() === acts0);

  console.log(`\n${L.PASS.length} passed, ${L.FAIL.length} failed - B repair (database)`);
  process.exit(L.FAIL.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
