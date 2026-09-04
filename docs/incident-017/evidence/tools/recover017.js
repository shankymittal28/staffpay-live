'use strict';
/* recover017 — Incident 017 one-time recovery tool.
 * Spec: docs/incident-017/01-RECOVERY-TOOL-SPEC.md
 * Pure function: backup.json -> manifest.json + manifest.sha256 + rollback-list.txt
 * Forbidden: network, DB writes, app code, clocks/randomness in output.
 * Any assumption violation ABORTS with no output. */
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const EVID = path.join(__dirname, '..');
const BACKUP_FILE = path.join(EVID, 'backup.json');
const RECORDED_BACKUP_HASH = 'dedefc44848daed266db6de09cad9fa57fcb3254a58a80fc08afd2513045b3aa';
const VAULT_ROW = 'b62e47f3-dda9-440a-93ce-77d829ad89ec';

function abort(step, msg) { console.error('ABORT [' + step + '] ' + msg); process.exit(1); }
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

/* Canonical serialisation (spec 02 s3): sorted keys at every level, 2-space
 * indent, LF, trailing newline. Integers only for numbers. */
function canonical(value) {
  return JSON.stringify(sortKeys(value), null, 2) + '\n';
}
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out;
  }
  if (typeof v === 'number' && !Number.isInteger(v)) abort('serialise', 'non-integer number: ' + v);
  return v;
}

/* Step 1 - source integrity */
const raw = fs.readFileSync(BACKUP_FILE);
if (sha256(raw) !== RECORDED_BACKUP_HASH) abort('step1', 'BACKUP_HASH mismatch');
const payload = JSON.parse(raw.toString('utf8'));
if (payload.kind !== 'device_backup_raw_v1') abort('step1', 'unexpected payload.kind: ' + payload.kind);

/* Step 2 - source extraction (cache slots are authoritative; legacy slots are debris) */
const K = payload.keys || {};
function parseKey(name) {
  if (K[name] == null) abort('step2', 'missing key: ' + name);
  try { return JSON.parse(K[name]); } catch (e) { abort('step2', 'unparseable key: ' + name); }
}
const P = parseKey('sp_cloud_cache:staffpay_profiles_v1');       // name -> profile
const M = parseKey('sp_cloud_cache:staffpay_staff_master_v1');   // roster names
const Q = parseKey('sp_cloud_outbox');                            // queued ops
const A = parseKey('sp_cloud_cache:staffpay_attendance_v1');      // cross-check only

/* Step 3 - roster reconciliation: set(P) == set(M), exactly */
const pNames = Object.keys(P), mNames = M.slice();
const pSet = new Set(pNames), mSet = new Set(mNames);
const onlyP = pNames.filter(n => !mSet.has(n)), onlyM = mNames.filter(n => !pSet.has(n));
if (onlyP.length || onlyM.length)
  abort('step3', 'roster asymmetry; only-in-profiles=' + JSON.stringify(onlyP) + ' only-in-master=' + JSON.stringify(onlyM));
if (mNames.length !== mSet.size) abort('step3', 'duplicate name in master list');

/* Step 4 - staff rows, ordered by canonical id */
function canonicalName(name) {
  return String(name).trim().replace(/\s+/g, ' ').toLowerCase()
    .replace(/ /g, '_').replace(/[^a-z0-9_]/g, '');
}
const seen = new Map();
const staffRows = mNames.map(name => {
  const cid = 'stf_' + canonicalName(name);
  if (!canonicalName(name)) abort('step4', 'empty canonical form for name: ' + JSON.stringify(name));
  if (seen.has(cid)) abort('step4', 'identifier collision: ' + cid + ' (' + seen.get(cid) + ' vs ' + name + ')');
  seen.set(cid, name);
  const p = P[name];
  return {
    legacy_id: cid,
    name: name,                                            // verbatim
    work_group: p.group === 'workshop' ? 'workshop' : 'shop',
    phone: p.phone || '',
    active: p.active !== false,
    salary: Number(p.salary) || 0,
    wage_type: p.wageType === 'daily' ? 'daily' : 'monthly',
    opening_balance: Math.round(Number(p.openingBalance) || 0),
    source: 'staff',
    removed: false,
    device: 'recovery-017'
  };
}).sort((a, b) => a.legacy_id < b.legacy_id ? -1 : 1);

/* Step 5 - attendance rows, verbatim from queue; staff_id stays null */
const attOps = Q.filter(o => o && o.table === 'staff_attendance' && o.op === 'upsert');
if (attOps.length !== Q.length) abort('step5', 'queue contains non-attendance or non-upsert ops');
const attRows = attOps.map(o => {
  const r = o.row;
  if (r.staff_id !== null) abort('step5', 'queued row carries non-null staff_id: ' + r.legacy_id);
  return {
    legacy_id: String(r.legacy_id), staff_id: null, name: r.name, status: r.status,
    note: r.note, date: r.date, month_key: r.month_key, day_key: r.day_key, device: r.device
  };
}).sort((a, b) => a.legacy_id < b.legacy_id ? -1 : 1);
const qIds = new Set(attRows.map(r => r.legacy_id));
const aIds = new Set(A.map(r => String(r.id)));
if (qIds.size !== aIds.size || [...qIds].some(id => !aIds.has(id)))
  abort('step5', 'queue/cache attendance mismatch: queue=' + [...qIds] + ' cache=' + [...aIds]);

/* Step 6 - assembly */
const staffCanon = canonical(staffRows);
const attCanon = canonical(attRows);
const manifestCore = {
  incident: '017',
  purpose: 'Restore the 28 staff and 10 attendance records from the verified phone backup into the empty cloud tables. owner_id is intentionally absent from rows; the database default (auth.uid()) supplies it.',
  source: {
    vault_row_id: VAULT_ROW,
    captured_at: payload.takenAt,
    backup_hash: RECORDED_BACKUP_HASH,
    device: (K['sp_cloud_outbox'] ? 'see backup keys' : ''),
    backup_build: payload.build
  },
  target: { project: 'bsjrihrekfsxmajdsyhc', tables: ['staff_employee', 'staff_attendance'] },
  generator: { name: 'recover017', version: '1.0.0', spec: 'docs/incident-017/01-RECOVERY-TOOL-SPEC.md' },
  hash_rule: 'MANIFEST_HASH = SHA-256 over the canonical serialisation of this object WITHOUT the generated_at field (sorted keys at every level, 2-space indent, LF, trailing newline).',
  staff: staffRows,
  attendance: attRows,
  expected: { staff_count: staffRows.length, attendance_count: attRows.length, payment_count: 0, settlement_count: 0 },
  hashes: { staff: sha256(staffCanon), attendance: sha256(attCanon) }
};
const MANIFEST_HASH = sha256(canonical(manifestCore));
const manifestFile = Object.assign({}, manifestCore, { generated_at: new Date().toISOString() });

/* Step 7 - emission */
fs.writeFileSync(path.join(EVID, 'manifest.json'), canonical(manifestFile));
fs.writeFileSync(path.join(EVID, 'manifest.sha256'), MANIFEST_HASH + '\n');
fs.writeFileSync(path.join(EVID, 'rollback-list.txt'),
  '# Incident 017 rollback list - derived from manifest ' + MANIFEST_HASH + '\n' +
  '# staff_attendance first (reverse of execution order), then staff_employee\n' +
  attRows.map(r => 'staff_attendance\t' + r.legacy_id).join('\n') + '\n' +
  staffRows.map(r => 'staff_employee\t' + r.legacy_id).join('\n') + '\n');
console.log('staff=' + staffRows.length + ' attendance=' + attRows.length);
console.log('MANIFEST_HASH=' + MANIFEST_HASH);
