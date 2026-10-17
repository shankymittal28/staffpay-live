/*
 * B - Kamal / Raju repair on real phones (390x844), faithful production copy.
 *
 *   test_d3/env.sh up && RC18_DIR=/var/tmp/rc18wt RC17_DIR=/var/tmp/rc17wt node test_d3/test_merge_b_browser.js
 *
 * Three phones are open BEFORE the repair (stale): this build, live rc18 and
 * rc17. The repair runs. Then a fresh phone on this build must show one
 * Kamal and one Raju with the single-person September figures in Payroll,
 * Details and WhatsApp; the stale phones' money must land once on the
 * retained records and nothing they upload may bring a merged copy back.
 */
const path = require('path');
const { chromium } = require('playwright');
const L = require('./lib.js'), { check, sql } = L;
const { phone, txt, serve, uploaded, addPayment } = require('./phone.js');
const { load, repair } = require('./fixture_b.js');
const NOW = '2026-10-17T11:00:00+05:30';
const K = '206dc20f-8a3b-4aa8-a237-233f735a87ec', KR = 'a5481eba-7c58-45b5-8826-b9f6d79ffa21';
const R = '095233df-7bcb-4ef8-9b87-3afd74e5335e', RR = 'f5c05b72-78ce-48cf-a8ea-85c65de63777';
const KL = 'stf_mtoejiad_25', RL = 'stf_mtoejcua_12';
const BUILDS = [['this build', path.join(__dirname, '..'), 8921, /rc19-merge-20261017/],
                ['rc18', process.env.RC18_DIR || '/var/tmp/rc18wt', 8922, /rc18-identity-20261016/],
                ['rc17', process.env.RC17_DIR || '/var/tmp/rc17wt', 8923, /rc17-shopreceipts-20261014/]];

(async () => {
  const servers = await Promise.all(BUILDS.map(b => serve(b[1], b[2])));
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  try {
    load();
    const stale = [];
    for (const [label, , port, stamp] of BUILDS) {
      const p = await phone(browser, { port, now: NOW }); p.label = label;
      check(label + ' P0 the real ' + label + ' page is served and open before the repair (it sees both Kamal records)',
        stamp.test(await p.content()) && await p.evaluate(() => Object.values((loadRegistry() || {}).staff || {}).filter(e => e.name === 'Kamal').length) === 2);
      stale.push(p);
    }
    const r = repair();
    check('P1 the repair ran (both pairs merged)', r.ok && /"archived": 16/.test(r.out) && /"archived": 15/.test(r.out), r.err);

    // ---- stale phones keep working; their money lands once on the retained records
    let amt = 301;
    for (const p of stale) {
      await addPayment(p, 'Kamal ' + amt, '2026-10-16'); await uploaded(p);
      await uploaded(p);                                                   // a retry of the same queue
      check(p.label + ' P2 a stale phone\'s "Kamal ' + amt + '" is recorded once, on the retained Kamal (by id)',
        sql(`select count(*) || '|' || string_agg(staff_id::text, ',') from staff_payment where amount = ${amt}`) === '1|' + K);
      await p.evaluate(() => { try { saveRegistry(loadRegistry()); } catch (e) {} });   // re-uploads every staff record it holds
      await uploaded(p);
      check(p.label + ' P3 its staff upload cannot bring a merged copy back (still merged, inactive)',
        sql(`select string_agg(active::text || '/' || (merged_into is not null)::text, ',' order by id) from staff_employee where id in ('${KR}', '${RR}')`) === 'false/true,false/true');
      check(p.label + ' P4 no page errors', p.errors.length === 0, p.errors);
      amt++;
    }

    // ---- a fresh phone on this build
    const page = await phone(browser, { port: 8921, now: NOW });
    const people = await page.evaluate(() => empList().filter(e => /^(Kamal|Raju)$/.test(e.name)).map(e => e.label + '=' + e.uuid).sort());
    check('F1 this build shows one Kamal and one Raju (the retained records, no code labels)', JSON.stringify(people) === JSON.stringify(['Kamal=' + K, 'Raju=' + R]), people);
    await page.evaluate(() => { viewMonth = new Date(2026, 8, 1); switchTab('payroll'); renderPayroll(); });
    await page.waitForTimeout(400);
    const prow = name => page.$$eval('.payroll-row', (rs, n) => rs.filter(r => r.querySelector('.payroll-name') && r.querySelector('.payroll-name').textContent.trim() === n).map(r => r.textContent.replace(/\s+/g, ' ').trim()), name);
    const kp = await prow('Kamal'), rp = await prow('Raju');
    check('F2 Payroll Sept: one Kamal row, 26/2/1, earned ₹10,125, balance ₹10,125', kp.length === 1 && /26\/2\/1/.test(kp[0]) && /₹10,125Earned/.test(kp[0]) && /^Kamal .*₹10,125Details/.test(kp[0]), kp);
    check('F3 Payroll Sept: one Raju row, 25/1/3, earned ₹12,750, balance ₹12,750', rp.length === 1 && /25\/1\/3/.test(rp[0]) && /₹12,750Earned/.test(rp[0]) && /^Raju .*₹12,750Details/.test(rp[0]), rp);
    for (const [name, legacy, p, h, a, earned] of [['Kamal', KL, 26, 2, 1, '10,125'], ['Raju', RL, 25, 1, 3, '12,750']]) {
      await page.evaluate(l => { viewMonth = new Date(2026, 8, 1); openStaffDetail(l); }, legacy);
      await page.waitForSelector('#shopDetailBalance', { timeout: 8000 });
      const kpis = await page.$eval('#shopDetailBalance', e => [...e.closest('.banner').parentElement.querySelectorAll('.detail-kpi')].map(k => k.textContent.trim()).join('|'));
      check(`F4 ${name} Details agree: ${p} Present, ${h} Half, ${a} Absent, earned ₹${earned}, balance ₹${earned}`,
        (await txt(page, '#shopDetailBalance')) === '₹' + earned && kpis.startsWith(`${p}Present|${h}Half|${a}Absent|`) && kpis.includes(`₹${earned}Earned`), kpis);
      const wa = await page.evaluate(l => buildHisabText(l), legacy);
      check(`F5 ${name} WhatsApp agrees: Present ${p} | Half ${h} | Absent ${a}, Kamai ₹${earned}, Baaki ₹${earned}`,
        new RegExp(`Present: ${p} \\| Half: ${h} \\| Absent: ${a}`).test(wa) && new RegExp(`Kamai \\(earned\\): ₹${earned}`).test(wa) && new RegExp(`Baaki balance: ₹${earned}`).test(wa) && !/roka/.test(wa), wa);
    }
    await page.evaluate(() => { viewMonth = new Date(2026, 9, 1); switchTab('payroll'); renderPayroll(); });
    await page.waitForTimeout(300);
    const okp = await prow('Kamal');
    check('F6 October: the three stale-phone payments (₹301 + ₹302 + ₹303) all sit on the one Kamal, nothing on a merged copy',
      okp.length === 1 && /₹906/.test(okp[0]) && Number(sql(`select count(*) from staff_payment where staff_id in ('${KR}', '${RR}')`)) === 0, okp);
    await page.evaluate(() => { switchTab('staff'); renderStaffMaster(); });
    check('F7 the Staff tab lists Kamal and Raju once each, with no pending identity decision',
      (await page.$$eval('#staffMasterList .staff-master-row', rs => rs.map(r => r.textContent).filter(t => /\bKamal\b/.test(t)).length)) === 1
      && (await txt(page, '#identityBox')) === '');
    check('F8 no page errors', page.errors.length === 0, page.errors);

    // ---- limitation, recorded: live rc18 reloaded after the repair (before updating to this build)
    const old = await phone(browser, { port: 8922, now: NOW });
    await old.evaluate(() => { viewMonth = new Date(2026, 8, 1); switchTab('payroll'); renderPayroll(); });
    await old.waitForTimeout(400);
    const oldRows = await old.$$eval('.payroll-row', rs => rs.map(r => r.textContent.replace(/\s+/g, ' ').trim()).filter(t => /^Kamal/.test(t)));
    check('L1 rc18 (not yet updated) lists the merged copy as a second, inactive Kamal with ₹0; September money is not doubled (₹10,125 + ₹0)',
      oldRows.length === 2 && oldRows.filter(t => /₹10,125Details/.test(t)).length === 1 && oldRows.filter(t => /₹0Details/.test(t)).length === 1, oldRows);
  } catch (e) { check('no exception', false, e.stack); }
  await browser.close(); servers.forEach(s => s.close());
  console.log(`\n${L.PASS.length} passed, ${L.FAIL.length} failed - B repair (phones)`);
  process.exit(L.FAIL.length ? 1 : 0);
})();
