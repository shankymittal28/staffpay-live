/*
 * StaffPay — Staff Work area (assign tasks, personal phone access) browser
 * verification at 390×844.
 *
 * The REAL index.html is served locally; Supabase is replaced by an in-test
 * fake (page.route) that answers the owner's session refresh and empty pay
 * tables; Project Zero is the REAL server on its stand-in database
 * (../project-zero/serve_fake.py, started here on port 8799), so what this
 * proves is the actual owner round-trip: employees come from the staff
 * registry, codes are issued by the server, access states are derived from
 * the server's records, tasks are created and acted on by the server.
 *
 *   node test_staff_work.js        (PZ_DIR=../project-zero by default)
 *   SHOT_DIR=/some/dir saves phone screenshots for a visual check.
 *   NODE_PATH=$(npm root -g) if playwright is installed globally.
 */
const fs = require('fs'), http = require('http'), path = require('path'), { spawn } = require('child_process');
const { chromium } = require('playwright');

const PORT = 8795, PZPORT = 8799, PZ = 'http://127.0.0.1:' + PZPORT, DIR = __dirname;
const PZ_DIR = process.env.PZ_DIR || path.join(DIR, '..', 'project-zero');
const SB = 'https://bsjrihrekfsxmajdsyhc.supabase.co', OWNER = 'owner.test.token';
const PASS = [], FAIL = [];
function check(name, cond, detail) { (cond ? PASS : FAIL).push(name); console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  -- ' + String(detail === undefined ? '' : (typeof detail === 'string' ? detail : JSON.stringify(detail))).slice(0, 800))); }
const json = (route, obj, status) => route.fulfill({ status: status || 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(obj) });
function req(method, p, token, body) {
  return new Promise((res, rej) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const r = http.request(PZ + p, { method, headers: Object.assign({}, token ? { Authorization: 'Bearer ' + token } : {}, data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) }, x => { let b = ''; x.on('data', d => b += d); x.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} res({ status: x.statusCode, json: j }); }); });
    r.on('error', rej); if (data) r.write(data); r.end();
  });
}
async function shot(page, nm) { if (process.env.SHOT_DIR) await page.screenshot({ path: path.join(process.env.SHOT_DIR, nm + '.png'), fullPage: true }); }
const vis = (page, sel) => page.isVisible(sel).catch(() => false);

(async () => {
  const pz = spawn('python3', ['serve_fake.py', String(PZPORT)], { cwd: PZ_DIR, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(res => pz.stdout.on('data', d => { if (String(d).includes('serve_fake on')) res(); }));
  const srv = http.createServer((q, r) => { const f = path.join(DIR, q.url.split('?')[0] === '/' ? 'index.html' : q.url.split('?')[0]); fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'Content-Type': f.endsWith('.html') ? 'text/html' : f.endsWith('.js') ? 'application/javascript' : 'application/octet-stream' }); r.end(d); }); });
  await new Promise(res => srv.listen(PORT, '127.0.0.1', res));
  const browser = await chromium.launch({ executablePath: process.env.CHROME || fs.readdirSync('/opt/pw-browsers').filter(d => /^chromium-\d+$/.test(d)).map(d => '/opt/pw-browsers/' + d + '/chrome-linux/chrome').find(fs.existsSync) });
  try {
    await req('GET', '/__reset');
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, serviceWorkers: 'block' });
    await ctx.addInitScript(([pzUrl, tok]) => { localStorage.setItem('sp_cloud_session', JSON.stringify({ access_token: tok, refresh_token: 'r', user: { id: 'x' } })); localStorage.setItem('sp_pz_url', pzUrl); localStorage.setItem('staffpay_schema_version', '2'); }, [PZ, OWNER]);
    const page = await ctx.newPage(); page.errors = []; page.on('pageerror', e => page.errors.push(String(e))); page.on('dialog', d => d.accept());
    const sbLog = [];
    await page.route(SB + '/**', async route => {
      const u = new URL(route.request().url()), m = route.request().method(); sbLog.push(m + ' ' + u.pathname);
      if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' } });
      if (u.pathname.startsWith('/auth/v1/token')) return json(route, { access_token: OWNER, refresh_token: 'r', user: { id: 'x' } });
      return json(route, []);
    });
    await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'networkidle' });
    await page.waitForSelector('.menu-btn', { timeout: 15000 });
    await page.click('.menu-btn'); await page.waitForTimeout(300);
    check('S1 the More menu offers "Staff Work"', await vis(page, '.more-item[data-tab="work"]'));
    await page.click('.more-item[data-tab="work"]'); await page.waitForSelector('#page-work.active');
    await page.waitForFunction(() => document.querySelectorAll('#wkAccess .wk-row').length > 0, null, { timeout: 8000 });
    const names = await page.$$eval('#wkAccess .wk-row .nm', els => els.map(e => e.textContent));
    check('S2 Personal phone access lists exactly the active staff from the registry (inactive/removed hidden), all "No access"',
      names.join() === 'Arjun,Raju,Vishal' && (await page.$$eval('#wkAccess .wk-row', els => els.map(e => e.dataset.access))).every(a => a === 'none'), names);
    const opts = await page.$$eval('#wkEmp option', els => els.map(e => e.textContent));
    check('S3 the employee picker offers the same three (by registry id, not typed names)', opts.length === 4 && /Arjun/.test(opts[1]) && (await page.$$eval('#wkEmp option', els => els.map(e => e.value))).slice(1).every(v => /^[0-9a-f-]{36}$/.test(v)), opts);
    await shot(page, 'sp-work-01-empty');

    // give access
    await page.click('#wkAccess .wk-row[data-access="none"] >> nth=0 >> button[data-act="issue"]');
    await page.waitForSelector('#wkCodeText'); await page.waitForTimeout(400);
    const codeText = (await page.textContent('#wkCodeText')).trim(), urlText = (await page.textContent('#wkCodeUrl')).trim();
    check('S4 "Give access" shows the one-time code ONCE (4+4 chars) with the exact Work URL and the instruction',
      /^[A-Z2-9]{4} [A-Z2-9]{4}$/.test(codeText) && urlText === PZ + '/staff-work' && /Shown once/.test(await page.textContent('#wkCode')) && /24 hours/.test(await page.textContent('#wkCode')), [codeText, urlText]);
    await page.waitForFunction(() => document.querySelector('#wkAccess .wk-row[data-access="code_waiting"]'), null, { timeout: 5000 });
    check('S5 Arjun\'s row now says "Code waiting" with the expiry', /Code waiting/.test(await page.textContent('#wkAccess .wk-row[data-access="code_waiting"]')) && /expires/.test(await page.textContent('#wkAccess .wk-row[data-access="code_waiting"]')));
    await shot(page, 'sp-work-02-code');
    const html = await page.content();
    check('S6 nothing secret is in the page besides the shown code: no hash, no token, no key', !/token_hash|code_hash|service_role|sb_secret/.test(html) && !/[0-9a-f]{64}/.test(html));
    // the phone activates (as the employee would)
    const act = (await req('POST', '/api/work/activate', null, { code: codeText.replace(' ', ''), phone_label: 'Arjun phone' })).json;
    check('S7 that code activates the phone on the server', act.ok && act.name === 'Arjun', act);
    const ARJUN_TOKEN = act.token;
    await page.click('#wkCode >> text=Done'); await page.waitForTimeout(200);
    await page.click('.more-item[data-tab="work"]', { force: true }).catch(() => {});
    await page.evaluate(() => SPWork.render()); await page.waitForFunction(() => document.querySelector('#wkAccess .wk-row[data-access="active"]'), null, { timeout: 5000 });
    check('S8 Arjun is now "Active on one phone" with the phone label and a Revoke button',
      /Active on one phone/.test(await page.textContent('#wkAccess .wk-row[data-access="active"]')) && /Arjun phone/.test(await page.textContent('#wkAccess .wk-row[data-access="active"]')) && await vis(page, '#wkAccess .wk-row[data-access="active"] button[data-act="revoke"]'));

    // assign with a customer reference
    await page.click('#wkAssignBtn'); await page.waitForTimeout(100);
    check('S9 Assign refuses an empty instruction', /Write what must be done/.test(await page.textContent('#wkAssignErr')));
    await page.fill('#wkInstr', 'Collect ₹12,500 from Amar ji');
    await page.selectOption('#wkEmp', { label: 'Arjun (shop)' });
    await page.fill('#wkDue', '2026-09-15');
    await page.fill('#wkRefQ', 'amar'); await page.waitForSelector('#wkRefRes .sugg-item', { timeout: 5000 });
    const sug = await page.textContent('#wkRefRes');
    check('S10 the reference picker finds the customer live (name + outstanding)', /Amar ji/.test(sug) && /13,000/.test(sug), sug);
    await page.click('#wkRefRes .sugg-item >> nth=0');
    check('S11 the chosen reference shows as a chip', await vis(page, '#wkRefSel') && /Amar ji/.test(await page.textContent('#wkRefSelText')));
    await shot(page, 'sp-work-03-assign');
    await page.click('#wkAssignBtn'); await page.waitForSelector('#wkTasks .wk-task', { timeout: 5000 });
    const card = await page.textContent('#wkTasks .wk-task');
    check('S12 the task appears under Pending with Arjun, due date and the reference label; form cleared',
      /Collect ₹12,500/.test(card) && /Arjun/.test(card) && /15\/09\/2026/.test(card) && /Amar Traders/.test(card) && (await page.inputValue('#wkInstr')) === '' && !(await vis(page, '#wkRefSel')), card);
    const rows = (await req('GET', '/__rows?table=pz_task_event')).json;
    check('S13 the server stored one created act: instruction, employee uuid, due date, ref type+id only, actor = owner uuid',
      rows.length === 1 && rows[0].act === 'created' && rows[0].ref_type === 'customer' && rows[0].ref_id === 'Amar Traders' && rows[0].actor_kind === 'owner' && /^[0-9a-f-]{36}$/.test(rows[0].employee_id), rows);
    const tid = rows[0].id;

    // the phone blocks it; Shanky sees it first, with the reason
    await req('POST', '/api/work/task/blocked', ARJUN_TOKEN, { task_id: tid, note: 'Amar ji out till Monday' });
    await page.evaluate(() => SPWork.render()); await page.waitForSelector('#wkTasks .wk-task.blocked', { timeout: 5000 });
    check('S14 a Blocked task comes first with its reason', /Blocked \(1\)/.test(await page.textContent('#wkTasks')) && /out till Monday/.test(await page.textContent('#wkTasks .wk-task.blocked')));
    await page.click('#wkTasks .wk-task.blocked'); await page.waitForSelector('#wkDetailCard');
    const d = await page.textContent('#wkDetailCard');
    check('S15 the detail shows the live customer (outstanding now), the history with the employee\'s name, and Reassign / Withdraw / Reopen', /Outstanding now/.test(d) && /13,000/.test(d) && /Arjun · blocked/.test(d) && /Reassign/.test(d) && /Withdraw/.test(d) && /Reopen/.test(d), d);
    await shot(page, 'sp-work-04-detail');
    await page.click('#wkDetailCard >> text=Reassign'); await page.click('#wkActGo'); await page.waitForTimeout(100);
    check('S16 Reassign needs a reason', /reason is required/.test(await page.textContent('#wkActErr')));
    await page.selectOption('#wkActEmp', { label: 'Vishal' }); await page.fill('#wkActNote', 'Arjun on leave'); await page.click('#wkActGo');
    await page.waitForFunction(() => /Vishal/.test(document.querySelector('#wkTasks').textContent), null, { timeout: 5000 });
    check('S17 after Reassign the card shows Vishal and is pending again', /Vishal/.test(await page.textContent('#wkTasks .wk-task')) && /pending/.test(await page.$eval('#wkTasks .wk-task', e => e.className)));
    check('S18 Arjun no longer sees it; it is a new act row (created, blocked, reassigned)', (await req('GET', '/api/work/tasks', ARJUN_TOKEN)).json.tasks.length === 0 && (await req('GET', '/__rows?table=pz_task_event')).json.map(r => r.act).join() === 'created,blocked,reassigned');
    await page.click('#wkTasks .wk-task'); await page.waitForSelector('#wkDetailCard');
    await page.click('#wkDetailCard >> text=Withdraw'); await page.fill('#wkActNote', 'Not needed'); await page.click('#wkActGo');
    await page.waitForFunction(() => /No open tasks/.test(document.querySelector('#wkTasks').textContent), null, { timeout: 5000 });
    check('S19 Withdraw with a reason hides the task; the rows stay', (await req('GET', '/__rows?table=pz_task_event')).json.length === 4);

    // revoke
    await page.click('#wkAccess .wk-row[data-access="active"] button[data-act="revoke"]'); await page.waitForSelector('#confirmModal.show');
    check('S20 Revoke asks first', /loses access immediately/.test(await page.textContent('#confirmMsg')));
    await page.click('#confirmYesBtn');
    await page.waitForFunction(() => document.querySelectorAll('#wkAccess .wk-row[data-access="active"]').length === 0, null, { timeout: 5000 });
    check('S21 after Revoke Arjun is back to "No access" and the phone token is dead', (await req('GET', '/api/work/me', ARJUN_TOKEN)).status === 401);
    await shot(page, 'sp-work-05-revoked');
    check('S22 StaffPay wrote nothing to its own tables for any of this (only the session refresh + snapshot reads)', !sbLog.some(l => /^(POST|PATCH|DELETE) \/rest/.test(l)), sbLog);
    check('S23 no page error', page.errors.length === 0, page.errors);
  } finally { await browser.close(); srv.close(); pz.kill(); }
  console.log('\n%d passed, %d failed — StaffPay Staff Work verified.', PASS.length, FAIL.length);
  process.exit(FAIL.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
