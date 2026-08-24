/* ============================================================================
 * MAIOS Staff module — Phase 1A · Migration engine (IMPORT only, no SWITCH)
 * ----------------------------------------------------------------------------
 * Runs in the OWNER's browser. Reads the live app's localStorage, validates it,
 * imports it into the verified Supabase shadow tables, and proves LOCAL == CLOUD.
 * It NEVER changes how the live app reads/writes (no SWITCH). Cloud is a shadow.
 *
 * Two layers:
 *   SPMigrate  — PURE logic (read/validate/map/aggregate/compare). Unit-tested
 *                offline in Node. This is what guarantees LOCAL == CLOUD.
 *   SPCloud    — thin network layer (Supabase Auth + REST). Runs in-browser only,
 *                validated on-device behind the gates.
 * ========================================================================== */
(function (root) {
  'use strict';

  // Local storage keys — must match the canonical app exactly.
  var K = {
    SK: 'staffpay_v4', NK: 'staffpay_names_v4', AK: 'staffpay_attendance_v1',
    STK: 'staffpay_staff_master_v1', PK: 'staffpay_profiles_v1', XK: 'staffpay_removed_v1',
    RK: 'staffpay_staff_v2', WSK: 'staffpay_settlements_v1', SCHEMA: 'staffpay_schema_version'
  };
  var STATUSES = ['Present', 'Absent', 'Half-Day', 'Leave'];

  function jparse(s, fb) { try { var v = JSON.parse(s); return (v == null ? fb : v); } catch (e) { return fb; } }
  function cents(n) { return Math.round(Number(n || 0) * 100); }
  function cleanName(n) { return String(n == null ? '' : n).trim(); }

  var SPMigrate = {
    K: K, STATUSES: STATUSES,

    /* Read every dataset straight from a storage-like object {getItem(k)} */
    readLocal: function (storage) {
      var reg = jparse(storage.getItem(K.RK), null);
      return {
        payments:    jparse(storage.getItem(K.SK), []),
        attendance:  jparse(storage.getItem(K.AK), []),
        settlements: jparse(storage.getItem(K.WSK), []),
        profiles:    jparse(storage.getItem(K.PK), {}),
        names:       jparse(storage.getItem(K.NK), []),
        removed:     jparse(storage.getItem(K.XK), []),
        registry:    reg,
        schema:      storage.getItem(K.SCHEMA)
      };
    },

    /* VERIFY BACKUP gate — returns {ok, failures[], stats}. STOP if !ok. */
    verifyBackup: function (local) {
      var f = [];
      // 1) readable / correct types
      if (!Array.isArray(local.payments))    f.push('payments not readable as array');
      if (!Array.isArray(local.attendance))  f.push('attendance not readable as array');
      if (!Array.isArray(local.settlements)) f.push('settlements not readable as array');
      // 2) all datasets present (identity registry is mandatory for a faithful import)
      if (!local.registry || typeof local.registry !== 'object' || !local.registry.staff)
        f.push('identity registry (staffpay_staff_v2) missing — open the app once to build it, then retry');
      // 3) internally consistent
      var dupCheck = function (arr, label) {
        var seen = Object.create(null), dups = 0, missing = 0;
        (arr || []).forEach(function (e) {
          if (!e || e.id == null) { missing++; return; }
          var k = String(e.id);
          if (seen[k]) dups++; else seen[k] = 1;
        });
        if (missing) f.push(label + ': ' + missing + ' record(s) missing an id');
        if (dups)    f.push(label + ': ' + dups + ' duplicate id(s)');
      };
      dupCheck(local.payments, 'payments');
      dupCheck(local.attendance, 'attendance');
      dupCheck(local.settlements, 'settlements');
      (local.payments || []).forEach(function (p) {
        if (!isFinite(Number(p.amount))) f.push('payment ' + p.id + ': amount not a finite number');
      });
      (local.attendance || []).forEach(function (a) {
        if (STATUSES.indexOf(a.status) < 0) f.push('attendance ' + a.id + ': unexpected status "' + a.status + '"');
        if (!a.dayKey) f.push('attendance ' + a.id + ': missing dayKey');
      });
      // orphan staffId check (informational -> becomes a hard failure only if registry missing)
      var regIds = {};
      if (local.registry && local.registry.staff) Object.keys(local.registry.staff).forEach(function (id) { regIds[id] = 1; });
      var orphans = 0;
      ['payments', 'attendance', 'settlements'].forEach(function (ds) {
        (local[ds] || []).forEach(function (e) { if (e && e.staffId && !regIds[e.staffId]) orphans++; });
      });
      var stats = {
        payments: (local.payments || []).length,
        attendance: (local.attendance || []).length,
        settlements: (local.settlements || []).length,
        staff: local.registry && local.registry.staff ? Object.keys(local.registry.staff).length : 0,
        paymentTotalCents: (local.payments || []).reduce(function (s, p) { return s + cents(p.amount); }, 0),
        orphanStaffIds: orphans
      };
      // 4) restorable — round-trip the three ledgers through JSON and confirm identical
      try {
        var rt = JSON.parse(JSON.stringify({ p: local.payments, a: local.attendance, s: local.settlements }));
        if (rt.p.length !== stats.payments || rt.a.length !== stats.attendance || rt.s.length !== stats.settlements)
          f.push('dry-run restore changed record counts');
        var rtTotal = rt.p.reduce(function (s, p) { return s + cents(p.amount); }, 0);
        if (rtTotal !== stats.paymentTotalCents) f.push('dry-run restore changed payment total');
      } catch (e) { f.push('dry-run restore threw: ' + e.message); }

      return { ok: f.length === 0, failures: f, stats: stats };
    },

    /* Map registry -> staff_employee rows (identity spine) */
    buildEmployees: function (local, device) {
      var reg = (local.registry && local.registry.staff) || {};
      return Object.keys(reg).map(function (id) {
        var e = reg[id] || {};
        return {
          legacy_id: String(e.id != null ? e.id : id),
          name: cleanName(e.name),
          work_group: e.group === 'workshop' ? 'workshop' : 'shop',
          phone: e.phone || '',
          active: e.active !== false,
          salary: Number(e.salary) || 0,
          wage_type: e.wageType === 'daily' ? 'daily' : 'monthly',
          source: e.source || null,
          device: device || null
        };
      });
    },

    /* Map ledgers -> child rows. empMap: {legacy_id -> cloud employee uuid} */
    buildChildren: function (local, empMap, device) {
      empMap = empMap || {};
      var resolve = function (staffId) { return staffId != null && empMap[String(staffId)] ? empMap[String(staffId)] : null; };
      return {
        payments: (local.payments || []).map(function (p) {
          return { legacy_id: String(p.id), staff_id: resolve(p.staffId), name: cleanName(p.name),
                   amount: Number(p.amount) || 0, note: p.note || '', date: p.date,
                   month_key: p.monthKey || null, device: device || null };
        }),
        attendance: (local.attendance || []).map(function (a) {
          return { legacy_id: String(a.id), staff_id: resolve(a.staffId), name: cleanName(a.name),
                   status: a.status, note: a.note || '', date: a.date,
                   month_key: a.monthKey || null, day_key: a.dayKey, device: device || null };
        }),
        settlements: (local.settlements || []).map(function (s) {
          return { legacy_id: String(s.id), staff_id: resolve(s.staffId), name: cleanName(s.name),
                   week_key: s.weekKey || null, days_worked: Number(s.daysWorked) || 0,
                   daily_wage: Number(s.dailyWage) || 0, cash_paid: Number(s.cashPaid) || 0,
                   settled_at: s.settledAt || null, device: device || null };
        })
      };
    },

    /* Local aggregates used by VERIFY IMPORT */
    localAggregates: function (local) {
      var setOf = function (arr) { var s = {}; (arr || []).forEach(function (e) { if (e && e.id != null) s[String(e.id)] = 1; }); return s; };
      var rels = function (arr) { var m = {}; (arr || []).forEach(function (e) { if (e && e.id != null) m[String(e.id)] = (e.staffId != null ? String(e.staffId) : null); }); return m; };
      return {
        counts: {
          payments: (local.payments || []).length,
          attendance: (local.attendance || []).length,
          settlements: (local.settlements || []).length,
          staff: local.registry && local.registry.staff ? Object.keys(local.registry.staff).length : 0
        },
        paymentTotalCents: (local.payments || []).reduce(function (s, p) { return s + cents(p.amount); }, 0),
        legacyIds: { payments: setOf(local.payments), attendance: setOf(local.attendance), settlements: setOf(local.settlements) },
        relations: { payments: rels(local.payments), attendance: rels(local.attendance), settlements: rels(local.settlements) }
      };
    },

    /* VERIFY IMPORT — compare local aggregates to cloud aggregates.
     * cloud = { counts:{payments,attendance,settlements,staff},
     *           paymentTotalCents,
     *           legacyIds:{payments:[..],attendance:[..],settlements:[..]},
     *           relations:{payments:{legacy_id:staff_legacy_id|null}, ...},
     *           duplicates:{payments,attendance,settlements,staff} }  // dup legacy_id counts
     * Returns {ok, checks[]}. */
    verifyImport: function (localAgg, cloud) {
      var checks = [];
      var add = function (name, pass, detail) { checks.push({ name: name, pass: !!pass, detail: detail || '' }); };
      add('payment count identical', localAgg.counts.payments === cloud.counts.payments,
          localAgg.counts.payments + ' vs ' + cloud.counts.payments);
      add('attendance count identical', localAgg.counts.attendance === cloud.counts.attendance,
          localAgg.counts.attendance + ' vs ' + cloud.counts.attendance);
      add('settlement count identical', localAgg.counts.settlements === cloud.counts.settlements,
          localAgg.counts.settlements + ' vs ' + cloud.counts.settlements);
      add('staff count identical', localAgg.counts.staff === cloud.counts.staff,
          localAgg.counts.staff + ' vs ' + cloud.counts.staff);
      add('exact total ₹ identical', localAgg.paymentTotalCents === cloud.paymentTotalCents,
          '₹' + (localAgg.paymentTotalCents / 100) + ' vs ₹' + (cloud.paymentTotalCents / 100));

      // every legacy_id preserved (set equality per table)
      ['payments', 'attendance', 'settlements'].forEach(function (ds) {
        var localSet = localAgg.legacyIds[ds];
        var cloudArr = (cloud.legacyIds && cloud.legacyIds[ds]) || [];
        var cloudSet = {}; cloudArr.forEach(function (id) { cloudSet[String(id)] = 1; });
        var missing = Object.keys(localSet).filter(function (id) { return !cloudSet[id]; });
        var extra = cloudArr.filter(function (id) { return !localSet[String(id)]; });
        add('every legacy_id preserved (' + ds + ')', missing.length === 0 && extra.length === 0,
            (missing.length ? missing.length + ' missing in cloud' : '') + (extra.length ? ' ' + extra.length + ' extra in cloud' : '') || 'exact match');
      });

      // every staff relationship preserved
      ['payments', 'attendance', 'settlements'].forEach(function (ds) {
        var lrel = localAgg.relations[ds];
        var crel = (cloud.relations && cloud.relations[ds]) || {};
        var bad = 0;
        Object.keys(lrel).forEach(function (id) { if ((lrel[id] || null) !== (crel[id] || null)) bad++; });
        add('every staff relationship preserved (' + ds + ')', bad === 0, bad ? bad + ' mismatched links' : 'all links match');
      });

      // zero duplicate records
      var dup = cloud.duplicates || {};
      var totDup = (dup.payments || 0) + (dup.attendance || 0) + (dup.settlements || 0) + (dup.staff || 0);
      add('zero duplicate records', totDup === 0, totDup ? totDup + ' duplicate legacy_id(s)' : 'none');

      var ok = checks.every(function (c) { return c.pass; });
      return { ok: ok, checks: checks };
    }
  };

  /* ---- SPCloud: thin Supabase network layer (browser only) ---------------- */
  var SPCloud = {
    URL: 'https://bsjrihrekfsxmajdsyhc.supabase.co',
    ANON: 'sb_publishable_68CN3THmdtvRrJnm_Yv4aA_kwHhl0hF',
    _session: null,
    _headers: function (extra) {
      var h = { 'apikey': this.ANON, 'Content-Type': 'application/json' };
      if (this._session && this._session.access_token) h['Authorization'] = 'Bearer ' + this._session.access_token;
      if (extra) for (var k in extra) h[k] = extra[k];
      return h;
    },
    restoreSession: function (storage) { this._session = jparse((storage || root.localStorage).getItem('sp_cloud_session'), null); return !!this._session; },
    _persist: function (storage) { try { (storage || root.localStorage).setItem('sp_cloud_session', JSON.stringify(this._session)); } catch (e) {} },
    signIn: function (email, password, storage) {
      var self = this;
      return fetch(this.URL + '/auth/v1/token?grant_type=password', {
        method: 'POST', headers: this._headers(), body: JSON.stringify({ email: email, password: password })
      }).then(function (r) { return r.json(); }).then(function (j) {
        if (!j.access_token) throw new Error(j.error_description || j.msg || j.error || 'sign-in failed');
        self._session = j; self._persist(storage); return j;
      });
    },
    // Idempotent upsert on (owner_id, legacy_id). Requires an authenticated session.
    upsert: function (table, rows) {
      if (!rows.length) return Promise.resolve([]);
      return fetch(this.URL + '/rest/v1/' + table + '?on_conflict=owner_id,legacy_id', {
        method: 'POST',
        headers: this._headers({ 'Prefer': 'resolution=merge-duplicates,return=representation' }),
        body: JSON.stringify(rows)
      }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(JSON.stringify(j)); return j; }); });
    },
    // Read back aggregates for VERIFY IMPORT (owner-scoped by RLS).
    aggregates: function () {
      var self = this;
      var count = function (t) {
        return fetch(self.URL + '/rest/v1/' + t + '?select=legacy_id', { headers: self._headers({ 'Prefer': 'count=exact' }) })
          .then(function (r) { return r.json().then(function (j) { return { rows: j }; }); });
      };
      // Employees give legacy_id<->id map; children carry staff_id -> resolve to employee legacy_id.
      return Promise.all([
        fetch(self.URL + '/rest/v1/staff_employee?select=id,legacy_id', { headers: self._headers() }).then(function (r) { return r.json(); }),
        fetch(self.URL + '/rest/v1/staff_payment?select=legacy_id,amount,staff_id', { headers: self._headers() }).then(function (r) { return r.json(); }),
        fetch(self.URL + '/rest/v1/staff_attendance?select=legacy_id,staff_id', { headers: self._headers() }).then(function (r) { return r.json(); }),
        fetch(self.URL + '/rest/v1/staff_settlement?select=legacy_id,staff_id', { headers: self._headers() }).then(function (r) { return r.json(); })
      ]).then(function (res) {
        var emps = res[0], pay = res[1], att = res[2], set = res[3];
        var idToLegacy = {}; emps.forEach(function (e) { idToLegacy[e.id] = e.legacy_id; });
        var cents = function (n) { return Math.round(Number(n || 0) * 100); };
        var dupCount = function (arr) { var s = {}, d = 0; arr.forEach(function (r) { var k = String(r.legacy_id); if (s[k]) d++; else s[k] = 1; }); return d; };
        var rels = function (arr) { var m = {}; arr.forEach(function (r) { m[String(r.legacy_id)] = r.staff_id != null ? (idToLegacy[r.staff_id] || '__unknown__') : null; }); return m; };
        return {
          counts: { payments: pay.length, attendance: att.length, settlements: set.length, staff: emps.length },
          paymentTotalCents: pay.reduce(function (s, r) { return s + cents(r.amount); }, 0),
          legacyIds: { payments: pay.map(function (r) { return String(r.legacy_id); }), attendance: att.map(function (r) { return String(r.legacy_id); }), settlements: set.map(function (r) { return String(r.legacy_id); }) },
          relations: { payments: rels(pay), attendance: rels(att), settlements: rels(set) },
          duplicates: { payments: dupCount(pay), attendance: dupCount(att), settlements: dupCount(set), staff: dupCount(emps.map(function (e) { return { legacy_id: e.legacy_id }; })) },
          _idToLegacy: idToLegacy
        };
      });
    }
  };

  root.SPMigrate = SPMigrate;
  root.SPCloud = SPCloud;
  if (typeof module !== 'undefined' && module.exports) module.exports = { SPMigrate: SPMigrate, SPCloud: SPCloud };
})(typeof window !== 'undefined' ? window : globalThis);
