/*
 * A1 correction 1 - ordinary edits must not release an identity hold
 * (synthetic data).
 *
 *   test_d3/env.sh up && node test_d3/test_identity_hold_edits_db.js
 *
 * Today Wed 14 Oct 2026, W1 = Mon 5 - Sun 11 Oct, Rs 500/day Workshop.
 * Raju R1 worked Mon 5 Oct (earned 500). Raju R2 arrived from an old page
 * (unresolved) and ₹500 is recorded on R2. Every ordinary edit below is a
 * REST upsert as the signed-in owner, exactly as phones and old pages send.
 */
const L = require('./lib.js'), { check, rpc, sql, OWNER } = L;
const T = L.token(OWNER);
const n = x => x == null ? x : Number(x);
const W1 = '2026-10-05';
const row = (legacy, name, extra) => Object.assign({ owner_id: OWNER, legacy_id: legacy, name, work_group: 'workshop', phone: '', active: true, salary: 500, wage_type: 'daily', opening_balance: 0, source: 'staff', device: 'old-page' }, extra || {});
const upload = (legacy, name, extra) => L.upsert(T, 'staff_employee', [row(legacy, name, extra)]);
const report = staff => rpc(T, 'staff_workshop_report', { staff_id: staff, to: '2026-10-11', receipts_ok: true });
async function settle(staff, cash) {
  const r = await report(staff), w = (r.weeks || []).find(x => x.monday === W1);
  return rpc(T, 'staff_settlement_apply', { op_id: L.uuid(), action: 'settle', staff_id: staff, week: W1, receipts_ok: true,
    expected_version: w && w.settlement ? w.settlement.version : null, cash, sunday_done: true, advances_complete: true,
    seen: w ? { days: n(w.days_worked), rate: n(w.rate), earned: n(w.earned), previous: n(w.previous), advances: n(w.advances_total),
                advances_out: n(w.advances_out_total), received: n(w.receipts_total) } : null });
}
const held = id => sql(`select staffpay_d3.identity_held(owner_id, id) from staff_employee where id = '${id}'`) === 't';
const rec = id => sql(`select name || '|' || coalesce(removed, false) || '|' || coalesce(identity_status, '-') || '|' || salary::int from staff_employee where id = '${id}'`);

(async () => {
  L.reset(); L.setToday('2026-10-14');
  const r1 = L.emp({ name: 'Raju', rate: 500, ob: 0, obDate: '2026-10-04', legacy: 'stf_r1' });
  L.attRange(r1, W1, 'PAAAAAA');
  await upload('stf_r2', 'Raju');
  const r2 = sql(`select id from staff_employee where legacy_id = 'stf_r2'`);
  await L.upsert(T, 'staff_payment', [Object.assign(L.payRow({ id: 1761100000001, name: 'Raju', amount: 500, date: L.istTs('2026-10-06') }), { staff_id: null, staff_legacy_id: 'stf_r2' })]);
  check('E0 set-up: R2 unresolved, ₹500 on R2, both held, R1 settlement refused',
    rec(r2) === 'Raju|false|unresolved|500' && held(r1) && held(r2) && (await settle(r1, 500)).error === 'balance withheld');

  // ---- edits to the unresolved record R2
  let u = await upload('stf_r2', 'Raju Bahadur');
  check('E1 an old-page upload renaming R2 is accepted but the name is kept; both stay held', u.status < 300 && rec(r2).startsWith('Raju|false|unresolved') && held(r1) && held(r2), rec(r2));
  check('E2 R1\'s ₹500 settlement is still refused after that rename', (await settle(r1, 500)).error === 'balance withheld');
  u = await upload('stf_r2', 'Raju', { removed: true });
  check('E3 an upload marking R2 removed is accepted but R2 stays (not removed); both stay held', u.status < 300 && rec(r2).startsWith('Raju|false|unresolved') && held(r1), rec(r2));
  check('E4 R1\'s ₹500 settlement is still refused after that removal', (await settle(r1, 500)).error === 'balance withheld');
  u = await upload('stf_r2', 'Raju', { salary: 550 });
  check('E5 other ordinary edits still apply (R2 rate 550); the hold remains', u.status < 300 && rec(r2) === 'Raju|false|unresolved|550' && held(r2));

  // ---- edits to the other member R1
  u = await upload('stf_r1', 'Raju Senior');
  check('E6 renaming R1 (the other member) is kept back too; both stay held', u.status < 300 && rec(r1).startsWith('Raju|false') && held(r1) && held(r2), rec(r1));
  u = await upload('stf_r1', 'Raju', { removed: true });
  check('E7 marking R1 removed is kept back too', rec(r1).startsWith('Raju|false') && held(r1));
  check('E8 settlement for R1 is still refused; references and history unchanged (₹500 still on R2, attendance on R1)',
    (await settle(r1, 500)).error === 'balance withheld'
    && sql(`select staff_id from staff_payment where legacy_id = '1761100000001'`) === r2
    && n(sql(`select count(*) from staff_attendance where staff_id = '${r1}'`)) === 7);

  // ---- "same person" keeps the same protection
  const k1 = L.emp({ name: 'Kamal', rate: 375, ob: 0, obDate: '2026-10-04', legacy: 'stf_k1' });
  await upload('stf_k2', 'Kamal');
  const k2 = sql(`select id from staff_employee where legacy_id = 'stf_k2'`);
  let d = await rpc(T, 'staff_identity_decide', { op_id: L.uuid(), staff_id: k2, decision: 'same', seen: [k1] });
  await upload('stf_k2', 'Kamal Two'); await upload('stf_k1', 'Kamal', { removed: true });
  check('E9 "same person": renaming one record or removing the other is kept back; both stay held',
    d.ok && rec(k2).startsWith('Kamal|false|same') && rec(k1).startsWith('Kamal|false') && held(k1) && held(k2), { k1: rec(k1), k2: rec(k2) });

  // ---- only the authorised decision releases it
  d = await rpc(T, 'staff_identity_decide', { op_id: L.uuid(), staff_id: r2, decision: 'different', seen: [r1] });
  const s = await settle(r1, 500);
  check('E10 after "different people" the hold is released and R1 settles its own ₹500', d.ok && !held(r1) && !held(r2) && s.ok === true, { d, s });
  u = await upload('stf_r2', 'Raju Bahadur');
  check('E11 once decided, ordinary renames work again (R2 renamed)', u.status < 300 && rec(r2).startsWith('Raju Bahadur|'), rec(r2));

  console.log(`\n${L.PASS.length} passed, ${L.FAIL.length} failed - identity hold vs ordinary edits`);
  process.exit(L.FAIL.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
