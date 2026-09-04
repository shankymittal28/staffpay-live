'use strict';
/* Stage D - application verification. The REAL shipping artifact + REAL
 * SPCloudStore boot against a mock cloud seeded with the ACTUAL post-restore
 * read-back rows (readback.json). The app judges; it writes nothing real. */
const fs = require('fs'); const path = require('path');
const EVID = path.join(__dirname, '..');
const { Store } = require('/home/user/staffpay-live/staff-cloud.js');
const html = fs.readFileSync('/home/user/staffpay-live/staff-module.html', 'utf8');
const appSrc = html.split('<script>').slice(1).map(s => s.slice(0, s.indexOf('</script>'))).find(b => b.includes('Storage shim'));
const rb = JSON.parse(fs.readFileSync(path.join(EVID, 'readback.json'), 'utf8'));
const backup = JSON.parse(fs.readFileSync(path.join(EVID, 'backup.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(EVID, 'manifest.json'), 'utf8'));

function memLS(seed) { const m = Object.assign({}, seed || {}); return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { if (v == null) delete m[k]; else m[k] = String(v); }, removeItem: k => { delete m[k]; }, _m: m }; }
const elStub = new Proxy(function () {}, { get(t,p){ if(p==='value'||p==='textContent'||p==='innerHTML')return ''; if(p==='classList')return{add(){},remove(){},toggle(){},contains:()=>false}; if(p==='style'||p==='dataset')return{}; if(p==='querySelectorAll')return()=>[]; if(p===Symbol.toPrimitive)return()=>''; return elStub;}, set(){return true;}, apply(){return elStub;} });
const doc = { getElementById: () => elStub, querySelector: () => elStub, querySelectorAll: () => [], createElement: () => elStub, addEventListener(){}, body: elStub, documentElement: elStub, visibilityState: 'visible' };

/* mock cloud SEEDED FROM THE READ-BACK (the actual database content) */
function cloudFromReadback() {
  const t = { staff_employee: {}, staff_payment: {}, staff_attendance: {}, staff_settlement: {} };
  let seq = 0;
  rb.staff.forEach(r => { t.staff_employee[r.legacy_id] = Object.assign({ id: 'uuid-' + (++seq) }, r); });
  rb.attendance.forEach(r => { t.staff_attendance[r.legacy_id] = Object.assign({}, r); });
  return { _t: t,
    snapshot() { return Promise.resolve({ employees: Object.values(t.staff_employee), payments: [], attendance: Object.values(t.staff_attendance), settlements: [] }); },
    apply(batch) { batch.forEach(op => { const tbl = t[op.table]; if (op.op === 'delete') { delete tbl[op.legacy_id]; return; } const r = op.row;
      if (!tbl[r.legacy_id]) tbl[r.legacy_id] = Object.assign(op.table === 'staff_employee' ? { id: 'uuid-' + (++seq) } : {}, r); else Object.assign(tbl[r.legacy_id], r); });
      return Promise.resolve({ employees: Object.values(t.staff_employee).map(e => ({ legacy_id: e.legacy_id, id: e.id })) }); } };
}
function bootApp(store, ls) {
  const win = { localStorage: ls, __SP_BACKEND__: store, addEventListener(){}, matchMedia: () => ({matches:false,addListener(){},addEventListener(){}}) };
  const ret = '\n;return {load,loadAtt,loadStaff,getProfile,loadRegistry,startApp:window.__startApp,daysWorkedInWeek,payrollFor};';
  const app = new Function('window','document','console','navigator', appSrc + ret)(win, doc, console, { onLine: true, userAgent: 'stageD-test' });
  ls.setItem('staffpay_schema_version', '2'); app.startApp(); return app;
}
let PASS = true; const out = [];
const chk = (n,c,x) => { if(!c) PASS=false; const l=(c?'PASS  ':'FAIL  ')+n+(x!==undefined?'  ['+x+']':''); out.push(l); console.log(l); };
const expSalary = {}; manifest.staff.forEach(r => expSalary[r.name] = { salary: r.salary, wage: r.wage_type, group: r.work_group });

(async () => {
  /* D1: FRESH DEVICE (Raj / any new phone) - empty storage, hydrates from restored cloud */
  const cloud = cloudFromReadback();
  const ls1 = memLS(); const s1 = new Store(cloud); s1.storage = ls1; await s1.init();
  const fresh = bootApp(s1, ls1);
  const staff1 = fresh.loadStaff();
  chk('fresh device: 28 staff visible', staff1.length === 28, staff1.length);
  let salaryErrs = staff1.filter(n => { const p = fresh.getProfile(n), e = expSalary[n]; return !e || p.salary !== e.salary || (p.wageType==='daily'?'daily':'monthly') !== e.wage || (p.group==='workshop'?'workshop':'shop') !== e.group; });
  chk('fresh device: every salary/wage/group exact', salaryErrs.length === 0, salaryErrs.join(',') || 'all exact');
  chk('fresh device: 10 attendance visible', fresh.loadAtt().length === 10, fresh.loadAtt().length);
  chk('fresh device: registry rebuilt from cloud (28 entries)', Object.keys((fresh.loadRegistry()||{staff:{}}).staff).length === 28);
  chk('fresh device: 29 Aug week days computed (Devendra=1)', fresh.daysWorkedInWeek('Devendra', new Date(2026,7,29)) === 1, fresh.daysWorkedInWeek('Devendra', new Date(2026,7,29)));
  chk('fresh device: absent staff counts 0 days (Laxman=0)', fresh.daysWorkedInWeek('Laxman', new Date(2026,7,29)) === 0);

  /* D2: OWNER PHONE - storage seeded from the REAL backup (caches + queue) */
  const ls2 = memLS(backup.keys); ls2.setItem('sp_cloud_session', null); // redacted marker removed; session not needed in harness
  const s2 = new Store(cloud); s2.storage = ls2; await s2.init();  // hydrate (populated cloud) then flush queue
  for (let i = 0; i < 5 && s2.outbox.length; i++) await s2.flush();
  const owner = bootApp(s2, ls2);
  const staff2 = owner.loadStaff();
  chk('owner phone: 28 staff on screen after reintegration', staff2.length === 28, staff2.length);
  chk('owner phone: same list as fresh device', JSON.stringify(staff2.slice().sort()) === JSON.stringify(staff1.slice().sort()));
  chk('owner phone: queue drained to zero', s2.outbox.length === 0, s2.outbox.length);
  chk('cloud counts unchanged after queue flush (28/10 - merge not add)', Object.keys(cloud._t.staff_employee).length === 28 && Object.keys(cloud._t.staff_attendance).length === 10, Object.keys(cloud._t.staff_employee).length + '/' + Object.keys(cloud._t.staff_attendance).length);
  chk('no unexpected writes (payments/settlements still 0)', Object.keys(cloud._t.staff_payment).length === 0 && Object.keys(cloud._t.staff_settlement).length === 0);
  const att2 = owner.loadAtt();
  chk('owner phone: 10 attendance, statuses intact (4 Present)', att2.length === 10 && att2.filter(a=>a.status==='Present').length === 4);

  fs.writeFileSync(path.join(EVID, 'gate-C-report.txt'), 'STAGE D / GATE C - application verification (sealed harness, real artifact rc4-20260902, mock cloud seeded from post-restore read-back)\n' + out.join('\n') + '\n' + (PASS ? '==> STAGE D: PASS' : '==> STAGE D: FAIL') + '\n');
  console.log(PASS ? '==> STAGE D: PASS' : '==> STAGE D: FAIL');
  process.exit(PASS ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
