/*
 * Older pages against a database holding a Shop receipt (synthetic data):
 * the real released rc16 and rc14 pages and rc9-safe. Their ordinary edit,
 * delete, Clear Month and upload paths cannot change or remove the receipt;
 * ordinary Shop payments keep working. rc16 does send receipts_ok, so its
 * controlled correction screen (with a correction record) can change or
 * remove a Shop receipt, as it already can a Workshop receipt (K1b).
 *
 *   test_d3/env.sh up
 *   RC16_DIR=/var/tmp/rc16wt RC14_DIR=/var/tmp/rc14wt RC9SAFE_DIR=/home/user/staffpay-rc9safe \
 *     node test_d3/test_shop_receipts_compat_browser.js
 */
const { chromium } = require('playwright');
const L = require('./lib.js'), { check, sql, OWNER } = L;
const { phone, txt, serve, uploaded, addPayment } = require('./phone.js');
const T = L.token(OWNER), NOW = '2026-10-14T11:00:00+05:30';
const PAGES = [['rc16', process.env.RC16_DIR || '/var/tmp/rc16wt', 8901, /rc16-addlayout-20261014/],
               ['rc14', process.env.RC14_DIR || '/var/tmp/rc14wt', 8902, /rc14-payedit-20261012/],
               ['rc9-safe', process.env.RC9SAFE_DIR || '/home/user/staffpay-rc9safe', 8903, /rc9-safe-20261009/]];
const fp = () => sql(`select md5(string_agg(legacy_id || ':' || amount::text || ':' || date, ',' order by legacy_id)) from staff_payment where amount < 0`)
  + '|' + sql('select count(*) from staff_payment_void') + '|' + sql('select count(*) from staff_d3_op');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  try {
    L.reset(); L.setToday('2026-10-14');
    const ramesh = L.emp({ name: 'Ramesh', group: 'shop', wage: 'daily', rate: 500, legacy: 'stf_ramesh' });
    await L.upsert(T, 'staff_payment', [L.payRow({ id: 1760700000001, staff: ramesh, name: 'Ramesh', amount: 3000, date: L.istTs('2026-10-03') })]);
    const a = await L.rpc(T, 'staff_receipt_add', { op_id: L.uuid(), staff_id: ramesh, amount: 600, day: '2026-10-12', receipts_ok: true });
    check('K0 set-up Shop receipt saved', a.ok === true, a);
    const rid = a.payment_id, before = fp();
    for (const [label, dir, port, stamp] of PAGES) {
      const srv = await serve(dir, port);
      const page = await phone(browser, { port, now: NOW });
      check(label + ' K1 the real ' + label + ' page is served', stamp.test(await page.content()));
      await page.evaluate(id => {
        const one = load().find(e => String(e.id) === id);
        if (typeof openEditEntry === 'function') { try { openEditEntry(one.id); } catch (e) {} }
        save(load().map(e => String(e.id) === id ? Object.assign({}, e, { amount: 600 }) : e));      // a stray edit making it positive
      }, rid);
      const closeAll = () => page.evaluate(() => { try { window.SPD3 && SPD3.closeCorrect(); } catch (e) {} try { closeEditEntry(); } catch (e) {} });
      const sawCorrect = await page.evaluate(() => !!document.querySelector('#d3CorrModal.show'));
      await closeAll();
      await page.evaluate(id => { try { deleteEntry(load().find(e => String(e.id) === id).id); } catch (e) {} }, rid);
      if (await page.$('#confirmModal.show')) await page.click('#confirmYesBtn');
      await closeAll();
      if (label === 'rc16') check('rc16 K1b rc16 routes the receipt to its controlled correction screen, not the ordinary edit', sawCorrect);
      await page.evaluate(() => { viewMonth = new Date(2026, 9, 1); clearMonth(); });
      await page.waitForSelector('#confirmModal.show'); await page.click('#confirmYesBtn');
      await uploaded(page);
      check(label + ' K2 stray edit, delete and Clear Month: the Shop receipt is unchanged; no correction record or log entry', fp() === before && Number(sql(`select count(*) from staff_payment where legacy_id = '${rid}' and amount = -600`)) === 1, fp());
      await addPayment(page, 'Ramesh 200', '2026-10-13'); await uploaded(page);
      check(label + ' K3 an ordinary Shop payment still records', Number(sql(`select count(*) from staff_payment where staff_id = '${ramesh}' and amount = 200`)) >= 1);
      check(label + ' K4 no page errors', page.errors.length === 0, page.errors);
      await page.close(); srv.close();
    }
  } catch (e) { check('no exception', false, e.stack); }
  await browser.close();
  console.log(`\n${L.PASS.length} passed, ${L.FAIL.length} failed - Shop receipts on older pages`);
  process.exit(L.FAIL.length ? 1 : 0);
})();
