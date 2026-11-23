const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/model.js');
const fixture = require('./fixtures/poll-sample.json');

const roster = [
  { id: 'p1', name: 'Anna', team: 'TM', roles: ['advisor'], active: true },
  { id: 'p2', name: 'Bram', team: 'PM', roles: ['advisor'], active: true },
  { id: 'p3', name: 'Cees', team: 'OM', roles: ['advisor'], active: true },
  { id: 'p4', name: 'Dirk', team: 'OM', roles: ['advisor'], active: true },
  { id: 'p5', name: 'Eva', team: 'TM', roles: ['advisor'], active: true },
  { id: 'p6', name: 'Frank', team: 'TM', roles: ['teamlead'], active: true },
  { id: 'p7', name: 'Gerda', team: 'P&C', roles: ['joker'], active: true },
  { id: 'p8', name: 'Hans', team: 'PM', roles: ['teamlead'], active: true },
];

test('day headers resolve to dates around the poll date', () => {
  assert.equal(M.parseDayHeader('ma 9-11', '2026-11-06').date, '2026-11-09');
  assert.equal(M.parseDayHeader('vr 4-12', '2026-11-06').date, '2026-12-04');
  assert.equal(M.parseDayHeader('ma 4-1', '2026-12-15').date, '2027-01-04');
  assert.equal(M.parseDayHeader('Opmerking', '2026-11-06'), null);
  assert.equal(M.parseDayHeader('di 10-11', '2026-11-06').weekdayMatches, true);
  assert.equal(M.parseDayHeader('di 11-11', '2026-11-06').weekdayMatches, false);
});

test('cell values normalise, lowercase is fixed, unknown is flagged', () => {
  assert.deepEqual(M.normalizeValue('Hele dag'), { value: 'all' });
  assert.equal(M.normalizeValue('middag').fixed, true);
  assert.equal(M.normalizeValue('middag').value, 'pm');
  assert.equal(M.normalizeValue('Misschien').unknown, true);
  assert.equal(M.normalizeValue(null).value, null);
});

test('parsePoll skips example and summary rows', () => {
  const d = M.parsePoll(fixture.sheets, { pollDate: M.pollDateFromFileName(fixture.fileName) });
  assert.equal(d.pollDate, '2026-11-06');
  assert.equal(d.tabs.length, 2);
  assert.deepEqual(d.tabs[0].entries.map((e) => e.name), ['Anna', 'Bram', 'Cees', 'Dirk', 'Eva B']);
  assert.equal(d.tabs[0].role, 'advisor');
  assert.equal(d.tabs[1].role, 'teamlead');
  assert.equal(d.from, '2026-11-30');
  assert.equal(d.to, '2026-12-04');
  assert.equal(d.tabs[0].entries[1].cells['2026-12-03'], 'pm');
});

test('reviewDraft flags unknown names, team clashes, blanks and typos', () => {
  const d = M.parsePoll(fixture.sheets, { pollDate: '2026-11-06' });
  const r = M.reviewDraft(d, roster, {});
  const kinds = (k) => r.issues.filter((i) => i.kind === k);
  assert.equal(kinds('unknown_name').length, 1); // Eva B
  assert.equal(kinds('unknown_name')[0].suggestions[0].id, 'p5');
  assert.equal(kinds('team_mismatch').length, 1); // Cees CP vs OM
  assert.equal(kinds('no_response').length, 1);
  assert.equal(kinds('none_available').length, 1);
  assert.equal(kinds('value_fixed').length, 1);
  assert.equal(kinds('unknown_value').length, 1);
  assert.equal(kinds('missing_from_sheet').map((i) => i.personId).join(), 'p5,p8');
  assert.equal(r.blocking, 1);
  const evaKey = d.tabs[0].entries[4].key;
  const r2 = M.reviewDraft(d, roster, { [evaKey]: { action: 'match', personId: 'p5' } });
  assert.equal(r2.blocking, 0);
  assert.equal(r2.matches[evaKey].person.id, 'p5');
});

test('remark suggestions are validated against poll dates', () => {
  const d = M.parsePoll(fixture.sheets, { pollDate: '2026-11-06' });
  const { prompt, count } = M.buildRemarkPrompt(d);
  assert.equal(count, 2);
  assert.match(prompt, /op vrijdag 4-12/);
  const anna = d.tabs[0].entries[0].key;
  const eva = d.tabs[0].entries[4].key;
  const out = M.cleanRemarkSuggestions([
    { row: anna, kind: 'window', dates: ['2026-12-04'], from: '14', to: '15.30', summary: 'Fri 4 Dec only 14:00-15:30' },
    { row: eva, kind: 'window', dates: ['2026-12-02', '2027-01-01'], to: '12:00' },
    { row: 'nope', kind: 'window', dates: ['2026-12-04'], from: '9:00' },
    { row: anna, kind: 'window', dates: ['2026-12-04'] },
  ], d);
  assert.equal(out.length, 2);
  assert.equal(out[0].from, '14:00');
  assert.equal(out[0].to, '15:30');
  assert.deepEqual(out[1].dates, ['2026-12-02']);
  const confirmed = { ...out[0], status: 'confirmed' };
  const cell = M.effectiveCell('pm', [confirmed], '2026-12-04');
  assert.equal(cell.window.from, '14:00');
  assert.equal(M.effectiveCell('pm', [{ ...confirmed, kind: 'unavailable', from: null, to: null }], '2026-12-04').value, 'no');
});

test('day coverage knows when a different-team pair is possible', () => {
  const rows = [
    { team: 'TM', cells: { d: 'am' }, rules: [] },
    { team: 'TM', cells: { d: 'all' }, rules: [] },
    { team: 'PM', cells: { d: 'pm' }, rules: [] },
  ];
  const c = M.dayCoverage(rows, 'd');
  assert.equal(c.am, 2);
  assert.equal(c.pairAm, false);
  assert.equal(c.pairPm, true);
});

function cand(steps) {
  return { name: 'Sanne de Vries', timeline: steps.map(([step, at, outcome, data], i) => ({ id: 'e' + i, step, at, outcome, data, recordedAt: at })) };
}

test('candidate state walks the main path', () => {
  let s = M.candidateState(cand([]), '2026-11-23');
  assert.equal(s.next, 'hr_done');
  assert.equal(s.prompt, 'Record HR result for Sanne');
  s = M.candidateState(cand([['hr_done', '2026-11-20', 'pass'], ['avail_asked_r2', '2026-11-20']]), '2026-11-25');
  assert.equal(s.next, 'avail_received_r2');
  assert.equal(s.stage, 'advisor');
  assert.equal(s.clock.deadline, '2026-11-27');
  assert.equal(s.clock.daysLeft, 2);
  assert.equal(s.clock.state, 'urgent');
  s = M.candidateState(cand([['hr_done', '2026-11-20', 'pass'], ['avail_asked_r2', '2026-11-20'], ['advisor_booked', '2026-11-21', null, { slotDate: '2026-11-27' }]]), '2026-11-22');
  assert.equal(s.next, 'advisor_done');
  assert.deepEqual(s.skipped, ['avail_received_r2']);
  assert.equal(s.clock.state, 'booked');
});

test('a reject routes to a call and then closing', () => {
  let s = M.candidateState(cand([['hr_done', '2026-11-20', 'reject']]));
  assert.equal(s.next, 'reject_call_hr');
  assert.equal(s.clock, null);
  s = M.candidateState(cand([['hr_done', '2026-11-20', 'reject'], ['reject_call_hr', '2026-11-21']]));
  assert.equal(s.next, 'closed');
  s = M.candidateState(cand([['hr_done', '2026-11-20', 'pass'], ['advisor_done', '2026-11-26', 'reject']]));
  assert.equal(s.next, 'result_call_r2');
  assert.equal(s.prompt, 'Call Sanne: not moving on');
  s = M.candidateState(cand([['hr_done', '2026-11-20', 'pass'], ['advisor_done', '2026-11-26', 'pass'], ['result_call_r2', '2026-11-26'], ['deepdive_done', '2026-12-02', 'hire'], ['final_call', '2026-12-02'], ['closed', '2026-12-03', 'hired']]));
  assert.equal(s.next, null);
  assert.equal(s.status, 'hired');
  assert.equal(s.stage, 'hired');
});

test('re-recording a step replaces the earlier entry', () => {
  const c = cand([['hr_done', '2026-11-20', 'reject'], ['hr_done', '2026-11-20', 'pass']]);
  c.timeline[1].recordedAt = '2026-11-21T10:00:00Z';
  assert.equal(M.candidateState(c).done.hr_done.outcome, 'pass');
});

test('pair check catches same-team interviewers', () => {
  const round = M.DEFAULT_ROUNDS[0];
  assert.deepEqual(M.pairProblems(['p1', 'p5'], roster, round), ['Two interviewers are from the same team.']);
  assert.deepEqual(M.pairProblems(['p1', 'p2'], roster, round), []);
});

test('funnel counts stages', () => {
  const f = M.funnel([
    cand([['hr_done', '2026-11-20', 'pass']]),
    cand([['hr_done', '2026-11-20', 'reject']]),
    cand([['hr_done', '2026-11-20', 'pass'], ['advisor_done', '2026-11-26', 'pass']]),
  ]);
  assert.equal(f.total, 3);
  assert.equal(f.passedHr, 2);
  assert.equal(f.passedAdvisor, 1);
});
