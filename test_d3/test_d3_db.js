/*
 * D3 database + API acceptance tests.
 *
 * Runs against the disposable PostgreSQL + PostgREST started by env.sh, using
 * the production-mirror schema (base_schema.sql) and sql/d3_weekly_hisab_v1.sql.
 * Every call that a phone makes goes through PostgREST with a Supabase-style
 * token, so RLS, grants, the "authenticated" role and the guards are the real
 * ones. Expected rupee amounts are worked out by hand in the comments and
 * written as literals - never computed with the code under test.
 *
 *   test_d3/env.sh up && node test_d3/test_d3_db.js
 */
const L = require('./lib.js'), { check, rpc, sql, OWNER, OTHER } = L;
const T = L.token(OWNER), T2 = L.token(OTHER);
const n = x => x == null ? x : Number(x);
const wk = (r, monday) => (r.weeks || []).find(w => w.monday === monday);
const seenOf = w => ({ days: n(w.days_worked), rate: n(w.rate), earned: n(w.earned), previous: n(w.previous), advances: n(w.advances_total) });
const payCount = like => Number(sql(`select count(*) from staff_payment where legacy_id like '${like}'`));
const stlRow = (staff, monday) => L.sqlJson(`select row_to_json(s) from staff_settlement s where legacy_id = 'stl_${staff}_${monday}'`);

async function settle(staff, monday, extra) {
  const r = await rpc(T, 'staff_workshop_report', { staff_id: staff, to: L.addDays(monday, 6) });
  const w = wk(r, monday);
  return Object.assign({ op_id: L.uuid(), action: 'settle', staff_id: staff, week: monday, expected_version: null,
    cash: 0, seen: w ? seenOf(w) : null, sunday_done: true, advances_complete: true }, extra || {});
}
L.addDays = (d, k) => new Date(new Date(d + 'T00:00:00Z').getTime() + k * 864e5).toISOString().slice(0, 10);

(async () => {
  // ===================================================================== A
  L.reset(); L.setToday('2026-10-11');                    // Sunday 11 Oct 2026
  const sonu = L.emp({ name: 'Sonu', rate: 800, ob: 0, obDate: '2026-10-04' });
  L.attRange(sonu, '2026-10-05', 'PPHPPHA');              // P4 H2 A1 -> 4 + 2x0.5 = 5 days
  // advances recorded by the app's normal upload path (role "authenticated")
  let up = await L.upsert(T, 'staff_payment', [
    L.payRow({ id: 1760000000001, staff: sonu, amount: 1000, date: L.istTs('2026-10-06') }),   // Tue
    L.payRow({ id: 1760000000002, staff: sonu, amount: 500, date: L.istTs('2026-10-09') })]);   // Fri
  check('A0 advances saved through the ordinary API', up.status === 201, up);
  let r = await rpc(T, 'staff_workshop_report', { staff_id: sonu, to: '2026-10-11' });
  let w = wk(r, '2026-10-05');
  // earned 5 x 800 = 4000; advances 1500; cash still to give 0 + 4000 - 1500 = 2500
  check('A1 owner example: days 5, rate 800, earned 4000', w && n(w.days_worked) === 5 && n(w.rate) === 800 && n(w.earned) === 4000, w);
  check('A2 advances 1000 (Tue) + 500 (Fri) = 1500, listed', n(w.advances_total) === 1500 && w.advances.length === 2
        && w.advances[0].day === '2026-10-06' && w.advances[1].day === '2026-10-09', w.advances);
  check('A3 cash still to give = closing before settlement = 2500', n(w.closing) === 2500 && n(r.balance) === 2500, w);
  let p = await settle(sonu, '2026-10-05', { cash: 2500 });
  let a = await rpc(T, 'staff_settlement_apply', p);
  check('A4 Sunday settlement of 2500 succeeds (version 1)', a.ok === true && a.version === 1 && n(a.cash) === 2500, a);
  const sonuPay1 = 'stl_' + sonu + '_2026-10-05_v1';
  const prow = L.sqlJson(`select json_build_object('amount', amount, 'day', (date at time zone 'Asia/Kolkata')::date, 'staff', staff_id)
                         from staff_payment where legacy_id = '${sonuPay1}'`);
  check('A5 settlement cash is ONE real payment of 2500 dated Sunday 11 Oct', prow && n(prow.amount) === 2500 && prow.day === '2026-10-11' && prow.staff === sonu, prow);
  r = await rpc(T, 'staff_workshop_report', { staff_id: sonu, to: '2026-10-11' });
  w = wk(r, '2026-10-05');
  check('A6 after settlement: settlement cash 2500, closing 0, balance 0', n(w.settlement_cash) === 2500 && n(w.closing) === 0 && n(r.balance) === 0, w);
  check('A7 settled week rate is frozen at 800', w.rate_frozen === true && n(w.settlement.detail.rate) === 800, w.settlement);

  // ===================================================================== B  carry-over and part payment
  L.setToday('2026-10-18');
  L.attRange(sonu, '2026-10-12', 'PPPPPPP');               // 7 x 800 = 5600
  p = await settle(sonu, '2026-10-12', { cash: 5000 });
  a = await rpc(T, 'staff_settlement_apply', p);
  r = await rpc(T, 'staff_workshop_report', { staff_id: sonu, to: '2026-10-18' });
  w = wk(r, '2026-10-12');
  // previous 0 + 5600 - 0 - 5000 = 600 still owed by the shop
  check('B1 part payment: earned 5600, paid 5000, closing 600', a.ok && n(w.earned) === 5600 && n(w.previous) === 0 && n(w.closing) === 600, { a, w });
  L.setToday('2026-10-20');
  L.attRange(sonu, '2026-10-19', 'PP');                    // Mon-Tue: 2 x 800 = 1600
  r = await rpc(T, 'staff_workshop_report', { staff_id: sonu, to: '2026-10-20' });
  w = wk(r, '2026-10-19');
  check('B2 next week opens with previous balance 600; balance now 600 + 1600 = 2200', n(w.previous) === 600 && n(r.balance) === 2200, w);

  // ===================================================================== C  negative opening, zero-cash settlement
  L.setToday('2026-10-11');
  const ravi = L.emp({ name: 'Ravi', rate: 500, ob: -2000, obDate: '2026-10-04' });   // worker owes shop 2000
  L.attRange(ravi, '2026-10-05', 'PPPPAAA');               // 4 x 500 = 2000
  await L.upsert(T, 'staff_payment', [L.payRow({ id: 1760000000101, staff: ravi, amount: 1000, date: L.istTs('2026-10-07') })]);
  r = await rpc(T, 'staff_workshop_report', { staff_id: ravi, to: '2026-10-11' });
  w = wk(r, '2026-10-05');
  // -2000 + 2000 - 1000 = -1000: worker owes the shop 1000; nothing to give
  check('C1 negative opening: closing -1000 (worker owes shop)', n(w.previous) === -2000 && n(w.closing) === -1000, w);
  a = await rpc(T, 'staff_settlement_apply', await settle(ravi, '2026-10-05', { cash: 0 }));
  check('C2 zero-cash settlement: record only, no payment row', a.ok && a.payment_id == null && payCount('stl_' + ravi + '%') === 0
        && n(stlRow(ravi, '2026-10-05').cash_paid) === 0, a);
  r = await rpc(T, 'staff_workshop_report', { staff_id: ravi, to: '2026-10-11' });
  check('C3 balance stays -1000 after zero-cash settlement', n(r.balance) === -1000, r.balance);

  // ===================================================================== D  missing Old Hisab vs explicit 0
  const noOb = L.emp({ name: 'Kallu', rate: 600 });
  r = await rpc(T, 'staff_workshop_report', { staff_id: noOb, to: '2026-10-11' });
  check('D1 Old Hisab missing: withheld, no balance', r.ok && r.balance === undefined && r.withheld[0] === 'Old Hisab not entered', r);
  a = await rpc(T, 'staff_settlement_apply', { op_id: L.uuid(), action: 'settle', staff_id: noOb, week: '2026-10-05', cash: 0, seen: {}, sunday_done: true, advances_complete: true });
  check('D2 settlement refused without Old Hisab', a.ok === false && /Old Hisab/.test(a.error), a);
  const zero = L.emp({ name: 'Zero', rate: 300, ob: 0, obDate: '2026-10-04' });
  r = await rpc(T, 'staff_workshop_report', { staff_id: zero, to: '2026-10-04' });
  check('D3 explicit 0 is a real Old Hisab: balance 0, nothing withheld', r.old_hisab && n(r.old_hisab.amount) === 0 && n(r.balance) === 0 && r.withheld.length === 0, r);

  // ===================================================================== E  boundary + Asia/Kolkata days
  const bina = L.emp({ name: 'Bina', rate: 400, ob: 1000, obDate: '2026-10-04' });
  L.att(bina, '2026-10-04', 'P');                          // on the boundary day: history
  L.attRange(bina, '2026-10-05', 'PPPPPPP');               // 7 x 400 = 2800
  await L.upsert(T, 'staff_payment', [
    L.payRow({ id: 1760000000201, staff: bina, amount: 300, date: L.istTs('2026-10-04', '23:30') }),   // day 04 IST: history
    L.payRow({ id: 1760000000202, staff: bina, amount: 200, date: L.istTs('2026-10-05', '00:30') })]); // 18:30 UTC on 04, but 05 in IST
  r = await rpc(T, 'staff_workshop_report', { staff_id: bina, to: '2026-10-11' });
  // 1000 + 2800 - 200 = 3600 (the 300 and the 04 Oct attendance are before the boundary)
  check('E1 records on/before the Old Hisab day are history; IST day decides', n(r.balance) === 3600 && n(r.paid_total) === 200, r);

  // ===================================================================== F  unmarked days are unknown
  const gopi = L.emp({ name: 'Gopi', rate: 500, ob: 0, obDate: '2026-09-27' });
  L.attRange(gopi, '2026-09-28', 'PP-PPPP');               // Wed 30 Sep missing in an EARLIER week
  L.attRange(gopi, '2026-10-05', 'PPPPPPP');
  r = await rpc(T, 'staff_workshop_report', { staff_id: gopi, to: '2026-10-11' });
  check('F1 missing earlier day withholds the balance and is listed', r.withheld.some(x => /Attendance not marked: 2026-09-30/.test(x)) && r.missing.includes('2026-09-30'), r.withheld);
  // (N1: weeks settle in order, so the week holding the gap is the one offered)
  a = await rpc(T, 'staff_settlement_apply', await settle(gopi, '2026-09-28', { cash: 0 }));
  check('F2 settlement refused while an earlier day is unmarked', a.ok === false && a.error === 'balance withheld', a);

  // ===================================================================== G  Sunday rule and confirmations
  L.setToday('2026-10-10');                                // Saturday
  const hari = L.emp({ name: 'Hari', rate: 700, ob: 0, obDate: '2026-10-04' });
  L.attRange(hari, '2026-10-05', 'PPPPPP');
  a = await rpc(T, 'staff_settlement_apply', await settle(hari, '2026-10-05', { cash: 0 }));
  check('G1 refused before Sunday (Saturday, Asia/Kolkata)', a.ok === false && /opens on Sunday 2026-10-11/.test(a.error), a);
  L.setToday('2026-10-11');
  L.att(hari, '2026-10-11', 'P');
  a = await rpc(T, 'staff_settlement_apply', await settle(hari, '2026-10-05', { cash: 0, sunday_done: false }));
  check('G2 refused without "Sunday\'s work is finished"', a.ok === false && /Sunday/.test(a.error), a);
  a = await rpc(T, 'staff_settlement_apply', await settle(hari, '2026-10-05', { cash: 0, advances_complete: false }));
  check('G3 refused without "every advance is entered"', a.ok === false && /advance/.test(a.error), a);

  // ===================================================================== H  version rules + replays
  const op0 = await settle(hari, '2026-10-05', { cash: 4900 });          // 7 x 700 = 4900
  const s1 = await rpc(T, 'staff_settlement_apply', op0);
  check('H1 first Settle -> version 1', s1.ok && s1.version === 1, s1);
  a = await rpc(T, 'staff_settlement_apply', await settle(hari, '2026-10-05', { cash: 4900 }));
  check('H2 second first-Settle (new op) -> already settled', a.ok === false && a.error === 'already settled', a);
  const rep = await rpc(T, 'staff_settlement_apply', op0);
  check('H3 identical retry -> saved answer, nothing written twice', rep.ok && rep.replayed === true && rep.version === 1
        && payCount('stl_' + hari + '%') === 1, rep);
  a = await rpc(T, 'staff_settlement_apply', Object.assign({}, op0, { cash: 4000 }));
  check('H4 same op id, different request -> operation mismatch', a.ok === false && a.error === 'operation mismatch', a);
  const cor = { op_id: L.uuid(), action: 'correct', staff_id: hari, week: '2026-10-05', expected_version: 1, reason: 'typed by mistake', cash_not_given: true };
  a = await rpc(T, 'staff_settlement_apply', cor);
  const hs = stlRow(hari, '2026-10-05');
  check('H5 correction: record kept as corrected v2, payment removed and recorded', a.ok && a.version === 2 && hs.state === 'corrected'
        && hs.version === 2 && payCount('stl_' + hari + '%') === 0
        && Number(sql(`select count(*) from staff_payment_void where legacy_id = 'stl_${hari}_2026-10-05_v1'`)) === 1, { a, hs });
  a = await rpc(T, 'staff_settlement_apply', Object.assign({}, op0, { op_id: L.uuid() }));
  check('H6 stale first-Settle after correction cannot recreate (version mismatch)', a.ok === false && a.error === 'version mismatch' && payCount('stl_' + hari + '%') === 0, a);
  a = await rpc(T, 'staff_settlement_apply', op0);
  check('H7 old Settle retry after correction -> replayed only, no payment', a.replayed === true && payCount('stl_' + hari + '%') === 0, a);
  const reset2 = await settle(hari, '2026-10-05', { cash: 4900, expected_version: 2 });
  a = await rpc(T, 'staff_settlement_apply', reset2);
  check('H8 re-settle with the corrected record\'s version 2 -> v3, new payment id', a.ok && a.version === 3 && a.payment_id === 'stl_' + hari + '_2026-10-05_v3', a);
  a = await rpc(T, 'staff_settlement_apply', cor);
  check('H9 old correction retry after re-settle -> replayed, payment survives', a.replayed === true && payCount('stl_' + hari + '%_v3') === 1, a);
  const ch1 = { op_id: L.uuid(), action: 'change', staff_id: hari, week: '2026-10-05', expected_version: 3, cash: 4800,
                seen: reset2.seen, sunday_done: true, advances_complete: true };
  const c1 = await rpc(T, 'staff_settlement_apply', ch1);
  const ch2 = Object.assign({}, ch1, { op_id: L.uuid(), expected_version: 4, cash: 4700 });
  const c2 = await rpc(T, 'staff_settlement_apply', ch2);
  a = await rpc(T, 'staff_settlement_apply', ch1);
  const nowCash = n(sql(`select amount from staff_payment where legacy_id = 'stl_${hari}_2026-10-05_v3'`));
  check('H10 old Change retry after a newer Change -> replayed, newer 4700 kept', c1.ok && c2.ok && a.replayed === true && nowCash === 4700, { c1, c2, a, nowCash });
  a = await rpc(T, 'staff_settlement_apply', Object.assign({}, ch1, { op_id: L.uuid() }));
  check('H11 a NEW Change with an old version is refused', a.ok === false && a.error === 'version mismatch', a);

  // ===================================================================== I/J  two phones
  const two = L.emp({ name: 'Twin', rate: 1000, ob: 0, obDate: '2026-10-04' });
  L.attRange(two, '2026-10-05', 'PPPPPPP');                // 7000
  const pa = await settle(two, '2026-10-05', { cash: 2500 }), pb = await settle(two, '2026-10-05', { cash: 3000 });
  const [ra, rb] = await Promise.all([rpc(T, 'staff_settlement_apply', pa), rpc(T, 'staff_settlement_apply', pb)]);
  const winner = ra.ok ? 2500 : 3000, loser = ra.ok ? rb : ra;
  const tw = stlRow(two, '2026-10-05');
  const twPays = L.sqlJson(`select coalesce(json_agg(amount), '[]') from staff_payment where legacy_id like 'stl_${two}%'`);
  check('I1 two phones at once: exactly one succeeds', (ra.ok ? 1 : 0) + (rb.ok ? 1 : 0) === 1, { ra, rb });
  check('I2 one payment and one record, same amount (no mixing)', twPays.length === 1 && n(twPays[0]) === winner && n(tw.cash_paid) === winner
        && tw.payment_legacy_id === 'stl_' + two + '_2026-10-05_v1', { twPays, tw });
  check('I3 the other phone is told it is already settled', loser.ok === false && loser.error === 'already settled' && n(loser.cash) === winner, loser);
  const twoB = L.emp({ name: 'TwinB', rate: 1000, ob: 0, obDate: '2026-10-04' });
  L.attRange(twoB, '2026-10-05', 'PPPPPPP');
  const pj = await settle(twoB, '2026-10-05', { cash: 2500 });
  pj.seen = Object.assign({}, pj.seen, { rate: 900, earned: 6300 });     // a phone holding an old rate, same cash
  a = await rpc(T, 'staff_settlement_apply', pj);
  check('J1 same cash but a different rate on the phone -> figures changed', a.ok === false && a.error === 'figures changed' && payCount('stl_' + twoB + '%') === 0, a);

  // ===================================================================== K  lost reply -> status
  const twoC = L.emp({ name: 'TwinC', rate: 1000, ob: 0, obDate: '2026-10-04' });
  L.attRange(twoC, '2026-10-05', 'PPPPPPP');
  const pk = await settle(twoC, '2026-10-05', { cash: 7000 });
  await rpc(T, 'staff_settlement_apply', pk);              // pretend the reply never arrived
  const st = await rpc(T, 'staff_d3_op_status', { op_id: pk.op_id });
  const st2 = await rpc(T, 'staff_d3_op_status', { op_id: L.uuid() });
  check('K1 status finds the saved operation and its result', st.found === true && st.result.ok === true && st.result.version === 1, st);
  check('K2 an operation that never arrived is "not found" (safe to resend)', st2.found === false, st2);
  const st3 = await rpc(T2, 'staff_d3_op_status', { op_id: pk.op_id });
  check('K3 another owner cannot see the operation', st3.found === false, st3);

  // ===================================================================== M  historical rate survives correction
  L.setToday('2026-10-11');
  const mohan = L.emp({ name: 'Mohan', rate: 500, ob: 0, obDate: '2026-10-04' });
  L.attRange(mohan, '2026-10-05', 'PPPPPPP');               // 7 x 500 = 3500
  const m1 = await settle(mohan, '2026-10-05', { cash: 3500 });
  await rpc(T, 'staff_settlement_apply', m1);
  let tv = Number(sql(`select terms_version from staff_employee where id = '${mohan}'`));
  a = await rpc(T, 'staff_workshop_terms_set', { op_id: L.uuid(), staff_id: mohan, expected_terms_version: tv, set: { salary: 600 } });
  check('M1 rate change allowed on Sunday once all work is in a settled week', a.ok && n(a.salary) === 600, a);
  a = await rpc(T, 'staff_settlement_apply', { op_id: L.uuid(), action: 'correct', staff_id: mohan, week: '2026-10-05', expected_version: 1, reason: 'wrong entry', cash_not_given: true });
  r = await rpc(T, 'staff_workshop_report', { staff_id: mohan, to: '2026-10-11' });
  w = wk(r, '2026-10-05');
  check('M2 after the payment is corrected, week 1 still earns 7 x 500 = 3500 (not 600)', a.ok && n(w.rate) === 500 && n(w.earned) === 3500 && w.rate_frozen === true, w);
  a = await rpc(T, 'staff_settlement_apply', await settle(mohan, '2026-10-05', { cash: 3500, expected_version: 2 }));
  check('M3 re-settlement keeps the frozen 500 rate', a.ok && n(stlRow(mohan, '2026-10-05').daily_wage) === 500, a);
  L.setToday('2026-10-13'); L.attRange(mohan, '2026-10-12', 'PP');
  r = await rpc(T, 'staff_workshop_report', { staff_id: mohan, to: '2026-10-13' });
  check('M4 the new week earns at 600: 2 x 600 = 1200', n(wk(r, '2026-10-12').earned) === 1200, wk(r, '2026-10-12'));

  // ===================================================================== N/O  rate change refused while work is unpriced
  const nita = L.emp({ name: 'Nita', rate: 400, ob: 0, obDate: '2026-10-04' });
  L.attRange(nita, '2026-10-05', 'PPP-PPP');               // Thu 08 Oct not marked
  L.setToday('2026-10-14');
  tv = Number(sql(`select terms_version from staff_employee where id = '${nita}'`));
  a = await rpc(T, 'staff_workshop_terms_set', { op_id: L.uuid(), staff_id: nita, expected_terms_version: tv, set: { salary: 450 } });
  check('N1 rate change refused while earlier work is not in a settled week', a.ok === false && a.error === 'rate change not allowed yet', a);
  L.att(nita, '2026-10-08', 'P');                          // the missing day entered later
  r = await rpc(T, 'staff_workshop_report', { staff_id: nita, to: '2026-10-11' });
  check('N2 the late day is priced at the unchanged 400: 7 x 400 = 2800', n(wk(r, '2026-10-05').earned) === 2800, wk(r, '2026-10-05'));
  L.setToday('2026-10-11');
  await rpc(T, 'staff_settlement_apply', await settle(nita, '2026-10-05', { cash: 2800 }));
  L.setToday('2026-10-14');                                // Wednesday, current week unsettled
  L.attRange(nita, '2026-10-12', 'PPP');
  a = await rpc(T, 'staff_workshop_terms_set', { op_id: L.uuid(), staff_id: nita, expected_terms_version: tv, set: { salary: 450 } });
  check('O1 mid-week rate change refused (Q2 open)', a.ok === false && a.error === 'rate change not allowed yet', a);

  // ===================================================================== P  Old Hisab: retries, stale, lock
  L.setToday('2026-10-11');
  const om = L.emp({ name: 'Om', rate: 500 });
  const t1 = { op_id: L.uuid(), staff_id: om, expected_terms_version: 0, set: { opening_balance: 1200, opening_balance_date: '2026-10-04' } };
  a = await rpc(T, 'staff_workshop_terms_set', t1);
  check('P1 Old Hisab set (amount + date) -> terms version 1', a.ok && a.terms_version === 1 && n(a.opening_balance) === 1200, a);
  const t2 = { op_id: L.uuid(), staff_id: om, expected_terms_version: 1, set: { opening_balance: 1500, opening_balance_date: '2026-10-04' } };
  await rpc(T, 'staff_workshop_terms_set', t2);
  a = await rpc(T, 'staff_workshop_terms_set', t1);          // the first reply was lost; the phone resends
  let ob = n(sql(`select opening_balance from staff_employee where id = '${om}'`));
  check('P2 lost-reply resend of an older Old Hisab change is replayed, newer 1500 kept', a.replayed === true && ob === 1500, { a, ob });
  a = await rpc(T, 'staff_workshop_terms_set', Object.assign({}, t1, { op_id: L.uuid() }));
  check('P3 a new request built on an old version is refused with current values', a.ok === false && a.error === 'changed elsewhere' && n(a.opening_balance) === 1500, a);
  const st4 = await rpc(T, 'staff_d3_op_status', { op_id: t2.op_id });
  check('P4 status check confirms the newer change', st4.found && n(st4.result.opening_balance) === 1500, st4);
  L.attRange(om, '2026-10-05', 'PPPPPPP');
  await rpc(T, 'staff_settlement_apply', await settle(om, '2026-10-05', { cash: 0 }));
  a = await rpc(T, 'staff_workshop_terms_set', { op_id: L.uuid(), staff_id: om, expected_terms_version: 2, set: { opening_balance: 0, opening_balance_date: '2026-10-04' } });
  check('P5 Old Hisab locked once a week is settled (no undo suggested)', a.ok === false && a.error === 'locked' && /needs review/.test(a.message) && !/undo/i.test(a.message), a);

  // ===================================================================== Q  ordinary saves cannot bypass protection
  L.setToday('2026-10-11');
  const shopW = L.emp({ name: 'ShopRaju', group: 'shop', wage: 'daily', rate: 400 });
  const q1 = 1760000000301, q2 = 1760000000302, q3 = 1760000000303, qShop = 1760000000304;
  await L.upsert(T, 'staff_payment', [
    L.payRow({ id: q1, staff: bina, amount: 700, date: L.istTs('2026-10-07') }),
    L.payRow({ id: q2, staff: bina, amount: 900, date: L.istTs('2026-10-08') }),
    L.payRow({ id: q3, staff: bina, amount: 50, date: L.istTs('2026-10-01') }),   // before Bina's boundary: unprotected
    L.payRow({ id: qShop, staff: shopW, amount: 250, date: L.istTs('2026-10-07') })]);
  const amt = id => n(sql(`select amount from staff_payment where legacy_id = '${id}'`));
  const day = id => sql(`select (date at time zone 'Asia/Kolkata')::date from staff_payment where legacy_id = '${id}'`);
  const sid = id => sql(`select staff_id from staff_payment where legacy_id = '${id}'`);
  await L.upsert(T, 'staff_payment', [L.payRow({ id: q1, staff: bina, amount: 70, date: L.istTs('2026-10-07') })]);
  check('Q1 ordinary edit of a protected amount is kept as stored (700)', amt(q1) === 700, amt(q1));
  await L.upsert(T, 'staff_payment', [L.payRow({ id: q1, staff: bina, amount: 700, date: L.istTs('2026-10-02') })]);
  check('Q2 ordinary edit moving it before the boundary is refused', day(q1) === '2026-10-07', day(q1));
  await L.upsert(T, 'staff_payment', [L.payRow({ id: q1, staff: shopW, amount: 700, date: L.istTs('2026-10-07') })]);
  check('Q3 ordinary edit moving it to another worker is refused', sid(q1) === bina, sid(q1));
  await L.upsert(T, 'staff_payment', [L.payRow({ id: q3, staff: bina, amount: 50, date: L.istTs('2026-10-06') })]);
  check('Q4 ordinary edit moving a history payment INTO the hisab is refused', day(q3) === '2026-10-01', day(q3));
  await L.upsert(T, 'staff_payment', [L.payRow({ id: q1, staff: bina, amount: 700, date: L.istTs('2026-10-07'), name: 'Bina Devi', note: 'tea' })]);
  check('Q5 harmless name/note change still saves', sql(`select name || '|' || note from staff_payment where legacy_id = '${q1}'`) === 'Bina Devi|tea');
  await L.del(T, 'staff_payment', [String(q1), String(q2), String(qShop)]);   // "Clear This Month" / old queued deletes
  check('Q6 bulk delete: protected advances survive, the shop payment is deleted', amt(q1) === 700 && amt(q2) === 900
        && sql(`select count(*) from staff_payment where legacy_id = '${qShop}'`) === '0');
  await L.upsert(T, 'staff_payment', [L.payRow({ id: 'stl_' + bina + '_2026-10-05_v9', staff: bina, amount: 99999, date: L.istTs('2026-10-11') })]);
  check('Q7 a phone cannot create a settlement payment', payCount('stl_' + bina + '%') === 0);
  await L.del(T, 'staff_payment', [sonuPay1]);
  await L.upsert(T, 'staff_payment', [L.payRow({ id: sonuPay1, staff: sonu, amount: 1, date: L.istTs('2026-10-11') })]);
  check('Q8 a phone cannot delete or change a settlement payment', amt(sonuPay1) === 2500, amt(sonuPay1));
  await L.call(T, 'PATCH', '/staff_settlement?legacy_id=eq.stl_' + sonu + '_2026-10-05', { cash_paid: 1, daily_wage: 1 });
  await L.del(T, 'staff_settlement', ['stl_' + sonu + '_2026-10-05']);
  const ss = stlRow(sonu, '2026-10-05');
  check('Q9 a phone cannot change or delete a settlement record', ss && n(ss.cash_paid) === 2500 && n(ss.daily_wage) === 800, ss);
  // worker terms through the ordinary worker save (what employeeRow sends, plus attempts at the new columns)
  const legSonu = sql(`select legacy_id from staff_employee where id = '${sonu}'`);
  await L.upsert(T, 'staff_employee', [{ legacy_id: legSonu, name: 'Sonu K', work_group: 'shop', phone: '98', active: true, salary: 1, wage_type: 'monthly',
                                          opening_balance: 99, opening_balance_date: '2026-01-01', terms_version: 50, source: 'staff', device: 'old' }]);
  const se = L.sqlJson(`select row_to_json(e) from staff_employee e where id = '${sonu}'`);
  check('Q10 ordinary worker save keeps Old Hisab, date, rate, pay type, group, terms version', n(se.opening_balance) === 0 && se.opening_balance_date === '2026-10-04'
        && n(se.salary) === 800 && se.wage_type === 'daily' && se.work_group === 'workshop' && se.terms_version === 0, se);
  check('Q11 ...while name and phone still save', se.name === 'Sonu K' && se.phone === '98', se);
  const legShop = sql(`select legacy_id from staff_employee where id = '${shopW}'`);
  await L.upsert(T, 'staff_employee', [{ legacy_id: legShop, name: 'ShopRaju', work_group: 'shop', phone: '', active: true, salary: 450, wage_type: 'monthly', opening_balance: 300, source: 'staff', device: 'x' }]);
  const sh = L.sqlJson(`select row_to_json(e) from staff_employee e where id = '${shopW}'`);
  check('Q12 shop worker: rate, pay type and opening balance save exactly as before', n(sh.salary) === 450 && sh.wage_type === 'monthly' && n(sh.opening_balance) === 300 && sh.opening_balance_date === null, sh);
  const newEmp = await L.upsert(T, 'staff_employee', [{ legacy_id: 'stf_new1', name: 'New', work_group: 'workshop', salary: 300, wage_type: 'daily', opening_balance: 5, source: 'staff' }]);
  check('Q13 a new worker created by a phone cannot carry an Old Hisab date', newEmp.status === 201 && newEmp.json[0].opening_balance_date === null, newEmp);

  // ===================================================================== R  controlled correction
  const corr = { op_id: L.uuid(), payment_id: String(q2), action: 'remove', expected: { amount: 900, day: '2026-10-08', staff_id: bina }, reason: 'entered twice', cash_not_given: true };
  a = await rpc(T, 'staff_payment_correct', Object.assign({}, corr, { expected: { amount: 901, day: '2026-10-08', staff_id: bina } }));
  check('R1 correction refused when the payment no longer matches what the phone saw', a.ok === false && a.error === 'payment changed', a);
  a = await rpc(T, 'staff_payment_correct', corr);
  check('R2 mistaken entry removed and kept in the correction record', a.ok && sql(`select count(*) from staff_payment where legacy_id = '${q2}'`) === '0'
        && sql(`select reason from staff_payment_void where legacy_id = '${q2}'`) === 'entered twice', a);
  a = await rpc(T, 'staff_payment_correct', corr);
  check('R3 delayed retry of the same correction -> replayed', a.replayed === true, a);
  a = await rpc(T, 'staff_payment_correct', Object.assign({}, corr, { op_id: L.uuid(), action: 'change', new: { amount: 900 } }));
  check('R4 a later correction of the removed payment cannot recreate it', a.ok === false && a.error === 'already removed' && sql(`select count(*) from staff_payment where legacy_id = '${q2}'`) === '0', a);
  await L.upsert(T, 'staff_payment', [L.payRow({ id: q2, staff: bina, amount: 900, date: L.istTs('2026-10-08') })]);
  check('R5 Restore / a queued save cannot bring the removed payment back', sql(`select count(*) from staff_payment where legacy_id = '${q2}'`) === '0');
  await L.upsert(T, 'staff_payment', [L.payRow({ id: 1760000000399, staff: bina, amount: 900, date: L.istTs('2026-10-08') })]);
  check('R6 a genuine new payment with a new identity is accepted', amt(1760000000399) === 900);
  a = await rpc(T, 'staff_payment_correct', { op_id: L.uuid(), payment_id: String(q1), action: 'change', expected: { amount: 700, day: '2026-10-07', staff_id: bina }, new: { amount: 650 }, reason: 'counted wrong' });
  check('R7 controlled amount change works (700 -> 650)', a.ok && amt(q1) === 650, a);
  a = await rpc(T, 'staff_payment_correct', { op_id: L.uuid(), payment_id: sonuPay1, action: 'remove', expected: { amount: 2500, day: '2026-10-11', staff_id: sonu }, reason: 'x', cash_not_given: true });
  check('R8 settlement payments are corrected only through the settlement screen', a.ok === false && /settlement/.test(a.error), a);

  // ===================================================================== S  unlinked payments fail safe
  const uma = L.emp({ name: 'Uma', rate: 300, ob: 0, obDate: '2026-10-04', legacy: 'stf_uma' });
  L.attRange(uma, '2026-10-05', 'PPPPPPP');
  await L.upsert(T, 'staff_payment', [L.payRow({ id: 1760000000501, staff: null, staffLegacy: 'stf_uma', amount: 400, date: L.istTs('2026-10-06') })]);
  r = await rpc(T, 'staff_workshop_report', { staff_id: uma, to: '2026-10-11' });
  check('S1 offline-created payment with only the stable worker reference is linked and counted', sid(1760000000501) === uma && n(r.paid_total) === 400 && r.withheld.length === 0, r);
  await L.upsert(T, 'staff_payment', [L.payRow({ id: 1760000000502, staff: null, name: 'Uma', amount: 600, date: L.istTs('2026-10-07') })]);   // old phone: no link at all
  r = await rpc(T, 'staff_workshop_report', { staff_id: uma, to: '2026-10-11' });
  check('S2 payment with no worker link: balance withheld (not guessed by name)', r.withheld.some(x => /no recorded worker/.test(x)), r.withheld);
  sql(`update staff_employee set name = 'Uma Rani' where id = '${uma}'`);
  r = await rpc(T, 'staff_workshop_report', { staff_id: uma, to: '2026-10-11' });
  check('S3 after renaming the worker it is still withheld', r.withheld.some(x => /no recorded worker/.test(x)), r.withheld);
  r = await rpc(T, 'staff_workshop_report', { staff_id: sonu, to: '2026-10-11' });
  check('S4 every workshop balance that it could affect is withheld (Sonu too)', r.withheld.some(x => /no recorded worker/.test(x)), r.withheld);
  a = await rpc(T, 'staff_settlement_apply', await settle(uma, '2026-10-05', { cash: 0 }));
  check('S5 settlement refused while it is unresolved', a.ok === false && a.error === 'balance withheld', a);
  await L.del(T, 'staff_payment', ['1760000000502']);
  check('S6 an ordinary delete cannot make it disappear', sql(`select count(*) from staff_payment where legacy_id = '1760000000502'`) === '1');
  a = await rpc(T, 'staff_payment_correct', { op_id: L.uuid(), payment_id: '1760000000502', action: 'assign', expected: { amount: 600, day: '2026-10-07', staff_id: null }, new: { staff_id: uma }, reason: 'owner confirmed it was Uma' });
  r = await rpc(T, 'staff_workshop_report', { staff_id: uma, to: '2026-10-11' });
  // 7 x 300 = 2100; paid 400 + 600 = 1000 -> balance 1100
  check('S7 owner explicitly assigns it -> counted once, balance 2100 - 1000 = 1100', a.ok && r.withheld.length === 0 && n(r.balance) === 1100, { a, r: r.withheld, b: r.balance });

  // ===================================================================== T  more than 1,000 records
  L.reset(); L.setToday('2026-10-11');
  const big = L.emp({ name: 'Big', rate: 100, ob: 0, obDate: '2026-01-04' });   // Sun 4 Jan 2026
  // 280 days of attendance 5 Jan .. 11 Oct, all Present: 280 x 100 = 28000
  sql(`insert into staff_attendance (owner_id, legacy_id, staff_id, name, status, date, month_key, day_key)
       select '${OWNER}', 'b' || g, '${big}', 'Big', 'Present', d, to_char(d, 'YYYY-MM'), to_char(d, 'YYYY-MM-DD')
         from generate_series(date '2026-01-05', date '2026-10-11', interval '1 day') with ordinality as t(d, g)`);
  // 1,200 payments of 10 = 12000, spread 5 Jan .. 11 Oct
  sql(`insert into staff_payment (owner_id, legacy_id, staff_id, name, amount, date, month_key)
       select '${OWNER}', 'bp' || g, '${big}', 'Big', 10, (date '2026-01-05' + (g % 280)) + time '12:00', '2026-01'
         from generate_series(1, 1200) g`);
  r = await rpc(T, 'staff_workshop_report', { staff_id: big, to: '2026-10-11' });
  check('T1 report is exact past 1,000 rows: earned 28000, paid 12000, balance 16000', n(r.earned_total) === 28000 && n(r.paid_total) === 12000 && n(r.balance) === 16000, { e: r.earned_total, p: r.paid_total });
  const capped = await L.call(T, 'GET', '/staff_payment?select=legacy_id');
  check('T2 (the ordinary download really stops at 1,000 rows)', Array.isArray(capped.json) && capped.json.length === 1000, capped.json.length);
  const tot = await rpc(T, 'staff_workshop_payments', { from: '2026-01-01', to: '2026-10-31' });
  check('T3 complete totals for History/Summary: 1,200 payments, 12000', n(tot.count) === 1200 && n(tot.total) === 12000 && n(tot.workers[0].total) === 12000, tot);
  const oct = await rpc(T, 'staff_workshop_payments', { from: '2026-10-01', to: '2026-10-31' });
  // days 5 Jan + (g % 280) in Oct: day index 269..279 (11 days, 1..11 Oct); g%280 in 269..279 -> g in {269..279, 549..559, 829..839, 1109..1119} = 44 payments
  check('T4 month total from the database: 44 October payments = 440', n(oct.count) === 44 && n(oct.total) === 440, oct);

  // ===================================================================== W  month cutoff
  L.setToday('2026-11-01');
  const wm = L.emp({ name: 'Month', rate: 100, ob: 0, obDate: '2026-10-25' });
  L.attRange(wm, '2026-10-26', 'PPPPPPP');                 // Mon 26 Oct .. Sun 1 Nov
  await L.upsert(T, 'staff_payment', [L.payRow({ id: 1760000000601, staff: wm, amount: 150, date: L.istTs('2026-10-30') }),
                                      L.payRow({ id: 1760000000602, staff: wm, amount: 70, date: L.istTs('2026-11-01') })]);
  r = await rpc(T, 'staff_workshop_report', { staff_id: wm, to: '2026-10-31', from: '2026-10-01' });
  // Oct: 26..31 = 6 days x 100 = 600; paid 150 -> balance 450; 1 Nov excluded
  check('W1 Payroll cutoff 31 Oct: earned 600, paid 150, balance 450 (1 Nov excluded)', n(r.period.earned) === 600 && n(r.period.paid) === 150 && n(r.balance) === 450 && n(r.period.brought_forward) === 0, r.period);
  r = await rpc(T, 'staff_workshop_report', { staff_id: wm, to: '2026-11-30', from: '2026-11-01' });
  // Nov: 1 day x 100 = 100, paid 70; brought forward 450 -> balance 480
  check('W2 November: brought forward 450 + 100 - 70 = 480', n(r.period.brought_forward) === 450 && n(r.period.earned) === 100 && n(r.period.paid) === 70 && n(r.balance) === 480, r.period);

  // ===================================================================== U  who may call
  L.setToday('2026-10-11');
  r = await rpc(T2, 'staff_workshop_report', { staff_id: big, to: '2026-10-11' });
  check('U1 another signed-in owner gets "not found" for my worker', r.ok === false && r.error === 'not found', r);
  a = await rpc(T2, 'staff_settlement_apply', { op_id: L.uuid(), action: 'settle', staff_id: big, week: '2026-10-05', cash: 1, seen: {}, sunday_done: true, advances_complete: true });
  check('U2 another owner cannot settle my worker', a.ok === false && a.error === 'not found', a);
  for (const fn of ['staff_workshop_report', 'staff_settlement_apply', 'staff_workshop_terms_set', 'staff_payment_correct', 'staff_workshop_payments', 'staff_d3_op_status']) {
    const u = await L.call(null, 'POST', '/rpc/' + fn, { p: {} });
    check('U3 unsigned call refused: ' + fn, u.status === 401 || u.status === 403, u.status);
  }
  const hidden = await L.call(T, 'POST', '/rpc/calc', { p_owner: OWNER, p_staff: big, p_to: '2026-10-11' });
  check('U4 internal helpers are not reachable through the API', hidden.status === 404, hidden.status);
  const otherOps = await L.call(T2, 'GET', '/staff_d3_op?select=op_id');
  check('U5 another owner reads none of my operation log', Array.isArray(otherOps.json) && otherOps.json.length === 0, otherOps.json);

  // ===================================================================== V  one snapshot; changes during settlement
  L.reset(); L.setToday('2026-10-11');
  const vv = L.emp({ name: 'Vik', rate: 1000, ob: 0, obDate: '2026-10-04' });
  L.attRange(vv, '2026-10-05', 'PPPPPPP');
  // make the report pause inside its first read; a payment committed during the pause
  sql(`create or replace function staffpay_d3.today() returns date language sql stable as $$ select pg_sleep(1.0); select '2026-10-11'::date $$`);
  const slow = rpc(T, 'staff_workshop_report', { staff_id: vv, to: '2026-10-11' });
  await new Promise(res => setTimeout(res, 300));
  await L.upsert(T, 'staff_payment', [L.payRow({ id: 1760000000701, staff: vv, amount: 1234, date: L.istTs('2026-10-08') })]);
  r = await slow;
  check('V1 a report is one consistent moment: a payment committed mid-report is not half-counted', n(r.paid_total) === 0 && n(r.balance) === 7000
        && wk(r, '2026-10-05').advances.length === 0, { p: r.paid_total, b: r.balance });
  L.setToday('2026-10-11');
  r = await rpc(T, 'staff_workshop_report', { staff_id: vv, to: '2026-10-11' });
  check('V2 ...and the next report counts it (7000 - 1234 = 5766)', n(r.balance) === 5766, r.balance);
  // a phone that saw the figures BEFORE an advance arrived: refused, never settled on stale figures
  const pv0 = await settle(vv, '2026-10-05', { cash: 5766 });
  await L.upsert(T, 'staff_payment', [L.payRow({ id: 1760000000700, staff: vv, amount: 6, date: L.istTs('2026-10-09') })]);
  a = await rpc(T, 'staff_settlement_apply', pv0);
  check('V3 advance saved after the phone read the figures -> "figures changed", nothing written', a.ok === false && a.error === 'figures changed'
        && payCount('stl_' + vv + '%') === 0, a);
  // an advance sent WHILE the settlement runs waits for it (the settlement holds the worker row;
  // the payment's worker link must lock that row too), then lands after it and is shown
  const pv = await settle(vv, '2026-10-05', { cash: 5760 });          // 7000 - 1234 - 6 = 5760
  sql(`create or replace function staffpay_d3.today() returns date language sql stable as $$ select pg_sleep(1.0); select '2026-10-11'::date $$`);
  const slowSettle = rpc(T, 'staff_settlement_apply', pv);
  await new Promise(res => setTimeout(res, 300));
  const t0 = Date.now();
  await L.upsert(T, 'staff_payment', [L.payRow({ id: 1760000000702, staff: vv, amount: 66, date: L.istTs('2026-10-09') })]);
  const waited = Date.now() - t0;
  a = await slowSettle;
  L.setToday('2026-10-11');
  const sv = stlRow(vv, '2026-10-05');
  check('V4 a concurrent advance waits for the running settlement (serialised, ~1s)', a.ok && waited > 500
        && !sv.detail.advance_ids.includes('1760000000702'), { a, waited });
  await L.upsert(T, 'staff_payment', [L.payRow({ id: 1760000000703, staff: vv, amount: 40, date: L.istTs('2026-10-10') })]);
  sql(`update staff_attendance set status = 'Half-Day' where staff_id = '${vv}' and day_key = '2026-10-10'`);
  r = await rpc(T, 'staff_workshop_report', { staff_id: vv, to: '2026-10-11' });
  w = wk(r, '2026-10-05');
  // now: earned 6 x 1000 + 0.5 x 1000 = 6500; advances 1234 + 6 + 66 + 40 = 1346; settlement 5760
  // closing 0 + 6500 - 1346 - 5760 = -606
  const after = w.added_after_settlement.map(x => n(x.amount)).sort((x, y) => x - y);
  check('V5 changes after settlement are shown, not hidden (66 and 40; Sat Present -> Half-Day)', JSON.stringify(after) === '[40,66]'
        && w.attendance_changed_after_settlement.length === 1 && w.attendance_changed_after_settlement[0].was === 'Present'
        && w.attendance_changed_after_settlement[0].now === 'Half-Day' && n(w.closing) === -606, w);

  console.log('\n' + L.PASS.length + ' passed, ' + L.FAIL.length + ' failed - D3 database/API');
  process.exit(L.FAIL.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
