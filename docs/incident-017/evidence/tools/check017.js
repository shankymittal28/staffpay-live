'use strict';
/* check017 - Gate A1 independent checker. Re-derives expectations DIRECTLY from
 * backup.json (never from the generator's intermediate state) and diffs the
 * manifest. Separate code path from recover017 by design. */
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const EVID = path.join(__dirname, '..');
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');

let pass = true;
const chk = (n, c, x) => { if (!c) pass = false; console.log((c ? 'PASS  ' : 'FAIL  ') + n + (x !== undefined ? '  [' + x + ']' : '')); };

const raw = fs.readFileSync(path.join(EVID, 'backup.json'));
chk('backup hash matches recorded value', sha256(raw) === 'dedefc44848daed266db6de09cad9fa57fcb3254a58a80fc08afd2513045b3aa');
const backup = JSON.parse(raw.toString('utf8'));
const profiles = JSON.parse(backup.keys['sp_cloud_cache:staffpay_profiles_v1']);
const master = JSON.parse(backup.keys['sp_cloud_cache:staffpay_staff_master_v1']);
const outbox = JSON.parse(backup.keys['sp_cloud_outbox']);

const manifestText = fs.readFileSync(path.join(EVID, 'manifest.json'), 'utf8');
const manifest = JSON.parse(manifestText);
const fileHash = fs.readFileSync(path.join(EVID, 'manifest.sha256'), 'utf8').trim();

/* hash recomputation: canonical form without generated_at */
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v).sort()) o[k] = sortKeys(v[k]); return o; }
  return v;
}
const core = JSON.parse(manifestText); delete core.generated_at;
chk('manifest.sha256 matches recomputed MANIFEST_HASH', sha256(JSON.stringify(sortKeys(core), null, 2) + '\n') === fileHash, fileHash.slice(0, 12) + '…');

/* roster: every backup name exactly once, fields equal profile-for-profile */
chk('staff count 28 in backup master', master.length === 28, master.length);
chk('staff count 28 in manifest', manifest.staff.length === 28, manifest.staff.length);
const byName = {}; manifest.staff.forEach(r => { byName[r.name] = (byName[r.name] || []).concat([r]); });
chk('every master name appears exactly once', master.every(n => byName[n] && byName[n].length === 1));
let fieldDiffs = [];
for (const n of master) {
  const p = profiles[n], r = (byName[n] || [])[0];
  if (!r) { fieldDiffs.push(n + ': missing'); continue; }
  if (r.salary !== (Number(p.salary) || 0)) fieldDiffs.push(n + ': salary ' + r.salary + '!=' + p.salary);
  if (r.wage_type !== (p.wageType === 'daily' ? 'daily' : 'monthly')) fieldDiffs.push(n + ': wage_type');
  if (r.work_group !== (p.group === 'workshop' ? 'workshop' : 'shop')) fieldDiffs.push(n + ': work_group');
  if (r.phone !== (p.phone || '')) fieldDiffs.push(n + ': phone');
  if (r.active !== (p.active !== false)) fieldDiffs.push(n + ': active');
  if (r.opening_balance !== Math.round(Number(p.openingBalance) || 0)) fieldDiffs.push(n + ': opening_balance');
  if (r.removed !== false) fieldDiffs.push(n + ': removed');
  if (r.source !== 'staff') fieldDiffs.push(n + ': source');
}
chk('zero field differences vs backup profiles', fieldDiffs.length === 0, fieldDiffs.join('; ') || 'none');

/* identifiers unique; no owner_id anywhere; integers only */
const ids = manifest.staff.map(r => r.legacy_id);
chk('28 unique staff identifiers', new Set(ids).size === 28);
chk('no owner_id key anywhere in manifest', !manifestText.includes('"owner_id"'));
chk('all salaries integers', manifest.staff.every(r => Number.isInteger(r.salary)));

/* attendance: byte-field equality with the queue ops */
chk('attendance count 10 in queue', outbox.length === 10, outbox.length);
chk('attendance count 10 in manifest', manifest.attendance.length === 10, manifest.attendance.length);
const qById = {}; outbox.forEach(o => { qById[String(o.row.legacy_id)] = o.row; });
let attDiffs = [];
for (const r of manifest.attendance) {
  const q = qById[r.legacy_id];
  if (!q) { attDiffs.push(r.legacy_id + ': not in queue'); continue; }
  for (const f of ['name', 'status', 'note', 'date', 'month_key', 'day_key', 'device'])
    if (r[f] !== q[f]) attDiffs.push(r.legacy_id + ': ' + f);
  if (r.staff_id !== null) attDiffs.push(r.legacy_id + ': staff_id not null');
}
chk('attendance rows field-equal to queued ops, staff_id null', attDiffs.length === 0, attDiffs.join('; ') || 'none');

/* expectations block */
chk('expected counts 28/10/0/0', manifest.expected.staff_count === 28 && manifest.expected.attendance_count === 10 && manifest.expected.payment_count === 0 && manifest.expected.settlement_count === 0);
chk('row-set hashes verify', sha256(JSON.stringify(sortKeys(manifest.staff), null, 2) + '\n') === manifest.hashes.staff && sha256(JSON.stringify(sortKeys(manifest.attendance), null, 2) + '\n') === manifest.hashes.attendance);
chk('provenance names the vault row and backup hash', manifest.source.vault_row_id === 'b62e47f3-dda9-440a-93ce-77d829ad89ec' && manifest.source.backup_hash === 'dedefc44848daed266db6de09cad9fa57fcb3254a58a80fc08afd2513045b3aa');

/* rollback list agrees with manifest, hash-linked */
const rb = fs.readFileSync(path.join(EVID, 'rollback-list.txt'), 'utf8');
chk('rollback list carries MANIFEST_HASH', rb.includes(fileHash));
const rbLines = rb.split('\n').filter(l => l && !l.startsWith('#'));
chk('rollback list enumerates all 38 ids', rbLines.length === 38 &&
  manifest.staff.every(r => rb.includes('staff_employee\t' + r.legacy_id)) &&
  manifest.attendance.every(r => rb.includes('staff_attendance\t' + r.legacy_id)));

console.log(pass ? '==> GATE A1: ALL CHECKS PASS' : '==> GATE A1: FAILURES PRESENT');
process.exit(pass ? 0 : 1);
