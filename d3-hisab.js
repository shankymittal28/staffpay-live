/* ============================================================================
 * StaffPay D3 - Workshop weekly hisab (rc10)
 * ----------------------------------------------------------------------------
 * Every workshop number on screen comes from the database's own calculation
 * (staff_workshop_report), which reads attendance, payments, frozen weekly
 * rates and the Old Hisab from one consistent moment and is not limited to the
 * phone's 1,000-row download. Settlement, Old Hisab / rate changes and payment
 * corrections are single database operations with an operation id that is
 * kept on this phone until the database has confirmed it, so a lost reply is
 * checked ("Save not confirmed - checking") instead of being guessed.
 *
 * Money a worker gives back ("Wapas mila", rc15) is a minus row in the same
 * Payments ledger, created only by staff_receipt_add. This page tells the
 * database it shows receipts (receipts_ok) on every hisab call; the database
 * refuses or withholds receipt weeks for older pages that do not.
 *
 * Shop staff never pass through this file.
 * ========================================================================== */
var SPD3 = (function () {
  'use strict';
  var PEND = 'sp_d3_pending';
  var cache = {};                       // report cache: staff|to|from -> report
  var notes = {};                       // per-card messages: legacy -> text
  var IST = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });

  function $(id) { return document.getElementById(id); }
  function h(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function js(s) { return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }
  function istToday() { return IST.format(new Date()); }
  function istDay(iso) { return IST.format(new Date(iso)); }
  function addDays(dk, k) { var d = new Date(dk + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + k); return d.toISOString().slice(0, 10); }
  function mondayOf(dk) { var d = new Date(dk + 'T00:00:00Z'); return addDays(dk, -((d.getUTCDay() + 6) % 7)); }
  function monthEnd(mk) { var p = mk.split('-').map(Number); return new Date(Date.UTC(p[0], p[1], 0)).toISOString().slice(0, 10); }
  function dShort(dk) { var d = new Date(dk + 'T00:00:00Z'); return d.toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', timeZone: 'UTC' }); }
  function dLong(dk) { var d = new Date(dk + 'T00:00:00Z'); return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }); }
  function num(v) { return Number(v); }
  function rs(v) {
    var x = Math.round(Math.abs(num(v)) * 100) / 100;
    return (num(v) < 0 ? '−' : '') + '₹' + x.toLocaleString('en-IN', { maximumFractionDigits: 2 });
  }
  function words(v) {
    v = num(v);
    if (v > 0) return rs(v) + ' — shop owes worker';
    if (v < 0) return rs(-v) + ' — worker owes shop';
    return '₹0 — nothing owed either way';
  }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var b = new Uint8Array(16); crypto.getRandomValues(b); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    var x = Array.from(b, function (v) { return ('0' + v.toString(16)).slice(-2); }).join('');
    return x.slice(0, 8) + '-' + x.slice(8, 12) + '-' + x.slice(12, 16) + '-' + x.slice(16, 20) + '-' + x.slice(20);
  }
  var ERR = {
    'already settled': 'This week is already settled (another phone may have done it). Refreshed.',
    'version mismatch': 'This week was changed on another phone. Refreshed — please check and try again.',
    'figures changed': 'Figures changed since you looked (new attendance or payment). Refreshed — please check again.',
    'balance withheld': 'Balance withheld — see the reasons on the card.',
    'changed elsewhere': 'Changed on another phone. Refreshed — please check and try again.',
    'payment changed': 'This payment was changed elsewhere. Refreshed.',
    'already removed': 'This payment was already removed.',
    'operation mismatch': 'This save conflicts with an earlier one. Refreshed.',
    'earlier week not settled': 'An earlier week is not settled yet. Weeks are settled in order; ₹0 is fine if no cash was given that Sunday.',
    'later week settled': 'A later week is already settled and carried this week\'s balance. Cash given on another day is recorded as a payment on that day.'
  };
  function plain(r) { return (r && (r.message || ERR[r.error] || r.error)) || 'Not saved'; }

  /* ---- talking to the database ------------------------------------------- */
  // calls whose answers or checks depend on receipts carry receipts_ok: true
  var RCV_OK = { staff_workshop_report: 1, staff_settlement_apply: 1, staff_payment_correct: 1, staff_workshop_payments: 1, staff_receipt_add: 1 };
  function rpc(fn, p) {
    var n = window.__SP_NET__;
    if (!n || !n.rpc) return Promise.reject(new Error('offline'));
    if (RCV_OK[fn] && p && p.receipts_ok === undefined) p = Object.assign({}, p, { receipts_ok: true });
    var stale = n.session && n.session.access_token;
    return n.rpc(fn, p).then(function (r) {
      if (!r || r.http !== 401 || !window.SPWork || !SPWork.renewSession) return r;
      return SPWork.renewSession(stale).then(function () { return n.rpc(fn, p); }, function () {
        if (window.__SP_SIGNIN__) window.__SP_SIGNIN__('Your sign-in has expired. Please sign in again.');
        throw new Error('signed out');
      });
    });
  }
  function pend() { try { return JSON.parse(localStorage.getItem(PEND)) || {}; } catch (e) { return {}; } }
  function savePend(m) { try { localStorage.setItem(PEND, JSON.stringify(m)); } catch (e) {} }
  function drop(op) { var m = pend(); delete m[op]; savePend(m); }
  // Saved on the phone BEFORE sending; removed only once the database has answered.
  function send(fn, p, meta) {
    var m = pend(); m[p.op_id] = { fn: fn, p: p, meta: meta || {}, at: Date.now() }; savePend(m);
    return rpc(fn, p).then(function (r) {
      if (!r || (r.http && r.http >= 500)) return { unconfirmed: true };
      drop(p.op_id); return r;
    }, function () { return { unconfirmed: true }; });
  }
  var resolving = null;
  var rcvDone = {};                     // op -> { meta, r }: how a receipt left the pending list
  function isRcvOp(e) { return !!(e && e.meta && e.meta.kind === 'receipt'); }
  function resolvePending() {
    if (resolving) return resolving;
    var m = pend(), ids = Object.keys(m);
    if (!ids.length) return Promise.resolve(0);
    resolving = ids.reduce(function (chain, op) {
      return chain.then(function () {
        return rpc('staff_d3_op_status', { op_id: op }).then(function (st) {
          if (st && st.ok && st.found) { if (isRcvOp(m[op])) rcvDone[op] = { meta: m[op].meta, r: st.result }; drop(op); return; }
          if (st && st.ok && !st.found) {                   // never reached the database: the same request again is safe
            return rpc(m[op].fn, m[op].p).then(function (r) {
              if (r && !(r.http && r.http >= 500)) { if (isRcvOp(m[op])) rcvDone[op] = { meta: m[op].meta, r: r }; drop(op); }
            }, function () {});
          }
        }, function () {});
      });
    }, Promise.resolve()).then(function () { resolving = null; rcvSync(); return Object.keys(pend()).length; });
    return resolving;
  }
  function pendingFor(staffUuid) {
    var m = pend(); return Object.keys(m).some(function (k) { return m[k].meta && m[k].meta.staff === staffUuid; });
  }
  function phonePending() { var s = window.__SP_STORE__; return s && s.pendingPayments ? s.pendingPayments() : 0; }
  function withPhonePending(r) {
    var n = phonePending();
    if (!r || !r.ok || !n) return r;
    var message = 'This phone has ' + n + ' payment change(s) not yet uploaded. Balances wait until they reach the cloud.';
    return Object.assign({}, r, { phone_pending: n, withheld: (r.withheld || []).concat(message) });
  }
  function refreshAll() {
    cache = {};
    var s = window.__SP_STORE__;
    return (s ? s.pull() : Promise.resolve()).then(function () { if (typeof renderAll === 'function') renderAll(); });
  }

  /* ---- which records belong to the weekly hisab --------------------------- */
  function workshopWithHisab() { return (typeof empList === 'function' ? empList() : []).filter(function (e) { return e.group === 'workshop'; }); }
  function isSettlementPayment(p) { return /^stl_/.test(String(p && p.id)); }
  function isReceipt(p) { return !!p && (/^rcv_/.test(String(p.id)) || Number(p.amount) < 0); }
  // Same rule the database enforces (staffpay_d3.protected); a payment whose worker is
  // unknown is protected whenever it could fall inside any workshop worker's period.
  function isProtected(p) {
    if (!p) return false;
    if (isSettlementPayment(p) || /^rcv_/.test(String(p.id))) return true;
    var day = istDay(p.date), emp = p.staffId != null ? empOf(String(p.staffId)) : null;
    if (emp) return emp.group === 'workshop' && !!emp.obDate && day > emp.obDate;
    if (p.staffId != null) return false;
    return workshopWithHisab().some(function (e) { return e.obDate && day > e.obDate; });
  }

  function report(emp, to, from) {
    // always fresh from the database; the copy kept is only for the WhatsApp text of what is on screen
    var k = emp.uuid + '|' + to + '|' + (from || '');
    return rpc('staff_workshop_report', { staff_id: emp.uuid, to: to, from: from || null }).then(function (r) {
      if (r && r.ok) cache[k] = r;
      return withPhonePending(r);
    });
  }

  /* ---- the report card ------------------------------------------------------- */
  function weekOf(r, monday) { return (r.weeks || []).filter(function (w) { return w.monday === monday; })[0] || null; }
  // a week's money given out and money returned, each counted once (the
  // database's gross figures; a database without them has no receipts)
  function given(w) { return (w.advances || []).filter(function (a) { return num(a.amount) >= 0; }); }
  function returned(w) { return (w.advances || []).filter(function (a) { return num(a.amount) < 0; }); }
  function gross(w) {
    return { out: w.advances_out_total != null ? num(w.advances_out_total) : num(w.advances_total),
             rcv: w.receipts_total != null ? num(w.receipts_total) : 0 };
  }
  function line(label, value, cls) { return '<div class="kv' + (cls ? ' ' + cls : '') + '"><span>' + label + '</span><b>' + value + '</b></div>'; }
  function cardHtml(emp, r, monday) {
    r = withPhonePending(r);
    var sun = addDays(monday, 6), out = '';
    out += '<div class="d3-head"><b>' + h(emp.label) + '</b> · Workshop · Week ' + dShort(monday) + ' – ' + dLong(sun) + '</div>';
    if (!r || !r.ok) return out + '<div class="wk-err">Hisab unavailable — could not confirm all records' + (r && r.error ? ' (' + h(plain(r)) + ')' : '') + '.</div>';
    if (r.phone_pending) return out + '<div class="wk-err">Balance withheld: ' + h(r.withheld[r.withheld.length - 1]) + '</div>';
    if (!r.old_hisab) return out + '<div class="wk-err">Old Hisab not entered — weekly hisab has not started for this worker.</div>';
    var w = weekOf(r, monday), ob = r.old_hisab, held = (r.withheld || []).length > 0;
    if (!w) {
      if (sun <= ob.date) return out + '<div class="wk-hint">This week is before the Old Hisab date (' + dLong(ob.date) + ') — it is history and not part of StaffPay\'s hisab.</div>';
      return out + '<div class="wk-hint">No StaffPay days in this week yet.</div>';
    }
    var days = num(w.days_worked);
    out += line('Attendance', 'Present ' + w.present + ' · Half Day ' + w.half + ' · Absent ' + w.absent);
    if (w.missing && w.missing.length) out += line('Not marked', w.missing.map(dShort).join(', '), 'warn');
    if (w.from !== monday) out += line('StaffPay from', dShort(w.from) + ' (after Old Hisab)');
    out += line('Days worked', w.present + ' + ' + w.half + '×½ = ' + days);
    out += line('Daily rate', rs(w.rate) + (w.rate_frozen ? ' (fixed when the week was settled)' : ''));
    out += line('Weekly earnings', days + ' × ' + rs(w.rate) + ' = ' + rs(w.earned));
    out += line('Opening balance (Old Hisab, end of ' + dLong(ob.date) + ')', words(ob.amount));
    out += line('Previous balance', words(w.previous));
    var adv = given(w), back = returned(w), g = gross(w);
    out += '<div class="kv"><span>Advances this week</span><b>' + (adv.length ? '' : 'none') + '</b></div>';
    adv.forEach(function (a) { out += '<div class="kv sub"><span>' + dShort(a.day) + (a.note ? ' · ' + h(a.note) : '') + '</span><span>' + rs(a.amount) + '</span></div>'; });
    out += line('Total advances', rs(g.out));
    if (back.length) {
      out += '<div class="kv"><span>↩ Wapas mila (worker ne paisa diya)</span><b></b></div>';
      back.forEach(function (a) { out += '<div class="kv sub"><span>' + dShort(a.day) + (a.note ? ' · ' + h(a.note) : '') + '</span><span>' + rs(-num(a.amount)) + '</span></div>'; });
      out += line('Total wapas mila', rs(g.rcv));
    }
    // Every balance carries its date: a past week's figures are history, not
    // what is owed today. A settlement closes the week's hisab; it is not proof
    // that everything owed was paid - any balance carries to the next week.
    var s = w.settlement, before = num(w.previous) + num(w.earned) - num(w.advances_total);
    if (held) {
      out += '<div class="wk-err">Balance withheld: ' + (r.withheld || []).map(h).join('; ') + '</div>';
    } else {
      out += line('Balance before settlement cash', rs(w.previous) + ' + ' + rs(w.earned) + ' − ' + rs(g.out) + (g.rcv ? ' + ' + rs(g.rcv) + ' wapas' : '') + ' = ' + words(before));
    }
    if (s && s.state === 'settled') {
      out += line('Cash given at settlement (' + dShort(sun) + ')', num(s.cash) > 0 ? rs(w.settlement_cash) : '₹0 — no cash given at settlement');
      out += line('Status', 'Settled — hisab closed for this week; any balance carries to the next week');
    } else if (s && s.state === 'corrected') {
      out += line('Weekly settlement', 'corrected as a mistaken entry' + (s.detail && s.detail.correct_reason ? ' (' + h(s.detail.correct_reason) + ')' : '') + ' — not settled now', 'warn');
    } else {
      out += line('Weekly settlement', 'not settled yet');
    }
    (w.added_after_settlement || []).forEach(function (a) {
      out += num(a.amount) < 0 ? line('Wapas mila added after settlement', dShort(a.day) + ' · ' + rs(-num(a.amount)), 'warn')
                               : line('Advance added after settlement', dShort(a.day) + ' · ' + rs(a.amount), 'warn');
    });
    (w.attendance_changed_after_settlement || []).forEach(function (a) { out += line('Attendance changed after settlement', dShort(a.day) + ': ' + (a.was || 'not marked') + ' → ' + (a.now || 'not marked'), 'warn'); });
    if (!held) out += line(w.to < sun ? 'Balance so far (to ' + dShort(w.to) + ')' : 'Balance at end of ' + dShort(sun), words(w.closing), 'total');
    if (r.today_unmarked && w.to === addDays(r.today, -1)) out += '<div class="wk-hint">Today is not marked yet, so today is not counted.</div>';
    return out;
  }

  /* ---- Weekly Hisab screen ------------------------------------------------- */
  function selectedMonday() { return typeof weekStart === 'function' ? dayKey(weekStart(hisabWeek)) : mondayOf(istToday()); }
  var renderGen = 0;                     // id of the latest Weekly Hisab render
  function current(gen, monday) { return gen === renderGen && selectedMonday() === monday; }
  function renderHisab() {
    var el = $('hisabList'); if (!el) return;
    var gen = ++renderGen, monday = selectedMonday(), sun = addDays(monday, 6);
    pdRows = {};                         // no save target until this week's figures arrive
    var lbl = $('hisabWeekLabel'); if (lbl) lbl.textContent = weekLabel(hisabWeek);
    var staff = workshopWithHisab().filter(function (e) { return e.active; });
    if (!staff.length) { el.innerHTML = '<div class="empty"><div class="empty-icon">🔧</div><p>No active Workshop staff yet.</p></div>'; return; }
    el.innerHTML = staff.map(function (e) { return '<div class="hisab-row d3-card" id="d3h_' + h(e.legacy) + '"><div class="wk-empty">Loading ' + h(e.label) + '…</div></div>'; }).join('');
    var totals = { given: 0, earned: 0, net: 0, held: 0 }, got = [];
    if ($('d3Payday')) $('d3Payday').innerHTML = '<div class="wk-empty">Loading…</div>';
    resolvePending().then(function () {
      return Promise.all(staff.map(function (e, i) {
        // a reply for a week no longer on screen is dropped: cards, totals and
        // Payday rows only ever show the week in the heading
        return report(e, sun).then(function (r) { if (!current(gen, monday)) return; got[i] = r; fillCard(e, r, monday); sum(r); },
                                   function () { if (!current(gen, monday)) return; got[i] = null; fillCard(e, null, monday); totals.held++; });
      }));
    }).then(function () {
      if (!current(gen, monday)) return;
      renderPayday(staff, got, monday, gen);
      var waiting = phonePending() > 0;
      if ($('hisabGiven')) $('hisabGiven').textContent = waiting ? 'unavailable' : rs(totals.given);
      if ($('hisabEarned')) $('hisabEarned').textContent = waiting ? 'unavailable' : rs(totals.earned);
      if ($('hisabAdvOut')) $('hisabAdvOut').textContent = totals.held ? 'unavailable' : rs(totals.net);
    });
    function sum(r) {
      var w = r && r.ok && r.old_hisab ? weekOf(r, monday) : null;
      if (!w || (r.withheld || []).length) { totals.held++; return; }
      totals.given += num(w.settlement_cash); totals.earned += num(w.earned); totals.net += num(w.closing);
    }
  }

  /* ---- Payday table (owner's Sunday workflow) -----------------------------
   * One row per active workshop worker, from the same reports as the cards.
   * KITNA KAATNA is only a helper for choosing the cash: it is never saved and
   * never subtracted again. Each row saves through the existing settlement
   * operation (one payment = the actual cash), after the owner confirms the
   * cash was handed over. Typed figures are drafts until the database answers.
   *   previous P (+ shop owes, - worker owes), earnings E, given this week A,
   *   returned by the worker this week R (rc15; it reduces the old advance)
   *   Pr = P + R; available = E - A; old advance = max(0, -Pr); shop owed = max(0, Pr)
   *   cash from deduction D:  max(0, max(0,Pr) + available - D)
   *   deduction from cash C:  min(old advance, max(0, available - C))
   *   final = P + E - A + R - C   (the database's closing after the save)     */
  var drafts = {};                       // uuid|monday -> { mode, c, d, touched, base, old, state, msg }
  var pdNote = {};                       // uuid|monday -> a one-time explanation shown on the row
  var pdRows = {};                       // legacy -> { emp, r, w, monday, sun }
  function money(v) { var t = String(v == null ? '' : v).trim(); return /^\d+(\.\d{1,2})?$/.test(t) ? Number(t) : null; }
  function ownWords(v) { v = num(v); return v > 0 ? rs(v) + ' dukaan par baaki' : v < 0 ? rs(-v) + ' aap par baaki' : '₹0 barabar'; }
  // the figures the database checks: the five of rc13/rc14 plus given and
  // returned separately (an equal extra advance and receipt leave the net alone)
  function seenOf(w) {
    var g = gross(w);
    return { days: num(w.days_worked), rate: num(w.rate), earned: num(w.earned), previous: num(w.previous), advances: num(w.advances_total),
             advances_out: g.out, received: g.rcv };
  }
  function figs(b) {
    var pr = b.previous + b.received, avail = b.earned - b.advances_out, oldAdv = Math.max(0, -pr), owed = Math.max(0, pr);
    return { avail: avail, oldAdv: oldAdv, owed: owed, maxD: Math.min(oldAdv, Math.max(0, avail)) };
  }
  function cashFor(b, d) { var f = figs(b); return Math.max(0, f.owed + f.avail - d); }
  function dedFor(b, c) { var f = figs(b); return f.oldAdv > 0 ? Math.min(f.oldAdv, Math.max(0, f.avail - c)) : 0; }
  // What a draft was based on: the five figures the database checks ("seen")
  // plus the week's settlement version, cash and state. Any difference after a
  // refresh puts the draft under review; a refresh never silently replaces it.
  function snap(w) {
    var o = seenOf(w), s = w.settlement;
    o.ver = s ? s.version : null; o.cash = num(w.settlement_cash); o.state = s ? s.state : null;
    return o;
  }
  function seenPart(b) { return { days: b.days, rate: b.rate, earned: b.earned, previous: b.previous, advances: b.advances, advances_out: b.advances_out, received: b.received }; }
  function sameSeen(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  function draftFor(emp, w, monday) {
    var k = emp.uuid + '|' + monday, cur = snap(w), d = drafts[k];
    if (!d || (!d.touched && d.state !== 'saving')) {                 // untouched defaults follow the server
      d = drafts[k] = { mode: 'settle', c: String(cashFor(cur, 0)), d: '0', touched: false, base: cur, state: d ? d.state : null, msg: d ? d.msg : '' };
    }
    d.review = d.touched && !sameSeen(d.base, cur) ? cur : null;     // owner must look before saving
    return d;
  }
  function canSaveRow(row, d) {
    if (!d || d.review || d.state === 'saving' || pendingFor(row.emp.uuid) || draftError(d, d.base)) return false;
    if (d.mode === 'edit') return money(d.c) !== d.old;               // an edit must change the cash
    return !settleBlock(row.r, row.w, row.monday, row.sun) && row.w.to >= row.sun;
  }
  function renderPayday(staff, got, monday, gen) {
    var el = $('d3Payday'); if (!el) return;
    var sun = addDays(monday, 6);
    pdRows = {};
    var rows = staff.map(function (e, i) { return pdRow(e, withPhonePending(got[i]), monday, sun, gen); }).join('');
    el.innerHTML = '<div class="pd-head" id="pdWeek" data-monday="' + monday + '">Hafta ' + h(weekRange(monday)) + ' · Payday <b>Ravivar ' + h(dPlain(sun, true)) + '</b></div><div class="pd-wrap"><table class="pd"><thead><tr><th class="pd-name">Staff</th><th>HAAZRI</th><th>IS HAFTE KI KAMAI</th>' +
      '<th>PURANA HISAB</th><th>KITNA KAATNA</th><th>CASH DIYA</th><th>FINAL HISAB</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<div class="wk-hint">Har worker alag save hota hai — sirf tab jab cash sach mein haath mein de diya ho. Typed amount sirf draft hai, payment nahi.</div>';
  }
  function pdRow(emp, r, monday, sun, gen) {
    var L = h(emp.legacy), name = '<b>' + h(emp.label) + '</b>';
    var reason = null, w = null;
    if (!r || !r.ok) reason = 'Hisab unavailable — could not confirm all records' + (r && r.error ? ' (' + plain(r) + ')' : '') + '.';
    else if (r.phone_pending) reason = 'Balance withheld: ' + r.withheld[r.withheld.length - 1];
    else if (!r.old_hisab) reason = 'Old Hisab not entered — weekly hisab has not started for this worker.';
    else if (!(w = weekOf(r, monday))) reason = sun <= r.old_hisab.date ? 'This week is before the Old Hisab date.' : 'No StaffPay days in this week yet.';
    else if ((r.withheld || []).length) reason = 'Balance withheld: ' + r.withheld.join('; ');
    if (reason) return '<tr id="pd_' + L + '"><td class="pd-name">' + name + '<div class="pd-why">' + h(reason) + '</div></td><td colspan="6"></td></tr>';
    pdRows[emp.legacy] = { emp: emp, r: r, w: w, monday: monday, sun: sun, gen: gen };
    var b = seenOf(w), f = figs(b), s = w.settlement;
    var haazri = '<td>' + dayCount(w.days_worked) + ' din</td>';
    var gv = given(w).filter(function (a) { return num(a.amount) > 0; }), bk = returned(w), dates = function (l) { return l.map(function (a) { return dPlain(a.day); }).join(', '); };
    var kamai = '<td><b>' + rs(w.earned) + '</b><div class="pd-sub">' + dayCount(w.days_worked) + ' × ' + rs(w.rate) + '</div>' +
      (b.advances_out ? '<div class="pd-sub pd-paid">pehle diye ' + rs(b.advances_out) + ' (' + dates(gv) + ')</div>' : '') +
      (b.received ? '<div class="pd-sub pd-back">wapas mila ' + rs(b.received) + ' (' + dates(bk) + ')</div>' : '') + '</td>';
    var purana = '<td>' + ownWords(w.previous) + '</td>';
    var k = emp.uuid + '|' + monday, ex = drafts[k], note = pdNote[k] ? '<div class="pd-st pd-bad">' + h(pdNote[k]) + '</div>' : '';
    delete pdNote[k];
    if (s && s.state === 'settled') {
      if (ex && ex.mode !== 'edit' && ex.state !== 'saving') {          // a payday draft for a week another phone already saved
        if (ex.touched) note += '<div class="pd-st pd-bad">Doosre phone ne ye hafta save kar diya — aapka draft hata diya.</div>';
        delete drafts[k]; ex = null;
      }
      if (!ex) {                                                        // actual: what the database recorded
        var c = num(w.settlement_cash);
        return '<tr id="pd_' + L + '" class="pd-done"><td class="pd-name">' + name + '<div class="pd-ok">✓ Diya · ' + dShort(sun) + '</div>' + note +
          '<button class="wk-btn pd-edit" id="pde_' + L + '"' + (pendingFor(emp.uuid) ? ' disabled' : '') + ' onclick="SPD3.pdEdit(\'' + js(emp.legacy) + '\')">Badlo</button></td>' +
          haazri + kamai + purana + '<td>' + rs(dedFor(b, c)) + '</td><td><b>' + rs(c) + '</b></td><td class="pd-final"><b>' + ownWords(w.closing) + '</b></td></tr>';
      }
    } else if (ex && ex.mode === 'edit') {                              // the saved entry was corrected elsewhere: stop editing
      delete drafts[k];
      note += '<div class="pd-st pd-bad">Badlav band: ye entry doosre phone par badal di gayi. Naya hisab dekhein.</div>';
    }
    var d = draftFor(emp, w, monday), base = d.base, edit = d.mode === 'edit';
    var block = edit ? null : settleBlock(r, w, monday, sun) || (w.to < sun ? dShort(sun) + ' ki hazri abhi nahi lagi — settlement uske baad.' : null);
    var status = note + (edit ? '<div class="pd-st pd-wait">Badal rahe hain · pehle ' + rs(d.old) + '</div>' : '');
    if (pendingFor(emp.uuid)) status = '<div class="pd-st pd-wait">Save not confirmed — checking…</div>';
    else if (d.state === 'saving') status = '<div class="pd-st pd-wait">Saving…</div>';
    else if (d.state === 'refused') status = '<div class="pd-st pd-bad">Not saved: ' + h(d.msg) + '</div>';
    if (d.review) status += '<div class="pd-st pd-bad">' + (edit && d.review.ver !== d.base.ver ? 'Doosre phone ne ye entry badli' : 'Figures badle (naya data)') +
      ' — ab: cash ' + rs(d.review.cash) + '. Dekh kar <button class="wk-btn" id="pdr_' + L + '" onclick="SPD3.pdAccept(\'' + js(emp.legacy) + '\')">Theek hai</button></div>';
    else if (block) status += '<div class="pd-st">' + h(block) + '</div>';
    pdRows[emp.legacy].k = k;
    var canSave = canSaveRow(pdRows[emp.legacy], d);
    var dedIn = '<input type="text" inputmode="numeric" class="pd-in" id="pdd_' + L + '" value="' + h(d.d) + '"' + (f.oldAdv > 0 ? '' : ' disabled') +
      ' oninput="SPD3.pdInput(\'' + js(emp.legacy) + '\',\'d\',this.value)"><div class="pd-sub" id="pddn_' + L + '">' + dedNote(d, base) + '</div>';
    var cashIn = '<input type="text" inputmode="numeric" class="pd-in pd-draft" id="pdc_' + L + '" value="' + h(d.c) + '"' +
      ' oninput="SPD3.pdInput(\'' + js(emp.legacy) + '\',\'c\',this.value)"><div class="pd-sub">draft</div>';
    return '<tr id="pd_' + L + '"' + (edit ? ' class="pd-editing"' : '') + '><td class="pd-name">' + name + status +
      '<button class="wk-btn go pd-save" id="pds_' + L + '"' + (canSave ? '' : ' disabled') + ' onclick="SPD3.pdAsk(\'' + js(emp.legacy) + '\')">' + (edit ? 'Sahi cash → Save' : 'Cash diya → Save') + '</button>' +
      (edit ? '<button class="wk-btn pd-edit" id="pdx_' + L + '" onclick="SPD3.pdCancel(\'' + js(emp.legacy) + '\')">Chhodo</button>' : '') + '</td>' +
      haazri + kamai + purana + '<td>' + dedIn + '</td><td>' + cashIn + '</td><td class="pd-final pd-prev" id="pdf_' + L + '">' + finalCell(base, d) + '</td></tr>' +
      '<tr class="pd-ask" id="pda_' + L + '" style="display:none"><td class="pd-name" colspan="7"></td></tr>';
  }
  // A draft can be confirmed only when both editable fields are valid amounts:
  // cash 0 or more; deduction 0 up to what may be recovered (max).
  function draftError(d, b) {
    var dv = money(d.d), f = figs(b);
    if (dv == null || dv > f.maxD) return 'KITNA KAATNA: sahi rakam likhein (0 se ' + rs(f.maxD) + ' tak)';
    if (money(d.c) == null) return 'CASH DIYA: sahi rakam likhein (0 ya zyada)';
    return null;
  }
  function dedNote(d, b) {
    var f = figs(b), dv = money(d.d);
    if (dv == null || dv > f.maxD) return '<span class="pd-bad">Sahi rakam likhein (0–' + rs(f.maxD) + ')</span>';
    return f.oldAdv > 0 ? 'max ' + rs(f.maxD) : 'advance nahi';
  }
  function finalCell(b, d) {
    var c = money(d.c);
    return c == null ? '<span class="pd-bad">Cash likhein (0 ya zyada)</span>' : '≈ ' + ownWords(b.previous + b.earned - b.advances - c) + '<div class="pd-sub">preview</div>';
  }
  function pdInput(legacy, field, value) {
    var row = pdRows[legacy]; if (!row) return;
    var d = draftFor(row.emp, row.w, row.monday), b = d.base, f = figs(b), L = legacy;
    d.touched = true; if (d.state === 'refused') { d.state = null; d.msg = ''; }
    if (field === 'd') {
      d.d = value; var dv = money(value);
      if (dv != null) {
        if (dv > f.maxD) { dv = f.maxD; d.d = String(dv); if ($('pdd_' + L)) $('pdd_' + L).value = d.d; }
        d.c = String(cashFor(b, dv)); if ($('pdc_' + L)) $('pdc_' + L).value = d.c;
      }
    } else {
      d.c = value; var cv = money(value);
      if (cv != null) { d.d = String(dedFor(b, cv)); if ($('pdd_' + L)) $('pdd_' + L).value = d.d; }
    }
    if ($('pdf_' + L)) $('pdf_' + L).innerHTML = finalCell(b, d);
    if ($('pddn_' + L)) $('pddn_' + L).innerHTML = dedNote(d, b);
    var btn = $('pds_' + L); if (btn) btn.disabled = !canSaveRow(row, d);
    if ($('pda_' + L)) $('pda_' + L).style.display = 'none';
  }
  function pdAccept(legacy) {                         // owner has looked at the new server figures
    var row = pdRows[legacy]; if (!row) return;
    var d = draftFor(row.emp, row.w, row.monday), c = money(d.c);
    d.base = snap(row.w); d.review = null;
    if (d.mode === 'edit') d.old = d.base.cash;
    if (c != null) d.d = String(dedFor(d.base, c));
    renderHisab();
  }
  // Edit a saved week: the version, cash and figures are captured now and sent
  // with the change, so a change made meanwhile on another phone is refused.
  function pdEdit(legacy) {
    var row = pdRows[legacy]; if (!row) return;
    if (!current(row.gen, row.monday)) { showToast('Hafta badal gaya — dobara dekhein'); return; }
    var s = row.w.settlement; if (!s || s.state !== 'settled' || pendingFor(row.emp.uuid)) return;
    var b = snap(row.w), c = b.cash;
    drafts[row.emp.uuid + '|' + row.monday] = { mode: 'edit', c: String(c), d: String(dedFor(b, c)), touched: true, base: b, old: c, state: null, msg: '' };
    renderHisab();
  }
  function pdCancel(legacy) {
    var row = pdRows[legacy]; if (!row) return;
    var k = row.emp.uuid + '|' + row.monday;
    if (drafts[k] && drafts[k].state !== 'saving') delete drafts[k];
    renderHisab();
  }
  function pdAsk(legacy) {
    var row = pdRows[legacy]; if (!row) return;
    var d = draftFor(row.emp, row.w, row.monday), c = money(d.c), L = h(legacy), lj = js(legacy);
    if (!current(row.gen, row.monday)) { showToast('Hafta badal gaya — dobara dekhein'); return; }
    var err = draftError(d, d.base);
    if (err) { showToast(err); return; }
    if (d.mode === 'edit' && c === d.old) { showToast('Cash pehle jaisa hi hai — kuch nahi badla'); return; }
    var fin = d.base.previous + d.base.earned - d.base.advances - c, day = 'Ravivar ' + dPlain(row.sun, true), ed = d.mode === 'edit';
    var cell = $('pda_' + legacy) && $('pda_' + legacy).firstChild; if (!cell) return;
    var tick1 = ed ? (c > 0 ? h(day) + ' ko asal mein ' + rs(c) + ' diya tha (pehle ' + rs(d.old) + ' likha tha)' : h(day) + ' ko asal mein koi cash nahi diya tha (pehle ' + rs(d.old) + ' likha tha)')
                   : (c > 0 ? rs(c) + ' cash ' + h(day) + ' ko haath mein de diya' : h(day) + ' ko koi cash nahi diya (₹0)');
    cell.innerHTML = '<div class="pd-confirm" data-monday="' + row.monday + '" data-action="' + (ed ? 'change' : 'settle') + '"><b>' + h(row.emp.label) + ' · ' + h(day) + ' · ' + rs(c) +
      (ed ? ' (pehle ' + rs(d.old) + ')' : '') + '</b> FINAL HISAB: ' + ownWords(fin) +
      '<label class="d3-tick"><input type="checkbox" id="pdk1_' + L + '"> ' + tick1 + '</label>' +
      '<label class="d3-tick"><input type="checkbox" id="pdk2_' + L + '"> Sunday\'s work is finished for ' + h(row.emp.name) + '</label>' +
      '<label class="d3-tick"><input type="checkbox" id="pdk3_' + L + '"> Every advance given this week, on every phone, is counted (pehle diye ' + rs(d.base.advances_out) +
        (d.base.received ? ', wapas mila ' + rs(d.base.received) : '') + ')</label>' +
      '<div class="wk-hint">Cash kisi aur din diya? Use "+ Add" se us din ki asli date par likhein — yahan nahi.' +
        (ed ? ' Agar ye poori entry hi galat thi, neeche card mein "Correct a mistaken entry" use karein.' : '') + '</div>' +
      '<button class="wk-btn go" id="pdok_' + L + '" onclick="SPD3.pdSave(\'' + lj + '\')">Confirm &amp; Save</button> ' +
      '<button class="wk-btn" onclick="document.getElementById(\'pda_' + lj + '\').style.display=\'none\'">Cancel</button></div>';
    $('pda_' + legacy).style.display = '';
    var wrap = $('pda_' + legacy).closest('.pd-wrap'); if (wrap) wrap.scrollLeft = 0;   // the confirmation reads from the left edge
  }
  function pdSave(legacy) {
    var row = pdRows[legacy]; if (!row) return;
    var emp = row.emp, d = draftFor(emp, row.w, row.monday), c = money(d.c);
    if (!current(row.gen, row.monday)) { showToast('Hafta badal gaya — dobara dekhein'); return; }
    var err = draftError(d, d.base);
    if (err) { showToast(err); return; }
    if (d.review || d.state === 'saving' || pendingFor(emp.uuid)) return;
    if (!($('pdk1_' + legacy) || {}).checked || !($('pdk2_' + legacy) || {}).checked || !($('pdk3_' + legacy) || {}).checked) { showToast('Teeno baatein tick karein'); return; }
    var n = phonePending();
    if (n) { d.state = 'refused'; d.msg = 'This phone has ' + n + ' payment change(s) not yet uploaded. Settlement waits until they reach the cloud.'; renderHisab(); return; }
    if (d.mode === 'edit' && c === d.old) return;
    var p = { op_id: uuid(), action: d.mode === 'edit' ? 'change' : 'settle', staff_id: emp.uuid, week: row.monday,
              expected_version: d.base.ver,                 // captured when the draft started; never refreshed silently
              cash: c, sunday_done: true, advances_complete: true, seen: seenPart(d.base) };
    d.state = 'saving'; d.msg = '';
    var btn = $('pdok_' + legacy); if (btn) btn.disabled = true;
    var sb = $('pds_' + legacy); if (sb) sb.disabled = true;
    showToast('Saving…');
    send('staff_settlement_apply', p, { staff: emp.uuid, week: row.monday }).then(function (res) {
      var k = emp.uuid + '|' + row.monday;
      if (res.unconfirmed) {
        // the reply was lost: check the database's operation log; only a change
        // that really happened ends the draft (refusals are never logged)
        d.state = null;
        return resolvePending().then(function () { return rpc('staff_d3_op_status', { op_id: p.op_id }); })
          .then(function (st) { if (st && st.ok && st.found && drafts[k] === d) delete drafts[k]; }, function () {})
          .then(refreshAll);
      }
      if (res.ok) { delete drafts[k]; showToast((p.action === 'change' ? 'Badla · ' : 'Saved · ') + emp.label + ' · ' + rs(c)); }
      else { d.state = 'refused'; d.msg = plain(res); }
      return refreshAll();
    });
  }
  function fillCard(emp, r, monday) {
    var el = $('d3h_' + emp.legacy); if (!el) return;
    var sun = addDays(monday, 6), html = cardHtml(emp, r, monday);
    html += oldHisabPanel(emp, r);
    html += actions(emp, r, monday, sun);
    if (notes[emp.legacy]) html += '<div class="wk-err" id="d3n_' + h(emp.legacy) + '">' + h(notes[emp.legacy]) + '</div>';
    el.innerHTML = html;
  }
  function oldHisabPanel(emp, r) {
    var L = h(emp.legacy), cur = r && r.old_hisab;
    var form = '<div class="d3-form" id="d3ob_' + L + '" style="display:' + (cur ? 'none' : 'block') + '">' +
      '<div class="wk-sub">' + (cur ? 'Change Old Hisab' : 'Enter Old Hisab (the starting balance)') + '</div>' +
      '<label class="d3-l">Amount ₹<input type="number" min="0" inputmode="numeric" id="d3oa_' + L + '" value="' + (cur ? Math.abs(num(cur.amount)) : '') + '"></label>' +
      '<label class="d3-l">Who owes<select id="d3od_' + L + '"><option value="1"' + (cur && num(cur.amount) > 0 ? ' selected' : '') + '>Shop owes worker</option>' +
      '<option value="-1"' + (cur && num(cur.amount) < 0 ? ' selected' : '') + '>Worker owes shop</option>' +
      '<option value="0"' + (cur && num(cur.amount) === 0 ? ' selected' : '') + '>Nothing owed (₹0)</option></select></label>' +
      '<label class="d3-l">Correct at the END of this day<input type="date" id="d3ot_' + L + '" max="' + istToday() + '" value="' + (cur ? cur.date : '') + '"></label>' +
      '<div class="wk-hint">Everything on or before this day is history. Only attendance and payments after it count in StaffPay.</div>' +
      '<button class="wk-btn go" onclick="SPD3.saveOldHisab(\'' + js(emp.legacy) + '\')">Save Old Hisab</button></div>';
    if (!r || !r.ok) return '';
    return (cur ? '<button class="wk-btn" style="margin-top:8px" onclick="SPD3.toggle(\'d3ob_' + js(emp.legacy) + '\')">Change Old Hisab</button>' : '') + form;
  }
  // Why this week cannot be settled now (null = it can). Shared by the card and
  // the Payday table; the database enforces the same rules.
  function settleBlock(r, w, monday, sun) {
    if (istToday() < sun) return 'Settlement opens on ' + dShort(sun) + ' after Sunday\'s work.';
    if ((r.withheld || []).length > 0) return 'Settlement waits until the balance can be confirmed.';
    // weeks are settled in order
    var gap = (r.weeks || []).filter(function (x) { return x.monday < monday && !x.settlement; })[0];
    if (gap) return 'Settle the week of ' + dShort(gap.monday) + ' first. Weeks are settled in order; ₹0 is fine if no cash was given that Sunday.';
    if (r.latest_settled_week && r.latest_settled_week > monday) {
      return 'The week of ' + dShort(r.latest_settled_week) + ' is already settled and carried this week\'s balance. Cash given on another day is recorded as a payment on that day.';
    }
    return null;
  }
  function actions(emp, r, monday, sun) {
    r = withPhonePending(r);
    if (!r || !r.ok || !r.old_hisab) return '';
    if (r.phone_pending) return '';
    var w = weekOf(r, monday); if (!w) return '';
    var L = h(emp.legacy), lj = js(emp.legacy), s = w.settlement, held = (r.withheld || []).length > 0;
    if (pendingFor(emp.uuid)) return '<div class="wk-err">Save not confirmed — checking… (other changes to this worker wait until it is confirmed)</div>';
    var today = istToday(), out = '';
    var ticks = '<label class="d3-tick"><input type="checkbox" id="d3s_' + L + '"> Sunday\'s work is finished for ' + h(emp.name) + '</label>' +
                '<label class="d3-tick"><input type="checkbox" id="d3a_' + L + '"> Every advance given this week, on every phone, is in the list above</label>';
    if (!s || s.state === 'corrected') {
      var block = settleBlock(r, w, monday, sun);
      if (block) return '<div class="wk-hint">' + h(block) + '</div>';
      var give = Math.max(0, num(w.previous) + num(w.earned) - num(w.advances_total));
      out += '<div class="d3-form"><label class="d3-l">Cash given on ' + dShort(sun) + ' ₹<input type="number" min="0" inputmode="numeric" id="d3c_' + L + '" value="' + give + '"></label>' +
             '<div class="wk-hint">Only cash actually given on ' + dShort(sun) + '. Cash given on another day: record it as a payment on that day.</div>' + ticks +
             '<button class="btn-hisab-settle" onclick="SPD3.settle(\'' + lj + '\',\'' + monday + '\',\'settle\')">' + (s ? 'Settle again' : 'Settle & Pay') + '</button></div>';
      return out;
    }
    return '<button class="wk-btn" onclick="SPD3.toggle(\'d3x_' + lj + '\')">Change amount</button> ' +
           '<button class="wk-btn warn" onclick="SPD3.toggle(\'d3y_' + lj + '\')">Correct a mistaken entry</button>' +
           '<div class="d3-form" id="d3x_' + L + '" style="display:none"><label class="d3-l">Correct cash given on ' + dShort(sun) + ' ₹<input type="number" min="0" id="d3c_' + L + '" value="' + num(s.cash) + '"></label>' + ticks +
           '<button class="wk-btn go" onclick="SPD3.settle(\'' + lj + '\',\'' + monday + '\',\'change\')">Save amount</button></div>' +
           '<div class="d3-form" id="d3y_' + L + '" style="display:none"><div class="wk-hint">Only if this settlement was entered by mistake and the cash was NOT given. The week\'s rate stays as it was.</div>' +
           '<label class="d3-tick"><input type="checkbox" id="d3g_' + L + '"> This cash was NOT given</label>' +
           '<label class="d3-l">Reason<input type="text" id="d3r_' + L + '" maxlength="200"></label>' +
           '<button class="wk-btn warn" onclick="SPD3.settle(\'' + lj + '\',\'' + monday + '\',\'correct\')">Correct entry</button></div>';
  }
  function toggle(id) { var el = $(id); if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none'; }
  function note(emp, msg) { notes[emp.legacy] = msg; }

  function settle(legacy, monday, action) {
    var emp = empOf(legacy); if (!emp || !emp.uuid) { showToast('Staff list still loading'); return; }
    var sun = addDays(monday, 6), r = cache[emp.uuid + '|' + sun + '|'], w = r && weekOf(r, monday);
    if (!w) { showToast('Refresh and try again'); return; }
    var L = emp.legacy, p = { op_id: uuid(), action: action, staff_id: emp.uuid, week: monday,
      expected_version: w.settlement ? w.settlement.version : null };
    notes[L] = '';
    if (action === 'correct') {
      p.cash_not_given = !!($('d3g_' + L) && $('d3g_' + L).checked);
      p.reason = ($('d3r_' + L) && $('d3r_' + L).value || '').trim();
      if (!p.cash_not_given || !p.reason) { showToast('Tick "cash was NOT given" and write a reason'); return; }
    } else {
      var n = phonePending();
      if (n) { note(emp, 'This phone has ' + n + ' payment change(s) not yet uploaded. Settlement waits until they reach the cloud.'); fillCard(emp, r, monday); return; }
      p.cash = Number(($('d3c_' + L) || {}).value);
      p.sunday_done = !!($('d3s_' + L) && $('d3s_' + L).checked);
      p.advances_complete = !!($('d3a_' + L) && $('d3a_' + L).checked);
      if (!(p.cash >= 0)) { showToast('Enter the cash given (0 or more)'); return; }
      if (!p.sunday_done || !p.advances_complete) { showToast('Tick both confirmations first'); return; }
      p.seen = seenOf(w);
    }
    var el = $('d3h_' + L); if (el) el.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
    showToast('Saving…');
    send('staff_settlement_apply', p, { staff: emp.uuid, week: monday }).then(function (res) {
      if (res.unconfirmed) { note(emp, 'Save not confirmed — checking…'); return resolvePending().then(refreshAll); }
      if (res.ok) {
        notes[L] = '';
        showToast(action === 'correct' ? 'Entry corrected' : action === 'change' ? 'Amount changed' : 'Settled · ' + rs(p.cash));
      } else note(emp, plain(res));
      return refreshAll();
    });
  }

  function saveOldHisab(legacy) {
    var emp = empOf(legacy); if (!emp || !emp.uuid) return;
    var L = emp.legacy, amt = Number(($('d3oa_' + L) || {}).value), dir = Number(($('d3od_' + L) || {}).value), dt = ($('d3ot_' + L) || {}).value;
    if (!dt || !(amt >= 0)) { showToast('Enter the amount and the day'); return; }
    if (dir === 0) amt = 0;
    if (dir !== 0 && amt === 0) { showToast('Choose "Nothing owed" for ₹0'); return; }
    var r = cache[Object.keys(cache).filter(function (k) { return k.indexOf(emp.uuid + '|') === 0; })[0]];
    var tv = r && r.worker && r.worker.terms_version != null ? r.worker.terms_version : (emp.termsVersion || 0);
    var p = { op_id: uuid(), staff_id: emp.uuid, expected_terms_version: tv, set: { opening_balance: amt * (dir || 1), opening_balance_date: dt } };
    var go = function () {
      send('staff_workshop_terms_set', p, { staff: emp.uuid }).then(function (res) {
        if (res.unconfirmed) { note(emp, 'Save not confirmed — checking…'); return resolvePending().then(refreshAll); }
        if (res.ok) { notes[L] = ''; showToast('Old Hisab saved'); } else note(emp, plain(res));
        return refreshAll();
      });
    };
    var cur = r && r.old_hisab;
    if (cur && cur.date !== dt) {
      rpc('staff_workshop_terms_set', Object.assign({}, p, { op_id: uuid(), preview: true })).then(function (pv) {
        if (!pv || !pv.ok) { note(emp, plain(pv)); refreshAll(); return; }
        var days = pv.moved_days || {}, pays = pv.moved_payments || {};
        var msg = (pv.direction === 'out_of_staffpay' ? 'This REMOVES from StaffPay (' + pv.from + ' to ' + pv.to + '):' : 'This ADDS to StaffPay (' + pv.from + ' to ' + pv.to + '):') +
          '\n• attendance: ' + (days.present || 0) + ' present, ' + (days.half || 0) + ' half days\n• payments: ' + (pays.count || 0) + ' totalling ' + rs(pays.total || 0) +
          (pv.direction === 'out_of_staffpay' ? '\nThe new Old Hisab amount must already include them.' : '') + '\nContinue?';
        showConfirm(msg, go, null, 'Yes, change');
      }, function () { showToast('No connection — not saved'); });
    } else go();
  }

  function setRate(emp, rate) {
    var r = cache[Object.keys(cache).filter(function (k) { return k.indexOf(emp.uuid + '|') === 0; })[0]];
    var p = { op_id: uuid(), staff_id: emp.uuid, expected_terms_version: r && r.worker && r.worker.terms_version != null ? r.worker.terms_version : (emp.termsVersion || 0), set: { salary: rate } };
    return send('staff_workshop_terms_set', p, { staff: emp.uuid }).then(function (res) {
      if (res.unconfirmed) { showToast('Save not confirmed — checking…'); return resolvePending().then(refreshAll); }
      if (res.ok) showToast('Rate saved'); else showToast(plain(res));
      return refreshAll().then(function () { return res; });
    });
  }

  /* ---- Details, WhatsApp, Payroll ---------------------------------------- */
  /* ---- worker summary: Staff Details and WhatsApp Hisab (owner-approved v1) --
   * Five lines from the same database report the owner's card uses; nothing is
   * recalculated except the sum of this week's payments (advances + settlement
   * cash, each counted once). The last line is the report's own closing
   * balance at the actual cutoff: previous + earnings - payments. When any
   * figure is unknown, the existing warning is shown and no amount at all. */
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function dPlain(dk, year) { var p = dk.split('-'); return Number(p[2]) + ' ' + MON[Number(p[1]) - 1] + (year ? ' ' + p[0] : ''); }
  function weekRange(monday) {
    var sun = addDays(monday, 6), sameMonth = monday.slice(0, 7) === sun.slice(0, 7);
    return (sameMonth ? String(Number(monday.slice(8))) : dPlain(monday, monday.slice(0, 4) !== sun.slice(0, 4))) + '–' + dPlain(sun, true);
  }
  function dayCount(v) {
    v = num(v); var whole = Math.floor(v), half = v - whole >= 0.5;
    return half ? (whole ? whole + '½' : '½') : String(whole);
  }
  function summary(emp, r, monday) {
    r = withPhonePending(r);
    var out = { name: emp.label, week: weekRange(monday), cutoff: null, from: null, rows: null, notes: [], err: false };
    if (!r || !r.ok) { out.err = true; out.notes.push('Hisab unavailable — could not confirm all records' + (r && r.error ? ' (' + plain(r) + ')' : '') + '.'); return out; }
    if (r.phone_pending) { out.err = true; out.notes.push('Balance withheld: ' + r.withheld[r.withheld.length - 1]); return out; }
    if (!r.old_hisab) { out.err = true; out.notes.push('Old Hisab not entered — weekly hisab has not started for this worker.'); return out; }
    var w = weekOf(r, monday);
    if (!w) {
      out.notes.push(addDays(monday, 6) <= r.old_hisab.date
        ? 'This week is before the Old Hisab date (' + dPlain(r.old_hisab.date, true) + ') — it is history and not part of StaffPay\'s hisab.'
        : 'No StaffPay days in this week yet.');
      return out;
    }
    out.cutoff = w.to;
    if (w.from !== monday) out.from = w.from;
    if ((r.withheld || []).length) { out.err = true; out.notes.push('Balance withheld: ' + r.withheld.join('; ')); return out; }
    // payments taken = money given this week + settlement cash; money the worker
    // returned is its own line (only when there is some), never netted in
    var g = gross(w), paid = g.out + num(w.settlement_cash), close = num(w.closing);
    out.rows = [
      ['HAAZRI', dayCount(w.days_worked) + ' din'],
      ['IS HAFTE PAYMENT LIYE', rs(paid)]
    ].concat(g.rcv ? [['IS HAFTE WAPAS DIYE', rs(g.rcv)]] : []).concat([
      ['IS HAFTE KA HISAB', dayCount(w.days_worked) + ' × ' + rs(w.rate) + ' = ' + rs(w.earned)],
      ['PICHLA ADVANCE', rs(w.previous)],
      ['AAJ TAK KA HISAB', close > 0 ? rs(close) + ' — dukaan par baaki' : close < 0 ? rs(-close) + ' — aap par baaki' : '₹0 — hisab barabar']
    ]);
    if (r.today_unmarked && w.to === addDays(r.today, -1)) out.notes.push('Today is not marked yet, so today is not counted.');
    return out;
  }
  function summaryHtml(emp, r, monday) {
    var s = summary(emp, r, monday), html = '<div class="d3-head"><b>' + h(s.name) + '</b>' + (s.cutoff ? ' · Hisab ' + h(dPlain(s.cutoff, true)) + ' tak' : '') + '</div>';
    html += '<div class="wk-hint">Hafta: ' + h(s.week) + (s.from ? ' · hisab ' + h(dPlain(s.from)) + ' se (pehle ka Old Hisab mein)' : '') + '</div>';
    (s.rows || []).forEach(function (x, i) { html += line(x[0], h(x[1]), i === s.rows.length - 1 ? 'total' : ''); });
    s.notes.forEach(function (n) { html += '<div class="' + (s.err ? 'wk-err' : 'wk-hint') + '">' + h(n) + '</div>'; });
    return html;
  }
  function fillDetail(emp, monday) {
    var el = $('d3Detail'); if (!el) return;
    if (!emp.uuid) { el.innerHTML = '<div class="wk-empty">Loading…</div>'; return; }
    el.innerHTML = '<div class="wk-empty">Loading hisab…</div>';
    report(emp, addDays(monday, 6)).then(function (r) {
      if ($('d3Detail')) $('d3Detail').innerHTML = '<div class="card wk-detail d3-card">' + summaryHtml(emp, r, monday) + '</div>';
    }, function () { if ($('d3Detail')) $('d3Detail').innerHTML = '<div class="card wk-detail d3-card">' + summaryHtml(emp, null, monday) + '</div>'; });
  }
  function whatsappText(emp, monday) {
    var r = cache[emp.uuid + '|' + addDays(monday, 6) + '|'];
    if (!r) return '';
    var s = summary(emp, r, monday), bar = '━━━━━━━━━━━━━━━━';
    var t = '🏪 *Mittal Hardware — Staff Hisab*\n*' + s.name + '*' + (s.cutoff ? ' · Hisab ' + dPlain(s.cutoff, true) + ' tak' : '') + '\n';
    t += 'Hafta: ' + s.week + (s.from ? ' (hisab ' + dPlain(s.from) + ' se)' : '') + '\n' + bar + '\n';
    (s.rows || []).forEach(function (x, i) { t += (i === s.rows.length - 1 ? '*' + x[0] + ': ' + x[1] + '*' : x[0] + ': ' + x[1]) + '\n'; });
    s.notes.forEach(function (n) { t += (s.rows ? '\n' : '') + n + '\n'; });
    t += '\n_StaffPay se bheja gaya · ' + dPlain(istToday(), true) + '_';
    return t;
  }
  function payrollRow(emp, mk) {
    var el = $('d3p_' + emp.legacy); if (!el) return Promise.resolve(null);
    var badge = $('d3pb_' + emp.legacy); if (badge) badge.textContent = 'unavailable';
    if (!emp.obDate) { el.innerHTML = '<div class="wk-hint">Old Hisab not entered — weekly hisab has not started.</div>'; return Promise.resolve(null); }
    var from = mk + '-01', to = monthEnd(mk);
    if (from > istToday()) { el.innerHTML = '<div class="wk-hint">Future month.</div>'; return Promise.resolve(null); }
    return report(emp, to, from).then(function (r) {
      var e2 = $('d3p_' + emp.legacy); if (!e2) return null;
      if (!r || !r.ok) { e2.innerHTML = '<div class="wk-err">Hisab unavailable — could not confirm all records.</div>'; return null; }
      if ((r.withheld || []).length) { e2.innerHTML = '<div class="wk-err">Balance withheld: ' + r.withheld.map(h).join('; ') + '</div>'; return null; }
      var per = r.period || {}, back = num(r.period_received || 0);
      e2.innerHTML = '<div class="payroll-grid">' +
        '<div class="payroll-box"><div class="payroll-num">' + rs(per.brought_forward) + '</div><div class="payroll-label">Brought fwd</div></div>' +
        '<div class="payroll-box"><div class="payroll-num">' + rs(per.earned) + '</div><div class="payroll-label">Earned</div></div>' +
        '<div class="payroll-box"><div class="payroll-num">' + rs(per.paid) + '</div><div class="payroll-label">' + (back ? 'Net paid' : 'Paid') + '</div></div></div>' +
        (back ? '<div class="staff-master-sub" id="d3pr_' + h(emp.legacy) + '" style="margin-top:6px">Diya ' + rs(num(per.paid) + back) + ' · ↩ Wapas mila ' + rs(back) + ' · Net ' + rs(per.paid) + '</div>' : '') +
        '<div class="staff-master-sub" style="margin-top:6px">Hisab balance till ' + dLong(r.cutoff) + ': <b>' + h(words(r.balance)) + '</b></div>';
      var b = $('d3pb_' + emp.legacy); if (b) b.textContent = rs(r.balance);
      return num(r.balance);
    }, function () { var e2 = $('d3p_' + emp.legacy); if (e2) e2.innerHTML = '<div class="wk-err">Hisab unavailable — no connection.</div>'; return null; });
  }

  /* ---- History / Summary completeness ------------------------------------ */
  function workshopTotals(from, to) { return rpc('staff_workshop_payments', { from: from, to: to }); }
  function localWorkshopCount(list) {
    return list.filter(function (p) { var e = p.staffId != null ? empOf(String(p.staffId)) : null; return e && e.group === 'workshop'; }).length;
  }
  function historyCheck(mk, list) {
    var el = $('historyD3'); if (!el) return;
    el.innerHTML = '';
    workshopTotals(mk + '-01', monthEnd(mk)).then(function (r) {
      if (!r || !r.ok) { el.innerHTML = '<div class="wk-err">Workshop payments: could not confirm the complete list.</div>'; return; }
      var local = localWorkshopCount(list), unk = num(r.unknown_worker_count);
      var msg = '';
      if (num(r.count) !== local) msg += 'Partial list: showing ' + local + ' of ' + r.count + ' workshop payments for this month (database total ' + rs(r.total) + '). ';
      if (unk) msg += unk + ' payment(s) this month have no recorded worker. ';
      if (msg) el.innerHTML = '<div class="wk-err">' + h(msg) + '</div>';
      if (num(r.received)) el.innerHTML += '<div class="wk-hint" id="historySplit">Workshop is mahine: Diya ' + rs(r.given) + ' · ↩ Wapas mila ' + rs(r.received) + ' · Net ' + rs(r.total) + '</div>';
    }, function () { el.innerHTML = '<div class="wk-err">Workshop payments: could not confirm the complete list (offline).</div>'; });
  }
  var summaryRequest = 0;
  function summaryTotals(from, to, list, query) {
    var el = $('summaryD3'); if (!el) return;
    var request = ++summaryRequest, q = (query || '').toLowerCase();
    function current() { return request === summaryRequest && summaryGroup === 'workshop' && $('searchBar').value.toLowerCase() === q; }
    el.innerHTML = '<div class="wk-hint">Checking workshop totals…</div>';
    $('bannerTotal').textContent = '…';
    $('bannerCount').textContent = '…';
    $('staffList').innerHTML = '<div class="wk-empty">Loading workshop payments…</div>';
    workshopTotals(from, to).then(function (r) {
      if (!current()) return;
      if (!r || !r.ok) throw new Error('x');
      var workers = r.workers || [], names = {};
      workers.forEach(function (w) { var k = w.name.toLowerCase(); names[k] = (names[k] || 0) + 1; });
      var rows = workers.map(function (w) {
        var emp = empOf(String(w.legacy_id));
        var label = w.name + ((names[w.name.toLowerCase()] > 1 || (emp && emp.dup)) ? ' · ' + String(w.staff_id).slice(0, 8) : '');
        return { name: label, total: num(w.total), count: num(w.count),
                 split: num(w.received) ? 'Diya ' + rs(w.given) + ' · ↩ Wapas mila ' + rs(w.received) + ' · Net' : '',
                 entries: list.filter(function (p) { return p.staffId != null && String(p.staffId) === String(w.legacy_id); }) };
      }).filter(function (s) { return !q || s.name.toLowerCase().includes(q); });
      rows.sort(function (a, b) { return b.total - a.total; });
      var total = rows.reduce(function (sum, s) { return sum + s.total; }, 0);
      var count = rows.reduce(function (sum, s) { return sum + s.count; }, 0);
      var local = rows.reduce(function (sum, s) { return sum + s.entries.length; }, 0);
      $('bannerTotal').textContent = rs(total);
      $('bannerCount').textContent = rows.length;
      if (typeof setPaidBanner === 'function') setPaidBanner(num(r.received) > 0);
      $('staffList').innerHTML = rows.length ? rows.map(summaryCard).join('') : '<div class="empty"><p>No workshop payments match this view.</p></div>';
      el.innerHTML = count !== local
        ? '<div class="wk-err">Totals are from the database (' + count + ' payments). Partial list: showing ' + local + ' of ' + count + '.</div>'
        : '<div class="wk-hint">Totals checked against the database (' + count + ' payments).</div>';
      if (num(r.received)) el.innerHTML += '<div class="wk-hint" id="summarySplit">Diya ' + rs(r.given) + ' · ↩ Wapas mila ' + rs(r.received) + ' · Net ' + rs(r.total) + ' (database, poora workshop)</div>';
      if (num(r.unknown_worker_count)) el.innerHTML += '<div class="wk-err">' + num(r.unknown_worker_count) + ' payment(s) in this period have no recorded worker and are not included in workshop totals.</div>';
    }).catch(function () {
      if (!current()) return;
      $('bannerTotal').textContent = 'unavailable'; $('bannerCount').textContent = '…';
      $('staffList').innerHTML = '';
      el.innerHTML = '<div class="wk-err">Totals unavailable — could not confirm with the database.</div>';
    });
  }

  /* ---- controlled payment correction ------------------------------------- */
  var corr = null;
  function ensureModal() {
    if ($('d3CorrModal')) return;
    var d = document.createElement('div');
    d.innerHTML = '<div class="modal-ov" id="d3CorrOv" onclick="SPD3.closeCorrect()"></div>' +
      '<div class="edit-modal" id="d3CorrModal"><div class="em-title">Correct this payment</div><div class="em-name" id="d3CorrName"></div>' +
      '<div class="wk-hint" id="d3CorrInfo"></div>' +
      '<div class="field"><label>What is wrong?</label><select id="d3CorrAct" onchange="SPD3.corrMode()" class="search-bar" style="margin-bottom:0">' +
      '<option value="change">Amount or date is wrong</option><option value="remove">Entered by mistake — money was NOT given</option>' +
      '<option value="assign">Choose the worker (payment has none)</option></select></div>' +
      '<div class="field" id="d3CorrAmtF"><label>Correct amount (₹)</label><input type="number" id="d3CorrAmt" inputmode="numeric"></div>' +
      '<div class="field" id="d3CorrDayF"><label>Correct date</label><input type="date" id="d3CorrDay"></div>' +
      '<div class="field" id="d3CorrWhoF"><label>Worker</label><select id="d3CorrWho" class="search-bar" style="margin-bottom:0"></select></div>' +
      '<label class="d3-tick" id="d3CorrNotF"><input type="checkbox" id="d3CorrNot"> The money was NOT given</label>' +
      '<div class="field"><label>Reason (required)</label><input type="text" id="d3CorrWhy" maxlength="200"></div>' +
      '<div class="wk-err" id="d3CorrErr"></div>' +
      '<div class="em-btns"><button class="cm-btn cm-no" type="button" onclick="SPD3.closeCorrect()">Cancel</button>' +
      '<button class="cm-btn em-save" type="button" id="d3CorrGo" onclick="SPD3.submitCorrect()">Save correction</button></div></div>';
    while (d.firstChild) document.body.appendChild(d.firstChild);
  }
  function openCorrect(id) {
    var p = load().filter(function (x) { return String(x.id) === String(id); })[0];
    if (!p) { showToast('Payment not found'); return; }
    if (isSettlementPayment(p)) { openHisabFor(p); return; }
    ensureModal();
    var emp = p.staffId != null ? empOf(String(p.staffId)) : null;
    var rcv = isReceipt(p);
    corr = { p: p, emp: emp, day: istDay(p.date), rcv: rcv };
    // a receipt keeps its direction: the amount is typed as a plain figure and
    // the database stores it as money returned
    $('d3CorrAct').innerHTML = rcv
      ? '<option value="change">Amount or date is wrong</option><option value="remove">Ye receipt galti se likhi gayi — paisa wapas mila hi nahi</option>'
      : '<option value="change">Amount or date is wrong</option><option value="remove">Entered by mistake — money was NOT given</option>' +
        '<option value="assign">Choose the worker (payment has none)</option>';
    $('d3CorrModal').querySelector('.em-title').textContent = rcv ? 'Correct this receipt (wapas mila)' : 'Correct this payment';
    $('d3CorrNotF').lastChild.textContent = rcv ? ' Paisa wapas mila hi nahi' : ' The money was NOT given';
    $('d3CorrAmtF').firstChild.textContent = rcv ? 'Sahi wapas mila amount (₹)' : 'Correct amount (₹)';
    $('d3CorrName').textContent = (emp ? emp.label : p.name + ' (no recorded worker)') + ' · ' + (rcv ? '↩ Wapas mila ' + rs(-num(p.amount)) : rs(p.amount)) + ' · ' + dLong(corr.day);
    $('d3CorrInfo').textContent = rcv ? 'Worker ne ye paisa wapas diya tha. Ye sirf yahan, reason ke saath, badla ya hataaya ja sakta hai.'
                                      : 'This payment is part of the workshop weekly hisab, so it can only be changed here, with a reason.';
    $('d3CorrAct').value = emp || rcv ? 'change' : 'assign';
    $('d3CorrAmt').value = Math.abs(num(p.amount)); $('d3CorrDay').value = corr.day; $('d3CorrDay').max = istToday();
    $('d3CorrWho').innerHTML = workshopWithHisab().map(function (e) { return '<option value="' + h(e.uuid) + '">' + h(e.label) + '</option>'; }).join('');
    $('d3CorrNot').checked = false; $('d3CorrWhy').value = ''; $('d3CorrErr').textContent = '';
    corrMode();
    $('d3CorrOv').classList.add('show'); $('d3CorrModal').classList.add('show');
  }
  function corrMode() {
    var a = $('d3CorrAct').value;
    $('d3CorrAmtF').style.display = a === 'change' ? '' : 'none'; $('d3CorrDayF').style.display = a === 'change' ? '' : 'none';
    $('d3CorrWhoF').style.display = a === 'assign' ? '' : 'none'; $('d3CorrNotF').style.display = a === 'remove' ? '' : 'none';
  }
  function closeCorrect() { corr = null; if ($('d3CorrModal')) { $('d3CorrOv').classList.remove('show'); $('d3CorrModal').classList.remove('show'); } }
  function submitCorrect() {
    if (!corr) return;
    var a = $('d3CorrAct').value, why = $('d3CorrWhy').value.trim();
    if (!why) { $('d3CorrErr').textContent = 'A reason is required.'; return; }
    var p = { op_id: uuid(), payment_id: String(corr.p.id), action: a, reason: why,
              expected: { amount: Number(corr.p.amount), day: corr.day, staff_id: corr.emp ? corr.emp.uuid : null } };
    if (a === 'change') p['new'] = { amount: corr.rcv ? rcvAmount($('d3CorrAmt').value) : Number($('d3CorrAmt').value), day: $('d3CorrDay').value };
    if (a === 'change' && corr.rcv && p['new'].amount == null) { $('d3CorrErr').textContent = RCV_AMT_MSG; return; }
    if (a === 'change' && !(p['new'].amount > 0)) { $('d3CorrErr').textContent = 'Amount 0 se zyada likhein.'; return; }
    if (a === 'remove') { p.cash_not_given = $('d3CorrNot').checked; if (!p.cash_not_given) { $('d3CorrErr').textContent = corr.rcv ? 'Tick "Paisa wapas mila hi nahi".' : 'Tick "The money was NOT given".'; return; } }
    if (a === 'assign') p['new'] = { staff_id: $('d3CorrWho').value };
    $('d3CorrGo').disabled = true;
    send('staff_payment_correct', p, { staff: p.expected.staff_id }).then(function (res) {
      $('d3CorrGo').disabled = false;
      if (res.unconfirmed) { $('d3CorrErr').textContent = 'Save not confirmed — checking…'; resolvePending().then(refreshAll); return; }
      if (!res.ok) { $('d3CorrErr').textContent = plain(res); return; }
      var wasRcv = corr && corr.rcv;
      closeCorrect(); showToast(wasRcv ? (a === 'remove' ? 'Receipt hataayi' : 'Receipt badli') : 'Correction saved'); refreshAll();
    });
  }
  function openHisabFor(p) {
    var emp = p && p.staffId != null ? empOf(String(p.staffId)) : null;
    if (p && p.date) hisabWeek = new Date(istDay(p.date) + 'T12:00:00');
    switchTab('hisab');
    if (emp) setTimeout(function () { var el = $('d3h_' + emp.legacy); if (el) el.scrollIntoView({ block: 'start' }); }, 400);
  }
  // Row buttons for a payment in Recent / History / Summary.
  function rowButtons(e, editCls, delCls) {
    if (isSettlementPayment(e)) return '<button class="btn-mini is-quiet" onclick="SPD3.openHisabFor(SPD3.findPay(\'' + js(e.id) + '\'))">Weekly Hisab</button>';
    if (isProtected(e)) return '<button class="' + editCls + '" onclick="SPD3.openCorrect(\'' + js(e.id) + '\')" aria-label="Correct">✏️</button>';
    return null;
  }
  function findPay(id) { return load().filter(function (x) { return String(x.id) === String(id); })[0] || null; }

  /* ---- "+ Add" → ↩ Wapas mila: money a workshop worker gives back -------------
   * The worker is chosen from a list by permanent id (never typed or matched by
   * name). Saved only through staff_receipt_add, with an operation id kept on
   * this phone until the database confirms, like every other hisab change.  */
  var rcvBusy = false;
  var rcvNotes = [];                    // outcomes shown on the form: { ok, text }
  // the database's receipt amount rule (staffpay_d3.receipt_amount_ok): digits
  // with at most two decimals, more than 0, below Rs 1 crore
  var RCV_AMT_MSG = 'Amount 0 se zyada, 2 decimal tak aur ₹1 crore se kam likhein.';
  function rcvAmount(v) { var a = money(v); return a != null && a > 0 && a < 10000000 ? a : null; }
  // Workshop workers with Old Hisab (weekly hisab) and active Shop staff (monthly
  // hisab), each chosen by permanent id
  function rcvWorkers() {
    return (typeof empList === 'function' ? empList() : []).filter(function (e) {
      return e.active && e.uuid && (e.group === 'shop' || (e.group === 'workshop' && e.obDate));
    });
  }
  function rcvHead(m) { return (m.label || 'Worker') + (m.group === 'shop' ? ' (Shop)' : '') + ' se ' + rs(m.amount) + ' wapas mila · ' + dPlain(m.day, true); }
  function monthName(mk) { var p = mk.split('-'); return MON[Number(p[1]) - 1] + ' ' + p[0]; }
  // Shop: the receipt's own month, from this phone's records, shown only when
  // the database confirms the same month figures and nothing waits to upload
  function shopMonth(emp, mk) {
    if (emp.held || phonePending() || typeof payrollFor !== 'function') return Promise.resolve(null);
    var loc = payrollFor(emp, mk);
    return rpc('staff_shop_month', { staff_id: emp.uuid, month: mk }).then(function (db) {
      if (!db || !db.ok) return null;
      // the database's current identity hold: held, or not reported, shows no figures
      if (!db.identity || db.identity.held !== false) return null;
      var dp = db.payments || {}, da = db.attendance || {}, dt = db.terms;
      var same = num(dp.count) === loc.count && num(dp.given) === loc.given && num(dp.received) === loc.returned
        && num(da.present) === loc.present && num(da.half) === loc.half && num(da.absent) === loc.absent
        && !!dt && num(dt.salary) === loc.salary && (dt.wage_type === 'daily' ? 'daily' : 'monthly') === loc.wageType;   // pay terms too: a stale rate on the phone is not confirmed
      return same ? loc : null;
    }, function () { return null; });
  }
  function shopWords(v, ml) {
    v = num(v);
    return (v > 0 ? rs(v) + ' dena baaki' : v < 0 ? rs(-v) + ' zyada diya' : '₹0 barabar') + ' (sirf ' + ml + ')';
  }
  function shopConfirm(head, emp, amt, day) {
    var mk = day.slice(0, 7), ml = monthName(mk);
    return shopMonth(emp, mk).then(function (m) {
      var msg = head + '\n\nShop · mahine ka hisab: ye wapasi ' + ml + ' ke hisab mein judegi.';
      if (!m) return msg + '\n\n⚠ ' + ml + ' ke records abhi poore confirm nahi ho sake, isliye hisab nahi dikha rahe. Staff, amount aur date jaanch kar hi likhein.';
      msg += '\n\n' + ml + ' (sirf is mahine ka, pichle mahine isme nahi):' +
        '\nKamai ' + rs(m.earned) + ' · Diya ' + rs(m.given) + ' · Wapas mila ' + rs(m.returned) + ' · Net paid ' + rs(m.paid) +
        '\nAbhi: ' + shopWords(m.balance, ml) +
        '\nIske baad: Wapas mila ' + rs(m.returned + amt) + ' · Net paid ' + rs(m.paid - amt) + ' · ' + shopWords(m.balance + amt, ml);
      if (amt > m.given) msg += '\n\n⚠ Ye wapasi ' + ml + ' mein diye gaye paise (' + rs(m.given) + ') se zyada hai. Pichle mahinon ka advance is mahine ke hisab mein nahi dikhta.';
      return msg;
    });
  }
  // receipts saved on this phone whose outcome the database has not confirmed
  // (kept in the phone's storage, so they survive closing the app)
  function rcvUnresolved() { var m = pend(); return Object.keys(m).filter(function (k) { return isRcvOp(m[k]); }).map(function (k) { return m[k].meta; }); }
  // the form still shows exactly this entry (same worker, amount, day and
  // note). A pending record without a note snapshot (saved by an earlier
  // build) never clears the form: anything typed is kept.
  function rcvFormIs(meta) {
    return !!$('rcvWho') && typeof meta.note === 'string' && $('rcvWho').value === meta.staff && money($('rcvAmt').value) === meta.amount
      && $('rcvDay').value === meta.day && $('rcvNote').value.trim() === meta.note;
  }
  function rcvClear() { $('rcvAmt').value = ''; $('rcvNote').value = ''; $('rcvWho').value = ''; $('rcvDay').value = istToday(); $('rcvErr').textContent = ''; }
  // Show what the database has decided about earlier receipts, and what is
  // still unknown. A confirmed entry clears the form only if the form still
  // holds that same entry; a refused one is never shown as saved.
  function rcvSync() {
    Object.keys(rcvDone).forEach(function (op) {
      var d = rcvDone[op]; delete rcvDone[op];
      if (d.r && d.r.ok) {
        rcvNotes.push({ ok: true, text: '✓ Saved: ' + rcvHead(d.meta) });
        if (rcvFormIs(d.meta)) rcvClear();
      } else {
        rcvNotes.push({ ok: false, text: 'Not saved: ' + rcvHead(d.meta) + ' — ' + plain(d.r) + '. Theek karke dobara likhein.' });
      }
    });
    rcvNotes = rcvNotes.slice(-3);
    var el = $('rcvMsg'); if (!el) return;
    var open = rcvUnresolved();
    el.innerHTML = rcvNotes.map(function (n) { return '<div class="' + (n.ok ? 'wk-hint' : 'wk-err') + '">' + h(n.text) + '</div>'; }).join('') +
      (open.length ? '<div class="wk-err">' + open.map(function (m) { return h(rcvHead(m)) + ': save confirm nahi hua — check kar rahe hain. Dobara mat likhein.'; }).join('<br>') +
        ' <button type="button" class="wk-btn" id="rcvCheck" onclick="SPD3.rcvRecheck()">Dobara check karein</button></div>' : '');
  }
  // reuses the existing recovery: the same operation id is checked and, only
  // if it never reached the database, sent again
  function rcvRecheck() {
    var b = $('rcvCheck'); if (b) b.disabled = true;
    return resolvePending().then(function (left) { rcvSync(); if (!left) return refreshAll(); });
  }
  function rcvToggle(on) {
    var f = $('rcvForm'), pf = $('payForm'), t = $('rcvToggle'); if (!f) return;
    if (on == null) on = f.style.display === 'none';
    f.style.display = on ? '' : 'none'; if (pf) pf.style.display = on ? 'none' : '';
    if (t) t.classList.toggle('on', on);
    if (!on) return;
    var cur = $('rcvWho').value;
    var opt = function (e) { return '<option value="' + h(e.uuid) + '"' + (e.uuid === cur ? ' selected' : '') + '>' + h(e.label) + '</option>'; };
    var ws = rcvWorkers().filter(function (e) { return e.group === 'workshop'; }), sh = rcvWorkers().filter(function (e) { return e.group === 'shop'; });
    $('rcvWho').innerHTML = '<option value="">— worker chunein —</option>' +
      (ws.length ? '<optgroup label="Workshop (hafte ka hisab)">' + ws.map(opt).join('') + '</optgroup>' : '') +
      (sh.length ? '<optgroup label="Shop (mahine ka hisab)">' + sh.map(opt).join('') + '</optgroup>' : '');
    if (!$('rcvDay').value) $('rcvDay').value = istToday();
    $('rcvDay').max = istToday();
    $('rcvErr').textContent = '';
    rcvSync();
    if (rcvUnresolved().length) rcvRecheck();          // e.g. after reopening the app
  }
  // a worker whose earlier hisab change is still unconfirmed cannot get another
  // receipt until the database's answer is known
  function rcvBlocked(emp) {
    if (!pendingFor(emp.uuid)) return false;
    $('rcvErr').textContent = emp.label + ' ki pichli entry abhi confirm nahi hui — check kar rahe hain. Dobara mat likhein.';
    rcvSync();
    return true;
  }
  function rcvAsk() {
    if (rcvBusy) return;
    var who = $('rcvWho').value, emp = rcvWorkers().filter(function (e) { return e.uuid === who; })[0];
    var amt = rcvAmount($('rcvAmt').value), day = $('rcvDay').value, note = $('rcvNote').value.trim(), err = $('rcvErr');
    err.textContent = '';
    if (!emp) { err.textContent = 'Worker chunein (list se).'; return; }
    if (rcvBlocked(emp)) return;
    if (amt == null) { err.textContent = RCV_AMT_MSG; return; }
    if (!day) { err.textContent = 'Date chunein.'; return; }
    if (day > istToday()) { err.textContent = 'Aage ki date nahi chalegi.'; return; }
    if (emp.group === 'workshop' && day <= emp.obDate) { err.textContent = 'Ye date Old Hisab (' + dPlain(emp.obDate, true) + ') se pehle ki hai — wo hisab Old Hisab mein hai.'; return; }
    var meta = { kind: 'receipt', staff: emp.uuid, label: emp.label, group: emp.group, amount: amt, day: day, note: note }, head = rcvHead(meta);
    rcvBusy = true; $('rcvGo').disabled = true;
    if (emp.group === 'shop') {
      shopConfirm(head, emp, amt, day).then(function (msg) {
        rcvBusy = false; $('rcvGo').disabled = false;
        showConfirm(msg, function () { rcvSave(emp, meta); }, null, 'Haan, wapas mila');
      });
      return;
    }
    report(emp, istToday()).then(function (r) { return r; }, function () { return null; }).then(function (r) {
      rcvBusy = false; $('rcvGo').disabled = false;
      var msg = head;
      if (!r || !r.ok || (r.withheld || []).length || !r.old_hisab) {
        msg += '\n\n⚠ Abhi ka baaki hisab confirm nahi ho saka. Sirf tab likhein jab paisa sach mein wapas mila ho.';
      } else {
        var bal = num(r.balance), owes = Math.max(0, -bal), after = bal + amt;
        msg += '\n\nAbhi (' + dPlain(r.cutoff, true) + ' tak): ' + ownWords(bal) + '.\nIske baad: ' + ownWords(after) + '.';
        if (owes === 0) msg += '\n\n⚠ ' + emp.label + ' par koi advance baaki nahi tha. Phir bhi wapas mila likhna hai?';
        else if (amt > owes) msg += '\n\n⚠ Ye baaki (' + rs(owes) + ') se ' + rs(amt - owes) + ' zyada hai — iske baad dukaan ko ' + rs(after) + ' dene honge.';
      }
      showConfirm(msg, function () { rcvSave(emp, meta); }, null, 'Haan, wapas mila');
    });
  }
  function rcvSave(emp, meta) {
    if (rcvBusy || rcvBlocked(emp)) return;
    rcvBusy = true; $('rcvGo').disabled = true;
    var p = { op_id: uuid(), staff_id: emp.uuid, amount: meta.amount, day: meta.day, note: meta.note || null };   // the note as submitted
    showToast('Saving…');
    send('staff_receipt_add', p, meta).then(function (res) {
      rcvBusy = false; if ($('rcvGo')) $('rcvGo').disabled = false;
      if (res.unconfirmed) { rcvSync(); return rcvRecheck(); }          // stays recorded on the phone until the database answers
      if (!res.ok) { $('rcvErr').textContent = 'Not saved: ' + plain(res); return; }   // a definite refusal: correct and try again
      rcvDone[p.op_id] = { meta: meta, r: res }; rcvSync();
      showToast(rcvHead(meta) + ' — saved');
      return refreshAll();
    });
  }

  /* ---------- one worker, one record (A1) ---------------------------------
   * The database creates staff (staff_employee_create) and decides nothing by
   * name: a matching name returns the existing records and the owner says
   * Same (nothing is created) or Different (created only once every current
   * match has been shown). A record that arrived from an older or offline
   * page with a matching name is "unresolved" until the owner decides here. */
  var addOps = {};                      // request key -> op_id, so a retry after a lost reply replays
  var lostAdd = null;                   // an add whose reply never came: resent as-is before anything new
  function matchLine(m) {
    var e = (typeof empList === 'function' ? empList() : []).filter(function (x) { return x.uuid === m.id; })[0];
    return (e ? e.label : m.name + ' · ' + String(m.id).slice(0, 8)) + ' (' + (m.group === 'workshop' ? 'Workshop' : 'Shop') + ', '
      + (Number(m.salary) ? '₹' + Number(m.salary).toLocaleString('en-IN') + (m.wage_type === 'daily' ? '/din' : '/mahina') : 'rate nahi') + ', '
      + dLong(String(m.created_at || '').slice(0, 10) || istToday()) + ' se)';
  }
  function afterStaffChange(msg) {
    var s = window.__SP_STORE__;
    return (s ? s.pull() : Promise.resolve()).then(function () { if (typeof renderAll === 'function') renderAll(); if (msg) showToast(msg); });
  }
  function addStaff(o, done, decision, seen) {
    if (lostAdd && !decision && typeof nameKey === 'function' && nameKey(lostAdd.o.name) === nameKey(o.name)) {
      var la = lostAdd;
      return rpc('staff_employee_create', la.p).then(function (r) {
        lostAdd = null;
        if (r && r.ok) { if (done) done(); return afterStaffChange(r.replayed ? o.name + ' pichli baar hi jud gaya tha — dobara nahi joda' : o.name + ' added'); }
        return addStaff(o, done);
      }, function () { showToast('Naya staff jodne ke liye internet chahiye — dobara try karein'); });
    }
    var key = JSON.stringify([o.name, o.salary, o.wageType, o.group, decision || '', seen || []]);
    var op = addOps[key] || (addOps[key] = uuid());
    var legacy = addOps[key + '#id'] || (addOps[key + '#id'] = newStaffId());
    var p = { op_id: op, legacy_id: legacy, name: o.name, group: o.group, wage_type: o.wageType, salary: o.salary };
    if (decision) { p.decision = decision; p.seen = seen; }
    return rpc('staff_employee_create', p).then(function (r) {
      if (r && r.ok) { delete addOps[key]; delete addOps[key + '#id']; if (done) done();
        return afterStaffChange(o.name + (r.distinct ? ' (alag insaan) jod diya' : ' added')); }
      if (r && r.error === 'name exists') {
        delete addOps[key]; delete addOps[key + '#id'];
        var ms = r.matches || [], ids = ms.map(function (m) { return m.id; });
        showConfirm('"' + o.name + '" naam pehle se hai:\n' + ms.map(matchLine).join('\n') + '\n\nKya ye wahi insaan hai?', function () {
          // Same: nothing is created; load the existing worker from the server so a
          // waiting payment for them can be recorded right away
          var st = window.__SP_STORE__;
          (st ? st.pull() : Promise.resolve(false)).then(function (ok) {
            if (!ok) { showToast('Naya record nahi banaya. ' + o.name + ' pehle se hai, par list load nahi hui (internet?) — dobara Add dabayein; aapki payment entry ruki hui hai'); return; }
            if (done) done();
            if (typeof renderAll === 'function') renderAll();
            showToast('Naya record nahi banaya — ' + o.name + ' pehle se hai, list mein aa gaya. Ab payment record kar sakte hain');
          });
        }, function () {
          showConfirm('Kya "' + o.name + '" bilkul alag insaan hai? Ek naya record banega aur code se pehchana jayega.', function () {
            addStaff(o, done, 'different', ids);
          }, null, 'Haan, alag insaan');
        }, 'Haan, wahi hai');
        return;
      }
      showToast((r && (r.message || r.error)) || 'Staff save nahi hua');
    }, function () { lostAdd = { o: o, p: p }; showToast('Naya staff jodne ke liye internet chahiye — dobara try karein'); });
  }
  function identityGroups() {
    var list = typeof empList === 'function' ? empList() : [];
    return list.filter(function (e) { return e.identity === 'unresolved' || e.identity === 'same'; })
               .map(function (e) { return { emp: e, others: e.sameName || [] }; })
               .filter(function (g) { return g.others.length; });
  }
  function renderIdentity() {
    var box = $('identityBox'); if (!box) return;
    var gs = identityGroups();
    if (!gs.length) { box.innerHTML = ''; return; }
    box.innerHTML = gs.map(function (g) {
      var e = g.emp, L = js(e.legacy);
      var head = '⚠ "' + h(e.name) + '" naam ke ' + (g.others.length + 1) + ' record: ' + [e].concat(g.others).map(function (x) { return h(x.label); }).join(', ');
      if (e.identity === 'same') return '<div class="wk-err idn-row" id="idn_' + h(e.legacy) + '">' + head + '<br>Aapne bataya: ek hi insaan. Purana hisab milana baaki hai — tab tak in sab ka hisab roka hua hai.</div>';
      return '<div class="wk-err idn-row" id="idn_' + h(e.legacy) + '">' + head + '<br>' + h(e.label) + ' kisi purane/offline phone se aaya hai. Tay hone tak in sab ka hisab roka hua hai (hazri aur payment dikhte rahenge).'
        + '<div style="margin-top:6px"><button class="btn-mini idn-diff" onclick="SPD3.decideIdentity(\'' + L + '\',\'different\')">Alag log hain</button> '
        + '<button class="btn-mini idn-same" onclick="SPD3.decideIdentity(\'' + L + '\',\'same\')">Ek hi insaan</button></div></div>';
    }).join('');
  }
  function decideIdentity(legacy, decision) {
    var g = identityGroups().filter(function (x) { return x.emp.legacy === legacy; })[0];
    if (!g || !g.emp.uuid) return;
    var seen = g.others.map(function (x) { return x.uuid; }).filter(Boolean);
    var msg = decision === 'different'
      ? 'Pakka? ' + g.emp.label + ' aur ' + g.others.map(function (x) { return x.label; }).join(', ') + ' alag-alag log hain. Har ek ka hisab alag chalega.'
      : 'Pakka? ' + g.emp.label + ' aur ' + g.others.map(function (x) { return x.label; }).join(', ') + ' ek hi insaan hain. Hisab tab tak roka rahega jab tak purana hisab milaya na jaye.';
    showConfirm(msg, function () {
      rpc('staff_identity_decide', { op_id: uuid(), staff_id: g.emp.uuid, decision: decision, seen: seen }).then(function (r) {
        if (r && r.ok) return afterStaffChange(decision === 'different' ? 'Tay hua: alag log. Hisab ab alag-alag chalega.' : 'Tay hua: ek hi insaan. Hisab roka hua hai.');
        if (r && r.error === 'matches changed') return afterStaffChange('Is naam ka ek aur record aa gaya — dobara dekh kar tay karein');
        return afterStaffChange((r && (r.message || r.error)) || 'Save nahi hua');
      }, function () { showToast('Internet nahi — tay nahi hua, dobara try karein'); });
    }, null, decision === 'different' ? 'Haan, alag log' : 'Haan, ek hi insaan');
  }

  // Re-check unconfirmed operations whenever the app comes back.
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && Object.keys(pend()).length) resolvePending().then(refreshAll); });

  return { addStaff: addStaff, renderIdentity: renderIdentity, decideIdentity: decideIdentity,
           rcvToggle: rcvToggle, rcvAsk: rcvAsk, rcvRecheck: rcvRecheck, isReceipt: isReceipt,
           renderHisab: renderHisab, settle: settle, pdInput: pdInput, pdAsk: pdAsk, pdSave: pdSave, pdAccept: pdAccept, pdEdit: pdEdit, pdCancel: pdCancel, toggle: toggle, saveOldHisab: saveOldHisab, setRate: setRate,
           fillDetail: fillDetail, whatsappText: whatsappText, payrollRow: payrollRow, report: report,
           historyCheck: historyCheck, summaryTotals: summaryTotals, isProtected: isProtected, isSettlementPayment: isSettlementPayment,
           openCorrect: openCorrect, closeCorrect: closeCorrect, submitCorrect: submitCorrect, corrMode: corrMode,
           openHisabFor: openHisabFor, rowButtons: rowButtons, findPay: findPay, resolvePending: resolvePending,
           pending: pend, istDay: istDay, istToday: istToday, mondayOf: mondayOf, addDays: addDays, clearCache: function () { cache = {}; } };
})();
