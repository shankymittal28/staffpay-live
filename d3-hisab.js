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
  function rpc(fn, p) {
    var n = window.__SP_NET__;
    if (!n || !n.rpc) return Promise.reject(new Error('offline'));
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
  function resolvePending() {
    if (resolving) return resolving;
    var m = pend(), ids = Object.keys(m);
    if (!ids.length) return Promise.resolve(0);
    resolving = ids.reduce(function (chain, op) {
      return chain.then(function () {
        return rpc('staff_d3_op_status', { op_id: op }).then(function (st) {
          if (st && st.ok && st.found) { drop(op); return; }
          if (st && st.ok && !st.found) {                   // never reached the database: the same request again is safe
            return rpc(m[op].fn, m[op].p).then(function (r) { if (r && !(r.http && r.http >= 500)) drop(op); }, function () {});
          }
        }, function () {});
      });
    }, Promise.resolve()).then(function () { resolving = null; return Object.keys(pend()).length; });
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
  // Same rule the database enforces (staffpay_d3.protected); a payment whose worker is
  // unknown is protected whenever it could fall inside any workshop worker's period.
  function isProtected(p) {
    if (!p) return false;
    if (isSettlementPayment(p)) return true;
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
    var adv = w.advances || [];
    out += '<div class="kv"><span>Advances this week</span><b>' + (adv.length ? '' : 'none') + '</b></div>';
    adv.forEach(function (a) { out += '<div class="kv sub"><span>' + dShort(a.day) + (a.note ? ' · ' + h(a.note) : '') + '</span><span>' + rs(a.amount) + '</span></div>'; });
    out += line('Total advances', rs(w.advances_total));
    // Every balance carries its date: a past week's figures are history, not
    // what is owed today. A settlement closes the week's hisab; it is not proof
    // that everything owed was paid - any balance carries to the next week.
    var s = w.settlement, before = num(w.previous) + num(w.earned) - num(w.advances_total);
    if (held) {
      out += '<div class="wk-err">Balance withheld: ' + (r.withheld || []).map(h).join('; ') + '</div>';
    } else {
      out += line('Balance before settlement cash', rs(w.previous) + ' + ' + rs(w.earned) + ' − ' + rs(w.advances_total) + ' = ' + words(before));
    }
    if (s && s.state === 'settled') {
      out += line('Cash given at settlement (' + dShort(sun) + ')', num(s.cash) > 0 ? rs(w.settlement_cash) : '₹0 — no cash given at settlement');
      out += line('Status', 'Settled — hisab closed for this week; any balance carries to the next week');
    } else if (s && s.state === 'corrected') {
      out += line('Weekly settlement', 'corrected as a mistaken entry' + (s.detail && s.detail.correct_reason ? ' (' + h(s.detail.correct_reason) + ')' : '') + ' — not settled now', 'warn');
    } else {
      out += line('Weekly settlement', 'not settled yet');
    }
    (w.added_after_settlement || []).forEach(function (a) { out += line('Advance added after settlement', dShort(a.day) + ' · ' + rs(a.amount), 'warn'); });
    (w.attendance_changed_after_settlement || []).forEach(function (a) { out += line('Attendance changed after settlement', dShort(a.day) + ': ' + (a.was || 'not marked') + ' → ' + (a.now || 'not marked'), 'warn'); });
    if (!held) out += line(w.to < sun ? 'Balance so far (to ' + dShort(w.to) + ')' : 'Balance at end of ' + dShort(sun), words(w.closing), 'total');
    if (r.today_unmarked && w.to === addDays(r.today, -1)) out += '<div class="wk-hint">Today is not marked yet, so today is not counted.</div>';
    return out;
  }

  /* ---- Weekly Hisab screen ------------------------------------------------- */
  function selectedMonday() { return typeof weekStart === 'function' ? dayKey(weekStart(hisabWeek)) : mondayOf(istToday()); }
  function renderHisab() {
    var el = $('hisabList'); if (!el) return;
    var monday = selectedMonday(), sun = addDays(monday, 6);
    var lbl = $('hisabWeekLabel'); if (lbl) lbl.textContent = weekLabel(hisabWeek);
    var staff = workshopWithHisab().filter(function (e) { return e.active; });
    if (!staff.length) { el.innerHTML = '<div class="empty"><div class="empty-icon">🔧</div><p>No active Workshop staff yet.</p></div>'; return; }
    el.innerHTML = staff.map(function (e) { return '<div class="hisab-row d3-card" id="d3h_' + h(e.legacy) + '"><div class="wk-empty">Loading ' + h(e.label) + '…</div></div>'; }).join('');
    var totals = { given: 0, earned: 0, net: 0, held: 0 };
    resolvePending().then(function () {
      return Promise.all(staff.map(function (e) {
        return report(e, sun).then(function (r) { fillCard(e, r, monday); sum(r); }, function () { fillCard(e, null, monday); totals.held++; });
      }));
    }).then(function () {
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
      if (today < sun) return '<div class="wk-hint">Settlement opens on ' + dShort(sun) + ' after Sunday\'s work.</div>';
      if (held) return '<div class="wk-hint">Settlement waits until the balance can be confirmed.</div>';
      // weeks are settled in order (the database enforces the same two rules)
      var gap = (r.weeks || []).filter(function (x) { return x.monday < monday && !x.settlement; })[0];
      if (gap) return '<div class="wk-hint">Settle the week of ' + dShort(gap.monday) + ' first. Weeks are settled in order; ₹0 is fine if no cash was given that Sunday.</div>';
      if (r.latest_settled_week && r.latest_settled_week > monday) {
        return '<div class="wk-hint">The week of ' + dShort(r.latest_settled_week) + ' is already settled and carried this week\'s balance. Cash given on another day is recorded as a payment on that day.</div>';
      }
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
      p.seen = { days: num(w.days_worked), rate: num(w.rate), earned: num(w.earned), previous: num(w.previous), advances: num(w.advances_total) };
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
    var paid = num(w.advances_total) + num(w.settlement_cash), close = num(w.closing);
    out.rows = [
      ['HAAZRI', dayCount(w.days_worked) + ' din'],
      ['IS HAFTE PAYMENT LIYE', rs(paid)],
      ['IS HAFTE KA HISAB', dayCount(w.days_worked) + ' × ' + rs(w.rate) + ' = ' + rs(w.earned)],
      ['PICHLA ADVANCE', rs(w.previous)],
      ['AAJ TAK KA HISAB', close > 0 ? rs(close) + ' — dukaan par baaki' : close < 0 ? rs(-close) + ' — aap par baaki' : '₹0 — hisab barabar']
    ];
    if (r.today_unmarked && w.to === addDays(r.today, -1)) out.notes.push('Today is not marked yet, so today is not counted.');
    return out;
  }
  function summaryHtml(emp, r, monday) {
    var s = summary(emp, r, monday), html = '<div class="d3-head"><b>' + h(s.name) + '</b>' + (s.cutoff ? ' · Hisab ' + h(dPlain(s.cutoff, true)) + ' tak' : '') + '</div>';
    html += '<div class="wk-hint">Hafta: ' + h(s.week) + (s.from ? ' · hisab ' + h(dPlain(s.from)) + ' se (pehle ka Old Hisab mein)' : '') + '</div>';
    (s.rows || []).forEach(function (x, i) { html += line(x[0], h(x[1]), i === 4 ? 'total' : ''); });
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
    (s.rows || []).forEach(function (x, i) { t += (i === 4 ? '*' + x[0] + ': ' + x[1] + '*' : x[0] + ': ' + x[1]) + '\n'; });
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
      var per = r.period || {};
      e2.innerHTML = '<div class="payroll-grid">' +
        '<div class="payroll-box"><div class="payroll-num">' + rs(per.brought_forward) + '</div><div class="payroll-label">Brought fwd</div></div>' +
        '<div class="payroll-box"><div class="payroll-num">' + rs(per.earned) + '</div><div class="payroll-label">Earned</div></div>' +
        '<div class="payroll-box"><div class="payroll-num">' + rs(per.paid) + '</div><div class="payroll-label">Paid</div></div></div>' +
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
                 entries: list.filter(function (p) { return p.staffId != null && String(p.staffId) === String(w.legacy_id); }) };
      }).filter(function (s) { return !q || s.name.toLowerCase().includes(q); });
      rows.sort(function (a, b) { return b.total - a.total; });
      var total = rows.reduce(function (sum, s) { return sum + s.total; }, 0);
      var count = rows.reduce(function (sum, s) { return sum + s.count; }, 0);
      var local = rows.reduce(function (sum, s) { return sum + s.entries.length; }, 0);
      $('bannerTotal').textContent = rs(total);
      $('bannerCount').textContent = rows.length;
      $('staffList').innerHTML = rows.length ? rows.map(summaryCard).join('') : '<div class="empty"><p>No workshop payments match this view.</p></div>';
      el.innerHTML = count !== local
        ? '<div class="wk-err">Totals are from the database (' + count + ' payments). Partial list: showing ' + local + ' of ' + count + '.</div>'
        : '<div class="wk-hint">Totals checked against the database (' + count + ' payments).</div>';
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
    corr = { p: p, emp: emp, day: istDay(p.date) };
    $('d3CorrName').textContent = (emp ? emp.label : p.name + ' (no recorded worker)') + ' · ' + rs(p.amount) + ' · ' + dLong(corr.day);
    $('d3CorrInfo').textContent = 'This payment is part of the workshop weekly hisab, so it can only be changed here, with a reason.';
    $('d3CorrAct').value = emp ? 'change' : 'assign';
    $('d3CorrAmt').value = p.amount; $('d3CorrDay').value = corr.day; $('d3CorrDay').max = istToday();
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
    if (a === 'change') p['new'] = { amount: Number($('d3CorrAmt').value), day: $('d3CorrDay').value };
    if (a === 'remove') { p.cash_not_given = $('d3CorrNot').checked; if (!p.cash_not_given) { $('d3CorrErr').textContent = 'Tick "The money was NOT given".'; return; } }
    if (a === 'assign') p['new'] = { staff_id: $('d3CorrWho').value };
    $('d3CorrGo').disabled = true;
    send('staff_payment_correct', p, { staff: p.expected.staff_id }).then(function (res) {
      $('d3CorrGo').disabled = false;
      if (res.unconfirmed) { $('d3CorrErr').textContent = 'Save not confirmed — checking…'; resolvePending().then(refreshAll); return; }
      if (!res.ok) { $('d3CorrErr').textContent = plain(res); return; }
      closeCorrect(); showToast('Correction saved'); refreshAll();
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

  // Re-check unconfirmed operations whenever the app comes back.
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && Object.keys(pend()).length) resolvePending().then(refreshAll); });

  return { renderHisab: renderHisab, settle: settle, toggle: toggle, saveOldHisab: saveOldHisab, setRate: setRate,
           fillDetail: fillDetail, whatsappText: whatsappText, payrollRow: payrollRow, report: report,
           historyCheck: historyCheck, summaryTotals: summaryTotals, isProtected: isProtected, isSettlementPayment: isSettlementPayment,
           openCorrect: openCorrect, closeCorrect: closeCorrect, submitCorrect: submitCorrect, corrMode: corrMode,
           openHisabFor: openHisabFor, rowButtons: rowButtons, findPay: findPay, resolvePending: resolvePending,
           pending: pend, istDay: istDay, istToday: istToday, mondayOf: mondayOf, addDays: addDays, clearCache: function () { cache = {}; } };
})();
