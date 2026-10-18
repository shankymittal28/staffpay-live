/*
 * B correction 1 - merged_into is server-controlled (synthetic + fixture data).
 *
 *   test_d3/env.sh up && node test_d3/test_merge_b_guard_db.js
 *
 * Ordinary page writes (REST as the signed-in owner) try to forge or change a
 * merge marker on: a new record, unrelated Mohan, retained Kamal and an
 * already-merged copy. Only the reviewed repair (merge_staff) may set it.
 */
const L = require('./lib.js'), { check, sql, OWNER } = L;
const { load, repair } = require('./fixture_b.js');
const T = L.token(OWNER);
const K = '206dc20f-8a3b-4aa8-a237-233f735a87ec', KR = 'a5481eba-7c58-45b5-8826-b9f6d79ffa21', R = '095233df-7bcb-4ef8-9b87-3afd74e5335e';
const mi = id => sql(`select coalesce(merged_into::text, '-') from staff_employee where id = '${id}'`);
const patch = (id, body) => L.call(T, 'PATCH', '/staff_employee?id=eq.' + id, body, { Prefer: 'return=minimal' });
const row = (legacy, name, extra) => Object.assign({ owner_id: OWNER, legacy_id: legacy, name, work_group: 'shop', phone: '', active: true, salary: 500, wage_type: 'daily', opening_balance: 0, source: 'staff', device: 'page' }, extra || {});

(async () => {
  const u = load();
  const mohan = u.mohan;

  // ---- before the repair
  let r = await patch(mohan, { merged_into: K });
  check('G1 a PATCH setting unrelated Mohan "merged into" retained Kamal is accepted but changes nothing', r.status < 300 && mi(mohan) === '-', { st: r.status, mi: mi(mohan) });
  r = await patch(K, { merged_into: R });
  check('G2 a PATCH marking retained Kamal merged into Raju changes nothing', r.status < 300 && mi(K) === '-');
  r = await L.upsert(T, 'staff_employee', [row('stf_new_forged', 'Suresh', { merged_into: K })]);
  check('G3 a new record uploaded with a merge marker is created without it', r.status < 300 && sql(`select coalesce(merged_into::text, '-') from staff_employee where legacy_id = 'stf_new_forged'`) === '-');
  r = await L.upsert(T, 'staff_employee', [row('stf_mohan', 'Mohan', { merged_into: K })]);
  check('G4 an upsert of Mohan carrying a merge marker keeps him unmerged', r.status < 300 && mi(mohan) === '-');
  await L.upsert(T, 'staff_payment', [{ owner_id: OWNER, legacy_id: 'pay_mohan_after', staff_id: mohan, staff_legacy_id: 'stf_mohan', name: 'Mohan', amount: 150, note: '', date: L.istTs('2026-10-16'), month_key: '2026-10', device: 'page' }]);
  check('G5 Mohan\'s new payment stays on Mohan (no redirect through a forged marker); no redirect audit row',
    sql(`select staff_id from staff_payment where legacy_id = 'pay_mohan_after'`) === mohan && sql('select count(*) from staffpay_d3.staff_merge_redirect') === '0');
  check('G6 nobody disappeared: Mohan, Kamal and Raju are all unmerged, no merge audit rows',
    sql(`select count(*) from staff_employee where merged_into is not null`) === '0' && sql('select count(*) from staffpay_d3.staff_identity_merge') === '0');

  // ---- the legitimate repair still works
  const rp = repair();
  check('G7 the reviewed repair still sets the markers (Kamal and Raju retired copies merged, with audit rows)',
    rp.ok && mi(KR) === K && sql('select count(*) from staffpay_d3.staff_identity_merge') === '2', rp.err);

  // ---- after the repair
  r = await patch(KR, { merged_into: null });
  check('G8 a PATCH clearing the merge marker on the merged Kamal copy changes nothing', r.status < 300 && mi(KR) === K);
  r = await patch(KR, { merged_into: R });
  check('G9 a PATCH re-pointing the merged copy at Raju changes nothing', r.status < 300 && mi(KR) === K);
  r = await patch(mohan, { merged_into: K });
  check('G10 forging Mohan into Kamal after the repair still changes nothing; Mohan stays listed', r.status < 300 && mi(mohan) === '-'
    && sql(`select active::text from staff_employee where id = '${mohan}'`) === 'true');
  r = await patch(mohan, { salary: 520 });
  check('G11 ordinary edits still apply (Mohan rate 520)', r.status < 300 && sql(`select salary::int from staff_employee where id = '${mohan}'`) === '520');

  console.log(`\n${L.PASS.length} passed, ${L.FAIL.length} failed - B merged_into is server-controlled`);
  process.exit(L.FAIL.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
