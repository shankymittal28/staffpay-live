// Shared phone harness for the D3 browser tests: a 390x844 Chromium page in
// Asia/Kolkata, serving one app build, with Supabase routed to the disposable
// PostgREST and Project Zero stubbed.
const fs = require('fs'), http = require('http'), path = require('path');
const L = require('./lib.js'), { sql, OWNER } = L;
const SB = 'https://bsjrihrekfsxmajdsyhc.supabase.co', PZ = 'https://pz.test';
const NOW = '2026-10-11T18:00:00+05:30';
const TOK = L.token(OWNER);
let PORT = 8823;
function serve(dir, port) {
  const srv = http.createServer((q, r) => { const f = path.join(dir, q.url.split('?')[0] === '/' ? 'index.html' : q.url.split('?')[0]);
    fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'Content-Type': f.endsWith('.html') ? 'text/html' : 'application/javascript' }); r.end(d); }); });
  return new Promise(res => srv.listen(port, '127.0.0.1', () => res(srv)));
}
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
  await page.goto('http://127.0.0.1:' + (opts.port || PORT) + '/', { waitUntil: 'networkidle' });
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
module.exports = { phone, txt, idle, uploaded, addPayment, openHisab, serve, NOW, TOK };
