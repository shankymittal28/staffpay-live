/*
 * Shop receipt confirmation vs. a stale pay rate or wage type on the phone
 * (synthetic data). The phone has Ramesh at Rs 500/day; the database is then
 * changed underneath it while payments and attendance stay identical.
 *
 *   test_d3/env.sh up && node test_d3/test_shop_terms_browser.js
 *   APP_DIR=/some/build node ...   serves another build (e.g. 5b72fc1, to show the defect)
 *
 * Clock Wed 14 Oct 2026. Ramesh Oct: 10 days Present, 3,000 given 3 Oct.
 *   at 500/day: earned 5,000, 2,000 to pay; at 600/day: earned 6,000, 3,000 to pay.
 */
const path = require('path');
const { chromium } = require('playwright');
const L = require('./lib.js'), { check, sql, OWNER } = L;
const { phone, serve } = require('./phone.js');
const T = L.token(OWNER), NOW = '2026-10-14T11:00:00+05:30';
const APP = process.env.APP_DIR || path.join(__dirname, '..');

(async () => {
  const srv = await serve(APP, 8905);
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  try {
    L.reset(); L.setToday('2026-10-14');
    const ramesh = L.emp({ name: 'Ramesh', group: 'shop', wage: 'daily', rate: 500, legacy: 'stf_ramesh' });
    L.attRange(ramesh, '2026-10-01', 'PPPPPPPPPP');
    await L.upsert(T, 'staff_payment', [L.payRow({ id: 1760800000001, staff: ramesh, name: 'Ramesh', amount: 3000, date: L.istTs('2026-10-03') })]);
    const page = await phone(browser, { port: 8905, now: NOW });
    async function ask() {
      await page.evaluate(() => { switchTab('add'); SPD3.rcvToggle(true); });
      await page.selectOption('#rcvWho', ramesh); await page.fill('#rcvAmt', '100'); await page.fill('#rcvDay', '2026-10-12');
      await page.click('#rcvGo');
      await page.waitForSelector('#confirmModal.show', { timeout: 8000 });
      const m = await page.$eval('#confirmMsg', e => e.textContent);
      await page.evaluate(() => closeConfirm(true));
      return m;
    }
    const unconfirmed = m => /records abhi poore confirm nahi ho sake/.test(m) && !/Kamai|Net paid|dena baaki|zyada diya/.test(m);
    let m = await ask();
    check('R0 phone and database agree (500/day): Oct figures shown', /Kamai ₹5,000 · Diya ₹3,000/.test(m) && /Abhi: ₹2,000 dena baaki \(sirf Oct 2026\)/.test(m), m);
    sql(`update staff_employee set salary = 600 where id = '${ramesh}'`);            // changed elsewhere; this phone still holds 500
    m = await ask();
    check('R1 stale pay rate (phone 500, database 600): no earnings or before/after figures, the unconfirmed message', unconfirmed(m), m);
    sql(`update staff_employee set salary = 500, wage_type = 'monthly' where id = '${ramesh}'`);   // rate back, wage type changed
    m = await ask();
    check('R2 stale wage type (phone daily, database monthly): the unconfirmed message, no figures', unconfirmed(m), m);
    sql(`update staff_employee set salary = 600, wage_type = 'daily' where id = '${ramesh}'`);
    await page.evaluate(() => window.__SP_STORE__.pull());                            // the phone refreshes
    m = await ask();
    check('R3 after refresh (600/day on both): correct Oct figures confirmed (earned 6,000, 3,000 to pay)',
      /Kamai ₹6,000 · Diya ₹3,000 · Wapas mila ₹0 · Net paid ₹3,000/.test(m) && /Abhi: ₹3,000 dena baaki \(sirf Oct 2026\)/.test(m)
      && /Iske baad: Wapas mila ₹100 · Net paid ₹2,900 · ₹3,100 dena baaki \(sirf Oct 2026\)/.test(m), m);
    check('R4 nothing was saved by these checks', sql(`select count(*) from staff_payment where amount < 0`) === '0');
    check('R5 no page errors', page.errors.length === 0, page.errors);
  } catch (e) { check('no exception', false, e.stack); }
  await browser.close(); srv.close();
  console.log(`\n${L.PASS.length} passed, ${L.FAIL.length} failed - Shop receipt confirmation vs stale terms`);
  process.exit(L.FAIL.length ? 1 : 0);
})();
