/*
 * Receipts ("Wapas mila") database + API acceptance tests.
 *
 * Same disposable PostgreSQL + PostgREST as the D3/N1 tests (env.sh applies
 * sql/d3_receipts_v1.sql on top of N1). Every call goes through PostgREST with
 * a Supabase-style token. Rupee amounts are worked out by hand in the comments.
 *
 *   test_d3/env.sh up && node test_d3/test_receipts_db.js
 *
 * Common setup: Rs 500/day. W1 = Mon 5 - Sun 11 Oct 2026, W2 = 12 - 18 Oct.
 * "Old page" = a request exactly as rc13/rc14 send it (no receipts_ok, the five
 * seen figures). "New page" = receipts_ok: true plus advances_out and received.
 */
const { spawn } = require('child_process');
const L = require('./lib.js'), { check, rpc, sql, OWNER, OTHER } = L;
const T = L.token(OWNER), T2 = L.token(OTHER);
const n = x => x == null ? x : Number(x);
const addDays = (d, k) => new Date(new Date(d + 'T00:00:00Z').getTime() + k * 864e5).toISOString().slice(0, 10);
const W1 = '2026-10-05', W2 = '2026-10-12';
const wk = (r, monday) => (r.weeks || []).find(w => w.monday === monday);
const seenOld = w => ({ days: n(w.days_worked), rate: n(w.rate), earned: n(w.earned), previous: n(w.previous), advances: n(w.advances_total) });
const seenNew = w => Object.assign(seenOld(w), { advances_out: n(w.advances_out_total), received: n(w.receipts_total) });
const report = (staff, to, extra) => rpc(T, 'staff_workshop_report', Object.assign({ staff_id: staff, to }, extra || {}));
const reportNew = (staff, to, extra) => report(staff, to, Object.assign({ receipts_ok: true }, extra || {}));
async function payload(staff, monday, action, isNew, extra) {
  const r = isNew ? await reportNew(staff, addDays(monday, 6)) : await report(staff, addDays(monday, 6)), w = wk(r, monday);
  const p = { op_id: L.uuid(), action, staff_id: staff, week: monday,
    expected_version: w && w.settlement ? w.settlement.version : null,
    cash: 0, seen: w ? (isNew ? seenNew(w) : seenOld(w)) : null, sunday_done: true, advances_complete: true };
  if (isNew) p.receipts_ok = true;
  return Object.assign(p, extra || {});
}
const apply = p => rpc(T, 'staff_settlement_apply', p);
const settleNew = async (staff, monday, cash) => apply(await payload(staff, monday, 'settle', true, { cash }));
const settleOld = async (staff, monday, cash) => apply(await payload(staff, monday, 'settle', false, { cash }));
const receipt = (staff, amount, day, extra) => rpc(T, 'staff_receipt_add',
  Object.assign({ op_id: L.uuid(), staff_id: staff, amount, day, receipts_ok: true }, extra || {}));
const rows = staff => JSON.parse(sql(`select coalesce(json_agg(json_build_object('id', legacy_id, 'amount', amount::float, 'day', (date at time zone 'Asia/Kolkata')::date) order by date, legacy_id), '[]') from staff_payment where staff_id = '${staff}'`));
const rcvRows = staff => rows(staff).filter(x => x.amount < 0);
const net = staff => n(sql(`select coalesce(sum(amount), 0) from staff_payment where staff_id = '${staff}'`));
const ops = () => n(sql('select count(*) from staff_d3_op'));
const voids = () => n(sql('select count(*) from staff_payment_void'));
const worker = (name, o) => L.emp(Object.assign({ name, rate: 500, ob: 0, obDate: '2026-10-04' }, o || {}));
const advance = (staff, amount, day, id) => sql(`insert into staff_payment (owner_id, legacy_id, staff_id, name, amount, note, date, month_key, device)
  values ('${OWNER}', '${id || 'pay_' + Math.random().toString(36).slice(2)}', '${staff}', 'x', ${amount}, '', '${L.istTs(day, '11:00')}', '${day.slice(0, 7)}', 'test')`);
const correct = (id, action, expected, extra) => rpc(T, 'staff_payment_correct',
  Object.assign({ op_id: L.uuid(), payment_id: id, action, expected, reason: 'test reason' }, extra || {}));
const exp = (amount, day, staff) => ({ amount, day, staff_id: staff });

// Hold the per-worker lock from a separate connection, so the next requests
// queue behind it in a known order (PostgreSQL grants waiters first-come).
function psqlBg(q) {
  return new Promise(res => {
    const p = spawn('psql', ['-h', '/tmp', '-p', '54329', '-U', 'postgres', '-d', process.env.D3_DB || 'd3test', '-q', '-c', q]);
    p.on('exit', res);
  });
}
const waiters = () => n(sql(`select count(*) from pg_locks where locktype = 'advisory' and not granted`));
async function until(f, ms) { const t = Date.now(); while (!f()) { if (Date.now() - t > (ms || 5000)) throw new Error('timeout'); await new Promise(r => setTimeout(r, 25)); } }
async function ordered(staff, first, second) {
  const hold = psqlBg(`begin; select pg_advisory_xact_lock(hashtext('staffpay-d3'), hashtext('${staff}')); select pg_sleep(1); commit;`);
  await until(() => n(sql(`select count(*) from pg_locks where locktype = 'advisory' and granted`)) > 0);
  const a = first(); await until(() => waiters() >= 1);
  const b = second(); await until(() => waiters() >= 2);
  await hold;
  return [await a, await b];
}

(async () => {
  L.reset();
  L.setToday('2026-10-11');

  // ============================================================ R  Rohit end to end
  // Old Hisab: Rs 24,000 owed BY Rohit at the end of Sun 4 Oct. W1: 4 days
  // Present (Mon-Thu) = 2,000 earned; Rs 1,000 given Fri 9 Oct; Rs 14,000
  // returned Sun 11 Oct. Payday: owner keeps back (KITNA KAATNA) 1,000, cash 0.
  const rohit = worker('Rohit', { ob: -24000 }); L.attRange(rohit, W1, 'PPPPAAA');
  advance(rohit, 1000, '2026-10-09', 'pay_rohit_9oct');
  let a = await receipt(rohit, 14000, '2026-10-11', { note: 'Rohit ne wapas diye' });
  check('R1 receipt saved: rcv_<op_id>, stored as -14,000 on 11 Oct, linked by permanent id',
    a.ok === true && /^rcv_/.test(a.payment_id) && JSON.stringify(rcvRows(rohit)) === JSON.stringify([{ id: a.payment_id, amount: -14000, day: '2026-10-11' }]), { a, r: rows(rohit) });
  let r = await reportNew(rohit, '2026-10-11'), w = wk(r, W1);
  // net advances 1,000 - 14,000 = -13,000; given 1,000; returned 14,000
  check('R2 week figures: earned 2,000, previous -24,000, net -13,000, given 1,000, returned 14,000, closing -9,000',
    n(w.earned) === 2000 && n(w.previous) === -24000 && n(w.advances_total) === -13000 && n(w.advances_out_total) === 1000
    && n(w.receipts_total) === 14000 && n(w.closing) === -9000 && r.withheld.length === 0, w);
  // Payday sum: Pr = -24,000 + 14,000 = -10,000; avail = 2,000 - 1,000 = 1,000;
  // old advance 10,000; maxD = min(10,000, 1,000) = 1,000; D 1,000 -> cash 0.
  a = await settleNew(rohit, W1, 0);
  r = await reportNew(rohit, '2026-10-11'); w = wk(r, W1);
  check('R3 settled with cash 0: final -9,000 (Rs 9,000 Rohit owes); ledger net 1,000 - 14,000 = -13,000',
    a.ok === true && n(w.closing) === -9000 && n(r.balance) === -9000 && net(rohit) === -13000 && w.settlement.state === 'settled', { a, w });
  const det = JSON.parse(sql(`select detail from staff_settlement where staff_id = '${rohit}'`));
  check('R4 the settlement record keeps given 1,000 and returned 14,000 beside the net -13,000',
    n(det.advances_out_total) === 1000 && n(det.receipts_total) === 14000 && n(det.advances_total) === -13000, det);
  check('R5 the Rs 1,000 of 9 Oct counted once (one row, counted only as given)',
    rows(rohit).filter(x => x.id === 'pay_rohit_9oct').length === 1 && n(w.advances_out_total) === 1000, rows(rohit));

  // ============================================================ P  partial / full / beyond (database closing)
  L.setToday('2026-10-11');
  const part = worker('Partial', { ob: -5000 }); L.attRange(part, W1, 'PPPAAAA');
  await receipt(part, 2000, '2026-10-08');
  // Pr = -3,000, avail 1,500, oldAdv 3,000, maxD 1,500 -> keep 1,500, cash 0, final -1,500
  a = await settleNew(part, W1, 0); r = await reportNew(part, '2026-10-11');
  check('P1 partial: owed 5,000, returned 2,000, earned 1,500 kept back -> cash 0, final -1,500', a.ok && n(r.balance) === -1500, { a, b: r.balance });
  const full = worker('Full', { ob: -5000 }); L.attRange(full, W1, 'PPPAAAA');
  await receipt(full, 5000, '2026-10-08');
  // Pr = 0, oldAdv 0, maxD 0 -> cash 1,500, final 0
  a = await settleNew(full, W1, 1500); r = await reportNew(full, '2026-10-11');
  check('P2 full: owed 5,000, returned 5,000, earned 1,500 -> cash 1,500, final 0', a.ok && n(r.balance) === 0 && n(wk(r, W1).receipts_total) === 5000, { a, b: r.balance });
  const beyond = worker('Beyond', { ob: -5000 }); L.attRange(beyond, W1, 'PPPAAAA');
  await receipt(beyond, 7000, '2026-10-08');
  // Pr = +2,000 (shop owes), avail 1,500 -> cash 3,500, final 0
  a = await settleNew(beyond, W1, 3500); r = await reportNew(beyond, '2026-10-11');
  check('P3 beyond: owed 5,000, returned 7,000, earned 1,500 -> shop owes 2,000; cash 3,500, final 0', a.ok && n(r.balance) === 0, { a, b: r.balance });

  // ============================================================ V  receipt validation
  const shop = worker('Shopboy', { group: 'shop' });
  const noOb = worker('NoOldHisab', { obDate: null });
  const v = worker('Valid');
  let before = ops();
  a = await receipt(shop, 500, '2026-10-08');
  check('V1 shop staff refused', a.ok === false && a.error === 'not a workshop worker', a);
  a = await receipt(noOb, 500, '2026-10-08');
  check('V2 worker without Old Hisab refused', a.ok === false && /Old Hisab not entered/.test(a.error), a);
  a = await receipt(v, 500, '2026-10-04');
  check('V3 on the Old Hisab date itself refused (only days after count)', a.ok === false && /before the Old Hisab/.test(a.error), a);
  a = await receipt(v, 500, '2026-10-12');
  check('V4 future date refused', a.ok === false && a.error === 'future date', a);
  const bad = await Promise.all([receipt(v, 0, '2026-10-08'), receipt(v, -500, '2026-10-08'), receipt(v, 'abc', '2026-10-08'), receipt(v, 10.555, '2026-10-08')]);
  check('V5 amount 0, minus, text and 3 decimals refused', bad.every(x => x.ok === false), bad);
  a = await rpc(T2, 'staff_receipt_add', { op_id: L.uuid(), staff_id: v, amount: 500, day: '2026-10-08' });
  check('V6 another owner cannot record against this worker', a.ok === false && a.error === 'not found', a);
  a = await rpc(L.token(OWNER, 'anon'), 'staff_receipt_add', { op_id: L.uuid(), staff_id: v, amount: 500, day: '2026-10-08' });
  check('V7 signed-out caller cannot call it', a.ok === false, a);
  check('V8 nothing written by any refusal: no rows, no operation log', rows(v).length === 0 && rows(shop).length === 0 && ops() === before, { ops: ops(), before });
  const op = L.uuid();
  const r1 = await receipt(v, 700, '2026-10-08', { op_id: op }), r2 = await receipt(v, 700, '2026-10-08', { op_id: op });
  check('V9 retry with the same op_id (lost reply): replayed, one row', r1.ok && r2.ok && r2.replayed === true && rcvRows(v).length === 1, { r1, r2 });
  a = await receipt(v, 900, '2026-10-08', { op_id: op });
  check('V10 same op_id with a different amount: "operation mismatch", still one row of -700',
    a.ok === false && a.error === 'operation mismatch' && rcvRows(v).length === 1 && rcvRows(v)[0].amount === -700, a);
  const st = await rpc(T, 'staff_d3_op_status', { op_id: op });
  check('V11 status check after a lost reply finds it', st.found === true && st.result.payment_id === 'rcv_' + op, st);

  // ============================================================ G  old upload route (ordinary phone saves)
  const g = worker('Guard'); advance(g, 1000, '2026-10-07', 'pay_g1');
  const gr = await receipt(g, 600, '2026-10-08'); const gid = gr.payment_id;
  let up = await L.upsert(T, 'staff_payment', [L.payRow({ id: 'pay_minus', staff: g, amount: -300, date: L.istTs('2026-10-08') })]);
  check('G1 a minus amount uploaded the old way is not stored', rows(g).every(x => x.id !== 'pay_minus'), { up: up.status, rows: rows(g) });
  up = await L.upsert(T, 'staff_payment', [L.payRow({ id: 'rcv_fake', staff: g, amount: 300, date: L.istTs('2026-10-08') })]);
  check('G2 an rcv_ id uploaded the old way is not stored', rows(g).every(x => x.id !== 'rcv_fake'), rows(g));
  const shopUp = await L.upsert(T, 'staff_payment', [L.payRow({ id: 'pay_shop_minus', staff: shop, amount: -50, date: L.istTs('2026-10-08') })]);
  check('G3 shop staff: minus amounts refused too; a normal shop payment still saves',
    rows(shop).length === 0 && (await L.upsert(T, 'staff_payment', [L.payRow({ id: 'pay_shop_ok', staff: shop, amount: 50, date: L.istTs('2026-10-08') })]), rows(shop).length === 1), rows(shop));
  await L.upsert(T, 'staff_payment', [L.payRow({ id: 'pay_shop_ok', staff: shop, amount: -50, date: L.istTs('2026-10-08') })]);
  check('G4 an upload cannot turn a payment negative (shop staff, unprotected)', rows(shop)[0].amount === 50, rows(shop));
  await L.upsert(T, 'staff_payment', [L.payRow({ id: 'pay_g1', staff: g, amount: -1000, date: L.istTs('2026-10-07') })]);
  check('G5 an upload cannot turn a workshop advance negative', rows(g).find(x => x.id === 'pay_g1').amount === 1000, rows(g));
  await L.upsert(T, 'staff_payment', [L.payRow({ id: gid, staff: g, amount: 600, date: L.istTs('2026-10-09') })]);
  check('G6 History edit / CSV restore of a receipt (amount, date) leaves it unchanged',
    JSON.stringify(rcvRows(g)) === JSON.stringify([{ id: gid, amount: -600, day: '2026-10-08' }]), rcvRows(g));
  await L.del(T, 'staff_payment', [gid]);
  await L.call(T, 'DELETE', '/staff_payment?month_key=eq.2026-10');   // Clear Month
  check('G7 History delete and Clear Month leave the receipt (and the protected advance)',
    rcvRows(g).length === 1 && rows(g).some(x => x.id === 'pay_g1'), rows(g));
  check('G8 none of that wrote a correction record or an operation-log entry for the receipt',
    n(sql(`select count(*) from staff_payment_void where legacy_id = '${gid}'`)) === 0
    && n(sql(`select count(*) from staff_d3_op where ref = '${gid}'`)) === 1, sql(`select action from staff_d3_op where ref = '${gid}'`));

  // ============================================================ C  correcting a receipt
  before = ops(); const vb = voids();
  a = await correct(gid, 'change', exp(-600, '2026-10-08', g), { new: { amount: 500 } });
  const a2 = await correct(gid, 'remove', exp(-600, '2026-10-08', g), { cash_not_given: true });
  check('C1 old page (rc13/rc14 request): change and remove refused "App update karein"; no change, no void, no log',
    a.error === 'upgrade required' && a2.error === 'upgrade required' && /App update karein/.test(a.message)
    && rcvRows(g)[0].amount === -600 && voids() === vb && ops() === before, { a, a2 });
  a = await correct(gid, 'change', exp(-600, '2026-10-08', g), { receipts_ok: true, new: { amount: 500, day: '2026-10-09' } });
  check('C2 new page changes it: amount sent as 500 is stored -500 (still a receipt), new date 9 Oct',
    a.ok === true && JSON.stringify(rcvRows(g)) === JSON.stringify([{ id: gid, amount: -500, day: '2026-10-09' }]), { a, r: rcvRows(g) });
  a = await correct(gid, 'change', exp(-500, '2026-10-09', g), { receipts_ok: true, new: { amount: -800 } });
  check('C3 a minus figure from the page is refused (the direction is kept by the database)', a.ok === false && rcvRows(g)[0].amount === -500, a);
  a = await correct(gid, 'change', exp(-500, '2026-10-09', g), { receipts_ok: true, new: { amount: 500, day: '2026-10-04' } });
  check('C4 moving a receipt onto/before the Old Hisab date refused', a.ok === false && /before the Old Hisab/.test(a.error), a);
  a = await correct(gid, 'remove', exp(-500, '2026-10-09', g), { receipts_ok: true });
  check('C5 removing needs the "paisa wapas mila hi nahi" confirmation', a.ok === false && rcvRows(g).length === 1, a);
  a = await correct(gid, 'remove', exp(-500, '2026-10-09', g), { receipts_ok: true, cash_not_given: true, reason: 'galti se likha' });
  const vrec = JSON.parse(sql(`select json_build_object('reason', reason, 'amount', (original->>'amount')::float) from staff_payment_void where legacy_id = '${gid}'`));
  check('C6 removed: row gone, correction record kept with reason and the -500', a.ok && rcvRows(g).length === 0 && vrec.reason === 'galti se likha' && vrec.amount === -500, { a, vrec });
  await L.upsert(T, 'staff_payment', [L.payRow({ id: gid, staff: g, amount: -500, date: L.istTs('2026-10-09') })]);
  check('C7 an old phone re-uploading its copy does not bring it back', rcvRows(g).length === 0, rows(g));
  a = await correct(gid, 'remove', exp(-500, '2026-10-09', g), { receipts_ok: true, cash_not_given: true });
  check('C8 removing again: "already removed"', a.error === 'already removed', a);

  // ============================================================ O  old pages: settlement compatibility
  L.reset(); L.setToday('2026-10-18');
  const plain = worker('Plain'); L.attRange(plain, W1, 'PPPPPPPPPPPPPP'); advance(plain, 1000, '2026-10-07');
  a = await settleOld(plain, W1, 2500);
  // W1 earned 3,500 - 1,000 = 2,500 owed -> cash 2,500 -> closing 0
  check('O1 old page, week without receipts: five seen figures, no flag -> settles normally (cash 2,500, closing 0)',
    a.ok === true && n(wk(await report(plain, '2026-10-11'), W1).closing) === 0, a);
  check('O2 old page report for a week without receipts: nothing withheld',
    (await report(plain, '2026-10-18')).withheld.length === 0, (await report(plain, '2026-10-18')).withheld);
  const mixed = worker('Mixed', { ob: -3000 }); L.attRange(mixed, W1, 'PPPPPPPPPPPPPP');
  await receipt(mixed, 1000, '2026-10-07');
  r = await report(mixed, '2026-10-11');
  check('O3 old page report for a week with a receipt: figures withheld "wapas mila paisa hai"',
    r.withheld.some(x => /wapas mila paisa hai/.test(x)) && r.receipts_ok === undefined, r.withheld);
  before = ops();
  a = await settleOld(mixed, W1, 0);
  check('O4 old page settle of a week with a receipt: refused "upgrade required", nothing written',
    a.ok === false && a.error === 'upgrade required' && /App update karein/.test(a.message) && ops() === before
    && n(sql(`select count(*) from staff_settlement where staff_id = '${mixed}'`)) === 0, a);
  a = await apply(await payload(mixed, W1, 'settle', true, { cash: 0, seen: seenOld(wk(await reportNew(mixed, '2026-10-11'), W1)) }));
  check('O5 a flagged request that leaves out given/received: "figures changed"', a.error === 'figures changed', a);
  // W1: -3,000 + 3,500 + 1,000 returned = +1,500 owed to him -> cash 1,500, closing 0
  a = await settleNew(mixed, W1, 1500);
  check('O6 new page settles it (cash 1,500, closing 0)', a.ok === true && n(wk(await reportNew(mixed, '2026-10-11'), W1).closing) === 0, a);
  r = await report(mixed, '2026-10-18');
  check('O7 old page, next week (no receipt in it): shown normally, previous carries the receipt (0)',
    r.withheld.length === 0 && n(wk(r, W2).previous) === 0, { wh: r.withheld, w: wk(r, W2) });
  a = await settleOld(mixed, W2, 3500);
  check('O8 old page settles that next week normally', a.ok === true, a);
  a = await apply(await payload(mixed, W1, 'change', false, { cash: 1000 }));
  check('O9 old page "change" of the settled receipt week: refused "upgrade required"', a.error === 'upgrade required', a);
  r = await report(mixed, '2026-10-31', { from: '2026-10-01' });
  check('O10 old page month view (Payroll) with a receipt in the month: withheld', r.withheld.some(x => /wapas mila/.test(x)), r.withheld);
  r = await reportNew(mixed, '2026-10-31', { from: '2026-10-01' });
  check('O11 new page month view: not withheld; period_received 1,000', r.withheld.length === 0 && n(r.period_received) === 1000, { wh: r.withheld, pr: r.period_received });

  // ============================================================ E  equal extra advance and receipt (net unchanged)
  const eq = worker('Equal'); L.attRange(eq, W1, 'PPPPPPPPPPPPPP'); advance(eq, 1000, '2026-10-07');
  let pl = await payload(eq, W1, 'settle', true, { cash: 2500 });
  advance(eq, 400, '2026-10-08'); await receipt(eq, 400, '2026-10-09');
  const wn = wk(await reportNew(eq, '2026-10-11'), W1);
  check('E1 extra 400 given and 400 returned: net advances unchanged (1,000) but given 1,400 / returned 400',
    n(wn.advances_total) === 1000 && n(wn.advances_out_total) === 1400 && n(wn.receipts_total) === 400, wn);
  a = await apply(pl);
  check('E2 a draft from before them: server says "figures changed" (not settled)', a.error === 'figures changed'
    && n(sql(`select count(*) from staff_settlement where staff_id = '${eq}'`)) === 0, a);

  // ============================================================ X  races (both orders, per-worker lock)
  L.setToday('2026-10-11');
  // X1/X2 receipt vs settlement
  for (const order of ['receipt first', 'settlement first']) {
    const x = worker('Race ' + order, { ob: -2000 }); L.attRange(x, W1, 'PPPPAAA');
    const p = await payload(x, W1, 'settle', true, { cash: 0 });   // seen: given 0, returned 0
    const doR = () => receipt(x, 1500, '2026-10-10'), doS = () => apply(p);
    const [ra, rb] = order === 'receipt first' ? await ordered(x, doR, doS) : await ordered(x, doS, doR);
    const rec = order === 'receipt first' ? ra : rb, set = order === 'receipt first' ? rb : ra;
    const w1 = wk(await reportNew(x, '2026-10-11'), W1);
    if (order === 'receipt first')
      check('X1 receipt then settlement: receipt saved once; the stale settlement refused "figures changed"',
        rec.ok && set.error === 'figures changed' && rcvRows(x).length === 1 && !w1.settlement, { rec, set });
    else
      check('X2 settlement then receipt: both saved once; receipt shows as added after the settlement',
        rec.ok && set.ok && rcvRows(x).length === 1 && w1.added_after_settlement.length === 1 && n(w1.closing) === -2000 + 2000 + 1500, { rec, set, w1 });
  }
  // X3/X4 receipt correction vs settlement
  for (const order of ['correction first', 'settlement first']) {
    const x = worker('Fix ' + order, { ob: -2000 }); L.attRange(x, W1, 'PPPPAAA');
    const rc = await receipt(x, 1500, '2026-10-09');
    const p = await payload(x, W1, 'settle', true, { cash: 0 });
    const doC = () => correct(rc.payment_id, 'change', exp(-1500, '2026-10-09', x), { receipts_ok: true, new: { amount: 1200 } });
    const doS = () => apply(p);
    const [ra, rb] = order === 'correction first' ? await ordered(x, doC, doS) : await ordered(x, doS, doC);
    const c = order === 'correction first' ? ra : rb, s = order === 'correction first' ? rb : ra;
    if (order === 'correction first')
      check('X3 correction then settlement: receipt now -1,200; stale settlement refused "figures changed"',
        c.ok && s.error === 'figures changed' && rcvRows(x)[0].amount === -1200, { c, s });
    else
      check('X4 settlement then correction: settled once on -1,500 figures; correction applied after (-1,200)',
        s.ok && c.ok && rcvRows(x)[0].amount === -1200 && n(sql(`select count(*) from staff_settlement where staff_id = '${x}'`)) === 1, { c, s });
  }
  // X5 two phones correcting the same receipt
  const tp = worker('TwoPhones'); const tr = await receipt(tp, 1000, '2026-10-09');
  const [c1, c2] = await ordered(tp,
    () => correct(tr.payment_id, 'change', exp(-1000, '2026-10-09', tp), { receipts_ok: true, new: { amount: 900 } }),
    () => correct(tr.payment_id, 'remove', exp(-1000, '2026-10-09', tp), { receipts_ok: true, cash_not_given: true }));
  check('X5 two phones: first change wins (-900); the second, made on the old figure, is told "payment changed"',
    c1.ok && c2.error === 'payment changed' && rcvRows(tp)[0].amount === -900 && voids() === n(sql('select count(*) from staff_payment_void')), { c1, c2 });
  // X6 two phones adding the same receipt (same op) at once
  const same = L.uuid(); const sw = worker('SameOp');
  const [s1, s2] = await ordered(sw, () => receipt(sw, 300, '2026-10-09', { op_id: same }), () => receipt(sw, 300, '2026-10-09', { op_id: same }));
  check('X6 same op_id twice at once: one row; the second is a replay', s1.ok && s2.replayed === true && rcvRows(sw).length === 1, { s1, s2 });
  // X7 lost reply on a correction: retry replays, nothing doubles
  const lr = await receipt(sw, 200, '2026-10-08'); const cop = L.uuid();
  const cp = { op_id: cop, payment_id: lr.payment_id, action: 'change', expected: exp(-200, '2026-10-08', sw), reason: 'r', receipts_ok: true, new: { amount: 250 } };
  const k1 = await rpc(T, 'staff_payment_correct', cp), k2 = await rpc(T, 'staff_payment_correct', cp);
  check('X7 lost reply on a correction: retry replays; receipt -250 once', k1.ok && k2.replayed === true && rcvRows(sw).find(x => x.id === lr.payment_id).amount === -250, { k1, k2 });

  // ============================================================ W  workshop payment totals
  L.reset(); L.setToday('2026-10-11');
  const t1 = worker('Tot'); advance(t1, 1000, '2026-10-06'); await receipt(t1, 300, '2026-10-08');
  let pw = await rpc(T, 'staff_workshop_payments', { from: '2026-10-01', to: '2026-10-31' });
  check('W1 old page month totals with a receipt in range: refused "upgrade required"', pw.ok === false && pw.error === 'upgrade required', pw);
  pw = await rpc(T, 'staff_workshop_payments', { from: '2026-10-01', to: '2026-10-07' });
  check('W2 old page, range without receipts: exactly the old fields', pw.ok === true && n(pw.total) === 1000 && pw.given === undefined
    && pw.workers[0].given === undefined && pw.workers[0].count === 1, pw);
  pw = await rpc(T, 'staff_workshop_payments', { from: '2026-10-01', to: '2026-10-31', receipts_ok: true });
  check('W3 new page: given 1,000, returned 300, net 700 (overall and for the worker)', pw.ok && n(pw.given) === 1000 && n(pw.received) === 300
    && n(pw.total) === 700 && n(pw.workers[0].given) === 1000 && n(pw.workers[0].received) === 300 && n(pw.workers[0].total) === 700, pw);

  // ============================================================ A  the receipt amount rule (creation and correction)
  L.setToday('2026-10-11');
  const am = worker('Amounts', { ob: -5000 });
  const state = () => sql(`select md5(coalesce(string_agg(legacy_id || ':' || amount::text || ':' || date, ',' order by legacy_id), '')) from staff_payment`)
    + sql(`select md5(coalesce(string_agg(legacy_id || state || cash_paid || version, ',' order by legacy_id), '')) from staff_settlement`)
    + '|' + voids() + '|' + ops();
  const BAD = [['missing', undefined], ['null', null], ['NaN', 'NaN'], ['Infinity', 'Infinity'], ['-Infinity', '-Infinity'], ['0', 0], ['-5', -5],
               ['10,000,000', 10000000], ['10,000,000.5', 10000000.5], ['100.001', 100.001], ['"100.001"', '100.001'], ['text', 'abc']];
  let base = state();
  const addRes = [];
  for (const [label, amt] of BAD) {
    const q = { op_id: L.uuid(), staff_id: am, day: '2026-10-08', receipts_ok: true }; if (amt !== undefined) q.amount = amt;
    addRes.push([label, await rpc(T, 'staff_receipt_add', q)]);
  }
  check('A1 creating a receipt refuses ' + BAD.map(x => x[0]).join(', '), addRes.every(([, r]) => r.ok === false), addRes.filter(([, r]) => r.ok !== false));
  check('A2 those refusals left payments, settlements, correction records and the operation log unchanged', state() === base);
  a = await receipt(am, 99.99, '2026-10-08');
  check('A3 Rs 99.99 is accepted and stored as -99.99', a.ok === true && rcvRows(am)[0].amount === -99.99, { a, r: rcvRows(am) });
  const aid = a.payment_id;
  base = state();
  const corrRes = [];
  for (const [label, amt] of BAD) {
    const q = { op_id: L.uuid(), payment_id: aid, action: 'change', reason: 'x', receipts_ok: true, expected: exp(-99.99, '2026-10-08', am), new: {} };
    if (amt !== undefined) q.new.amount = amt;
    corrRes.push([label, await rpc(T, 'staff_payment_correct', q)]);
  }
  check('A4 correcting a receipt refuses ' + BAD.map(x => x[0]).join(', '), corrRes.every(([, r]) => r.ok === false), corrRes.filter(([, r]) => r.ok !== false));
  check('A5 those refusals left the receipt (-99.99), payments, settlements, correction records and the log unchanged',
    state() === base && rcvRows(am)[0].amount === -99.99, rcvRows(am));
  r = await reportNew(am, '2026-10-11');
  check('A6 the report stays a real number (no NaN anywhere)', !/NaN/.test(JSON.stringify(r)) && n(r.balance) === -5000 + 99.99, r.balance);
  a = await correct(aid, 'change', exp(-99.99, '2026-10-08', am), { receipts_ok: true, new: { amount: 9999999.99 } });
  check('A7 correcting to Rs 99,99,999.99 (largest allowed) works and keeps the direction (-9,999,999.99)', a.ok && rcvRows(am)[0].amount === -9999999.99, { a, r: rcvRows(am) });
  a = await correct(aid, 'change', exp(-9999999.99, '2026-10-08', am), { receipts_ok: true, new: { amount: '45.5' } });
  check('A8 correcting to "45.5" works: stored -45.5', a.ok && rcvRows(am)[0].amount === -45.5, { a, r: rcvRows(am) });
  // ordinary outgoing payments keep their existing behaviour (recorded separately, not changed here)
  advance(am, 700, '2026-10-09', 'pay_amounts_out');
  a = await correct('pay_amounts_out', 'change', exp(700, '2026-10-09', am), { receipts_ok: true, new: { amount: 100.001 } });
  check('A9 unchanged: an ordinary payment correction still accepts 100.001 (known weakness, out of scope)', a.ok === true
    && n(sql(`select amount from staff_payment where legacy_id = 'pay_amounts_out'`)) === 100.001, a);

  console.log(`\n${L.PASS.length} passed, ${L.FAIL.length} failed`);
  process.exit(L.FAIL.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
