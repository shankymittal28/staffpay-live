/*
 * Staff identity decisions (A1) - database + API tests for
 * sql/d3_staff_identity_v1.sql (synthetic data only).
 *
 *   test_d3/env.sh up && node test_d3/test_identity_db.js
 *
 * Today Wed 14 Oct 2026. W1 = Mon 5 - Sun 11 Oct. Rs 500/day.
 * "Page row" = a staff record written straight to the table the way older or
 * offline pages do (REST upsert as the signed-in owner).
 */
const L = require('./lib.js'), { check, rpc, sql, OWNER, OTHER } = L;
const T = L.token(OWNER), T2 = L.token(OTHER);
const n = x => x == null ? x : Number(x);
const W1 = '2026-10-05';
const create = (o, tok) => rpc(tok || T, 'staff_employee_create', Object.assign({ op_id: L.uuid(), legacy_id: 'stf_' + L.uuid().slice(0, 8), group: 'shop', wage_type: 'daily', salary: 500 }, o));
const decide = (o, tok) => rpc(tok || T, 'staff_identity_decide', Object.assign({ op_id: L.uuid() }, o));
const pageRow = (legacy, name, extra) => L.upsert(T, 'staff_employee', [Object.assign({ owner_id: OWNER, legacy_id: legacy, name, work_group: 'shop', phone: '', active: true, salary: 500, wage_type: 'daily', opening_balance: 0, source: 'staff', device: 'old-page' }, extra || {})]);
const idOf = legacy => sql(`select id from staff_employee where legacy_id = '${legacy}'`);
const st = id => sql(`select coalesce(identity_status, '-') || '|' || coalesce(left(identity_of::text, 8), '-') from staff_employee where id = '${id}'`);
const count = name => n(sql(`select count(*) from staff_employee where staffpay_d3.name_key(name) = staffpay_d3.name_key('${name}')`));
const report = (staff, to) => rpc(T, 'staff_workshop_report', { staff_id: staff, to: to || '2026-10-11', receipts_ok: true });
const idHold = r => (r.withheld || []).some(x => /do record hain/.test(x)) && r.identity_hold === true;
async function settle(staff, monday, cash) {
  const r = await report(staff, '2026-10-11'), w = (r.weeks || []).find(x => x.monday === monday);
  return rpc(T, 'staff_settlement_apply', { op_id: L.uuid(), action: 'settle', staff_id: staff, week: monday, receipts_ok: true,
    expected_version: w && w.settlement ? w.settlement.version : null, cash, sunday_done: true, advances_complete: true,
    seen: w ? { days: n(w.days_worked), rate: n(w.rate), earned: n(w.earned), previous: n(w.previous), advances: n(w.advances_total),
                advances_out: n(w.advances_out_total), received: n(w.receipts_total) } : null });
}

(async () => {
  L.reset(); L.setToday('2026-10-14');
  sql(`delete from staff_employee`);

  // ---- C  server-controlled creation on the new page
  const op = L.uuid();
  let a = await create({ op_id: op, legacy_id: 'stf_raju1', name: 'Raju' });
  const r1 = a.staff_id;
  let b = await create({ op_id: op, legacy_id: 'stf_raju1', name: 'Raju' });
  let c = await create({ op_id: op, legacy_id: 'stf_raju1', name: 'Raju', salary: 600 });
  check('C1 a new name is created (not on hold); the same op_id replays it; a changed request on that op_id is refused',
    a.ok && a.created && b.replayed === true && b.staff_id === r1 && c.error === 'operation mismatch' && count('Raju') === 1 && st(r1) === '-|-', { a, b, c });
  const tries = [await create({ legacy_id: 'stf_x1', name: 'Raju' }), await create({ legacy_id: 'stf_x2', name: '  raju ' }),
                 await create({ legacy_id: 'stf_x3', name: 'RAJU', group: 'workshop' })];
  check('C2 "Raju", "  raju " and a Workshop "RAJU" create nothing: "name exists" with the existing record listed',
    tries.every(t => t.ok === false && t.error === 'name exists' && t.matches.length === 1 && t.matches[0].id === r1) && count('Raju') === 1, tries);
  a = await create({ legacy_id: 'stf_rajesh', name: 'Rajesh' });
  check('C3 a different name ("Rajesh") is not a match', a.ok && a.created && st(a.staff_id) === '-|-', a);
  a = await create({ legacy_id: 'stf_raju2', name: 'Raju', decision: 'different', seen: [r1] });
  const r2 = a.staff_id;
  check('C4 "different person" after seeing every match: created as a confirmed different person (no hold)',
    a.ok && a.created && a.distinct === true && st(r2) === 'distinct|-' && count('Raju') === 2, a);
  a = await create({ legacy_id: 'stf_raju3', name: 'Raju', decision: 'different', seen: [r1] });
  check('C5 "different" with an out-of-date list (a newer Raju exists) creates nothing and lists both again',
    a.error === 'name exists' && a.matches.length === 2 && count('Raju') === 2, a);
  const par = await Promise.all([1, 2, 3].map(i => create({ legacy_id: 'stf_mohanp' + i, name: 'Mohan', decision: 'different', seen: [] })));
  check('C6 three phones creating "Mohan" at the same moment: exactly one record; the others are asked again with it listed',
    count('Mohan') === 1 && par.filter(x => x.created).length === 1 && par.filter(x => x.error === 'name exists' && x.matches.length === 1).length === 2, par);
  a = await create({ legacy_id: 'stf_bad', name: 'Bad', salary: 'NaN' });
  b = await create({ legacy_id: 'stf_bad', name: 'Bad' }, T2);
  check('C7 bad requests refused; another owner never sees this owner\'s names', a.error === 'bad request' && b.ok && b.created, { a, b });
  sql(`delete from staff_employee where owner_id = '${OTHER}'`);

  // ---- P  records arriving from older / offline pages
  sql(`delete from staff_employee where name in ('Raju', 'Rajesh', 'Mohan')`);
  const ws1 = L.emp({ name: 'Raju', rate: 500, ob: 0, obDate: '2026-10-04', legacy: 'stf_ws_raju' });   // the Raju everyone knows
  const mohan = L.emp({ name: 'Mohan', rate: 500, ob: 0, obDate: '2026-10-04', legacy: 'stf_ws_mohan' });
  L.attRange(ws1, W1, 'PAAAAAA'); L.attRange(mohan, W1, 'PAAAAAA');
  let u = await pageRow('stf_stale_raju', 'raju ', { work_group: 'workshop', identity_status: 'distinct' });
  const sr = idOf('stf_stale_raju');
  check('P1 a stale/old page\'s "raju " is accepted (no error) and marked unresolved, pointing at the existing Raju; it cannot mark itself confirmed',
    u.status === 201 && st(sr) === 'unresolved|' + ws1.slice(0, 8), { u: u.status, st: st(sr) });
  u = await L.upsert(T, 'staff_payment', [L.payRow({ id: 1760900000001, name: 'raju', amount: 500, date: L.istTs('2026-10-06') })].map(x => Object.assign(x, { staff_legacy_id: 'stf_stale_raju', staff_id: null })));
  check('P2 that page\'s ₹500 payment uploads and is linked to its own record (not the existing Raju, not by name)',
    u.status === 201 && sql(`select staff_id from staff_payment where legacy_id = '1760900000001'`) === sr, u.status);
  u = await pageRow('stf_stale_raju', 'raju ', { salary: 550, identity_status: null, identity_of: null });
  check('P3 a later upload of that record (retry, rate edit) keeps it unresolved; still one record', u.status < 300 && st(sr) === 'unresolved|' + ws1.slice(0, 8) && count('raju') === 2);
  u = await pageRow('stf_ws_mohan', 'Mohan', { work_group: 'workshop', salary: 500 });
  check('P4 editing an existing record (no name change) never marks it', u.status < 300 && st(mohan) === '-|-');
  const sk = L.emp({ name: 'Shyam', group: 'shop', legacy: 'stf_shyam' });
  u = await pageRow('stf_shyam', 'Mohan');
  check('P5 renaming a record to an existing name marks it unresolved', st(sk) === 'unresolved|' + mohan.slice(0, 8));
  await pageRow('stf_shyam', 'Shyam');
  sql(`update staff_employee set identity_status = null, identity_of = null where id = '${sk}'`);
  const pp = await Promise.all([1, 2].map(i => pageRow('stf_par' + i, 'Kamal')));
  check('P6 two old pages adding "Kamal" at the same moment: both accepted, exactly one of them unresolved',
    pp.every(x => x.status === 201) && n(sql(`select count(*) from staff_employee where name = 'Kamal' and identity_status = 'unresolved'`)) === 1
    && n(sql(`select count(*) from staff_employee where name = 'Kamal' and identity_status is null`)) === 1);

  // ---- H  hold: test 1 - R1 earns 500, 500 was paid on R2
  let rep = await report(ws1);
  let w = (rep.weeks || []).find(x => x.monday === W1);
  check('H1 the existing Raju\'s hisab is shown (attendance, ₹500 earned) but its balance is withheld while the other record is unresolved',
    rep.ok && w && n(w.earned) === 500 && n(w.advances_total) === 0 && idHold(rep), rep.withheld);
  a = await settle(ws1, W1, 500);
  check('H2 test 1: no ₹500 settlement for Raju while ₹500 sits on the other record (refused: balance withheld)', a.error === 'balance withheld', a);
  rep = await report(mohan);
  b = await settle(mohan, W1, 500);
  check('H3 test 4: unrelated Mohan is unaffected (no hold reason) and settles normally', rep.ok && !idHold(rep) && b.ok === true, { w: rep.withheld, b });
  check('H4 nothing moved by name: the ₹500 is still only on the other record',
    sql(`select string_agg(left(staff_id::text, 8) || ':' || amount::int, ',') from staff_payment where name ilike 'raju%'`) === sr.slice(0, 8) + ':500');

  // ---- D  the owner's decision
  a = await decide({ staff_id: sr, decision: 'different', seen: [] });
  check('D1 a decision made without seeing the existing Raju is refused (matches changed)', a.error === 'matches changed' && a.matches.length === 1, a);
  b = await decide({ staff_id: sr, decision: 'different', seen: [ws1] }, T2);
  check('D2 another owner cannot decide', b.ok === false && st(sr).startsWith('unresolved'), b);
  const dop = L.uuid();
  a = await decide({ op_id: dop, staff_id: sr, decision: 'different', seen: [ws1] });
  b = await decide({ op_id: dop, staff_id: sr, decision: 'different', seen: [ws1] });
  check('D3 test 3: "different people" clears the hold (retry replays it, logged)', a.ok && a.held === false && b.replayed === true && st(sr).startsWith('distinct')
    && n(sql(`select count(*) from staff_d3_op where op_id = '${dop}' and kind = 'staff'`)) === 1, { a, b });
  rep = await report(ws1); w = (rep.weeks || []).find(x => x.monday === W1);
  a = await settle(ws1, W1, 500);
  check('D4 test 3: each person is calculated alone again: Raju earned ₹500, no advance of the other person\'s ₹500, and settles',
    !idHold(rep) && n(w.earned) === 500 && n(w.advances_total) === 0 && a.ok === true, { w: rep.withheld, a });
  a = await decide({ staff_id: sr, decision: 'same', seen: [ws1] });
  check('D5 a decided record cannot be decided again', a.error === 'no decision pending', a);
  const k = sql(`select id from staff_employee where name = 'Kamal' and identity_status = 'unresolved'`), k1 = sql(`select id from staff_employee where name = 'Kamal' and identity_status is null`);
  a = await decide({ staff_id: k, decision: 'same', seen: [k1] });
  check('D6 "same person" keeps every Kamal record on hold until the reviewed reconciliation', a.ok && a.held === true && st(k) === 'same|' + k1.slice(0, 8)
    && sql(`select bool_and(staffpay_d3.identity_held(owner_id, id)) from staff_employee where name = 'Kamal'`) === 't', a);

  // ---- X  housekeeping
  const r3 = await pageRow('stf_third_raju', 'Raju', { work_group: 'workshop' });
  rep = await report(ws1);
  check('X1 a third Raju arriving puts the whole name back on hold (even the confirmed pair)', r3.status === 201 && idHold(rep) && st(idOf('stf_third_raju')).startsWith('unresolved'));
  sql(`delete from staff_employee where legacy_id = 'stf_ws_raju'`);
  check('X2 deleting a record that another points at clears the pointer instead of failing', st(sr) === 'distinct|-' && count('raju') === 2);
  check('X3 staff functions are not callable signed out', (await rpc(L.token(OWNER, 'anon'), 'staff_employee_create', { op_id: L.uuid(), legacy_id: 'z', name: 'Z' })).ok === false);

  console.log(`\n${L.PASS.length} passed, ${L.FAIL.length} failed - staff identity database`);
  process.exit(L.FAIL.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
