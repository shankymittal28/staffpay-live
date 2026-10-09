/*
 * D3 browser acceptance: the REAL index.html + d3-hisab.js + staff-cloud.js on a
 * 390x844 phone, in Asia/Kolkata, talking to the disposable PostgreSQL +
 * PostgREST (env.sh) exactly as the app talks to Supabase. Project Zero is a
 * stub (attendance is seeded directly in the shape its server writes).
 * Expected rupee amounts are worked out by hand in the comments.
 *
 *   test_d3/env.sh up && node test_d3/test_d3_browser.js
 *   APP_DIR=<dir> picks which build to serve (rollback test uses it).
 */
const fs = require('fs'), http = require('http'), path = require('path');
const { chromium } = require('playwright');
const L = require('./lib.js'), { check, sql, OWNER } = L;
const APP = process.env.APP_DIR || path.join(__dirname, '..'), PORT = 8823;
const SB = 'https://bsjrihrekfsxmajdsyhc.supabase.co', PZ = 'https://pz.test';
const NOW = '2026-10-11T18:00:00+05:30';                   // Sunday evening, Asia/Kolkata
const TOK = L.token(OWNER);

async function phone(browser, opts) {
  opts = opts || {};
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'Asia/Kolkata', serviceWorkers: 'block' });
  await ctx.addInitScript(([pz, tok]) => {
    if (!localStorage.getItem('sp_cloud_session')) localStorage.setItem('sp_cloud_session', JSON.stringify({ access_token: tok, refresh_token: 'r', user: { id: 'x' } }));
    localStorage.setItem('sp_pz_url', pz);
  }, [PZ, TOK]);
  const page = await ctx.newPage(); page.errors = [];
  page.on('pageerror', e => page.errors.push(String(e)));
  await page.clock.setSystemTime(new Date(opts.now || NOW));   // time keeps moving (payment ids are ms timestamps)
  page.ctl = { dropReply: null, failPaymentWrites: false, rpcLog: [] };
  await page.route(SB + '/**', async route => {
    const rq = route.request(), u = new URL(rq.url()), m = rq.method();
    const H = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*', 'Access-Control-Expose-Headers': '*' };
    if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: H });
    if (u.pathname.startsWith('/auth/v1/token')) return route.fulfill({ status: 200, headers: H, contentType: 'application/json', body: JSON.stringify({ access_token: TOK, refresh_token: 'r', user: { id: OWNER } }) });
    const rest = u.pathname.replace('/rest/v1', '') + u.search;
    if (page.ctl.failPaymentWrites && m !== 'GET' && rest.startsWith('/staff_payment')) return route.abort('internetdisconnected');
    if (rest.startsWith('/rpc/')) page.ctl.rpcLog.push(rest.split('?')[0].slice(5));
    const hdr = {}; for (const [k, v] of Object.entries(rq.headers())) if (/^(authorization|prefer|content-type|range)$/i.test(k)) hdr[k] = v;
    const resp = await fetch(L.API + rest, { method: m, headers: hdr, body: ['GET', 'HEAD'].includes(m) ? undefined : rq.postData() });
    const body = await resp.text();
    if (page.ctl.dropReply && rest.startsWith('/rpc/' + page.ctl.dropReply)) { page.ctl.dropReply = null; return route.abort('connectionreset'); }   // saved, reply lost
    return route.fulfill({ status: resp.status, headers: Object.assign({}, H, { 'content-type': resp.headers.get('content-type') || 'application/json' }), body });
  });
  await page.route(PZ + '/**', route => route.request().method() === 'OPTIONS'
    ? route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' } })
    : route.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': '*' }, contentType: 'application/json', body: JSON.stringify({ ok: true, teams: [], employees: [], tasks: [] }) }));
  page.on('dialog', d => d.accept());
  await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.getElementById('cloudBoot').style.display === 'none', null, { timeout: 15000 });
  return page;
}
// text of an element with every block/flex child separated by a space
const txt = (page, sel) => page.$eval(sel, el => { const parts = []; const walk = n => { if (n.nodeType === 3) parts.push(n.textContent); else if (n.nodeType === 1 && getComputedStyle(n).display !== 'none') n.childNodes.forEach(walk); parts.push(' '); }; walk(el); return parts.join('').replace(/\s+/g, ' ').trim(); }).catch(() => '');
const idle = page => page.waitForLoadState('networkidle').then(() => page.waitForTimeout(400));
// the app retries its upload queue every 15 s; tests flush it the same way instead of waiting
async function uploaded(page) {
  for (let i = 0; i < 20; i++) {
    const left = await page.evaluate(() => window.__SP_STORE__.flush().then(() => window.__SP_STORE__.outbox.length));
    if (!left) return true; await page.waitForTimeout(200);
  }
  return false;
}
async function addPayment(page, entry, day) {
  await page.evaluate(([e, d]) => { switchTab('add'); document.getElementById('quickEntry').value = e; document.getElementById('paymentDate').value = d; addEntry(); }, [entry, day]);
  await page.waitForTimeout(300);
}
async function openHisab(page, legacy) {
  await page.evaluate(() => { hisabWeek = new Date(2026, 9, 5); switchTab('hisab'); });
  await page.waitForFunction(l => { const el = document.getElementById('d3h_' + l); return el && !/Loading/.test(el.innerText); }, legacy, { timeout: 15000 });
}
const legacyOf = id => sql(`select legacy_id from staff_employee where id = '${id}'`);
const dbAmt = like => sql(`select coalesce(string_agg(amount::text, ',' order by date), '') from staff_payment where legacy_id like '${like}'`);

(async () => {
  const srv = http.createServer((q, r) => { const f = path.join(APP, q.url.split('?')[0] === '/' ? 'index.html' : q.url.split('?')[0]);
    fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'Content-Type': f.endsWith('.html') ? 'text/html' : 'application/javascript' }); r.end(d); }); });
  await new Promise(res => srv.listen(PORT, '127.0.0.1', res));
  const exe = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find(fs.existsSync);
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  try {
    L.reset(); L.setToday('2026-10-11');
    const sonu = L.emp({ name: 'Sonu', rate: 800, ob: 0, obDate: '2026-10-04', legacy: 'stf_sonu' });
    const ravi = L.emp({ name: 'Ravi', rate: 500, legacy: 'stf_ravi' });                       // no Old Hisab yet
    const twin = L.emp({ name: 'Twin', rate: 1000, ob: 0, obDate: '2026-10-04', legacy: 'stf_twin' });
    const shop = L.emp({ name: 'ShopRaju', group: 'shop', wage: 'daily', rate: 400, legacy: 'stf_shopraju' });
    L.attRange(sonu, '2026-10-05', 'PPHPPHA');                // 5 days x 800 = 4000
    L.attRange(ravi, '2026-10-05', 'PPPPPPP');
    L.attRange(twin, '2026-10-05', 'PPPPPPP');                // 7000
    L.attRange(shop, '2026-10-01', 'PPH');                    // shop: 2.5 days x 400 = 1000
    let page = await phone(browser);

    // ---- advances through the ordinary "+ Add" screen -------------------------
    await addPayment(page, 'Sonu 1000', '2026-10-06');
    await addPayment(page, 'Sonu 500', '2026-10-09');
    await addPayment(page, 'ShopRaju 500', '2026-10-02');
    await uploaded(page);
    const linked = sql(`select count(*) from staff_payment where staff_legacy_id = 'stf_sonu' and staff_id = '${sonu}'`);
    check('B1 "+ Add" advances reach the database with the stable worker reference and link', linked === '2', linked);

    // ---- Weekly Hisab report and Sunday settlement ----------------------------
    await openHisab(page, 'stf_sonu');
    let card = await txt(page, '#d3h_stf_sonu');
    check('B2 report explains every rupee: 5 days x 800 = 4000; advances 1000 + 500; to give 2500',
      /Days worked 4 \+ 2×½ = 5/.test(card) && /5 × ₹800 = ₹4,000/.test(card) && /Total advances ₹1,500/.test(card)
      && /₹0 \+ ₹4,000 − ₹1,500 = ₹2,500/.test(card) && /Opening balance \(Old Hisab, end of 04 Oct 2026\) ₹0 — nothing owed/.test(card), card);
    check('B3 settlement cash pre-filled with 2500', (await page.inputValue('#d3c_stf_sonu')) === '2500');
    await page.click('#d3h_stf_sonu .btn-hisab-settle');
    await page.waitForTimeout(300);
    check('B4 Settle refused on screen until both confirmations are ticked', dbAmt('stl_%') === '');
    await page.check('#d3s_stf_sonu'); await page.check('#d3a_stf_sonu');
    await page.click('#d3h_stf_sonu .btn-hisab-settle');
    await page.waitForFunction(() => /Cash paid at weekly settlement \(Sun, 11 Oct\)/.test((document.getElementById('d3h_stf_sonu') || {}).innerText || ''), null, { timeout: 15000 });
    card = await txt(page, '#d3h_stf_sonu');
    check('B5 settled: one payment of 2500 dated Sunday in the database; card shows closing ₹0',
      dbAmt('stl_' + sonu + '%') === '2500' && sql(`select (date at time zone 'Asia/Kolkata')::date from staff_payment where legacy_id like 'stl_${sonu}%'`) === '2026-10-11'
      && /Closing balance ₹0 — nothing owed/.test(card), card);

    // ---- Details + WhatsApp show the same report --------------------------------
    await page.evaluate(() => { viewMonth = new Date(2026, 9, 5); openStaffDetail('stf_sonu'); });
    await page.waitForFunction(() => /Closing balance/.test((document.getElementById('d3Detail') || {}).innerText || ''), null, { timeout: 15000 });
    const det = await txt(page, '#d3Detail');
    const wa = await page.evaluate(() => buildHisabText('stf_sonu'));
    check('B6 Details shows the same figures (4000 earned, 1500 advances, 2500 settlement, closing 0)',
      /₹4,000/.test(det) && /Total advances ₹1,500/.test(det) && /₹2,500/.test(det) && /Closing balance ₹0/.test(det), det);
    check('B7 WhatsApp hisab carries the same lines', /Weekly earnings: 5 × ₹800 = ₹4,000/.test(wa) && /Total advances: ₹1,500/.test(wa)
      && /Closing balance: ₹0 — nothing owed/.test(wa) && !/jald aa raha/.test(wa), wa);

    // ---- Payroll (October, workshop row from the database) ----------------------
    await page.evaluate(() => { viewMonth = new Date(2026, 9, 1); updateMonthLabels(); switchTab('payroll'); });
    await page.waitForFunction(() => /Hisab balance till/.test((document.getElementById('d3p_stf_sonu') || {}).innerText || ''), null, { timeout: 15000 });
    const pr = await txt(page, '#d3p_stf_sonu');
    // Oct to 11 Oct: earned 4000; paid 1000 + 500 + 2500 = 4000; brought forward 0; balance 0
    check('B8 Payroll workshop row: brought fwd 0, earned 4000, paid 4000, balance 0 till 11 Oct', /₹0 BROUGHT FWD/i.test(pr) && /₹4,000 EARNED/i.test(pr) && /₹4,000 PAID/i.test(pr) && /till 11 Oct 2026: ₹0 — nothing owed/.test(pr), pr);
    const shopRow = await page.$$eval('.payroll-row', rs => rs.map(r => r.innerText.replace(/\s+/g, ' ')).find(t => /ShopRaju/.test(t)) || '');
    check('B9 shop Payroll unchanged: 2/1/0, earned 1000, paid 500, balance 500', /₹500/.test(shopRow) && /2\/1\/0/.test(shopRow) && /₹1,000 EARNED/i.test(shopRow) && /₹500 PAID/i.test(shopRow), shopRow);

    // ---- History buttons + controlled correction --------------------------------
    await page.evaluate(() => { viewMonth = new Date(2026, 9, 1); updateMonthLabels(); switchTab('history'); });
    await idle(page);
    const hist = await page.$$eval('#historyList .entry-item', rs => rs.map(r => r.innerText.replace(/\s+/g, ' ')));
    const stlRowTxt = hist.find(t => /2,500/.test(t)) || '';
    check('B10 settlement payment in History opens Weekly Hisab (no edit/delete)', /Weekly Hisab/.test(stlRowTxt) && !/×/.test(stlRowTxt), hist);
    const id500 = await page.evaluate(() => String(load().find(e => e.amount === 500 && e.name === 'Sonu').id));
    await page.evaluate(id => deleteEntry(Number(id)), id500);
    await page.waitForSelector('#d3CorrModal.show');
    check('B11 deleting a weekly-hisab advance opens "Correct this payment" instead', await page.isVisible('#d3CorrModal'));
    await page.selectOption('#d3CorrAct', 'remove'); await page.check('#d3CorrNot'); await page.fill('#d3CorrWhy', 'entered twice');
    await page.click('#d3CorrGo'); await idle(page);
    check('B12 correction recorded: advance removed, kept in the correction record', sql(`select count(*) from staff_payment where legacy_id = '${id500}'`) === '0'
      && sql(`select reason from staff_payment_void where legacy_id = '${id500}'`) === 'entered twice');
    await openHisab(page, 'stf_sonu');
    card = await txt(page, '#d3h_stf_sonu');
    // 0 + 4000 - 1000 - 2500 = 500 now owed by the shop
    check('B13 Hisab after the correction: advances 1000, closing 500 (shop owes)', /Total advances ₹1,000/.test(card) && /Closing balance ₹500 — shop owes worker/.test(card), card);

    // ---- Clear This Month keeps protected money ----------------------------------
    await page.evaluate(() => { viewMonth = new Date(2026, 9, 1); updateMonthLabels(); switchTab('summary'); clearMonth(); });
    await page.waitForSelector('#confirmModal.show'); const cmsg = await txt(page, '#confirmMsg');
    await page.click('#confirmYesBtn'); await uploaded(page); await idle(page);
    check('B14 Clear This Month warns and keeps weekly-hisab payments; the shop payment is cleared',
      /2 workshop weekly-hisab payment\(s\) will be KEPT/.test(cmsg) && dbAmt('stl_' + sonu + '%') === '2500'
      && sql(`select count(*) from staff_payment where staff_id = '${sonu}' and amount = 1000`) === '1'
      && sql(`select count(*) from staff_payment where staff_id = '${shop}'`) === '0', cmsg);

    // ---- Old Hisab entered on screen; rate change refused; protected fields ----------
    await openHisab(page, 'stf_ravi');
    check('B15 worker without Old Hisab: "not entered", no balance, entry form shown', /Old Hisab not entered/.test(await txt(page, '#d3h_stf_ravi')) && await page.isVisible('#d3oa_stf_ravi'));
    await page.fill('#d3oa_stf_ravi', '2000'); await page.selectOption('#d3od_stf_ravi', '-1'); await page.fill('#d3ot_stf_ravi', '2026-10-04');
    await page.click('#d3h_stf_ravi .wk-btn.go'); await idle(page);
    await page.waitForFunction(() => /Opening balance/.test((document.getElementById('d3h_stf_ravi') || {}).innerText || ''), null, { timeout: 15000 });
    card = await txt(page, '#d3h_stf_ravi');
    // -2000 + 7 x 500 = 1500 owed by the shop
    check('B16 Old Hisab saved as -2000 at end of 04 Oct; week closing 1500', sql(`select opening_balance || '|' || opening_balance_date from staff_employee where id = '${ravi}'`) === '-2000|2026-10-04'
      && /₹2,000 — worker owes shop/.test(card) && /Closing balance ₹1,500 — shop owes worker/.test(card), card);
    await page.evaluate(() => { switchTab('staff'); editStaffRow('Ravi'); });
    const locked = await page.$eval('#ie_group', el => el.disabled) && await page.$eval('#ie_wage', el => el.disabled) && !(await page.$('#ie_opening'));
    await page.fill('#ie_amount', '600'); await page.fill('#ie_phone', '9999');
    await page.evaluate(() => saveStaffRow()); await uploaded(page); await idle(page); await page.waitForTimeout(600);
    const rv = sql(`select salary || '|' || phone from staff_employee where id = '${ravi}'`);
    const shown = await page.evaluate(() => empOf('stf_ravi').salary);
    check('B17 rate change refused (week not settled); phone saved; screen shows the database\'s 500', locked && rv === '500|9999' && shown === 500, { locked, rv, shown });

    // ---- lost reply: "Save not confirmed - checking" ----------------------------
    await openHisab(page, 'stf_twin');
    await page.check('#d3s_stf_twin'); await page.check('#d3a_stf_twin');
    page.ctl.dropReply = 'staff_settlement_apply';
    await page.click('#d3h_stf_twin .btn-hisab-settle');
    await page.waitForFunction(() => /Cash paid at weekly settlement \(Sun, 11 Oct\)/.test((document.getElementById('d3h_stf_twin') || {}).innerText || ''), null, { timeout: 15000 });
    check('B18 reply lost after the save: checked via status, exactly one settlement payment, nothing left pending',
      dbAmt('stl_' + twin + '%') === '7000' && page.ctl.rpcLog.includes('staff_d3_op_status')
      && (await page.evaluate(() => Object.keys(SPD3.pending()).length)) === 0, page.ctl.rpcLog);

    // ---- payments not yet uploaded on this phone block settlement ---------------
    L.attRange(sonu, '2026-10-12', 'PPPPPPP'); L.setToday('2026-10-18');
    await page.close();
    page = await phone(browser, { now: '2026-10-18T19:00:00+05:30' });
    page.ctl.failPaymentWrites = true;
    await addPayment(page, 'Sonu 300', '2026-10-15');
    await page.evaluate(() => { hisabWeek = new Date(2026, 9, 12); switchTab('hisab'); });
    await page.waitForFunction(() => { const el = document.getElementById('d3h_stf_sonu'); return el && !/Loading/.test(el.innerText); }, null, { timeout: 15000 });
    await page.check('#d3s_stf_sonu'); await page.check('#d3a_stf_sonu');
    await page.click('#d3h_stf_sonu .btn-hisab-settle'); await page.waitForTimeout(500);
    check('B19 settlement waits while this phone has payments not yet uploaded', /not yet uploaded/.test(await txt(page, '#d3h_stf_sonu')) && dbAmt('stl_' + sonu + '_2026-10-12%') === '');
    page.ctl.failPaymentWrites = false;

    // ---- shop staff: create / edit / save / reopen, Details + WhatsApp (D1) -----
    await page.evaluate(() => { switchTab('staff'); document.getElementById('staffNameInput').value = 'NewShop';
      document.getElementById('staffGroupInput').value = 'shop'; document.getElementById('staffWageTypeInput').value = 'daily';
      document.getElementById('staffSalaryInput').value = '350'; addStaff(); });
    await uploaded(page); await idle(page);
    await page.evaluate(() => editStaffRow('NewShop'));
    const shopUnlocked = !(await page.$eval('#ie_group', el => el.disabled)) && !!(await page.$('#ie_opening'));
    await page.fill('#ie_amount', '375'); await page.fill('#ie_opening', '1200');
    await page.evaluate(() => saveStaffRow()); await uploaded(page); await idle(page);
    await page.reload({ waitUntil: 'networkidle' }); await page.waitForFunction(() => document.getElementById('cloudBoot').style.display === 'none');
    await page.evaluate(() => { switchTab('staff'); editStaffRow('NewShop'); });
    const reopened = [await page.inputValue('#ie_amount'), await page.inputValue('#ie_opening'), await page.inputValue('#ie_group')];
    check('B20 shop worker created, edited (rate 375, opening 1200), saved and reopened unchanged in behaviour',
      shopUnlocked && JSON.stringify(reopened) === '["375","1200","shop"]'
      && sql(`select salary || '|' || opening_balance || '|' || coalesce(opening_balance_date::text, 'none') from staff_employee where name = 'NewShop'`) === '375|1200|none', reopened);
    await page.evaluate(() => { viewMonth = new Date(2026, 9, 1); openStaffDetail('stf_shopraju'); });
    await page.waitForTimeout(300);
    const sd = await txt(page, '#staffDetailContent .banner'), swa = await page.evaluate(() => buildHisabText('stf_shopraju'));
    // shop: 2.5 days x 400 = 1000 earned; the 500 payment was cleared with the month -> paid 0, balance 1000
    check('B21 shop Details and WhatsApp still use the monthly hisab (D1): earned 1000, balance 1000', /₹1,000/.test(sd) && /Daily/.test(sd)
      && /Kamai \(earned\): ₹1,000/.test(swa) && /Baaki balance: ₹1,000/.test(swa), { sd, swa });
    check('B22 no page errors', page.errors.length === 0, page.errors);
    await page.close();
  } finally { await browser.close(); srv.close(); }
  console.log('\n' + L.PASS.length + ' passed, ' + L.FAIL.length + ' failed - D3 browser');
  process.exit(L.FAIL.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
