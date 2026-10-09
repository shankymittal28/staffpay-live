// Targeted D3 regressions: rejected terms are atomic, and payment reports
// resolve worker references only within the signed-in owner's records.
// Run after test_d3/env.sh up; all data lives in the disposable database.
const L = require('./lib.js');
const T = L.token(L.OWNER), T2 = L.token(L.OTHER);
const terms = staff => L.sqlJson(`select json_build_object('amount', opening_balance,
  'date', opening_balance_date, 'rate', salary, 'version', terms_version)
  from staff_employee where id = '${staff}'`);
const opCount = id => L.sql(`select count(*) from staff_d3_op where op_id = '${id}'`);

(async () => {
  L.reset(); L.setToday('2026-10-11');
  const staff = L.emp({ name: 'Terms', rate: 500, ob: 100, obDate: '2026-10-04' });
  const before = terms(staff);
  const badRate = { op_id: L.uuid(), staff_id: staff, expected_terms_version: 0,
    set: { opening_balance: 2000, opening_balance_date: '2026-10-08', salary: -1 } };
  let r = await L.rpc(T, 'staff_workshop_terms_set', badRate);
  L.check('CDB1 invalid combined terms request changes no Old Hisab, rate, version or log',
    !r.ok && r.error === 'bad rate' && JSON.stringify(terms(staff)) === JSON.stringify(before)
    && opCount(badRate.op_id) === '0', { r, before, after: terms(staff) });

  const unpriced = { ...badRate, op_id: L.uuid(), set: { ...badRate.set, salary: 600 } };
  r = await L.rpc(T, 'staff_workshop_terms_set', unpriced);
  L.check('CDB2 combined request with unpriced days is wholly refused',
    !r.ok && r.error === 'rate change not allowed yet' && JSON.stringify(terms(staff)) === JSON.stringify(before)
    && opCount(unpriced.op_id) === '0', { r, after: terms(staff) });
  r = await L.rpc(T, 'staff_workshop_terms_set', { ...badRate, preview: true });
  L.check('CDB3 preview validates the complete request and writes nothing',
    !r.ok && r.error === 'bad rate' && JSON.stringify(terms(staff)) === JSON.stringify(before), r);

  // Old Hisab at the end of today has no later work to reprice. Both terms
  // can legitimately change together, as one versioned and logged operation.
  const valid = { ...badRate, op_id: L.uuid(), set: { opening_balance: -200, opening_balance_date: '2026-10-11', salary: 600 } };
  r = await L.rpc(T, 'staff_workshop_terms_set', valid);
  const after = terms(staff);
  L.check('CDB4 valid combined terms commit together with one version increment',
    r.ok && after.amount === -200 && after.date === '2026-10-11' && after.rate === 600
    && after.version === 1 && r.terms_version === 1 && opCount(valid.op_id) === '1', { r, after });
  r = await L.rpc(T, 'staff_workshop_terms_set', valid);
  L.check('CDB5 retry returns the committed result without another terms change',
    r.ok && r.replayed && JSON.stringify(terms(staff)) === JSON.stringify(after) && opCount(valid.op_id) === '1', r);

  L.reset(); L.setToday('2026-10-11');
  const foreign = L.emp({ owner: L.OWNER, name: 'Private worker A', legacy: 'stf_private_a', rate: 800, obDate: '2026-10-04' });
  const own = L.emp({ owner: L.OTHER, name: 'Worker B', legacy: 'stf_worker_b', rate: 500, obDate: '2026-10-04' });
  L.attRange(own, '2026-10-05', 'PPPPPPP');
  // attRange defaults to OWNER; keep the fixture consistently owned by B.
  L.sql(`update staff_attendance set owner_id = '${L.OTHER}' where staff_id = '${own}'`);
  const forged = L.payRow({ id: 'cross-owner-link', staff: foreign, staffLegacy: 'stf_private_a',
    name: 'Unassigned', amount: 1500, date: L.istTs('2026-10-08') });
  const saved = await L.upsert(T2, 'staff_payment', [forged]);
  L.check('CDB6 existing phone upload remains accepted without a queue error', saved.status === 201, saved);
  r = await L.rpc(T2, 'staff_workshop_payments', { from: '2026-10-05', to: '2026-10-11' });
  L.check('CDB7 complete totals expose no foreign worker; foreign link is unresolved',
    r.ok && r.total === 0 && r.count === 0 && r.workers.length === 0 && r.unknown_worker_count === 1
    && !JSON.stringify(r).includes('Private worker A') && !JSON.stringify(r).includes(foreign), r);
  r = await L.rpc(T2, 'staff_workshop_report', { staff_id: own, to: '2026-10-11' });
  L.check('CDB8 unresolved foreign link withholds owner B balance rather than omitting cash',
    r.ok && r.withheld.length > 0, r.withheld);
  const heldDelete = await L.del(T2, 'staff_payment', ['cross-owner-link']);
  L.check('CDB9 ordinary deletion cannot erase an unresolved hisab payment',
    heldDelete.status < 300 && L.sql("select count(*) from staff_payment where legacy_id = 'cross-owner-link'") === '1', heldDelete.status);
  r = await L.rpc(T2, 'staff_payment_correct', { op_id: L.uuid(), payment_id: 'cross-owner-link',
    action: 'assign', expected: { amount: 1500, day: '2026-10-08', staff_id: null },
    new: { staff_id: own }, reason: 'Owner assigns this advance to Worker B' });
  L.check('CDB10 owner explicitly assigns the unresolved payment to their own worker', r.ok && r.staff_id === own, r);
  r = await L.rpc(T2, 'staff_workshop_payments', { from: '2026-10-05', to: '2026-10-11' });
  L.check('CDB11 assigned cash counted once: total 1500, count 1, only Worker B',
    r.ok && r.total === 1500 && r.count === 1 && r.unknown_worker_count === 0
    && r.workers.length === 1 && r.workers[0].staff_id === own, r);
  r = await L.rpc(T2, 'staff_workshop_report', { staff_id: own, to: '2026-10-11' });
  L.check('CDB12 assigned report: 7 days at 500 less 1500 gives balance 2000',
    r.ok && !r.withheld.length && r.balance === 2000 && r.paid_total === 1500, r);
  r = await L.rpc(T, 'staff_workshop_payments', { from: '2026-10-05', to: '2026-10-11' });
  L.check('CDB13 owner A totals never count B cash', r.ok && r.total === 0 && r.count === 0, r);

  console.log('\n' + L.PASS.length + ' passed, ' + L.FAIL.length + ' failed - targeted D3 database regressions');
  process.exitCode = L.FAIL.length ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 1; });
