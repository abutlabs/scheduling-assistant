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

test('interview goals split the expected interviews per round and count what is done', () => {
  const people = [
    { id: 'a1', name: 'Ann', team: 'TM', roles: ['advisor'] },
    { id: 'a2', name: 'Bob', team: 'PM', roles: ['advisor'] },
    { id: 'a3', name: 'Cas', team: 'CP', roles: ['advisor'] },
    { id: 't1', name: 'Tim', team: 'TM', roles: ['teamlead'] },
    { id: 't2', name: 'Uma', team: 'PM', roles: ['teamlead'] },
  ];
  const camp = M.newCampaign({ name: 'X', targetInterviews: 4 });
  const booked = (step, slotDate, interviewers) => ({ id: step, step, at: slotDate, data: { slotDate, time: '10:00', interviewers } });
  const cands = [
    { id: 'c1', campaignId: camp.id, timeline: [booked('advisor_booked', '2026-11-02', ['a1', 'a2']), booked('deepdive_booked', '2026-11-09', ['t1', 't2'])] },
    { id: 'c2', campaignId: camp.id, timeline: [booked('advisor_booked', '2026-11-20', ['a1', 'a3'])] },
  ];
  const g = M.interviewGoals({ camp, cands, invites: [], people, today: '2026-11-10' });
  // Advisors: 4 interviews x 2 seats = 8 over 3 people -> 3, 3, 2 (adds up to the need).
  assert.deepEqual([g.a1.goal, g.a2.goal, g.a3.goal], [3, 3, 2]);
  // Deep dives: 60% of 4 = 2 interviews x 2 seats = 4 over 2 people -> 2 each.
  assert.deepEqual([g.t1.goal, g.t2.goal], [2, 2]);
  // A round can set its own expected count.
  const camp2 = { ...camp, rounds: camp.rounds.map((r) => (r.key === 'deepdive' ? { ...r, expected: 4 } : r)) };
  assert.equal(M.expectedInterviews(camp2, camp2.rounds.find((r) => r.key === 'deepdive')), 4);
  assert.deepEqual([M.interviewGoals({ camp: camp2, cands, invites: [], people, today: '2026-11-10' }).t1.goal], [4]);
  // Held by 10 Nov: a1 and a2 once, t1 once. a1 and a3 have one planned.
  assert.deepEqual([g.a1.done, g.a2.done, g.a3.done, g.t1.done], [1, 1, 0, 1]);
  assert.deepEqual([g.a1.planned, g.a3.planned], [1, 1]);
});

test('slot suggestions need a free pair from different teams and ask those furthest from their goal', () => {
  const members = [
    { id: 'a', name: 'Ann', team: 'TM' },
    { id: 'b', name: 'Bob', team: 'TM' },
    { id: 'c', name: 'Cas', team: 'PM' },
    { id: 'd', name: 'Dirk', team: 'CP' },
  ];
  const free = { '2026-11-26|10:00': ['a', 'b'], '2026-11-27|10:00': ['a', 'b', 'c', 'd'], '2026-11-27|14:00': ['b', 'c'] };
  const res = M.suggestSlots({
    options: [{ date: '2026-11-26', time: '10:00' }, { date: '2026-11-27', time: '10:00' }, { date: '2026-11-27', time: '14:00' }],
    members,
    freeOn: (id, d, t) => (free[`${d}|${t}`] || []).includes(id),
    need: (id) => ({ a: 1, b: 3, c: 2, d: 0 })[id],
    load: () => 0,
    interviewers: 2,
    perSlot: 3,
  });
  // Thursday has only TM people free, so it isn't offered.
  assert.deepEqual(res.map((x) => `${x.date} ${x.time}`), ['2026-11-27 10:00', '2026-11-27 14:00']);
  // One per team, furthest from goal first: Bob (TM, 3 left), Cas (PM), Dirk (CP).
  assert.deepEqual(res[0].ask, ['b', 'c', 'd']);
});

test('outlook links and calendar files carry the slot, people and room', () => {
  assert.deepEqual(M.slotTimes('2026-11-27', '14:30', 60), { start: '2026-11-27T14:30:00', end: '2026-11-27T15:30:00' });
  const url = new URL(M.outlookMeetingLink({ subject: 'Hold: advisor interview', body: 'Hi', date: '2026-11-27', time: '10:00', durationMin: 60, location: 'Room 1', to: ['a@flux.nl', '', 'room1@flux.nl'] }));
  assert.equal(url.host, 'outlook.office.com');
  assert.equal(url.searchParams.get('startdt'), '2026-11-27T10:00:00');
  assert.equal(url.searchParams.get('enddt'), '2026-11-27T11:00:00');
  assert.equal(url.searchParams.get('to'), 'a@flux.nl,room1@flux.nl');
  assert.ok(!url.search.includes('+'), 'spaces are %20, not +');
  assert.equal(url.searchParams.get('subject'), 'Hold: advisor interview');
  const mail = new URL(M.outlookMailLink({ to: ['b@flux.nl'], subject: 'Released', body: 'Thanks' }));
  assert.equal(mail.pathname, '/mail/deeplink/compose');
  const ics = M.icsEvent({ uid: 'inv1@flux', method: 'CANCEL', subject: 'Hold; advisor', date: '2026-11-27', time: '10:00', durationMin: 60, attendees: ['a@flux.nl'] });
  assert.match(ics, /METHOD:CANCEL/);
  assert.match(ics, /DTSTART;TZID=Europe\/Amsterdam:20261127T100000/);
  assert.match(ics, /SUMMARY:Hold\\; advisor/);
  assert.match(ics, /STATUS:CANCELLED/);
});

test('rooms in use: bookings, holds and waiting requests in the same hour clash', () => {
  const cands = [{ id: 'c1', campaignId: 'k', timeline: [{ id: 'e1', step: 'advisor_booked', at: '2026-11-20', data: { slotDate: '2026-11-27', time: '10:00', room: 'Room 1', interviewers: ['p1', 'p2'] } }] }, { id: 'c2', campaignId: 'k', timeline: [] }, { id: 'c3', campaignId: 'k', timeline: [] }];
  const invites = [{ id: 'i1', candidateId: 'c2', round: 'advisor', personId: 'p3', slotDate: '2026-11-27', time: '10:30', room: 'Room 2', status: 'pending' }, { id: 'i2', candidateId: 'c2', round: 'advisor', personId: 'p4', slotDate: '2026-11-27', time: '14:00', room: 'Room 1', status: 'declined' }];
  const busy = M.roomsInUse({ cands, invites, date: '2026-11-27', time: '10:00', exceptCandidateId: 'c3' });
  assert.deepEqual([...busy.keys()].sort(), ['Room 1', 'Room 2']);
  assert.equal(busy.get('Room 1').candidateId, 'c1');
  assert.equal(M.roomsInUse({ cands, invites, date: '2026-11-27', time: '11:00', exceptCandidateId: 'c3' }).size, 1);
  assert.equal(M.roomsInUse({ cands, invites, date: '2026-11-27', time: '14:00', exceptCandidateId: 'c3' }).size, 0);
  assert.equal(M.roomsInUse({ cands, invites, date: '2026-11-27', time: '10:00', exceptCandidateId: 'c1' }).size, 1);
});

test('campaign metrics: funnel, speed, requests and feedback', () => {
  const e = (step, at, outcome, data) => ({ id: step + at, step, at, outcome: outcome || null, data });
  const cands = [
    { id: 'a', name: 'A', timeline: [e('hr_done', '2026-11-02', 'pass'), e('avail_asked_r2', '2026-11-02'), e('avail_received_r2', '2026-11-03'), e('advisor_booked', '2026-11-04', null, { slotDate: '2026-11-06', time: '10:00', room: 'Room 1', interviewers: ['p1', 'p2'] }), e('advisor_done', '2026-11-06', 'pass'), e('result_call_r2', '2026-11-06'), e('deepdive_booked', '2026-11-09', null, { slotDate: '2026-11-12', time: '14:00', room: 'Room 2', interviewers: ['t1', 't2'] }), e('deepdive_done', '2026-11-12', 'hire')] },
    { id: 'b', name: 'B', timeline: [e('hr_done', '2026-11-02', 'pass'), e('avail_asked_r2', '2026-11-02'), e('avail_received_r2', '2026-11-05'), e('advisor_booked', '2026-11-06', null, { slotDate: '2026-11-13', time: '10:00', room: 'Room 1', interviewers: ['p1', 'p3'] }), e('advisor_done', '2026-11-13', 'reject')] },
    { id: 'c', name: 'C', timeline: [e('hr_done', '2026-11-10', 'reject')] },
  ];
  const people = [{ id: 'p1', team: 'TM' }, { id: 'p2', team: 'PM' }, { id: 'p3', team: 'OM' }, { id: 't1', team: 'TM' }, { id: 't2', team: 'PM' }];
  const invites = [
    { candidateId: 'a', status: 'accepted', sentAt: '2026-11-04T08:00:00Z', respondedAt: '2026-11-04T12:00:00Z' },
    { candidateId: 'a', status: 'released', sentAt: '2026-11-04T08:00:00Z', noticeDays: 2, slotDate: '2026-11-06' },
    { candidateId: 'b', status: 'declined', declineReason: 'Client meeting', sentAt: '2026-11-06T08:00:00Z', respondedAt: '2026-11-06T16:00:00Z' },
  ];
  const notes = [{ kind: 'feedback', candidateId: 'a', round: 'advisor', authorPersonId: 'p1', createdAt: '2026-11-07T09:00:00Z' }];
  const m = M.campaignMetrics({ camp: { targetHires: 10, targetInterviews: 25, startDate: '2026-11-02' }, cands, invites, notes, people, today: '2026-11-20' });
  assert.deepEqual(m.funnel.map((r) => r.n), [3, 2, 1, 1, 0]);
  assert.equal(m.funnel[1].ofPrev, 2 / 3);
  assert.equal(m.interviewsHeld, 3);
  assert.equal(m.speed.toAdvisor, 7.5);
  assert.equal(m.speed.toOffer, 10);
  assert.deepEqual(m.onTime.advisor, { met: 1, all: 2, share: 0.5 });
  assert.equal(m.requests.acceptShare, 0.5);
  assert.equal(m.requests.replyHours, 6);
  assert.equal(m.requests.releaseNoticeDays, 2);
  assert.equal(m.feedback.expected, 6);
  assert.equal(m.feedback.given, 1);
  assert.equal(m.feedback.days, 1);
  assert.equal(m.load.max, 2);
  assert.deepEqual(m.weeks.map((w) => w.n), [1, 2, 0]);
});

test('reply writes: answers, feedback and reports apply once', () => {
  const people = [{ id: 'p1', accountId: 'u_a', team: 'TM' }, { id: 'p2', accountId: 'u_b', team: 'PM' }];
  const candidates = [{ id: 'c1', campaignId: 'k', timeline: [{ id: 'e', step: 'advisor_booked', at: '2026-11-20', data: { slotDate: '2026-11-23', time: '10:00', interviewers: ['p1', 'p2'] } }] }];
  const invites = [
    { id: 'i1', candidateId: 'c1', personId: 'p1', status: 'pending' },
    { id: 'i2', candidateId: 'c1', personId: 'p2', status: 'accepted' },
    { id: 'i3', candidateId: 'c1', personId: 'p2', status: 'pending' },
  ];
  const replies = [
    { id: 'u_a', invites: { i1: { status: 'accepted', at: '2026-11-24T08:00:00Z' }, i3: { status: 'declined' } }, feedback: { f1: { candidateId: 'c1', round: 'advisor', text: 'Strong' }, f2: { candidateId: 'zz', round: 'advisor', text: 'x' } }, reports: { rp_1: { note: 'Button' } } },
    { id: 'u_stranger', invites: { i3: { status: 'accepted' } } },
  ];
  const w = M.planReplyWrites({ replies, people, invites, candidates, notes: [], reports: [], now: '2026-11-24T09:00:00Z' });
  assert.deepEqual(w.map((x) => `${x.op} ${x.collection}/${x.doc_id}`), ['set reports/rp_1', 'update invites/i1', 'set notes/no_u_a:f1']);
  assert.equal(w[1].data.status, 'accepted');
  assert.equal(w[2].data.authorPersonId, 'p1');
  const again = M.planReplyWrites({ replies, people, invites: [{ ...invites[0], status: 'accepted' }, invites[1], invites[2]], candidates, notes: [{ id: 'no_u_a:f1', replyKey: 'u_a:f1' }], reports: [{ id: 'rp_1' }] });
  assert.equal(again.length, 0);
});

test('pasted emails match the roster by name or address', () => {
  const people = [{ id: 'k', name: 'Koen' }, { id: 'kb', name: 'Koen B' }, { id: 'm', name: 'Marnix', aliases: ['Marnix de Wit'] }, { id: 'e', name: 'Eveline' }];
  const r = M.matchEmails('Marnix de Wit <m.dewit@flux.nl>\nkoen.bakker@flux.nl\nEveline@Flux.nl; koen@flux.nl\nno email here\nunknown.person@flux.nl', people);
  assert.deepEqual(r.map((x) => [x.email, x.personId]), [['m.dewit@flux.nl', 'm'], ['koen.bakker@flux.nl', 'kb'], ['eveline@flux.nl', 'e'], ['koen@flux.nl', 'k'], ['unknown.person@flux.nl', null]]);
});

test('campaign metrics: where time goes per step, and who is stuck', () => {
  const e = (step, at, outcome, data) => ({ id: step + at, step, at, outcome: outcome || null, data });
  const cands = [
    { id: 'a', name: 'A', timeline: [e('hr_done', '2026-11-02', 'pass'), e('avail_asked_r2', '2026-11-02'), e('avail_received_r2', '2026-11-05'), e('advisor_booked', '2026-11-06', null, { slotDate: '2026-11-10', interviewers: [] }), e('advisor_done', '2026-11-11', 'pass')] },
    { id: 'b', name: 'B', timeline: [e('hr_done', '2026-11-02', 'pass'), e('avail_asked_r2', '2026-11-03'), e('avail_received_r2', '2026-11-04'), e('advisor_booked', '2026-11-09', null, { slotDate: '2026-11-12', interviewers: [] })] },
    { id: 'c', name: 'C', timeline: [e('hr_done', '2026-11-16', 'pass'), e('avail_asked_r2', '2026-11-16')] },
  ];
  const m = M.campaignMetrics({ camp: {}, cands, invites: [], notes: [], people: [], today: '2026-11-20' });
  const d = Object.fromEntries(m.delays.map((x) => [x.key, x]));
  assert.equal(d.cand_r2.median, 2);
  assert.deepEqual(d.cand_r2.stuck.map((x) => [x.candidateId, x.days]), [['c', 4]]);
  assert.equal(d.book_r2.median, 3);
  assert.equal(d.verdict_r2.n, 1);
  assert.deepEqual(d.verdict_r2.stuck.map((x) => x.candidateId), ['b']);
  assert.equal(m.slowest, 'book_r2');
});

test('reply writes: give up a hold early, ask Natalie to cancel a booked interview', () => {
  const people = [{ id: 'p1', accountId: 'u_a' }];
  const candidates = [
    { id: 'c1', campaignId: 'k', timeline: [] },
    { id: 'c2', campaignId: 'k', timeline: [{ id: 'e', step: 'advisor_booked', at: '2026-11-20', data: { slotDate: '2026-11-27', interviewers: ['p1', 'p9'] } }] },
  ];
  const invites = [
    { id: 'i1', candidateId: 'c1', round: 'advisor', personId: 'p1', status: 'accepted' },
    { id: 'i2', candidateId: 'c2', round: 'advisor', personId: 'p1', status: 'accepted' },
  ];
  const replies = [{ id: 'u_a', invites: { i1: { status: 'withdrawn', reason: 'Client workshop' }, i2: { status: 'withdrawn' } }, cancels: { x1: { candidateId: 'c2', round: 'advisor', reason: 'Sick' }, x2: { candidateId: 'c1', round: 'advisor', reason: 'not booked' } } }];
  const w = M.planReplyWrites({ replies, people, invites, candidates, notes: [], reports: [], now: '2026-11-24T09:00:00Z' });
  assert.deepEqual(w.map((x) => `${x.op} ${x.collection}/${x.doc_id}`), ['update invites/i1', 'set notes/nc_u_a:x1']);
  assert.equal(w[0].data.status, 'declined');
  assert.match(w[0].data.declineReason, /Client workshop/);
  assert.equal(w[1].data.kind, 'cancel_request');
});

test('pairGrid lists pairs from different teams per half-day', () => {
  const people = [
    { id: 'a', team: 'X' },
    { id: 'b', team: 'X' },
    { id: 'c', team: 'Y' },
  ];
  const free = { a: { am: true, pm: true }, b: { am: true, pm: false }, c: { am: true, pm: false } };
  const cells = M.pairGrid({ people, dates: ['2026-12-04'], freeOf: (id) => free[id] });
  const am = cells.find((c) => c.half === 'am');
  const pm = cells.find((c) => c.half === 'pm');
  assert.equal(am.free.length, 3);
  assert.deepEqual(am.pairs.map((p) => p.map((x) => x.id).join('+')), ['a+c', 'b+c']);
  assert.equal(pm.pairs.length, 0);
});
