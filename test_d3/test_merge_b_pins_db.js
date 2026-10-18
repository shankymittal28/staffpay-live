/*
 * B correction 2 - the repair runs only on exactly the reviewed records
 * (faithful production copy).
 *
 *   test_d3/env.sh up && node test_d3/test_merge_b_pins_db.js
 *
 * Each change below keeps every row count the same (or touches the retained
 * record, which the first candidate did not check), yet must stop the whole
 * repair: neither pair merged, no archive or audit rows. The race checks run
 * a change in a second session at the same time as the repair: it must either
 * be seen by the repair's checks or wait until the merge is committed.
 */
const { spawn } = require('child_process');
const L = require('./lib.js'), { check, sql, OWNER } = L;
const { load, repair } = require('./fixture_b.js');
const K = '206dc20f-8a3b-4aa8-a237-233f735a87ec', KR = 'a5481eba-7c58-45b5-8826-b9f6d79ffa21';
const R = '095233df-7bcb-4ef8-9b87-3afd74e5335e', RR = 'f5c05b72-78ce-48cf-a8ea-85c65de63777';
const fp = () => sql(`select md5(coalesce((select string_agg(x::text, '|' order by x.id) from public.staff_attendance x), '')) || ':' ||
  md5(coalesce((select string_agg((x.id, x.name, x.active, x.salary, x.wage_type, x.merged_into)::text, '|' order by x.id) from public.staff_employee x), '')) || ':' ||
  md5(coalesce((select string_agg(x::text, '|' order by x.legacy_id) from public.staff_payment x), ''))`);
const untouched = () => sql(`select (select count(*) from staff_employee where merged_into is not null) || '/' ||
  (select count(*) from staffpay_d3.staff_attendance_archive) || '/' || (select count(*) from staffpay_d3.staff_identity_merge)`) === '0/0/0';
const pay = (staff, legacy, amt) => `insert into staff_payment (owner_id, legacy_id, staff_id, staff_legacy_id, name, amount, note, date, month_key, device)
  values ('${OWNER}', '${legacy}', '${staff}', null, 'x', ${amt}, '', now(), '2026-10', 'test')`;

const grant = id => `insert into pz_supplier_access (employee_id, granted, actor_id, actor_name) values ('${id}', true, '${OWNER}', 'Owner')`;

const INJECT = [
  ['a new ₹100 payment on retained Kamal', pay(K, 'pay_k100', 100)],
  ['a ₹50 receipt on retained Raju', pay(R, 'rcv_r50', -50)],
  ['both Kamal salaries ₹375 → ₹400', `update staff_employee set salary = 400 where id in ('${K}', '${KR}')`],
  ['both Raju copies switched to monthly pay', `update staff_employee set wage_type = 'monthly' where id in ('${R}', '${RR}')`],
  ['retained Kamal\'s 1 Sep mark Present → Absent (same row count)', `update staff_attendance set status = 'Absent' where staff_id = '${K}' and day_key = '2026-09-01'`],
  ['the same 20 Sep change on both Raju copies (still equal, same counts)', `update staff_attendance set status = 'Absent' where staff_id in ('${R}', '${RR}') and day_key = '2026-09-20'`],
  ['a retained Raju row replaced by a different row on the same day', `update staff_attendance set id = gen_random_uuid() where staff_id = '${R}' and day_key = '2026-09-10'`],
  ['a Staff Work login on retained Kamal', `insert into pz_work_credential (employee_id) values ('${K}')`],
  ['a Supplier access row on retained Raju', grant(R)],
  ['retained Kamal renamed "Kamal Kumar"', `update staff_employee set name = 'Kamal Kumar' where id = '${K}'`],
  ['an identity decision pending on retained Raju', `update staff_employee set identity_status = 'unresolved', identity_of = '${RR}' where id = '${R}'`],
];

// one psql session in the background; resolves with its exit, output and finish time
const session = text => new Promise(res => {
  const c = spawn('psql', ['-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-h', process.env.PGHOST || '/tmp', '-p', process.env.PGPORT || '54329', '-U', 'postgres', '-d', process.env.D3_DB || 'd3test']);
  let out = '', err = ''; c.stdout.on('data', d => out += d); c.stderr.on('data', d => err += d);
  c.on('close', code => res({ ok: code === 0, out, err, at: Date.now() }));
  c.stdin.end(text);
});
const REPAIR = require('fs').readFileSync(require('path').join(__dirname, '..', 'sql', 'repair_b_kamal_raju.sql'), 'utf8');
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  for (const [label, s] of INJECT) {
    load(); sql(s); const b = fp();
    const r = repair();
    check('P ' + label + ': the whole repair stops, neither pair changed, no archive or audit rows',
      !r.ok && /merge refused/.test(r.err) && fp() === b && untouched(), (r.ok ? 'REPAIR RAN: ' + r.out : r.err).slice(0, 220));
  }
  // ---- races: a change in flight while the repair starts
  load();
  let [w, rp] = await Promise.all([
    session(`begin; ${pay(K, 'pay_k_race', 100)}; select pg_sleep(1.5); commit;`),
    wait(400).then(() => session(REPAIR))]);
  check('P-race1 a ₹100 payment on retained Kamal still uncommitted when the repair starts: the repair waits for it, sees it and stops (nothing merged)',
    w.ok && !rp.ok && /merge refused/.test(rp.err) && untouched() && sql(`select count(*) from staff_payment where legacy_id = 'pay_k_race'`) === '1', (rp.ok ? 'REPAIR RAN: ' + rp.out : rp.err).slice(0, 220));
  load();
  [rp, w] = await Promise.all([
    session(REPAIR.replace(/\ncommit;/, "\nselect pg_sleep(1.5);\ncommit;")),
    wait(400).then(() => session(`update staff_attendance set status = 'Absent' where staff_id = '${K}' and day_key = '2026-09-01'; select clock_timestamp();`))]);
  check('P-race2 an edit to retained Kamal\'s 1 Sep mark arriving while the repair holds its locks waits until the merge is committed (it cannot slip between check and write)',
    rp.ok && w.ok && w.at >= rp.at && sql(`select count(*) from staffpay_d3.staff_identity_merge`) === '2'
    && sql(`select status from staff_attendance where staff_id = '${K}' and day_key = '2026-09-01'`) === 'Absent', { rp: rp.err, w: w.err, order: w.at - rp.at });

  // ---- Supplier access has no foreign key in production, so locked staff rows do not hold it back
  for (const [who, id] of [['retired', KR], ['retained', K]]) {
    load();
    [w, rp] = await Promise.all([
      session(`begin; ${grant(id)}; select pg_sleep(1.5); commit;`),
      wait(400).then(() => session(REPAIR))]);
    check(`P-race3 a Supplier access grant for ${who} Kamal still uncommitted when the repair starts: the repair waits, sees it and stops; nothing merged, archived or audited`,
      w.ok && !rp.ok && /merge refused/.test(rp.err) && untouched() && sql(`select count(*) from pz_supplier_access where employee_id = '${id}'`) === '1',
      (rp.ok ? 'REPAIR RAN: ' + rp.out : rp.err).slice(0, 220));
    load();
    [rp, w] = await Promise.all([
      session(REPAIR.replace(/\ncommit;/, "\nselect pg_sleep(1.5);\ncommit;")),
      wait(400).then(() => session(`${grant(id)};`))]);
    check(`P-race4 a Supplier access grant for ${who} Kamal arriving after the repair has its locks (paused before COMMIT) waits until the repair transaction finishes`,
      rp.ok && w.ok && w.at >= rp.at && sql(`select count(*) from staffpay_d3.staff_identity_merge`) === '2'
      && sql(`select count(*) from pz_supplier_access where employee_id = '${id}'`) === '1', { rp: rp.err, w: w.err, order: w.at - rp.at });
  }

  // ---- lock order: the real writers' shapes, in flight before and arriving during the repair; none may deadlock
  {
    const u = load();
    const door = (emp, day, reason) => `select pz_attendance_assert('${OWNER}', '${emp}', '${day}', 'Present', 'owner', 'x', 'Owner', ${reason ? `'${reason}'` : 'null'}, gen_random_uuid()::text);`;
    const before = [`begin; ${grant(u.mohan)}; select pg_sleep(1); commit;`,
                    `begin; ${door(u.mohan, '2026-10-16')} select pg_sleep(1); commit;`,
                    `begin; ${pay(u.mohan, 'pay_m_race', 70)}; select pg_sleep(1); commit;`];
    const during = [`${grant(u.mohan)};`, `${grant(K)};`, door(K, '2026-10-16'), door(K, '2026-09-01', 'checked'), `${pay(K, 'pay_k_after', 80)};`];
    const all = await Promise.all([
      ...before.map(t => session(t)),
      wait(300).then(() => session(REPAIR.replace(/\ncommit;/, "\nselect pg_sleep(1.5);\ncommit;"))),
      ...during.map(t => wait(1500).then(() => session(t)))]);
    const rp = all[before.length], errs = all.map(x => x.err).filter(Boolean);
    check('P-order the repair and Project Zero\'s Supplier, attendance and payment writes (before and during) all finish, with no deadlock; the repair merges both pairs',
      all.every(x => x.ok) && !errs.some(e => /deadlock/.test(e)) && sql(`select count(*) from staffpay_d3.staff_identity_merge`) === '2'
      && sql(`select count(*) from pz_supplier_access`) === '3' && sql(`select count(*) from staff_payment where legacy_id in ('pay_m_race', 'pay_k_after')`) === '2',
      { repair: rp.ok, errs: errs.map(e => e.slice(0, 160)) });
  }

  load();
  let r = repair();
  check('P-ok the unchanged copy still repairs exactly as reviewed (Kamal 16 archived; Raju 15 archived, 1 moved)',
    r.ok && /"archived": 16/.test(r.out) && /"archived": 15/.test(r.out) && /"moved": 1/.test(r.out), r.err);
  const after = fp();
  r = repair();
  check('P-again a second run is harmless (already merged, nothing changed)', r.ok && (r.out.match(/already_merged/g) || []).length === 2 && fp() === after, r.err || r.out);
  console.log(`\n${L.PASS.length} passed, ${L.FAIL.length} failed - B repair pinned to the reviewed records`);
  process.exit(L.FAIL.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
