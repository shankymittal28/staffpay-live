/*
 * One worker, one record (A1) on a 390x844 phone, synthetic data only.
 *
 *   test_d3/env.sh up && node test_d3/test_identity_browser.js
 *
 * Clock Wed 14 Oct 2026. Rs 500/day Shop staff.
 *   Raju R1  - the existing record (the Raju everyone knows)
 *   Raju R2  - the same name arriving from an older/offline page: unresolved
 *   Mohan    - unrelated, 1 day Present, nothing paid -> Rs 500 payable throughout
 *   Kamal K1/K2 - a second same-name pair, used for "same person"
 */
const path = require('path');
const { chromium } = require('playwright');
const L = require('./lib.js'), { check, sql, OWNER } = L;
const { phone, txt, serve } = require('./phone.js');
const T = L.token(OWNER), NOW = '2026-10-14T11:00:00+05:30';
const pageRow = (legacy, name) => L.upsert(T, 'staff_employee', [{ owner_id: OWNER, legacy_id: legacy, name, work_group: 'shop', phone: '', active: true, salary: 500, wage_type: 'daily', opening_balance: 0, source: 'staff', device: 'old-page' }]);
const idOf = legacy => sql(`select id from staff_employee where legacy_id = '${legacy}'`);
const count = name => Number(sql(`select count(*) from staff_employee where staffpay_d3.name_key(name) = staffpay_d3.name_key('${name}')`));

(async () => {
  const srv = await serve(path.join(__dirname, '..'), 8906);
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  try {
    L.reset(); L.setToday('2026-10-14');
    const r1 = L.emp({ name: 'Raju', group: 'shop', wage: 'daily', rate: 500, legacy: 'stf_raju1' });
    const mohan = L.emp({ name: 'Mohan', group: 'shop', wage: 'daily', rate: 500, legacy: 'stf_mohan' });
    const k1 = L.emp({ name: 'Kamal', group: 'shop', wage: 'daily', rate: 375, legacy: 'stf_kamal1' });
    await pageRow('stf_raju2', 'Raju'); await pageRow('stf_kamal2', 'Kamal');
    const r2 = idOf('stf_raju2'), k2 = idOf('stf_kamal2');
    L.att(r1, '2026-10-13', 'P');                                   // R1: 13 Oct Present
    L.att(r2, '2026-10-12', 'P');                                   // test 2: a day that exists only on R2
    L.att(mohan, '2026-10-13', 'P');
    await L.upsert(T, 'staff_payment', [Object.assign(L.payRow({ id: 1761000000001, name: 'Raju', amount: 500, date: L.istTs('2026-10-13') }), { staff_id: null, staff_legacy_id: 'stf_raju2' })]);
    check('S0 set-up: R2 and K2 arrived from a page and are unresolved; the ₹500 payment sits on R2',
      sql(`select string_agg(identity_status, ',') from staff_employee where id in ('${r2}', '${k2}')`) === 'unresolved,unresolved'
      && sql(`select staff_id from staff_payment where legacy_id = '1761000000001'`) === r2);
    const page = await phone(browser, { port: 8906, now: NOW });
    check('S1 the new build is served (rc18-identity-20261016)', /rc18-identity-20261016/.test(await page.content()));
    const payroll = async () => { await page.evaluate(() => { viewMonth = new Date(2026, 9, 1); switchTab('payroll'); renderPayroll(); }); await page.waitForTimeout(300); };
    const bal = legacy => txt(page, '#shpb_' + legacy);

    // ---- test 1 and 4: R1 earns 500, 500 was paid on R2; Mohan unaffected
    await payroll();
    const total = await txt(page, '#payrollBalanceTotal');
    check('T1 test 1: neither Raju shows a payable balance (R1 ₹500 earned, ₹500 paid on R2): both "On hold", earnings hidden',
      /On hold/.test(await bal('stf_raju1')) && /On hold/.test(await bal('stf_raju2')) && /pehchaan|Staff tab/i.test(await txt(page, '#shph_stf_raju1')), { a: await bal('stf_raju1'), b: await bal('stf_raju2') });
    check('T2 test 1: the payable total holds only Mohan\'s ₹500 (no second ₹500 for Raju) and says what is on hold',
      /^₹500 · 4 shop on hold/.test(total), total);
    check('T3 the ₹500 payment stays visible on R2\'s own row (nothing hidden, moved or deducted by name)',
      /₹500/.test(await page.$eval('#shpb_stf_raju2', e => e.closest('.payroll-row').textContent)) && sql(`select staff_id from staff_payment where legacy_id = '1761000000001'`) === r2);
    check('T4 test 4: unrelated Mohan shows ₹500 payable with no hold', (await bal('stf_mohan')) === '₹500' && !(await page.$('#shph_stf_mohan')));

    // ---- test 2: a day exists only on R2; R1's incomplete wages are not final
    await page.evaluate(() => { viewMonth = new Date(2026, 9, 1); openStaffDetail('stf_raju1'); });
    await page.waitForSelector('#shopDetailBalance', { timeout: 8000 });
    const kp = await page.$eval('#shopDetailBalance', e => { const c = e.closest('.banner').parentElement; return [...c.querySelectorAll('.detail-kpi')].map(k => k.textContent.trim()).join('|'); });
    check('T5 test 2: R1 Details show its own Present day but no final balance or earnings ("On hold", "—")',
      /On hold/.test(await txt(page, '#shopDetailBalance')) && !!(await page.$('#shopDetailHold')) && /^1Present/.test(kp) && /—Earned/.test(kp), kp);
    const wa = await page.evaluate(() => buildHisabText('stf_raju1'));
    check('T6 R1\'s WhatsApp hisab carries no Kamai or Baaki figure, only the hold message', /Hisab roka gaya/.test(wa) && !/Kamai|Baaki balance|Advance chal/.test(wa), wa);
    await page.evaluate(() => { switchTab('add'); SPD3.rcvToggle(true); });
    await page.selectOption('#rcvWho', r1); await page.fill('#rcvAmt', '100'); await page.fill('#rcvDay', '2026-10-13');
    await page.click('#rcvGo'); await page.waitForSelector('#confirmModal.show', { timeout: 8000 });
    const rm = await txt(page, '#confirmMsg'); await page.evaluate(() => closeConfirm(true));
    check('T7 a receipt for R1 shows the existing "not confirmed" message, no earnings or balances', /confirm nahi ho sake/.test(rm) && !/Kamai|dena baaki|zyada diya/.test(rm), rm);

    // ---- roster, delete and near-name payment guards
    await page.evaluate(() => { switchTab('attendance'); renderAttendance(); });
    await page.waitForTimeout(300);
    check('T8 the attendance roster warns beside every held name (Raju, Kamal) and not beside Mohan',
      await page.$$eval('.roster-row', rs => rs.filter(r => r.querySelector('.roster-hold')).map(r => r.dataset.name).sort().join(',')) === 'Kamal,Kamal,Raju,Raju');
    await page.evaluate(() => deleteStaff('Raju'));
    check('T9 removing a held name is refused (removal works by name and would hide both)', !(await page.$('#confirmModal.show')) && /tay karein/.test(await txt(page, '#toast')));
    const before = Number(sql('select count(*) from staff_payment'));
    await page.evaluate(() => { switchTab('add'); document.getElementById('quickEntry').value = 'raju  300'; addEntry(); });
    await page.waitForTimeout(500);
    check('T10 a payment typed as "raju" (spacing/capitals differ) is refused with the real names shown; no payment, no new record',
      /milta-julta/.test(await txt(page, '#toast')) && Number(sql('select count(*) from staff_payment')) === before && count('Raju') === 2);

    // ---- test 3: the explicit decision on the Staff tab
    await page.evaluate(() => { switchTab('staff'); renderStaffMaster(); });
    await page.waitForSelector('#idn_stf_raju2', { timeout: 8000 });
    check('T11 the Staff tab lists each pending decision (Raju R2, Kamal K2) with both choices', !!(await page.$('#idn_stf_raju2 .idn-diff')) && !!(await page.$('#idn_stf_kamal2 .idn-same')));
    await page.click('#idn_stf_raju2 .idn-diff'); await page.waitForSelector('#confirmModal.show');
    await page.click('#confirmYesBtn');
    await page.waitForFunction(() => !document.getElementById('idn_stf_raju2'), null, { timeout: 8000 });
    await payroll();
    check('T12 test 3: after "different people" each Raju is calculated alone: R1 ₹500 payable, R2 earned ₹500 (12 Oct) paid ₹500 = ₹0',
      (await bal('stf_raju1')) === '₹500' && (await bal('stf_raju2')) === '₹0' && sql(`select identity_status from staff_employee where id = '${r2}'`) === 'distinct',
      { a: await bal('stf_raju1'), b: await bal('stf_raju2') });
    check('T13 the total now counts both genuine people and Mohan (₹1,000), with only the Kamal pair on hold', /^₹1,000 · 2 shop on hold/.test(await txt(page, '#payrollBalanceTotal')), await txt(page, '#payrollBalanceTotal'));
    await page.evaluate(() => { switchTab('staff'); renderStaffMaster(); });
    await page.click('#idn_stf_kamal2 .idn-same'); await page.waitForSelector('#confirmModal.show'); await page.click('#confirmYesBtn');
    await page.waitForFunction(() => /milana baaki/.test((document.getElementById('idn_stf_kamal2') || {}).textContent || ''), null, { timeout: 8000 });
    await payroll();
    check('T14 "same person" keeps both Kamal records on hold (no final figure until the reviewed reconciliation)',
      /On hold/.test(await bal('stf_kamal1')) && /On hold/.test(await bal('stf_kamal2')) && sql(`select identity_status from staff_employee where id = '${k2}'`) === 'same');

    // ---- adding staff on the new build: the server decides first
    const addStaffUi = async (name) => {
      await page.evaluate(n => { switchTab('staff'); document.getElementById('staffNameInput').value = n; document.getElementById('staffSalaryInput').value = '500';
        document.getElementById('staffWageTypeInput').value = 'daily'; document.getElementById('staffGroupInput').value = 'shop'; addStaff(); }, name);
    };
    await addStaffUi('mohan '); await page.waitForSelector('#confirmModal.show', { timeout: 8000 });
    const q1 = await txt(page, '#confirmMsg');
    await page.click('#confirmYesBtn'); await page.waitForTimeout(400);
    check('T15 adding "mohan ": the server finds Mohan and asks; "Haan, wahi hai" creates nothing', /pehle se hai[\s\S]*Mohan/.test(q1) && count('Mohan') === 1, q1);
    await addStaffUi('Mohan'); await page.waitForSelector('#confirmModal.show', { timeout: 8000 });
    await page.evaluate(() => closeConfirm(true)); await page.waitForSelector('#confirmModal.show', { timeout: 8000 });
    const q2 = await txt(page, '#confirmMsg');
    check('T16 not the same: a second question must be confirmed before anything is created', /bilkul alag insaan/.test(q2) && count('Mohan') === 1, q2);
    page.ctl.dropReply = 'staff_employee_create';
    await page.click('#confirmYesBtn'); await page.waitForTimeout(800);
    check('T17 the reply is lost: the phone says so and does not claim it was added', /internet/.test(await txt(page, '#toast')));
    await addStaffUi('Mohan'); await page.waitForFunction(() => /pichli baar/.test(document.getElementById('toast').textContent), null, { timeout: 8000 });
    check('T18 trying again after the lost reply resends the same request: the server replays it, no new question, exactly 2 Mohan records',
      count('Mohan') === 2 && Number(sql(`select count(*) from staff_employee where name = 'Mohan' and identity_status = 'distinct'`)) === 1 && !(await page.$('#confirmModal.show')));
    await page.route('**/rest/v1/rpc/staff_employee_create', r => r.abort('internetdisconnected'));
    const ob = await page.evaluate(() => (localStorage.getItem('sp_cloud_outbox') || ''));
    await addStaffUi('Suresh'); await page.waitForTimeout(600);
    check('T19 offline: adding staff says internet is needed; nothing is created or queued, and no local id is invented',
      /internet/.test(await txt(page, '#toast')) && count('Suresh') === 0 && (await page.evaluate(() => localStorage.getItem('sp_cloud_outbox') || '')) === ob
      && !(await page.evaluate(() => JSON.stringify(loadRegistry())).then(s => /Suresh/.test(s))));
    await page.unroute('**/rest/v1/rpc/staff_employee_create');
    await addStaffUi('Suresh'); await page.waitForFunction(() => /Suresh added/.test(document.getElementById('toast').textContent), null, { timeout: 8000 });
    check('T20 online again: a new name is created by the server, once, and shows up', count('Suresh') === 1 && /Suresh/.test(await txt(page, '#staffMasterList')));
    check('T21 no page errors', page.errors.length === 0, page.errors);
  } catch (e) { check('no exception', false, e.stack); }
  await browser.close(); srv.close();
  console.log(`\n${L.PASS.length} passed, ${L.FAIL.length} failed - one worker, one record (phone)`);
  process.exit(L.FAIL.length ? 1 : 0);
})();
