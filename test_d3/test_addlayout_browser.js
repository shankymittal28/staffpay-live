/*
 * "+ Add" layout (rc16) on a 390x844 phone with synthetic data only.
 *
 *   test_d3/env.sh up && node test_d3/test_addlayout_browser.js [screenshot-dir]
 *
 * Payment form first, Recent Entries below, compact backup reminder under
 * them, "↩ Wapas mila" as a small button beside "New Payment", Today at Work
 * on Attend, and ☰ → Backup & Restore opening the existing Summary section.
 * Project Zero's Today at Work answers are faked here (two teams).
 */
const path = require('path');
const { chromium } = require('playwright');
const L = require('./lib.js'), { check, sql, OWNER } = L;
const { phone, txt, serve, addPayment, uploaded } = require('./phone.js');
const T = L.token(OWNER), SHOTS = process.argv[2] || null, NOW = '2026-10-14T11:00:00+05:30';
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png') }); };
const box = (page, sel) => page.$eval(sel, e => { const r = e.getBoundingClientRect(); return { top: Math.round(r.top + window.scrollY), bottom: Math.round(r.bottom + window.scrollY), h: Math.round(r.height), w: Math.round(r.width), vis: getComputedStyle(e).display !== 'none' && r.height > 0 }; });
const TODAY = { ok: true, teams: [
  { id: 7, name: 'Workshop', size: 6, last_at: '2026-10-14T04:40:00Z', counts: { working: 4, not_marked: 1, at_lunch: 1, left: 0 } },
  { id: 8, name: 'Shop', size: 3, last_at: '2026-10-14T04:10:00Z', counts: { working: 3, not_marked: 0, at_lunch: 0, left: 0 } }] };
const DETAIL = { ok: true, team: { id: 7, name: 'Workshop' }, day: '2026-10-14', members: [
  { label: 'Test Ram', state: 'arrived', at: '2026-10-14T03:30:00Z', by: 'Head' },
  { label: 'Test Shyam', state: 'not_marked' }] };

(async () => {
  const srv = await serve(path.join(__dirname, '..'), 8897);
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  try {
    L.reset(); L.setToday('2026-10-14');
    const ram = L.emp({ name: 'TestRam', rate: 500, ob: 0, obDate: '2026-10-04', legacy: 'stf_testram' });
    L.emp({ name: 'TestShop', group: 'shop', wage: 'monthly', legacy: 'stf_testshop' });
    await L.upsert(T, 'staff_payment', [L.payRow({ id: 1760500000001, staff: ram, name: 'TestRam', amount: 500, date: L.istTs('2026-10-13') })]);
    const page = await phone(browser, { port: 8897, now: NOW });
    let todayCalls = 0;
    await page.route('https://pz.test/api/work/owner/today/team**', r => r.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': '*' }, contentType: 'application/json', body: JSON.stringify(DETAIL) }));
    await page.route('https://pz.test/api/work/owner/today', r => { todayCalls++; return r.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': '*' }, contentType: 'application/json', body: JSON.stringify(TODAY) }); });
    check('L0 the new build is served (rc19-merge-20261017)', /rc19-merge-20261017/.test(await page.content()));

    // ---- + Add: form first, then Recent Entries, then the compact reminder
    await page.evaluate(() => { switchTab('add'); renderAll(); });
    await page.waitForTimeout(500);
    const kids = await page.$$eval('#page-add > *', els => els.map(e => e.id || e.className.split(' ')[0]));
    check('L1 + Add holds only: payment card, Recent Entries, list, backup reminder (no Today at Work, no Attendance shortcut)',
      JSON.stringify(kids) === JSON.stringify(['card', 'section-title', 'recentList', 'backupReminder']) && !(await page.$('#page-add .home-att-btn')), kids);
    const qe = await box(page, '#quickEntry'), rec = await box(page, '#paymentDate'), go = await box(page, '#payForm .btn-add');
    check('L2 name & amount, date and Record Payment are all on the first phone screen (above 844 px)',
      qe.top < 300 && rec.bottom < 700 && go.bottom < 844, { qe, rec, go });
    check('L3 the cursor is in Name & Amount on opening', await page.evaluate(() => document.activeElement && document.activeElement.id === 'quickEntry'));
    const title = await box(page, '#page-add .card-head-row .card-title'), btn = await box(page, '#rcvToggle');
    check('L4 "↩ Wapas mila" is a small labelled button on the New Payment row; its form starts closed',
      Math.abs(title.top - btn.top) < 14 && btn.h <= 36 && btn.w < 160 && /↩ Wapas mila/.test(await txt(page, '#rcvToggle'))
      && !(await box(page, '#rcvForm')).vis && (await box(page, '#payForm')).vis, { title, btn });
    const rem = await box(page, '#backupReminder .backup-reminder'), list = await box(page, '#recentList');
    check('L5 backup reminder (no backup yet, data exists) is below Recent Entries and compact',
      rem.vis && rem.top >= list.bottom && rem.h <= 64 && /Backup due/.test(await txt(page, '#backupReminder')) && !!(await page.$('#backupReminder .br-btn')), { rem, list });
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot(page, '1-add-opened');
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await shot(page, '2-add-bottom-reminder');
    await page.click('#backupReminder .br-x');
    check('L6 dismissing hides the reminder', (await txt(page, '#backupReminder')) === '');
    await page.evaluate(() => { markBackupDone(); backupSnoozed = false; renderBackupReminder(); });
    check('L7 after a backup the reminder is not shown (still conditional)', (await txt(page, '#backupReminder')) === '');

    // ---- Wapas mila opens its form in place
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.click('#rcvToggle');
    const opts = await page.$$eval('#rcvWho option', o => o.map(x => x.textContent));
    check('L8 tapping it opens the receipt form (Workshop and Shop staff) and hides the payment form',
      (await box(page, '#rcvForm')).vis && !(await box(page, '#payForm')).vis && opts.includes('TestRam') && opts.includes('TestShop'), opts);
    await shot(page, '3-wapas-mila-open');
    await page.click('.rcv-cancel');
    check('L9 "Chhodo" returns to the payment form', (await box(page, '#payForm')).vis && !(await box(page, '#rcvForm')).vis);

    // ---- a normal payment still records with the chosen date
    await addPayment(page, 'TestRam 300', '2026-10-12'); await uploaded(page);
    check('L10 Record Payment unchanged: 300 saved for 12 Oct, shown in Recent Entries',
      sql(`select amount::int || '@' || to_char(date at time zone 'Asia/Kolkata', 'DD') from staff_payment where amount = 300`) === '300@12'
      && /TestRam/.test(await txt(page, '#recentList')) && /₹300/.test(await txt(page, '#recentList')));

    // ---- Today at Work on Attend
    const before = todayCalls;
    await page.click('.tab[data-tab="attendance"]');
    await page.waitForFunction(() => document.getElementById('todayAtWork').style.display === 'block', null, { timeout: 8000 });
    const att = await page.$$eval('#page-attendance > *', els => els.map(e => e.id || e.className.split(' ')[0]));
    check('L11 Today at Work is the first card on Attend, refreshed on opening, with the same counts',
      att[0] === 'todayAtWork' && todayCalls > before && /Workshop 6 people/.test(await txt(page, '#todayAtWork'))
      && /4 at work · 1 not marked · 1 at lunch · 0 left/.test(await txt(page, '#todayAtWork')), { att: att.slice(0, 3), t: await txt(page, '#todayAtWork') });
    await page.click('.taw-team[data-team="7"]');
    await page.waitForFunction(() => /Test Ram/.test(document.getElementById('tawDetail').textContent), null, { timeout: 8000 });
    check('L12 tapping a team still opens its people (team interaction preserved)', /Test Ram at work/.test(await txt(page, '#tawDetail')) && /Test Shyam not marked/.test(await txt(page, '#tawDetail')));
    await shot(page, '4-attend-today-at-work');
    await page.click('#tawDetail .wk-btn');
    check('L13 Close hides the people list; attendance marking still below', (await txt(page, '#tawDetail')) === '' && !!(await page.$('#attendanceDate')));

    // ---- ☰ → Backup & Restore
    await page.click('.menu-btn'); await page.waitForTimeout(500);
    check('L13b ☰ lists "💾 Backup & Restore"', /Backup & Restore/.test(await txt(page, '#backupMenuButton')));
    await shot(page, '5-menu');
    await page.click('#backupMenuButton');
    await page.waitForTimeout(900);
    const sec = await page.$eval('#backupSection', e => { const r = e.getBoundingClientRect(); return { top: Math.round(r.top), h: window.innerHeight }; });
    check('L14 ☰ → Backup & Restore opens Summary at the existing backup section (Full Backup, Restore, Drive, WhatsApp)',
      await page.$eval('#page-summary', e => e.classList.contains('active')) && sec.top >= 0 && sec.top < sec.h / 2
      && !!(await page.$('#page-summary .btn-fullbackup')) && !!(await page.$('#page-summary .btn-restore')), sec);
    await shot(page, '6-backup-section');
    check('L15 no page errors', page.errors.length === 0, page.errors);
  } catch (e) { check('no exception', false, e.stack); }
  await browser.close(); srv.close();
  console.log(`\n${L.PASS.length} passed, ${L.FAIL.length} failed - + Add layout phone`);
  process.exit(L.FAIL.length ? 1 : 0);
})();
