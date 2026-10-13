/*
 * Receipts ("↩ Wapas mila") when a save's outcome is uncertain, on the phone,
 * against the disposable database (env.sh applies sql/d3_receipts_v1.sql).
 *
 *   test_d3/env.sh up && node test_d3/test_receipts_recovery_browser.js
 *   APP_DIR=/some/copy node ...   serves another copy of the app (mutation run)
 *
 * The network between the phone and the database is controlled per request:
 *   reply lost     - the database saves, the phone never hears back
 *   request lost   - the request never reaches the database
 *   status down    - staff_d3_op_status cannot be reached
 * Clock Sun 11 Oct 2026 18:00 IST; Old Hisab at the end of Sun 4 Oct.
 */
const path = require('path');
const { chromium } = require('playwright');
const L = require('./lib.js'), { check, sql } = L;
const { phone, txt, serve } = require('./phone.js');
const SB = 'https://bsjrihrekfsxmajdsyhc.supabase.co', NOW = '2026-10-11T18:00:00+05:30';
const APP = process.env.APP_DIR || path.join(__dirname, '..');
const rows = s => sql(`select coalesce(string_agg(amount::int::text || '@' || to_char(date at time zone 'Asia/Kolkata', 'DD'), ',' order by date, legacy_id), '') from staff_payment where staff_id = '${s}' and amount < 0`);
const logged = () => Number(sql(`select count(*) from staff_d3_op where action = 'receipt'`));

(async () => {
  const srv = await serve(APP, 8895);
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  try {
    L.reset(); L.setToday('2026-10-11');
    const rohit = L.emp({ name: 'Rohit', rate: 500, ob: -24000, obDate: '2026-10-04', legacy: 'stf_rohit' });
    const mohan = L.emp({ name: 'Mohan', rate: 500, ob: -5000, obDate: '2026-10-04', legacy: 'stf_mohan' });
    L.attRange(rohit, '2026-10-05', 'PPPPAAA'); L.attRange(mohan, '2026-10-05', 'PPPPAAA');
    const page = await phone(browser, { port: 8895, now: NOW });
    const net = { statusDown: false, dropRequest: false };
    await page.route(SB + '/rest/v1/rpc/staff_d3_op_status', r => net.statusDown ? r.abort('connectionreset') : r.fallback());
    await page.route(SB + '/rest/v1/rpc/staff_receipt_add', r => { if (net.dropRequest) { net.dropRequest = false; return r.abort('connectionreset'); } return r.fallback(); });
    const pendingOps = () => page.evaluate(() => Object.keys(SPD3.pending()));
    const form = async () => ({ who: await page.inputValue('#rcvWho'), amt: await page.inputValue('#rcvAmt'), day: await page.inputValue('#rcvDay'),
                                err: await txt(page, '#rcvErr'), msg: await txt(page, '#rcvMsg') });
    async function fill(staff, amt, day) {
      await page.evaluate(() => { switchTab('add'); SPD3.rcvToggle(true); });
      await page.selectOption('#rcvWho', staff); await page.fill('#rcvAmt', String(amt)); await page.fill('#rcvDay', day);
    }
    // press "Wapas mila likhein"; returns true if the confirmation opened (and confirms it)
    async function submit() {
      await page.click('#rcvGo');
      const opened = await page.waitForSelector('#confirmModal.show', { timeout: 4000 }).then(() => true, () => false);
      if (opened) { await page.click('#confirmYesBtn'); await page.waitForTimeout(1500); }
      return opened;
    }
    async function recheck() {
      await page.click('#rcvCheck');
      await page.waitForFunction(() => { const b = document.getElementById('rcvCheck'); return !b || !b.disabled; }, null, { timeout: 15000 });
      await page.waitForTimeout(800);
    }

    // ---- 1. database committed, reply lost, status unavailable -------------------
    net.statusDown = true; page.ctl.dropReply = 'staff_receipt_add';
    await fill(rohit, 14000, '2026-10-11');
    await submit();
    let f = await form();
    check('1a reply lost + status down: the phone says it is not confirmed, offers "Dobara check karein", says not to write again',
      /Rohit se ₹14,000 wapas mila · 11 Oct 2026: save confirm nahi hua/.test(f.msg) && /Dobara mat likhein/.test(f.msg) && !!(await page.$('#rcvCheck'))
      && !/Saved/.test(f.msg), f);
    const op1 = (await pendingOps())[0];
    check('1b the operation stays recorded on the phone', (await pendingOps()).length === 1 && rows(rohit) === '-14000@11', { p: await pendingOps(), r: rows(rohit) });
    const opened = await submit();
    f = await form();
    check('1c a second submission for Rohit is blocked before any confirmation: exactly one receipt, one logged operation',
      !opened && /Rohit ki pichli entry abhi confirm nahi hui/.test(f.err) && rows(rohit) === '-14000@11' && logged() === 1, { opened, f, r: rows(rohit) });
    await recheck();
    f = await form();
    check('1d "Dobara check karein" while the status is still down: still unresolved, nothing new written',
      /save confirm nahi hua/.test(f.msg) && (await pendingOps()).join() === op1 && rows(rohit) === '-14000@11', f);
    net.statusDown = false;
    await recheck();
    f = await form();
    check('1e status back: confirmed as saved with the original id; form (still that entry) cleared; nothing pending',
      /✓ Saved: Rohit se ₹14,000 wapas mila · 11 Oct 2026/.test(f.msg) && !/confirm nahi/.test(f.msg) && f.who === '' && f.amt === ''
      && (await pendingOps()).length === 0 && sql(`select legacy_id from staff_payment where staff_id = '${rohit}' and amount < 0`) === 'rcv_' + op1, { f, op1 });
    check('1f still exactly one receipt and one logged operation', rows(rohit) === '-14000@11' && logged() === 1, rows(rohit));

    // ---- 2. the request never reached the database ------------------------------
    net.statusDown = true; net.dropRequest = true;
    await fill(mohan, 2000, '2026-10-09');
    await submit();
    const op2 = (await pendingOps())[0];
    check('2a request lost: nothing in the database, the operation kept on the phone', rows(mohan) === '' && !!op2, rows(mohan));
    net.statusDown = false;
    await recheck();
    f = await form();
    check('2b recovery: status "not found" -> the same request resent with the SAME id -> exactly one receipt; shown as saved',
      rows(mohan) === '-2000@09' && sql(`select legacy_id from staff_payment where staff_id = '${mohan}' and amount < 0`) === 'rcv_' + op2
      && /✓ Saved: Mohan se ₹2,000 wapas mila · 9 Oct 2026/.test(f.msg) && (await pendingOps()).length === 0, f);

    // ---- 3. reopen the app while unresolved, then recover ------------------------
    net.statusDown = true; page.ctl.dropReply = 'staff_receipt_add';
    await fill(rohit, 1000, '2026-10-10');
    await submit();
    const op3 = (await pendingOps())[0];
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.getElementById('cloudBoot').style.display === 'none', null, { timeout: 15000 });
    await page.evaluate(() => { switchTab('add'); SPD3.rcvToggle(true); }); await page.waitForTimeout(1200);
    f = await form();
    check('3a after reopening: the unresolved receipt is still recorded and shown', (await pendingOps()).join() === op3
      && /Rohit se ₹1,000 wapas mila · 10 Oct 2026: save confirm nahi hua/.test(f.msg), f);
    await page.selectOption('#rcvWho', rohit); await page.fill('#rcvAmt', '1000'); await page.fill('#rcvDay', '2026-10-10');
    check('3b after reopening: a new receipt for Rohit is still blocked', !(await submit()) && /pichli entry abhi confirm nahi hui/.test((await form()).err)
      && rows(rohit) === '-1000@10,-14000@11', rows(rohit));
    net.statusDown = false;
    await recheck();
    f = await form();
    check('3c recovery after reopening: saved once with the original id; form (holding that same entry) cleared',
      /✓ Saved: Rohit se ₹1,000 wapas mila · 10 Oct 2026/.test(f.msg) && f.amt === '' && (await pendingOps()).length === 0
      && Number(sql(`select count(*) from staff_payment where legacy_id = 'rcv_${op3}'`)) === 1 && rows(rohit) === '-1000@10,-14000@11', { f, r: rows(rohit) });

    // ---- 4. definite rejection during recovery ----------------------------------
    net.statusDown = true; net.dropRequest = true;
    await fill(mohan, 500, '2026-10-09');
    await submit();
    sql(`update staff_employee set opening_balance_date = '2026-10-09' where id = '${mohan}'`);   // Old Hisab moved on another phone meanwhile
    const before4 = rows(mohan), o4 = logged();
    net.statusDown = false;
    await recheck();
    f = await form();
    check('4a refused during recovery: "Not saved" with the reason; never shown as saved; nothing written',
      /Not saved: Mohan se ₹500 wapas mila · 9 Oct 2026 — that date is before the Old Hisab date/.test(f.msg) && !/Saved: Mohan se ₹500/.test(f.msg)
      && rows(mohan) === before4 && logged() === o4 && (await pendingOps()).length === 0, { f, r: rows(mohan) });
    check('4b the entry stays on the form so it can be corrected', f.amt === '500' && f.day === '2026-10-09');
    sql(`update staff_employee set opening_balance_date = '2026-10-04' where id = '${mohan}'`);
    await page.evaluate(() => window.__SP_STORE__.pull());                         // the phone sees the restored date

    // ---- 5. switching worker / changing the form before recovery completes -------
    net.statusDown = true; page.ctl.dropReply = 'staff_receipt_add';
    await fill(rohit, 300, '2026-10-09');
    await submit();
    await fill(mohan, 700, '2026-10-08');
    const okOther = await submit();
    f = await form();
    check('5a another worker is not blocked: Mohan 700 saved while Rohit is unresolved', okOther && /-700@08/.test(rows(mohan)) && /✓ Saved: Mohan se ₹700/.test(f.msg), { f, r: rows(mohan) });
    await page.selectOption('#rcvWho', mohan); await page.fill('#rcvAmt', '800'); await page.fill('#rcvDay', '2026-10-07');   // newer input, not submitted
    net.statusDown = false;
    await recheck();
    f = await form();
    check('5b Rohit confirmed as saved, but Mohan\'s newer typing (800, 7 Oct) is NOT erased',
      /✓ Saved: Rohit se ₹300 wapas mila · 9 Oct 2026/.test(f.msg) && f.who === mohan && f.amt === '800' && f.day === '2026-10-07' && /-300@09/.test(rows(rohit)), f);
    net.statusDown = true; page.ctl.dropReply = 'staff_receipt_add';
    await fill(rohit, 400, '2026-10-08');
    await submit();
    await page.fill('#rcvAmt', '450');                                             // same worker, contents changed
    check('5c same worker with changed contents: still blocked', !(await submit()) && /pichli entry/.test((await form()).err));
    net.statusDown = false;
    await recheck();
    f = await form();
    check('5d confirmed 400 shown as saved; the form keeps the changed 450 (it is not that entry); 400 saved once, 450 never',
      /✓ Saved: Rohit se ₹400 wapas mila · 8 Oct 2026/.test(f.msg) && f.amt === '450' && rows(rohit) === '-400@08,-300@09,-1000@10,-14000@11', { f, r: rows(rohit) });
    // ---- 7. the note is part of the form snapshot -----------------------------------
    const noteOf = (s, amt, day) => sql(`select string_agg(note || '|' || amount::int || '|' || to_char(date at time zone 'Asia/Kolkata', 'DD'), ',') from staff_payment where staff_id = '${s}' and amount = ${-amt}`);
    net.statusDown = true; page.ctl.dropReply = 'staff_receipt_add';
    await fill(rohit, 250, '2026-10-07'); await page.fill('#rcvNote', 'original note');
    await submit();
    await page.fill('#rcvNote', 'newer note');                                      // only the note changed after submitting
    net.statusDown = false;
    await recheck();
    f = await form();
    check('7a only the note changed: confirmed as saved, but the form keeps everything incl. the newer note',
      /✓ Saved: Rohit se ₹250 wapas mila · 7 Oct 2026/.test(f.msg) && f.who === rohit && f.amt === '250' && f.day === '2026-10-07'
      && await page.inputValue('#rcvNote') === 'newer note', { f, note: await page.inputValue('#rcvNote') });
    check('7b the stored receipt keeps the submitted note and amount; exactly one such receipt',
      noteOf(rohit, 250) === 'original note|-250|07', noteOf(rohit, 250));
    net.statusDown = true; page.ctl.dropReply = 'staff_receipt_add';
    await fill(mohan, 150, '2026-10-07'); await page.fill('#rcvNote', 'same note');
    await submit();
    net.statusDown = false;
    await recheck();
    f = await form();
    check('7c entirely unchanged form: cleared normally after the confirmed save (note too); one receipt with that note',
      /✓ Saved: Mohan se ₹150/.test(f.msg) && f.who === '' && f.amt === '' && await page.inputValue('#rcvNote') === '' && noteOf(mohan, 150) === 'same note|-150|07', f);
    net.statusDown = true; page.ctl.dropReply = 'staff_receipt_add';
    await fill(mohan, 160, '2026-10-06');
    await submit();
    await page.evaluate(() => {                                                    // a pending record written by the earlier build: no note snapshot
      const m = JSON.parse(localStorage.getItem('sp_d3_pending')); Object.values(m).forEach(e => { if (e.meta) delete e.meta.note; });
      localStorage.setItem('sp_d3_pending', JSON.stringify(m));
    });
    net.statusDown = false;
    await recheck();
    f = await form();
    check('7d a pending record without a note snapshot: shown as saved, the form is conservatively NOT cleared; one receipt',
      /✓ Saved: Mohan se ₹160/.test(f.msg) && f.who === mohan && f.amt === '160' && noteOf(mohan, 160) === 'Wapas mila|-160|06', { f, n: noteOf(mohan, 160) });
    check('6 no page errors', page.errors.length === 0, page.errors);
  } catch (e) { check('no exception', false, e.stack); }
  await browser.close(); srv.close();
  console.log(`\n${L.PASS.length} passed, ${L.FAIL.length} failed - receipts uncertain-save phone`);
  process.exit(L.FAIL.length ? 1 : 0);
})();
