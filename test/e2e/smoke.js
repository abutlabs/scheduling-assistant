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
  window.claude = { use: async (n) => (n === 'sample' ? sample : null) };
};

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1360, height: 900 } });
  await ctx.route('https://cdnjs.cloudflare.com/**', (r) => r.fulfill({ path: xlsxLib, contentType: 'application/javascript' }));
  await ctx.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ body: '', contentType: 'text/css' }));
  await ctx.addInitScript(fakeClaude);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(page_url);
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
  await page.goto(page_url + '#roster');
  await page.screenshot({ path: path.join(outDir, '6-roster.png'), fullPage: true });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(page_url + '#run');
  await page.screenshot({ path: path.join(outDir, '7-run-dark.png'), fullPage: true });
  await page.setViewportSize({ width: 400, height: 860 });
  await page.screenshot({ path: path.join(outDir, '8-phone.png'), fullPage: false });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  console.log('phone horizontal overflow:', overflow);
  console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
  await b.close();
})().catch(async (e) => { console.error('FAILED', e.message); process.exit(1); });
