/*
 * Shop receipts on a 390x844 phone, synthetic data only (disposable database
 * with sql/d3_receipts_shop_v1.sql).
 *
 *   test_d3/env.sh up && node test_d3/test_shop_receipts_browser.js [screenshot-dir]
 *
 * Clock Wed 14 Oct 2026 11:00 IST. Shop staff are daily-rate Rs 500 so every
 * month figure is easy to check by hand:
 *   Ramesh  Oct: 10 days Present = 5,000 earned; 3,000 given 3 Oct
 *   Mohan   Sep: 1,000 advance 10 Sep. Oct: 5 days Present = 2,500 earned
 *   Kamal   Oct: 4 days = 2,000 earned; 500 given 6 Oct (no receipt: labels unchanged)
 */
const path = require('path');
const { chromium } = require('playwright');
const L = require('./lib.js'), { check, sql, OWNER } = L;
const { phone, txt, serve, addPayment, uploaded } = require('./phone.js');
const SB = 'https://bsjrihrekfsxmajdsyhc.supabase.co';
const T = L.token(OWNER), SHOTS = process.argv[2] || null, NOW = '2026-10-14T11:00:00+05:30';
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png') }); };
const rows = s => sql(`select coalesce(string_agg(amount::int || '@' || to_char(date at time zone 'Asia/Kolkata', 'DD Mon'), ',' order by date, legacy_id), '') from staff_payment where staff_id = '${s}'`);

(async () => {
  const srv = await serve(path.join(__dirname, '..'), 8899);
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  try {
    L.reset(); L.setToday('2026-10-14');
    const mk = (name, o) => L.emp(Object.assign({ name, group: 'shop', wage: 'daily', rate: 500, legacy: 'stf_' + name.toLowerCase() }, o || {}));
    const ramesh = mk('Ramesh'), mohan = mk('Mohan'), kamal = mk('Kamal');
    const rohit = L.emp({ name: 'Rohit', rate: 500, ob: -24000, obDate: '2026-10-04', legacy: 'stf_rohit' });
    L.attRange(ramesh, '2026-10-01', 'PPPPPPPPPP'); L.attRange(mohan, '2026-10-01', 'PPPPP'); L.attRange(kamal, '2026-10-01', 'PPPP');
    L.attRange(rohit, '2026-10-05', 'PPPPAAAPPP');
    await L.upsert(T, 'staff_payment', [
      L.payRow({ id: 1760600000001, staff: ramesh, name: 'Ramesh', amount: 3000, date: L.istTs('2026-10-03') }),
      L.payRow({ id: 1760600000002, staff: mohan, name: 'Mohan', amount: 1000, date: L.istTs('2026-09-10') }),
      L.payRow({ id: 1760600000003, staff: kamal, name: 'Kamal', amount: 500, date: L.istTs('2026-10-06') })]);
    const page = await phone(browser, { port: 8899, now: NOW });
    const net = { statusDown: false };
    await page.route(SB + '/rest/v1/rpc/staff_d3_op_status', r => net.statusDown ? r.abort('connectionreset') : r.fallback());
    check('P0 the new build is served (rc18-identity-20261016)', /rc18-identity-20261016/.test(await page.content()));

    async function ask(uuid, amt, day) {
      await page.evaluate(() => { switchTab('add'); SPD3.rcvToggle(true); });
      await page.selectOption('#rcvWho', uuid); await page.fill('#rcvAmt', String(amt)); await page.fill('#rcvDay', day);
      await page.click('#rcvGo');
      const opened = await page.waitForSelector('#confirmModal.show', { timeout: 6000 }).then(() => true, () => false);
      return opened ? page.$eval('#confirmMsg', e => e.textContent) : null;
    }
    const yes = async () => { await page.click('#confirmYesBtn'); await page.waitForFunction(() => Object.keys(SPD3.pending()).length === 0, null, { timeout: 15000 }); await page.waitForTimeout(800); };
    const payrollRow = async (name, month) => {
      await page.evaluate(m => { viewMonth = new Date(2026, m, 1); switchTab('payroll'); renderPayroll(); }, month);
      await page.waitForTimeout(400);
      return page.$$eval('.payroll-row', (rs, nm) => (rs.find(r => r.querySelector('.payroll-name') && r.querySelector('.payroll-name').textContent.trim() === nm) || {}).innerText || '', name).then(t => t.replace(/\s+/g, ' '));
    };

    // ---- picker: Workshop and Shop, clearly identified
    await page.evaluate(() => { switchTab('add'); SPD3.rcvToggle(true); });
    const groups = await page.$$eval('#rcvWho optgroup', gs => gs.map(g => g.label + ': ' + [...g.querySelectorAll('option')].map(o => o.textContent + '=' + o.value.length).join(', ')));
    check('P1 one picker, two labelled groups; Workshop (Rohit) and Shop (Kamal, Mohan, Ramesh), each by permanent id',
      groups.length === 2 && /^Workshop \(hafte ka hisab\): Rohit=36$/.test(groups[0]) && /^Shop \(mahine ka hisab\): Kamal=36, Mohan=36, Ramesh=36$/.test(groups[1]), groups);
    await shot(page, '1-picker');

    // ---- Ramesh: receipt in a month whose records are complete and confirmed
    // Oct: earned 5,000; given 3,000; returned 0; net paid 3,000; 2,000 to pay
    // after 600 back: returned 600, net paid 2,400, 2,600 to pay (Oct only)
    let msg = await ask(ramesh, 600, '2026-10-12');
    await shot(page, '2-confirm-ramesh');
    check('P2 confirmation names Shop, amount and actual date, and says the receipt joins the Oct 2026 hisab',
      /^Ramesh \(Shop\) se ₹600 wapas mila · 12 Oct 2026/.test(msg) && /ye wapasi Oct 2026 ke hisab mein judegi/.test(msg), msg);
    check('P3 Oct-only figures, before and after, never called a total balance',
      /Oct 2026 \(sirf is mahine ka, pichle mahine isme nahi\):/.test(msg)
      && /Kamai ₹5,000 · Diya ₹3,000 · Wapas mila ₹0 · Net paid ₹3,000/.test(msg)
      && /Abhi: ₹2,000 dena baaki \(sirf Oct 2026\)/.test(msg)
      && /Iske baad: Wapas mila ₹600 · Net paid ₹2,400 · ₹2,600 dena baaki \(sirf Oct 2026\)/.test(msg) && !/⚠/.test(msg), msg);
    await yes();
    check('P4 saved once: −600 on 12 Oct in the Payments ledger', rows(ramesh) === '3000@03 Oct,-600@12 Oct', rows(ramesh));

    // ---- Shop screens: given and returned separately, "Net paid", counted once
    let pr = await payrollRow('Ramesh', 9);
    check('P5 Payroll (Oct): "Net paid ₹2,400", split "Diya ₹3,000 · ↩ Wapas mila ₹600 · Net paid ₹2,400 (Oct 2026)", balance ₹2,600',
      /₹2,400 Net paid/i.test(pr) && /Diya ₹3,000 · ↩ Wapas mila ₹600 · Net paid ₹2,400 \(Oct 2026\)/.test(pr) && /₹2,600/.test(pr) && !/\bPaid\b/i.test(pr.replace(/Net paid/gi, '')), pr);
    await page.evaluate(() => { const el = [...document.querySelectorAll('.payroll-row')].find(r => /Ramesh/.test(r.textContent)); if (el) el.scrollIntoView(); });
    await shot(page, '3-payroll-ramesh');
    const kp = await payrollRow('Kamal', 9);
    check('P6 Shop staff without a receipt unchanged: "Paid ₹500", no split line, balance ₹1,500', /₹500 Paid/i.test(kp) && !/Wapas|Net paid/i.test(kp) && /₹1,500/.test(kp), kp);
    await page.evaluate(() => { viewMonth = new Date(2026, 9, 1); detailGroup = 'shop'; selectedDetailStaff = 'stf_ramesh'; switchTab('detail'); renderStaffDetail(); });
    await page.waitForTimeout(400);
    const det = await txt(page, '#staffDetailContent');
    check('P7 Details (Oct): Net paid ₹2,400 with the split line; balance payable ₹2,600; the row reads "↩ Wapas mila ₹600"',
      /₹2,400 Net paid/i.test(det) && /Diya ₹3,000 · ↩ Wapas mila ₹600 · Net paid ₹2,400 \(Oct 2026\)/.test(det) && /₹2,600 Daily balance payable/.test(det) && /↩ Wapas mila ₹600/.test(det), det.slice(0, 500));
    await shot(page, '4-details-ramesh');
    const wa = await page.evaluate(() => buildHisabText('stf_ramesh'));
    check('P8 WhatsApp: "Diya gaya ₹3,000 / Wapas mila ₹600 / Net paid ₹2,400", then the month balance ₹2,600',
      /Mahina: /.test(wa) && /Kamai \(earned\): ₹5,000\nDiya gaya: ₹3,000\nWapas mila: ₹600\nNet paid: ₹2,400\n🔴 \*Baaki balance: ₹2,600\*/.test(wa), wa);
    const waK = await page.evaluate(() => buildHisabText('stf_kamal'));
    check('P9 WhatsApp without a receipt unchanged: "Diya gaya (paid): ₹500"', /Diya gaya \(paid\): ₹500/.test(waK) && !/Wapas|Net paid/.test(waK), waK);
    await page.evaluate(() => { summaryGroup = 'shop'; viewMonth = new Date(2026, 9, 7); switchTab('summary'); renderSummary(); });
    await page.waitForTimeout(400);
    const sl = await txt(page, '#staffList');
    check('P10 Summary (Shop, Oct): banner "Total net paid", split line, Ramesh card split; totals counted once',
      (await txt(page, '#bannerPaidLabel')) === 'Total net paid' && (await txt(page, '#bannerTotal')) === '₹2,900'
      && /Diya ₹3,500 · ↩ Wapas mila ₹600 · Net paid ₹2,900/.test(await txt(page, '#summaryShopSplit'))
      && /Ramesh .*Diya ₹3,000 · ↩ Wapas mila ₹600 · Net paid/.test(sl), { b: await txt(page, '#bannerPaidLabel'), t: await txt(page, '#bannerTotal'), s: await txt(page, '#summaryD3'), sl: sl.slice(0, 300) });
    await shot(page, '5-summary-shop');
    await page.evaluate(() => { viewMonth = new Date(2026, 8, 7); renderSummary(); });
    check('P11 Summary for September (no receipt): banner back to "Total Paid", no split line',
      (await txt(page, '#bannerPaidLabel')) === 'Total Paid' && (await txt(page, '#summaryD3')) === '');
    await page.evaluate(() => { viewMonth = new Date(2026, 9, 1); updateMonthLabels(); switchTab('history'); renderHistory(); });
    check('P12 History row reads "↩ Wapas mila ₹600" (not a payment of −600)', /Ramesh .*↩ Wapas mila ₹600/.test(await txt(page, '#historyList')) && !/₹-600/.test(await txt(page, '#historyList')));

    // ---- cross-month: Sept advance 1,000, returned 600 on 5 Oct (no carry-forward)
    // Oct before: earned 2,500, given 0, returned 0, net 0, 2,500 to pay; after: returned 600, net −600, 3,100 to pay (Oct only)
    msg = await ask(mohan, 600, '2026-10-05');
    await shot(page, '6-confirm-cross-month');
    check('P13 cross-month confirmation: Oct-only figures and the precise warning (more than given in Oct 2026; earlier advances not shown)',
      /^Mohan \(Shop\) se ₹600 wapas mila · 5 Oct 2026/.test(msg) && /Kamai ₹2,500 · Diya ₹0 · Wapas mila ₹0 · Net paid ₹0/.test(msg)
      && /Iske baad: Wapas mila ₹600 · Net paid −₹600 · ₹3,100 dena baaki \(sirf Oct 2026\)/.test(msg)
      && /⚠ Ye wapasi Oct 2026 mein diye gaye paise \(₹0\) se zyada hai\. Pichle mahinon ka advance is mahine ke hisab mein nahi dikhta\./.test(msg)
      && !/advance baaki nahi|koi advance/.test(msg), msg);
    await yes();
    check('P14 actual dates kept: +1,000 on 10 Sep, −600 on 5 Oct', rows(mohan) === '1000@10 Sep,-600@05 Oct', rows(mohan));
    const sep = await payrollRow('Mohan', 8), oct = await payrollRow('Mohan', 9);
    check('P15 monthly treatment: Sept unchanged ("Paid ₹1,000", ₹-1,000); Oct shows the return alone ("Net paid ₹-600", split, ₹3,100)',
      /₹1,000 Paid/i.test(sep) && /₹-1,000/.test(sep) && !/Wapas/.test(sep)
      && /₹-600 Net paid/i.test(oct) && /Diya ₹0 · ↩ Wapas mila ₹600 · Net paid ₹-600 \(Oct 2026\)/.test(oct) && /₹3,100/.test(oct), { sep, oct });
    await page.evaluate(() => { viewMonth = new Date(2026, 9, 1); detailGroup = 'shop'; selectedDetailStaff = 'stf_mohan'; switchTab('detail'); renderStaffDetail(); });
    await page.waitForTimeout(300);
    await shot(page, '7-details-mohan-oct');

    // ---- records not confirmed: a payment still waiting to upload
    page.ctl.failPaymentWrites = true;
    await addPayment(page, 'Kamal 100', '2026-10-13');
    msg = await ask(kamal, 50, '2026-10-13');
    check('P16 unconfirmed month: only staff, amount and date, with a clear limitation; no figures',
      /^Kamal \(Shop\) se ₹50 wapas mila · 13 Oct 2026/.test(msg) && /⚠ Oct 2026 ke records abhi poore confirm nahi ho sake, isliye hisab nahi dikha rahe/.test(msg)
      && !/Kamai|Net paid|dena baaki/.test(msg), msg);
    await shot(page, '8-confirm-unconfirmed');
    await page.evaluate(() => closeConfirm(true));
    page.ctl.failPaymentWrites = false; await uploaded(page);
    // the phone's month disagrees with the database: a Kamal payment saved by name only
    // (no worker id) matches Kamal on the phone but not in the database
    sql(`insert into staff_payment (owner_id, legacy_id, staff_id, name, amount, note, date, month_key, device)
         values ('${OWNER}', 'pay_kamal_byname', null, 'Kamal', 75, '', '${L.istTs('2026-10-09')}', '2026-10', 'test')`);
    await page.evaluate(() => window.__SP_STORE__.pull());
    msg = await ask(kamal, 50, '2026-10-13');
    check('P16b phone and database differ for Oct: figures held back with the same limitation', /records abhi poore confirm nahi ho sake/.test(msg) && !/Kamai|Net paid/.test(msg), msg);
    await page.evaluate(() => closeConfirm(true));
    sql(`delete from staff_payment where legacy_id = 'pay_kamal_byname'`);
    await page.evaluate(() => window.__SP_STORE__.pull());

    // ---- duplicate-save protection and recovery for a Shop worker
    net.statusDown = true; page.ctl.dropReply = 'staff_receipt_add';
    msg = await ask(kamal, 50, '2026-10-13'); await page.click('#confirmYesBtn'); await page.waitForTimeout(1500);
    const again = await ask(kamal, 50, '2026-10-13');
    check('P17 reply lost + status down: a second Kamal receipt is blocked; exactly one in the ledger',
      again === null && /Kamal ki pichli entry abhi confirm nahi hui/.test(await txt(page, '#rcvErr'))
      && Number(sql(`select count(*) from staff_payment where staff_id = '${kamal}' and amount < 0`)) === 1, rows(kamal));
    net.statusDown = false;
    await page.click('#rcvCheck'); await page.waitForTimeout(1500);
    check('P18 recovery with the original id: "✓ Saved: Kamal (Shop) se ₹50 …", still one receipt', /✓ Saved: Kamal \(Shop\) se ₹50 wapas mila · 13 Oct 2026/.test(await txt(page, '#rcvMsg'))
      && Number(sql(`select count(*) from staff_payment where staff_id = '${kamal}' and amount < 0`)) === 1);

    // ---- correcting a Shop receipt keeps it a receipt
    const rid = sql(`select legacy_id from staff_payment where staff_id = '${ramesh}' and amount < 0`);
    await page.waitForFunction(id => !!SPD3.findPay(id), rid, { timeout: 10000 });
    await page.evaluate(id => SPD3.openCorrect(id), rid);
    const head = await txt(page, '#d3CorrModal');
    await page.fill('#d3CorrAmt', '500'); await page.fill('#d3CorrWhy', 'galat likha'); await page.click('#d3CorrGo');
    await page.waitForFunction(() => !document.getElementById('d3CorrModal').classList.contains('show'), null, { timeout: 15000 });
    check('P19 Shop receipt correction: receipt wording; 600 → 500 stored −500', /Correct this receipt \(wapas mila\)/.test(head) && /Ramesh · ↩ Wapas mila ₹600 · 12 Oct 2026/.test(head)
      && rows(ramesh) === '3000@03 Oct,-500@12 Oct', { head, r: rows(ramesh) });
    check('P20 no page errors', page.errors.length === 0, page.errors);
  } catch (e) { check('no exception', false, e.stack); }
  await browser.close(); srv.close();
  console.log(`\n${L.PASS.length} passed, ${L.FAIL.length} failed - Shop receipts phone`);
  process.exit(L.FAIL.length ? 1 : 0);
})();
