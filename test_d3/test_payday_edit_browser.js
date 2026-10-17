/*
 * Payday "Badlo" (edit a saved week) on a 412x915 phone against the disposable
 * database. Edits go through the existing controlled settlement change route
 * with the settlement version captured when editing starts.
 *
 *   test_d3/env.sh up && node test_d3/test_payday_edit_browser.js [screenshot-dir]
 *
 * Week 12-18 Oct 2026 (W2), phone clock Sun 18 Oct 18:00 IST, Rs 300/day.
 * Old Hisab at the end of Sun 11 Oct unless stated. Amounts worked by hand.
 */
const path = require('path');
const { chromium } = require('playwright');
const L = require('./lib.js'), { check, sql, OWNER } = L;
const { phone, txt, serve } = require('./phone.js');
const T = L.token(OWNER), SHOTS = process.argv[2] || null, W = '2026-10-12', W1 = '2026-10-05', NOW = '2026-10-18T18:00:00+05:30';
const n = x => Number(x);
L.addDays = (d, k) => new Date(new Date(d + 'T00:00:00Z').getTime() + k * 864e5).toISOString().slice(0, 10);
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png') }); };
const stl = s => sql(`select coalesce(string_agg(legacy_id || '=' || amount::int, ',' order by legacy_id), '') from staff_payment where legacy_id like 'stl\\_${s}\\_%'`);
const ver = (s, m) => sql(`select version || ':' || state || ':' || cash_paid::int from staff_settlement where legacy_id = 'stl_${s}_${m || W}'`);
const report = async (s, m) => (await L.rpc(T, 'staff_workshop_report', { staff_id: s, to: L.addDays(m || W, 6) })).weeks.find(w => w.monday === (m || W));
async function api(s, action, extra, m) {                    // set-up and "another phone": the same call a phone makes
  const w = await report(s, m);
  return L.rpc(T, 'staff_settlement_apply', Object.assign({ op_id: L.uuid(), action, staff_id: s, week: m || W,
    expected_version: w.settlement ? w.settlement.version : null, cash: 0, sunday_done: true, advances_complete: true,
    seen: { days: n(w.days_worked), rate: n(w.rate), earned: n(w.earned), previous: n(w.previous), advances: n(w.advances_total) } }, extra || {}));
}
async function open(page, day) {
  await page.setViewportSize({ width: 412, height: 915 });
  await page.evaluate(d => { hisabWeek = new Date(2026, 9, d); switchTab('hisab'); }, day || 12);
  await page.waitForFunction(m => { const h = document.getElementById('pdWeek'); return h && h.dataset.monday === m && document.querySelector('#d3Payday table.pd'); },
    (day || 12) === 12 ? W : W1, { timeout: 15000 });
}
const row = (page, l) => txt(page, '#pd_' + l);
const val = (page, id) => page.inputValue('#' + id);
const waitRow = (page, l, re) => page.waitForFunction(([x, r]) => new RegExp(r).test((document.getElementById('pd_' + x) || {}).innerText || ''), [l, re], { timeout: 15000 });
async function edit(page, l) { await page.click('#pde_' + l); await page.waitForSelector('#pdc_' + l, { timeout: 15000 }); }
async function confirmSave(page, l) {
  await page.click('#pds_' + l);
  for (const k of [1, 2, 3]) await page.check('#pdk' + k + '_' + l);
  await page.click('#pdok_' + l);
}

(async () => {
  const srv = await serve(path.join(__dirname, '..'), 8871);
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  try {
    L.reset(); L.setToday('2026-10-18');
    const mk = (name, ob, obDate, pattern) => { const s = L.emp({ name, rate: 300, ob, obDate: obDate || '2026-10-11', legacy: 'stf_' + name.toLowerCase() }); L.attRange(s, obDate === '2026-10-04' ? W1 : W, pattern || 'PPPPPAA'); return s; };
    const ramu = mk('Ramu', -6100), shyam = mk('Shyam', 0), kalu = mk('Kalu', 0), raju = mk('Raju', 0), duo = mk('Duo', 0), lost = mk('Lost', 0), corr = mk('Corr', 0);
    const mohan = mk('Mohan', 0, '2026-10-04', 'PPPPPPP' + 'PPPPPAA');          // W1 7 x 300 = 2,100; W2 1,500
    // saved weeks to edit (each earns 1,500 in W2)
    for (const [s, c] of [[ramu, 500], [shyam, 1500], [kalu, 500], [raju, 1000], [duo, 1000], [lost, 1000], [corr, 1000]]) {
      const a = await api(s, 'settle', { cash: c }); if (!a.ok) throw new Error('setup ' + JSON.stringify(a));
    }
    check('E0 set-up: Mohan W1 2,100 and W2 1,500 settled', (await api(mohan, 'settle', { cash: 2100 }, W1)).ok && (await api(mohan, 'settle', { cash: 1500 })).ok);

    const page = await phone(browser, { port: 8871, now: NOW });
    check('E1 the new build is served', /rc19-merge-/.test(await page.content()));
    await open(page);

    // ---- Ramu: old advance 6,100, earned 1,500, saved cash 500 -> edit to 700
    let t = await row(page, 'stf_ramu');
    check('E2 saved row shows actual figures and a "Badlo" button', /✓ Diya/.test(t) && /Badlo/.test(t) && /₹5,100 aap par baaki/.test(t), t);
    await edit(page, 'stf_ramu');
    t = await row(page, 'stf_ramu');
    // KITNA KAATNA from cash 500 = min(6,100, 1,500 - 500) = 1,000
    check('E3 editing: cash pre-filled 500, deduction 1,000, "Badal rahe hain · pehle ₹500", Save off until the cash changes',
      await val(page, 'pdc_stf_ramu') === '500' && await val(page, 'pdd_stf_ramu') === '1000' && /Badal rahe hain · pehle ₹500/.test(t)
      && await page.$eval('#pds_stf_ramu', b => b.disabled), t);
    check('E4 only CASH DIYA and KITNA KAATNA are editable (attendance, rate, carried balance are text)',
      await page.$$eval('#pd_stf_ramu input', a => a.map(i => i.id).sort().join(',')) === 'pdc_stf_ramu,pdd_stf_ramu');
    await page.fill('#pdc_stf_ramu', '700');
    // deduction min(6,100, 1,500 - 700) = 800; final -6,100 + 1,500 - 700 = -5,300
    check('E5 cash 700 -> deduction 800, preview 5,300 aap par baaki', await val(page, 'pdd_stf_ramu') === '800' && /≈ ₹5,300 aap par baaki/.test(await row(page, 'stf_ramu')));
    for (const [id, bad] of [['pdc_stf_ramu', 'abc'], ['pdc_stf_ramu', ''], ['pdd_stf_ramu', '-5'], ['pdd_stf_ramu', '1,000']]) {
      await page.fill('#' + id, bad);
      check('E6 invalid ' + (id.startsWith('pdc') ? 'cash' : 'deduction') + ' "' + bad + '" blocks Save', await page.$eval('#pds_stf_ramu', b => b.disabled));
    }
    await page.fill('#pdc_stf_ramu', '700');
    await page.evaluate(() => window.scrollTo(0, document.getElementById('pd_stf_ramu').getBoundingClientRect().top + window.scrollY - 160));
    await shot(page, '1-editing-ramu');
    await page.click('#pds_stf_ramu');
    const ask = await txt(page, '#pda_stf_ramu');
    check('E7 confirmation names the Sunday and the old amount; it is a change, not a new settlement',
      /Ramu · Ravivar 18 Oct 2026 · ₹700 \(pehle ₹500\)/.test(ask) && /Ravivar 18 Oct 2026 ko asal mein ₹700 diya tha \(pehle ₹500 likha tha\)/.test(ask)
      && await page.$eval('#pda_stf_ramu .pd-confirm', e => e.dataset.action) === 'change', ask);
    await shot(page, '2-edit-confirmation');
    for (const k of [1, 2, 3]) await page.check('#pdk' + k + '_stf_ramu');
    await page.click('#pdok_stf_ramu');
    await waitRow(page, 'stf_ramu', '✓ Diya');
    t = await row(page, 'stf_ramu');
    check('E8 saved: the same payment record now 700 (version 2); closing -5,300; row shows 800 recovered, 5,300 aap par baaki',
      stl(ramu) === 'stl_' + ramu + '_2026-10-12_v1=700' && ver(ramu) === '2:settled:700' && n((await report(ramu)).closing) === -5300
      && /₹800/.test(t) && /₹700/.test(t) && /₹5,300 aap par baaki/.test(t), { p: stl(ramu), v: ver(ramu), t });
    const card = await txt(page, '#d3h_stf_ramu');
    check('E9 detailed card and Details agree (cash 700; 5,300)', /Cash given at settlement \(Sun, 18 Oct\) ₹700/.test(card) && /₹5,300 — worker owes shop/.test(card)
      && await (async () => { await page.evaluate(() => { viewMonth = new Date(2026, 9, 14); openStaffDetail('stf_ramu'); });
        await page.waitForFunction(() => /AAJ TAK KA HISAB/.test((document.getElementById('d3Detail') || {}).innerText || ''), null, { timeout: 15000 });
        const d = await txt(page, '#d3Detail'); return /IS HAFTE PAYMENT LIYE ₹700/.test(d) && /AAJ TAK KA HISAB ₹5,300 — aap par baaki/.test(d); })(), card);
    await open(page);

    // ---- Shyam: saved 1,500 -> edit to 0: payment voided and kept on record
    await edit(page, 'stf_shyam'); await page.fill('#pdc_stf_shyam', '0');
    await page.click('#pds_stf_shyam');
    check('E10 zero edit wording: "asal mein koi cash nahi diya tha (pehle ₹1,500 likha tha)"', /Ravivar 18 Oct 2026 ko asal mein koi cash nahi diya tha \(pehle ₹1,500 likha tha\)/.test(await txt(page, '#pda_stf_shyam')));
    for (const k of [1, 2, 3]) await page.check('#pdk' + k + '_stf_shyam');
    await page.click('#pdok_stf_shyam'); await waitRow(page, 'stf_shyam', '✓ Diya');
    check('E11 edit to 0: payment removed with a kept record, settlement stays (cash 0), 1,500 dukaan par baaki',
      stl(shyam) === '' && sql(`select count(*) from staff_payment_void where staff_id = '${shyam}'`) === '1' && ver(shyam) === '2:settled:0'
      && /₹1,500 dukaan par baaki/.test(await row(page, 'stf_shyam')));

    // ---- Kalu: refresh while another phone changes the settlement
    await edit(page, 'stf_kalu'); await page.fill('#pdc_stf_kalu', '600');       // this phone captured version 1 (cash 500)
    const other = await api(kalu, 'change', { cash: 800 });                         // another phone: 500 -> 800 (version 2)
    check('E12 another phone changed Kalu to 800 (version 2)', other.ok && ver(kalu) === '2:settled:800', other);
    await page.evaluate(() => renderHisab());                                       // a routine refresh
    await waitRow(page, 'stf_kalu', 'Doosre phone ne ye entry badli');
    t = await row(page, 'stf_kalu');
    check('E13 after the refresh: review required ("ab: cash ₹800"), typed 600 kept, Save blocked, nothing overwritten',
      /ab: cash ₹800/.test(t) && await val(page, 'pdc_stf_kalu') === '600' && await page.$eval('#pds_stf_kalu', b => b.disabled) && ver(kalu) === '2:settled:800', t);
    await page.evaluate(() => window.scrollTo(0, document.getElementById('pd_stf_kalu').getBoundingClientRect().top + window.scrollY - 160));
    await shot(page, '3-other-phone-changed-review');
    await page.evaluate(() => SPD3.pdSave('stf_kalu')); await page.waitForTimeout(600);
    check('E14 a direct save while under review does nothing', ver(kalu) === '2:settled:800');
    await page.click('#pdr_stf_kalu');                                              // "Theek hai": owner has seen 800
    await page.waitForFunction(() => /pehle ₹800/.test((document.getElementById('pd_stf_kalu') || {}).innerText || ''), null, { timeout: 15000 });
    await confirmSave(page, 'stf_kalu'); await waitRow(page, 'stf_kalu', '✓ Diya');
    check('E15 after "Theek hai" the owner\'s 600 saves on top of version 2 (now version 3, 600)', ver(kalu) === '3:settled:600' && stl(kalu).endsWith('=600'), ver(kalu));

    // ---- Raju: no refresh at all — the stale page still sends its captured version and is refused
    await edit(page, 'stf_raju'); await page.fill('#pdc_stf_raju', '1200');
    await api(raju, 'change', { cash: 900 });                                       // another phone: version 2, 900
    await page.click('#pds_stf_raju');
    for (const k of [1, 2, 3]) await page.check('#pdk' + k + '_stf_raju');
    await page.click('#pdok_stf_raju');
    await waitRow(page, 'stf_raju', 'Not saved|Doosre phone');
    check('E16 stale page without refresh: its old version is refused; the other phone\'s 900 stays', ver(raju) === '2:settled:900' && stl(raju).endsWith('=900'), ver(raju));
    check('E17 the row then asks for review and keeps the typed 1,200', /Doosre phone ne ye entry badli/.test(await row(page, 'stf_raju')) && await val(page, 'pdc_stf_raju') === '1200');

    // ---- Duo: two phones edit at the same time from version 1
    const p2 = await phone(browser, { port: 8871, now: NOW }); await open(p2);
    await edit(page, 'stf_duo'); await page.fill('#pdc_stf_duo', '1100');
    await edit(p2, 'stf_duo'); await p2.fill('#pdc_stf_duo', '1300');
    await confirmSave(page, 'stf_duo'); await waitRow(page, 'stf_duo', '✓ Diya');
    await confirmSave(p2, 'stf_duo');
    await p2.waitForFunction(() => /Not saved|Doosre phone/.test((document.getElementById('pd_stf_duo') || {}).innerText || ''), null, { timeout: 15000 });
    check('E18 two phones: first change wins (1,100, version 2); the second is refused; one payment record', ver(duo) === '2:settled:1100' && stl(duo).split(',').length === 1 && stl(duo).endsWith('=1100'), stl(duo));
    await p2.close();

    // ---- Lost: the reply to the change is lost on the way back
    await edit(page, 'stf_lost'); await page.fill('#pdc_stf_lost', '1250');
    page.ctl.dropReply = 'staff_settlement_apply';
    await confirmSave(page, 'stf_lost'); await waitRow(page, 'stf_lost', '✓ Diya');
    check('E19 lost reply: confirmed after checking; changed once (version 2, 1,250)', ver(lost) === '2:settled:1250' && stl(lost).endsWith('=1250'), ver(lost));

    // ---- Corr: the saved entry is corrected on another phone while this phone edits it
    await edit(page, 'stf_corr'); await page.fill('#pdc_stf_corr', '1100');
    const cc = await api(corr, 'correct', { reason: 'mistake', cash_not_given: true });
    await page.evaluate(() => renderHisab());
    await waitRow(page, 'stf_corr', 'Badlav band');
    check('E20 corrected elsewhere: editing stops with an explanation; no change saved', cc.ok && ver(corr) === '2:corrected:0' && !(await page.$('#pdx_stf_corr')), ver(corr));

    // ---- Mohan: editing an earlier week updates the later week's carried balance
    await open(page, 5);
    await edit(page, 'stf_mohan'); await page.fill('#pdc_stf_mohan', '1600');
    await confirmSave(page, 'stf_mohan'); await waitRow(page, 'stf_mohan', '✓ Diya');
    await open(page, 12);
    t = await row(page, 'stf_mohan');
    // W1: 2,100 - 1,600 = 500 carried; W2: 500 + 1,500 - 1,500 = 500 dukaan par baaki
    check('E21 earlier-week edit (2,100 -> 1,600): W2 PURANA 500 and FINAL 500 dukaan par baaki', /₹500 dukaan par baaki/.test(t) && n((await report(mohan)).closing) === 500 && ver(mohan, W1) === '2:settled:1600', t);

    // ---- week switching during an edit: the draft stays with its week; a save after switching does nothing
    await edit(page, 'stf_ramu'); await page.fill('#pdc_stf_ramu', '650');
    await page.evaluate(() => { hisabWeek = new Date(2026, 9, 5); renderHisab(); SPD3.pdSave('stf_ramu'); });
    await page.waitForTimeout(1200);
    check('E22 save pressed while switching weeks changes nothing', ver(ramu) === '2:settled:700');
    await open(page, 12);
    check('E23 back on the week, the edit draft (650) is still there', await val(page, 'pdc_stf_ramu') === '650' && /Badal rahe hain · pehle ₹700/.test(await row(page, 'stf_ramu')));
    await page.click('#pdx_stf_ramu');                                              // "Chhodo"
    await waitRow(page, 'stf_ramu', 'Badlo');
    check('E24 "Chhodo" ends the edit without saving', ver(ramu) === '2:settled:700' && !(await page.$('#pdc_stf_ramu')));
    check('E25 no page errors', page.errors.length === 0, page.errors);
    await page.close();
  } finally { await browser.close(); srv.close(); }
  console.log('\n' + L.PASS.length + ' passed, ' + L.FAIL.length + ' failed - Payday edit');
  process.exit(L.FAIL.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
