/*
 * One worker, one record (A1) against the real older pages: live rc17, rc16,
 * rc14 and rc9-safe (synthetic data). Each page is a stale phone: it loaded
 * before another phone created Raju, then adds Raju itself and records a
 * payment for him. The database must accept both (nothing jams, nothing is
 * lost), mark that page's Raju unresolved and keep the payment on that record.
 *
 *   test_d3/env.sh up
 *   RC17_DIR=/var/tmp/rc17wt RC16_DIR=/var/tmp/rc16wt RC14_DIR=/var/tmp/rc14wt RC9SAFE_DIR=/home/user/staffpay-rc9safe \
 *     node test_d3/test_identity_compat_browser.js
 */
const { chromium } = require('playwright');
const L = require('./lib.js'), { check, sql } = L;
const { phone, serve, uploaded, addPayment } = require('./phone.js');
const NOW = '2026-10-14T11:00:00+05:30';
const PAGES = [['rc17', process.env.RC17_DIR || '/var/tmp/rc17wt', 8911, /rc17-shopreceipts-20261014/],
               ['rc16', process.env.RC16_DIR || '/var/tmp/rc16wt', 8912, /rc16-addlayout-20261014/],
               ['rc14', process.env.RC14_DIR || '/var/tmp/rc14wt', 8913, /rc14-payedit-20261012/],
               ['rc9-safe', process.env.RC9SAFE_DIR || '/home/user/staffpay-rc9safe', 8914, /rc9-safe-20261009/]];

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  try {
    for (const [label, dir, port, stamp] of PAGES) {
      L.reset(); L.setToday('2026-10-14');
      L.emp({ name: 'Mohan', group: 'shop', wage: 'daily', rate: 500, legacy: 'stf_mohan' });
      const srv = await serve(dir, port);
      const page = await phone(browser, { port, now: NOW });
      check(label + ' K0 the real ' + label + ' page is served', stamp.test(await page.content()));
      const r1 = L.emp({ name: 'Raju', group: 'shop', wage: 'daily', rate: 500, legacy: 'stf_raju_other_phone' });   // created elsewhere; this page has not refreshed
      await page.evaluate(() => { document.getElementById('staffNameInput').value = 'Raju'; const s = document.getElementById('staffSalaryInput'); if (s) s.value = '500';
        const t = document.getElementById('staffWageTypeInput'); if (t) t.value = 'daily'; addStaff(); });
      await addPayment(page, 'Raju 200', '2026-10-13'); await uploaded(page);
      const mine = sql(`select id from staff_employee where name = 'Raju' and id <> '${r1}'`);
      check(label + ' K1 the stale page\'s own Raju is accepted and marked unresolved (pointing at the other phone\'s Raju)',
        !!mine && sql(`select identity_status || '|' || identity_of from staff_employee where id = '${mine}'`) === 'unresolved|' + r1);
      check(label + ' K2 its ₹200 payment uploaded and stays on that page\'s own record; nothing queued behind it',
        sql(`select staff_id from staff_payment where amount = 200`) === mine && (await page.evaluate(() => (JSON.parse(localStorage.getItem('sp_cloud_outbox') || '[]')).length)) === 0);
      await addPayment(page, 'Mohan 100', '2026-10-13'); await uploaded(page);
      check(label + ' K3 unrelated work after it still uploads (Mohan ₹100)', Number(sql(`select count(*) from staff_payment where amount = 100`)) === 1);
      check(label + ' K4 no page errors', page.errors.length === 0, page.errors);
      await page.close(); srv.close();
    }
  } catch (e) { check('no exception', false, e.stack); }
  await browser.close();
  console.log(`\n${L.PASS.length} passed, ${L.FAIL.length} failed - one worker, one record on older pages`);
  process.exit(L.FAIL.length ? 1 : 0);
})();
