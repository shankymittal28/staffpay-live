/*
 * Shop receipts ("↩ Wapas mila" for Shop staff) - database + API tests for
 * sql/d3_receipts_shop_v1.sql on top of the released receipt migration.
 *
 *   test_d3/env.sh up && node test_d3/test_shop_receipts_db.js
 *
 * Today Wed 14 Oct 2026. Shop staff have no Old Hisab and keep their monthly
 * accounting; Workshop keeps its Old Hisab boundary and weekly rules.
 */
const L = require('./lib.js'), { check, rpc, sql, OWNER, OTHER } = L;
const T = L.token(OWNER), T2 = L.token(OTHER);
const n = x => x == null ? x : Number(x);
const receipt = (staff, amount, day, extra) => rpc(T, 'staff_receipt_add', Object.assign({ op_id: L.uuid(), staff_id: staff, amount, day, receipts_ok: true }, extra || {}));
const correct = (id, action, expected, extra) => rpc(T, 'staff_payment_correct', Object.assign({ op_id: L.uuid(), payment_id: id, action, expected, reason: 'test' }, extra || {}));
const rcv = s => sql(`select coalesce(string_agg(amount::int::text || '@' || to_char(date at time zone 'Asia/Kolkata', 'MM-DD'), ',' order by date), '') from staff_payment where staff_id = '${s}' and amount < 0`);
const state = () => sql(`select md5(coalesce(string_agg(legacy_id || ':' || amount::text || ':' || date, ',' order by legacy_id), '')) from staff_payment`)
  + sql(`select md5(coalesce(string_agg(legacy_id || state || cash_paid || version, ',' order by legacy_id), '')) from staff_settlement`)
  + '|' + sql('select count(*) from staff_payment_void') + '|' + sql('select count(*) from staff_d3_op');
const shopMonth = (staff, month, tok) => rpc(tok || T, 'staff_shop_month', { staff_id: staff, month });
const pay = (staff, amount, day, id) => sql(`insert into staff_payment (owner_id, legacy_id, staff_id, name, amount, note, date, month_key, device)
  values ('${OWNER}', '${id}', '${staff}', 'x', ${amount}, '', '${L.istTs(day, '11:00')}', '${day.slice(0, 7)}', 'test')`);

(async () => {
  L.reset(); L.setToday('2026-10-14');
  const ramesh = L.emp({ name: 'Ramesh', group: 'shop', wage: 'daily', rate: 500, legacy: 'stf_ramesh' });
  const rohit = L.emp({ name: 'Rohit', rate: 500, ob: -24000, obDate: '2026-10-04', legacy: 'stf_rohit' });
  const naya = L.emp({ name: 'Naya', rate: 500, legacy: 'stf_naya' });                       // workshop, no Old Hisab
  L.attRange(rohit, '2026-10-05', 'PPPPAAAPPPPPPP');
  pay(ramesh, 3000, '2026-10-03', 'pay_r1');

  // ---- S  creating a Shop receipt
  let a = await receipt(ramesh, 600, '2026-10-12', { note: 'Ramesh ne wapas diye' });
  check('S1 Shop receipt accepted without Old Hisab: minus row rcv_<op>, actual date 12 Oct, group shop',
    a.ok === true && a.group === 'shop' && /^rcv_/.test(a.payment_id) && rcv(ramesh) === '-600@10-12', { a, r: rcv(ramesh) });
  check('S2 same Payments ledger, note kept, device d3-receipt', sql(`select note || '|' || device || '|' || month_key from staff_payment where legacy_id = '${a.payment_id}'`) === 'Ramesh ne wapas diye|d3-receipt|2026-10');
  let base = state();
  const bad = [];
  for (const [label, amt, day] of [['future date', 100, '2026-10-15'], ['NaN', 'NaN', '2026-10-12'], ['Infinity', 'Infinity', '2026-10-12'], ['0', 0, '2026-10-12'],
    ['-5', -5, '2026-10-12'], ['10,000,000', 10000000, '2026-10-12'], ['100.001', 100.001, '2026-10-12'], ['text', 'abc', '2026-10-12']])
    bad.push([label, await receipt(ramesh, amt, day)]);
  bad.push(['other owner', await rpc(T2, 'staff_receipt_add', { op_id: L.uuid(), staff_id: ramesh, amount: 100, day: '2026-10-12' })]);
  check('S3 Shop refusals (future date, every bad amount, another owner): all refused, nothing written', bad.every(([, r]) => r.ok === false) && state() === base, bad.filter(([, r]) => r.ok !== false));
  const op = L.uuid();
  const r1 = await receipt(ramesh, 50, '2026-10-13', { op_id: op }), r2 = await receipt(ramesh, 50, '2026-10-13', { op_id: op }), r3 = await receipt(ramesh, 70, '2026-10-13', { op_id: op });
  check('S4 retry with the same op_id replays (one row); a different amount on that op_id is "operation mismatch"',
    r1.ok && r2.replayed === true && r3.error === 'operation mismatch' && rcv(ramesh) === '-600@10-12,-50@10-13', { r2, r3, r: rcv(ramesh) });

  // ---- W  Workshop rules unchanged
  a = await receipt(naya, 500, '2026-10-08');
  const b = await receipt(rohit, 500, '2026-10-04');
  check('W1 Workshop still needs Old Hisab and a date after it', /Old Hisab not entered/.test(a.error) && /before the Old Hisab/.test(b.error), { a, b });

  // ---- C  corrections and removal (controlled route only)
  const rid = sql(`select legacy_id from staff_payment where staff_id = '${ramesh}' and amount = -600`);
  base = state();
  a = await correct(rid, 'change', { amount: -600, day: '2026-10-12', staff_id: ramesh }, { new: { amount: 400 } });
  check('C1 an older page (no flag) cannot change a Shop receipt: "upgrade required", nothing written', a.error === 'upgrade required' && state() === base, a);
  a = await correct(rid, 'change', { amount: -600, day: '2026-10-12', staff_id: ramesh }, { receipts_ok: true, new: { amount: 100.001 } });
  check('C2 the receipt amount rule applies to Shop corrections', a.error === 'bad amount' && state() === base, a);
  a = await correct(rid, 'change', { amount: -600, day: '2026-10-12', staff_id: ramesh }, { receipts_ok: true, new: { amount: 400, day: '2026-10-11' } });
  check('C3 change to 400 on 11 Oct: stored -400, still a receipt, actual date moved', a.ok && rcv(ramesh) === '-400@10-11,-50@10-13', { a, r: rcv(ramesh) });
  const r50 = sql(`select legacy_id from staff_payment where staff_id = '${ramesh}' and amount = -50`);
  a = await correct(r50, 'remove', { amount: -50, day: '2026-10-13', staff_id: ramesh }, { receipts_ok: true, cash_not_given: true, reason: 'galti' });
  check('C4 removal keeps a correction record', a.ok && rcv(ramesh) === '-400@10-11' && sql(`select count(*) from staff_payment_void where legacy_id = '${r50}'`) === '1', a);

  // ---- G  ordinary phone saves cannot touch a Shop receipt
  base = state();
  await L.upsert(T, 'staff_payment', [L.payRow({ id: rid, staff: ramesh, amount: 400, date: L.istTs('2026-10-02') })]);
  await L.del(T, 'staff_payment', [rid]);
  await L.call(T, 'DELETE', '/staff_payment?month_key=eq.2026-10&staff_id=eq.' + ramesh);
  await L.upsert(T, 'staff_payment', [L.payRow({ id: 'pay_shop_minus', staff: ramesh, amount: -20, date: L.istTs('2026-10-12') })]);
  check('G1 History edit / delete, Clear Month and a minus upload leave the Shop receipt; no minus row added', rcv(ramesh) === '-400@10-11', rcv(ramesh));
  check('G2 an ordinary Shop payment is still freely deletable (Clear Month removed pay_r1, as before)', sql(`select count(*) from staff_payment where legacy_id = 'pay_r1'`) === '0');
  pay(ramesh, 3000, '2026-10-03', 'pay_r1b');

  // ---- X  Workshop figures untouched by Shop receipts
  const wr = JSON.stringify(await rpc(T, 'staff_workshop_report', { staff_id: rohit, to: '2026-10-14' }));
  const wp = await rpc(T, 'staff_workshop_payments', { from: '2026-10-01', to: '2026-10-31' });
  await receipt(ramesh, 100, '2026-10-14');
  check('X1 Workshop report and month totals ignore Shop receipts (old page: not refused, not withheld)',
    JSON.stringify(await rpc(T, 'staff_workshop_report', { staff_id: rohit, to: '2026-10-14' })) === wr && wp.ok === true
    && JSON.stringify(await rpc(T, 'staff_workshop_payments', { from: '2026-10-01', to: '2026-10-31' })) === JSON.stringify(wp)
    && !/wapas mila/.test(wr), wp);

  // ---- M  staff_shop_month: database figures for one Shop worker and month
  L.attRange(ramesh, '2026-10-01', 'PPPPPPPPPH');
  let m = await shopMonth(ramesh, '2026-10');
  check('M1 Oct from the database: 3 payment rows (3,000 given; 400 + 100 returned) and attendance 9 P / 1 H',
    m.ok && n(m.payments.count) === 3 && n(m.payments.given) === 3000 && n(m.payments.received) === 500
    && n(m.attendance.present) === 9 && n(m.attendance.half) === 1 && n(m.attendance.absent) === 0, m);
  const refusals = [await shopMonth(rohit, '2026-10'), await shopMonth(ramesh, '2026-10', T2), await shopMonth(ramesh, 'Oct'), await rpc(T, 'staff_shop_month', { staff_id: ramesh }),
    await rpc(L.token(OWNER, 'anon'), 'staff_shop_month', { staff_id: ramesh, month: '2026-10' })];
  check('M2 refused: a Workshop worker, another owner, a bad or missing month, a signed-out caller', refusals.every(r => r.ok === false), refusals);

  // ---- Y  cross-month: advance in September, returned in October (no carry-forward)
  const mohan = L.emp({ name: 'Mohan', group: 'shop', wage: 'daily', rate: 500, legacy: 'stf_mohan' });
  pay(mohan, 1000, '2026-09-10', 'pay_m_sep');
  a = await receipt(mohan, 600, '2026-10-05');
  const sep = await shopMonth(mohan, '2026-09'), oct = await shopMonth(mohan, '2026-10');
  check('Y1 Sept advance stays in Sept (given 1,000, returned 0); the Oct return is in Oct (given 0, returned 600)',
    a.ok && n(sep.payments.given) === 1000 && n(sep.payments.received) === 0 && n(oct.payments.given) === 0 && n(oct.payments.received) === 600, { sep, oct });
  check('Y2 both rows keep their actual dates and months (10 Sep / 2026-09, 5 Oct / 2026-10)',
    sql(`select string_agg(amount::int || '@' || to_char(date at time zone 'Asia/Kolkata', 'DD Mon') || '/' || month_key, ',' order by date) from staff_payment where staff_id = '${mohan}'`) === '1000@10 Sep/2026-09,-600@05 Oct/2026-10');

  console.log(`\n${L.PASS.length} passed, ${L.FAIL.length} failed - Shop receipts database`);
  process.exit(L.FAIL.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
