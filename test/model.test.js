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

test('invite state finds a different-team pair and what to release', () => {
  const inv = (id, personId, status, respondedAt, sentAt) => ({ id, personId, status, respondedAt, sentAt: sentAt || '2026-11-20T09:00:00Z' });
  let st = M.inviteState([inv('a', 'p1', 'accepted', '1'), inv('b', 'p5', 'pending'), inv('c', 'p2', 'pending')], roster, { today: '2026-11-21' });
  assert.equal(st.complete, false);
  assert.deepEqual(st.toRelease.map((r) => [r.invite.id, r.why]), [['b', 'same_team']]);
  assert.equal(st.overdue.length, 0);
  st = M.inviteState([inv('a', 'p1', 'accepted', '1'), inv('b', 'p5', 'pending'), inv('c', 'p2', 'accepted', '2'), inv('d', 'p4', 'pending')], roster);
  assert.equal(st.complete, true);
  assert.deepEqual(st.pair, ['p1', 'p2']);
  assert.deepEqual(st.toRelease.map((r) => r.invite.id).sort(), ['b', 'd']);
  st = M.inviteState([inv('a', 'p1', 'declined'), inv('c', 'p2', 'pending')], roster, { today: '2026-11-23' });
  assert.equal(st.shortBy, 1);
  assert.equal(st.overdue.length, 1);
});

test('scoreboard: points, ranks within team, fair share, feedback on time', () => {
  const people = [
    { id: 'a', name: 'A', team: 'TM', roles: ['advisor'] },
    { id: 'b', name: 'B', team: 'TM', roles: ['advisor'] },
    { id: 'c', name: 'C', team: 'PM', roles: ['advisor'] },
    { id: 'n', name: 'Natalie', team: 'P&C', roles: [] },
  ];
  const ev = (step, at, data) => ({ id: step, step, at, recordedAt: at, data });
  const cands = [
    { id: 'k1', campaignId: 'c1', name: 'K One', timeline: [{ ...ev('hr_done', '2026-11-01'), outcome: 'pass' }, ev('advisor_booked', '2026-11-02', { slotDate: '2026-11-06', time: '10:00', interviewers: ['a', 'c'] })] },
    { id: 'k2', campaignId: 'c1', name: 'K Two', timeline: [] },
  ];
  const invites = [
    { id: 'i1', candidateId: 'k1', round: 'advisor', personId: 'a', status: 'accepted', sentAt: '2026-11-02T09:00:00Z', respondedAt: '2026-11-02T12:00:00Z', slotDate: '2026-11-06' },
    { id: 'i2', candidateId: 'k1', round: 'advisor', personId: 'c', status: 'accepted', sentAt: '2026-11-02T09:00:00Z', respondedAt: '2026-11-05T09:00:00Z', slotDate: '2026-11-06' },
    { id: 'i3', candidateId: 'k2', round: 'advisor', personId: 'b', status: 'accepted', sentAt: '2026-11-10T09:00:00Z', respondedAt: '2026-11-10T10:00:00Z', slotDate: '2026-11-30' },
  ];
  const notes = [{ kind: 'feedback', personId: 'a', candidateId: 'k1', round: 'advisor', createdAt: '2026-11-06T16:00:00Z' }];
  const sb = M.scoreboard({ cands, invites, notes, people, today: '2026-11-20' });
  const a = sb.people.find((x) => x.personId === 'a');
  const c = sb.people.find((x) => x.personId === 'c');
  const b = sb.people.find((x) => x.personId === 'b');
  assert.equal(a.points, 10 + 3 + 3);
  assert.equal(c.points, 10);
  assert.equal(b.done, 0);
  assert.equal(b.upcoming, 1);
  assert.equal(a.rank, 1);
  assert.equal(a.of, 3);
  assert.equal(a.teamRank, 1);
  assert.equal(b.teamRank, 2);
  assert.equal(c.rank, 2);
  assert.equal(b.teamOf, 2);
  assert.equal(c.feedbackDue, 1);
  assert.equal(c.feedbackOnTime, 0);
  assert.equal(sb.totalDone, 2);
  assert.equal(sb.people.length, 3, 'people without interviewer roles are left out');
  const tm = sb.teams.find((t) => t.team === 'TM');
  assert.equal(tm.pointsPerMember, 9.5);
  assert.equal(sb.teams[0].team, 'PM');
  assert.equal(M.interviewsOf(cands, invites).length, 3);
  assert.deepEqual(M.pipelineCounts(cands, '2026-11-20'), { total: 2, hr: 1, advisor: 1, deepdive: 0, hired: 0, closed: 0 });
});

test('hiring goals add up to at least the campaign target and count hires', () => {
  const people = [
    { id: 'a1', name: 'Ann', team: 'TM', roles: ['advisor'] },
    { id: 'a2', name: 'Bob', team: 'PM', roles: ['advisor'] },
    { id: 'a3', name: 'Cas', team: 'CP', roles: ['advisor'] },
    { id: 't1', name: 'Tim', team: 'TM', roles: ['teamlead'] },
    { id: 't2', name: 'Uma', team: 'PM', roles: ['teamlead'] },
  ];
  const camp = M.newCampaign({ name: 'X', targetHires: 4 });
  const booked = (step, slotDate, interviewers) => ({ id: step, step, at: slotDate, data: { slotDate, time: '10:00', interviewers } });
  const cands = [
    { id: 'c1', campaignId: camp.id, timeline: [booked('advisor_booked', '2026-11-02', ['a1', 'a2']), booked('deepdive_booked', '2026-11-09', ['t1', 't2']), { id: 'x', step: 'closed', at: '2026-11-12', outcome: 'hired' }] },
    { id: 'c2', campaignId: camp.id, timeline: [booked('advisor_booked', '2026-11-03', ['a1', 'a3'])] },
  ];
  const g = M.hiringGoals({ camp, cands, invites: [], people });
  // Advisors: 4 hires x 2 interviewers = 8 credits over 3 people -> 3, 3, 2.
  assert.deepEqual([g.a1.goal, g.a2.goal, g.a3.goal], [3, 3, 2]);
  assert.equal(g.a1.goal + g.a2.goal + g.a3.goal, 8);
  // Team leads: 8 credits over 2 -> 4 each.
  assert.deepEqual([g.t1.goal, g.t2.goal], [4, 4]);
  // c1 was hired: its four interviewers get a hire; c2 isn't hired yet.
  assert.deepEqual([g.a1.hires, g.a2.hires, g.a3.hires, g.t1.hires], [1, 1, 0, 1]);
});
