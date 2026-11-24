/*
 * Recruitee (Tellent ATS) read-only sync: shared by the page and the desktop
 * extension (tools/pack-extension.js copies this file into the bundle).
 *
 * Recruitee stays the system of record for candidates. The app reads three
 * things from it: the vacancy (offer) with its pipeline stages, the
 * candidates on that vacancy with their stage, and the interviews booked in
 * Recruitee's agenda. It writes nothing back.
 *
 *  normalizeOffers / normalizeCandidates / normalizeEvents
 *      Turn raw API JSON into small, stable shapes. Defensive: field names
 *      differ between list and detail endpoints, so several are tried.
 *  roundOfStage(name, category)
 *      Which interview round a pipeline stage belongs to.
 *  toCandidateDoc(...)
 *      One synced candidate as an app candidate (flow "lite") whose
 *      timeline is derived from the Recruitee stage and booked interviews.
 *  mockRecruitee(today)
 *      Raw-API-shaped mock data, used until a real token exists.
 */
(function (root) {
  'use strict';

  const pick = (...vals) => vals.find((v) => v !== undefined && v !== null && v !== '');
  const dateOf = (iso) => (iso ? String(iso).slice(0, 10) : '');
  // Local wall-clock time in the Netherlands for an ISO instant (interviews are booked in Dutch time).
  function amsterdamParts(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return { date: dateOf(iso), time: '' };
    try {
      const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
      const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
      return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
    } catch (e) {
      return { date: dateOf(iso), time: String(iso).slice(11, 16) };
    }
  }

  // ------------------------------------------------------------------
  // Stages
  // ------------------------------------------------------------------
  const ROUND_PATTERNS = [
    ['hired', /aangenomen|\bhired?\b|in dienst/i],
    ['offer', /aanbod|\boffer|contract/i],
    ['deepdive', /deep ?dive|team ?lead|eindgesprek|final|tweede gesprek|2e gesprek/i],
    ['advisor', /advis|adviseur|competentie|eerste gesprek|1e gesprek|kennismaking/i],
    ['hr', /hr|telefo|phone|screen|video/i],
  ];
  const CATEGORY_ROUND = { hire: 'hired', offer: 'offer', apply: 'applied', none: 'applied', phone_screen: 'hr', evaluation: 'hr' };
  /** Which round a pipeline stage stands for: applied, hr, advisor, deepdive, offer or hired. */
  function roundOfStage(name, category, overrides) {
    if (overrides && name && overrides[name]) return overrides[name];
    for (const [round, re] of ROUND_PATTERNS) if (re.test(name || '')) return round;
    return CATEGORY_ROUND[category] || (category === 'interview' ? 'advisor' : 'applied');
  }
  const ROUND_ORDER = ['applied', 'hr', 'advisor', 'deepdive', 'offer', 'hired'];

  // ------------------------------------------------------------------
  // Normalisers
  // ------------------------------------------------------------------
  function stagesOfOffer(o) {
    const list = pick(o.pipeline_template && o.pipeline_template.stages, o.pipeline && o.pipeline.stages, o.stages) || [];
    return list.map((s) => ({ id: s.id, name: s.name || '', category: s.category || '' }));
  }
  function normalizeOffers(raw) {
    const list = Array.isArray(raw) ? raw : (raw && (raw.offers || raw.data)) || [];
    return list.map((o) => ({
      id: o.id,
      title: pick(o.title, o.position, o.name) || `Vacancy ${o.id}`,
      status: o.status || '',
      kind: o.kind || 'job',
      candidatesCount: pick(o.candidates_count, o.candidates_count_total) || 0,
      stages: stagesOfOffer(o),
    }));
  }

  /**
   * Candidates on one offer, one row per placement on that offer.
   * `stages` (from the offer) names stage ids the candidate list leaves bare.
   */
  function normalizeCandidates(raw, offerId, stages, urlTemplate) {
    const list = Array.isArray(raw) ? raw : (raw && (raw.candidates || raw.data)) || [];
    const refs = (raw && raw.references) || [];
    const stageById = new Map();
    for (const s of stages || []) stageById.set(String(s.id), s);
    for (const r of refs) if (/stage/i.test(r.type || '')) stageById.set(String(r.id), { id: r.id, name: r.name || '', category: r.category || '' });
    const out = [];
    for (const c of list) {
      const placements = c.placements || [];
      const pl = placements.find((p) => String(p.offer_id) === String(offerId)) || (offerId ? null : placements[0]);
      if (!pl) continue;
      const st = pl.stage || stageById.get(String(pl.stage_id)) || {};
      out.push({
        id: c.id,
        name: pick(c.name, [c.first_name, c.last_name].filter(Boolean).join(' ')) || `Candidate ${c.id}`,
        email: pick((c.emails || [])[0], c.email) || '',
        offerId: pl.offer_id,
        stageId: pick(pl.stage_id, st.id) || null,
        stageName: st.name || '',
        stageCategory: st.category || '',
        disqualified: !!(pl.disqualified_at || pl.disqualify_reason || pl.disqualified),
        stageChangedAt: pick(pl.positioned_at, pl.stage_changed_at, pl.updated_at, c.updated_at, c.created_at) || '',
        // Candidate links in Tellent aren't documented; fill in a template once we see a real one.
        url: urlTemplate ? urlTemplate.replace('{id}', c.id) : '',
      });
    }
    return out;
  }

  function normalizeEvents(raw) {
    const list = Array.isArray(raw) ? raw : (raw && (raw.interview_events || raw.events || raw.data)) || [];
    return list
      .map((e) => {
        const startsAt = pick(e.starts_at, e.start_time, e.start, e.date);
        const endsAt = pick(e.ends_at, e.end_time, e.end);
        const people = [...(e.attendees || []), ...(e.admins || []), ...(e.interviewers || []), ...(e.participants || [])];
        return {
          id: e.id,
          candidateId: pick(e.candidate_id, e.candidate && e.candidate.id),
          offerId: pick(e.offer_id, e.offer && e.offer.id) || null,
          startsAt: startsAt || '',
          endsAt: endsAt || '',
          title: pick(e.title, e.name, e.subject) || '',
          location: pick(e.location, e.meeting_room && e.meeting_room.name, e.room) || '',
          attendees: people
            .filter((a) => a && !/candidate/i.test(a.type || a.role || ''))
            .map((a) => ({ name: pick(a.name, a.full_name, a.admin && a.admin.name) || '', email: String(pick(a.email, a.admin && a.admin.email) || '').toLowerCase() })),
          cancelled: !!(e.cancelled_at || e.status === 'cancelled' || e.canceled),
        };
      })
      .filter((e) => e.candidateId && e.startsAt && !e.cancelled);
  }

  // ------------------------------------------------------------------
  // Matching interviewers to the roster
  // ------------------------------------------------------------------
  const norm = (s) =>
    String(s || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  function matchPerson(att, people) {
    if (att.email) {
      const p = people.find((x) => (x.email || '').toLowerCase() === att.email);
      if (p) return p;
    }
    const n = norm(att.name);
    if (!n) return null;
    return people.find((x) => norm(x.name) === n || (x.aliases || []).some((a) => norm(a) === n)) || null;
  }
  const hasRole = (p, r) => (p.roles || []).includes(r) || (r === 'teamlead' && (p.roles || []).includes('joker'));

  /** Which round an interview is: by its title first, then by who sits on it. Null for an HR or unknown interview. */
  function roundOfEvent(ev, interviewers, currentRound) {
    if (/deep ?dive|team ?lead|eindgesprek|final/i.test(ev.title)) return 'deepdive';
    if (/advis|adviseur|competentie/i.test(ev.title)) return 'advisor';
    if (/video|\bhr\b|telefo|phone|screen/i.test(ev.title)) return null;
    const leads = interviewers.filter((p) => hasRole(p, 'teamlead') && !hasRole(p, 'advisor')).length;
    const advisors = interviewers.filter((p) => hasRole(p, 'advisor')).length;
    if (leads || advisors) return leads > advisors ? 'deepdive' : 'advisor';
    // Nobody on the roster: assume it's the round the candidate is in.
    return ev.attendees.length && (currentRound === 'advisor' || currentRound === 'deepdive') ? currentRound : null;
  }

  // ------------------------------------------------------------------
  // One synced candidate as an app candidate
  // ------------------------------------------------------------------
  /**
   * Returns null for candidates the app doesn't plan for (still before the
   * advisor round). Timeline entries carry `source: "recruitee"` and stable
   * ids, so a re-sync replaces them; entries Natalie recorded in the app
   * (a booking made from an accepted pair) are kept unless Recruitee has a
   * booking for the same round.
   */
  function toCandidateDoc({ rc, events, people, campaignId, existing, stageOverrides, now }) {
    const round = roundOfStage(rc.stageName, rc.stageCategory, stageOverrides);
    const mine = (events || []).filter((e) => String(e.candidateId) === String(rc.id));
    const booked = {};
    for (const ev of mine.sort((a, b) => a.startsAt.localeCompare(b.startsAt))) {
      const ivs = ev.attendees.map((a) => matchPerson(a, people)).filter(Boolean);
      const r = roundOfEvent(ev, ivs, round);
      if (!r) continue;
      const { date, time } = amsterdamParts(ev.startsAt);
      booked[r] = { eventId: ev.id, slotDate: date, time, room: ev.location, interviewers: [...new Set(ivs.map((p) => p.id))], unmatched: ev.attendees.filter((a) => !matchPerson(a, people)).map((a) => a.name || a.email) };
    }
    const reached = ROUND_ORDER.indexOf(round);
    const anyBooking = booked.advisor || booked.deepdive;
    if (reached < ROUND_ORDER.indexOf('advisor') && !anyBooking) return null;

    const stamp = now || new Date().toISOString();
    const since = dateOf(rc.stageChangedAt) || dateOf(stamp);
    const tl = [];
    const add = (step, at, outcome, data) => tl.push({ id: `rc-${step}`, step, at, outcome: outcome || null, note: '', recordedAt: stamp, source: 'recruitee', ...(data ? { data } : {}) });
    const atLeast = (r) => reached >= ROUND_ORDER.indexOf(r);
    const advisorDone = atLeast('deepdive');
    const ddDone = atLeast('offer');
    // The stage date is when they entered their current round; the advisor
    // round's 1-week clock starts there (or at its interview, once past it).
    const advisorStart = advisorDone && booked.advisor && booked.advisor.slotDate < since ? booked.advisor.slotDate : since;
    add('hr_done', advisorStart, 'pass');
    add('avail_received_r2', advisorStart);
    if (booked.advisor) add('advisor_booked', since <= booked.advisor.slotDate ? since : booked.advisor.slotDate, null, booked.advisor);
    if (advisorDone) add('advisor_done', since, 'pass');
    else if (rc.disqualified && round === 'advisor') add('advisor_done', since, 'reject');
    if (advisorDone) add('avail_received_final', since);
    if (booked.deepdive) add('deepdive_booked', since <= booked.deepdive.slotDate ? since : booked.deepdive.slotDate, null, booked.deepdive);
    if (ddDone) add('deepdive_done', since, 'hire');
    else if (rc.disqualified && round === 'deepdive') add('deepdive_done', since, 'reject');

    // Keep what Natalie recorded in the app, except bookings Recruitee now has.
    const local = ((existing && existing.timeline) || []).filter((e) => e.source !== 'recruitee' && !(e.step === 'advisor_booked' && booked.advisor) && !(e.step === 'deepdive_booked' && booked.deepdive));
    // A Recruitee booking whose interviewers aren't on the roster borrows the pair Natalie booked here.
    for (const r of ['advisor', 'deepdive']) {
      const b = booked[r];
      const prev = ((existing && existing.timeline) || []).filter((e) => e.step === `${r}_booked` && e.source !== 'recruitee' && !e.voided).pop();
      if (b && b.interviewers.length < 2 && prev && prev.data && prev.data.interviewers) b.interviewers = [...new Set([...b.interviewers, ...prev.data.interviewers])].slice(0, Math.max(2, b.interviewers.length));
    }
    return {
      ...(existing || {}),
      campaignId,
      name: rc.name,
      email: rc.email || (existing && existing.email) || '',
      flow: 'lite',
      source: 'recruitee',
      recruiteeId: rc.id,
      recruiteeUrl: rc.url || (existing && existing.recruiteeUrl) || '',
      recruiteeStage: rc.stageName,
      recruiteeRound: round,
      recruiteeDisqualified: rc.disqualified,
      syncedAt: stamp,
      createdAt: (existing && existing.createdAt) || stamp,
      timeline: [...tl, ...local],
    };
  }

  /** Plan a whole sync: candidate docs to write, plus counts for the status line. */
  function planSync({ offer, candidates, events, people, campaignId, existing, stageOverrides, now }) {
    const byRc = new Map((existing || []).filter((c) => c.recruiteeId != null).map((c) => [String(c.recruiteeId), c]));
    const docs = [];
    const counts = { total: candidates.length, planned: 0, earlier: 0, interviews: 0, unmatched: [] };
    for (const rc of candidates) {
      const cur = byRc.get(String(rc.id));
      const doc = toCandidateDoc({ rc, events, people, campaignId, existing: cur, stageOverrides, now });
      if (!doc) {
        counts.earlier++;
        continue;
      }
      counts.planned++;
      for (const e of doc.timeline) if (/_booked$/.test(e.step) && e.source === 'recruitee') {
        counts.interviews++;
        for (const u of (e.data && e.data.unmatched) || []) if (u && !counts.unmatched.includes(u)) counts.unmatched.push(u);
      }
      docs.push({ id: cur ? cur.id : `rc_${rc.id}`, doc });
    }
    return { docs, counts, offer: offer ? { id: offer.id, title: offer.title } : null };
  }

  // ------------------------------------------------------------------
  // Mock data in the raw API shape, until a real token exists.
  // ------------------------------------------------------------------
  function mockRecruitee(today, people) {
    const T = today || new Date().toISOString().slice(0, 10);
    const add = (n) => {
      const d = new Date(`${T}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() + n);
      return d.toISOString().slice(0, 10);
    };
    const wd = (n) => {
      let d = T;
      let k = Math.abs(n);
      const step = n < 0 ? -1 : 1;
      let i = 0;
      while (k > 0) {
        i += step;
        d = add(i);
        const w = new Date(`${d}T12:00:00Z`).getUTCDay();
        if (w >= 1 && w <= 5) k--;
      }
      return d;
    };
    const stages = [
      { id: 101, name: 'Gesolliciteerd', category: 'apply' },
      { id: 102, name: 'Video-interview HR', category: 'phone_screen' },
      { id: 103, name: 'Competentiegesprek adviseurs', category: 'interview' },
      { id: 104, name: 'Deep dive teamleads', category: 'interview' },
      { id: 105, name: 'Aanbod', category: 'offer' },
      { id: 106, name: 'Aangenomen', category: 'hire' },
    ];
    const offers = [
      { id: 9001, title: 'Traineeship', status: 'published', kind: 'job', candidates_count: 35, pipeline_template: { stages } },
      { id: 9002, title: 'Adviseur Contractmanagement', status: 'published', kind: 'job', candidates_count: 42, pipeline_template: { stages } },
    ];
    const rows = [
      ['Anne van der Woude', 103, -3],
      ['Tim van der Vuurst', 103, -1],
      ['Hugo Wessels', 102, -2],
      ['Sam van Haren', 102, -1],
      ['Lucas Zijlstra', 103, -6],
      ['Fleur Brouwer', 104, -2],
      ['Milan de Groot', 104, -5],
      ['Iris Mulder', 105, -1],
      ['Noor Hendriks', 103, -4, true],
      ['Jesse Kok', 101, 0],
    ];
    const candidates = rows.map(([name, stageId, ago, dq], i) => ({
      id: 70000 + i,
      name,
      emails: [`${name.toLowerCase().replace(/[^a-z]+/g, '.')}@example.com`],
      created_at: `${wd(ago - 10)}T09:00:00Z`,
      updated_at: `${wd(ago)}T09:00:00Z`,
      placements: [{ id: 80000 + i, offer_id: 9001, stage_id: stageId, positioned_at: `${wd(ago)}T09:00:00Z`, disqualified_at: dq ? `${wd(ago + 1)}T10:00:00Z` : null }],
    }));
    // Interviews booked in Recruitee's agenda, with roster people when we know them.
    const ps = people || [];
    const adv = ps.filter((p) => hasRole(p, 'advisor'));
    const tls = ps.filter((p) => hasRole(p, 'teamlead') && !hasRole(p, 'advisor'));
    const two = (pool, k) => {
      if (pool.length < 2) return [];
      const a = pool[k % pool.length];
      const b = pool.find((p, j) => j > k % pool.length && p.team !== a.team) || pool.find((p) => p.team !== a.team) || pool[(k + 1) % pool.length];
      return [a, b].map((p) => ({ name: p.name, email: p.email || '' }));
    };
    const at = (d, hm) => `${d}T${hm}:00+01:00`;
    const events = [
      { id: 5001, candidate_id: 70000, offer_id: 9001, title: 'Anne van der Woude - Interview met Flux Partners', starts_at: at(wd(2), '10:00'), ends_at: at(wd(2), '11:00'), location: 'Room 1', attendees: two(adv, 0) },
      { id: 5002, candidate_id: 70001, offer_id: 9001, title: 'Video-interview voor Traineeship - Tim van der Vuurst', starts_at: at(wd(-2), '11:10'), ends_at: at(wd(-2), '11:50'), location: 'Video', attendees: [{ name: 'Natalie', email: '' }] },
      { id: 5003, candidate_id: 70002, offer_id: 9001, title: 'Video-interview voor Traineeship - Hugo Wessels', starts_at: at(wd(2), '13:00'), ends_at: at(wd(2), '13:40'), location: 'Video', attendees: [{ name: 'Natalie', email: '' }] },
      { id: 5004, candidate_id: 70005, offer_id: 9001, title: 'Competentiegesprek - Fleur Brouwer', starts_at: at(wd(-4), '14:00'), ends_at: at(wd(-4), '15:00'), location: 'Room 2', attendees: two(adv, 2) },
      { id: 5005, candidate_id: 70006, offer_id: 9001, title: 'Deep dive - Milan de Groot', starts_at: at(wd(3), '09:30'), ends_at: at(wd(3), '10:30'), location: 'Room 1', attendees: two(tls, 0) },
      { id: 5006, candidate_id: 70007, offer_id: 9001, title: 'Deep dive - Iris Mulder', starts_at: at(wd(-3), '15:00'), ends_at: at(wd(-3), '16:00'), location: 'Room 2', attendees: two(tls, 1) },
      { id: 5007, candidate_id: 70004, offer_id: 9001, title: 'Interview met Flux Partners - Lucas Zijlstra', starts_at: at(wd(1), '14:00'), ends_at: at(wd(1), '15:00'), location: 'Room 2', attendees: [{ name: 'Onbekende Collega', email: 'someone@fluxpartners.nl' }] },
    ];
    return { company: { id: 0, name: 'Flux Partners (mock)', slug: '' }, offers, candidates, events };
  }

  const api = { roundOfStage, normalizeOffers, normalizeCandidates, normalizeEvents, matchPerson, roundOfEvent, toCandidateDoc, planSync, mockRecruitee, amsterdamParts, ROUND_ORDER };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FluxRecruitee = api;
})(typeof window !== 'undefined' ? window : globalThis);
