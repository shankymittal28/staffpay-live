/*
 * A1 correction 5 - the Shop receipt confirmation checks the database's
 * current identity hold (synthetic data, 390x844 phone).
 *
 *   test_d3/env.sh up && node test_d3/test_identity_shopconfirm_browser.js
 *
 * The phone loads Raju and Mohan (Shop, Rs 500/day, Oct: 4 days Present,
 * ₹1,000 given). Only afterwards does a duplicate Raju arrive from another
 * (old) page, so this phone still believes Raju is a single record.
 */
const path = require('path');
const { chromium } = require('playwright');
const L = require('./lib.js'), { check, sql, OWNER } = L;
const { phone, txt, serve } = require('./phone.js');
const T = L.token(OWNER), NOW = '2026-10-14T11:00:00+05:30';

(async () => {
  const srv = await serve(path.join(__dirname, '..'), 8910);
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  try {
    L.reset(); L.setToday('2026-10-14');
    const raju = L.emp({ name: 'Raju', group: 'shop', wage: 'daily', rate: 500, legacy: 'stf_raju' });
    const mohan = L.emp({ name: 'Mohan', group: 'shop', wage: 'daily', rate: 500, legacy: 'stf_mohan' });
    for (const [id, pid] of [[raju, 1761400000001], [mohan, 1761400000002]]) {
      L.attRange(id, '2026-10-05', 'PPPP');
      await L.upsert(T, 'staff_payment', [L.payRow({ id: pid, staff: id, name: id === raju ? 'Raju' : 'Mohan', amount: 1000, date: L.istTs('2026-10-03') })]);
    }
    const page = await phone(browser, { port: 8910, now: NOW });
    await page.waitForTimeout(1000);
    await L.upsert(T, 'staff_employee', [{ owner_id: OWNER, legacy_id: 'stf_raju_dup', name: 'Raju', work_group: 'shop', phone: '', active: true, salary: 500, wage_type: 'daily', opening_balance: 0, source: 'staff', device: 'old-page' }]);
    const shopMonth = id => L.rpc(T, 'staff_shop_month', { staff_id: id, month: '2026-10' });
    const a = await shopMonth(raju), b = await shopMonth(mohan);
    check('C0 the database now holds Raju (duplicate arrived after this phone loaded); its month read says so; Mohan\'s says not held',
      a.ok && a.identity && a.identity.held === true && b.ok && b.identity && b.identity.held === false, { a: a.identity, b: b.identity });
    check('C1 this stale phone still sees one Raju, not held', await page.evaluate(() => empList().filter(e => e.name === 'Raju').length === 1 && !empList().find(e => e.name === 'Raju').held));
    const ask = async (id, amt) => {
      await page.evaluate(() => { switchTab('add'); SPD3.rcvToggle(true); });
      await page.selectOption('#rcvWho', id); await page.fill('#rcvAmt', String(amt)); await page.fill('#rcvDay', '2026-10-12');
      await page.click('#rcvGo'); await page.waitForSelector('#confirmModal.show', { timeout: 8000 });
      return txt(page, '#confirmMsg');
    };
    let m = await ask(raju, 100);
    check('C2 Raju\'s receipt confirmation withholds earnings and before/after balances (the existing "not confirmed" message)',
      /confirm nahi ho sake/.test(m) && !/Kamai|Net paid|dena baaki|zyada diya|Abhi:|Iske baad/.test(m), m);
    await page.click('#confirmYesBtn');
    await page.waitForFunction(() => /wapas mila/i.test(document.getElementById('toast').textContent), null, { timeout: 8000 });
    check('C3 the real receipt can still be recorded for Raju (₹100, on his own record)',
      sql(`select staff_id || '|' || amount::int from staff_payment where amount < 0`) === raju + '|-100');
    m = await ask(mohan, 100); await page.evaluate(() => closeConfirm(true));
    check('C4 unrelated Mohan still gets confirmed Oct figures (earned ₹2,000, given ₹1,000)',
      /Kamai ₹2,000 · Diya ₹1,000/.test(m) && /Abhi: ₹1,000 dena baaki/.test(m), m);
    check('C5 no page errors', page.errors.length === 0, page.errors);
  } catch (e) { check('no exception', false, e.stack); }
  await browser.close(); srv.close();
  console.log(`\n${L.PASS.length} passed, ${L.FAIL.length} failed - Shop confirmation vs fresh identity hold`);
  process.exit(L.FAIL.length ? 1 : 0);
})();
