/* Full StaffPay page at phone size; every external request is intercepted.
 * Uses only synthetic accounts. No production request or password change.
 * Run: node test_account_security_browser.js (Playwright + Chromium required).
 */
'use strict';
const fs=require('node:fs'),http=require('node:http'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const DIR=__dirname,SB='https://bsjrihrekfsxmajdsyhc.supabase.co',PZ='https://project-zero-xafh.onrender.com';
const USER={id:'00000000-0000-4000-8000-000000000001',email:'owner@example.test'};
const NEW='Synthetic testing only!5678';
const token=()=>({access_token:'fixture-access',refresh_token:'fixture-refresh',user:USER});
const json=(route,obj,status=200)=>route.fulfill({status,contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*'},body:JSON.stringify(obj)});
(async()=>{
 const server=http.createServer((q,r)=>{const name=q.url.split('?')[0]==='/'?'index.html':q.url.split('?')[0].slice(1);const file=path.join(DIR,name);
   if(!file.startsWith(DIR+path.sep)){r.writeHead(403);return r.end();}
   fs.readFile(file,(e,d)=>{if(e){r.writeHead(404);return r.end();}r.setHeader('Content-Type',name.endsWith('.js')?'application/javascript':name.endsWith('.html')?'text/html':'application/octet-stream');r.end(d);});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 let browser;
 try {
  browser=await chromium.launch({headless:true});
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,serviceWorkers:'block'});
  let mode='success',writes=0,emails=0,businessWrites=0,lastBody=null;
  await context.addInitScript(t=>{localStorage.setItem('sp_cloud_session',JSON.stringify(t));localStorage.setItem('staffpay_schema_version','2');},token());
  await context.route('**/*',async route=>{
   const req=route.request(),u=req.url(),m=req.method();
   if(u.startsWith(origin+'/'))return route.continue();
   if(u.startsWith(SB+'/auth/v1/token?'))return json(route,token());
   if(u===SB+'/auth/v1/user'){
    if(m==='GET')return json(route,USER);
    assert.equal(m,'PUT');writes++;lastBody=req.postDataJSON();
    if(mode==='reauth'&&!lastBody.nonce)return json(route,{code:'reauthentication_needed'},400);
    if(mode==='old_required')return json(route,{code:'current_password_required'},400);
    if(mode==='lost')return route.abort('failed');
    if(mode==='unreadable')return route.fulfill({status:200,contentType:'text/plain',body:'not json'});
    return json(route,USER);
   }
   if(u===SB+'/auth/v1/reauthenticate'){assert.equal(m,'GET');emails++;return json(route,{});}
   if(u.startsWith(SB+'/rest/v1/')){if(m!=='GET')businessWrites++;return json(route,[]);}
   if(u.startsWith(PZ+'/api/work/owner/')){if(m!=='GET')businessWrites++;return json(route,{ok:true,teams:[],employees:[],tasks:[],today:'2026-09-15'});}
   return route.abort('blockedbyclient'); // Fonts/images/analytics cannot reach production either.
  });
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin);await page.locator('#cloudBoot').waitFor({state:'hidden'});
  async function open(){await page.getByLabel('More options',{exact:true}).click();await page.locator('#accountPasswordButton').click();await page.waitForFunction(()=>document.querySelector('#acEmail')?.value==='owner@example.test');}
  async function fill(){await page.locator('#acPassword').fill(NEW);await page.locator('#acConfirm').fill(NEW);}
  async function save(){await page.locator('#acSave').click();await page.waitForFunction(()=>!document.querySelector('#acSave').disabled);}
  async function close(){await page.locator('#acClose').click();await page.waitForFunction(()=>!document.querySelector('#accountDialog').open);await page.waitForTimeout(100);}
  await open();assert.equal(writes,0);assert.equal(emails,0);
  assert(await page.locator('#acPassword').isVisible());
  assert(await page.locator('#acSave').isVisible());
  assert(await page.evaluate(()=>document.querySelector('#accountDialog').getBoundingClientRect().right<=390));
  fs.mkdirSync(path.join(DIR,'test-results'),{recursive:true});
  await page.screenshot({path:path.join(DIR,'test-results/password-form-phone.png'),fullPage:true});
  await fill();await save();
  assert.match(await page.locator('#acMessage').innerText(),/^Password changed/);
  assert.deepEqual(lastBody,{password:NEW});assert.equal(writes,1);
  assert.equal(await page.locator('#acPassword').inputValue(),'');
  assert(await page.locator('#acSuccess a').isVisible());
  assert.equal(await page.evaluate(p=>Object.values(localStorage).some(v=>v.includes(p)),NEW),false);
  console.log('PASS full-page phone opening, private submit, confirmation and cleared fields');await close();
  mode='reauth';await open();await fill();await save();
  assert.equal(emails,0);assert(await page.locator('#acVerification').isVisible());
  await page.locator('#acSendCode').click();await page.waitForFunction(()=>document.querySelector('#acMessage').textContent.includes('Verification code requested'));
  assert.equal(emails,1);await page.locator('#acCode').fill('123456');await fill();await save();
  assert.deepEqual(lastBody,{password:NEW,nonce:'123456'});assert.match(await page.locator('#acMessage').innerText(),/^Password changed/);
  console.log('PASS required email verification, requested only by its button');await close();
  for(const state of ['lost','unreadable','old_required']){
   mode=state;await open();await fill();await save();const text=await page.locator('#acMessage').innerText();
   assert.doesNotMatch(text,/^Password changed/);assert.match(text,state==='old_required'?/requires the old password/:/could not be confirmed/);
   assert.equal(await page.locator('#acPassword').inputValue(),'');await close();
  }
  console.log('PASS lost response, unreadable result and old-password requirement');
  mode='success';await open();await fill();await page.goBack();await page.waitForFunction(()=>!document.querySelector('#accountDialog').open);
  assert.equal(await page.locator('#acPassword').inputValue(),'');assert(await page.locator('#page-add').isVisible());
  assert.equal(businessWrites,0);assert.deepEqual(errors,[]);
  console.log('PASS browser Back clears fields and returns to the existing app');
  await context.close();console.log('4 full-page phone journeys passed; no business writes or production requests');
 } finally {if(browser)await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});

