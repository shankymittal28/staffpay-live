/*
 * N1 database + API acceptance tests: weekly settlements in order (R1 + R2).
 *
 * Same disposable PostgreSQL + PostgREST as the D3 tests (env.sh applies
 * sql/d3_settlement_order_v1.sql on top of D3). Every call goes through
 * PostgREST with a Supabase-style token. Rupee amounts are worked out by hand
 * in the comments and written as literals.
 *
 *   test_d3/env.sh up && node test_d3/test_n1_db.js
 *
 * Common setup unless a case says otherwise: Rs 500/day, Old Hisab Rs 0 at the
 * end of Sun 4 Oct 2026. W1 = 5-11 Oct, W2 = 12-18 Oct, W3 = 19-25 Oct; a full
 * Present week earns 7 x 500 = 3,500.
 */
const L = require('./lib.js'), { check, rpc, sql, OWNER } = L;
const T = L.token(OWNER);
const n = x => x == null ? x : Number(x);
L.addDays = (d, k) => new Date(new Date(d + 'T00:00:00Z').getTime() + k * 864e5).toISOString().slice(0, 10);
const W1 = '2026-10-05', W2 = '2026-10-12', W3 = '2026-10-19';
const wk = (r, monday) => (r.weeks || []).find(w => w.monday === monday);
const seenOf = w => ({ days: n(w.days_worked), rate: n(w.rate), earned: n(w.earned), previous: n(w.previous), advances: n(w.advances_total) });
const report = (staff, to) => rpc(T, 'staff_workshop_report', { staff_id: staff, to });
async function payload(staff, monday, action, extra) {
  const r = await report(staff, L.addDays(monday, 6)), w = wk(r, monday);
  return Object.assign({ op_id: L.uuid(), action, staff_id: staff, week: monday,
    expected_version: w && w.settlement ? w.settlement.version : null,
    cash: 0, seen: w ? seenOf(w) : null, sunday_done: true, advances_complete: true }, extra || {});
}
const apply = p => rpc(T, 'staff_settlement_apply', p);
const settle = async (staff, monday, cash) => apply(await payload(staff, monday, 'settle', { cash }));
const correct = async (staff, monday) => apply(await payload(staff, monday, 'correct', { reason: 'entered by mistake', cash_not_given: true }));
const stlPaid = staff => n(sql(`select coalesce(sum(amount), 0) from staff_payment where legacy_id like 'stl\\_${staff}\\_%'`));
const allPaid = staff => n(sql(`select coalesce(sum(amount), 0) from staff_payment where staff_id = '${staff}'`));
const worker = (name, o) => L.emp(Object.assign({ name, rate: 500, ob: 0, obDate: '2026-10-04' }, o || {}));

(async () => {
  L.reset();

  // ============================================================ A  the reproduced N1 case
  L.setToday('2026-10-18');
  const ajay = worker('Ajay'); L.attRange(ajay, W1, 'PPPPPPPPPPPPPP');
  let a = await settle(ajay, W2, 7000);
  check('A1 W2 (7,000 = carried 3,500 + 3,500) refused while W1 has no record: "settle 5 Oct first"',
    a.ok === false && a.error === 'earlier week not settled' && a.week === W1 && /Settle the week of 05 Oct first/.test(a.message), a);
  check('A2 the refusal wrote no money', stlPaid(ajay) === 0, stlPaid(ajay));
  a = await settle(ajay, W1, 0);
  let r = await report(ajay, '2026-10-11');
  check('A3 W1 closed with Rs 0: no payment, balance at end of 11 Oct still 3,500 owed', a.ok === true && stlPaid(ajay) === 0
    && n(wk(r, W1).closing) === 3500 && wk(r, W1).settlement.state === 'settled', { a, w: wk(r, W1) });
  a = await settle(ajay, W2, 7000);
  r = await report(ajay, '2026-10-18');
  check('A4 W2 then settles 7,000; balance 0; latest_settled_week = 12 Oct', a.ok === true && n(r.balance) === 0 && r.latest_settled_week === W2, r.balance);
  a = await settle(ajay, W1, 3500);
  check('A5 W1 again: "already settled" (no second payment); paid 7,000 = earned 7,000', a.ok === false && a.error === 'already settled' && stlPaid(ajay) === 7000, a);

  // ============================================================ B  later settlement with partial cash
  const bablu = worker('Bablu'); L.attRange(bablu, W1, 'PPPPPPPPPPPPPP');
  await settle(bablu, W1, 0); a = await settle(bablu, W2, 1000);
  r = await report(bablu, '2026-10-18');
  // W2: before cash 3,500 + 3,500 - 0 = 7,000; cash 1,000; balance 6,000 owed
  check('B1 W2 cash 1,000: previous 3,500, settlement cash 1,000, balance at end of 18 Oct 6,000 owed',
    a.ok === true && n(wk(r, W2).previous) === 3500 && n(wk(r, W2).settlement_cash) === 1000 && n(wk(r, W2).closing) === 6000 && n(r.balance) === 6000, wk(r, W2));

  // ============================================================ C  later settlement with zero cash
  const chotu = worker('Chotu'); L.attRange(chotu, W1, 'PPPPPPPPPPPPPP');
  await settle(chotu, W1, 0); a = await settle(chotu, W2, 0);
  r = await report(chotu, '2026-10-18');
  check('C1 W1 Rs 0 + W2 Rs 0: both settled with cash 0, no settlement payment, balance 7,000 owed',
    a.ok === true && stlPaid(chotu) === 0 && n(wk(r, W2).closing) === 7000 && n(r.balance) === 7000
    && sql(`select string_agg(state || ':' || cash_paid::int, ',' order by week_key) from staff_settlement where staff_id = '${chotu}'`) === 'settled:0,settled:0', r.balance);

  // ============================================================ D  partial first week after a mid-week Old Hisab
  // Old Hisab +1,000 at the end of Wed 7 Oct (register date). W1 counts Thu 8 - Sun 11: 4 x 500 = 2,000.
  const dinesh = worker('Dinesh', { ob: 1000, obDate: '2026-10-07' });
  L.attRange(dinesh, '2026-10-05', 'PPPPPPPPPPPPPP');     // Mon-Wed 5-7 Oct are history
  r = await report(dinesh, '2026-10-11');
  check('D1 partial W1 from Thu 8 Oct: 4 days, earned 2,000, previous (Old Hisab) 1,000',
    wk(r, W1).from === '2026-10-08' && n(wk(r, W1).days_worked) === 4 && n(wk(r, W1).earned) === 2000 && n(wk(r, W1).previous) === 1000, wk(r, W1));
  a = await settle(dinesh, W2, 6500);
  check('D2 W2 refused before the partial W1: week 5 Oct', a.ok === false && a.error === 'earlier week not settled' && a.week === W1, a);
  a = await apply({ op_id: L.uuid(), action: 'settle', staff_id: dinesh, week: '2026-09-28', cash: 0, seen: {}, sunday_done: true, advances_complete: true });
  check('D3 week of 28 Sep (Sunday 4 Oct, before the Old Hisab date) refused as before', a.ok === false && a.error === 'this week is before the Old Hisab date', a);
  a = await settle(dinesh, W1, 3000);
  const a2 = await settle(dinesh, W2, 3500);
  r = await report(dinesh, '2026-10-18');
  // paid 3,000 + 3,500 = 6,500 = Old Hisab 1,000 + 2,000 + 3,500
  check('D4 W1 3,000 then W2 3,500: balance 0, paid 6,500', a.ok && a2.ok && n(wk(r, W1).closing) === 0 && n(r.balance) === 0 && stlPaid(dinesh) === 6500, { a, a2, b: r.balance });

  // ============================================================ E  zero-cash advance week and an absent week
  L.setToday('2026-10-25');
  const eshwar = worker('Eshwar'); L.attRange(eshwar, W1, 'PPPPPPP' + 'AAAAAAA' + 'PPPPPPP');
  await L.upsert(T, 'staff_payment', [L.payRow({ id: 1760100000001, staff: eshwar, amount: 3500, date: L.istTs('2026-10-07') })]);
  a = await settle(eshwar, W1, 0);
  r = await report(eshwar, '2026-10-11');
  check('E1 W1: 3,500 earned - 3,500 advance = 0; closed with Rs 0', a.ok === true && n(wk(r, W1).closing) === 0, wk(r, W1));
  a = await settle(eshwar, W3, 3500);
  check('E2 W3 refused while the absent W2 has no record (week 12 Oct)', a.ok === false && a.error === 'earlier week not settled' && a.week === W2, a);
  a = await settle(eshwar, W2, 0);
  const e3 = await settle(eshwar, W3, 3500);
  r = await report(eshwar, '2026-10-25');
  check('E3 absent W2 (earned 0) closed with Rs 0, then W3 3,500: balance 0', a.ok && e3.ok && n(wk(r, W2).earned) === 0 && n(r.balance) === 0, { a, e3 });

  // ============================================================ F  rate change: no permanent block, no repricing
  L.setToday('2026-10-18');
  const firoz = worker('Firoz'); L.attRange(firoz, W1, 'PPPPPPPPPPPPPP');
  a = await settle(firoz, W2, 7000);
  check('F1 skip W1 -> W2 refused', a.ok === false && a.error === 'earlier week not settled', a);
  r = await report(firoz, '2026-10-18');
  a = await rpc(T, 'staff_workshop_terms_set', { op_id: L.uuid(), staff_id: firoz, expected_terms_version: r.worker.terms_version, set: { salary: 600 } });
  check('F2 rate change on Sun 18 Oct refused by the existing rule (days from 5 Oct not in a settled week)',
    a.ok === false && a.error === 'rate change not allowed yet' && /2026-10-05/.test(a.message), a);
  await settle(firoz, W1, 0); a = await settle(firoz, W2, 1000);
  r = await report(firoz, '2026-10-18');
  a = await rpc(T, 'staff_workshop_terms_set', { op_id: L.uuid(), staff_id: firoz, expected_terms_version: r.worker.terms_version, set: { salary: 600 } });
  check('F3 after W1 Rs 0 + W2 1,000 the same rate change on Sun 18 Oct succeeds (no permanent block)', a.ok === true && n(a.salary) === 600, a);
  L.setToday('2026-10-19'); L.att(firoz, '2026-10-19', 'P');
  r = await report(firoz, '2026-10-19');
  // W1 3,500 + W2 3,500 (both frozen at 500) + Mon 19 Oct 600 - 1,000 paid = 6,600
  check('F4 W1 and W2 stay 7 x 500 = 3,500 (frozen); Mon 19 Oct earns 600; balance 6,600',
    n(wk(r, W1).earned) === 3500 && wk(r, W1).rate_frozen && n(wk(r, W2).earned) === 3500 && wk(r, W2).rate_frozen
    && n(wk(r, W3).earned) === 600 && n(r.balance) === 6600, { w1: wk(r, W1), b: r.balance });
  a = await apply(await payload(firoz, W1, 'change', { cash: 500 }));
  r = await report(firoz, '2026-10-19');
  // "Change amount" on W1 after W2 is settled stays allowed; W1 still earns 3,500; balance 6,600 - 500 = 6,100
  check('F5 "Change amount" W1 to 500 after W2 is settled: allowed, W1 still 3,500, balance 6,100',
    a.ok === true && n(wk(r, W1).earned) === 3500 && n(wk(r, W1).rate) === 500 && n(r.balance) === 6100, { a, b: r.balance });

  // ============================================================ G  corrected records
  L.setToday('2026-10-18');
  const ganesh = worker('Ganesh'); L.attRange(ganesh, W1, 'PPPPPPPPPPPPPP');
  await settle(ganesh, W1, 3500); await settle(ganesh, W2, 3500);
  a = await correct(ganesh, W1);
  r = await report(ganesh, '2026-10-18');
  const void1 = L.sqlJson(`select json_build_object('n', count(*), 'amt', sum((original ->> 'amount')::numeric)) from staff_payment_void where staff_id = '${ganesh}'`);
  check('G1 correcting W1 after W2 is settled is allowed: its 3,500 payment voided with a kept record',
    a.ok === true && a.state === 'corrected' && void1.n === 1 && n(void1.amt) === 3500, { a, void1 });
  check('G2 W2 shows the truth: balance at end of 18 Oct 3,500 owed (W1 frozen at 500)', n(wk(r, W2).closing) === 3500 && n(wk(r, W1).rate) === 500 && wk(r, W1).rate_frozen, wk(r, W2));
  a = await settle(ganesh, W1, 3500);
  check('G3 settling W1 again is refused: "later week settled" (12 Oct)', a.ok === false && a.error === 'later week settled' && a.later_week === W2
    && /already settled and carried this week's balance/.test(a.message), a);
  L.setToday('2026-10-25'); L.attRange(ganesh, W3, 'PPPPPPP');
  a = await settle(ganesh, W3, 7000);
  r = await report(ganesh, '2026-10-25');
  // corrected W1 counts as a record for R1; W3 carries 3,500 + earns 3,500; paid 3,500 (W2) + 7,000 = 10,500 = earned 10,500
  check('G4 W3 settles 7,000 (corrected W1 counts as a record); balance 0; paid 10,500 = earned', a.ok === true && n(wk(r, W3).previous) === 3500 && n(r.balance) === 0 && stlPaid(ganesh) === 10500, { a, b: r.balance });

  L.setToday('2026-10-18');
  const gopal = worker('Gopal'); L.attRange(gopal, W1, 'PPPPPPPPPPPPPP');
  await settle(gopal, W1, 3500); await correct(gopal, W1);
  a = await settle(gopal, W2, 7000);
  check('G5 W1 settled then corrected: W2 may settle 7,000 carrying the 3,500', a.ok === true, a);
  a = await settle(gopal, W1, 3500);
  check('G6 then W1 again is refused (R2); paid 7,000 = earned 7,000', a.ok === false && a.error === 'later week settled' && stlPaid(gopal) === 7000, { a, paid: stlPaid(gopal) });

  const hari = worker('Hari'); L.attRange(hari, W1, 'PPPPPPPPPPPPPP');
  await settle(hari, W1, 3500); await correct(hari, W1);
  a = await settle(hari, W1, 3000);
  check('G7 corrected W1 with no later settlement may be settled again (existing "Settle again")', a.ok === true && a.version === 3 && stlPaid(hari) === 3000, a);

  // the truthful path when the correction itself was wrong: cash really given Sun 11 Oct, entered later, dated that Sunday
  const ishaan = worker('Ishaan'); L.attRange(ishaan, W1, 'PPPPPPPPPPPPPP');
  await settle(ishaan, W1, 3500); await settle(ishaan, W2, 3500); await correct(ishaan, W1);
  let up = await L.upsert(T, 'staff_payment', [L.payRow({ id: 1760100000101, staff: ishaan, amount: 3500, date: L.istTs('2026-10-11', '20:00') })]);
  r = await report(ishaan, '2026-10-18');
  check('G8 W1 corrected after W2: a payment of 3,500 dated Sun 11 Oct is recorded through the ordinary API; balance 0',
    up.status === 201 && n(wk(r, W1).advances_total) === 3500 && n(r.balance) === 0, { status: up.status, body: up.json, b: r.balance });

  // ============================================================ H  two phones at the same time
  let worst = 0, outcomes = [];
  for (let i = 0; i < 6; i++) {
    const s = worker('Twin' + i); L.attRange(s, W1, 'PPPPPPPPPPPPPP');
    const pA = await payload(s, W1, 'settle', { cash: 3500 }), pB = await payload(s, W2, 'settle', { cash: 7000 });   // B's page still thinks W1 is open
    const [ra, rb] = await Promise.all([apply(pA), apply(pB)]);
    outcomes.push((ra.ok ? 'A' : ra.error) + '|' + (rb.ok ? 'B' : rb.error));
    worst = Math.max(worst, stlPaid(s));
  }
  console.log('     H1 orders seen: ' + outcomes.join(', '));
  // A first: B's figures are stale ('figures changed'); B first: R1 refuses B. Either way only W1's 3,500 is paid.
  check('H1 W1 (3,500) and W2 (7,000) at once, 6 runs: never both; at most 7,000 paid each time',
    worst <= 7000 && outcomes.every(o => o === 'A|figures changed' || o === 'A|earlier week not settled'), outcomes);
  let worst2 = 0, out2 = [];
  for (let i = 0; i < 4; i++) {
    const s = worker('Pair' + i); L.attRange(s, W1, 'PPPPPPPPPPPPPP');
    await settle(s, W1, 3500);
    const pC = await payload(s, W1, 'correct', { reason: 'mistake', cash_not_given: true }), pW = await payload(s, W2, 'settle', { cash: 3500 });
    const [rc, rw] = await Promise.all([apply(pC), apply(pW)]);
    const again = await settle(s, W1, 3500);
    out2.push((rc.ok ? 'C' : rc.error) + '|' + (rw.ok ? 'W2' : rw.error) + '|' + (again.ok ? 'W1again' : again.error));
    worst2 = Math.max(worst2, stlPaid(s));
  }
  console.log('     H2 orders seen: ' + out2.join(', '));
  check('H2 "correct W1" racing "settle W2", then W1 again: never more than earned 7,000', worst2 <= 7000 && out2.every(o => !/W1again/.test(o) || !/\|W2\|/.test(o)), out2);

  // H3: force the other order. A database session holds the worker's lock; W2 (B)
  // queues first, W1 (A) second; when the lock is released B runs before A.
  const holdLock = (staff, ms) => new Promise(res => {
    const c = require('child_process').spawn('psql', ['-h', process.env.PGHOST || '/tmp', '-p', process.env.PGPORT || '54329', '-U', 'postgres', '-d', process.env.D3_DB || 'd3test', '-q', '-c',
      `begin; select pg_advisory_xact_lock(hashtext('staffpay-d3'), hashtext('${staff}')); select pg_sleep(${ms / 1000}); commit;`]);
    c.on('exit', res);
  });
  const out3 = [];
  for (let i = 0; i < 3; i++) {
    const s = worker('Order' + i); L.attRange(s, W1, 'PPPPPPPPPPPPPP');
    const pA = await payload(s, W1, 'settle', { cash: 3500 }), pB = await payload(s, W2, 'settle', { cash: 7000 });
    const held = holdLock(s, 1500); await new Promise(r => setTimeout(r, 300));
    const fb = apply(pB); await new Promise(r => setTimeout(r, 300));
    const fa = apply(pA);
    const [rb, ra] = await Promise.all([fb, fa]); await held;
    out3.push((rb.ok ? 'B' : rb.error) + '|' + (ra.ok ? 'A' : ra.error) + '|paid ' + stlPaid(s));
  }
  console.log('     H3 orders seen: ' + out3.join(', '));
  check('H3 W2 forced to run first: refused (R1), then W1 3,500 succeeds; never 10,500', out3.every(o => o === 'earlier week not settled|A|paid 3500'), out3);

  // ============================================================ I  lost replies and retries
  const imran = worker('Imran'); L.attRange(imran, W1, 'PPPPPPPPPPPPPP');
  const p1 = await payload(imran, W1, 'settle', { cash: 3500 });
  const first = await apply(p1);                                 // pretend this reply was lost
  await settle(imran, W2, 3500);
  const replay = await apply(p1);
  check('I1 retry of the completed W1 settle after W2 is settled returns the saved result; one payment only',
    first.ok && replay.ok === true && replay.version === 1 && replay.payment_id === first.payment_id
    && n(sql(`select count(*) from staff_payment where legacy_id like 'stl\\_${imran}\\_2026-10-05%'`)) === 1, { first, replay });
  const jatin = worker('Jatin'); L.attRange(jatin, W1, 'PPPPPPPPPPPPPP');
  const pW2 = await payload(jatin, W2, 'settle', { cash: 7000 });
  a = await apply(pW2);
  const st = await rpc(T, 'staff_d3_op_status', { op_id: pW2.op_id });
  check('I2 a refused request writes nothing and is not logged (status: not found)', a.ok === false && st.ok && st.found === false && stlPaid(jatin) === 0, { a, st });
  await settle(jatin, W1, 0);
  a = await apply(pW2);                                          // the same request sent again later
  check('I3 the same request sent again after W1 is closed is checked fresh and now succeeds once', a.ok === true && stlPaid(jatin) === 7000
    && (await apply(pW2)).payment_id === a.payment_id && stlPaid(jatin) === 7000, a);

  // ============================================================ J  the date rule
  L.setToday('2026-10-13');                                      // Tuesday
  const lalit = worker('Lalit'); L.attRange(lalit, W1, 'PPPPPPPP');
  a = await settle(lalit, W1, 1000);                             // cash actually given on Sun 11 Oct, entered Tue 13 Oct
  const pd = L.sqlJson(`select json_build_object('day', (date at time zone 'Asia/Kolkata')::date, 'hm', to_char(date at time zone 'Asia/Kolkata', 'HH24:MI'))
                       from staff_payment where legacy_id = '${a.payment_id}'`);
  check('J1 Sunday cash entered on Tuesday is dated Sun 11 Oct (21:00)', a.ok === true && pd.day === '2026-10-11' && pd.hm === '21:00', pd);
  await L.upsert(T, 'staff_payment', [L.payRow({ id: 1760100000201, staff: lalit, amount: 2000, date: L.istTs('2026-10-14') })]);
  L.setToday('2026-10-18'); L.attRange(lalit, '2026-10-13', 'PPPPPP');
  r = await report(lalit, '2026-10-18');
  // W2: previous 3,500 - 1,000 = 2,500; earned 3,500; advance 2,000 (Wed 14 Oct, its real date) -> 4,000
  check('J2 cash given Wed 14 Oct is a payment on its real date: W2 advance 2,000, balance 4,000',
    n(wk(r, W2).advances_total) === 2000 && wk(r, W2).advances[0].day === '2026-10-14' && n(wk(r, W2).closing) === 4000, wk(r, W2));

  // ============================================================ K  report field, other owner
  r = await report(firoz, '2026-10-11');
  check('K1 latest_settled_week is reported even when the report stops at an earlier Sunday', r.latest_settled_week === W2, r.latest_settled_week);
  r = await rpc(L.token(L.OTHER), 'staff_workshop_report', { staff_id: firoz, to: '2026-10-18' });
  check('K2 another owner gets no report and no latest week', r.ok === false && r.latest_settled_week === undefined, r);

  console.log('\n' + L.PASS.length + ' passed, ' + L.FAIL.length + ' failed - N1 database/API');
  process.exit(L.FAIL.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
