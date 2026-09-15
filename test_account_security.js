/* Runs the shipped form and Staff Work renewal code, with synthetic Auth and
 * a small DOM stand-in. No production network, tokens, accounts or passwords.
 * This verifies event/HTTP behaviour; it is not a browser layout test.
 * Run: node test_account_security.js
 */
'use strict';
const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const source = fs.readFileSync(__dirname + '/account-security.js', 'utf8');
const html = fs.readFileSync(__dirname + '/index.html', 'utf8');
const workStart = html.indexOf('var SPWork = (function () {');
const workEnd = html.indexOf('</script>', workStart);
const work = html.slice(workStart, workEnd);
const USER = { id: 'owner-fixture', email: 'owner@example.test' };
const PASSWORD = 'Synthetic test only!987';
const okay = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const deferred = () => { let resolve; return { promise: new Promise(r => { resolve = r; }), resolve: v => resolve(v) }; };
function rig({ responder, noSession = false, refreshFails = false } = {}) {
  const elements = {}, windowEvents = {}, calls = [], storageWrites = [], refreshes = [];
  class Element {
    constructor(tag = 'div') { this.tagName = tag; this.value = ''; this.textContent = ''; this.hidden = false; this.disabled = false; this.open = false; this.events = {}; }
    set id(v) { this._id = v; elements[v] = this; } get id() { return this._id; }
    set innerHTML(value) {
      this._html = value;
      for (const m of value.matchAll(/<([a-z]+)\b([^>]*)>/g)) {
        const id = m[2].match(/\bid="([^"]+)"/); if (!id) continue;
        const e = new Element(m[1]); e.id = id[1]; e.hidden = /\bhidden\b/.test(m[2]); e.disabled = /\bdisabled\b/.test(m[2]);
      }
    }
    appendChild() {} setAttribute() {}
    addEventListener(k, f) { this.events[k] = f; }
    showModal() { this.open = true; } close() { this.open = false; }
    emit(k) { return this.events[k]?.({ preventDefault() {} }); }
  }
  const history = { state: { original: true }, stack: [], pushState(s) { this.stack.push(this.state); this.state = s; },
    back() { this.state = this.stack.pop() ?? null; windowEvents.popstate?.(); } };
  const net = {
    URL: 'https://auth.example.test', session: noSession ? null : { access_token: 'fixture-old', refresh_token: 'fixture-refresh' },
    _h(extra) { return Object.assign({ apikey: 'publishable-fixture', 'Content-Type': 'application/json' }, extra); },
    refreshSession: async function () { refreshes.push('refresh'); await Promise.resolve(); if (refreshFails) throw Error('fixture refresh refused'); this.session.access_token = 'fixture-new'; return this.session; }
  };
  const context = {
    console, Promise, URL, AbortController, setTimeout, clearTimeout, history,
    document: { createElement: tag => new Element(tag), getElementById: id => elements[id], head: new Element(), body: new Element() },
    localStorage: { getItem() { return null; }, setItem(k,v) { storageWrites.push([k,v]); }, removeItem(k) { storageWrites.push([k,null]); } },
    addEventListener(k,fn) { windowEvents[k] = fn; }, __SP_NET__: net,
    fetch: async (url, options = {}) => {
      const call = { url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null, options };
      calls.push(call);
      if (responder) { const r = await responder(call, calls); if (r) return r; }
      if (url.startsWith('https://auth.example.test/auth/v1/user')) return okay(USER);
      if (url.endsWith('/auth/v1/reauthenticate')) return okay({});
      return okay({ ok: true });
    }
  };
  context.window = context; vm.createContext(context);
  vm.runInContext(work, context); vm.runInContext(source, context);
  function passwords() { elements.acPassword.value = PASSWORD; elements.acConfirm.value = PASSWORD; }
  return { context, elements, calls, storageWrites, refreshes, net, history, passwords,
    open: () => context.SPAccount.open(),
    submit: () => elements.acForm.emit('submit'),
    close: () => elements.acClose.emit('click'),
    fire: type => windowEvents[type]?.(),
    msg: () => elements.acMessage.textContent,
    puts: () => calls.filter(c => c.method === 'PUT'),
    codes: () => calls.filter(c => c.url.endsWith('/reauthenticate')) };
}
const tests = [];
function test(name, f) { tests.push([name, f]); }
test('Loading the script makes no network or storage change', () => {
  const r = rig(); assert.equal(r.calls.length, 0); assert.equal(r.storageWrites.length, 0);
});
test('Open verifies the account at Auth, and sends no password or email', async () => {
  const r = rig(); await r.open(); assert.equal(r.elements.acEmail.value, USER.email);
  assert.equal(r.calls.length, 1); assert.equal(r.puts().length, 0); assert.equal(r.codes().length, 0);
});
test('Absent sign-in does not become a reset or a sign-out', async () => {
  const r = rig({noSession:true}); await r.open(); assert.equal(r.calls.length,0);
  assert(r.elements.acSave.disabled); assert.equal(r.storageWrites.length,0);
});
test('Expired token shares Staff Work renewal, then re-verifies the user', async () => {
  const r = rig({responder(c) { if(c.options.headers.Authorization === 'Bearer fixture-old') return okay({code:'bad_jwt'},401); }});
  await r.open(); assert.equal(r.refreshes.length,1); assert.equal(r.elements.acEmail.value,USER.email);
  assert.equal(r.calls.at(-1).options.headers.Authorization,'Bearer fixture-new');
});
test('Account and Staff Work calls share ONE simultaneous renewal', async () => {
  const r = rig({responder(c) { if(c.options.headers.Authorization === 'Bearer fixture-old') return okay({code:'bad_jwt'},401); }});
  await Promise.all([r.open(), r.context.SPWork.api('/api/work/owner/teams')]);
  assert.equal(r.refreshes.length,1);
});
test('Failed renewal preserves the stored session, with no write', async () => {
  const r = rig({refreshFails:true,responder(){return okay({code:'bad_jwt'},401);}});
  await r.open(); assert.equal(r.puts().length,0); assert.equal(r.storageWrites.length,0);
  assert(r.net.session); assert(r.elements.acSave.disabled);
});
test('Mismatched passwords never leave the phone', async () => {
  const r=rig(); await r.open(); r.passwords(); r.elements.acConfirm.value='different'; await r.submit();
  assert.equal(r.puts().length,0); assert.match(r.msg(),/do not match/);
});
test('Confirmed change updates only self and clears password fields', async () => {
  const r=rig(); await r.open(); r.passwords(); await r.submit();
  assert.equal(r.puts().length,1); assert.deepEqual(r.puts()[0].body,{password:PASSWORD});
  assert.match(r.msg(),/^Password changed/); assert.equal(r.elements.acPassword.value,'');
  assert.equal(r.elements.acConfirm.value,''); assert.equal(r.storageWrites.length,0);
  assert(r.calls.every(c=>c.url.startsWith('https://auth.example.test/auth/v1/')));
  assert(r.calls.every(c=>!c.url.includes('logout')&&!c.url.includes('admin')));
});
test('Account changed between opening and Save cannot update either account', async () => {
  let reads=0; const r=rig({responder(c){if(c.method==='GET'&&c.url.endsWith('/user')&&++reads>1)return okay({...USER,id:'other-user'});}});
  await r.open(); r.passwords(); await r.submit(); assert.equal(r.puts().length,0); assert.match(r.msg(),/account changed/);
});
test('Reauthentication refusal displays a code option but does NOT send email', async () => {
  const r=rig({responder(c){if(c.method==='PUT')return okay({code:'reauthentication_needed'},400);}});
  await r.open(); r.passwords(); await r.submit();
  assert.equal(r.elements.acVerification.hidden,false); assert.equal(r.codes().length,0);
  assert.doesNotMatch(r.msg(),/^Password changed/);
});
test('Email is requested only from its button; nonce goes with the new password', async () => {
  let needs=true;const r=rig({responder(c){if(c.method==='PUT'&&needs){needs=false;return okay({code:'reauthentication_needed'},400);}}});
  await r.open();r.passwords();await r.submit();await r.elements.acSendCode.emit('click');
  assert.equal(r.codes().length,1);assert.equal(r.codes()[0].method,'GET');
  r.passwords();r.elements.acCode.value='123456';await r.submit();
  assert.deepEqual(r.puts().at(-1).body,{password:PASSWORD,nonce:'123456'});assert.match(r.msg(),/^Password changed/);
});
test('Bad nonce stays refused', async () => {
  const r=rig({responder(c){if(c.method==='PUT')return okay({code:'reauthentication_not_valid'},400);}});
  await r.open();r.passwords();await r.submit();assert.match(r.msg(),/not accepted/);assert.equal(r.codes().length,0);
});
test('Current-password requirement is explained and never bypassed', async () => {
  const r=rig({responder(c){if(c.method==='PUT')return okay({code:'current_password_required'},400);}});
  await r.open();r.passwords();await r.submit();assert.match(r.msg(),/requires the old password/);
  assert.equal(r.puts().length,1);assert.equal(r.codes().length,0);assert.equal(r.storageWrites.length,0);
});
test('Weak password and rate limits are failures, not success', async () => {
  for(const [code,status,pattern] of [['weak_password',422,/requirements/],['over_request_rate_limit',429,/Too many/]]){
    const r=rig({responder(c){if(c.method==='PUT')return okay({code},status);}});
    await r.open();r.passwords();await r.submit();assert.match(r.msg(),pattern);assert.doesNotMatch(r.msg(),/^Password changed/);
  }
});
test('Request failure, unreadable result and wrong user all remain unconfirmed', async () => {
  for(const response of [
    ()=>{throw Error('lost response');},
    ()=>({ok:true,status:200,json:async()=>{throw Error('bad json');}}),
    ()=>okay({id:'wrong-user'}),
    ()=>okay({})
  ]){
    const r=rig({responder(c){if(c.method==='PUT')return response();}});
    await r.open();r.passwords();await r.submit();
    assert.match(r.msg(),/could not be confirmed/);assert.doesNotMatch(r.msg(),/^Password changed/);
    assert.equal(r.puts().length,1);assert.equal(r.storageWrites.length,0);
  }
});
test('A write refused with 401 is not automatically replayed', async () => {
  const r=rig({responder(c){if(c.method==='PUT')return okay({code:'bad_jwt'},401);}});
  await r.open();r.passwords();await r.submit();assert.equal(r.puts().length,1);assert.equal(r.refreshes.length,0);
});
test('Back before preflight completes cancels the unsent password change', async () => {
  const wait=deferred();let reads=0;const r=rig({responder(c){if(c.method==='GET'&&c.url.endsWith('/user')&&++reads===2)return wait.promise;}});
  await r.open();r.passwords();const pending=r.submit();r.history.back();wait.resolve(okay(USER));await pending;
  assert.equal(r.puts().length,0);assert.equal(r.elements.accountDialog.open,false);assert.equal(r.elements.acPassword.value,'');
});
test('Close while opening ignores the late identity reply', async () => {
  const wait=deferred();const r=rig({responder(){return wait.promise;}});
  const pending=r.open();r.close();wait.resolve(okay(USER));await pending;
  assert.equal(r.elements.accountDialog.open,false);assert.equal(r.elements.acEmail.value,'');assert.deepEqual(r.history.state,{original:true});
});
test('Old opening cannot overwrite a newer opening', async () => {
  const wait=deferred();let first=true;const r=rig({responder(){if(first){first=false;return wait.promise;}}});
  const old=r.open();r.close();await r.open();wait.resolve(okay({...USER,email:'stale@example.test'}));await old;
  assert.equal(r.elements.acEmail.value,USER.email);
});
test('Double Save issues one write', async () => {
  const wait=deferred();const r=rig({responder(c){if(c.method==='PUT')return wait.promise;}});
  await r.open();r.passwords();const first=r.submit();const second=r.submit();
  await new Promise(resolve=>setImmediate(resolve));wait.resolve(okay(USER));await Promise.all([first,second]);
  assert.equal(r.puts().length,1);
});
test('Page hide clears typed passwords and codes', async () => {
  const r=rig();await r.open();r.passwords();r.elements.acCode.value='123456';
  r.fire('pagehide');assert.equal(r.elements.acPassword.value,'');assert.equal(r.elements.acConfirm.value,'');assert.equal(r.elements.acCode.value,'');
});
(async()=>{
  let failed=0;
  for(const [name,run] of tests){try{await run();console.log('PASS '+name);}catch(e){failed++;console.error('FAIL '+name+' — '+e.message);}}
  console.log((tests.length-failed)+' passed, '+failed+' failed (DOM/HTTP stand-in, not a browser)');
  process.exitCode=failed?1:0;
})();
