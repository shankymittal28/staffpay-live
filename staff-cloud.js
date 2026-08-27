/* ============================================================================
 * MAIOS Staff module — Phase 1A · Cloud cutover backend for the storage seam
 * ----------------------------------------------------------------------------
 * Turns the existing SPStore seam into: Supabase (source of truth) + in-memory
 * mirror (synchronous reads for the untouched app) + localStorage cache +
 * offline outbox. The app's load()/save()/... never change.
 *
 * Blob<->row translation: the app reads/writes whole JSON blobs by key; this
 * module maps them to the verified relational staff_ tables and back.
 *
 *   SK  (payments)    <-> staff_payment
 *   AK  (attendance)  <-> staff_attendance
 *   WSK (settlements) <-> staff_settlement
 *   RK  (registry)    <-> staff_employee   (identity spine)
 *   PK/STK/NK/XK      : DERIVED from staff_employee (DP2: employee is canonical)
 *   SNAP/LBK/SCHEMA   : LOCAL-ONLY (never leave the device)
 *
 * Multi-device safety: setRaw diffs the incoming blob against THIS device's
 * mirror. A delete only fires for a record this device had and then removed;
 * records another device added (absent from this mirror) are never deletion
 * candidates -> concurrent additions union, they never clobber each other.
 * (Concurrent edits to the SAME record are last-write-wins — see report.)
 * ========================================================================== */
(function (root) {
  'use strict';

  var K = {
    SK: 'staffpay_v4', NK: 'staffpay_names_v4', AK: 'staffpay_attendance_v1',
    STK: 'staffpay_staff_master_v1', PK: 'staffpay_profiles_v1', XK: 'staffpay_removed_v1',
    RK: 'staffpay_staff_v2', WSK: 'staffpay_settlements_v1'
  };
  var LOCAL_ONLY = { 'staffpay_schema_version': 1, 'staffpay_premigration_backup_v1': 1, 'staffpay_lastbackup_v1': 1 };
  var OUTBOX_KEY = 'sp_cloud_outbox';
  var CACHE_PREFIX = 'sp_cloud_cache:';

  function jparse(s, fb) { try { var v = JSON.parse(s); return v == null ? fb : v; } catch (e) { return fb; } }
  function idNative(legacy) { return /^\d+$/.test(String(legacy)) ? Number(legacy) : String(legacy); }
  function cents(n) { return Math.round(Number(n || 0) * 100); }

  /* ---------- pure translation (blob <-> rows) ---------------------------- */
  var Map2 = {
    // rows -> app blobs
    employeesToRegistry: function (emps) {
      var reg = { version: 2, createdAt: null, updatedAt: null, staff: {}, variantFlags: [] };
      emps.forEach(function (e) {
        reg.staff[e.legacy_id] = {
          id: e.legacy_id, name: e.name, group: e.work_group === 'workshop' ? 'workshop' : 'shop',
          phone: e.phone || '', active: e.active !== false, salary: Number(e.salary) || 0,
          wageType: e.wage_type === 'daily' ? 'daily' : 'monthly', source: e.source || null,
          policyId: null, createdAt: e.created_at || null
        };
      });
      return reg;
    },
    // "removed" (XK blocklist) and "inactive" (profile active=false) are distinct
    // app concepts: removed staff leave master/profiles entirely (registry keeps
    // their identity), inactive staff stay listed. Mapped via the dedicated
    // staff_employee.removed column.
    employeesToProfiles: function (emps) {
      var p = {};
      emps.forEach(function (e) { if (e.removed === true) return; p[e.name] = { salary: Number(e.salary) || 0, wageType: e.wage_type === 'daily' ? 'daily' : 'monthly', group: e.work_group === 'workshop' ? 'workshop' : 'shop', phone: e.phone || '', active: e.active !== false }; });
      return p;
    },
    employeesToMaster: function (emps) { return emps.filter(function (e) { return e.removed !== true; }).map(function (e) { return e.name; }); },
    employeesToRemoved: function (emps) { return emps.filter(function (e) { return e.removed === true; }).map(function (e) { return e.name; }); },
    paymentsToBlob: function (rows, idToLegacy) {
      return rows.map(function (r) { return { id: idNative(r.legacy_id), name: r.name, amount: Number(r.amount) || 0, note: r.note || '', date: r.date, monthKey: r.month_key, staffId: r.staff_id != null ? idToLegacy[r.staff_id] : undefined }; });
    },
    attendanceToBlob: function (rows, idToLegacy) {
      return rows.map(function (r) { return { id: idNative(r.legacy_id), name: r.name, status: r.status, note: r.note || '', date: r.date, monthKey: r.month_key, dayKey: r.day_key, staffId: r.staff_id != null ? idToLegacy[r.staff_id] : undefined }; });
    },
    settlementsToBlob: function (rows, idToLegacy) {
      return rows.map(function (r) { return { id: r.legacy_id, staffId: r.staff_id != null ? idToLegacy[r.staff_id] : null, name: r.name, weekKey: r.week_key, daysWorked: Number(r.days_worked) || 0, dailyWage: Number(r.daily_wage) || 0, cashPaid: Number(r.cash_paid) || 0, settledAt: r.settled_at }; });
    },
    // app record -> row (staff_id resolved by caller via empMap on legacy staffId)
    paymentRow: function (p, empMap, device) { return { legacy_id: String(p.id), staff_id: p.staffId != null ? (empMap[String(p.staffId)] || null) : null, name: p.name, amount: Number(p.amount) || 0, note: p.note || '', date: p.date, month_key: p.monthKey || null, device: device }; },
    attendanceRow: function (a, empMap, device) { return { legacy_id: String(a.id), staff_id: a.staffId != null ? (empMap[String(a.staffId)] || null) : null, name: a.name, status: a.status, note: a.note || '', date: a.date, month_key: a.monthKey || null, day_key: a.dayKey, device: device }; },
    settlementRow: function (s, empMap, device) { return { legacy_id: String(s.id), staff_id: s.staffId != null ? (empMap[String(s.staffId)] || null) : null, name: s.name, week_key: s.weekKey || null, days_worked: Number(s.daysWorked) || 0, daily_wage: Number(s.dailyWage) || 0, cash_paid: Number(s.cashPaid) || 0, settled_at: s.settledAt || null, device: device }; },
    employeeRow: function (e, device) { return { legacy_id: String(e.id), name: e.name, work_group: e.group === 'workshop' ? 'workshop' : 'shop', phone: e.phone || '', active: e.active !== false, salary: Number(e.salary) || 0, wage_type: e.wageType === 'daily' ? 'daily' : 'monthly', source: e.source || null, device: device }; },

    // diff two arrays of records by id -> {upsert:[...], deleteIds:[...]}
    diff: function (oldArr, newArr, idOf) {
      idOf = idOf || function (e) { return String(e.id); };
      var oldMap = {}, newMap = {};
      (oldArr || []).forEach(function (e) { if (e) oldMap[idOf(e)] = e; });
      (newArr || []).forEach(function (e) { if (e) newMap[idOf(e)] = e; });
      var upsert = [], deleteIds = [];
      for (var k in newMap) if (oldMap[k] == null || JSON.stringify(oldMap[k]) !== JSON.stringify(newMap[k])) upsert.push(newMap[k]);
      for (var k2 in oldMap) if (newMap[k2] == null) deleteIds.push(k2);
      return { upsert: upsert, deleteIds: deleteIds };
    }
  };

  /* ---------- the cloud-backed store ------------------------------------- */
  function SPCloudStore(net) {
    this.net = net;                 // network adapter (real Supabase in browser, mock in tests)
    this.mirror = {};               // key -> JSON string (what the app sees)
    this.empByLegacy = {};          // legacy_id -> cloud uuid
    this.empByUuid = {};            // cloud uuid -> legacy_id
    this.outbox = [];               // pending row ops
    this.device = (root.navigator && root.navigator.userAgent ? 'web-' + root.navigator.userAgent.slice(0, 20) : 'node');
    this.storage = (root.localStorage) || null;
  }
  SPCloudStore.prototype._cacheGet = function (key) { try { return this.storage ? this.storage.getItem(CACHE_PREFIX + key) : null; } catch (e) { return null; } };
  SPCloudStore.prototype._cacheSet = function (key, val) { try { if (this.storage) this.storage.setItem(CACHE_PREFIX + key, val); } catch (e) {} };
  SPCloudStore.prototype._loadOutbox = function () { this.outbox = jparse(this.storage && this.storage.getItem(OUTBOX_KEY), []); };
  SPCloudStore.prototype._saveOutbox = function () { try { if (this.storage) this.storage.setItem(OUTBOX_KEY, JSON.stringify(this.outbox)); } catch (e) {} };

  // Build every mirror blob from a snapshot of cloud rows.
  SPCloudStore.prototype._rebuildMirror = function (snap) {
    this.empByLegacy = {}; this.empByUuid = {};
    (snap.employees || []).forEach(function (e) { this.empByLegacy[e.legacy_id] = e.id; this.empByUuid[e.id] = e.legacy_id; }, this);
    var idToLegacy = this.empByUuid;
    this.mirror[K.RK]  = JSON.stringify(Map2.employeesToRegistry(snap.employees || []));
    this.mirror[K.PK]  = JSON.stringify(Map2.employeesToProfiles(snap.employees || []));
    this.mirror[K.STK] = JSON.stringify(Map2.employeesToMaster(snap.employees || []));
    this.mirror[K.NK]  = JSON.stringify((snap.employees || []).filter(function (e) { return e.removed !== true; }).map(function (e) { return e.name; }));
    this.mirror[K.XK]  = JSON.stringify(Map2.employeesToRemoved(snap.employees || []));
    this.mirror[K.SK]  = JSON.stringify(Map2.paymentsToBlob(snap.payments || [], idToLegacy));
    this.mirror[K.AK]  = JSON.stringify(Map2.attendanceToBlob(snap.attendance || [], idToLegacy));
    this.mirror[K.WSK] = JSON.stringify(Map2.settlementsToBlob(snap.settlements || [], idToLegacy));
    // cache every blob for offline
    for (var kk in this.mirror) this._cacheSet(kk, this.mirror[kk]);
  };

  // Hydrate: try cloud; on failure fall back to the local cache (offline start).
  SPCloudStore.prototype.init = function () {
    var self = this;
    this._loadOutbox();
    return this.net.snapshot().then(function (snap) {
      self._rebuildMirror(snap);
      return self.flush();               // push anything queued while offline
    }).catch(function () {
      // offline / unreachable -> serve from cache
      [K.SK, K.AK, K.WSK, K.RK, K.PK, K.STK, K.NK, K.XK].forEach(function (kk) {
        var c = self._cacheGet(kk); if (c != null) self.mirror[kk] = c;
      });
      // rebuild emp maps from cached registry so staffId resolution still works
      var reg = jparse(self.mirror[K.RK], { staff: {} });
      return null;
    });
  };

  SPCloudStore.prototype.getRaw = function (key) {
    if (LOCAL_ONLY[key]) { try { return this.storage ? this.storage.getItem(key) : null; } catch (e) { return null; } }
    return this.mirror[key] != null ? this.mirror[key] : null;
  };
  SPCloudStore.prototype.removeRaw = function (key) {
    if (LOCAL_ONLY[key]) { try { if (this.storage) this.storage.removeItem(key); } catch (e) {} return; }
    delete this.mirror[key]; this._cacheSet(key, null);
  };

  // Write-through: update mirror + cache, translate the delta to row ops, queue, flush.
  SPCloudStore.prototype.setRaw = function (key, val) {
    if (LOCAL_ONLY[key]) { try { if (this.storage) this.storage.setItem(key, val); } catch (e) {} return; }
    var oldBlob = this.mirror[key];
    this.mirror[key] = String(val);
    this._cacheSet(key, this.mirror[key]);
    this._enqueueDelta(key, jparse(oldBlob, key === K.RK ? { staff: {} } : []), jparse(val, key === K.RK ? { staff: {} } : []));
    if (key === K.RK) { /* employee ids may be new; keep emp maps roughly current */ }
    this.flush();
  };

  SPCloudStore.prototype._enqueueDelta = function (key, oldB, newB) {
    var self = this, ops = [];
    var push = function (table, up, del) { up.forEach(function (r) { ops.push({ table: table, op: 'upsert', row: r }); }); del.forEach(function (id) { ops.push({ table: table, op: 'delete', legacy_id: id }); }); };
    if (key === K.RK) {
      var oldE = Object.keys((oldB && oldB.staff) || {}).map(function (id) { return oldB.staff[id]; });
      var newE = Object.keys((newB && newB.staff) || {}).map(function (id) { return newB.staff[id]; });
      var d = Map2.diff(oldE, newE, function (e) { return String(e.id); });
      push('staff_employee', d.upsert.map(function (e) { return Map2.employeeRow(e, self.device); }), d.deleteIds);
    } else if (key === K.SK || key === K.AK || key === K.WSK) {
      var table = key === K.SK ? 'staff_payment' : key === K.AK ? 'staff_attendance' : 'staff_settlement';
      var rowFn = key === K.SK ? Map2.paymentRow : key === K.AK ? Map2.attendanceRow : Map2.settlementRow;
      var d2 = Map2.diff(oldB, newB, function (e) { return String(e.id); });
      push(table, d2.upsert.map(function (e) { return rowFn(e, self.empByLegacy, self.device); }), d2.deleteIds);
    } else if (key === K.XK) {
      // Removed-blocklist change -> flip staff_employee.removed for the affected
      // names (deleteStaff adds a name; saveStaffName clears it on re-add).
      var was = {}; (Array.isArray(oldB) ? oldB : []).forEach(function (n) { was[String(n).trim()] = 1; });
      var now = {}; (Array.isArray(newB) ? newB : []).forEach(function (n) { now[String(n).trim()] = 1; });
      var reg2 = jparse(this.mirror[K.RK], { staff: {} });
      var byName = {}; Object.keys(reg2.staff || {}).forEach(function (id) { var e = reg2.staff[id]; if (e && e.name) byName[String(e.name).trim()] = e; });
      var flag = function (name, removed) {
        var e = byName[name];
        if (!e) return;                                    // unknown name: nothing to flag
        var row = Map2.employeeRow(e, self.device); row.removed = removed;
        ops.push({ table: 'staff_employee', op: 'upsert', row: row });
      };
      for (var nm in now) if (!was[nm]) flag(nm, true);
      for (var nm2 in was) if (!now[nm2]) flag(nm2, false);
    } else if (key === K.PK || key === K.STK || key === K.NK) {
      // Profile/master/name-list writes are absorbed by the RK (employee) write the
      // app performs alongside them; nothing extra to enqueue here (DP2).
    }
    if (ops.length) { this.outbox = this.outbox.concat(ops); this._saveOutbox(); }
  };

  // Flush outbox to cloud; on any failure keep the queue for the next attempt.
  SPCloudStore.prototype.flush = function () {
    var self = this;
    if (!this.outbox.length) return Promise.resolve({ flushed: 0 });
    if (this._flushing) return this._flushing;
    var batch = this.outbox.slice();
    this._flushing = this.net.apply(batch).then(function (res) {
      // res may map new employee legacy_id->uuid; refresh emp maps
      if (res && res.employees) res.employees.forEach(function (e) { self.empByLegacy[e.legacy_id] = e.id; self.empByUuid[e.id] = e.legacy_id; });
      self.outbox = self.outbox.slice(batch.length);
      self._saveOutbox(); self._flushing = null;
      return { flushed: batch.length };
    }).catch(function (e) { self._flushing = null; return { flushed: 0, error: String(e && e.message || e) }; });
    return this._flushing;
  };

  // Pull latest cloud state into the mirror (merging pending outbox on top).
  SPCloudStore.prototype.pull = function () {
    var self = this;
    return this.net.snapshot().then(function (snap) { self._rebuildMirror(snap); return true; }).catch(function () { return false; });
  };

  /* ---------- SPNet: real Supabase network adapter (browser only) --------- */
  function SPNet(session) {
    this.URL = 'https://bsjrihrekfsxmajdsyhc.supabase.co';
    this.ANON = 'sb_publishable_68CN3THmdtvRrJnm_Yv4aA_kwHhl0hF';
    this.session = session || null;
  }
  SPNet.prototype._h = function (extra) {
    var h = { 'apikey': this.ANON, 'Content-Type': 'application/json' };
    if (this.session && this.session.access_token) h['Authorization'] = 'Bearer ' + this.session.access_token;
    if (extra) for (var k in extra) h[k] = extra[k];
    return h;
  };
  SPNet.prototype.signIn = function (email, password) {
    var self = this;
    return fetch(this.URL + '/auth/v1/token?grant_type=password', { method: 'POST', headers: this._h(), body: JSON.stringify({ email: email, password: password }) })
      .then(function (r) { return r.json(); }).then(function (j) { if (!j.access_token) throw new Error(j.error_description || j.msg || 'sign-in failed'); self.session = j; try { root.localStorage.setItem('sp_cloud_session', JSON.stringify(j)); } catch (e) {} return j; });
  };
  // One-time sign-in per device: the persisted session's access token expires
  // (~1h), so on every boot the refresh token mints a fresh session silently.
  SPNet.prototype.refreshSession = function () {
    var self = this;
    if (!this.session || !this.session.refresh_token) return Promise.reject(new Error('no session'));
    return fetch(this.URL + '/auth/v1/token?grant_type=refresh_token', { method: 'POST', headers: this._h(), body: JSON.stringify({ refresh_token: this.session.refresh_token }) })
      .then(function (r) { return r.json(); }).then(function (j) {
        if (!j.access_token) throw new Error(j.error_description || j.msg || 'refresh failed');
        self.session = j; try { root.localStorage.setItem('sp_cloud_session', JSON.stringify(j)); } catch (e) {}
        return j;
      });
  };
  SPNet.prototype.snapshot = function () {
    var self = this, get = function (t) { return fetch(self.URL + '/rest/v1/' + t + '?select=*', { headers: self._h() }).then(function (r) { if (!r.ok) throw new Error(t + ' ' + r.status); return r.json(); }); };
    return Promise.all([get('staff_employee'), get('staff_payment'), get('staff_attendance'), get('staff_settlement')])
      .then(function (a) { return { employees: a[0], payments: a[1], attendance: a[2], settlements: a[3] }; });
  };
  SPNet.prototype.apply = function (batch) {
    var self = this, byTable = {}, deletes = {};
    batch.forEach(function (o) {
      if (o.op === 'delete') { (deletes[o.table] = deletes[o.table] || []).push(o.legacy_id); }
      else { (byTable[o.table] = byTable[o.table] || []).push(o.row); }
    });
    var chain = Promise.resolve({ employees: [] });
    Object.keys(byTable).forEach(function (t) {
      chain = chain.then(function (acc) {
        return fetch(self.URL + '/rest/v1/' + t + '?on_conflict=owner_id,legacy_id', { method: 'POST', headers: self._h({ 'Prefer': 'resolution=merge-duplicates,return=representation' }), body: JSON.stringify(byTable[t]) })
          .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(JSON.stringify(j)); if (t === 'staff_employee') acc.employees = acc.employees.concat(j.map(function (e) { return { legacy_id: e.legacy_id, id: e.id }; })); return acc; }); });
      });
    });
    Object.keys(deletes).forEach(function (t) {
      chain = chain.then(function (acc) {
        var inList = '(' + deletes[t].map(function (x) { return '"' + String(x).replace(/"/g, '') + '"'; }).join(',') + ')';
        return fetch(self.URL + '/rest/v1/' + t + '?legacy_id=in.' + encodeURIComponent(inList), { method: 'DELETE', headers: self._h() })
          .then(function (r) { if (!r.ok) return r.text().then(function (tx) { throw new Error(tx); }); return acc; });
      });
    });
    return chain;
  };

  root.SPCloud2 = { Store: SPCloudStore, Map: Map2, K: K, Net: SPNet };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.SPCloud2;
})(typeof window !== 'undefined' ? window : globalThis);
