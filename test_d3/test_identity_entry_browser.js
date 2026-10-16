/*
 * A1 correction 2 - a payment for an unknown name never creates staff
 * (synthetic data, 390x844 phone).
 *
 *   test_d3/env.sh up && node test_d3/test_identity_entry_browser.js
 *
 * Mohan exists. "Suresh" does not. An old name-only payment for "Ramu" (no
 * staff record) is already in the ledger.
 */
const path = require('path');
const { chromium } = require('playwright');
const L = require('./lib.js'), { check, sql, OWNER } = L;
const { phone, txt, serve, uploaded } = require('./phone.js');
const T = L.token(OWNER), NOW = '2026-10-14T11:00:00+05:30';
const staffCount = name => Number(sql(`select count(*) from staff_employee where staffpay_d3.name_key(name) = staffpay_d3.name_key('${name}')`));
const payCount = amt => Number(sql(`select count(*) from staff_payment where amount = ${amt}`));

(async () => {
  const srv = await serve(path.join(__dirname, '..'), 8907);
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  try {
    L.reset(); L.setToday('2026-10-14');
    const mohan = L.emp({ name: 'Mohan', group: 'shop', wage: 'daily', rate: 500, legacy: 'stf_mohan' });
    await L.upsert(T, 'staff_payment', [Object.assign(L.payRow({ id: 1761200000001, name: 'Ramu', amount: 50, date: L.istTs('2026-10-02') }), { staff_id: null, staff_legacy_id: null })]);
    const page = await phone(browser, { port: 8907, now: NOW });
    await page.waitForTimeout(1500); await uploaded(page);
    check('U0 opening the app with an old name-only payment ("Ramu") creates no staff record', staffCount('Ramu') === 0);
    const state = () => page.evaluate(() => ({ ob: (JSON.parse(localStorage.getItem('sp_cloud_outbox') || '[]')).length,
      reg: /Suresh/.test(JSON.stringify(loadRegistry() || {})), staffTxt: /Suresh/.test(SPStore.getRaw('staffpay_staff_master_v1') || ''),
      pays: load().filter(e => e.name === 'Suresh').length }));
    const tryPay = async v => { await page.evaluate(x => { switchTab('add'); document.getElementById('quickEntry').value = x; addEntry(); }, v); await page.waitForTimeout(700); };

    await tryPay('Suresh 300');
    let s = await state();
    check('U1 online: "Suresh 300" for an unknown name is refused with "add the worker first"',
      /pehle Staff/i.test(await txt(page, '#toast')), await txt(page, '#toast'));
    check('U2 online: no staff id, staff record, payment or queued write was created',
      staffCount('Suresh') === 0 && payCount(300) === 0 && s.ob === 0 && !s.reg && !s.staffTxt && s.pays === 0, s);
    check('U3 the typed entry is kept so the owner can continue', (await page.$eval('#quickEntry', e => e.value)) === 'Suresh 300');

    await page.route('**/rest/v1/**', r => r.abort('internetdisconnected'));
    await tryPay('Suresh 300');
    s = await state();
    check('U4 offline: refused the same way; nothing created locally or queued, entry kept',
      /pehle Staff/i.test(await txt(page, '#toast')) && s.ob === 0 && !s.reg && !s.staffTxt && s.pays === 0
      && (await page.$eval('#quickEntry', e => e.value)) === 'Suresh 300', s);
    await page.unroute('**/rest/v1/**');
    check('U5 nothing reached the database meanwhile', staffCount('Suresh') === 0 && payCount(300) === 0);

    await page.evaluate(() => { switchTab('staff'); document.getElementById('staffNameInput').value = 'Suresh'; document.getElementById('staffSalaryInput').value = '400';
      document.getElementById('staffWageTypeInput').value = 'daily'; document.getElementById('staffGroupInput').value = 'shop'; addStaff(); });
    await page.waitForFunction(() => /Suresh added/.test(document.getElementById('toast').textContent), null, { timeout: 8000 });
    await page.evaluate(() => switchTab('add'));
    check('U6 after adding Suresh on the Staff tab, the typed entry is still waiting on + Add', (await page.$eval('#quickEntry', e => e.value)) === 'Suresh 300');
    await page.evaluate(() => addEntry()); await uploaded(page);
    const sid = sql(`select id from staff_employee where name = 'Suresh'`);
    check('U7 continuing records ₹300 for the server-created Suresh (one record, linked by id)',
      staffCount('Suresh') === 1 && payCount(300) === 1 && sql(`select staff_id from staff_payment where amount = 300`) === sid);
    await page.evaluate(() => { document.getElementById('quickEntry').value = 'Mohan 200'; addEntry(); }); await uploaded(page);
    check('U8 an existing worker\'s payment records normally (Mohan ₹200, linked)', payCount(200) === 1 && sql(`select staff_id from staff_payment where amount = 200`) === mohan && staffCount('Mohan') === 1);
    check('U9 no page errors', page.errors.length === 0, page.errors);
  } catch (e) { check('no exception', false, e.stack); }
  await browser.close(); srv.close();
  console.log(`\n${L.PASS.length} passed, ${L.FAIL.length} failed - unknown-name payment`);
  process.exit(L.FAIL.length ? 1 : 0);
})();
