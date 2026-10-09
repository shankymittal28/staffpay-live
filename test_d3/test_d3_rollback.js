/*
 * D3 rollback acceptance: rc10 -> rc9-safe -> rc10 on ONE disposable database,
 * using the records each build really writes and the real sync code.
 *
 *   test_d3/env.sh up && RC9SAFE_DIR=/path/to/rc9-safe/checkout node test_d3/test_d3_rollback.js
 */
const path = require('path');
const { chromium } = require('playwright');
const L = require('./lib.js'), { check, sql, OWNER } = L;
const { phone, txt, idle, uploaded, addPayment, openHisab, serve } = require('./phone.js');
const RC10 = path.join(__dirname, '..'), RC9S = process.env.RC9SAFE_DIR;
if (!RC9S) { console.error('set RC9SAFE_DIR'); process.exit(2); }
const T = L.token(OWNER);
const snapshot = () => sql(`select json_build_object(
  'payments', (select json_agg(json_build_object('id', legacy_id, 'amt', amount, 'day', (date at time zone 'Asia/Kolkata')::date, 'staff', staff_id) order by legacy_id) from staff_payment),
  'settlements', (select json_agg(json_build_object('id', legacy_id, 'v', version, 'state', state, 'rate', daily_wage, 'cash', cash_paid) order by legacy_id) from staff_settlement),
  'ops', (select count(*) from staff_d3_op), 'voids', (select count(*) from staff_payment_void),
  'terms', (select json_agg(json_build_object('n', name, 'ob', opening_balance, 'obd', opening_balance_date, 'rate', salary, 'g', work_group) order by name) from staff_employee))`);

(async () => {
  const s10 = await serve(RC10, 8831), s9 = await serve(RC9S, 8832);
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  try {
    L.reset(); L.setToday('2026-10-11');
    const sonu = L.emp({ name: 'Sonu', rate: 800, ob: 0, obDate: '2026-10-04', legacy: 'stf_sonu' });
    const shop = L.emp({ name: 'ShopRaju', group: 'shop', wage: 'daily', rate: 400, legacy: 'stf_shopraju' });
    L.attRange(sonu, '2026-10-05', 'PPHPPHA'); L.attRange(shop, '2026-10-01', 'PPH');

    // ---- rc10: advances, settlement, a correction --------------------------
    let page = await phone(browser, { port: 8831 });
    await addPayment(page, 'Sonu 1000', '2026-10-06'); await addPayment(page, 'Sonu 500', '2026-10-09');
    await addPayment(page, 'ShopRaju 500', '2026-10-02'); await uploaded(page);
    await openHisab(page, 'stf_sonu');
    await page.check('#d3s_stf_sonu'); await page.check('#d3a_stf_sonu');
    await page.click('#d3h_stf_sonu .btn-hisab-settle');
    await page.waitForFunction(() => /\(Sun, 11 Oct\)/.test((document.getElementById('d3h_stf_sonu') || {}).innerText || ''), null, { timeout: 15000 });
    const r10 = await L.rpc(T, 'staff_workshop_report', { staff_id: sonu, to: '2026-10-11' });
    const before = snapshot();
    check('R0 rc10 wrote: 2 advances + 1 settlement payment (2500), balance 0', JSON.parse(before).payments.length === 4 && Number(r10.balance) === 0, before);
    await page.close();

    // ---- rollback: rc9-safe on the same data --------------------------------
    page = await phone(browser, { port: 8832 });
    check('R1 rc9-safe is the build being served', /rc9-safe-20261009/.test(await page.content()));
    await page.evaluate(() => { viewMonth = new Date(2026, 9, 1); updateMonthLabels(); switchTab('history'); }); await idle(page);
    const hist = await page.$$eval('#historyList .entry-item', rs => rs.map(r => r.innerText.replace(/\s+/g, ' ')));
    check('R2 every payment is visible, settlement and hisab payments marked read-only', hist.length === 4
      && hist.filter(t => /read-only/.test(t)).length === 3 && hist.some(t => /Weekly settlement · read-only/.test(t) && /2,500/.test(t)), hist);
    await page.evaluate(() => { switchTab('hisab'); });
    check('R3 Weekly Hisab says it is unavailable in this version', /unavailable in this version/.test(await txt(page, '#hisabList')));
    await page.evaluate(() => { switchTab('payroll'); }); await idle(page);
    const rows = await page.$$eval('.payroll-row', rs => rs.map(r => r.innerText.replace(/\s+/g, ' ')));
    check('R4 Payroll: workshop balance "unavailable", shop row normal (2/1/0, earned 1000, paid 500)',
      rows.some(t => /Sonu/.test(t) && /balance unavailable in this version/.test(t))
      && rows.some(t => /ShopRaju/.test(t) && /2\/1\/0/.test(t) && /₹1,000/.test(t) && /₹500/.test(t)), rows);
    // attempts to change protected money from this build
    await page.evaluate(() => { const id = load().find(e => e.amount === 1000).id; deleteEntry(id); });
    await page.evaluate(() => save(load().map(e => e.name === 'Sonu' ? Object.assign({}, e, { amount: 1 }) : e)));   // a stray bulk edit
    await page.evaluate(() => { viewMonth = new Date(2026, 9, 1); clearMonth(); });
    await page.waitForSelector('#confirmModal.show'); await page.click('#confirmYesBtn');
    await uploaded(page); await idle(page);
    await page.evaluate(() => { switchTab('staff'); editStaffRow('Sonu'); });
    const lockedUi = await page.$eval('#ie_amount', el => el.disabled) && await page.$eval('#ie_group', el => el.disabled);
    await page.fill('#ie_phone', '98765'); await page.evaluate(() => saveStaffRow()); await uploaded(page);
    await addPayment(page, 'Sonu 200', '2026-10-12'); await uploaded(page);   // ordinary recording keeps working
    const after9 = JSON.parse(snapshot());
    const sonuPays = after9.payments.filter(p => p.staff === sonu).map(p => Number(p.amt)).sort((a, b) => a - b);
    check('R5 nothing deleted or rewritten: Sonu still has 500, 1000, 2500 (+ new 200); settlement record unchanged',
      JSON.stringify(sonuPays) === '[200,500,1000,2500]' && JSON.stringify(after9.settlements) === JSON.stringify(JSON.parse(before).settlements)
      && after9.ops === JSON.parse(before).ops && after9.voids === JSON.parse(before).voids, { sonuPays, s: after9.settlements });
    const sonuTerms = after9.terms.find(t => t.n === 'Sonu');
    check('R6 worker terms kept (rate 800, Old Hisab 0 at 04 Oct, workshop); editor locked; phone saved',
      lockedUi && Number(sonuTerms.rate) === 800 && sonuTerms.obd === '2026-10-04' && sonuTerms.g === 'workshop'
      && sql(`select phone from staff_employee where id = '${sonu}'`) === '98765', sonuTerms);
    check('R7 the shop payment in the cleared month was cleared as before', !after9.payments.some(p => p.staff === shop), after9.payments);
    check('R8 no page errors in rc9-safe', page.errors.length === 0, page.errors);
    await page.close();

    // ---- upgrade again: rc10 on the same data -------------------------------
    page = await phone(browser, { port: 8831 });
    await openHisab(page, 'stf_sonu');
    const card = await txt(page, '#d3h_stf_sonu');
    const r10b = await L.rpc(T, 'staff_workshop_report', { staff_id: sonu, to: '2026-10-11' });
    check('R9 rc10 again: same week figures with no conversion (earned 4000, advances 1500, settlement 2500, closing 0)',
      /₹4,000/.test(card) && /Total advances ₹1,500/.test(card) && /Closing balance ₹0/.test(card)
      && JSON.stringify(r10b.weeks) === JSON.stringify(r10.weeks), card);
    check('R10 no page errors in rc10', page.errors.length === 0, page.errors);
    await page.close();
  } finally { await browser.close(); s10.close(); s9.close(); }
  console.log('\n' + L.PASS.length + ' passed, ' + L.FAIL.length + ' failed - D3 rollback');
  process.exit(L.FAIL.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
