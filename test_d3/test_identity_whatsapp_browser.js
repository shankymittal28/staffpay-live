/*
 * A1 correction 3 - a held worker's WhatsApp hisab keeps the separate
 * Diya / Wapas mila / Net paid lines (synthetic data).
 *
 *   test_d3/env.sh up && node test_d3/test_identity_whatsapp_browser.js
 *
 * Raju R1 (Shop, Rs 500/day) is held because Raju R2 arrived unresolved.
 * Oct: ₹1,000 given to R1, ₹400 returned (a Wapas mila receipt), net ₹600.
 */
const path = require('path');
const { chromium } = require('playwright');
const L = require('./lib.js'), { check, sql, OWNER } = L;
const { phone, serve } = require('./phone.js');
const T = L.token(OWNER), NOW = '2026-10-14T11:00:00+05:30';

(async () => {
  const srv = await serve(path.join(__dirname, '..'), 8908);
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  try {
    L.reset(); L.setToday('2026-10-14');
    const r1 = L.emp({ name: 'Raju', group: 'shop', wage: 'daily', rate: 500, legacy: 'stf_raju1' });
    L.emp({ name: 'Mohan', group: 'shop', wage: 'daily', rate: 500, legacy: 'stf_mohan' });
    await L.upsert(T, 'staff_employee', [{ owner_id: OWNER, legacy_id: 'stf_raju2', name: 'Raju', work_group: 'shop', phone: '', active: true, salary: 500, wage_type: 'daily', opening_balance: 0, source: 'staff', device: 'old-page' }]);
    L.attRange(r1, '2026-10-05', 'PP');
    await L.upsert(T, 'staff_payment', [L.payRow({ id: 1761300000001, staff: r1, name: 'Raju', amount: 1000, date: L.istTs('2026-10-03') })]);
    const rc = await L.rpc(T, 'staff_receipt_add', { op_id: L.uuid(), staff_id: r1, amount: 400, day: '2026-10-10', receipts_ok: true });
    check('W0 set-up: R1 held (R2 unresolved); ₹1,000 given and ₹400 returned on R1', rc.ok && sql(`select staffpay_d3.identity_held(owner_id, id) from staff_employee where id = '${r1}'`) === 't');
    const page = await phone(browser, { port: 8908, now: NOW });
    await page.evaluate(() => { viewMonth = new Date(2026, 9, 1); });
    const t = await page.evaluate(() => buildHisabText('stf_raju1'));
    check('W1 the held WhatsApp hisab shows the separate lines: Diya gaya ₹1,000 · Wapas mila ₹400 · Net paid ₹600',
      /Diya gaya: ₹1,000\n/.test(t) && /Wapas mila: ₹400\n/.test(t) && /Net paid: ₹600\n/.test(t), t);
    check('W2 earnings and balance stay on hold: no Kamai, Baaki or Advance figure, the hold message is there',
      /Hisab roka gaya/.test(t) && !/Kamai|Baaki balance|Advance chal/.test(t), t);
    const m = await page.evaluate(() => buildHisabText('stf_mohan'));
    check('W3 an unrelated worker\'s hisab is unchanged (Kamai and Baaki shown, no hold message)', /Kamai \(earned\)/.test(m) && /Baaki balance/.test(m) && !/Hisab roka/.test(m), m);
    check('W4 no page errors', page.errors.length === 0, page.errors);
  } catch (e) { check('no exception', false, e.stack); }
  await browser.close(); srv.close();
  console.log(`\n${L.PASS.length} passed, ${L.FAIL.length} failed - held WhatsApp receipt labels`);
  process.exit(L.FAIL.length ? 1 : 0);
})();
