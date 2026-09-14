/*
 * StaffPay — the owner's sign-in renews itself, at 390x844.
 *
 * A StaffPay sign-in token lasts about an hour. On 14 Sept 2026 the owner
 * created a team, worked on, and then tapped "Give access": the token had
 * quietly expired, Project Zero refused the request, and the app told him to
 * sign out and sign in again. This test locks in the cure: before an
 * owner-only request is given up on, the app renews the sign-in ONCE and
 * sends the request again with the NEWLY returned token.
 *
 * The REAL index.html is served locally; Supabase is a stub that mints the
 * tokens this test chooses (so "expired" and "cannot be renewed" are exact,
 * not timing-dependent); Project Zero is the REAL server on its stand-in
 * database (../project-zero/serve_fake.py), which accepts exactly one owner
 * token and refuses every other one.
 *
 *   node test_owner_session.js       (PZ_DIR=../project-zero by default)
 *   SHOT_DIR=/some/dir saves phone screenshots for a visual check.
 *   NODE_PATH=$(npm root -g) if playwright is installed globally.
 *
 * No token value is ever printed: the log says OLD or NEW, never the token.
 */
const fs = require('fs'), http = require('http'), path = require('path'), { spawn } = require('child_process');
const { chromium } = require('playwright');

const PORT = 8789, PZPORT = 8805, PZ = 'http://127.0.0.1:' + PZPORT, DIR = __dirname;
const PZ_DIR = process.env.PZ_DIR || path.join(DIR, '..', 'project-zero');
const SB = 'https://bsjrihrekfsxmajdsyhc.supabase.co';
const NEW = 'owner.test.token';        // the only token the server accepts
const OLD = 'owner.expired.token';     // an hour-old token: refused, exactly as production refuses it
const DAY = '2026-09-03';              // the stand-in server's own business day
const PASS = [], FAIL = [];
function check(name, cond, detail) { (cond ? PASS : FAIL).push(name); console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  -- ' + String(detail === undefined ? '' : (typeof detail === 'string' ? detail : JSON.stringify(detail))).slice(0, 600))); }
const json = (route, obj, status) => route.fulfill({ status: status || 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(obj) });
function req(method, p, token, body) {
  return new Promise((res, rej) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const r = http.request(PZ + p, { method, headers: Object.assign({}, token ? { Authorization: 'Bearer ' + token } : {}, data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) },
      x => { let b = ''; x.on('data', d => b += d); x.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} res({ status: x.statusCode, json: j }); }); });
    r.on('error', rej); if (data) r.write(data); r.end();
  });
}
const rows = t => req('GET', '/__rows?table=' + t).then(r => r.json || []);
async function shot(page, nm) { if (process.env.SHOT_DIR) await page.screenshot({ path: path.join(process.env.SHOT_DIR, nm + '.png'), fullPage: true }); }
const vis = (page, sel) => page.isVisible(sel).catch(() => false);
// what a request carried, named — never the token itself
const label = t => t === 'Bearer ' + NEW ? 'NEW' : t === 'Bearer ' + OLD ? 'OLD' : 'OTHER';

(async () => {
  const pz = spawn('python3', ['serve_fake.py', String(PZPORT)], { cwd: PZ_DIR, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(res => pz.stdout.on('data', d => { if (String(d).includes('serve_fake on')) res(); }));
  const srv = http.createServer((q, r) => { const f = path.join(DIR, q.url.split('?')[0] === '/' ? 'index.html' : q.url.split('?')[0]); fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'Content-Type': f.endsWith('.html') ? 'text/html' : f.endsWith('.js') ? 'application/javascript' : 'application/octet-stream' }); r.end(d); }); });
  await new Promise(res => srv.listen(PORT, '127.0.0.1', res));
  const browser = await chromium.launch({ executablePath: process.env.CHROME || fs.readdirSync('/opt/pw-browsers').filter(d => /^chromium-\d+$/.test(d)).map(d => '/opt/pw-browsers/' + d + '/chrome-linux/chrome').find(fs.existsSync) });
  try {
    await req('GET', '/__reset');
    const emps = (await req('GET', '/api/work/owner/employees', NEW)).json.employees;
    const ID = {}; emps.forEach(e => { if (!ID[e.name]) ID[e.name] = e.id; });

    // ---- the server's own door, before any browser is involved -------------
    // Every /api/work/owner/... request passes ONE owner check. Phone-code
    // issuing and team creation are two doors in the same wall.
    const forged = (await req('POST', '/api/work/owner/access/issue', 'forged.not.a.token', { employee_id: ID.Arjun }));
    const forgedTeam = (await req('POST', '/api/work/owner/team', 'forged.not.a.token', { action: 'create', name: 'Forged' }));
    check('V1 a forged token is refused for phone codes AND for team creation, identically',
      forged.status === 401 && forgedTeam.status === 401 && JSON.stringify(forged.json) === JSON.stringify(forgedTeam.json), [forged.status, forgedTeam.status]);
    const noTok = await req('POST', '/api/work/owner/access/issue', null, { employee_id: ID.Arjun });
    check('V2 no token at all is refused the same way', noTok.status === 401 && !JSON.stringify(noTok.json || {}).includes('Arjun'), noTok.status);
    const src = fs.readFileSync(path.join(PZ_DIR, 'staff_work_service.py'), 'utf8');
    check('V3 the server has exactly ONE owner check guarding every owner route (nothing can grow its own)',
      (src.match(/if path\.startswith\("\/api\/work\/owner\/"\):\s*\n\s*owner = _owner\(headers\)\s*\n\s*if not owner:\s*\n\s*return _j\(401/) || []).length === 1
      && !/OWNER_EMAIL|owner_email|@gmail/.test(src), 'owner gate shape');
    check('V4 owner identity is a verified account id, never an e-mail and never a remembered name',
      /str\(u\.get\("id"\)\) != want/.test(src) && /_auth_user\(tok\)/.test(src), 'uid check present');
    // the employee's own phone token must never open an owner door
    const code = (await req('POST', '/api/work/owner/access/issue', NEW, { employee_id: ID.Raju })).json.code;
    const phoneTok = (await req('POST', '/api/work/activate', null, { code: code, phone_label: 'Raju phone' })).json.token;
    const asEmp = await req('GET', '/api/work/owner/employees', phoneTok);
    check('V5 an employee\'s own phone token is still refused at every owner door',
      asEmp.status === 401 && (await req('POST', '/api/work/owner/team', phoneTok, { action: 'create', name: 'X' })).status === 401
      && (await req('POST', '/api/work/owner/attendance', phoneTok, { employee_id: ID.Raju, day_key: DAY, status: 'Present' })).status === 401, asEmp.status);
    await req('GET', '/__reset');   // clean slate for the browser half

    // ---- the browser, with a token that expired an hour ago -----------------
    let refreshes = 0, mint = NEW, refreshBroken = false;
    const authLog = [];             // { path, carried: 'OLD' | 'NEW' }
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, serviceWorkers: 'block' });
    await ctx.addInitScript(([pzUrl, tok]) => {
      localStorage.setItem('sp_cloud_session', JSON.stringify({ access_token: tok, refresh_token: 'r', user: { id: 'x' } }));
      localStorage.setItem('sp_pz_url', pzUrl); localStorage.setItem('staffpay_schema_version', '2');
    }, [PZ, OLD]);
    const page = await ctx.newPage(); page.errors = []; page.on('pageerror', e => page.errors.push(String(e)));
    page.on('dialog', d => d.accept());
    await page.route(SB + '/**', async route => {
      const rq = route.request(), u = new URL(rq.url()), m = rq.method();
      if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' } });
      if (u.pathname.startsWith('/auth/v1/token')) {
        refreshes++;
        if (refreshBroken) return json(route, { error: 'invalid_grant', error_description: 'refresh token expired' }, 400);
        return json(route, { access_token: mint, refresh_token: 'r', user: { id: 'x' } });
      }
      const table = u.pathname.replace('/rest/v1/', '');
      if (m !== 'GET') return json(route, [], 403);
      if (table === 'staff_employee') return json(route, await rows('staff_employee'));
      if (table === 'staff_attendance') return json(route, (await rows('staff_attendance')).map(a => ({
        id: String(a.id), legacy_id: a.legacy_id, staff_id: a.staff_id, name: a.name, status: a.status,
        note: a.note || '', date: a.date, month_key: a.month_key, day_key: a.day_key })));
      return json(route, []);
    });
    await page.route(PZ + '/**', async route => {
      const rq = route.request();
      authLog.push({ path: new URL(rq.url()).pathname, carried: label(rq.headers()['authorization']) });
      await route.continue();
    });

    await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.menu-btn', { timeout: 20000 });
    check('O1 the app still opens by renewing the stored sign-in once, as before', refreshes === 1 && !(await vis(page, '#cbForm')), refreshes);
    // the hour runs out while Shanky is working — exactly the 14 Sept incident
    await page.evaluate(t => { window.__SP_NET__.session.access_token = t; }, OLD);
    const beforeLists = refreshes;
    await page.click('.menu-btn'); await page.click('.more-item[data-tab="work"]');
    await page.waitForSelector('#page-work.active');
    await page.waitForFunction(() => document.querySelectorAll('#wkAccess .wk-row').length > 0, null, { timeout: 10000 });
    const names = await page.$$eval('#wkAccess .wk-row .nm', els => els.map(e => e.textContent));
    const seen = () => page.evaluate(() => document.body.innerText);
    check('O2 a stale token is renewed silently: Staff Work loads, nobody is told to sign out',
      names.join() === 'Arjun,Raju,Vishal' && !/sign out/i.test(await seen()) && !(await vis(page, '#cbForm')), names);
    const listTries = authLog.filter(a => a.path === '/api/work/owner/employees');
    check('O3 the refused request was sent again with the NEW token, never the old one',
      listTries.length === 2 && listTries[0].carried === 'OLD' && listTries[1].carried === 'NEW', listTries);
    check('O4 three refused requests share ONE renewal — it never loops',
      refreshes - beforeLists === 1, refreshes - beforeLists);
    await shot(page, 'sp-session-01-renewed');

    // ---- "Give access" with a token that expires in the owner's hand --------
    await page.evaluate(t => { window.__SP_NET__.session.access_token = t; }, OLD);   // the hour runs out
    const beforeIssue = refreshes;
    await page.click('#wkAccess .wk-row[data-access="none"] >> nth=0 >> button[data-act="issue"]');
    await page.waitForSelector('#wkCodeText', { timeout: 10000 }); await page.waitForTimeout(400);
    const codeText = (await page.textContent('#wkCodeText')).trim();
    check('O5 "Give access" still produces the one-time code — the incident of 14 Sept cannot repeat',
      /^[A-Z2-9]{4} [A-Z2-9]{4}$/.test(codeText) && !/sign out/i.test(await seen()), codeText.length);
    const issueTries = authLog.filter(a => a.path === '/api/work/owner/access/issue');
    check('O6 the code request was renewed once and retried with the NEW token',
      issueTries.length === 2 && issueTries[0].carried === 'OLD' && issueTries[1].carried === 'NEW'
      && refreshes - beforeIssue === 1, [issueTries, refreshes - beforeIssue]);
    const creds = await rows('pz_work_credential'), acc = await rows('pz_work_access_event');
    check('O7 exactly ONE code exists despite the request being sent twice',
      creds.length === 1 && acc.filter(e => e.act === 'code_issued').length === 1, [creds.length, acc.map(e => e.act)]);
    check('O8 the refused first attempt left no trace: only the successful retry is recorded',
      acc.length === 2 && acc.every(e => e.actor_kind === 'owner'), acc.map(e => e.act));
    await page.click('#wkCode button.wk-btn:not(.go)').catch(() => {});
    await shot(page, 'sp-session-02-code');

    // ---- team setup, the other owner door, with an expired token ------------
    await page.evaluate(t => { window.__SP_NET__.session.access_token = t; }, OLD);
    await page.fill('#wkNewTeam', 'Aluminium'); await page.click('text=Create team');
    await page.waitForSelector('.wk-team', { timeout: 8000 });
    const teamTries = authLog.filter(a => a.path === '/api/work/owner/team');
    check('O9 team creation renews the same way — one owner path, one cure',
      (await page.textContent('.wk-team .tname')).trim() === 'Aluminium'
      && teamTries.length === 2 && teamTries[0].carried === 'OLD' && teamTries[1].carried === 'NEW'
      && (await rows('pz_team_event')).filter(t => t.act === 'created').length === 1, teamTries);
    const tid = await page.$eval('.wk-team', e => e.dataset.team);
    await page.selectOption('#wkM' + tid, ID.Arjun);
    await page.click('.wk-team .wk-add >> nth=0 >> button');
    await page.waitForFunction(() => /1 members/.test(document.querySelector('.wk-team .st').textContent), null, { timeout: 8000 });
    check('O10 adding a member still works', (await page.textContent('.wk-team .st')).includes('1 members'));

    // ---- Personal Tasks still work -----------------------------------------
    await page.selectOption('#wkEmp', ID.Arjun);
    await page.fill('#wkInstr', 'Count the aluminium sections');
    await page.click('#wkAssignBtn');
    await page.waitForFunction(() => document.querySelectorAll('#wkTasks .wk-task').length > 0, null, { timeout: 8000 });
    check('O11 Personal Tasks are unaffected: a task can still be assigned',
      (await page.textContent('#wkTasks')).includes('Count the aluminium sections'));

    // ---- attendance still goes out through the server's own door ------------
    await page.evaluate(t => { window.__SP_NET__.session.access_token = t; }, OLD);
    await page.click('.tab[data-tab="attendance"]'); await page.waitForSelector('#page-attendance.active');
    await page.fill('#attendanceDate', DAY); await page.waitForTimeout(400);
    await page.click('.roster-row[data-emp] >> nth=0 >> .status-btn.Present');
    await page.waitForFunction(() => /saved for/.test(document.getElementById('toast').textContent), null, { timeout: 10000 });
    const att = await rows('staff_attendance'), attTries = authLog.filter(a => a.path === '/api/work/owner/attendance');
    check('O12 attendance still reads and writes through Project Zero, renewing the same way',
      att.length === 1 && att[0].device === 'pz-server' && att[0].day_key === DAY
      && attTries.length === 2 && attTries[1].carried === 'NEW'
      && (await rows('pz_attendance_act')).length === 1, [att.length, attTries]);
    check('O13 one attendance row despite the retry — a mark is never doubled', att.length === 1);

    // ---- Today at Work -------------------------------------------------------
    await page.click('.tab[data-tab="add"]');
    await page.waitForFunction(() => document.getElementById('todayAtWork') && document.getElementById('todayAtWork').style.display === 'block', null, { timeout: 10000 });
    check('O14 Today at Work still appears and lists the team', (await page.textContent('#todayAtWork')).includes('Aluminium'));
    await shot(page, 'sp-session-03-today');

    // ---- and when the sign-in genuinely cannot be renewed ---------------------
    refreshBroken = true;
    await page.evaluate(t => { window.__SP_NET__.session.access_token = t; }, OLD);
    const beforeDead = refreshes;
    await page.click('.menu-btn'); await page.click('.more-item[data-tab="work"]');
    await page.waitForSelector('#page-work.active');
    await page.waitForSelector('#cbForm', { state: 'visible', timeout: 10000 });
    const msg = (await page.textContent('#cbStatus')).trim();
    check('O15 when renewal genuinely fails, the ordinary sign-in screen returns with a plain reason',
      /expired/i.test(msg) && !/[Ss]ign out/.test(msg) && await vis(page, '#cloudBoot'), msg);
    check('O16 the dead session is cleared, so nothing stale is sent again',
      (await page.evaluate(() => localStorage.getItem('sp_cloud_session'))) === null);
    const shown = await page.evaluate(() => document.getElementById('cloudBoot').getBoundingClientRect().height);
    check('O17 no owner data is left on screen behind the sign-in', shown >= 800);
    check('O18 even a dead session never loops: at most one renewal attempt', refreshes - beforeDead <= 1, refreshes - beforeDead);
    await shot(page, 'sp-session-04-signin');

    // ---- the shape of the cure, locked in -------------------------------------
    const app = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
    check('O19 every owner request goes through the one renewing wrapper (no raw call can slip past)',
      (app.match(/fetch\(PZ \+/g) || []).length === 1 && !/Sign out and sign in again/.test(app)
      && (app.match(/\/api\/work\/owner\//g) || []).length === (app.match(/(?:api|post|raw|SPWork\.post)\('\/api\/work\/owner\//g) || []).length,
      (app.match(/fetch\(PZ \+/g) || []).length);
    check('O20 nothing in this test printed a token', !PASS.concat(FAIL).join(' ').includes(NEW) && !PASS.concat(FAIL).join(' ').includes(OLD));
    check('O21 no page error anywhere', page.errors.length === 0, page.errors);
  } finally { await browser.close(); srv.close(); pz.kill(); }
  console.log('\n%d passed, %d failed — StaffPay owner session renewal verified.', PASS.length, FAIL.length);
  process.exit(FAIL.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
