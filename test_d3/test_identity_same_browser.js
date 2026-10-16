/*
 * A1 correction 4 - "Same person" loads the existing worker so the waiting
 * payment can continue (synthetic data, 390x844 phone).
 *
 *   test_d3/env.sh up && node test_d3/test_identity_same_browser.js
 *
 * The phone opens with no Kamal; another phone then creates Kamal. This stale
 * phone's "Kamal 300" is refused as unknown; the owner adds Kamal, the server
 * finds the existing one, the owner answers Same, and records the payment
 * without any manual refresh.
 */
const path = require('path');
const { chromium } = require('playwright');
const L = require('./lib.js'), { check, sql } = L;
const { phone, txt, serve, uploaded } = require('./phone.js');
const NOW = '2026-10-14T11:00:00+05:30';
const kamals = () => Number(sql(`select count(*) from staff_employee where staffpay_d3.name_key(name) = 'kamal'`));
const pays = () => Number(sql(`select count(*) from staff_payment where amount = 300`));

(async () => {
  const srv = await serve(path.join(__dirname, '..'), 8909);
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  try {
    L.reset(); L.setToday('2026-10-14');
    L.emp({ name: 'Mohan', group: 'shop', wage: 'daily', rate: 500, legacy: 'stf_mohan' });
    const page = await phone(browser, { port: 8909, now: NOW });
    await page.waitForTimeout(1000);
    const kamal = L.emp({ name: 'Kamal', group: 'shop', wage: 'daily', rate: 375, legacy: 'stf_kamal_other_phone' });   // another phone added him
    const typePay = v => page.evaluate(x => { switchTab('add'); document.getElementById('quickEntry').value = x; }, v);
    const addKamal = () => page.evaluate(() => { switchTab('staff'); document.getElementById('staffNameInput').value = 'Kamal'; document.getElementById('staffSalaryInput').value = '375';
      document.getElementById('staffWageTypeInput').value = 'daily'; document.getElementById('staffGroupInput').value = 'shop'; addStaff(); });
    const entry = () => page.$eval('#quickEntry', e => e.value);

    await typePay('Kamal 300'); await page.evaluate(() => addEntry()); await page.waitForTimeout(400);
    check('M0 stale list: "Kamal 300" is refused as unknown and the entry is kept', /pehle Staff/.test(await txt(page, '#toast')) && (await entry()) === 'Kamal 300');

    // ---- refresh fails after Same: explained, entry kept for retry
    await page.route('**/rest/v1/staff_employee?select=*', r => r.abort('internetdisconnected'));
    await addKamal(); await page.waitForSelector('#confirmModal.show', { timeout: 8000 });
    await page.click('#confirmYesBtn'); await page.waitForTimeout(1200);
    check('M1 Same chosen but the list could not be loaded: the phone says so and nothing was created',
      /load nahi|dobara/i.test(await txt(page, '#toast')) && kamals() === 1, await txt(page, '#toast'));
    await page.evaluate(() => switchTab('add'));
    check('M2 the waiting entry is still there for the retry', (await entry()) === 'Kamal 300');
    await page.unroute('**/rest/v1/staff_employee?select=*');

    // ---- retry: Same loads Kamal; Record Payment continues
    await addKamal(); await page.waitForSelector('#confirmModal.show', { timeout: 8000 });
    const q = await txt(page, '#confirmMsg');
    await page.click('#confirmYesBtn');
    await page.waitForFunction(() => (typeof empList === 'function') && empList().some(e => e.name === 'Kamal'), null, { timeout: 8000 });
    check('M3 Same: the existing Kamal (from the server) is now on this phone without a manual refresh',
      /pehle se hai[\s\S]*Kamal/.test(q) && await page.evaluate(id => empList().some(e => e.name === 'Kamal' && e.uuid === id), kamal), q);
    await page.evaluate(() => switchTab('add'));
    check('M4 the entry "Kamal 300" is still waiting on + Add', (await entry()) === 'Kamal 300');
    await page.evaluate(() => addEntry()); await uploaded(page);
    check('M5 Record Payment: exactly one Kamal and one ₹300 payment, linked to his existing id',
      kamals() === 1 && pays() === 1 && sql(`select staff_id from staff_payment where amount = 300`) === kamal);
    check('M6 no page errors', page.errors.length === 0, page.errors);
  } catch (e) { check('no exception', false, e.stack); }
  await browser.close(); srv.close();
  console.log(`\n${L.PASS.length} passed, ${L.FAIL.length} failed - Same person continues the payment`);
  process.exit(L.FAIL.length ? 1 : 0);
})();
