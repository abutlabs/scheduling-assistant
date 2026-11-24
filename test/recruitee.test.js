const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../src/recruitee.js');
const M = require('../src/model.js');

const people = [
  { id: 'a1', name: 'Anna de Boer', team: 'TM', roles: ['advisor'], email: 'anna@flux.nl' },
  { id: 'a2', name: 'Bram Smit', team: 'PM', roles: ['advisor'] },
  { id: 'a3', name: 'Cees Kok', team: 'OM', roles: ['advisor'] },
  { id: 't1', name: 'Frank Dijk', team: 'TM', roles: ['teamlead'] },
  { id: 't2', name: 'Hans Vos', team: 'PM', roles: ['teamlead'] },
];
const T = '2026-11-24';

test('stage names map to rounds, Dutch and English', () => {
  assert.equal(R.roundOfStage('Competentiegesprek adviseurs', 'interview'), 'advisor');
  assert.equal(R.roundOfStage('Deep dive teamleads', 'interview'), 'deepdive');
  assert.equal(R.roundOfStage('Video-interview HR', 'phone_screen'), 'hr');
  assert.equal(R.roundOfStage('Aangenomen', 'hire'), 'hired');
  assert.equal(R.roundOfStage('Something', 'interview'), 'advisor');
  assert.equal(R.roundOfStage('Something', 'interview', { Something: 'deepdive' }), 'deepdive');
});

test('mock data syncs into lite candidates with bookings matched to the roster', () => {
  const mock = R.mockRecruitee(T, people);
  const offer = R.normalizeOffers(mock.offers)[0];
  const cands = R.normalizeCandidates({ candidates: mock.candidates }, offer.id, offer.stages, '');
  const events = R.normalizeEvents(mock.events);
  const plan = R.planSync({ offer, candidates: cands, events, people, campaignId: 'c1', existing: [], now: `${T}T09:00:00Z` });
  const byName = Object.fromEntries(plan.docs.map((d) => [d.doc.name, d.doc]));
  // HR and applied candidates aren't planned yet.
  assert.equal(byName['Hugo Wessels'], undefined);
  assert.equal(byName['Jesse Kok'], undefined);
  assert.equal(plan.counts.earlier, 3);
  // Anne: advisor round, interview booked with two advisors from different teams.
  const anne = M.candidateState(byName['Anne van der Woude'], T);
  assert.equal(anne.stage, 'advisor');
  const b = anne.done.advisor_booked.data;
  assert.equal(b.interviewers.length, 2);
  assert.equal(b.time, '10:00');
  assert.equal(anne.next, 'advisor_done');
  // Tim: advisor round, nothing booked yet: needs a pair.
  assert.equal(M.candidateState(byName['Tim van der Vuurst'], T).next, 'advisor_booked');
  // Milan: deep dive with two team leads booked.
  const milan = M.candidateState(byName['Milan de Groot'], T);
  assert.equal(milan.stage, 'deepdive');
  assert.deepEqual(milan.done.deepdive_booked.data.interviewers.sort(), ['t1', 't2']);
  // Iris: offer stage counts as through the deep dive.
  assert.equal(M.candidateState(byName['Iris Mulder'], T).status, 'hired');
  // Noor: disqualified in the advisor round.
  assert.equal(M.candidateState(byName['Noor Hendriks'], T).status, 'rejected');
  // Lucas: booked with someone not on the roster.
  assert.ok(plan.counts.unmatched.includes('Onbekende Collega'));
  assert.equal(plan.docs.find((d) => d.doc.name === 'Lucas Zijlstra').id, 'rc_70004');
});

test('a re-sync keeps what Natalie recorded, and Recruitee bookings replace local ones', () => {
  const rc = { id: 1, name: 'X Y', stageName: 'Competentiegesprek', stageCategory: 'interview', stageChangedAt: `${T}T08:00:00Z` };
  const local = { step: 'advisor_booked', at: T, id: 'l1', data: { slotDate: '2026-11-27', time: '10:00', interviewers: ['a1', 'a2'] } };
  const existing = { id: 'rc_1', createdAt: '2026-11-20', timeline: [local, { step: 'hr_done', id: 'rc-hr_done', source: 'recruitee', at: '2026-11-01', outcome: 'pass' }] };
  let doc = R.toCandidateDoc({ rc, events: [], people, campaignId: 'c', existing, now: `${T}T09:00:00Z` });
  assert.equal(doc.timeline.filter((e) => e.step === 'hr_done').length, 1);
  assert.ok(doc.timeline.find((e) => e.id === 'l1'));
  // Recruitee now has the booking, with one person we can't match: the app keeps its pair.
  const ev = { id: 9, candidateId: 1, startsAt: '2026-11-27T10:00:00+01:00', endsAt: '', title: 'Competentiegesprek', location: 'Room 1', attendees: [{ name: 'Anna de Boer', email: '' }, { name: 'Somebody', email: '' }] };
  doc = R.toCandidateDoc({ rc, events: [ev], people, campaignId: 'c', existing, now: `${T}T09:00:00Z` });
  const booked = doc.timeline.filter((e) => e.step === 'advisor_booked');
  assert.equal(booked.length, 1);
  assert.equal(booked[0].source, 'recruitee');
  assert.deepEqual(booked[0].data.interviewers.sort(), ['a1', 'a2']);
  assert.equal(doc.createdAt, '2026-11-20');
});
