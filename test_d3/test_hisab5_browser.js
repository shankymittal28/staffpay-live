/*
 * Five-line worker hisab (Staff Details + WhatsApp, workshop only), on a
 * 390x844 Chromium phone against the disposable database.
 *
 *   test_d3/env.sh up && node test_d3/test_hisab5_browser.js [screenshot-dir]
 *
 * For every case the five lines are checked against hand-calculated amounts,
 * and the last line against the database report's closing balance and the
 * owner's unchanged Weekly Hisab card at the same cutoff. Rate Rs 400/day and
 * Old Hisab Rs 0 at the end of Sun 4 Oct unless stated; W1 = 5-11 Oct,
 * W2 = 12-18 Oct 2026.
 */
const path = require('path');
const { chromium } = require('playwright');
const L = require('./lib.js'), { check, sql, OWNER } = L;
const { phone, txt, serve } = require('./phone.js');
const T = L.token(OWNER), SHOTS = process.argv[2] || null;
const n = x => Number(x);
L.addDays = (d, k) => new Date(new Date(d + 'T00:00:00Z').getTime() + k * 864e5).toISOString().slice(0, 10);
const W1 = '2026-10-05', W2 = '2026-10-12';
const pay = (id, staff, amount, day) => L.payRow({ id, staff, amount, date: L.istTs(day) });

async function apiSettle(staff, monday, cash) {               // set-up only: the same call a phone makes
  const r = await L.rpc(T, 'staff_workshop_report', { staff_id: staff, to: L.addDays(monday, 6) });
  const w = r.weeks.find(x => x.monday === monday);
  return L.rpc(T, 'staff_settlement_apply', { op_id: L.uuid(), action: 'settle', staff_id: staff, week: monday, expected_version: null,
    cash, seen: { days: n(w.days_worked), rate: n(w.rate), earned: n(w.earned), previous: n(w.previous), advances: n(w.advances_total) },
    sunday_done: true, advances_complete: true });
}
// Details for the week holding `day` (Oct), the WhatsApp text, and the owner's Weekly Hisab card for the same week
async function views(page, legacy, day, shot) {
  await page.evaluate(([l, d]) => { viewMonth = new Date(2026, 9, d); openStaffDetail(l); }, [legacy, day]);
  await page.waitForFunction(() => { const el = document.getElementById('d3Detail'); return el && !/Loading/.test(el.innerText); }, null, { timeout: 15000 });
  await page.waitForTimeout(200);
  const det = await txt(page, '#d3Detail');
  if (SHOTS && shot) {
    await page.evaluate(() => window.scrollTo(0, document.getElementById('d3Detail').getBoundingClientRect().top + window.scrollY - 140));
    await page.screenshot({ path: path.join(SHOTS, shot + '.png') });
  }
  const wa = await page.evaluate(l => buildHisabText(l), legacy);
  if (process.env.DUMP) console.log('----- WhatsApp ' + legacy + ' (week of ' + day + ' Oct)\n' + wa);
  await page.evaluate(d => { hisabWeek = new Date(2026, 9, d); switchTab('hisab'); renderHisab(); }, day);
  await page.waitForFunction(l => { const el = document.getElementById('d3h_' + l); return el && !/Loading/.test(el.innerText); }, legacy, { timeout: 15000 });
  const card = await txt(page, '#d3h_' + legacy);
  return { det, wa, card };
}
const lines5 = wa => (wa.match(/^(HAAZRI|IS HAFTE PAYMENT LIYE|IS HAFTE KA HISAB|PICHLA ADVANCE|\*AAJ TAK KA HISAB):.*$/gm) || []);
// the database report for the same week, at the same cutoff the screens use
async function weekReport(staff, monday) {
  const r = await L.rpc(T, 'staff_workshop_report', { staff_id: staff, to: L.addDays(monday, 6) });
  return r.weeks.find(x => x.monday === monday);
}
const closingWords = c => c > 0 ? '₹' + c.toLocaleString('en-IN') + ' — dukaan par baaki' : c < 0 ? '₹' + (-c).toLocaleString('en-IN') + ' — aap par baaki' : '₹0 — hisab barabar';
const cardWords = c => c > 0 ? '₹' + c.toLocaleString('en-IN') + ' — shop owes worker' : c < 0 ? '₹' + (-c).toLocaleString('en-IN') + ' — worker owes shop' : '₹0 — nothing owed either way';

(async () => {
  const srv = await serve(path.join(__dirname, '..'), 8851);
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  try {
    // ================================================================ phase 1: today Sat 10 Oct, not yet marked
    L.reset(); L.setToday('2026-10-10');
    const chandra = L.emp({ name: 'Chandrabhan', rate: 400, ob: 0, obDate: '2026-10-04', legacy: 'stf_chandra' });
    const gopi = L.emp({ name: 'Gopi', rate: 400, ob: 0, obDate: '2026-10-04', legacy: 'stf_gopi' });
    const noob = L.emp({ name: 'Naya', rate: 400, legacy: 'stf_naya' });
    L.attRange(chandra, W1, 'PPAPP');                       // Mon-Fri; Sat 10 Oct (today) not marked
    L.attRange(gopi, W1, 'PP-PP');                          // Wed 7 Oct never marked
    let page = await phone(browser, { port: 8851, now: '2026-10-10T18:00:00+05:30' });
    check('H0 the new build is served (rc12-hisab5-20261010)', /rc12-hisab5-20261010/.test(await page.content()));

    // Chandrabhan: 4 x 400 = 1,600; no payments; previous 0; 0 + 1,600 - 0 = 1,600, cutoff Fri 9 Oct
    let v = await views(page, 'stf_chandra', 7, '1-chandrabhan');
    let w = await weekReport(chandra, W1);
    check('H1 Chandrabhan Details: name and real cutoff, five rows in the approved order',
      /Chandrabhan · Hisab 9 Oct 2026 tak Hafta: 5–11 Oct 2026 HAAZRI 4 din IS HAFTE PAYMENT LIYE ₹0 IS HAFTE KA HISAB 4 × ₹400 = ₹1,600 PICHLA ADVANCE ₹0 AAJ TAK KA HISAB ₹1,600 — dukaan par baaki/.test(v.det)
      && /Today is not marked yet, so today is not counted\./.test(v.det), v.det);
    check('H2 Chandrabhan WhatsApp: the same five lines', lines5(v.wa).join('\n') ===
      'HAAZRI: 4 din\nIS HAFTE PAYMENT LIYE: ₹0\nIS HAFTE KA HISAB: 4 × ₹400 = ₹1,600\nPICHLA ADVANCE: ₹0\n*AAJ TAK KA HISAB: ₹1,600 — dukaan par baaki*'
      && /\*Chandrabhan\* · Hisab 9 Oct 2026 tak\nHafta: 5–11 Oct 2026/.test(v.wa), v.wa);
    check('H3 Chandrabhan: last line = database closing 1,600 at cutoff 9 Oct = owner card "Balance so far (to Fri, 09 Oct)"',
      n(w.closing) === 1600 && w.to === '2026-10-09' && /Balance so far \(to Fri, 09 Oct\) ₹1,600 — shop owes worker/.test(v.card), { w, card: v.card });

    // incomplete data: no amounts at all
    v = await views(page, 'stf_gopi', 7, '6-gopi-incomplete');
    check('H4 unmarked Wed 7 Oct: warning shown, no five rows and no rupee amount (Details and WhatsApp)',
      /Balance withheld: Attendance not marked: 2026-10-07/.test(v.det) && !/HAAZRI|AAJ TAK|₹/.test(v.det)
      && /Balance withheld: Attendance not marked: 2026-10-07/.test(v.wa) && !/HAAZRI|AAJ TAK|₹/.test(v.wa), { det: v.det, wa: v.wa });
    v = await views(page, 'stf_naya', 7);
    check('H5 Old Hisab not entered: existing message, no amounts', /Old Hisab not entered/.test(v.det) && !/₹/.test(v.det) && !/₹/.test(v.wa), v.det);
    check('H6 no page errors (phase 1)', page.errors.length === 0, page.errors);
    await page.close();

    // ================================================================ phase 2: today Sun 18 Oct
    L.setToday('2026-10-18');
    // Ravi: previous positive, half-day, two advances
    //   W1 7 x 400 = 2,800 unpaid -> previous 2,800; W2 PPHPPPA = 5 + 0.5 = 5.5 days -> 5.5 x 400 = 2,200
    //   advances 13 Oct 500 + 15 Oct 700 = 1,200; 2,800 + 2,200 - 1,200 = 3,800
    const ravi = L.emp({ name: 'Ravi', rate: 400, ob: 0, obDate: '2026-10-04', legacy: 'stf_ravi' });
    L.attRange(ravi, W1, 'PPPPPPP' + 'PPHPPPA');
    // Mohan: Old Hisab -1,000 (worker owes); W1 7 x 400 = 2,800, advance 9 Oct 3,000 -> -1,000 + 2,800 - 3,000 = -1,200
    //   W1 closed with Rs 0; W2 7 x 400 = 2,800; advance 14 Oct 500; settlement Sun 18 Oct 1,000
    //   payments 500 + 1,000 = 1,500; -1,200 + 2,800 - 1,500 = 100
    const mohan = L.emp({ name: 'Mohan', rate: 400, ob: -1000, obDate: '2026-10-04', legacy: 'stf_mohan' });
    L.attRange(mohan, W1, 'P'.repeat(14));
    // Suresh: W1 PPAAAAA = 2 x 400 = 800; advance 7 Oct 2,000 -> 0 + 800 - 2,000 = -1,200 (aap par baaki)
    const suresh = L.emp({ name: 'Suresh', rate: 400, ob: 0, obDate: '2026-10-04', legacy: 'stf_suresh' });
    L.attRange(suresh, W1, 'PPAAAAA');
    // Dinesh: Old Hisab +1,000 at end of Wed 7 Oct; Thu-Sun PHPP = 3.5 days -> 3.5 x 400 = 1,400; 1,000 + 1,400 = 2,400
    const dinesh = L.emp({ name: 'Dinesh', rate: 400, ob: 1000, obDate: '2026-10-07', legacy: 'stf_dinesh' });
    L.attRange(dinesh, W1, 'PPP' + 'PHPP');
    // Kallu: W1 7 x 400 = 2,800 settled 2,800 on Sun 11 Oct -> 0 (hisab barabar)
    const kallu = L.emp({ name: 'Kallu', rate: 400, ob: 0, obDate: '2026-10-04', legacy: 'stf_kallu' });
    L.attRange(kallu, W1, 'PPPPPPP');
    let up = await L.upsert(T, 'staff_payment', [
      pay(1760200000001, ravi, 500, '2026-10-13'), pay(1760200000002, ravi, 700, '2026-10-15'),
      pay(1760200000003, mohan, 3000, '2026-10-09'), pay(1760200000004, mohan, 500, '2026-10-14'),
      pay(1760200000005, suresh, 2000, '2026-10-07')]);
    check('H7 set-up payments saved through the ordinary API', up.status === 201, up);
    const s1 = await apiSettle(mohan, W1, 0), s2 = await apiSettle(mohan, W2, 1000), s3 = await apiSettle(kallu, W1, 2800);
    check('H8 set-up settlements: Mohan W1 Rs 0 and W2 1,000; Kallu W1 2,800', s1.ok && s2.ok && s3.ok, { s1, s2, s3 });
    page = await phone(browser, { port: 8851, now: '2026-10-18T18:00:00+05:30' });

    const cases = [
      { who: 'Ravi', legacy: 'stf_ravi', staff: ravi, monday: W2, day: 14, shot: '2-ravi-halfday-advances', cut: '18 Oct 2026', week: '12–18 Oct 2026',
        rows: ['5½ din', '₹1,200', '5½ × ₹400 = ₹2,200', '₹2,800'], close: 3800 },
      { who: 'Mohan', legacy: 'stf_mohan', staff: mohan, monday: W2, day: 14, shot: '3-mohan-negative-previous-settlement', cut: '18 Oct 2026', week: '12–18 Oct 2026',
        rows: ['7 din', '₹1,500', '7 × ₹400 = ₹2,800', '−₹1,200'], close: 100 },
      { who: 'Mohan', legacy: 'stf_mohan', staff: mohan, monday: W1, day: 7, cut: '11 Oct 2026', week: '5–11 Oct 2026',
        rows: ['7 din', '₹3,000', '7 × ₹400 = ₹2,800', '−₹1,000'], close: -1200 },
      { who: 'Suresh', legacy: 'stf_suresh', staff: suresh, monday: W1, day: 7, shot: '4-suresh-aap-par-baaki', cut: '11 Oct 2026', week: '5–11 Oct 2026',
        rows: ['2 din', '₹2,000', '2 × ₹400 = ₹800', '₹0'], close: -1200 },
      { who: 'Dinesh', legacy: 'stf_dinesh', staff: dinesh, monday: W1, day: 7, shot: '5-dinesh-partial-first-week', cut: '11 Oct 2026', week: '5–11 Oct 2026 · hisab 8 Oct se \\(pehle ka Old Hisab mein\\)',
        rows: ['3½ din', '₹0', '3½ × ₹400 = ₹1,400', '₹1,000'], close: 2400 },
      { who: 'Kallu', legacy: 'stf_kallu', staff: kallu, monday: W1, day: 7, cut: '11 Oct 2026', week: '5–11 Oct 2026',
        rows: ['7 din', '₹2,800', '7 × ₹400 = ₹2,800', '₹0'], close: 0 }
    ];
    const LABELS = ['HAAZRI', 'IS HAFTE PAYMENT LIYE', 'IS HAFTE KA HISAB', 'PICHLA ADVANCE', 'AAJ TAK KA HISAB'];
    for (const c of cases) {
      v = await views(page, c.legacy, c.day, c.shot);
      w = await weekReport(c.staff, c.monday);
      const vals = c.rows.concat(closingWords(c.close));
      const detRe = new RegExp(c.who + ' · Hisab ' + c.cut + ' tak Hafta: ' + c.week + ' ' + LABELS.map((l, i) => l + ' ' + vals[i].replace(/[+()]/g, '\\$&')).join(' '));
      const waWant = LABELS.map((l, i) => (i === 4 ? '*' : '') + l + ': ' + vals[i] + (i === 4 ? '*' : '')).join('\n');
      const tag = c.who + ' ' + c.monday.slice(5);
      check('H9 ' + tag + ' Details five rows: ' + vals.join(' | '), detRe.test(v.det), v.det);
      check('H9 ' + tag + ' WhatsApp five lines identical', lines5(v.wa).join('\n') === waWant && v.wa.includes('Hafta: ' + c.week.replace(/ · hisab (\d+ Oct) se.*$/, ' (hisab $1 se)').replace(/\\/g, '')), v.wa);
      // the formula, then the database and the owner's card, separately
      const formula = n(w.previous) + n(w.earned) - (n(w.advances_total) + n(w.settlement_cash));
      check('H9 ' + tag + ' formula previous + earnings - payments = ' + c.close + ' = database closing; payments = advances + settlement cash',
        formula === c.close && n(w.closing) === c.close && n(w.advances_total) + n(w.settlement_cash) === n(c.rows[1].replace(/[₹,]/g, '')), w);
      check('H9 ' + tag + ' owner Weekly Hisab card (unchanged) shows the same balance', v.card.includes('Balance at end of ' + (c.monday === W1 ? 'Sun, 11 Oct ' : 'Sun, 18 Oct ') + cardWords(c.close)), v.card);
    }
    check('H10 settlement rules untouched: Mohan paid 3,000 + 500 advances and 1,000 settlement cash, nothing else',
      sql(`select string_agg(amount::int::text, ',' order by amount) from staff_payment where staff_id = '${mohan}'`) === '500,1000,3000');
    check('H11 no page errors (phase 2)', page.errors.length === 0, page.errors);
    await page.close();
  } finally { await browser.close(); srv.close(); }
  console.log('\n' + L.PASS.length + ' passed, ' + L.FAIL.length + ' failed - five-line worker hisab');
  process.exit(L.FAIL.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
