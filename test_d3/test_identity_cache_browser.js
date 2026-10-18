/*
 * A1 rollout - a phone with live rc17 in its browser cache opens rc18 and
 * must load rc18's sync script (synthetic data, 390x844 phone).
 *
 *   test_d3/env.sh up && RC17_DIR=/var/tmp/rc17wt node test_d3/test_identity_cache_browser.js
 *
 * One address serves rc17 first, then this build, with GitHub Pages' caching
 * (Cache-Control: max-age=600), in ONE browser context. If the sync script
 * URL does not change, the browser reuses rc17's cached staff-cloud.js, which
 * drops the identity flags: two held ₹500 Raju records would then show
 * ₹1,000 payable.
 *
 * Playwright switches the HTTP cache off whenever requests are intercepted,
 * so this test intercepts nothing: the browser resolves the Supabase and
 * Project Zero hosts (no proxy) to a local HTTPS stand-in that forwards to the
 * disposable PostgREST exactly like phone.js does.
 */
const fs = require('fs'), http = require('http'), https = require('https'), path = require('path'), os = require('os'), { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const L = require('./lib.js'), { check, sql, OWNER } = L;
const { txt } = require('./phone.js');
const T = L.token(OWNER), NOW = '2026-10-14T11:00:00+05:30', PORT = 8915, TLS = 8916;
const RC17 = process.env.RC17_DIR || '/var/tmp/rc17wt', RC18 = path.join(__dirname, '..');
const OLD_STAMP = new RegExp(process.env.OLD_STAMP || 'rc17-shopreceipts-20261014');   // the cached build (RC17_DIR may point at rc18)

let dir = RC17; const log = [];
const srv = http.createServer((q, r) => {
  const p = q.url.split('?')[0], f = path.join(dir, p === '/' ? 'index.html' : p);
  log.push({ build: dir === RC17 ? 'rc17' : 'rc18', url: q.url });
  fs.readFile(f, (e, d) => {
    if (e) { r.writeHead(404); return r.end(); }
    r.writeHead(200, { 'Content-Type': f.endsWith('.html') ? 'text/html' : 'application/javascript', 'Cache-Control': 'max-age=600' });
    r.end(d);
  });
});

// the Supabase / Project Zero stand-in (self-signed, test only)
const CERT = fs.mkdtempSync(path.join(os.tmpdir(), 'spcert-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
  '-keyout', path.join(CERT, 'k.pem'), '-out', path.join(CERT, 'c.pem')], { stdio: 'ignore' });
const H = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*', 'Access-Control-Expose-Headers': '*' };
const tls = https.createServer({ key: fs.readFileSync(path.join(CERT, 'k.pem')), cert: fs.readFileSync(path.join(CERT, 'c.pem')) }, (q, r) => {
  const chunks = []; q.on('data', c => chunks.push(c)); q.on('end', async () => {
    if (q.method === 'OPTIONS') { r.writeHead(204, H); return r.end(); }
    if (q.headers.host && /pz\.test/.test(q.headers.host)) { r.writeHead(200, Object.assign({ 'content-type': 'application/json' }, H)); return r.end(JSON.stringify({ ok: true, teams: [], employees: [], tasks: [] })); }
    if (q.url.startsWith('/auth/v1/token')) { r.writeHead(200, Object.assign({ 'content-type': 'application/json' }, H)); return r.end(JSON.stringify({ access_token: T, refresh_token: 'r', user: { id: OWNER } })); }
    const hdr = {}; for (const [k, v] of Object.entries(q.headers)) if (/^(authorization|prefer|content-type|range)$/i.test(k)) hdr[k] = v;
    const resp = await fetch(L.API + q.url.replace('/rest/v1', ''), { method: q.method, headers: hdr, body: ['GET', 'HEAD'].includes(q.method) ? undefined : Buffer.concat(chunks) });
    const body = await resp.text();
    r.writeHead(resp.status, Object.assign({ 'content-type': resp.headers.get('content-type') || 'application/json' }, H)); r.end(body);
  });
});

(async () => {
  await new Promise(res => srv.listen(PORT, '127.0.0.1', res));
  await new Promise(res => tls.listen(TLS, '127.0.0.1', res));
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-proxy-server', '--host-resolver-rules=MAP bsjrihrekfsxmajdsyhc.supabase.co 127.0.0.1:' + TLS + ', MAP pz.test 127.0.0.1:' + TLS] });
  try {
    L.reset(); L.setToday('2026-10-14');
    const r1 = L.emp({ name: 'Raju', group: 'shop', wage: 'daily', rate: 500, legacy: 'stf_raju1' });
    await L.upsert(T, 'staff_employee', [{ owner_id: OWNER, legacy_id: 'stf_raju2', name: 'Raju', work_group: 'shop', phone: '', active: true, salary: 500, wage_type: 'daily', opening_balance: 0, source: 'staff', device: 'old-page' }]);
    const r2 = sql(`select id from staff_employee where legacy_id = 'stf_raju2'`);
    L.att(r1, '2026-10-13', 'P'); L.att(r2, '2026-10-13', 'P');
    check('K0 set-up: two Raju records, R2 unresolved, each with one ₹500 Present day', sql(`select identity_status from staff_employee where id = '${r2}'`) === 'unresolved');

    // ---- 1. live rc17 loads and fills the browser cache (one context, no interception)
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'Asia/Kolkata', serviceWorkers: 'block', ignoreHTTPSErrors: true });
    await ctx.addInitScript(([tok]) => {
      if (!localStorage.getItem('sp_cloud_session')) localStorage.setItem('sp_cloud_session', JSON.stringify({ access_token: tok, refresh_token: 'r', user: { id: 'x' } }));
      localStorage.setItem('sp_pz_url', 'https://pz.test');
    }, [T]);
    const page = await ctx.newPage(); page.errors = [];
    page.on('pageerror', e => page.errors.push(String(e))); page.on('dialog', d => d.accept());
    await page.clock.setSystemTime(new Date(NOW));
    await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.getElementById('cloudBoot').style.display === 'none', null, { timeout: 15000 });
    check('K1 rc17 is served first and its sync script is fetched', OLD_STAMP.test(await page.content())
      && log.some(x => x.build === 'rc17' && /^\/staff-cloud\.js/.test(x.url)));

    // ---- 2. the same address now serves rc18; same browser, warm cache
    dir = RC18; const mark = log.length;
    await page.goto('http://127.0.0.1:' + PORT + '/?b=rc19-merge-20261017');
    await page.waitForFunction(() => window.__SP_BACKEND__ && typeof empList === 'function', null, { timeout: 15000 });
    await page.waitForTimeout(800);
    const after = log.slice(mark).map(x => x.url);
    check('K2 the rc18 page is served', /rc19-merge-20261017/.test(await page.content()));
    check('K3 rc18\'s sync script is fetched from the server (not reused from rc17\'s cache)',
      after.some(u => /^\/staff-cloud\.js\?v=rc19-merge-20261017$/.test(u)), after);
    const reg = await page.evaluate(() => Object.values((loadRegistry() || {}).staff || {}).map(e => e.name + ':' + (e.identityStatus || '-')).sort().join(','));
    check('K4 the phone\'s registry keeps the identity flags', reg === 'Raju:-,Raju:unresolved', reg);
    await page.evaluate(() => { viewMonth = new Date(2026, 9, 1); switchTab('payroll'); renderPayroll(); });
    await page.waitForTimeout(300);
    const b1 = await txt(page, '#shpb_stf_raju1'), b2 = await txt(page, '#shpb_stf_raju2'), tot = await txt(page, '#payrollBalanceTotal');
    check('K5 both Raju records show "On hold"', /On hold/.test(b1) && /On hold/.test(b2), { b1, b2 });
    check('K6 neither ₹500 enters the payable total (₹0, 2 shop on hold)', /^₹0 · 2 shop on hold/.test(tot), tot);
    check('K7 no page errors', page.errors.length === 0, page.errors);
  } catch (e) { check('no exception', false, e.stack); }
  await browser.close(); srv.close(); tls.close();
  console.log(`\n${L.PASS.length} passed, ${L.FAIL.length} failed - rc17 cache -> rc18 sync script`);
  process.exit(L.FAIL.length ? 1 : 0);
})();
