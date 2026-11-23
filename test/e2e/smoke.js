// Browser smoke test: node test/e2e/smoke.js <poll.xlsx> <xlsx.full.min.js> <outdir>
// Runs dist/index.html in Chromium with a fake `window.claude` (local storage
// fallback for data, canned answers for Claude), walks the main flows and
// saves screenshots.
const { chromium } = require('playwright');
const path = require('path');
const [, , pollFile, xlsxLib, outDir] = process.argv;
const page_url = 'file://' + path.join(__dirname, '..', '..', 'dist', 'index.html');

const fakeClaude = () => {
  const sample = async (input, opts) => {
    const text = 'What matters most\n- Passed HR with strong tender writing.\n\nWhat colleagues noted\n- Natalie: confident, asks good questions.\n\nWhat to dig into\n- Planning under deadline pressure.\n\nQuestions to ask\n- Tell us about a deadline you nearly missed.';
    if (opts && opts.onText) opts.onText({ text: text.slice(0, 40), delta: '' });
    return { text, truncated: false };
  };
  sample.json = async (prompt) => {
    if (prompt.includes('Poll rows with remarks')) {
      const rows = JSON.parse(prompt.slice(prompt.indexOf('[', prompt.indexOf('Poll rows with remarks'))));
      const by = (n) => rows.find((r) => r.name.trim() === n);
      const out = [];
      const b = by('Bastiaan'); if (b) out.push({ row: b.row, kind: 'window', dates: ['2026-12-04'], from: '14:00', to: '15:30', summary: 'Fri 4 Dec only 14:00-15:30', quote: 'op vrijdag 4-12 alleen van 14-15.30 uur' });
      const p = by('Pieter'); if (p) out.push({ row: p.row, kind: 'window', dates: p.poll_dates.filter((d) => new Date(d).getUTCDay() === 3), to: '12:00', summary: 'Wednesdays until 12:00', quote: 'Op woensdagen tot uiterlijk 12 uur' });
      const j = by('Jesse'); if (j) out.push({ row: j.row, kind: 'tentative', dates: j.poll_dates.filter((d) => d >= '2026-11-24'), summary: 'From 24 Nov tentative, check first', quote: 'onder voorbehoud' });
      return out;
    }
    return [{ date: '2026-11-26', from: '09:00', to: '12:30' }, { date: '2026-11-27', from: '09:00', to: '17:30' }];
  };
  const viewerId = localStorage.getItem('e2e.viewer');
  const user = viewerId ? { id: async () => viewerId, canEdit: () => false, isOwner: () => false, profiles: async () => ({}), search: async () => [] } : null;
  window.claude = { use: async (n) => (n === 'sample' ? sample : n === 'user' ? user : null) };
};

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1360, height: 900 } });
  await ctx.route('https://cdnjs.cloudflare.com/**', (r) => r.fulfill({ path: xlsxLib, contentType: 'application/javascript' }));
  await ctx.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ body: '', contentType: 'text/css' }));
  await ctx.addInitScript(fakeClaude);
  const page = await ctx.newPage();
  global.__page = page;
  const errors = [];
  global.__errors = errors;
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(page_url);
  // Welcome card on first open: English, then Dutch, then "I'm in".
  await page.waitForSelector('text=Welcome to Flux Interviews');
  await page.screenshot({ path: path.join(outDir, '0-welcome.png'), fullPage: false });
  await page.getByRole('button', { name: 'Nederlands' }).click();
  await page.waitForSelector('text=Welkom bij Flux Interviews');
  await page.screenshot({ path: path.join(outDir, '0-welcome-nl.png'), fullPage: false });
  await page.getByRole('button', { name: 'Ik doe mee' }).click();
  await page.waitForSelector('text=Welcome aboard');
  await page.getByRole('button', { name: 'Create campaign' }).click();
  await page.waitForSelector('text=To do');

  // Seed the roster the way Claude will seed it after publishing.
  await page.evaluate(async () => {
    const S = window.FluxApp.state();
    const roster = [
      ['Bastiaan','TM','advisor'],['Nieck','TM','advisor'],['Yoram','TM','advisor'],['Jesse','TM','advisor'],['Pieter','TM','advisor'],
      ['Michael','PM','advisor'],['Marnix','PM','advisor'],['Max T','PM','advisor'],['Ties','PM','advisor'],['Ole','PM','advisor'],['Max A','PM','advisor'],['Bart','PM','advisor'],
      ['Ewout','CP','advisor'],['Marco','CP','advisor'],['Joost','OM','advisor'],['Wybren','OM','advisor'],['Alexander','OM','advisor'],
      ['Mark','TM','teamlead'],['Janneke','TM','teamlead'],['Koen','PM','teamlead'],['Hans','PM','teamlead'],['Ruben','OM','teamlead'],['Doekes','CP','teamlead'],['Eveline','P&C','joker'],
    ];
    for (const [name, team, role] of roster) await S.add('people', { name, team, roles: [role], aliases: [], active: true, email: '' });
  });

  await page.goto(page_url + '#availability');
  await page.setInputFiles('#poll-file', pollFile);
  await page.waitForSelector('text=Check the import');
  await page.screenshot({ path: path.join(outDir, '1-import-before.png'), fullPage: true });
  await page.getByRole('button', { name: /Add Koen B as advisor/ }).click();
  await page.getByRole('button', { name: /Update roster to CP/ }).click();
  await page.getByRole('button', { name: /with Claude/ }).click();
  await page.waitForSelector('text=Claude: Fri 4 Dec only 14:00-15:30');
  await page.screenshot({ path: path.join(outDir, '2-import-claude.png'), fullPage: true });
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'Confirm', exact: true }).first().click();
  await page.getByRole('button', { name: 'Save snapshot' }).click();
  await page.waitForSelector('text=Snapshot saved');
  await page.screenshot({ path: path.join(outDir, '3-snapshot.png'), fullPage: true });

  // Candidates
  await page.goto(page_url + '#run');
  for (const [name, date] of [['Sanne de Vries', '2026-11-19'], ['Daan Bakker', '2026-11-16'], ['Emma Jansen', '2026-11-23']]) {
    await page.getByRole('button', { name: '+ Candidate' }).first().click();
    await page.fill('#nc-name', name);
    await page.fill('#nc-hr', date);
    await page.getByRole('button', { name: 'Add candidate' }).click();
    await page.waitForSelector('.drawer h2');
    await page.getByRole('button', { name: 'Close', exact: true }).click();
  }
  // Sanne: availability received, then book
  await page.getByRole('button', { name: 'Sanne de Vries', exact: true }).click();
  await page.fill('#sf-avail', 'Donderdag ochtend en vrijdag de hele dag');
  await page.getByRole('button', { name: 'Read with Claude' }).click();
  await page.waitForSelector('text=Fri 27 Nov 09:00-17:30');
  await page.getByRole('button', { name: 'Save step' }).click();
  await page.waitForSelector('#sf-slot');
  await page.fill('#sf-slot', '2026-11-27');
  await page.dispatchEvent('#sf-slot', 'change');
  await page.fill('#sf-time', '10:00');
  const opts = await page.$$eval('#sf-int-0 option', (o) => o.map((x) => [x.value, x.textContent]));
  const koen = opts.find((o) => o[1].startsWith('Koen B'));
  const max = opts.find((o) => o[1].startsWith('Max T'));
  await page.selectOption('#sf-int-0', koen[0]);
  await page.selectOption('#sf-int-1', max[0]);
  await page.fill('textarea[id^="note-text"]', 'Confident, asks good questions. Probe planning under pressure.');
  await page.getByRole('button', { name: 'Add note' }).click();
  await page.waitForSelector('text=Note added');
  await page.getByRole('button', { name: 'Brief me' }).click();
  await page.waitForSelector('text=Questions to ask');
  await page.screenshot({ path: path.join(outDir, '4-drawer.png'), fullPage: false });
  await page.getByRole('button', { name: 'Save step' }).click();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  // Daan: rejected at HR? -> record outcome reject via cell
  await page.getByRole('button', { name: 'Daan Bakker: HR interview done' }).click();
  await page.getByRole('button', { name: 'Not moving on' }).click();
  await page.getByRole('button', { name: 'Save correction' }).click();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.screenshot({ path: path.join(outDir, '5-run.png'), fullPage: true });
  // Mock: fast-forward. Load demo candidates, then let days pass.
  await page.getByRole('button', { name: 'Mock', exact: true }).click();
  await page.getByRole('button', { name: 'Load demo candidates' }).click();
  await page.waitForSelector('text=Demo candidates loaded');
  await page.screenshot({ path: path.join(outDir, '9-mock-demo.png'), fullPage: false });
  await page.getByRole('button', { name: 'Next day ▸' }).click();
  await page.waitForFunction(() => !document.querySelector('.sidecar button[disabled]'));
  await page.waitForSelector('.sim-log li');
  await page.screenshot({ path: path.join(outDir, '10-fast-forward.png'), fullPage: false });
  await page.getByRole('button', { name: 'Close mock sidecar' }).click();
  // Sanne (demo): open drawer, book the pair if complete
  await page.getByRole('button', { name: 'Sanne de Vries (demo)', exact: true }).click();
  await page.waitForSelector('text=Interviewer requests');
  await page.screenshot({ path: path.join(outDir, '11-requests.png'), fullPage: false });
  const book = page.getByRole('button', { name: 'Book with this pair' });
  if (await book.count()) { await book.click(); await page.getByRole('button', { name: 'Save step' }).click(); }
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  // Skip a week: interviews happen and feedback comes in.
  await page.getByRole('button', { name: /^Mock/ }).click();
  await page.getByRole('button', { name: 'Skip a week ▸▸' }).click();
  await page.waitForFunction(() => !document.querySelector('.sidecar button[disabled]'));
  const simFb = await page.evaluate(() => window.FluxApp.state().state.notes.filter((n) => n.mock && n.kind === 'feedback').length);
  console.log('mock feedback notes after a week:', simFb);
  await page.screenshot({ path: path.join(outDir, '12-week-later.png'), fullPage: false });
  const accepted = await page.evaluate(() => { const S = window.FluxApp.state(); const i = S.state.invites.find((x) => x.status === 'accepted'); return i ? { person: i.personId, date: i.slotDate } : null; });
  await page.getByRole('button', { name: 'Back to real today' }).click();
  await page.getByRole('button', { name: 'Close mock sidecar' }).click();

  // Campaign rules: Natalie edits the advisor round to 10 days.
  await page.goto(page_url + '#campaign');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.fill('#r-max-0', '10');
  await page.getByRole('button', { name: 'Save rules' }).click();
  await page.waitForSelector('text=Rules saved');
  await page.waitForSelector('text=10 days');
  await page.goto(page_url + '#run');

  // Natalie switches to the advisor view from the top bar.
  const who = accepted ? accepted.person : await page.evaluate(() => window.FluxApp.state().state.people.find((p) => (p.roles || []).includes('advisor')).id);
  await page.evaluate((pid) => {
    const S = window.FluxApp.state();
    const daan = S.state.candidates.find((c) => c.name.startsWith('Daan'));
    const d = new Date(Date.now() + 9 * 864e5).toISOString().slice(0, 10);
    return S.add('invites', { campaignId: daan.campaignId, candidateId: daan.id, round: 'advisor', personId: pid, slotDate: d, time: '14:00', room: 'Room 2', status: 'pending', sentAt: new Date().toISOString(), via: 'outlook', mock: true });
  }, who);
  await page.getByRole('button', { name: 'Advisor', exact: true }).click();
  await page.waitForSelector('text=Requests for you');
  await page.selectOption('#view-as', who);
  await page.waitForSelector('text=Team board');
  await page.screenshot({ path: path.join(outDir, '14-interviewer-preview.png'), fullPage: true });
  if (await page.getByText('Add candidate').count()) errors.push('admin controls visible in interviewer view');
  await page.getByRole('button', { name: 'How interviews are planned (rounds and rules)' }).click();
  await page.waitForSelector('text=Natalie sets these');
  if (await page.getByRole('button', { name: 'Edit', exact: true }).count()) errors.push('interviewer can edit rules');
  await page.getByRole('button', { name: 'Team lead', exact: true }).click();
  await page.waitForSelector('text=/Team lead ·/');
  await page.screenshot({ path: path.join(outDir, '14b-teamlead-preview.png'), fullPage: false });
  await page.getByRole('button', { name: 'Admin', exact: true }).click();
  await page.waitForSelector('text=To do');
  await page.goto(page_url + '#campaign');
  await page.waitForSelector('text=Scoreboard');
  await page.screenshot({ path: path.join(outDir, '15-admin-scoreboard.png'), fullPage: true });

  // A real advisor signs in: link them, let Natalie's page write their inbox, then open as them.
  await page.evaluate((pid) => window.FluxApp.state().update('people', pid, { accountId: 'acct-1' }), who);
  await page.waitForFunction(() => {
    try { return !!JSON.parse(localStorage.getItem('flux-scheduling-local-v1')).inbox['acct-1']; } catch (e) { return false; }
  }, null, { timeout: 10000 });
  console.log('storage', await page.evaluate(() => { localStorage.setItem('e2e.viewer', 'acct-1'); return [localStorage.getItem('e2e.viewer'), (localStorage.getItem('flux-scheduling-local-v1') || '').length, location.href]; }));
  await page.goto(page_url + '#run');
  await page.reload();
  await page.waitForSelector('text=Welcome to Flux Interviews');
  console.log('viewer state', await page.evaluate(() => { const S = window.FluxApp.state(); return JSON.stringify({ admin: S.admin, myId: S.myId, inbox: !!S.state.mine.inbox, camps: S.state.campaigns.length, url: location.href, flag: localStorage.getItem('e2e.viewer') }); }));
  await page.getByRole('button', { name: 'I’m in' }).click();
  await page.waitForSelector('text=Requests for you');
  if (await page.locator('#view-as').count()) errors.push('viewer sees the view switch');
  if (await page.getByRole('link', { name: 'Roster' }).count()) errors.push('viewer sees admin navigation');
  await page.getByRole('button', { name: 'Accept' }).first().click();
  await page.waitForSelector('text=You accepted');
  await page.screenshot({ path: path.join(outDir, '16-interviewer-real.png'), fullPage: true });
  await page.setViewportSize({ width: 400, height: 860 });
  await page.screenshot({ path: path.join(outDir, '17-interviewer-phone.png'), fullPage: true });
  if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) errors.push('interviewer view overflows on phone');
  await page.setViewportSize({ width: 1360, height: 900 });
  // Back as Natalie: the answer is applied to the invite.
  console.log('before admin reload', await page.evaluate(() => [localStorage.length, (localStorage.getItem('flux-scheduling-local-v1') || '').length, location.href]));
  await page.evaluate(() => localStorage.removeItem('e2e.viewer'));
  await page.reload();
  console.log('after admin reload', await page.evaluate(() => [localStorage.length, (localStorage.getItem('flux-scheduling-local-v1') || '').length, location.href]));
  await page.waitForFunction(() => {
    const S = window.FluxApp.state();
    return S && S.state.invites.some((i) => i.via === 'app' && i.status === 'accepted');
  }, null, { timeout: 10000 }).catch(() => errors.push('viewer answer was not applied'));

  // Roster: a person without Claude, availability set by hand
  await page.goto(page_url + '#roster');
  await page.getByRole('button', { name: '+ Person' }).click();
  await page.fill('#pf-name', 'Sophie');
  await page.selectOption('#pf-team', 'OM');
  await page.check('#pf-access-manual');
  await page.getByRole('button', { name: 'Add person' }).click();
  await page.waitForSelector('text=Save availability');
  await page.getByRole('button', { name: 'Fridays Hele dag' }).click();
  await page.getByRole('button', { name: 'Save availability' }).click();
  await page.waitForSelector('text=Availability saved for Sophie');
  await page.screenshot({ path: path.join(outDir, '6-roster.png'), fullPage: true });
  if (!(await page.getByText('Joined ✓').count())) errors.push('roster shows no joined member');
  // Reload: the welcome card must not come back.
  await page.reload();
  await page.waitForTimeout(300);
  if (await page.getByText('Welcome to Flux Interviews').count()) errors.push('welcome card shown twice');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(page_url + '#run');
  await page.screenshot({ path: path.join(outDir, '7-run-dark.png'), fullPage: true });
  await page.setViewportSize({ width: 400, height: 860 });
  await page.screenshot({ path: path.join(outDir, '8-phone.png'), fullPage: false });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  console.log('phone horizontal overflow:', overflow);
  console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
  await b.close();
})().catch(async (e) => {
  console.error('FAILED', e.message);
  if (global.__page) await global.__page.screenshot({ path: path.join(outDir, 'failed.png'), fullPage: true }).catch(() => {});
  if (global.__errors) console.error(global.__errors.join('\n'));
  process.exit(1);
});
