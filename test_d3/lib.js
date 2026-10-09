// Shared helpers for the D3 tests: Supabase-style tokens, PostgREST calls and
// direct SQL against the disposable database started by env.sh.
const crypto = require('crypto'), { spawnSync } = require('child_process');
const API = process.env.D3_API || 'http://127.0.0.1:3010';
const SECRET = process.env.JWT_SECRET || 'd3-disposable-secret-d3-disposable-secret';
const DB = process.env.D3_DB || 'd3test';
const OWNER = '11111111-1111-4111-8111-111111111111', OTHER = '22222222-2222-4222-8222-222222222222';

const b64 = o => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
function token(sub, role) {
  const h = b64({ alg: 'HS256', typ: 'JWT' }), p = b64({ sub, role: role || 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 });
  return h + '.' + p + '.' + crypto.createHmac('sha256', SECRET).update(h + '.' + p).digest('base64url');
}
async function call(tok, method, path, body, headers) {
  const h = Object.assign({ 'Content-Type': 'application/json' }, headers || {});
  if (tok) h.Authorization = 'Bearer ' + tok;
  const r = await fetch(API + path, { method, headers: h, body: body == null ? undefined : JSON.stringify(body) });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) { j = t; }
  return { status: r.status, json: j, headers: r.headers };
}
const rpc = (tok, fn, p) => call(tok, 'POST', '/rpc/' + fn, { p }).then(r => r.status === 200 ? r.json : { ok: false, http: r.status, error: r.json });
function sql(q) {
  const r = spawnSync('psql', ['-h', process.env.PGHOST || '/tmp', '-p', process.env.PGPORT || '54329', '-U', 'postgres',
    '-d', DB, '-v', 'ON_ERROR_STOP=1', '-q', '-At', '-F', '\t', '-c', q], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('sql failed: ' + r.stderr + '\n' + q.slice(0, 300));
  return r.stdout.trim();
}
const sqlJson = q => { const o = sql(q); return o ? JSON.parse(o) : null; };
function setToday(d) {
  sql(`create or replace function staffpay_d3.today() returns date language sql stable as $$ select '${d}'::date $$`);
}
function reset() {
  sql(`truncate public.staff_d3_op, public.staff_payment_void, public.staff_settlement, public.staff_payment,
       public.staff_attendance, pz_attendance_act, public.staff_employee cascade;
       insert into auth.users values ('${OWNER}'), ('${OTHER}') on conflict do nothing;`);
}
let seq = 0;
function emp(o) {
  const legacy = o.legacy || ('stf_t' + (++seq));
  return sql(`insert into public.staff_employee (owner_id, legacy_id, name, work_group, wage_type, salary, opening_balance, opening_balance_date)
    values ('${o.owner || OWNER}', '${legacy}', '${o.name}', '${o.group || 'workshop'}', '${o.wage || 'daily'}', ${o.rate || 0},
            ${o.ob || 0}, ${o.obDate ? `'${o.obDate}'` : 'null'}) returning id`);
}
const ST = { P: 'Present', H: 'Half-Day', A: 'Absent' };
function att(staff, day, s, owner) {   // the shape Project Zero's attendance door writes
  sql(`insert into public.staff_attendance (owner_id, legacy_id, staff_id, name, status, date, month_key, day_key, device)
       select '${owner || OWNER}', 'pz_' || md5(random()::text), id, name, '${ST[s] || s}',
              ('${day}'::date + time '10:00') at time zone 'Asia/Kolkata', '${day.slice(0, 7)}', '${day}', 'pz-server'
         from public.staff_employee where id = '${staff}'`);
}
function attRange(staff, from, pattern) {   // pattern like 'PPHPAPP', one char per day from `from`
  const d0 = new Date(from + 'T00:00:00Z');
  [...pattern].forEach((c, i) => { if (c !== '-') att(staff, new Date(d0.getTime() + i * 864e5).toISOString().slice(0, 10), c); });
}
// a payment exactly as the app's upload path writes it (row shape of paymentRow)
function payRow(o) {
  return { legacy_id: String(o.id), staff_id: o.staff === undefined ? null : o.staff, staff_legacy_id: o.staffLegacy || null,
           name: o.name || 'x', amount: o.amount, note: o.note || '', date: o.date, month_key: (o.date || '').slice(0, 7), device: 'test' };
}
const istTs = (day, hhmm) => new Date(day + 'T' + (hhmm || '12:00') + ':00+05:30').toISOString();
async function upsert(tok, table, rows) {
  return call(tok, 'POST', '/' + table + '?on_conflict=owner_id,legacy_id', rows, { Prefer: 'resolution=merge-duplicates,return=representation' });
}
async function del(tok, table, ids) {
  return call(tok, 'DELETE', '/' + table + '?legacy_id=in.' + encodeURIComponent('(' + ids.map(x => '"' + x + '"').join(',') + ')'));
}
const PASS = [], FAIL = [];
function check(name, cond, detail) {
  (cond ? PASS : FAIL).push(name);
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  -- ' + String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 600)));
}
const uuid = () => crypto.randomUUID();
module.exports = { API, OWNER, OTHER, token, call, rpc, sql, sqlJson, setToday, reset, emp, att, attRange, payRow, istTs,
                   upsert, del, check, PASS, FAIL, uuid };
