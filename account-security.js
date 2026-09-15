/* Account password changes use only the current user's Supabase Auth session.
 * No admin credential, owner reassignment, password storage, or payroll write.
 * The form is loaded on demand; it sends nothing until opened by the user.
 */
(function (root) {
  'use strict';
  var dialog, marker = null, generation = 0, verified = null, busy = false;
  var closingHistory = false;
  var $ = function (id) { return document.getElementById(id); };
  function clearFields() {
    ['acPassword', 'acConfirm', 'acCode'].forEach(function (id) { if ($(id)) $(id).value = ''; });
  }
  function message(text) { $('acMessage').textContent = text; }
  function setBusy(on) {
    busy = on;
    ['acSave', 'acSendCode'].forEach(function (id) { $(id).disabled = on || !verified; });
  }
  function active(g) { return dialog.open && generation === g; }
  function net() {
    var n = root.__SP_NET__;
    if (!n || !n.session || !n.session.access_token) throw fail('signed_out');
    return n;
  }
  function fail(code, status) { var e = new Error(code); e.code = code; e.status = status; return e; }
  // A token is captured per request. Password writes never follow an account
  // switch or retry automatically after an uncertain response.
  async function request(method, path, body, token) {
    var n = net(), controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 20000);
    try {
      var response = await fetch(n.URL + '/auth/v1/' + path, {
        method: method, credentials: 'omit', cache: 'no-store',
        headers: n._h({ Authorization: 'Bearer ' + token }),
        body: body == null ? undefined : JSON.stringify(body), signal: controller.signal
      });
      var result;
      try { result = await response.json(); } catch (e) { throw fail('unconfirmed'); }
      if (!response.ok) throw fail(result.code || result.error_code || 'refused', response.status);
      return result;
    } catch (e) {
      if (e.code) throw e;
      throw fail('unconfirmed');
    } finally { clearTimeout(timer); }
  }
  async function currentAccount(expected) {
    var token = net().session.access_token, user;
    try { user = await request('GET', 'user', null, token); }
    catch (e) {
      if (e.status !== 401) throw e;
      // Use the SAME renewal as Staff Work, avoiding refresh-token races.
      await root.SPWork.renewSession(token).catch(function () { throw fail('signed_out'); });
      token = net().session.access_token;
      user = await request('GET', 'user', null, token);
    }
    if (!user || typeof user.id !== 'string' || typeof user.email !== 'string' || !user.email || user.is_anonymous) throw fail('signed_out');
    if (expected && user.id !== expected) throw fail('account_changed');
    return { id: user.id, email: user.email, token: token };
  }
  function explain(e, writing) {
    var code = e.code || '';
    if (code === 'reauthentication_needed' || code === 'reauthentication_not_valid') {
      $('acVerification').hidden = false;
      return code === 'reauthentication_not_valid'
        ? 'The verification code was not accepted. Request a fresh code and enter it here.'
        : 'Confirm this account by email first. Tap Send verification code, then enter the code and your new password.';
    }
    if (code === 'current_password_required' || code === 'current_password_mismatch' || code === 'invalid_current_password') {
      return 'This account requires the old password. Keep StaffPay signed in; email password recovery must be set up before continuing. No security setting has been changed.';
    }
    if (code === 'weak_password') return 'That password does not meet the account requirements. Try a longer password with upper and lower case letters, a number and a symbol.';
    if (code === 'same_password') return 'That is already your password. You can use it to sign in to Credit Review.';
    if (e.status === 429 || /rate_limit/.test(code)) return 'Too many attempts. Wait a few minutes before trying again.';
    if (code === 'account_changed') return 'The signed-in account changed. Close this form and open it again before continuing.';
    if (code === 'signed_out' || e.status === 401) return 'This sign-in could not be verified. Keep StaffPay open; do not clear its data or sign out.';
    if (code === 'insufficient_aal') return 'This account requires its second verification step before changing the password. Keep this session signed in.';
    if (writing) return 'The password change could not be confirmed. Keep StaffPay open. Try the new password in Credit Review before submitting another change.';
    return 'The account could not be checked. Check your connection and try again. Your sign-in has been kept.';
  }
  async function save(event) {
    event.preventDefault();
    if (busy || !verified) return;
    var password = $('acPassword').value, confirm = $('acConfirm').value;
    if (password.length < 8) { message('Use at least 8 characters for the new password.'); return; }
    if (password !== confirm) { message('The two passwords do not match.'); return; }
    var g = generation, expected = verified.id, nonce = $('acCode').value.trim(), sent = false;
    setBusy(true); message('Checking your account…');
    try {
      var account = await currentAccount(expected);
      if (!active(g)) return;
      var body = { password: password };
      if (nonce) body.nonce = nonce;
      message('Changing your password…'); sent = true;
      var result = await request('PUT', 'user', body, account.token);
      if (!result || result.id !== expected) throw fail('unconfirmed');
      if (!active(g)) return;
      clearFields(); $('acForm').hidden = true;
      $('acSuccess').hidden = false;
      message('Password changed. Use your new password with ' + account.email + ' in StaffPay and Credit Review. Save it in your password manager.');
    } catch (e) {
      if (active(g)) { clearFields(); message(explain(e, sent)); }
    } finally { password = ''; confirm = ''; if (active(g)) setBusy(false); }
  }
  async function sendCode() {
    if (busy || !verified) return;
    var g = generation, expected = verified.id;
    setBusy(true); message('Checking your account…');
    try {
      var account = await currentAccount(expected);
      if (!active(g)) return;
      // Only this explicit button requests an email; never on open/error.
      await request('GET', 'reauthenticate', null, account.token);
      if (active(g)) message('Verification code requested for ' + account.email + '. Check your inbox and spam folder, then enter the code and your new password.');
    } catch (e) {
      if (active(g)) message('The verification email could not be confirmed. Check your inbox before trying again. Your password has not been changed by this request.');
    } finally { if (active(g)) setBusy(false); }
  }
  function finishClose() {
    generation++; verified = null; busy = false;
    clearFields(); if ($('acEmail')) $('acEmail').value = '';
    if (dialog.open) dialog.close();
  }
  function close() {
    var mine = marker; marker = null; finishClose();
    if (history.state && history.state.spAccount === mine) {
      closingHistory = true; history.back();
    }
  }
  function create() {
    if (dialog) return;
    var style = document.createElement('style');
    style.textContent = '#accountDialog{box-sizing:border-box;width:min(94vw,420px);max-height:92dvh;overflow:auto;border:1px solid #6b8191;border-radius:16px;background:#19252f;color:#e8edf0;padding:22px;font:15px system-ui,sans-serif}#accountDialog::backdrop{background:#000b}#accountDialog h2{margin:0;font-size:21px}#accountDialog p{line-height:1.5}#accountDialog label{display:block;margin:14px 0 5px}#accountDialog input{box-sizing:border-box;width:100%;background:#0f1923;border:1px solid #6b8191;color:#e8edf0;border-radius:9px;padding:12px;font-size:16px}#accountDialog button,#accountDialog a{cursor:pointer;min-height:44px;border-radius:9px;padding:10px 14px;font:inherit}#accountDialog button{background:#f0a500;color:#0f1923;border:0}#accountDialog button:disabled{opacity:.5}#acClose{margin-left:auto}#acMessage{white-space:pre-wrap;margin:14px 0;line-height:1.5}#accountDialog small{display:block;color:#b6c4ce;margin:12px 0;line-height:1.5}#acSave{width:100%;margin-top:18px}#acSuccess a{display:inline-block;background:#f0a500;color:#0f1923;text-decoration:none}';
    document.head.appendChild(style);
    dialog = document.createElement('dialog'); dialog.id = 'accountDialog';
    dialog.setAttribute('aria-labelledby', 'acTitle');
    dialog.innerHTML = '<div style="display:flex;align-items:center;gap:12px"><h2 id="acTitle">Change password</h2><button id="acClose" type="button" aria-label="Close password form">×</button></div>' +
      '<p>This changes the password for your signed-in account, used by StaffPay and Credit Review.</p>' +
      '<form id="acForm"><label for="acEmail">Account</label><input id="acEmail" type="email" autocomplete="username" readonly>' +
      '<label for="acPassword">New password</label><input id="acPassword" type="password" autocomplete="new-password" minlength="8" required>' +
      '<label for="acConfirm">Repeat new password</label><input id="acConfirm" type="password" autocomplete="new-password" minlength="8" required>' +
      '<section id="acVerification" hidden><button id="acSendCode" type="button" style="margin-top:16px">Send verification code</button>' +
      '<label for="acCode">Code from your email</label><input id="acCode" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="12"></section>' +
      '<small>Other sessions for this account may ask you to sign in again. Staff accounts and business records are unchanged.</small>' +
      '<button id="acSave" type="submit" disabled>Save new password</button></form>' +
      '<p id="acMessage" role="status" aria-live="polite"></p>' +
      '<div id="acSuccess" hidden><a href="https://project-zero-xafh.onrender.com/?review=1" target="_blank" rel="noopener noreferrer">Open Credit Review</a></div>';
    document.body.appendChild(dialog);
    $('acClose').addEventListener('click', close);
    dialog.addEventListener('cancel', function (e) { e.preventDefault(); close(); });
    $('acForm').addEventListener('submit', save);
    $('acSendCode').addEventListener('click', sendCode);
    root.addEventListener('popstate', function () {
      closingHistory = false;
      if (marker && (!history.state || history.state.spAccount !== marker)) { marker = null; finishClose(); }
    });
    root.addEventListener('pagehide', clearFields);
  }
  async function open() {
    create();
    if (dialog.open || closingHistory) return;
    clearFields(); verified = null;
    $('acForm').hidden = false; $('acSuccess').hidden = true; $('acVerification').hidden = true;
    $('acEmail').value = '';
    marker = 'account-' + (++generation);
    history.pushState(Object.assign({}, history.state || {}, { spAccount: marker }), '');
    dialog.showModal(); setBusy(true); message('Checking your signed-in account…');
    var g = generation;
    try {
      var account = await currentAccount();
      if (!active(g)) return;
      verified = { id: account.id, email: account.email }; // never retain the token here
      $('acEmail').value = account.email;
      message('Choose a new password. You do not need to send it to anyone.');
    } catch (e) { if (active(g)) message(explain(e, false)); }
    finally { if (active(g)) setBusy(false); }
  }
  root.SPAccount = { open: open };
})(window);
