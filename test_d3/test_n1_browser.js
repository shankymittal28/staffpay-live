/*
 * N1 phone tests: weekly settlements in order, through the real screens
 * (Weekly Hisab, Details, WhatsApp text) on a 390x844 Chromium phone against
 * the disposable database with sql/d3_settlement_order_v1.sql applied.
 *
 *   test_d3/env.sh up && RC10_DIR=/path/to/rc10-d3-checkout node test_d3/test_n1_browser.js
 *
 * RC10_DIR (optional) is a checkout of the released rc10-d3-20261009 build; it
 * shows what a phone still holding the old page sees when the database refuses.
 * Rs 500/day; Old Hisab Rs 0 at the end of Sun 4 Oct unless stated;
 * W1 = 5-11 Oct, W2 = 12-18 Oct; the phone's clock is Sun 18 Oct, 18:00 IST.
 */
const path = require('path');
const { chromium } = require('playwright');
const L = require('./lib.js'), { check, sql, OWNER } = L;
const { phone, txt, serve } = require('./phone.js');
const T = L.token(OWNER), NOW = '2026-10-18T18:00:00+05:30';
const W1 = '2026-10-05', W2 = '2026-10-12';
const n = x => Number(x);
const stlPaid = staff => n(sql(`select coalesce(sum(amount), 0) from staff_payment where legacy_id like 'stl\\_${staff}\\_%'`));
L.addDays = (d, k) => new Date(new Date(d + 'T00:00:00Z').getTime() + k * 864e5).toISOString().slice(0, 10);

async function apiSettle(staff, monday, action, extra) {         // set-up only: the same call a phone makes
  const r = await L.rpc(T, 'staff_workshop_report', { staff_id: staff, to: L.addDays(monday, 6) });
  const w = r.weeks.find(x => x.monday === monday);
  const p = Object.assign({ op_id: L.uuid(), action, staff_id: staff, week: monday, expected_version: w.settlement ? w.settlement.version : null,
    cash: 0, seen: { days: n(w.days_worked), rate: n(w.rate), earned: n(w.earned), previous: n(w.previous), advances: n(w.advances_total) },
    sunday_done: true, advances_complete: true }, extra || {});
  return L.rpc(T, 'staff_settlement_apply', p);
}
// the Weekly Hisab screen on the week starting `monday` (5 or 12 Oct)
async function hisabWeek(page, legacy, day) {
  await page.evaluate(d => { hisabWeek = new Date(2026, 9, d); switchTab('hisab'); renderHisab(); }, day);
  await page.waitForFunction(l => { const el = document.getElementById('d3h_' + l); return el && !/Loading/.test(el.innerText); }, legacy, { timeout: 15000 });
  return txt(page, '#d3h_' + legacy);
}
async function settleOnPhone(page, legacy, cash, waitFor) {
  await page.fill('#d3c_' + legacy, String(cash));
  await page.check('#d3s_' + legacy); await page.check('#d3a_' + legacy);
  await page.click('#d3h_' + legacy + ' .btn-hisab-settle');
  await page.waitForFunction(([l, re]) => new RegExp(re).test((document.getElementById('d3h_' + l) || {}).innerText || ''), [legacy, waitFor], { timeout: 15000 });
  return txt(page, '#d3h_' + legacy);
}
async function detailsAndWhatsApp(page, legacy, day) {
  await page.evaluate(([l, d]) => { viewMonth = new Date(2026, 9, d); openStaffDetail(l); }, [legacy, day]);
  await page.waitForFunction(() => /Balance at end of/.test((document.getElementById('d3Detail') || {}).innerText || ''), null, { timeout: 15000 });
  const det = await txt(page, '#d3Detail');
  const wa = await page.evaluate(l => buildHisabText(l), legacy);
  await page.evaluate(() => { if (typeof closeStaffDetail === 'function') closeStaffDetail(); });
  return { det, wa };
}

(async () => {
  const s11 = await serve(path.join(__dirname, '..'), 8841);
  const s10 = process.env.RC10_DIR ? await serve(process.env.RC10_DIR, 8842) : null;
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  try {
    L.reset(); L.setToday('2026-10-18');
    const ajay = L.emp({ name: 'Ajay', rate: 500, ob: 0, obDate: '2026-10-04', legacy: 'stf_ajay' });
    const chotu = L.emp({ name: 'Chotu', rate: 500, ob: 0, obDate: '2026-10-04', legacy: 'stf_chotu' });
    const dinesh = L.emp({ name: 'Dinesh', rate: 500, ob: 1000, obDate: '2026-10-07', legacy: 'stf_dinesh' });
    const ganesh = L.emp({ name: 'Ganesh', rate: 500, ob: 0, obDate: '2026-10-04', legacy: 'stf_ganesh' });
    const gopal = L.emp({ name: 'Gopal', rate: 500, ob: 0, obDate: '2026-10-04', legacy: 'stf_gopal' });
    [ajay, chotu, dinesh, ganesh, gopal].forEach(s => L.attRange(s, W1, 'PPPPPPPPPPPPPP'));
    const page = await phone(browser, { port: 8841, now: NOW });
    check('P0 the new build is served (rc11-n1-20261009)', /rc11-n1-20261009/.test(await page.content()));

    // ---------------------------------------------------- 1. the reproduced N1 case, in order, partial cash
    let card = await hisabWeek(page, 'stf_ajay', 12);
    check('P1 W2 while W1 is open: no Settle button, "Settle the week of Mon, 05 Oct first"',
      /Settle the week of Mon, 05 Oct first\. Weeks are settled in order; ₹0 is fine if no cash was given that Sunday\./.test(card)
      && !(await page.$('#d3h_stf_ajay .btn-hisab-settle')), card);
    card = await hisabWeek(page, 'stf_ajay', 5);
    check('P2 W1 offers Settle with the date-rule hint', !!(await page.$('#d3h_stf_ajay .btn-hisab-settle'))
      && /Only cash actually given on Sun, 11 Oct\. Cash given on another day: record it as a payment on that day\./.test(card), card);
    card = await settleOnPhone(page, 'stf_ajay', 0, 'Cash given at settlement \\(Sun, 11 Oct\\)');
    check('P3 W1 closed with ₹0: "no cash given", settled = hisab closed, balance at end of Sun 11 Oct ₹3,500 owed',
      /Cash given at settlement \(Sun, 11 Oct\) ₹0 — no cash given at settlement/.test(card)
      && /Status Settled — hisab closed for this week; any balance carries to the next week/.test(card)
      && /Balance at end of Sun, 11 Oct ₹3,500 — shop owes worker/.test(card) && stlPaid(ajay) === 0, card);
    card = await hisabWeek(page, 'stf_ajay', 12);
    check('P4 W2 now offers Settle, pre-filled 7,000', (await page.inputValue('#d3c_stf_ajay')) === '7000', card);
    card = await settleOnPhone(page, 'stf_ajay', 1000, 'Cash given at settlement \\(Sun, 18 Oct\\)');
    // before cash 3,500 + 3,500 - 0 = 7,000; cash 1,000; balance 6,000 owed
    const partialRe = [/Balance before settlement cash ₹3,500 \+ ₹3,500 − ₹0 = ₹7,000 — shop owes worker/, /Cash given at settlement \(Sun, 18 Oct\) ₹1,000/,
                       /Balance at end of Sun, 18 Oct ₹6,000 — shop owes worker/];
    check('P5 W2 cash ₹1,000: balance before 7,000, cash 1,000, balance at end of Sun 18 Oct ₹6,000 owed',
      partialRe.every(re => re.test(card)) && !/Cash still to give|Closing balance|paid in full/i.test(card) && stlPaid(ajay) === 1000, card);
    let dw = await detailsAndWhatsApp(page, 'stf_ajay', 14);
    check('P6 Details shows the same wording and figures', partialRe.every(re => re.test(dw.det)) && /Status Settled — hisab closed/.test(dw.det), dw.det);
    check('P7 WhatsApp carries the same lines',
      /Balance before settlement cash: ₹3,500 \+ ₹3,500 − ₹0 = ₹7,000 — shop owes worker/.test(dw.wa) && /Cash given at settlement \(Sun, 18 Oct\): ₹1,000/.test(dw.wa)
      && /Status: Settled — hisab closed for this week; any balance carries to the next week/.test(dw.wa)
      && /Balance at end of Sun, 18 Oct: ₹6,000 — shop owes worker/.test(dw.wa) && !/Cash still to give|Closing balance/.test(dw.wa), dw.wa);
    card = await hisabWeek(page, 'stf_ajay', 5);
    check('P8 W1 (history) still reads balance at end of Sun 11 Oct ₹3,500 and offers no Settle', /Balance at end of Sun, 11 Oct ₹3,500 — shop owes worker/.test(card)
      && !(await page.$('#d3h_stf_ajay .btn-hisab-settle')), card);

    // ---------------------------------------------------- 2. zero cash on both weeks
    await hisabWeek(page, 'stf_chotu', 5);
    await settleOnPhone(page, 'stf_chotu', 0, 'Cash given at settlement \\(Sun, 11 Oct\\)');
    await hisabWeek(page, 'stf_chotu', 12);
    card = await settleOnPhone(page, 'stf_chotu', 0, 'Cash given at settlement \\(Sun, 18 Oct\\)');
    dw = await detailsAndWhatsApp(page, 'stf_chotu', 14);
    check('P9 W2 cash ₹0: "no cash given at settlement", balance at end of Sun 18 Oct ₹7,000 owed (screen, Details, WhatsApp)',
      [card, dw.det].every(t => /₹0 — no cash given at settlement/.test(t) && /Balance at end of Sun, 18 Oct ₹7,000 — shop owes worker/.test(t))
      && /Balance at end of Sun, 18 Oct: ₹7,000 — shop owes worker/.test(dw.wa) && stlPaid(chotu) === 0, { card, wa: dw.wa });

    // ---------------------------------------------------- 3. partial first week after a mid-week Old Hisab (+1,000 at end of Wed 7 Oct)
    card = await hisabWeek(page, 'stf_dinesh', 12);
    check('P10 W2 waits for the partial W1', /Settle the week of Mon, 05 Oct first/.test(card) && !(await page.$('#d3h_stf_dinesh .btn-hisab-settle')), card);
    card = await hisabWeek(page, 'stf_dinesh', 5);
    // Thu 8 - Sun 11: 4 x 500 = 2,000; + Old Hisab 1,000 = 3,000
    check('P11 partial W1: StaffPay from Thu 08 Oct, 4 days, 2,000 earned, pre-filled 3,000',
      /StaffPay from Thu, 08 Oct \(after Old Hisab\)/.test(card) && /4 × ₹500 = ₹2,000/.test(card)
      && /Balance before settlement cash ₹1,000 \+ ₹2,000 − ₹0 = ₹3,000 — shop owes worker/.test(card) && (await page.inputValue('#d3c_stf_dinesh')) === '3000', card);
    card = await settleOnPhone(page, 'stf_dinesh', 3000, 'Cash given at settlement \\(Sun, 11 Oct\\)');
    check('P12 partial W1 settled 3,000: balance at end of Sun 11 Oct ₹0', /Balance at end of Sun, 11 Oct ₹0 — nothing owed/.test(card) && stlPaid(dinesh) === 3000, card);
    await hisabWeek(page, 'stf_dinesh', 12);
    card = await settleOnPhone(page, 'stf_dinesh', 3500, 'Cash given at settlement \\(Sun, 18 Oct\\)');
    check('P13 then W2 3,500: balance at end of Sun 18 Oct ₹0; paid 6,500 = 1,000 + 2,000 + 3,500', /Balance at end of Sun, 18 Oct ₹0 — nothing owed/.test(card) && stlPaid(dinesh) === 6500, card);

    // ---------------------------------------------------- 4. corrected records
    // Ganesh: W1 3,500 and W2 3,500 settled; then W1 is corrected on the phone ("cash NOT given")
    await apiSettle(ganesh, W1, 'settle', { cash: 3500 }); await apiSettle(ganesh, W2, 'settle', { cash: 3500 });
    await hisabWeek(page, 'stf_ganesh', 5);
    await page.click('#d3h_stf_ganesh button.warn');                // "Correct a mistaken entry"
    await page.check('#d3g_stf_ganesh'); await page.fill('#d3r_stf_ganesh', 'entered by mistake');
    await page.click('#d3y_stf_ganesh button');
    await page.waitForFunction(() => /corrected as a mistaken entry/.test(document.getElementById('d3h_stf_ganesh').innerText), null, { timeout: 15000 });
    card = await txt(page, '#d3h_stf_ganesh');
    check('P14 correcting W1 after W2 is settled works; W1 then offers no "Settle again" and says why',
      /corrected as a mistaken entry \(entered by mistake\)/.test(card) && !(await page.$('#d3h_stf_ganesh .btn-hisab-settle'))
      && /The week of Mon, 12 Oct is already settled and carried this week's balance\. Cash given on another day is recorded as a payment on that day\./.test(card)
      && sql(`select count(*) from staff_payment_void where staff_id = '${ganesh}'`) === '1', card);
    card = await hisabWeek(page, 'stf_ganesh', 12);
    dw = await detailsAndWhatsApp(page, 'stf_ganesh', 14);
    check('P15 W2 tells the truth after the correction: balance at end of Sun 18 Oct ₹3,500 owed (screen, Details, WhatsApp)',
      [card, dw.det].every(t => /Balance at end of Sun, 18 Oct ₹3,500 — shop owes worker/.test(t)) && /Balance at end of Sun, 18 Oct: ₹3,500 — shop owes worker/.test(dw.wa), card);
    // Gopal: W1 settled then corrected, W2 not settled -> the corrected record counts; W2 offered carrying 3,500
    await apiSettle(gopal, W1, 'settle', { cash: 3500 }); await apiSettle(gopal, W1, 'correct', { expected_version: 1, reason: 'mistake', cash_not_given: true });
    card = await hisabWeek(page, 'stf_gopal', 12);
    check('P16 corrected W1 counts as a record: W2 offered, pre-filled 7,000', (await page.inputValue('#d3c_stf_gopal')) === '7000', card);
    card = await settleOnPhone(page, 'stf_gopal', 7000, 'Cash given at settlement \\(Sun, 18 Oct\\)');
    const w1g = await hisabWeek(page, 'stf_gopal', 5);
    check('P17 after W2 (7,000) the corrected W1 offers no Settle again; paid 7,000 = earned', stlPaid(gopal) === 7000 && !(await page.$('#d3h_stf_gopal .btn-hisab-settle'))
      && /already settled and carried this week's balance/.test(w1g), w1g);
    check('P18 no page errors on the new build', page.errors.length === 0, page.errors);
    await page.close();

    // ---------------------------------------------------- 5. a phone still holding the released rc10 page
    if (s10) {
      const sunil = L.emp({ name: 'Sunil', rate: 500, ob: 0, obDate: '2026-10-04', legacy: 'stf_sunil' });
      L.attRange(sunil, W1, 'PPPPPPPPPPPPPP');
      const old = await phone(browser, { port: 8842, now: NOW });
      check('P19 the released rc10-d3-20261009 page is served', /rc10-d3-20261009/.test(await old.content()));
      await hisabWeek(old, 'stf_sunil', 12);
      await old.fill('#d3c_stf_sunil', '7000'); await old.check('#d3s_stf_sunil'); await old.check('#d3a_stf_sunil');
      await old.click('#d3h_stf_sunil .btn-hisab-settle');
      await old.waitForFunction(() => /first/.test((document.getElementById('d3n_stf_sunil') || {}).innerText || ''), null, { timeout: 15000 });
      const note = await txt(old, '#d3n_stf_sunil');
      check('P20 the old page still offers W2 but the database refuses in plain words; nothing paid',
        /Settle the week of 05 Oct first\. Weeks are settled in order; ₹0 is fine if no cash was given that Sunday\./.test(note) && stlPaid(sunil) === 0, note);
      check('P21 no page errors on the old build', old.errors.length === 0, old.errors);
      await old.close();
    } else console.log('SKIP P19-P21 (RC10_DIR not set)');
  } finally { await browser.close(); s11.close(); if (s10) s10.close(); }
  console.log('\n' + L.PASS.length + ' passed, ' + L.FAIL.length + ' failed - N1 phone');
  process.exit(L.FAIL.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
