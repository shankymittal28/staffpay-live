/*
 * Receipts ("↩ Wapas mila") on the phone, against the disposable database with
 * sql/d3_receipts_v1.sql applied. Also serves the REAL released rc13 and rc14
 * pages and rc9-safe against the same database.
 *
 *   test_d3/env.sh up
 *   RC13_DIR=/var/tmp/rc13wt RC14_DIR=/var/tmp/rc14wt RC9SAFE_DIR=/home/user/staffpay-rc9safe \
 *     node test_d3/test_receipts_browser.js [screenshot-dir]
 *
 * Week Mon 5 - Sun 11 Oct 2026, phone clock Sun 11 Oct 18:00 IST, Old Hisab at
 * the end of Sun 4 Oct, Rs 500/day. Every rupee is worked out in comments.
 */
const path = require('path');
const { chromium } = require('playwright');
const L = require('./lib.js'), { check, sql, OWNER } = L;
const { phone, txt, serve, uploaded, idle } = require('./phone.js');
const T = L.token(OWNER), SHOTS = process.argv[2] || null, W = '2026-10-05', NOW = '2026-10-11T18:00:00+05:30';
const RC13 = process.env.RC13_DIR || '/var/tmp/rc13wt', RC14 = process.env.RC14_DIR || '/var/tmp/rc14wt';
const RC9 = process.env.RC9SAFE_DIR || '/home/user/staffpay-rc9safe';
const n = x => Number(x);
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png') }); };
const rcv = s => sql(`select coalesce(string_agg(amount::int::text || '@' || to_char(date at time zone 'Asia/Kolkata', 'DD'), ',' order by legacy_id), '') from staff_payment where staff_id = '${s}' and amount < 0`);
const rcvId = s => sql(`select legacy_id from staff_payment where staff_id = '${s}' and amount < 0 order by legacy_id limit 1`);
const stl = s => sql(`select coalesce(string_agg(cash_paid::int::text || ':' || state, ','), '') from staff_settlement where staff_id = '${s}'`);
const ops = () => n(sql('select count(*) from staff_d3_op')), voids = () => n(sql('select count(*) from staff_payment_void'));
const snapshot = () => sql(`select md5(string_agg(legacy_id || amount || date || coalesce(staff_id::text, ''), ',' order by legacy_id)) from staff_payment`)
  + sql(`select md5(coalesce(string_agg(legacy_id || state || cash_paid || version, ',' order by legacy_id), '')) from staff_settlement`);
const report = async (s, to, x) => L.rpc(T, 'staff_workshop_report', Object.assign({ staff_id: s, to: to || '2026-10-11', receipts_ok: true }, x || {}));
const closing = async s => n((await report(s)).weeks.find(w => w.monday === W).closing);
const row = (page, l) => txt(page, '#pd_' + l);

async function openPayday(page) {
  await page.evaluate(() => { hisabWeek = new Date(2026, 9, 5); switchTab('hisab'); renderHisab(); });
  await page.waitForFunction(() => document.querySelector('#d3Payday table.pd'), null, { timeout: 15000 });
  await page.waitForTimeout(300);
}
async function card(page, l) {
  await page.waitForFunction(x => { const el = document.getElementById('d3h_' + x); return el && !/Loading/.test(el.innerText); }, l, { timeout: 15000 });
  return txt(page, '#d3h_' + l);
}
async function paydaySave(page, l, ticks) {
  await page.click('#pds_' + l);
  for (const k of (ticks || [1, 2, 3])) await page.check('#pdk' + k + '_' + l);
  await page.click('#pdok_' + l);
  await page.waitForFunction(x => /✓ Diya/.test((document.getElementById('pd_' + x) || {}).innerText || ''), l, { timeout: 15000 });
}
async function receiptUi(page, uuid, amt, day, opts) {
  await page.evaluate(() => { switchTab('add'); SPD3.rcvToggle(true); });
  await page.selectOption('#rcvWho', uuid);
  await page.fill('#rcvAmt', String(amt)); await page.fill('#rcvDay', day);
  await page.click('#rcvGo');
  if (opts && opts.expectError) { await page.waitForTimeout(300); return txt(page, '#rcvErr'); }
  await page.waitForSelector('#confirmModal.show', { timeout: 15000 });
  const msg = await page.$eval('#confirmMsg', e => e.textContent);
  if (opts && opts.shot) await shot(page, opts.shot);
  if (opts && opts.cancel) await page.evaluate(() => closeConfirm(true));
  else await page.click('#confirmYesBtn');
  return msg;
}
async function details(page, legacy) {
  await page.evaluate(l => { viewMonth = new Date(2026, 9, 7); openStaffDetail(l); }, legacy);
  await page.waitForFunction(() => { const el = document.getElementById('d3Detail'); return el && !/Loading/.test(el.innerText); }, null, { timeout: 15000 });
  await page.waitForTimeout(200);
  return { det: await txt(page, '#d3Detail'), wa: await page.evaluate(l => buildHisabText(l), legacy) };
}
async function oldSettleRequest(page, staff) {      // exactly the shape rc13/rc14 send: five figures, no flag
  return page.evaluate(async ([s, w]) => {
    const r = await window.__SP_NET__.rpc('staff_workshop_report', { staff_id: s, to: '2026-10-11', from: null });
    const x = r.weeks.find(v => v.monday === w);
    return window.__SP_NET__.rpc('staff_settlement_apply', { op_id: crypto.randomUUID(), action: 'settle', staff_id: s, week: w, expected_version: null, cash: 0,
      sunday_done: true, advances_complete: true, seen: { days: +x.days_worked, rate: +x.rate, earned: +x.earned, previous: +x.previous, advances: +x.advances_total } });
  }, [staff, W]);
}

(async () => {
  const srvNew = await serve(path.join(__dirname, '..'), 8881), srv14 = await serve(RC14, 8882), srv13 = await serve(RC13, 8883), srv9 = await serve(RC9, 8884);
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  try {
    L.reset(); L.setToday('2026-10-11');
    const mk = (name, ob, pattern, o) => { const s = L.emp(Object.assign({ name, rate: 500, ob, obDate: '2026-10-04', legacy: 'stf_' + name.toLowerCase() }, o || {})); if (pattern) L.attRange(s, W, pattern); return s; };
    const rohit = mk('Rohit', -24000, 'PPPPAAA');           // 4 x 500 = 2,000
    const part = mk('Partial', -5000, 'PPPAAAA');           // 3 x 500 = 1,500
    const full = mk('Full', -5000, 'PPPAAAA');
    const beyond = mk('Beyond', -5000, 'PPPAAAA');
    const nil = mk('Nil', 0, 'AAAAAAA');                     // owes nothing
    const eq = mk('Equal', 0, 'PPPPPPP');                    // 3,500
    const corr = mk('Corr', -4000, 'PPPPPPP');
    const plain13 = mk('PlainA', 0, 'PPPPPPP'), plain14 = mk('PlainB', 0, 'PPPPPPP');   // weeks without receipts, for old pages
    const shop = mk('Shopboy', 0, null, { group: 'shop', wage: 'monthly' });
    const noOb = mk('Naya', 0, 'PPPPPPP', { obDate: null });
    const up = await L.upsert(T, 'staff_payment', [
      L.payRow({ id: 1760000000001, staff: rohit, amount: 1000, date: L.istTs('2026-10-09') }),   // Rs 1,000 given Fri 9 Oct
      L.payRow({ id: 1760000000002, staff: eq, amount: 1000, date: L.istTs('2026-10-07') })]);
    check('B0 set-up payments saved', up.status === 201, up);
    for (const [s, a] of [[part, 2000], [full, 5000], [corr, 3000]])
      await L.rpc(T, 'staff_receipt_add', { op_id: L.uuid(), staff_id: s, amount: a, day: '2026-10-08', receipts_ok: true });

    // ======================================================== the new page (rc15)
    let page = await phone(browser, { port: 8881, now: NOW });
    check('B1 the new build is served (rc16-addlayout-20261014)', /rc16-addlayout-20261014/.test(await page.content()));
    await page.evaluate(() => switchTab('add'));
    await page.click('#rcvToggle');
    const opts = await page.$$eval('#rcvWho option', o => o.map(x => x.value + '=' + x.textContent));
    check('B2 "+ Add" → "↩ Wapas mila": worker chosen from a list by permanent id; only workshop workers with Old Hisab; no default',
      opts[0] === '=— worker chunein —' && opts.includes(rohit + '=Rohit') && !opts.some(o => /Shopboy|Naya/.test(o))
      && await page.$eval('#payForm', e => e.style.display === 'none'), opts);
    await shot(page, '1-add-wapas-mila-form');
    let err = await receiptUi(page, rohit, 500, '2026-10-04', { expectError: true });
    check('B3 a date on/before the Old Hisab date is stopped on the phone', /Old Hisab/.test(err), err);
    err = await receiptUi(page, rohit, '0', '2026-10-11', { expectError: true });
    check('B4 amount 0 is stopped on the phone', /0 se zyada/.test(err) && rcv(rohit) === '', err);
    const badEntry = [];
    for (const v of ['100.001', '10000000', '-5', 'abc']) badEntry.push([v, await receiptUi(page, rohit, v, '2026-10-11', { expectError: true })]);
    check('B4b entry form: 100.001, 10,000,000, -5 and text stopped with the amount rule; nothing saved',
      badEntry.every(([, e]) => /2 decimal tak aur ₹1 crore se kam/.test(e)) && rcv(rohit) === '', badEntry);

    // Rohit: balance now (11 Oct) = -24,000 + 2,000 - 1,000 = -23,000; after 14,000 back: -9,000
    page.ctl.dropReply = 'staff_receipt_add';                // saved, but the reply is lost
    let msg = await receiptUi(page, rohit, 14000, '2026-10-11', { shot: '2-confirm-rohit' });
    check('B5 confirmation: "Rohit se ₹14,000 wapas mila · 11 Oct 2026", now ₹23,000 owed, after ₹9,000 owed; no warning',
      /^Rohit se ₹14,000 wapas mila · 11 Oct 2026/.test(msg) && /₹23,000 aap par baaki/.test(msg) && /Iske baad: ₹9,000 aap par baaki/.test(msg) && !/⚠/.test(msg), msg);
    await page.waitForFunction(() => Object.keys(SPD3.pending()).length === 0, null, { timeout: 15000 }); await idle(page);
    check('B6 lost reply: checked with the database, saved exactly once (-14,000 on 11 Oct), nothing left pending',
      rcv(rohit) === '-14000@11', rcv(rohit));
    await page.evaluate(() => { switchTab('add'); renderRecent(); });
    const recent = await txt(page, '#recentList');
    check('B7 Recent shows "↩ Wapas mila ₹14,000" (not a payment of -14,000)', /Rohit .*↩ Wapas mila ₹14,000/.test(recent) && !/-14,000|₹-/.test(recent), recent);

    // warnings
    msg = await receiptUi(page, nil, 300, '2026-10-10', { cancel: true });
    check('B8 nothing owed: warning shown; cancelled, nothing saved', /⚠ Nil par koi advance baaki nahi tha/.test(msg) && rcv(nil) === '', msg);
    // Beyond: now -5,000 + 1,500 = -3,500 owed; 7,000 back is 3,500 more -> shop owes 3,500
    msg = await receiptUi(page, beyond, 7000, '2026-10-08', { shot: '3-confirm-beyond' });
    check('B9 more than owed: warning names the extra (₹3,500) and what the shop then owes', /⚠ Ye baaki \(₹3,500\) se ₹3,500 zyada hai/.test(msg) && /dukaan ko ₹3,500 dene honge/.test(msg), msg);
    await page.waitForFunction(() => Object.keys(SPD3.pending()).length === 0, null, { timeout: 15000 });
    check('B10 Beyond saved once', rcv(beyond) === '-7000@08', rcv(beyond));

    // ---- Payday (week 5-11 Oct)
    await openPayday(page);
    let t = await row(page, 'stf_rohit');
    // Pr = -24,000 + 14,000 = -10,000; avail = 2,000 - 1,000 = 1,000; maxD = 1,000; cash with D 0 = 1,000
    check('B11 Rohit row: PURANA ₹24,000 aap par baaki; kamai ₹2,000 with "pehle diye ₹1,000 (9 Oct)" and "wapas mila ₹14,000 (11 Oct)"; max ₹1,000',
      /₹2,000/.test(t) && /pehle diye ₹1,000 \(9 Oct\)/.test(t) && /wapas mila ₹14,000 \(11 Oct\)/.test(t) && /₹24,000 aap par baaki/.test(t)
      && /max ₹1,000/.test(t) && await page.inputValue('#pdc_stf_rohit') === '1000', t);
    await page.fill('#pdd_stf_rohit', '1000');
    t = await row(page, 'stf_rohit');
    check('B12 KITNA KAATNA 1,000 → cash 0, FINAL ≈ ₹9,000 aap par baaki', await page.inputValue('#pdc_stf_rohit') === '0' && /≈ ₹9,000 aap par baaki/.test(t), t);
    await page.fill('#pdd_stf_rohit', '1001');
    check('B13 more than 1,000 cannot be kept back (capped to the max)', await page.inputValue('#pdd_stf_rohit') === '1000');
    await page.$eval('.pd-wrap', el => { el.scrollLeft = 0; }); await page.evaluate(() => window.scrollTo(0, document.getElementById('pd_stf_rohit').getBoundingClientRect().top + window.scrollY - 200));
    await shot(page, '4-payday-rohit-draft');
    await page.$eval('.pd-wrap', el => { el.scrollLeft = 330; }); await shot(page, '4b-payday-rohit-right'); await page.$eval('.pd-wrap', el => { el.scrollLeft = 0; });
    await page.click('#pds_stf_rohit');
    const ask = await txt(page, '#pda_stf_rohit');
    check('B14 confirmation lists given and returned separately', /pehle diye ₹1,000, wapas mila ₹14,000/.test(ask) && /FINAL HISAB: ₹9,000 aap par baaki/.test(ask), ask);
    for (const k of [1, 2, 3]) await page.check('#pdk' + k + '_stf_rohit');
    await page.click('#pdok_stf_rohit');
    await page.waitForFunction(() => /✓ Diya/.test((document.getElementById('pd_stf_rohit') || {}).innerText || ''), null, { timeout: 15000 });
    t = await row(page, 'stf_rohit');
    check('B15 saved: cash ₹0, kept back ₹1,000, FINAL ₹9,000 aap par baaki = database closing -9,000',
      stl(rohit) === '0:settled' && await closing(rohit) === -9000 && /₹1,000 ₹0 ₹9,000 aap par baaki/.test(t), { t, s: stl(rohit) });
    check('B16 the Rs 1,000 of 9 Oct counted once; ledger holds +1,000 and -14,000 only',
      sql(`select string_agg(amount::int::text, ',' order by amount) from staff_payment where staff_id = '${rohit}'`) === '-14000,1000');

    // partial / full / beyond
    t = await row(page, 'stf_partial');
    // Pr = -5,000 + 2,000 = -3,000; avail 1,500; maxD 1,500
    check('B17 partial (owed 5,000, returned 2,000, earned 1,500): max ₹1,500, default cash ₹1,500', /max ₹1,500/.test(t) && await page.inputValue('#pdc_stf_partial') === '1500', t);
    await page.fill('#pdd_stf_partial', '1500'); await paydaySave(page, 'stf_partial');
    check('B18 partial: keep back 1,500 → cash 0, final ₹1,500 aap par baaki', stl(part) === '0:settled' && await closing(part) === -1500);
    t = await row(page, 'stf_full');
    check('B19 full (returned all 5,000): no old advance left, deduction off, cash ₹1,500', /advance nahi/.test(t) && await page.$eval('#pdd_stf_full', e => e.disabled)
      && await page.inputValue('#pdc_stf_full') === '1500' && /≈ ₹0 barabar/.test(t), t);
    await paydaySave(page, 'stf_full');
    check('B20 full: cash 1,500, final 0', stl(full) === '1500:settled' && await closing(full) === 0);
    t = await row(page, 'stf_beyond');
    check('B21 beyond (returned 7,000 of 5,000): shop owes 2,000 + 1,500 → cash ₹3,500', await page.inputValue('#pdc_stf_beyond') === '3500' && /≈ ₹0 barabar/.test(t), t);
    await paydaySave(page, 'stf_beyond');
    check('B22 beyond: cash 3,500, final 0', stl(beyond) === '3500:settled' && await closing(beyond) === 0);

    // equal extra given and returned while a draft is open
    await page.fill('#pdc_stf_equal', '2000');
    await L.upsert(T, 'staff_payment', [L.payRow({ id: 1760000000003, staff: eq, amount: 400, date: L.istTs('2026-10-08') })]);
    await L.rpc(T, 'staff_receipt_add', { op_id: L.uuid(), staff_id: eq, amount: 400, day: '2026-10-09', receipts_ok: true });
    await page.evaluate(() => renderHisab()); await page.waitForFunction(() => document.querySelector('#pd_stf_equal'));
    await page.waitForTimeout(500);
    t = await row(page, 'stf_equal');
    check('B23 extra 400 given and 400 returned (net unchanged): the draft goes to review, Save blocked',
      /Figures badle/.test(t) && await page.$eval('#pds_stf_equal', b => b.disabled) && /pehle diye ₹1,400/.test(t) && /wapas mila ₹400/.test(t), t);

    // ---- owner card, five lines, WhatsApp
    const c = await card(page, 'stf_rohit');
    check('B24 Weekly Hisab card: advances ₹1,000 and "↩ Wapas mila" ₹14,000 on separate lines; formula adds the receipt',
      /Total advances ₹1,000/.test(c) && /↩ Wapas mila \(worker ne paisa diya\) Sun, 11 Oct · Rohit ne wapas diye|↩ Wapas mila \(worker ne paisa diya\) Sun, 11 Oct/.test(c)
      && /Total wapas mila ₹14,000/.test(c) && /−₹24,000 \+ ₹2,000 − ₹1,000 \+ ₹14,000 wapas = ₹9,000 — worker owes shop/.test(c)
      && /Balance at end of Sun, 11 Oct ₹9,000 — worker owes shop/.test(c), c);
    if (SHOTS) { await page.$eval('#d3h_stf_rohit', e => e.scrollIntoView()); await shot(page, '5-card-rohit'); }
    const v = await details(page, 'stf_rohit');
    check('B25 five lines + receipt line: PAYMENT LIYE ₹1,000 (given + settlement cash 0), IS HAFTE WAPAS DIYE ₹14,000, AAJ TAK ₹9,000 aap par baaki',
      /HAAZRI 4 din IS HAFTE PAYMENT LIYE ₹1,000 IS HAFTE WAPAS DIYE ₹14,000 IS HAFTE KA HISAB 4 × ₹500 = ₹2,000 PICHLA ADVANCE −₹24,000 AAJ TAK KA HISAB ₹9,000 — aap par baaki/.test(v.det), v.det);
    check('B26 WhatsApp: same lines, the last in bold', /IS HAFTE PAYMENT LIYE: ₹1,000\nIS HAFTE WAPAS DIYE: ₹14,000\nIS HAFTE KA HISAB: 4 × ₹500 = ₹2,000\nPICHLA ADVANCE: −₹24,000\n\*AAJ TAK KA HISAB: ₹9,000 — aap par baaki\*/.test(v.wa), v.wa);
    if (SHOTS) { await page.evaluate(() => window.scrollTo(0, document.getElementById('d3Detail').getBoundingClientRect().top + window.scrollY - 140)); await shot(page, '6-details-rohit'); }
    const vf = await details(page, 'stf_full');
    check('B27 a week without... (Full) still shows the receipt line only when there is one; PlainA has no receipt line',
      /IS HAFTE WAPAS DIYE ₹5,000/.test(vf.det) && !/WAPAS/.test((await details(page, 'stf_plaina')).det), vf.det);

    // ---- History / Summary / Payroll
    await page.evaluate(() => { viewMonth = new Date(2026, 9, 1); updateMonthLabels(); switchTab('history'); renderHistory(); }); await idle(page);
    const hist = await txt(page, '#historyList'), split = await txt(page, '#historyD3');
    // given: Rohit 1,000 + Equal 1,000 + 400 + settlement cash 1,500 + 3,500 = 7,400; returned 14,000 + 2,000 + 5,000 + 3,000 + 7,000 + 400 = 31,400
    check('B28 History: receipts read "↩ Wapas mila"; month split Diya ₹7,400 · Wapas mila ₹31,400 · Net −₹24,000',
      /↩ Wapas mila ₹14,000/.test(hist) && /Diya ₹7,400 · ↩ Wapas mila ₹31,400 · Net −₹24,000/.test(split), { split, hist: hist.slice(0, 300) });
    await shot(page, '7-history');
    await page.evaluate(() => { summaryGroup = 'workshop'; viewMonth = new Date(2026, 9, 7); switchTab('summary'); renderSummary(); }); await idle(page); await page.waitForTimeout(500);
    const sm = await txt(page, '#summaryD3'), sl = await txt(page, '#staffList');
    check('B29 Summary (workshop): Diya / Wapas mila / Net from the database; Rohit card split', /Diya .* · ↩ Wapas mila .* · Net/.test(sm)
      && /Rohit .*Diya ₹1,000 · ↩ Wapas mila ₹14,000 · Net/.test(sl), { sm, sl: sl.slice(0, 400) });
    await page.evaluate(() => { viewMonth = new Date(2026, 9, 1); switchTab('payroll'); renderPayroll(); });
    await page.waitForFunction(() => document.getElementById('d3pr_stf_rohit'), null, { timeout: 15000 });
    const pr = await txt(page, '#d3p_stf_rohit');
    check('B30 Payroll workshop row: Diya ₹1,000 · Wapas mila ₹14,000 · Net −₹13,000; balance ₹9,000 owed', /Diya ₹1,000 · ↩ Wapas mila ₹14,000 · Net −₹13,000/.test(pr) && /₹9,000 — worker owes shop/.test(pr), pr);
    await shot(page, '8-payroll');

    // ---- correcting a receipt on the new page (Corr: -3,000 on 8 Oct)
    const cid = rcvId(corr);
    await page.evaluate(id => SPD3.openCorrect(id), cid);
    const opt = await page.$$eval('#d3CorrAct option', o => o.map(x => x.textContent));
    const head = await txt(page, '#d3CorrModal');
    check('B31 receipt correction screen: own title, amount shown as ₹3,000, remove reads "paisa wapas mila hi nahi"; no "choose worker"',
      /Correct this receipt \(wapas mila\)/.test(head) && /Corr · ↩ Wapas mila ₹3,000 · 08 Oct 2026/.test(head) && await page.inputValue('#d3CorrAmt') === '3000'
      && JSON.stringify(opt) === JSON.stringify(['Amount or date is wrong', 'Ye receipt galti se likhi gayi — paisa wapas mila hi nahi']), { head, opt });
    await shot(page, '9-correct-receipt');
    await page.fill('#d3CorrWhy', 'galat likha');
    const v0c = voids(), o0c = ops();
    for (const bad of ['100.001', '10000000']) {
      await page.fill('#d3CorrAmt', bad); await page.click('#d3CorrGo'); await page.waitForTimeout(300);
      check('B31b correction form refuses ' + bad + ' with the amount rule; receipt unchanged, nothing logged',
        /2 decimal tak aur ₹1 crore se kam/.test(await txt(page, '#d3CorrErr')) && rcv(corr) === '-3000@08' && voids() === v0c && ops() === o0c, await txt(page, '#d3CorrErr'));
    }
    await page.fill('#d3CorrAmt', '2500'); await page.click('#d3CorrGo');
    await page.waitForFunction(() => !document.getElementById('d3CorrModal').classList.contains('show'), null, { timeout: 15000 });
    check('B32 changed to 2,500: stored -2,500, still a receipt', rcv(corr) === '-2500@08', rcv(corr));
    await page.waitForFunction(id => { const p = SPD3.findPay(id); return p && Number(p.amount) === -2500; }, cid, { timeout: 15000 });   // the phone's copy refreshed
    await page.evaluate(id => SPD3.openCorrect(id), cid);
    await page.selectOption('#d3CorrAct', 'remove'); await page.fill('#d3CorrWhy', 'paisa mila hi nahi'); await page.click('#d3CorrGo');
    check('B33 remove without the tick is refused on the phone', /Paisa wapas mila hi nahi/.test(await txt(page, '#d3CorrErr')) && rcv(corr) === '-2500@08');
    await page.check('#d3CorrNot'); await page.click('#d3CorrGo');
    await page.waitForFunction(() => !document.getElementById('d3CorrModal').classList.contains('show'), null, { timeout: 15000 });
    check('B34 removed: row gone, correction record kept', rcv(corr) === '' && n(sql(`select count(*) from staff_payment_void where legacy_id = '${cid}'`)) === 1);
    await L.rpc(T, 'staff_receipt_add', { op_id: L.uuid(), staff_id: corr, amount: 3000, day: '2026-10-08', receipts_ok: true });   // back for the old pages
    check('B35 no page errors (new page)', page.errors.length === 0, page.errors);
    await page.close();

    // ======================================================== the real released rc14 and rc13 pages
    for (const [label, port, plain, plainLegacy] of [['rc14', 8882, plain14, 'stf_plainb'], ['rc13', 8883, plain13, 'stf_plaina']]) {
      page = await phone(browser, { port, now: NOW });
      const build = label === 'rc14' ? /rc14-payedit-20261012/ : /rc13-payday-20261012/;
      check(label + ' O0 the real ' + label + ' page is served', build.test(await page.content()));
      await openPayday(page);
      t = await row(page, plainLegacy);
      check(label + ' O1 week WITHOUT receipts: row shown normally (7 din, ₹3,500)', /7 din/.test(t) && /₹3,500/.test(t) && !/withheld/.test(t), t);
      await paydaySave(page, plainLegacy);
      check(label + ' O2 week without receipts: old page settles normally (cash 3,500, closing 0)', stl(plain) === '3500:settled' && await closing(plain) === 0, stl(plain));
      t = await row(page, 'stf_corr');
      check(label + ' O3 week WITH a receipt: figures withheld on the Payday row, no save button', /Balance withheld: .*wapas mila paisa hai/.test(t)
        && !(await page.$('#pds_stf_corr')), t);
      const oc = await card(page, 'stf_corr');
      check(label + ' O4 owner card withheld too, no Settle button', /Balance withheld/.test(oc) && /wapas mila paisa hai/.test(oc) && !/Settle & Pay/.test(oc), oc);
      if (label === 'rc14') await shot(page, '10-rc14-withheld');
      let before = snapshot(), o0 = ops(), v0 = voids();
      const sres = await oldSettleRequest(page, corr);
      check(label + ' O5 settling that week with the old request shape: refused "upgrade required"', sres.ok === false && sres.error === 'upgrade required', sres);
      // receipt correction / removal from the old page's own correction screen
      const id = rcvId(corr);
      await page.evaluate(i => SPD3.openCorrect(i), id);
      await page.fill('#d3CorrAmt', '1000'); await page.fill('#d3CorrWhy', 'x'); await page.click('#d3CorrGo');
      await page.waitForFunction(() => /App update karein/.test(document.getElementById('d3CorrErr').innerText), null, { timeout: 15000 });
      await page.selectOption('#d3CorrAct', 'remove'); await page.check('#d3CorrNot'); await page.click('#d3CorrGo');
      await page.waitForTimeout(800);
      const ce = await txt(page, '#d3CorrErr');
      check(label + ' O6 old page change and remove of a receipt: "App update karein — wapas mila paise ki entry purani app se badli ya hataayi nahi ja sakti."',
        /App update karein — wapas mila paise ki entry purani app se badli ya hataayi nahi ja sakti\./.test(ce), ce);
      await page.evaluate(() => SPD3.closeCorrect());
      // History edit / delete, a stray bulk edit, Clear Month, JSON and CSV restore
      await page.evaluate(i => { openEditEntry(i); deleteEntry(i); SPD3.closeCorrect(); }, id);
      await page.evaluate(i => save(load().map(e => e.id === i ? Object.assign({}, e, { amount: 1 }) : e)), id);
      await page.evaluate(() => { viewMonth = new Date(2026, 9, 1); clearMonth(); });
      await page.waitForSelector('#confirmModal.show'); await page.click('#confirmYesBtn');
      await page.evaluate(i => { restoreFromJSON(JSON.stringify({ payments: [{ id: i, name: 'Corr', amount: 500, note: '', date: '2026-10-09T06:30:00.000Z', monthKey: '2026-10' }] }));
        restoreFromCSV('Name,Amount (Rs),Date,Note\nCorr,-3000,08 Oct 2026,\n'); }, id);
      await uploaded(page); await idle(page);
      check(label + ' O7 History edit/delete, stray edit, Clear Month, JSON/CSV restore: receipt unchanged; no correction record, no log entry',
        rcv(corr) === '-3000@08' && voids() === v0 && ops() === o0, { r: rcv(corr), v: voids() - v0, o: ops() - o0 });
      check(label + ' O8 nothing else in the ledger or settlements changed by those attempts', snapshot() === before);
      // what an old page shows for receipt periods
      await page.evaluate(() => { viewMonth = new Date(2026, 9, 1); updateMonthLabels(); switchTab('history'); renderHistory(); }); await idle(page);
      check(label + ' O9 History: workshop list cannot be confirmed (old page gets no receipt totals)', /could not confirm/.test(await txt(page, '#historyD3')));
      await page.evaluate(() => { summaryGroup = 'workshop'; viewMonth = new Date(2026, 9, 7); switchTab('summary'); renderSummary(); }); await idle(page); await page.waitForTimeout(500);
      check(label + ' O10 Summary (workshop): totals unavailable', /Totals unavailable/.test(await txt(page, '#summaryD3')));
      const od = await details(page, 'stf_rohit');
      check(label + ' O11 Rohit details on the old page: withheld, no amounts', /wapas mila paisa hai/.test(od.det) && !/AAJ TAK/.test(od.det) && !/₹9,000/.test(od.wa), od.det);
      check(label + ' O12 no page errors', page.errors.length === 0, page.errors);
      await page.close();
    }

    // ======================================================== rollback to rc9-safe on the same data
    page = await phone(browser, { port: 8884, now: NOW });
    check('R1 rc9-safe is served', /rc9-safe-20261009/.test(await page.content()));
    let before = snapshot(), o0 = ops(), v0 = voids();
    const rid = rcvId(rohit);
    await page.evaluate(i => { deleteEntry(i); }, rid);
    if (await page.$('#confirmModal.show')) await page.click('#confirmYesBtn');
    await page.evaluate(i => save(load().map(e => e.id === i ? Object.assign({}, e, { amount: 14000 }) : e)), rid);
    await page.evaluate(() => { viewMonth = new Date(2026, 9, 1); clearMonth(); });
    await page.waitForSelector('#confirmModal.show'); await page.click('#confirmYesBtn');
    await uploaded(page); await idle(page);
    check('R2 rc9-safe delete / stray edit / Clear Month: every receipt and settlement unchanged; no log or correction record',
      snapshot() === before && ops() === o0 && voids() === v0 && rcv(rohit) === '-14000@11');
    check('R3 no page errors (rc9-safe)', page.errors.length === 0, page.errors);
    await page.close();
    page = await phone(browser, { port: 8881, now: NOW });
    await openPayday(page);
    check('R4 back on rc15: Rohit still ₹9,000 aap par baaki', /₹9,000 aap par baaki/.test(await row(page, 'stf_rohit')) && await closing(rohit) === -9000);
    await page.close();
  } catch (e) { check('no exception', false, e.stack); }
  await browser.close(); [srvNew, srv14, srv13, srv9].forEach(s => s.close());
  console.log(`\n${L.PASS.length} passed, ${L.FAIL.length} failed - receipts phone`);
  process.exit(L.FAIL.length ? 1 : 0);
})();
