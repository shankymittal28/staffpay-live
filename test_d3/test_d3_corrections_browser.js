// Real phone UI regressions for the approved D3 review corrections. Uses only
// the disposable database/API; expected money amounts are hand-calculated.
const path = require('path'), { chromium } = require('playwright');
const L = require('./lib.js'), { phone, txt, idle, uploaded, addPayment, openHisab, serve } = require('./phone.js');
const T = L.token(L.OWNER);
const waitSummary = page => page.waitForFunction(() => /Totals (checked|are from|unavailable)/.test(document.getElementById('summaryD3').textContent));

(async () => {
  const srv = await serve(path.join(__dirname, '..'), 8823);
  const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
  try {
    L.reset(); L.setToday('2026-10-11');
    const big = L.emp({ name: 'Big', legacy: 'stf_big', rate: 2000, obDate: '2026-10-04' });
    const remote = L.emp({ name: 'OnlyOnServer', legacy: 'stf_remote', rate: 100, obDate: '2026-10-04' });
    // 1,200 x 10 = 12,000 plus 500 = 12,500. The phone gets only 1,000 rows.
    L.sql(`insert into staff_payment(owner_id, legacy_id, staff_id, staff_legacy_id, name, amount, date, month_key)
      select '${L.OWNER}', 'cap_' || i, '${big}', 'stf_big', 'Big', 10, '2026-10-08T12:00:00+05:30', '2026-10'
      from generate_series(1,1200) i;
      insert into staff_payment(owner_id, legacy_id, staff_id, staff_legacy_id, name, amount, date, month_key)
      values('${L.OWNER}', 'cap_remote', '${remote}', 'stf_remote', 'OnlyOnServer', 500, '2026-10-09T12:00:00+05:30', '2026-10')`);
    let page = await phone(browser);
    await page.evaluate(() => { viewMonth = new Date(2026, 9, 5); summaryGroup = 'workshop'; switchTab('summary'); });
    await waitSummary(page);
    const cards = await page.$$eval('#staffList .staff-card', es => es.map(e => e.textContent.replace(/\s+/g, ' ')));
    const summary = await txt(page, '#summaryD3');
    L.check('CB1 capped phone: banner 12500, Big card 12000, server-only worker 500, partial list disclosed',
      (await page.textContent('#bannerTotal')) === '₹12,500' && cards.length === 2
      && cards.some(t => /Big/.test(t) && /₹12,000/.test(t) && /1200 payments/.test(t))
      && cards.some(t => /OnlyOnServer/.test(t) && /₹500/.test(t)) && /showing 1000 of 1201/.test(summary), { cards, summary });
    await page.fill('#searchBar', 'big'); await waitSummary(page);
    L.check('CB2 search keeps complete Big total 12000 and partial-list warning',
      (await page.textContent('#bannerTotal')) === '₹12,000'
      && /₹12,000/.test(await txt(page, '#staffList')) && /showing 1000 of 1200/.test(await txt(page, '#summaryD3')));
    await page.fill('#searchBar', 'onlyonserver'); await waitSummary(page);
    L.check('CB3 search finds the worker absent from the capped payment list',
      (await page.textContent('#bannerTotal')) === '₹500' && /OnlyOnServer/.test(await txt(page, '#staffList'))
      && /showing 0 of 1/.test(await txt(page, '#summaryD3')));
    await page.evaluate(() => {
      const n = window.__SP_NET__, original = n.rpc;
      n.rpc = function (fn, p) { return fn === 'staff_workshop_payments' ? Promise.reject(new Error('offline')) : original.call(this, fn, p); };
      renderSummary();
    });
    await waitSummary(page);
    L.check('CB4 failed complete-totals request clears old amounts and says unavailable',
      (await page.textContent('#bannerTotal')) === 'unavailable' && !(await page.$('#staffList .staff-card'))
      && /Totals unavailable/.test(await txt(page, '#summaryD3')));
    await page.close();

    L.reset(); L.setToday('2026-10-11');
    const sonu = L.emp({ name: 'Sonu', legacy: 'stf_sonu', rate: 800, obDate: '2026-10-04' });
    L.attRange(sonu, '2026-10-05', 'PPHPPHA'); // 5 x 800 = 4000
    await L.upsert(T, 'staff_payment', [
      L.payRow({ id: 1760000000001, staff: sonu, staffLegacy: 'stf_sonu', name: 'Sonu', amount: 1000, date: L.istTs('2026-10-06') }),
      L.payRow({ id: 1760000000002, staff: sonu, staffLegacy: 'stf_sonu', name: 'Sonu', amount: 500, date: L.istTs('2026-10-09') })]);
    page = await phone(browser);
    await openHisab(page, 'stf_sonu');
    await page.check('#d3s_stf_sonu'); await page.check('#d3a_stf_sonu');
    await page.click('#d3h_stf_sonu .btn-hisab-settle');
    await page.waitForFunction(() => /Cash given at settlement \(Sun, 11 Oct\)/.test(document.getElementById('d3h_stf_sonu').innerText));
    const settled = await txt(page, '#d3h_stf_sonu');
    L.check('CB5 paid card: pre-settlement requirement 2500, paid 2500, cash still to give 0',
      /Balance before settlement cash ₹0 \+ ₹4,000 − ₹1,500 = ₹2,500 — shop owes worker/.test(settled)
      && /Status Settled — hisab closed for this week; any balance carries to the next week/.test(settled) && /Balance at end of Sun, 11 Oct ₹0/.test(settled), settled);
    await page.evaluate(() => { viewMonth = new Date(2026, 9, 5); openStaffDetail('stf_sonu'); });
    await page.waitForFunction(() => /AAJ TAK KA HISAB/.test(document.getElementById('d3Detail').innerText));
    let wa = await page.evaluate(() => buildHisabText('stf_sonu'));
    L.check('CB6 worker WhatsApp: payments 1,500 + 2,500 = 4,000 counted once; AAJ TAK 0 (barabar)',
      /IS HAFTE PAYMENT LIYE: ₹4,000\n/.test(wa) && /AAJ TAK KA HISAB: ₹0 — hisab barabar/.test(wa), wa);

    // Force a fresh card in one render. A report request must start after its
    // DOM is installed; boot-time hidden renders must not mask the ordering.
    const beforeCalls = page.ctl.rpcLog.filter(x => x === 'staff_workshop_report').length;
    await page.evaluate(() => { viewMonth = new Date(2026, 9, 1); document.getElementById('payrollList').innerHTML = ''; switchTab('payroll'); });
    await page.waitForFunction(() => /Hisab balance till/.test(document.getElementById('d3p_stf_sonu').innerText));
    L.check('CB7 newly inserted Payroll card requests and loads its report on the first render',
      page.ctl.rpcLog.filter(x => x === 'staff_workshop_report').length > beforeCalls
      && /₹4,000 PAID/i.test(await txt(page, '#d3p_stf_sonu')));

    page.ctl.failPaymentWrites = true;
    await addPayment(page, 'Sonu 300', '2026-10-10');
    // WhatsApp cache was populated before the pending payment existed.
    wa = await page.evaluate(() => { viewMonth = new Date(2026, 9, 5); return buildHisabText('stf_sonu'); });
    L.check('CB8 cached WhatsApp immediately withholds balances when this phone queues a payment',
      /not yet uploaded/.test(wa) && !/HAAZRI|PAYMENT LIYE|KA HISAB|PICHLA ADVANCE|₹/.test(wa), wa);
    await openHisab(page, 'stf_sonu');
    const pendingCard = await txt(page, '#d3h_stf_sonu');
    L.check('CB9 pending payments hide Hisab amounts and settlement actions before any tap',
      /not yet uploaded/.test(pendingCard) && !/Balance at end of|Balance so far|Weekly earnings|Balance before settlement cash/.test(pendingCard)
      && !(await page.$('#d3h_stf_sonu .btn-hisab-settle')) && !/Change amount/.test(pendingCard)
      && (await page.textContent('#hisabGiven')) === 'unavailable' && (await page.textContent('#hisabEarned')) === 'unavailable', pendingCard);
    await page.evaluate(() => { viewMonth = new Date(2026, 9, 5); openStaffDetail('stf_sonu'); });
    await page.waitForFunction(() => /not yet uploaded/.test(document.getElementById('d3Detail').innerText));
    L.check('CB10 Details also withholds the cached balance during pending uploads',
      !/HAAZRI|PAYMENT LIYE|KA HISAB|PICHLA ADVANCE|₹/.test(await txt(page, '#d3Detail')));
    await page.evaluate(() => { viewMonth = new Date(2026, 9, 1); switchTab('payroll'); });
    await page.waitForFunction(() => /not yet uploaded/.test(document.getElementById('d3p_stf_sonu').innerText));
    L.check('CB11 Payroll withholds balance and replaces any old badge while a payment waits',
      !/Hisab balance till|EARNED|PAID/.test(await txt(page, '#d3p_stf_sonu'))
      && (await page.textContent('#d3pb_stf_sonu')) === 'unavailable');
    page.ctl.failPaymentWrites = false;
    const drained = await uploaded(page);
    await openHisab(page, 'stf_sonu');
    const afterUpload = await txt(page, '#d3h_stf_sonu');
    // 4000 - 1000 - 500 - 2500 - 300 = -300. No stale zero balance.
    L.check('CB12 after upload the confirmed report counts 300 exactly once and shows worker owes 300',
      drained && /Total advances ₹1,800/.test(afterUpload)
      && /Balance at end of Sun, 11 Oct ₹300 — worker owes shop/.test(afterUpload) && !/not yet uploaded/.test(afterUpload), afterUpload);
    L.check('CB13 no browser errors', page.errors.length === 0, page.errors);
    await page.close();
  } finally { await browser.close(); srv.close(); }
  console.log('\n' + L.PASS.length + ' passed, ' + L.FAIL.length + ' failed - targeted D3 phone regressions');
  process.exitCode = L.FAIL.length ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 1; });
