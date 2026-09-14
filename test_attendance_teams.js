/*
 * StaffPay — Today at Work, Teams, and the server-owned attendance writer,
 * at 390×844.
 *
 * The REAL index.html is served locally. Supabase is replaced by a stub that
 * PROXIES the stand-in database of the real Project Zero server
 * (../project-zero/serve_fake.py on port 8801), so what the app reads is
 * exactly what the server wrote — and any attempt by the browser to write
 * attendance directly is recorded and failed, the way production will refuse
 * it after the permission cutover.
 *
 *   node test_attendance_teams.js      (PZ_DIR=../project-zero by default)
 *   SHOT_DIR=/some/dir saves phone screenshots for a visual check.
 *   NODE_PATH=$(npm root -g) if playwright is installed globally.
 */
const fs = require('fs'), http = require('http'), path = require('path'), { spawn } = require('child_process');
const { chromium } = require('playwright');

const PORT = 8793, PZPORT = 8801, PZ = 'http://127.0.0.1:' + PZPORT, DIR = __dirname;
const PZ_DIR = process.env.PZ_DIR || path.join(DIR, '..', 'project-zero');
const SB = 'https://bsjrihrekfsxmajdsyhc.supabase.co', OWNER = 'owner.test.token';
const DAY = '2026-09-03';          // the stand-in server's own business day
const PASS = [], FAIL = [];
function check(name, cond, detail) { (cond ? PASS : FAIL).push(name); console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  -- ' + String(detail === undefined ? '' : (typeof detail === 'string' ? detail : JSON.stringify(detail))).slice(0, 500))); }
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

(async () => {
  const pz = spawn('python3', ['serve_fake.py', String(PZPORT)], { cwd: PZ_DIR, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(res => pz.stdout.on('data', d => { if (String(d).includes('serve_fake on')) res(); }));
  const srv = http.createServer((q, r) => { const f = path.join(DIR, q.url.split('?')[0] === '/' ? 'index.html' : q.url.split('?')[0]); fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'Content-Type': f.endsWith('.html') ? 'text/html' : f.endsWith('.js') ? 'application/javascript' : 'application/octet-stream' }); r.end(d); }); });
  await new Promise(res => srv.listen(PORT, '127.0.0.1', res));
  const browser = await chromium.launch({ executablePath: process.env.CHROME || fs.readdirSync('/opt/pw-browsers').filter(d => /^chromium-\d+$/.test(d)).map(d => '/opt/pw-browsers/' + d + '/chrome-linux/chrome').find(fs.existsSync) });
  try {
    await req('GET', '/__reset');
    // two active people who really do share a display name, at the same rate
    const K1 = (await req('GET', '/__employee?name=Kamal&group=shop&salary=375')).json.id;
    const K2 = (await req('GET', '/__employee?name=Kamal&group=shop&salary=375')).json.id;
    const emps = (await req('GET', '/api/work/owner/employees', OWNER)).json.employees;
    const ID = {}; emps.forEach(e => { if (!ID[e.name]) ID[e.name] = e.id; });

    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, serviceWorkers: 'block' });
    await ctx.addInitScript(([pzUrl, tok]) => {
      localStorage.setItem('sp_cloud_session', JSON.stringify({ access_token: tok, refresh_token: 'r', user: { id: 'x' } }));
      localStorage.setItem('sp_pz_url', pzUrl); localStorage.setItem('staffpay_schema_version', '2');
    }, [PZ, OWNER]);
    const page = await ctx.newPage(); page.errors = []; page.on('pageerror', e => page.errors.push(String(e)));
    page.on('dialog', d => d.accept());

    // Supabase stub: reads proxy the server's stand-in tables; writes are recorded
    const sbWrites = [];
    await page.route(SB + '/**', async route => {
      const rq = route.request(), u = new URL(rq.url()), m = rq.method();
      if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' } });
      if (u.pathname.startsWith('/auth/v1/token')) return json(route, { access_token: OWNER, refresh_token: 'r', user: { id: 'x' } });
      const table = u.pathname.replace('/rest/v1/', '');
      if (m !== 'GET') { sbWrites.push(m + ' ' + table); return json(route, [], 403); }
      if (table === 'staff_employee') return json(route, await rows('staff_employee'));
      if (table === 'staff_attendance') return json(route, (await rows('staff_attendance')).map(a => ({
        id: String(a.id), legacy_id: a.legacy_id, staff_id: a.staff_id, name: a.name, status: a.status,
        note: a.note || '', date: a.date, month_key: a.month_key, day_key: a.day_key })));
      return json(route, []);
    });
    await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'networkidle' });
    await page.waitForSelector('.menu-btn', { timeout: 15000 });

    // ---- Today at Work is absent until a team exists ---------------------
    check('A1 Today at Work stays hidden while no team exists', !(await vis(page, '#todayAtWork')));

    // ---- Teams, by uuid --------------------------------------------------
    await page.click('.menu-btn'); await page.click('.more-item[data-tab="work"]');
    await page.waitForSelector('#page-work.active');
    await page.waitForFunction(() => document.querySelector('#wkTeams') && !/Loading/.test(document.querySelector('#wkTeams').textContent), null, { timeout: 8000 });
    check('A2 the Teams area starts empty and invites the first team', (await page.textContent('#wkTeams')).includes('No team yet'));
    await page.fill('#wkNewTeam', 'Workshop'); await page.click('text=Create team');
    await page.waitForSelector('.wk-team', { timeout: 6000 });
    check('A3 Shanky creates a team without a code change', (await page.textContent('.wk-team .tname')).trim() === 'Workshop');
    const tid = await page.$eval('.wk-team', e => e.dataset.team);
    const opts = await page.$$eval('#wkM' + tid + ' option', els => els.map(e => ({ v: e.value, t: e.textContent })));
    check('A4 members are chosen by uuid, never by name', opts.every(o => /^[0-9a-f-]{36}$/.test(o.v)), opts.slice(0, 2));
    check('A5 the two people who share a name are distinguished by a stable short code',
      opts.filter(o => o.t.startsWith('Kamal')).length === 2
      && opts.filter(o => o.t.startsWith('Kamal')).every(o => o.t.includes(' · ') && o.t.includes(o.v.slice(0, 8))),
      opts.filter(o => o.t.startsWith('Kamal')));
    for (const who of [ID.Arjun, ID.Vishal, K2]) {
      await page.selectOption('#wkM' + tid, who);
      await page.click('.wk-team .wk-add >> nth=0 >> button');
      await page.waitForTimeout(350);
    }
    await page.selectOption('#wkH' + tid, ID.Vishal);
    await page.click('.wk-team .wk-add >> nth=1 >> button');
    await page.waitForFunction(() => /1 heads/.test(document.querySelector('.wk-team .st').textContent), null, { timeout: 6000 });
    check('A6 members and one head are recorded', (await page.textContent('.wk-team .st')).includes('3 members · 1 heads'));
    const mem = (await rows('pz_team_member_event')).filter(r => r.act === 'added');
    check('A7 every membership act carries the employee uuid and the owner as actor',
      mem.length === 4 && mem.every(r => /^[0-9a-f-]{36}$/.test(String(r.employee_id)) && r.actor_kind === 'owner'), mem.length);
    await shot(page, 'sp-teams-01');

    // ---- Today at Work ---------------------------------------------------
    const headTok = await (async () => {
      const c = (await req('POST', '/api/work/owner/access/issue', OWNER, { employee_id: ID.Vishal })).json.code;
      return (await req('POST', '/api/work/activate', null, { code: c })).json.token;
    })();
    await req('POST', '/api/work/team/presence', headTok, { team_id: Number(tid), kind: 'arrived', events: [{ employee_id: ID.Arjun, client_id: 'cid-aaaa0001' }] });
    await req('POST', '/api/work/team/presence', headTok, { team_id: Number(tid), kind: 'lunch_started', events: [{ employee_id: ID.Vishal, client_id: 'cid-aaaa0002' }] });
    await page.click('.tab[data-tab="add"]');
    await page.waitForFunction(() => document.getElementById('todayAtWork') && document.getElementById('todayAtWork').style.display === 'block', null, { timeout: 8000 });
    const server = (await req('GET', '/api/work/owner/today', OWNER)).json.teams[0];
    await page.waitForFunction((w) => /\.taw-counts/ && document.querySelector('.taw-counts')
      && document.querySelector('.taw-counts').textContent.indexOf(w + ' at work') >= 0,
      server.counts.working, { timeout: 8000 });
    const counts = await page.textContent('.taw-counts');
    check('A8 Today at Work shows the same counts the server holds',
      counts.includes(server.counts.working + ' at work') && counts.includes(server.counts.not_marked + ' not marked')
      && counts.includes(server.counts.at_lunch + ' at lunch') && counts.includes(server.counts.left + ' left'), [counts, server.counts]);
    await page.click('.taw-team'); await page.waitForSelector('.taw-person', { timeout: 6000 });
    check('A9 tapping the team shows names, states, times and who recorded them',
      (await page.textContent('#tawDetail')).includes('Arjun') && (await page.textContent('#tawDetail')).includes('Vishal'));
    await shot(page, 'sp-teams-02-today');

    // ---- the attendance screen, now server-written ------------------------
    await page.click('.tab[data-tab="attendance"]'); await page.waitForSelector('#page-attendance.active');
    await page.fill('#attendanceDate', DAY);          // the stand-in server's business day
    await page.waitForTimeout(400);
    const roster = await page.$$eval('#attendanceRoster .roster-row', els => els.map(e => e.querySelector('.roster-name').textContent.trim()));
    check('A10 the roster keeps its familiar shape and lists one row per EMPLOYEE',
      roster.length === (await page.$$eval('#attendanceRoster .roster-row', e => e.length))
      && roster.filter(n => n.startsWith('Kamal')).length === 2, roster);
    check('A11 the duplicated name is distinguishable on the roster too',
      roster.filter(n => n.startsWith('Kamal · ')).length === 2, roster.filter(n => n.startsWith('Kamal')));
    const pzCalls = [];
    page.on('request', r => { if (r.url().includes('/api/work/owner/attendance')) pzCalls.push({ body: r.postData() }); });
    await page.click('.roster-row[data-emp] >> nth=0 >> .status-btn.Present');
    await page.waitForFunction(() => /saved for/.test(document.getElementById('toast').textContent), null, { timeout: 8000 });
    const att = await rows('staff_attendance');
    check('A12 a first mark is written by Project Zero, not by the browser',
      att.length === 1 && att[0].device === 'pz-server' && att[0].day_key === DAY && pzCalls.length === 1, att);
    check('A13 the browser never wrote attendance to Supabase itself', sbWrites.length === 0, sbWrites);
    const acts = await rows('pz_attendance_act');
    check('A14 an audit act landed with it, naming Shanky as the actor',
      acts.length === 1 && acts[0].actor_kind === 'owner' && acts[0].prev_status === null, acts);
    await page.waitForTimeout(300);
    check('A15 the roster shows the saved status after the refresh',
      (await page.$eval('.roster-row[data-emp] >> nth=0 >> .att-status', e => e.textContent.trim())) === 'Present');

    // a change needs a reason
    await page.click('.roster-row[data-emp] >> nth=0 >> .status-btn.Absent');
    await page.waitForSelector('#reasonModal.show', { timeout: 8000 });
    check('A16 changing an existing mark asks why, naming both statuses',
      (await page.textContent('#reasonName')).includes('Present → Absent'));
    await page.fill('#reasonIn', 'left after lunch'); await page.click('#reasonGo');
    await page.waitForFunction(() => /saved for/.test(document.getElementById('toast').textContent), null, { timeout: 8000 });
    const att2 = await rows('staff_attendance'), acts2 = await rows('pz_attendance_act');
    check('A17 the change replaces the row and keeps the whole story',
      att2.length === 1 && att2[0].status === 'Absent' && acts2.length === 2
      && acts2[1].prev_status === 'Present' && acts2[1].reason === 'left after lunch', [att2.length, acts2.length]);
    await shot(page, 'sp-teams-03-attendance');

    // ---- a lost reply ----------------------------------------------------
    let dropped = 0;
    await page.route(PZ + '/api/work/owner/attendance', route => {
      if (dropped === 0) { dropped = 1; return route.abort(); }
      return route.continue();
    });
    await page.click('.roster-row[data-emp] >> nth=1 >> .status-btn.Present');
    await page.waitForFunction(() => /NOT saved/.test(document.getElementById('toast').textContent), null, { timeout: 8000 });
    check('A18 a lost reply says NOT saved — it never claims success', true);
    check('A19 ... and nothing was written', (await rows('staff_attendance')).length === 1);
    const before = pzCalls.length;
    await page.click('.roster-row[data-emp] >> nth=1 >> .status-btn.Present');
    await page.waitForFunction(() => /saved for/.test(document.getElementById('toast').textContent), null, { timeout: 8000 });
    const bodies = pzCalls.slice(before - 1).map(c => JSON.parse(c.body));
    check('A20 the retry repeats the SAME client event id, so one row exists',
      bodies.length >= 2 && bodies[0].client_id === bodies[1].client_id
      && (await rows('staff_attendance')).length === 2, bodies.map(b => b.client_id));

    // ---- a stale device cannot resurrect a replaced row -------------------
    const stale = await page.evaluate(() => {
      const raw = window.__SP_BACKEND__.getRaw('staffpay_attendance_v1');
      const arr = JSON.parse(raw);
      arr.forEach(a => { a.status = 'Present'; });                  // an old copy of the day
      window.__SP_BACKEND__.setRaw('staffpay_attendance_v1', JSON.stringify(arr));
      return arr.length;
    });
    await page.waitForTimeout(600);
    const att3 = await rows('staff_attendance');
    check('A21 a stale device writing its old attendance blob changes nothing on the server',
      stale >= 1 && sbWrites.length === 0 && att3.length === 2 && att3.filter(a => a.status === 'Absent').length === 1,
      [sbWrites, att3.map(a => a.status)]);

    // ---- payroll -----------------------------------------------------------
    await page.evaluate(() => window.__SP_STORE__.pull().then(() => renderAll()));
    await page.waitForTimeout(500);
    await page.click('.menu-btn'); await page.click('.more-item[data-tab="payroll"]');
    await page.waitForSelector('#page-payroll.active');
    const pay = await page.$$eval('.payroll-row', els => els.map(e => ({
      name: e.querySelector('.payroll-name').textContent.trim(),
      pha: e.querySelector('.payroll-num').textContent.trim(),
      earned: e.querySelectorAll('.payroll-num')[1].textContent.trim() })));
    const kamals = pay.filter(r => r.name.startsWith('Kamal'));
    check('A22 payroll lists BOTH people who share a name, each with its own code',
      kamals.length === 2 && kamals.every(r => r.name.includes(' · ')), kamals);
    const marked = att3.map(a => a.staff_id);
    const kamalMarked = kamals.filter(r => r.pha !== '0/0/0');
    check('A23 only the twin who was actually marked carries days — the other is not paid twice',
      kamalMarked.length === (marked.includes(K1) || marked.includes(K2) ? 1 : 0), kamals);
    // Arjun ended the run Absent (marked Present, then changed with a reason);
    // one Kamal was marked Present; the other Kamal was never marked at all.
    const arjun = pay.filter(r => r.name === 'Arjun')[0];
    const paidKamal = kamals.filter(r => r.pha === '1/0/0')[0];
    const unpaidKamal = kamals.filter(r => r.pha === '0/0/0')[0];
    check('A24 the monthly formula is unchanged: Absent earns nothing, Present earns the day rate',
      arjun && arjun.pha === '0/0/1' && arjun.earned === '₹0'
      && paidKamal && paidKamal.earned === '₹375'
      && unpaidKamal && unpaidKamal.earned === '₹0', [arjun, kamals]);
    await shot(page, 'sp-teams-04-payroll');

    // ---- weekly hisab ------------------------------------------------------
    await page.click('.menu-btn'); await page.click('.more-item[data-tab="hisab"]');
    await page.waitForSelector('#page-hisab.active'); await page.waitForTimeout(300);
    const hisabNames = await page.$$eval('.hisab-row .hisab-name', els => els.map(e => e.textContent.trim()));
    check('A25 weekly hisab lists the Workshop people only, by employee', hisabNames.join(',').includes('Vishal'), hisabNames);
    check('A26 no page error anywhere', page.errors.length === 0, page.errors);
  } finally { await browser.close(); srv.close(); pz.kill(); }
  console.log('\n%d passed, %d failed — StaffPay attendance + teams verified.', PASS.length, FAIL.length);
  process.exit(FAIL.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
