/*
 * Payday table (Weekly Hisab, workshop) on an Android-sized phone (412x915)
 * against the disposable database.
 *
 *   test_d3/env.sh up && node test_d3/test_payday_browser.js [screenshot-dir]
 *
 * Week 12-18 Oct 2026, phone clock Sun 18 Oct 18:00 IST. Each worker's Old
 * Hisab is the balance at the end of Sun 11 Oct, so this week's "PURANA
 * HISAB" is that Old Hisab. Every expected rupee is worked out in comments.
 */
const path = require('path');
const { chromium } = require('playwright');
const L = require('./lib.js'), { check, sql, OWNER } = L;
const { phone, txt, serve } = require('./phone.js');
const T = L.token(OWNER), SHOTS = process.argv[2] || null, W = '2026-10-12', NOW = '2026-10-18T18:00:00+05:30';
const n = x => Number(x);
const stl = s => sql(`select coalesce(string_agg(amount::int::text, ',' order by legacy_id), '') from staff_payment where legacy_id like 'stl\\_${s}\\_%'`);
const closing = async s => n((await L.rpc(T, 'staff_workshop_report', { staff_id: s, to: '2026-10-18' })).weeks.find(w => w.monday === W).closing);
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png') }); };

async function open(page) {
  await page.setViewportSize({ width: 412, height: 915 });
  await page.evaluate(() => { hisabWeek = new Date(2026, 9, 12); switchTab('hisab'); });
  await page.waitForFunction(() => document.querySelector('#d3Payday table.pd'), null, { timeout: 15000 });
}
const row = (page, l) => txt(page, '#pd_' + l);
const val = (page, id) => page.inputValue('#' + id);
async function type(page, id, v) { await page.fill('#' + id, v); }
async function save(page, l, ticks) {
  await page.click('#pds_' + l);
  for (const k of (ticks || [1, 2, 3])) await page.check('#pdk' + k + '_' + l);
  await page.click('#pdok_' + l);
}
const settledRow = (page, l) => page.waitForFunction(x => /✓ Diya/.test((document.getElementById('pd_' + x) || {}).innerText || ''), l, { timeout: 15000 });

(async () => {
  const srv = await serve(path.join(__dirname, '..'), 8861);
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  try {
    L.reset(); L.setToday('2026-10-18');
    const mk = (name, ob, rate, pattern) => { const s = L.emp({ name, rate, ob, obDate: '2026-10-11', legacy: 'stf_' + name.toLowerCase() }); L.attRange(s, W, pattern); return s; };
    const ramu = mk('Ramu', -6100, 300, 'PPPPPAA');      // 5 x 300 = 1,500; old advance 6,100
    const shyam = mk('Shyam', 0, 300, 'PPPPPAA');        // 1,500; no advance
    const kalu = mk('Kalu', -2000, 300, 'PPPPPAA');      // 1,500; old advance 2,000; 400 paid Wed 14 Oct
    const mohan = mk('Mohan', 800, 300, 'PPPPPAA');      // 1,500; shop already owed 800
    const raju = mk('Raju', -300, 300, 'PPPPPAA');       // 1,500; small old advance 300
    const hari = mk('Hari', 0, 400, 'PHPPPAA');          // 4 + 0.5 = 4.5 x 400 = 1,800
    const bablu = mk('Bablu', 0, 300, 'PPPPPAA');        // 1,500; 2,000 already given this week
    const gopi = mk('Gopi', 0, 300, 'PP-PPAA');          // Wed 14 Oct never marked
    const up = await L.upsert(T, 'staff_payment', [
      L.payRow({ id: 1760300000001, staff: kalu, amount: 400, date: L.istTs('2026-10-14') }),
      L.payRow({ id: 1760300000002, staff: bablu, amount: 2000, date: L.istTs('2026-10-13') })]);
    check('Y0 set-up advances saved', up.status === 201, up);

    const page = await phone(browser, { port: 8861, now: NOW });
    check('Y1 the new build is served (rc13-payday-20261012)', /rc13-payday-20261012/.test(await page.content()));
    await open(page);
    const head = await page.$$eval('#d3Payday thead th', ths => ths.map(t => t.innerText.trim()));
    check('Y2 columns in the approved order', JSON.stringify(head) === JSON.stringify(['Staff', 'HAAZRI', 'IS HAFTE KI KAMAI', 'PURANA HISAB', 'KITNA KAATNA', 'CASH DIYA', 'FINAL HISAB']), head);
    await page.evaluate(() => window.scrollTo(0, document.getElementById('d3Payday').getBoundingClientRect().top + window.scrollY - 150));
    await shot(page, '1-payday-table');
    await page.$eval('.pd-wrap', el => { el.scrollLeft = 400; });
    await shot(page, '2-scrolled-right-names-stay');
    const stuck = await page.$eval('#pd_stf_ramu .pd-name', el => { const r = el.getBoundingClientRect(), w = el.closest('.pd-wrap').getBoundingClientRect(); return Math.abs(r.left - w.left) < 3; });
    check('Y3 name column stays in place while the figures scroll sideways', stuck);
    await page.$eval('.pd-wrap', el => { el.scrollLeft = 0; });

    // ---- the owner's examples (Ramu: old advance 6,100; earnings 1,500; nothing paid earlier)
    let t = await row(page, 'stf_ramu');
    check('Y4 Ramu defaults: deduction 0, cash 1,500 (a draft), FINAL preview 6,100 aap par baaki',
      await val(page, 'pdd_stf_ramu') === '0' && await val(page, 'pdc_stf_ramu') === '1500'
      && /5 din/.test(t) && /₹1,500/.test(t) && /₹6,100 aap par baaki/.test(t) && /≈ ₹6,100 aap par baaki/.test(t) && /preview/.test(t), t);
    await type(page, 'pdd_stf_ramu', '1000');
    check('Y5 deduction 1,000 -> cash 500, remaining advance 5,100', await val(page, 'pdc_stf_ramu') === '500' && /≈ ₹5,100 aap par baaki/.test(await row(page, 'stf_ramu')));
    await shot(page, '3-ramu-deduction-1000');
    await type(page, 'pdc_stf_ramu', '700');
    check('Y6 cash 700 -> deduction 800, remaining advance 5,300', await val(page, 'pdd_stf_ramu') === '800' && /≈ ₹5,300 aap par baaki/.test(await row(page, 'stf_ramu')));
    await type(page, 'pdd_stf_ramu', '0');
    check('Y7 deduction 0 -> cash 1,500, advance stays 6,100', await val(page, 'pdc_stf_ramu') === '1500' && /≈ ₹6,100 aap par baaki/.test(await row(page, 'stf_ramu')));
    await type(page, 'pdc_stf_ramu', '2000');
    check('Y8 cash 2,000 -> deduction 0, advance becomes 6,600', await val(page, 'pdd_stf_ramu') === '0' && /≈ ₹6,600 aap par baaki/.test(await row(page, 'stf_ramu')));
    for (const bad of ['', '-5', 'abc', '1,000']) {
      await type(page, 'pdc_stf_ramu', bad);
      const dis = await page.$eval('#pds_stf_ramu', b => b.disabled);
      check('Y9 cash "' + bad + '" cannot be saved', dis && /Cash likhein/.test(await row(page, 'stf_ramu')), bad);
    }
    check('Y10 nothing saved while typing', stl(ramu) === '', stl(ramu));
    await type(page, 'pdd_stf_ramu', '1000');                      // back to example 1: cash 500
    await page.evaluate(() => renderHisab());                       // a routine re-render
    await page.waitForFunction(() => document.querySelector('#pdc_stf_ramu'));
    check('Y11 typed draft survives a re-render (deduction 1,000, cash 500)', await val(page, 'pdd_stf_ramu') === '1000' && await val(page, 'pdc_stf_ramu') === '500');
    await page.click('#pds_stf_ramu');
    await page.check('#pdk1_stf_ramu'); await page.check('#pdk2_stf_ramu');
    await shot(page, '4-confirm-before-save');
    await page.click('#pdok_stf_ramu'); await page.waitForTimeout(500);
    check('Y12 Confirm without all three ticks saves nothing', stl(ramu) === '');
    await page.check('#pdk3_stf_ramu'); await page.click('#pdok_stf_ramu');
    await settledRow(page, 'stf_ramu');
    t = await row(page, 'stf_ramu');
    // -6,100 + 1,500 - 0 - 500 = -5,100; recovery shown 1,000
    check('Y13 Ramu saved: one payment 500; database closing -5,100; row shows actual ✓ Diya, 1,000 recovered, 5,100 aap par baaki',
      stl(ramu) === '500' && await closing(ramu) === -5100 && /✓ Diya/.test(t) && /₹1,000/.test(t) && /₹5,100 aap par baaki/.test(t) && !/≈|preview/.test(t), t);
    const card = await txt(page, '#d3h_stf_ramu');
    check('Y14 detailed Weekly Hisab card (unchanged) agrees: cash 500, balance at end of Sun 18 Oct 5,100 worker owes shop',
      /Cash given at settlement \(Sun, 18 Oct\) ₹500/.test(card) && /Balance at end of Sun, 18 Oct ₹5,100 — worker owes shop/.test(card), card);

    // ---- Shyam: no old advance, cash 2,000 -> new advance 500 (reply lost on the way back)
    await type(page, 'pdc_stf_shyam', '2000');
    check('Y15 Shyam (no advance): deduction stays 0 and disabled; cash 2,000 -> 500 aap par baaki',
      await val(page, 'pdd_stf_shyam') === '0' && await page.$eval('#pdd_stf_shyam', e => e.disabled) && /≈ ₹500 aap par baaki/.test(await row(page, 'stf_shyam')));
    page.ctl.dropReply = 'staff_settlement_apply';
    await save(page, 'stf_shyam');
    await settledRow(page, 'stf_shyam');
    check('Y16 reply lost: confirmed after checking, exactly one payment 2,000; closing -500', stl(shyam) === '2000' && await closing(shyam) === -500, stl(shyam));

    // ---- Kalu: 400 already given Wed 14 Oct, old advance 2,000
    t = await row(page, 'stf_kalu');
    // available = 1,500 - 400 = 1,100 -> default cash 1,100, final -2,000 + 1,500 - 400 - 1,100 = -2,000
    check('Y17 Kalu: earlier payment shown in the row ("pehle diye ₹400 (14 Oct)"); default cash 1,100; final 2,000 aap par baaki',
      /pehle diye ₹400 \(14 Oct\)/.test(t) && await val(page, 'pdc_stf_kalu') === '1100' && /≈ ₹2,000 aap par baaki/.test(t), t);
    await type(page, 'pdd_stf_kalu', '5000');
    // capped at min(2,000 advance, 1,100 available) = 1,100 -> cash 0 -> -2,000 + 1,100 = -900
    check('Y18 deduction 5,000 is capped at 1,100 (what this week can repay) -> cash 0, 900 aap par baaki',
      await val(page, 'pdd_stf_kalu') === '1100' && await val(page, 'pdc_stf_kalu') === '0' && /≈ ₹900 aap par baaki/.test(await row(page, 'stf_kalu')));
    await type(page, 'pdd_stf_kalu', '600');                       // cash 500 -> -2,000 + 1,500 - 400 - 500 = -1,400
    check('Y19 deduction 600 -> cash 500 -> 1,400 aap par baaki', await val(page, 'pdc_stf_kalu') === '500' && /≈ ₹1,400 aap par baaki/.test(await row(page, 'stf_kalu')));
    // another phone records 100 more for Kalu: the server figures change under the typed draft
    await L.upsert(T, 'staff_payment', [L.payRow({ id: 1760300000003, staff: kalu, amount: 100, date: L.istTs('2026-10-16') })]);
    await page.evaluate(() => renderHisab());
    await page.waitForFunction(() => /Figures badle/.test((document.getElementById('pd_stf_kalu') || {}).innerText || ''), null, { timeout: 15000 });
    check('Y20 changed server figures: warning shown, Save blocked, typed cash kept', await page.$eval('#pds_stf_kalu', b => b.disabled) && await val(page, 'pdc_stf_kalu') === '500');
    await page.evaluate(() => window.scrollTo(0, document.getElementById('pd_stf_kalu').getBoundingClientRect().top + window.scrollY - 200));
    await shot(page, '5-figures-changed-review');
    await page.click('#pd_stf_kalu button.wk-btn');                // "Theek hai"
    await page.waitForFunction(() => !/Figures badle/.test((document.getElementById('pd_stf_kalu') || {}).innerText || ''), null, { timeout: 15000 });
    t = await row(page, 'stf_kalu');
    // now paid 500 earlier; available 1,000; cash 500 -> deduction 500; final -2,000 + 1,500 - 500 - 500 = -1,500
    check('Y21 after "Theek hai": cash 500 kept, deduction 500, final 1,500 aap par baaki, Save allowed',
      await val(page, 'pdd_stf_kalu') === '500' && /pehle diye ₹500 \(14 Oct, 16 Oct\)/.test(t) && /≈ ₹1,500 aap par baaki/.test(t) && !(await page.$eval('#pds_stf_kalu', b => b.disabled)), t);
    await save(page, 'stf_kalu'); await settledRow(page, 'stf_kalu');
    check('Y22 Kalu saved 500; closing -1,500; ordinary payments untouched (400, 100)', stl(kalu) === '500' && await closing(kalu) === -1500
      && sql(`select string_agg(amount::int::text, ',' order by amount) from staff_payment where staff_id = '${kalu}' and legacy_id not like 'stl%'`) === '100,400');

    // ---- Mohan: shop already owed 800 (positive), unpaid wages
    t = await row(page, 'stf_mohan');
    check('Y23 Mohan: PURANA 800 dukaan par baaki; deduction disabled ("advance nahi"); default cash 2,300 -> barabar',
      /₹800 dukaan par baaki/.test(t) && /advance nahi/.test(t) && await val(page, 'pdc_stf_mohan') === '2300' && /≈ ₹0 barabar/.test(t), t);
    await type(page, 'pdc_stf_mohan', '1000');                     // 800 + 1,500 - 1,000 = 1,300 still owed by the shop
    check('Y24 cash 1,000 -> 1,300 dukaan par baaki (unpaid wages stay owed)', /≈ ₹1,300 dukaan par baaki/.test(await row(page, 'stf_mohan')));

    // ---- Raju: recovery capped at the remaining 300, rest owed by the shop
    await type(page, 'pdd_stf_raju', '1000');
    check('Y25 Raju deduction 1,000 capped at the 300 still owed -> cash 1,200 -> barabar', await val(page, 'pdd_stf_raju') === '300' && await val(page, 'pdc_stf_raju') === '1200' && /≈ ₹0 barabar/.test(await row(page, 'stf_raju')));
    await type(page, 'pdc_stf_raju', '1000');                      // recovery min(300, 500) = 300; -300 + 1,500 - 1,000 = 200
    check('Y26 cash 1,000 -> recovery 300, then 200 dukaan par baaki', await val(page, 'pdd_stf_raju') === '300' && /≈ ₹200 dukaan par baaki/.test(await row(page, 'stf_raju')));
    await save(page, 'stf_raju'); await settledRow(page, 'stf_raju');
    check('Y27 Raju saved: closing +200 (shop owes)', stl(raju) === '1000' && await closing(raju) === 200);

    // ---- Hari half-day; Bablu excess advance and zero cash; Gopi missing attendance
    t = await row(page, 'stf_hari');
    check('Y28 Hari half-day: 4½ din, 4½ × ₹400 = ₹1,800', /4½ din/.test(t) && /₹1,800/.test(t) && /4½ × ₹400/.test(t), t);
    t = await row(page, 'stf_bablu');
    // available 1,500 - 2,000 = -500 -> suggested cash 0; final -500
    check('Y29 Bablu took 2,000 against 1,500: cash suggestion 0, 500 aap par baaki', await val(page, 'pdc_stf_bablu') === '0' && /pehle diye ₹2,000/.test(t) && /≈ ₹500 aap par baaki/.test(t), t);
    await page.click('#pds_stf_bablu');
    check('Y30 zero-cash confirmation says no cash was given', /Aaj koi cash nahi diya \(₹0\)/.test(await txt(page, '#pda_stf_bablu')));
    for (const k of [1, 2, 3]) await page.check('#pdk' + k + '_stf_bablu');
    await page.click('#pdok_stf_bablu'); await settledRow(page, 'stf_bablu');
    check('Y31 Bablu ₹0 closure: no payment row, closing -500', stl(bablu) === '' && await closing(bablu) === -500);
    t = await row(page, 'stf_gopi');
    check('Y32 Gopi missing attendance: warning only, no inputs, no amounts', /Attendance not marked: 2026-10-14/.test(t) && !/₹/.test(t) && !(await page.$('#pdc_stf_gopi')), t);
    check('Y33 rc12 five-line Details unchanged for a Payday-saved worker (Ramu: paid 500, 5,100 aap par baaki)',
      await (async () => { await page.evaluate(() => { viewMonth = new Date(2026, 9, 14); openStaffDetail('stf_ramu'); });
        await page.waitForFunction(() => /AAJ TAK KA HISAB/.test((document.getElementById('d3Detail') || {}).innerText || ''), null, { timeout: 15000 });
        const d = await txt(page, '#d3Detail'); return /IS HAFTE PAYMENT LIYE ₹500/.test(d) && /AAJ TAK KA HISAB ₹5,100 — aap par baaki/.test(d); })());
    await open(page);
    await page.evaluate(() => window.scrollTo(0, document.getElementById('d3Payday').getBoundingClientRect().top + window.scrollY - 150));
    await shot(page, '6-after-saves');

    // ---- two phones on Mohan: both have 1,000 typed; only the first save becomes a payment
    const p2 = await phone(browser, { port: 8861, now: NOW }); await open(p2);
    await type(p2, 'pdc_stf_mohan', '1000');
    await type(page, 'pdc_stf_mohan', '1000');
    await save(page, 'stf_mohan'); await settledRow(page, 'stf_mohan');
    await save(p2, 'stf_mohan');
    await p2.waitForFunction(() => /✓ Diya|Not saved/.test((document.getElementById('pd_stf_mohan') || {}).innerText || ''), null, { timeout: 15000 });
    check('Y34 two phones: one payment of 1,000 only; closing +1,300', stl(mohan) === '1000' && await closing(mohan) === 1300, stl(mohan));
    check('Y35 no page errors', page.errors.length === 0 && p2.errors.length === 0, page.errors.concat(p2.errors));
    await p2.close(); await page.close();
  } finally { await browser.close(); srv.close(); }
  console.log('\n' + L.PASS.length + ' passed, ' + L.FAIL.length + ' failed - Payday table');
  process.exit(L.FAIL.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
