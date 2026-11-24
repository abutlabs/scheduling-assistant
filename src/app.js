/*
 * Flux interview scheduling: the page.
 *
 * Views (hash routes): #run (default), #availability, #roster, #campaign.
 * Candidate detail opens as a drawer over any view.
 * All values from storage, files or Claude go into the DOM as text.
 */
(function () {
  'use strict';
  const M = window.FluxModel;
  const REAL_TODAY = M.todayIso();
  // The mock sidecar can pretend it's another day, to see clocks run down.
  let TODAY = (function () {
    try {
      const v = localStorage.getItem('flux.mockToday');
      return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : REAL_TODAY;
    } catch (e) {
      return REAL_TODAY;
    }
  })();
  // Meeting rooms come from the campaign's settings (name plus the room's Outlook address).
  const roomList = (camp) => {
    const r = ((camp || campaign() || {}).settings || {}).rooms;
    return r && r.length ? r : M.DEFAULT_SETTINGS.rooms;
  };
  const roomNames = (camp) => roomList(camp).map((r) => r.name);
  const roomEmail = (name, camp) => ((roomList(camp).find((r) => r.name === name) || {}).email || '');

  // ------------------------------------------------------------------
  // Tiny DOM helper
  // ------------------------------------------------------------------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k.startsWith('aria-') && typeof v === 'boolean') {
        el.setAttribute(k, String(v));
        continue;
      }
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  // Is this person in the campaign's round? (Chosen members, or everyone eligible when none were chosen.)
  function inRound(c, roundKey, p) {
    const camp = S.state.campaigns.find((x) => x.id === c.campaignId) || campaign();
    return M.roundMembers(camp, roundKey, [p]).length > 0;
  }
  const roundByKey = (camp, key) => ((camp && camp.rounds) || []).find((r) => r.key === key) || M.DEFAULT_ROUNDS.find((r) => r.key === key);
  // Max days per round come from the candidate's campaign settings.
  function roundLimits(campId) {
    const camp = S && S.state.campaigns.find((x) => x.id === campId);
    const out = {};
    for (const r of (camp && camp.rounds) || []) out[r.key] = r.maxDaysAfterPrevious;
    return out;
  }
  const cstate = (c) => M.candidateState(c, TODAY, roundLimits(c.campaignId));
  // replaceChildren() turns null and arrays into text; flatten and drop empties first.
  const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));
  const short = (iso) => (iso ? `${Number(iso.slice(8, 10))}-${Number(iso.slice(5, 7))}` : '');
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + 's'}`;
  function store(k, v) {
    try {
      if (v === undefined) return localStorage.getItem(k);
      localStorage.setItem(k, v);
    } catch (e) {
      return null;
    }
    return null;
  }

  // ------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------
  let S = null; // store connection
  const ui = {
    view: 'run',
    campaignId: store('flux.campaign'),
    candId: null, // drawer: candidate id, or 'new'
    openStep: null, // step key whose form is open in the drawer
    candFilter: 'open',
    draft: null, // availability import in progress
    snapId: null,
    sheetIdx: 0,
    rosterEdit: null, // person id or 'new'
    viewAs: store('flux.viewAs') || null, // Natalie previewing an interviewer's page
    toast: null,
    busy: {},
    error: null,
  };
  let sample = null;

  const people = () => [...S.state.people].sort((a, b) => a.name.localeCompare(b.name));
  const campaigns = () => S.state.campaigns.filter((c) => !c.archived).sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  // Natalie decides which campaigns advisors and team leads see. Older docs without the flag count as open.
  const isOpen = (c) => c.open !== false;
  const openCampaigns = () => campaigns().filter(isOpen);
  function campaign() {
    const all = campaigns();
    return all.find((c) => c.id === ui.campaignId) || all[0] || null;
  }
  const candidates = () => {
    const c = campaign();
    return c ? S.state.candidates.filter((x) => x.campaignId === c.id).sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || '')) : [];
  };
  const snapshots = () => {
    const c = campaign();
    return c ? S.state.snapshots.filter((x) => x.campaignId === c.id).sort((a, b) => (b.pollDate || '').localeCompare(a.pollDate || '') || (b.importedAt || '').localeCompare(a.importedAt || '')) : [];
  };
  // Poll snapshots plus availability set by hand, shaped alike so the newest answer per person and day wins.
  function availSources() {
    const manual = S.state.availability.map((a) => ({
      pollDate: (a.updatedAt || '').slice(0, 10),
      importedAt: a.updatedAt || '',
      manual: true,
      tabs: [{ role: null, dates: Object.keys(a.days || {}), rows: [{ personId: a.personId, cells: a.days || {}, rules: [] }] }],
    }));
    return [...snapshots(), ...manual];
  }
  const personById = (id) => S.state.people.find((p) => p.id === id);

  function toast(msg) {
    ui.toast = msg;
    render();
    clearTimeout(toast.t);
    toast.t = setTimeout(() => {
      ui.toast = null;
      render();
    }, 2600);
  }
  async function act(fn, ok) {
    try {
      await fn();
      if (ok) toast(ok);
    } catch (e) {
      toast(`Couldn't save: ${(e && (e.message || e.code)) || 'unknown error'}. Try again.`);
    }
  }

  // ------------------------------------------------------------------
  // Render root
  // ------------------------------------------------------------------
  let pending = false;
  function render() {
    // Don't rebuild while someone is typing; render again on blur.
    const a = document.activeElement;
    if (a && a.closest && a.closest('#app') && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && !render.force) {
      pending = true;
      return;
    }
    render.force = false;
    pending = false;
    const root = document.getElementById('app');
    const scroll = { x: window.scrollX, y: window.scrollY };
    const drawerScroll = document.querySelector('.drawer') ? document.querySelector('.drawer').scrollTop : 0;
    const iv = ivContext();
    root.replaceChildren(...[iv ? ivTopBar(iv) : topBar(), h('main', {}, iv ? interviewerView(iv) : ui.dev ? devView() : view()), iv || ui.dev ? null : drawer(), sidecar(), welcomeCard(), reportDialog(), ui.toast ? h('div', { class: 'toast', role: 'status' }, ui.toast) : null].flat().filter(Boolean));
    window.scrollTo(scroll.x, scroll.y);
    const d = document.querySelector('.drawer');
    if (d) d.scrollTop = drawerScroll;
  }
  document.addEventListener('focusout', () => setTimeout(() => pending && render(), 0));
  function rerender() {
    render.force = true;
    render();
  }

  function topBar() {
    const c = campaign();
    const nav = [
      ['run', 'Today'],
      ['availability', 'Availability'],
      ['roster', 'Roster'],
      ['campaign', 'Campaign'],
      ['metrics', 'Metrics'],
    ];
    return h(
      'header',
      { class: 'bar gutter' },
      h('div', { class: 'brand' }, h('span', {}, 'Flux interviews')),
      h('nav', {}, nav.map(([k, label]) => h('a', { href: `#${k}`, onclick: () => ui.dev && setViewAs(null), 'aria-current': ui.view === k && !ui.dev ? 'page' : null }, label))),
      h(
        'div',
        { class: 'end' },
        testPill(),
        c
          ? h(
              'select',
              {
                class: 'camp-pick',
                'aria-label': 'Campaign',
                id: 'campaign-pick',
                onchange: (e) => {
                  ui.campaignId = e.target.value;
                  store('flux.campaign', ui.campaignId);
                  rerender();
                },
              },
              campaigns().map((x) => h('option', { value: x.id, selected: x.id === c.id }, x.name)),
            )
          : null,
        nameMenu(),
        reportFab(),
      ),
    );
  }

  // Test mode and the mock date show as a small pill in the bar instead of a banner.
  function testPill() {
    const bits = [];
    if (S.mode !== 'db') bits.push(h('span', { class: 'test-pill', title: 'Data is kept in this browser only. Open the published page on claude.ai, signed in, to share it with the team.' }, 'Test mode'));
    if (S.admin && TODAY !== REAL_TODAY) bits.push(h('button', { class: 'test-pill', title: 'Open the mock tool', onclick: () => ((ui.mockOpen = true), rerender()) }, `Mock date · ${M.formatDay(TODAY)}`));
    return bits;
  }

  // The name menu at top right holds the view switch and the Mock tool, so the bar stays quiet.
  function nameMenu() {
    if (!S.admin || !campaign()) return null;
    const cur = ui.viewAs && personById(ui.viewAs);
    const label = ui.dev ? 'Developer' : cur ? cur.name.split(' ')[0] : 'Admin';
    return h(
      'details',
      { class: 'menu', open: !!ui.menuOpen, ontoggle: (e) => (ui.menuOpen = e.target.open) },
      h('summary', { 'aria-label': 'View and test tools' }, label),
      h(
        'div',
        { class: 'menu-panel' },
        h(
          'nav',
          { class: 'phone-only', 'aria-label': 'Pages' },
          [['run', 'Today'], ['availability', 'Availability'], ['roster', 'Roster'], ['campaign', 'Campaign'], ['metrics', 'Metrics']].map(([k, label]) => h('a', { href: `#${k}`, onclick: () => ((ui.menuOpen = false), ui.dev && setViewAs(null)), 'aria-current': ui.view === k && !ui.dev && !ui.viewAs ? 'page' : null }, label)),
        ),
        viewSwitch(),
        h('hr'),
        h('span', { class: 'label' }, 'Test tool: fast-forward replies, feedback and the date.'),
        h('button', { class: ui.mockOpen ? 'p' : '', 'aria-pressed': !!ui.mockOpen, title: 'Test tool: fast-forward colleagues’ replies, change the date', onclick: () => ((ui.mockOpen = !ui.mockOpen), (ui.menuOpen = false), rerender()) }, TODAY !== REAL_TODAY ? `Mock · ${M.formatDay(TODAY)}` : 'Mock'),
      ),
    );
  }

  function view() {
    if (!campaign()) return [setupView(), archivedCampaigns()];
    if (ui.view === 'availability') return availabilityView();
    if (ui.view === 'roster') return rosterView();
    if (ui.view === 'campaign') return campaignView();
    if (ui.view === 'metrics') return metricsView();
    return runView();
  }

  // ------------------------------------------------------------------
  // First run
  // ------------------------------------------------------------------
  function setupView() {
    const loaded = S.state.loaded.campaigns;
    if (!loaded) return h('div', { class: 'section gutter' }, h('p', { class: 'muted' }, 'Loading…'));
    return h(
      'div',
      { class: 'section gutter' },
      h('div', { class: 'head' }, h('div', {}, h('h1', {}, 'Set up your first campaign'), h('p', {}, 'A campaign is one hiring drive: its structure, the people in each round, targets and availability polls.'))),
      campaignWizard(),
    );
  }

  // ------------------------------------------------------------------
  // Run view: to-do list + holds/summary + step matrix
  // ------------------------------------------------------------------
  const KIND = {
    hr_done: ['Record', ''],
    reject_call_hr: ['Call', 'accent'],
    avail_asked_r2: ['Ask', 'accent'],
    avail_received_r2: ['Note', ''],
    advisor_booked: ['Book', 'accent'],
    advisor_done: ['Record', ''],
    result_call_r2: ['Call', 'accent'],
    avail_received_final: ['Note', ''],
    deepdive_booked: ['Book', 'accent'],
    deepdive_done: ['Record', ''],
    final_call: ['Call', 'accent'],
    closed: ['Close', ''],
  };

  function todoItems() {
    const items = [];
    for (const c of candidates()) {
      const s = cstate(c);
      if (!s.next) continue;
      let group = 'later';
      let reason = '';
      const [kind, tone] = KIND[s.next] || ['Do', ''];
      let k = kind;
      let t = tone;
      if (s.clock && s.clock.state === 'overdue') {
        group = 'overdue';
        k = 'Overdue';
        t = 'bad';
        reason = `Day ${s.clock.day} of ${s.clock.max}: the ${s.clock.round === 'advisor' ? 'advisor interview' : 'deep dive'} deadline was ${M.formatDay(s.clock.deadline)}.`;
      } else if (s.clock && (s.clock.state === 'urgent' || s.clock.state === 'booked_late')) {
        group = 'today';
        t = 'warn';
        reason = s.clock.state === 'booked_late' ? `Booked for ${M.formatDay(s.clock.interviewDate)}, after the ${s.clock.max}-day deadline (${M.formatDay(s.clock.deadline)}).` : `Day ${s.clock.day} of ${s.clock.max}, deadline ${M.formatDay(s.clock.deadline)}.`;
      } else if (s.clock && s.clock.state === 'booked' && s.clock.interviewDate <= TODAY) {
        group = 'today';
        reason = s.clock.interviewDate === TODAY ? 'The interview is today.' : `The interview was on ${M.formatDay(s.clock.interviewDate)}.`;
      } else if (s.clock && s.clock.state === 'booked') {
        group = 'later';
        reason = `Interview booked for ${M.formatDay(s.clock.interviewDate)}.`;
      } else if (/call|avail_asked|reject/.test(s.next)) {
        group = 'today';
        reason = s.clock ? `Day ${s.clock.day} of ${s.clock.max}.` : 'Every candidate hears back, and the call is logged.';
      } else if (s.next === 'hr_done') {
        const d = c.hrDate;
        group = d && d <= TODAY ? 'today' : 'later';
        reason = d ? `HR interview ${d === TODAY ? 'today' : d < TODAY ? `was on ${M.formatDay(d)}` : `on ${M.formatDay(d)}`}.` : 'No HR interview date yet.';
      } else {
        reason = s.clock ? `Day ${s.clock.day} of ${s.clock.max}, deadline ${M.formatDay(s.clock.deadline)}.` : '';
      }
      const inv = roundInvites(c);
      if (inv.state.complete && s.next.endsWith('_booked')) continue;
      if (inv.list.length && /avail_received|_booked$/.test(s.next) && !inv.state.complete && k !== 'Overdue') {
        k = 'Waiting';
        t = t === 'warn' ? 'warn' : '';
        reason = `${inv.state.accepted.length} of 2 accepted, ${inv.state.pending.length} waiting. ${reason}`;
      }
      if (s.skipped.length) reason += ` ${plural(s.skipped.length, 'earlier step')} not recorded.`;
      const due = s.clock && s.clock.deadline && s.clock.state !== 'booked' ? (s.clock.state === 'overdue' ? 'past the deadline' : `due ${longDay(s.clock.deadline).split(' ')[0]}`) : '';
      items.push({ group, kind: k, tone: t, who: c.name, text: `${s.prompt}. ${reason}`.trim(), title: `${s.prompt}.`, sub: `${c.name} · ${reason}`.trim(), due, btn: k === 'Overdue' ? 'Open' : kind, cand: c.id, step: s.next, sortKey: s.clock ? s.clock.daysLeft ?? 99 : 50 });
    }
    items.push(...inviteTodoItems());
    // Availability housekeeping
    const snaps = snapshots();
    if (!snaps.length) {
      items.push({ group: 'later', kind: 'Import', tone: 'accent', who: 'Availability poll', text: 'No poll imported for this campaign yet. Import the xlsx so slots can be matched.', btn: 'Import', go: 'availability', sortKey: 90 });
    } else {
      const latest = snaps[0];
      const age = M.daysBetween(latest.pollDate, TODAY);
      if (latest.to && latest.to < M.addDays(TODAY, 7)) {
        items.push({ group: latest.to < TODAY ? 'today' : 'later', kind: 'Poll', tone: 'warn', who: 'Availability poll', text: `The latest poll (${M.formatDay(latest.pollDate)}) only runs until ${M.formatDay(latest.to)}. Send out a new one.`, btn: 'Open', go: 'availability', sortKey: 80 });
      } else if (age > 30) {
        items.push({ group: 'later', kind: 'Poll', tone: 'warn', who: 'Availability poll', text: `The latest poll is ${age} days old. Answers may be out of date.`, btn: 'Open', go: 'availability', sortKey: 85 });
      }
    }
    if (S.state.loaded.people && !S.state.people.length) {
      items.push({ group: 'today', kind: 'Set up', tone: 'accent', who: 'Roster', text: 'The roster is empty. Import a poll and add people from it, or add them by hand.', btn: 'Open', go: 'roster', sortKey: 0 });
    }
    return items.sort((a, b) => a.sortKey - b.sortKey);
  }

  const DAYNAME = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const longDay = (iso) => `${DAYNAME[M.weekdayOf(iso)]} ${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;

  function todoAction(i) {
    return () => {
      if (i.go) location.hash = i.go;
      else if (i.invite) releaseInvite(i.invite, i.why);
      else if (i.prefill) {
        const c = S.state.candidates.find((x) => x.id === i.cand);
        const r = roundInvites(c);
        ui.candId = c.id;
        prefillBooking(c, i.step, r.list, r.state);
      } else openCandidate(i.cand, i.step);
    };
  }

  function todoRow(i) {
    return h('div', { class: `act tone-${i.tone || 'plain'}` }, h('i', { class: 'dot', title: i.kind }), h('div', {}, h('b', {}, i.who), h('p', {}, i.text)), h('button', { onclick: todoAction(i) }, i.btn));
  }

  // The one next step, large, at the top of Natalie's home.
  function todoHero(i) {
    const cand = i.cand && S.state.candidates.find((x) => x.id === i.cand);
    return h(
      'section',
      { class: `act-hero tone-${i.tone || 'plain'}`, 'aria-label': 'Start here' },
      h('span', { class: 'kicker' }, ['Start here', i.due].filter(Boolean).join(' · ')),
      h('h2', {}, i.title || i.who),
      h('p', {}, i.title ? i.sub : i.text),
      h(
        'div',
        { class: 'row' },
        h('button', { class: 'p', onclick: todoAction(i) }, i.btn),
        cand && i.btn !== 'Open' ? h('button', { class: 'link', onclick: () => openCandidate(cand.id) }, `Open ${cand.name.split(' ')[0]}`) : null,
      ),
    );
  }

  function runView() {
    const items = todoItems();
    const now = items.filter((i) => i.group === 'overdue' || i.group === 'today');
    const later = items.filter((i) => i.group === 'later');
    const showN = ui.showAllTodo ? now.length : 5;
    const c = campaign();
    const f = M.funnel(candidates());
    const target = c.targetHires || 0;
    const pct = target ? Math.min(100, Math.round((f.hired / target) * 100)) : 0;
    const summary = now.length ? `${now.length === 1 ? 'One thing needs' : `${now.length} things need`} you today.` : 'Nothing needs you right now.';
    const [hero, ...rest] = now;

    const todo = h(
      'div',
      { 'aria-label': 'To do' },
      hero
        ? [
            todoHero(hero),
            rest.length ? [h('p', { class: 'then' }, 'Then'), h('div', {}, rest.slice(0, showN - 1).map(todoRow))] : null,
            rest.length > showN - 1 ? h('button', { class: 'link more', onclick: () => ((ui.showAllTodo = true), rerender()) }, `Show ${rest.length - (showN - 1)} more`) : null,
          ]
        : h('div', { class: 'calm-empty' }, h('p', {}, candidates().length ? 'All caught up. Enjoy the quiet.' : 'Add a candidate after their HR interview and the next steps appear here.'), candidates().length ? null : h('div', { class: 'row' }, h('button', { class: 'p big', onclick: () => openCandidate('new') }, '+ Candidate'), h('button', { class: 'quiet', title: 'Fills the app with mock candidates, interviews and feedback. Clear it any time from Mock.', onclick: loadFullDemo }, 'Try it with a demo campaign'))),
      later.length ? h('details', { class: 'later', open: !!ui.laterOpen, ontoggle: (e) => (ui.laterOpen = e.target.open) }, h('summary', {}, `Coming up · ${later.length}`), h('div', {}, later.map(todoRow))) : null,
    );

    const side = h(
      'aside',
      { class: 'progress', 'aria-label': 'Campaign progress' },
      h('span', { class: 'label' }, c.name),
      h('div', { class: 'big-num' }, `${f.hired}`, h('span', {}, ` of ${target || '?'} hired`)),
      h('div', { class: 'track' }, h('i', { style: `width:${pct}%` })),
      h('div', { class: 'stat-list' }, h('div', {}, 'Candidates', h('b', {}, f.total)), h('div', {}, 'Passed HR', h('b', {}, f.passedHr)), h('div', {}, 'Through advisor round', h('b', {}, f.passedAdvisor))),
    );

    const showTable = store('flux.stepTable') === '1';
    return h(
      'div',
      { class: 'home' },
      h('div', { class: 'calm-head' }, h('p', { class: 'date' }, longDay(TODAY)), h('h1', {}, summary)),
      h('div', { class: 'cols' }, todo, side),
      h(
        'section',
        { class: 'cand-sec', 'aria-label': 'Candidates' },
        h('div', { class: 'cand-head' }, h('h2', {}, 'Candidates'), h('div', { class: 'filters' }, filterButtons()), h('button', { class: 'link add', onclick: () => openCandidate('new') }, '+ Candidate')),
        showTable ? matrix() : candidateList(),
        h('div', { class: 'cand-foot' }, h('button', { class: 'quiet', onclick: () => (store('flux.stepTable', showTable ? '0' : '1'), rerender()) }, showTable ? 'Simple list' : 'Show every step ▸')),
      ),
    );
  }

  // The calm default: one line per candidate with where they are and what's next.
  function candidateList() {
    const list = candidates().filter((c) => {
      const st = cstate(c).status;
      return ui.candFilter === 'all' ? true : ui.candFilter === 'closed' ? st !== 'open' : st === 'open';
    });
    if (!list.length) return h('p', { class: 'muted', style: 'padding:18px 0' }, 'No candidates here.');
    const stageName = { hr: 'HR round', advisor: 'Advisor round', deepdive: 'Deep dive', hired: 'Offer' };
    return h(
      'div',
      { class: 'cand-list' },
      list.map((c) => {
        const s = cstate(c);
        return h(
          'button',
          { class: 'cand-row', onclick: () => openCandidate(c.id) },
          h('b', {}, c.name),
          h('span', { class: `round${s.status === 'open' ? '' : ' closed'}` }, s.status === 'open' ? stageName[s.stage] : M.OUTCOME_LABELS[s.status] || s.status),
          h('span', { class: 'next' }, s.prompt || ''),
          dayTag(s, c),
        );
      }),
    );
  }

  // Where the candidate is on the clock, in mono: "day 5 of 7", "today", "past deadline".
  function dayTag(s, c) {
    const clk = s.clock && s.clock.state !== 'met' ? s.clock : null;
    if (clk) return h('span', { class: `day ${clk.state === 'overdue' ? 'bad' : clk.daysLeft <= 2 ? 'late' : ''}` }, clk.state === 'overdue' ? 'past deadline' : clk.state === 'booked' || clk.state === 'booked_late' ? M.formatDay(clk.interviewDate) : `day ${Math.max(0, clk.day)} of ${clk.max}`);
    if (s.next === 'hr_done' && c.hrDate === TODAY) return h('span', { class: 'day' }, 'today');
    return h('span', {});
  }

  function filterButtons() {
    const all = candidates().map((c) => cstate(c).status === 'open');
    const open = all.filter(Boolean).length;
    return [
      ['open', `Open ${open}`],
      ['closed', `Closed ${all.length - open}`],
      ['all', `All ${all.length}`],
    ].map(([k, label]) =>
      h(
        'button',
        {
          'aria-pressed': ui.candFilter === k,
          onclick: () => {
            ui.candFilter = k;
            rerender();
          },
        },
        label,
      ),
    );
  }

  function matrix() {
    const rows = candidates().filter((c) => {
      const st = cstate(c).status;
      return ui.candFilter === 'all' || (ui.candFilter === 'open' ? st === 'open' : st !== 'open');
    });
    if (!rows.length) return h('div', { class: 'empty gutter' }, h('p', {}, ui.candFilter === 'open' ? 'No open candidates.' : 'No candidates here yet.'));
    const head = h('tr', {}, h('th', { class: 'rn' }), h('th', {}, 'Candidate'), M.STEPS.map((s) => h('th', {}, `${s.n}. ${s.label}`)), h('th', {}, 'Clock'), h('th', {}, 'Next action'));
    const body = rows.map((c, i) => {
      const s = cstate(c);
      const cells = M.STEPS.map((step) => {
        let key = step.key;
        // The HR reject call shows in column 2.
        if (step.key === 'avail_asked_r2' && s.rejectedAt === 'hr') key = 'reject_call_hr';
        const e = s.done[key];
        const onPath = s.path.includes(key);
        let cls = 'up';
        let txt = '·';
        if (e) {
          cls = e.outcome === 'reject' || (key === 'closed' && e.outcome !== 'hired') ? 'done rej' : 'done';
          if (key === 'closed') txt = M.OUTCOME_LABELS[e.outcome] || 'closed';
          else if (key.endsWith('_booked') && e.data && e.data.slotDate) txt = `${short(e.data.slotDate)}${e.data.time ? ` ${e.data.time}` : ''}`;
          else txt = `${short(e.at)}${e.outcome === 'pass' || e.outcome === 'hire' ? ' ✓' : e.outcome === 'reject' ? ' ✗' : key.startsWith('reject_call') ? ' call' : ''}`;
        } else if (s.next === key) {
          cls = 'next';
          txt = 'to do';
        } else if (s.skipped.includes(key)) {
          cls = 'skip';
          txt = '–';
        } else if (!onPath) {
          cls = 'na';
          txt = '';
        }
        const clickable = cls !== 'na';
        return h('td', { class: `d ${cls}` }, h('button', { disabled: !clickable, 'aria-label': `${c.name}: ${M.STEP_BY_KEY[key].label}`, onclick: clickable ? () => openCandidate(c.id, key) : null }, txt));
      });
      const clk = s.clock && s.clock.state !== 'met' ? s.clock : null;
      return h(
        'tr',
        { class: ui.candId === c.id ? 'sel' : '' },
        h('td', { class: 'rn' }, i + 1),
        h('td', { class: 'name' }, h('button', { onclick: () => openCandidate(c.id) }, c.name)),
        cells,
        h('td', { class: `clk ${clk && (clk.state === 'overdue' || clk.daysLeft < 1) ? 'bad' : clk && clk.daysLeft <= 2 ? 'warn' : ''}` }, clk ? (clk.state === 'booked' ? `${Math.max(0, clk.day)}/7 ✓` : `${Math.max(0, clk.day)}/7`) : ''),
        h('td', { class: 'small' }, s.prompt || M.OUTCOME_LABELS[s.status] || ''),
      );
    });
    return h('div', { class: 'sheet-wrap' }, h('table', { class: 'x' }, h('thead', {}, head), h('tbody', {}, body)));
  }

  // ------------------------------------------------------------------
  // Candidate drawer
  // ------------------------------------------------------------------
  function openCandidate(id, step) {
    ui.candId = id;
    ui.openStep = step || null;
    if (id !== 'new' && !step) {
      const c = S.state.candidates.find((x) => x.id === id);
      if (c) ui.openStep = cstate(c).next;
    }
    rerender();
  }
  function closeDrawer() {
    ui.forms = {};
    ui.candId = null;
    ui.openStep = null;
    rerender();
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && ui.candId) closeDrawer();
  });

  function drawer() {
    if (!ui.candId) return null;
    const content = ui.candId === 'new' ? newCandidateForm() : candidateDetail(S.state.candidates.find((x) => x.id === ui.candId));
    return [h('div', { class: 'scrim', onclick: closeDrawer }), h('aside', { class: 'drawer', role: 'dialog', 'aria-label': 'Candidate' }, h('button', { class: 'x', 'aria-label': 'Close', onclick: closeDrawer }, '×'), content)];
  }

  function newCandidateForm() {
    const f = { name: '', email: '', phone: '', hrDate: TODAY, hr: 'pass', asked: true, notes: '' };
    const err = h('p', { class: 'err-line' });
    return h(
      'form',
      {
        class: 'stack',
        style: 'display:flex;flex-direction:column;gap:12px',
        onsubmit: (e) => {
          e.preventDefault();
          if (!f.name.trim()) {
            err.textContent = 'Add the candidate’s name.';
            return;
          }
          const now = new Date().toISOString();
          const timeline = [];
          if (f.hr !== 'none') timeline.push({ id: S.uid('e'), step: 'hr_done', at: f.hrDate, outcome: f.hr, note: '', recordedAt: now });
          if (f.hr === 'pass' && f.asked) timeline.push({ id: S.uid('e'), step: 'avail_asked_r2', at: f.hrDate, note: 'Asked at the end of the HR interview.', recordedAt: now });
          const doc = { campaignId: campaign().id, name: f.name.trim(), email: f.email.trim(), phone: f.phone.trim(), hrDate: f.hrDate, notes: f.notes.trim(), timeline, createdAt: now };
          act(async () => {
            const id = await S.add('candidates', withSummary(doc));
            ui.candId = id;
            ui.openStep = cstate(doc).next;
            rerender();
          }, `${doc.name} added`);
        },
      },
      h('h2', {}, 'Add a candidate'),
      h('p', { class: 'muted small' }, 'Add them after the HR interview. If they passed, the 1-week clock for the advisor interview starts when you ask for their availability.'),
      h(
        'div',
        { class: 'fg' },
        h('label', { class: 'f wide' }, 'Name', h('input', { id: 'nc-name', required: true, autocomplete: 'off', oninput: (e) => (f.name = e.target.value) })),
        h('label', { class: 'f' }, 'Email', h('input', { id: 'nc-email', type: 'email', oninput: (e) => (f.email = e.target.value) })),
        h('label', { class: 'f' }, 'Phone', h('input', { id: 'nc-phone', type: 'tel', oninput: (e) => (f.phone = e.target.value) })),
        h('label', { class: 'f' }, 'HR interview date', h('input', { id: 'nc-hr', type: 'date', value: f.hrDate, oninput: (e) => (f.hrDate = e.target.value || TODAY) })),
        h(
          'label',
          { class: 'f' },
          'HR result',
          h(
            'select',
            { id: 'nc-result', onchange: (e) => (f.hr = e.target.value) },
            h('option', { value: 'pass', selected: true }, 'Passed'),
            h('option', { value: 'reject' }, 'Not moving on'),
            h('option', { value: 'none' }, 'Not recorded yet'),
          ),
        ),
        h('label', { class: 'check wide' }, h('input', { id: 'nc-asked', type: 'checkbox', checked: true, onchange: (e) => (f.asked = e.target.checked) }), 'I asked for next week’s availability on the same day'),
        h('label', { class: 'f wide' }, 'Notes', h('textarea', { id: 'nc-notes', oninput: (e) => (f.notes = e.target.value) })),
      ),
      err,
      h('div', { class: 'row end' }, h('button', { type: 'button', onclick: closeDrawer }, 'Cancel'), h('button', { class: 'p', type: 'submit' }, 'Add candidate')),
    );
  }

  // Denormalised fields so Claude sessions and metrics can query without replaying timelines.
  function withSummary(doc) {
    const s = cstate(doc);
    return { ...doc, status: s.status, stage: s.stage, nextStep: s.next || null, updatedAt: new Date().toISOString() };
  }
  function saveCandidate(c, patch, msg) {
    const next = { ...c, ...patch };
    return act(() => S.set('candidates', c.id, withSummary(next)), msg);
  }

  const STAGE_NAME = { hr: 'HR round', advisor: 'Advisor round', deepdive: 'Deep dive', hired: 'Offer stage' };

  // Candidate drawer: who, the one next step, progress (done steps folded), brief, notes.
  function candidateDetail(c) {
    if (!c) return h('p', { class: 'muted' }, 'This candidate was removed.');
    const s = cstate(c);
    const clk = s.clock && s.clock.state !== 'met' ? s.clock : null;
    const camp = campaigns().find((x) => x.id === c.campaignId) || campaign();
    const clockText = clk ? (clk.state === 'overdue' ? h('span', { class: 'bad' }, `day ${clk.day} of ${clk.max}, past the deadline`) : clk.state === 'booked' || clk.state === 'booked_late' ? `booked for ${M.formatDay(clk.interviewDate)}` : h('span', { class: clk.daysLeft <= 2 ? 'late' : '' }, `day ${Math.max(0, clk.day)} of ${clk.max}`)) : null;
    const header = [
      h('p', { class: 'eyebrow' }, `Candidate · ${camp ? camp.name : ''}`),
      h('h1', {}, c.name),
      h('p', { class: 'sub' }, s.status === 'open' ? STAGE_NAME[s.stage] : M.OUTCOME_LABELS[s.status] || s.status, clockText ? ' · ' : '', clockText),
      c.email || c.phone || c.hrDate ? h('div', { class: 'contact' }, c.email ? h('span', {}, c.email) : null, c.phone ? h('span', {}, c.phone) : null, c.hrDate ? h('em', {}, `HR interview ${M.formatDay(c.hrDate)}`) : null) : null,
      c.notes ? h('p', { class: 'cnotes' }, c.notes) : null,
    ];

    const why = clk && clk.deadline && clk.state !== 'booked' ? `Day ${Math.max(0, clk.day)} of ${clk.max}, deadline ${M.formatDay(clk.deadline)}.` : '';
    const next = s.next
      ? h(
          'section',
          { class: 'next', 'aria-label': 'Next step' },
          h('span', { class: 'kicker' }, 'Next step'),
          h('h2', {}, `${s.prompt}.`),
          why || s.skipped.length ? h('p', {}, [why, s.skipped.length ? `${plural(s.skipped.length, 'earlier step')} not recorded yet.` : ''].filter(Boolean).join(' ')) : null,
          ui.openStep === s.next ? stepForm(c, s.next, s.done[s.next]) : h('div', { class: 'row go' }, h('button', { class: 'p', onclick: () => ((ui.openStep = s.next), rerender()) }, `Record: ${M.STEP_BY_KEY[s.next].label.toLowerCase()}`)),
        )
      : null;

    const keys = s.rejectedAt === 'hr' ? ['hr_done', 'reject_call_hr', ...M.STEPS.slice(1).map((x) => x.key)] : M.STEPS.map((x) => x.key);
    const row = (key) => {
      const step = M.STEP_BY_KEY[key];
      const e = s.done[key];
      const onPath = s.path.includes(key);
      let cls = 'later';
      if (e) cls = e.outcome === 'reject' ? 'done rej' : 'done';
      else if (s.next === key) cls = 'now';
      else if (s.skipped.includes(key)) cls = 'skip';
      else if (!onPath) cls = 'na';
      const isOpen = ui.openStep === key;
      let when = '';
      if (e) when = M.formatDay(e.at.slice(0, 10));
      else if (s.next === key) when = clk && clk.deadline ? M.formatDay(clk.deadline) : 'next';
      else if (s.skipped.includes(key)) when = 'not recorded';
      else if (!onPath) when = 'n/a';
      return h(
        'div',
        { class: `step ${cls}` },
        h(
          'button',
          { class: 'st', 'aria-expanded': isOpen, onclick: () => ((ui.openStep = isOpen && key !== s.next ? null : key), rerender()) },
          h('span', { class: 'mark' }, e ? (e.outcome === 'reject' ? '✗' : '✓') : cls === 'skip' ? '!' : ''),
          h('span', { class: 'lbl' }, step.label, e && e.outcome ? ` · ${M.OUTCOME_LABELS[e.outcome]}` : ''),
          h('span', { class: 'when' }, when),
        ),
        e && !isOpen ? entryDetail(e) : null,
        isOpen && key !== s.next ? stepForm(c, key, e) : null,
      );
    };
    const doneKeys = keys.filter((k) => s.done[k]);
    const lastDone = doneKeys.map((k) => s.done[k].at.slice(0, 10)).sort().pop();
    const rest = keys.filter((k) => !s.done[k] && k !== s.next && !s.skipped.includes(k));
    const soon = rest.filter((k) => s.path.includes(k)).slice(0, 2);
    const more = rest.filter((k) => !soon.includes(k));
    const progress = h(
      'section',
      { class: 'dsec', 'aria-label': 'Progress' },
      h('span', { class: 'label' }, 'Progress'),
      h(
        'div',
        { class: 'step-list' },
        doneKeys.length
          ? h(
              'details',
              { class: 'fold-steps done-sum', open: doneKeys.includes(ui.openStep) || !!ui.doneOpen, ontoggle: (e) => (ui.doneOpen = e.target.open) },
              h('summary', {}, `${plural(doneKeys.length, 'step')} done${lastDone ? ` · last on ${M.formatDay(lastDone)}` : ''}`),
              doneKeys.map(row),
            )
          : null,
        s.skipped.map(row),
        s.next ? row(s.next) : null,
        soon.map(row),
        more.length ? h('details', { class: 'fold-steps more-sum', open: more.includes(ui.openStep) }, h('summary', {}, `${plural(more.length, 'more step')}`), more.map(row)) : null,
      ),
    );
    return h('div', { style: 'display:flex;flex-direction:column' }, header, next, requestsSection(c, s) ? h('div', { class: 'dsec' }, requestsSection(c, s)) : null, progress, fromInterviewers(c, s), briefPanel(c, s), notesSection(c), h('div', { class: 'dsec' }, candidateAdmin(c, s)));
  }

  // Interview feedback for the current round, one line per interviewer with their lean.
  function fromInterviewers(c, s) {
    const round = s.stage === 'deepdive' || s.stage === 'hired' ? 'deepdive' : 'advisor';
    const list = notesFor(c).filter((n) => n.kind === 'feedback' && n.round === round);
    if (!list.length) return null;
    return h(
      'section',
      { class: 'dsec from-iv', 'aria-label': 'Interview feedback' },
      h('span', { class: 'label' }, round === 'deepdive' ? 'From the team leads' : 'From the advisors'),
      list.map((n) => {
        const lean = LEANS.find((l) => n.text.startsWith(l[1]));
        return h('div', { class: 'fb' }, h('span', {}, authorName(n)), h('span', { class: `lean ${lean ? (lean[0] === 'reject' ? 'no' : lean[0]) : ''}` }, lean ? lean[1] : 'Feedback'), h('p', {}, lean ? n.text.slice(lean[1].length).replace(/^[.\s]+/, '') : n.text));
      }),
    );
  }

  function entryDetail(e) {
    const bits = [];
    const d = e.data || {};
    if (d.slotDate) bits.push(`${M.formatDay(d.slotDate)}${d.time ? ` ${d.time}` : ''}${d.room ? `, ${d.room}` : ''}`);
    if (d.interviewers && d.interviewers.length) bits.push(d.interviewers.map((id) => interviewerLabel(id)).join(' + '));
    if (d.availability) bits.push(`Availability: ${d.availability}`);
    if (d.slots && d.slots.length) bits.push(d.slots.map((x) => `${M.formatDay(x.date)} ${x.from || ''}${x.to ? `-${x.to}` : ''}`.trim()).join(', '));
    if (d.reason) bits.push(`Reason: ${d.reason}`);
    if (e.note) bits.push(e.note);
    return bits.length ? h('div', { class: 'detail' }, bits.join('\n')) : null;
  }
  function interviewerLabel(id) {
    if (id === 'natalie') return 'Natalie (HR)';
    const p = personById(id);
    return p ? `${p.name} (${p.team})` : 'removed person';
  }

  function stepForm(c, key, existing) {
    const step = M.STEP_BY_KEY[key];
    const s = cstate(c);
    const round = step.round === 'advisor' || step.round === 'deepdive' ? roundByKey(campaign(), step.round) : null;
    const prev = existing || {};
    const pd = prev.data || {};
    // Keep what's been typed across re-renders (another note saved, data arriving).
    ui.forms = ui.forms || {};
    const fk = `${c.id}:${key}:${prev.id || 'new'}`;
    if (!existing && !ui.forms[fk] && key.endsWith('_booked')) {
      const r = roundInvites(c, key === 'deepdive_booked' ? 'deepdive' : 'advisor');
      if (r.state.complete) {
        const slot = r.list.find((i) => r.state.pair.includes(i.personId)) || r.list[0];
        ui.forms[fk] = { at: TODAY, outcome: null, note: '', availability: '', slots: [], slotDate: slot.slotDate, time: slot.time || '', room: slot.room || roomNames()[0], interviewers: [...r.state.pair], reason: '' };
      }
    }
    const f = ui.forms[fk] || (ui.forms[fk] = {
      at: (prev.at || TODAY).slice(0, 10),
      outcome: prev.outcome || (step.outcome ? defaultOutcome(key, s) : null),
      note: prev.note || '',
      availability: pd.availability || '',
      slots: pd.slots || [],
      slotDate: pd.slotDate || '',
      time: pd.time || '',
      room: pd.room || roomNames()[0],
      interviewers: pd.interviewers ? [...pd.interviewers] : ['', ''],
      reason: pd.reason || '',
    });
    const forget = () => delete ui.forms[fk];
    const wrap = h('div', { class: 'step-form' });
    const err = h('p', { class: 'err-line' });
    const box = h('div', { style: 'display:flex;flex-direction:column;gap:10px' });

    function draw() {
      const parts = [];
      parts.push(h('div', { class: 'fg' }, h('label', { class: 'f' }, step.call ? 'Call date' : key.endsWith('booked') ? 'Booked on' : 'Date', h('input', { type: 'date', id: `sf-at-${key}`, value: f.at, oninput: (e) => (f.at = e.target.value) }))));
      if (step.outcome) {
        const opts = key === 'closed' ? closeOptions(s) : step.outcome;
        parts.push(
          h(
            'div',
            { class: 'radios', role: 'group', 'aria-label': 'Outcome' },
            opts.map((o) =>
              h(
                'button',
                {
                  type: 'button',
                  'aria-pressed': f.outcome === o,
                  onclick: () => {
                    f.outcome = o;
                    draw();
                  },
                },
                M.OUTCOME_LABELS[o],
              ),
            ),
          ),
        );
      }
      if (step.call) {
        const told = s.rejectedAt ? 'Told them they are not moving on.' : key === 'final_call' ? 'Told them the final result.' : 'Told them they passed and asked for availability for the deep dive.';
        parts.push(h('p', { class: 'small muted' }, told));
      }
      if (key === 'closed' && (f.outcome === 'withdrew' || f.outcome === 'no_show')) {
        parts.push(h('label', { class: 'f' }, 'Reason', h('input', { id: 'sf-reason', value: f.reason, oninput: (e) => (f.reason = e.target.value) })));
      }
      if (step.fields && step.fields.includes('availability')) parts.push(availabilityFields(f, draw));
      if (step.fields && step.fields.includes('slot')) parts.push(slotFields(f, round, draw, c));
      parts.push(h('label', { class: 'f' }, 'Note', h('textarea', { id: `sf-note-${key}`, value: f.note, oninput: (e) => (f.note = e.target.value) })));
      parts.push(err);
      parts.push(
        h(
          'div',
          { class: 'row end' },
          existing ? h('button', { type: 'button', class: 'danger', onclick: () => removeStep(c, key) }, 'Remove step') : null,
          h(
            'button',
            {
              type: 'button',
              onclick: () => {
                forget();
                ui.openStep = null;
                rerender();
              },
            },
            'Cancel',
          ),
          h('button', { type: 'button', class: 'p', onclick: save }, existing ? 'Save correction' : 'Save step'),
        ),
      );
      fill(box, parts);
    }

    function save() {
      if (step.outcome && !f.outcome) {
        err.textContent = 'Pick an outcome.';
        return;
      }
      if (step.fields && step.fields.includes('slot') && !f.slotDate) {
        err.textContent = 'Add the interview date.';
        return;
      }
      const data = {};
      if (step.fields && step.fields.includes('availability')) {
        data.availability = f.availability.trim();
        if (f.slots.length) data.slots = f.slots;
      }
      if (step.fields && step.fields.includes('slot')) Object.assign(data, { slotDate: f.slotDate, time: f.time, room: f.room, interviewers: f.interviewers.filter(Boolean) });
      if (f.reason) data.reason = f.reason.trim();
      const entry = { id: S.uid('e'), step: key, at: f.at || TODAY, note: f.note.trim(), recordedAt: new Date().toISOString() };
      if (f.outcome) entry.outcome = f.outcome;
      if (Object.keys(data).length) entry.data = data;
      const timeline = [...(c.timeline || []), entry];
      const after = cstate({ ...c, timeline });
      forget();
      ui.openStep = after.next;
      saveCandidate(c, { timeline }, `${step.label} saved`).then(rerender);
    }

    draw();
    wrap.append(box);
    return wrap;
  }

  function defaultOutcome(key, s) {
    if (key === 'closed') {
      if (s.rejectedAt) return 'rejected';
      if (s.done.deepdive_done && s.done.deepdive_done.outcome === 'hire') return 'hired';
      return null;
    }
    return null;
  }
  function closeOptions(s) {
    if (s.rejectedAt) return ['rejected', 'withdrew', 'no_show'];
    if (s.done.deepdive_done && s.done.deepdive_done.outcome === 'hire') return ['hired', 'withdrew'];
    return ['withdrew', 'no_show', 'rejected'];
  }

  function availabilityFields(f, draw) {
    const status = h('p', { class: 'small muted' });
    return h(
      'div',
      { style: 'display:flex;flex-direction:column;gap:6px' },
      h('label', { class: 'f' }, 'Days and times for the next week (paste their email or type it)', h('textarea', { id: 'sf-avail', value: f.availability, oninput: (e) => (f.availability = e.target.value) })),
      sample
        ? h(
            'div',
            { class: 'row' },
            h(
              'button',
              {
                type: 'button',
                onclick: async () => {
                  if (!f.availability.trim()) {
                    status.textContent = 'Paste their availability first.';
                    return;
                  }
                  status.textContent = 'Claude is reading it…';
                  try {
                    const res = await sample.json(
                      `Today is ${TODAY} (${M.formatDay(TODAY)}). A job candidate wrote when they can come in for a 1-hour interview. Turn it into a JSON array of {"date":"YYYY-MM-DD","from":"HH:MM","to":"HH:MM"} for the coming 14 days. Use "from":"09:00","to":"12:30" for a morning, "13:00"-"17:30" for an afternoon, "09:00"-"17:30" for a whole day. Reply with only the JSON array.\n\nCandidate wrote:\n${f.availability}`,
                      { modelTier: 'quick' },
                    );
                    f.slots = (Array.isArray(res) ? res : []).filter((x) => x && /^\d{4}-\d{2}-\d{2}$/.test(x.date)).map((x) => ({ date: x.date, from: M.normTime(x.from) || '', to: M.normTime(x.to) || '' }));
                    draw();
                  } catch (e) {
                    status.textContent = e && e.code === 'not_granted' ? 'Claude isn’t allowed on this page. Type the days instead.' : 'Claude couldn’t read that. Keep the text as it is, or try again.';
                  }
                },
              },
              'Read with Claude',
            ),
            status,
          )
        : null,
      f.slots.length
        ? h(
            'div',
            { class: 'slots' },
            f.slots.map((x, i) =>
              h(
                'span',
                { class: 'chip accent' },
                `${M.formatDay(x.date)} ${x.from}${x.to ? `-${x.to}` : ''}`,
                h(
                  'button',
                  {
                    type: 'button',
                    class: 'link',
                    'aria-label': 'Remove',
                    onclick: () => {
                      f.slots.splice(i, 1);
                      draw();
                    },
                  },
                  '×',
                ),
              ),
            ),
          )
        : null,
    );
  }

  function slotFields(f, round, draw, c) {
    const role = round ? round.role : 'advisor';
    const pool = people().filter((p) => p.active !== false && (M.personHasRole(p, role) || (role === 'teamlead' && (p.roles || []).includes('joker'))));
    const snaps = availSources();
    function label(p) {
      let note = '';
      if (f.slotDate) {
        const a = M.availabilityOn(snaps, p.id, role, f.slotDate);
        if (!a) note = ' · not in a poll for this date';
        else if (a.value === null) note = ' · no answer';
        else note = ` · ${a.value === 'no' ? 'not available' : M.VALUES[a.value].label.toLowerCase()}${a.window ? ` (${a.window.from || ''}-${a.window.to || ''})` : ''}${a.tentative ? ', check first' : ''}`;
      }
      return `${p.name} (${p.team})${(p.roles || []).includes('joker') ? ' · joker' : ''}${note}`;
    }
    const problems = M.pairProblems(f.interviewers.filter((x) => x && x !== 'natalie'), people(), round ? { ...round, interviewers: 0 } : null);
    if (f.interviewers.filter(Boolean).length < (round ? round.interviewers : 2)) problems.push(`Pick ${round ? round.interviewers : 2} interviewers.`);
    const who = role === 'teamlead' ? 'Team lead' : 'Advisor';
    return h(
      'div',
      { style: 'display:flex;flex-direction:column;gap:8px' },
      h(
        'div',
        { class: 'fg' },
        h(
          'label',
          { class: 'f' },
          'Interview date',
          h(
            'input',
            {
              type: 'date',
              id: 'sf-slot',
              value: f.slotDate,
              onchange: (e) => {
                f.slotDate = e.target.value;
                draw();
              },
            },
          ),
        ),
        h('label', { class: 'f' }, 'Start time', h('input', { type: 'time', id: 'sf-time', value: f.time, step: 900, oninput: (e) => (f.time = e.target.value) })),
        h('label', { class: 'f' }, 'Room', h('select', { id: 'sf-room', onchange: (e) => ((f.room = e.target.value), draw()) }, roomNames().map((r) => h('option', { selected: f.room === r }, r))), roomClash(f.slotDate, f.time, f.room, c && c.id)),
      ),
      h(
        'div',
        { class: 'fg' },
        [0, 1].map((i) =>
          h(
            'label',
            { class: 'f' },
            `${who} ${i + 1}`,
            h(
              'select',
              {
                id: `sf-int-${i}`,
                onchange: (e) => {
                  f.interviewers[i] = e.target.value;
                  draw();
                },
              },
              h('option', { value: '' }, 'Choose…'),
              pool.map((p) => h('option', { value: p.id, selected: f.interviewers[i] === p.id }, label(p))),
              h('option', { value: 'natalie', selected: f.interviewers[i] === 'natalie' }, 'Natalie (HR, last resort)'),
            ),
          ),
        ),
      ),
      problems.length ? h('p', { class: 'warn-line' }, problems.join(' ')) : h('p', { class: 'small muted' }, 'Different teams: OK.'),
      !pool.length ? h('p', { class: 'warn-line' }, `No ${who.toLowerCase()}s on the roster yet.`) : null,
    );
  }

  function removeStep(c, key) {
    const timeline = (c.timeline || []).map((e) => (e.step === key && !e.voided ? { ...e, voided: true } : e));
    ui.openStep = null;
    saveCandidate(c, { timeline }, 'Step removed');
  }

  function candidateAdmin(c, s) {
    const box = h('div', { style: 'display:flex;flex-direction:column;gap:10px' });
    let mode = null;
    function draw() {
      const parts = [];
      if (mode === 'edit') {
        const f = { name: c.name, email: c.email || '', phone: c.phone || '', hrDate: c.hrDate || '', notes: c.notes || '' };
        parts.push(
          h(
            'div',
            { class: 'step-form', style: 'margin:0' },
            h(
              'div',
              { class: 'fg' },
              h('label', { class: 'f wide' }, 'Name', h('input', { id: 'ed-name', value: f.name, oninput: (e) => (f.name = e.target.value) })),
              h('label', { class: 'f' }, 'Email', h('input', { id: 'ed-email', value: f.email, oninput: (e) => (f.email = e.target.value) })),
              h('label', { class: 'f' }, 'Phone', h('input', { id: 'ed-phone', value: f.phone, oninput: (e) => (f.phone = e.target.value) })),
              h('label', { class: 'f' }, 'HR interview date', h('input', { id: 'ed-hr', type: 'date', value: f.hrDate, oninput: (e) => (f.hrDate = e.target.value) })),
              h('label', { class: 'f wide' }, 'Notes', h('textarea', { id: 'ed-notes', value: f.notes, oninput: (e) => (f.notes = e.target.value) })),
            ),
            h(
              'div',
              { class: 'row end' },
              h(
                'button',
                {
                  type: 'button',
                  onclick: () => {
                    mode = null;
                    draw();
                  },
                },
                'Cancel',
              ),
              h('button', { type: 'button', class: 'p', onclick: () => f.name.trim() && saveCandidate(c, { ...f, name: f.name.trim() }, 'Details saved') }, 'Save details'),
            ),
          ),
        );
      } else if (mode === 'delete') {
        parts.push(
          h(
            'div',
            { class: 'row' },
            h('span', { class: 'err-line' }, `Delete ${c.name} and their whole timeline? This can’t be undone.`),
            h(
              'button',
              {
                onclick: () => {
                  mode = null;
                  draw();
                },
              },
              'Keep',
            ),
            h(
              'button',
              {
                class: 'danger',
                onclick: () =>
                  act(async () => {
                    await S.remove('candidates', c.id);
                    closeDrawer();
                  }, 'Candidate deleted'),
              },
              'Delete',
            ),
          ),
        );
      } else {
        parts.push(
          h(
            'div',
            { class: 'row' },
            h(
              'button',
              {
                onclick: () => {
                  mode = 'edit';
                  draw();
                },
              },
              'Edit details',
            ),
            s.status === 'open'
              ? h(
                  'button',
                  {
                    onclick: () => {
                      ui.openStep = 'closed';
                      rerender();
                    },
                  },
                  'Withdraw or close',
                )
              : null,
            h(
              'button',
              {
                class: 'danger',
                onclick: () => {
                  mode = 'delete';
                  draw();
                },
              },
              'Delete',
            ),
          ),
        );
      }
      fill(box, parts);
    }
    draw();
    return box;
  }



  // ------------------------------------------------------------------
  // Interviewer requests (invites)
  // ------------------------------------------------------------------
  const roundOf = (s) => (s.stage === 'deepdive' || s.stage === 'hired' ? 'deepdive' : 'advisor');
  function roundInvites(c, round) {
    const s = cstate(c);
    const r = round || roundOf(s);
    const list = S.state.invites.filter((i) => i.candidateId === c.id && i.round === r);
    const camp = S.state.campaigns.find((x) => x.id === c.campaignId) || campaign();
    const st = M.inviteState(list, S.state.people, { today: TODAY, replyDays: camp && camp.settings ? camp.settings.replyWindowWorkingDays : 2 });
    return { round: r, list, state: st };
  }
  const pname = (id) => {
    const p = personById(id);
    return p ? `${p.name} (${p.team})` : 'someone';
  };
  const first = (c) => (c.name || '').split(' ')[0];
  const nowIso = () => `${TODAY}T${new Date().toISOString().slice(11)}`;

  function inviteTodoItems() {
    const items = [];
    for (const c of candidates()) {
      const s = cstate(c);
      if (s.status !== 'open') continue;
      const { round, list, state } = roundInvites(c);
      if (!list.length) continue;
      const bookedKey = round === 'deepdive' ? 'deepdive_booked' : 'advisor_booked';
      const slot = list[0];
      const when = `${M.formatDay(slot.slotDate)} ${slot.time || ''}`.trim();
      if (state.complete && !s.done[bookedKey]) {
        items.push({ group: 'today', kind: 'Send', tone: 'accent', who: c.name, text: `Pair complete for ${when}: ${state.pair.map(pname).join(' + ')}. Book it and send ${first(c)}'s invite.`, btn: 'Book', cand: c.id, step: bookedKey, prefill: true, sortKey: 5 });
      }
      for (const r of state.toRelease) {
        if (r.invite.slotDate < TODAY) continue;
        const notice = M.daysBetween(TODAY, r.invite.slotDate);
        items.push({ group: 'today', kind: 'Release', tone: 'accent', who: pname(r.invite.personId), text: `Release from ${first(c)}'s ${when} slot: ${M.RELEASE_REASONS[r.why]}. Notice: ${plural(notice, 'day')}.`, btn: 'Release', invite: r.invite, why: r.why, sortKey: 6 });
      }
      if (!state.complete && state.shortBy > 0) {
        items.push({ group: 'today', kind: 'Top up', tone: 'warn', who: c.name, text: `${state.declined.length ? `${state.declined.map((i) => pname(i.personId)).join(', ')} declined. ` : ''}Ask ${plural(state.shortBy, 'more person', 'more people')} for ${when}.`, btn: 'Ask', cand: c.id, step: null, sortKey: 4 });
      }
      for (const i of state.overdue) {
        if (state.complete) continue;
        items.push({ group: 'today', kind: 'Chase', tone: 'warn', who: pname(i.personId), text: `No reply to ${first(c)}'s ${when} request since ${M.formatDay(i.sentAt.slice(0, 10))}. Chase, or ask someone else.`, btn: 'Open', cand: c.id, step: null, sortKey: 7 });
      }
    }
    return items;
  }

  // Room clash check: other candidates' interviews, holds and waiting requests in the same hour.
  const busyRooms = (date, time, exceptCand) => M.roomsInUse({ cands: S.state.candidates, invites: S.state.invites, date, time, exceptCandidateId: exceptCand });
  function roomClash(date, time, room, exceptCand) {
    if (!date || !time || !room) return null;
    const busy = busyRooms(date, time, exceptCand);
    const hit = busy.get(room);
    if (!hit) return null;
    const other = S.state.candidates.find((x) => x.id === hit.candidateId);
    const free = roomNames().find((n) => !busy.has(n));
    return h('span', { class: 'small warn-t' }, `Taken at ${hit.time} for ${other ? first(other) : 'another candidate'}. ${free ? `${free} is free.` : 'No room is free then.'}`);
  }

  function releaseInvite(inv, why) {
    ui.outlookDraft = releaseDraft(inv);
    return act(() => S.update('invites', inv.id, { status: 'released', releaseReason: why || 'pair_filled', releasedAt: nowIso(), noticeDays: M.daysBetween(TODAY, inv.slotDate) }), `${pname(inv.personId)} released`);
  }
  function answerInvite(inv, status, via, reason) {
    return act(() => S.update('invites', inv.id, { status, respondedAt: nowIso(), via: via || 'outlook', declineReason: reason || '' }), `${pname(inv.personId)}: ${status}`);
  }

  function requestsSection(c, s) {
    if (s.status !== 'open' || s.stage === 'hr') return null;
    const { round, list, state } = roundInvites(c);
    const bookedKey = round === 'deepdive' ? 'deepdive_booked' : 'advisor_booked';
    const roundObj = roundByKey(campaign(), round);
    const releaseIds = new Set(state.toRelease.map((r) => r.invite.id));
    const chip = (i) => {
      const tone = { accepted: 'good', declined: 'bad', pending: releaseIds.has(i.id) ? 'warn' : 'accent', released: '', cancelled: '' }[i.status];
      return h('span', { class: `chip ${tone}` }, releaseIds.has(i.id) && i.status === 'pending' ? 'Release' : M.INVITE_STATUS[i.status]);
    };
    const rows = list
      .slice()
      .sort((a, b) => (a.sentAt || '').localeCompare(b.sentAt || ''))
      .map((i) =>
        h(
          'div',
          { class: 'row small', style: 'justify-content:space-between;border-top:1px solid var(--line);padding:6px 10px' },
          h('span', {}, h('b', {}, pname(i.personId)), ' ', chip(i), i.via === 'app' || i.via === 'mock' ? h('span', { class: 'faint' }, ` via ${i.via === 'app' ? 'the app' : 'mock'}`) : null, i.declineReason ? h('span', { class: 'faint' }, ` · ${i.declineReason}`) : null),
          h(
            'span',
            { class: 'row' },
            i.status === 'pending' && !releaseIds.has(i.id) ? [h('button', { onclick: () => answerInvite(i, 'accepted') }, 'Accepted'), h('button', { onclick: () => answerInvite(i, 'declined') }, 'Declined')] : null,
            releaseIds.has(i.id) ? h('button', { class: 'p', onclick: () => releaseInvite(i, state.toRelease.find((r) => r.invite.id === i.id).why) }, 'Release') : null,
          ),
        ),
      );
    const head = list.length
      ? state.complete
        ? h('div', { class: 'row', style: 'justify-content:space-between;padding:8px 10px' }, h('span', { class: 'small' }, h('b', {}, 'Pair complete: '), state.pair.map(pname).join(' + ')), !s.done[bookedKey] ? h('button', { class: 'p', onclick: () => prefillBooking(c, bookedKey, list, state) }, 'Book with this pair') : h('span', { class: 'row' }, h('span', { class: 'chip good' }, 'Booked'), h('button', { onclick: () => ((ui.outlookDraft = bookingDraft(c, round, s.done[bookedKey].data || {})), rerender()) }, 'Outlook invite')))
        : h('p', { class: 'small', style: 'padding:8px 10px' }, `${M.formatDay(list[0].slotDate)} ${list[0].time || ''}, ${list[0].room || ''}: ${state.accepted.length} of ${roundObj.interviewers} accepted, ${state.pending.length} waiting${state.shortBy ? `. Ask ${plural(state.shortBy, 'more person', 'more people')}.` : '.'}`)
      : null;
    return h(
      'section',
      { class: 'tpanel', 'aria-label': 'Interviewer requests' },
      h('div', { class: 'ph' }, `Interviewer requests · ${roundObj.name}`, h('span', { class: 'faint' }, 'replies come from Outlook or the app')),
      head,
      s.done[bookedKey] && !(list.length && state.complete)
        ? h('div', { class: 'row', style: 'justify-content:space-between;padding:8px 10px' }, h('span', { class: 'small' }, h('b', {}, 'Booked: '), `${M.formatDay((s.done[bookedKey].data || {}).slotDate || s.done[bookedKey].at)} ${(s.done[bookedKey].data || {}).time || ''}`), h('button', { onclick: () => ((ui.outlookDraft = bookingDraft(c, round, s.done[bookedKey].data || {})), rerender()) }, 'Outlook invite'))
        : null,
      rows,
      outlookPanel(c),
      !list.filter((i) => i.status === 'pending' || i.status === 'accepted').length && !s.done[bookedKey] ? slotSuggestions(c, s, round, roundObj) : null,
      !state.complete ? askForm(c, round, roundObj, list) : null,
    );
  }

  function prefillBooking(c, key, list, state) {
    ui.forms = ui.forms || {};
    const slot = list.find((i) => state.pair.includes(i.personId)) || list[0];
    ui.forms[`${c.id}:${key}:new`] = { at: TODAY, outcome: null, note: '', availability: '', slots: [], slotDate: slot.slotDate, time: slot.time || '', room: slot.room || roomNames()[0], interviewers: [...state.pair], reason: '' };
    ui.openStep = key;
    rerender();
  }

  function askForm(c, round, roundObj, list) {
    const key = `ask:${c.id}:${round}`;
    ui.forms = ui.forms || {};
    const asked = new Set(list.filter((i) => i.status !== 'cancelled').map((i) => i.personId));
    const f = ui.forms[key] || (ui.forms[key] = { open: !list.length, slotDate: list[0] ? list[0].slotDate : '', time: list[0] ? list[0].time : '10:00', room: list[0] ? list[0].room : roomNames()[0], picked: [] });
    const box = h('div', { style: 'border-top:1px solid var(--line);padding:8px 10px;display:flex;flex-direction:column;gap:8px' });
    const role = roundObj.role;
    const load = interviewLoad();
    function candidatesFor() {
      const snaps = availSources();
      return people()
        .filter((p) => inRound(c, round, p) && !asked.has(p.id))
        .map((p) => {
          const a = f.slotDate ? M.availabilityOn(snaps, p.id, role, f.slotDate) : null;
          const hour = Number((f.time || '10:00').slice(0, 2));
          const half = hour < 12 ? 'am' : 'pm';
          let score = 1;
          let label = 'no poll answer';
          if (a && a.value) {
            const free = a.value === 'all' || a.value === half;
            score = free ? 0 : 2;
            label = a.value === 'no' ? 'not available' : free ? `free (${M.VALUES[a.value].label.toLowerCase()})` : `only ${M.VALUES[a.value].label.toLowerCase()}`;
            if (a.window) label += `, ${a.window.from || ''}-${a.window.to || ''}`;
            if (a.tentative) label += ', check first';
          }
          if ((p.roles || []).includes('joker')) score += 0.5;
          return { p, score, label, load: load[p.id] || 0 };
        })
        .sort((a, b) => a.score - b.score || a.load - b.load || a.p.name.localeCompare(b.p.name));
    }
    function suggest() {
      const n = (campaign().settings || M.DEFAULT_SETTINGS).invitesPerSlot || 3;
      const taken = new Set(list.filter((i) => i.status === 'accepted' || i.status === 'pending').map((i) => (personById(i.personId) || {}).team));
      const out = [];
      for (const x of candidatesFor()) {
        if (out.length >= Math.max(1, n - list.filter((i) => i.status === 'pending' || i.status === 'accepted').length)) break;
        if (x.score >= 2 || taken.has(x.p.team)) continue;
        taken.add(x.p.team);
        out.push(x.p.id);
      }
      f.picked = out;
    }
    function draw() {
      if (!f.open) {
        fill(box, h('button', { onclick: () => ((f.open = true), f.slotDate && suggest(), draw()) }, list.length ? '+ Ask more people' : 'Ask interviewers'));
        return;
      }
      const opts = candidatesFor();
      const pickedTeams = f.picked.map((id) => (personById(id) || {}).team);
      fill(
        box,
        h('div', { class: 'small muted' }, 'Pick a slot, then who to ask. Different teams first, then whoever is free and has done the fewest interviews.'),
        h(
          'div',
          { class: 'fg' },
          h('label', { class: 'f' }, 'Date', h('input', { type: 'date', id: `ask-date-${c.id}`, value: f.slotDate, onchange: (e) => ((f.slotDate = e.target.value), suggest(), draw()) })),
          h('label', { class: 'f' }, 'Start', h('input', { type: 'time', id: `ask-time-${c.id}`, step: 900, value: f.time, onchange: (e) => ((f.time = e.target.value), suggest(), draw()) })),
          h('label', { class: 'f' }, 'Room', h('select', { id: `ask-room-${c.id}`, onchange: (e) => ((f.room = e.target.value), draw()) }, roomNames().map((r) => h('option', { selected: f.room === r }, r))), roomClash(f.slotDate, f.time, f.room, c && c.id)),
        ),
        f.slotDate
          ? h(
              'div',
              { style: 'max-height:220px;overflow:auto;border:1px solid var(--grid);border-radius:4px' },
              opts.map((x) =>
                h(
                  'label',
                  { class: 'check', style: 'display:flex;padding:4px 8px;border-top:1px solid var(--line)' },
                  h('input', { type: 'checkbox', checked: f.picked.includes(x.p.id), onchange: (e) => ((f.picked = e.target.checked ? [...f.picked, x.p.id] : f.picked.filter((id) => id !== x.p.id)), draw()) }),
                  h('span', { style: 'flex:1' }, `${x.p.name} `, h('span', { class: 'team' }, x.p.team)),
                  h('span', { class: `small ${x.score === 0 ? '' : 'faint'}` }, `${x.label}${x.load ? ` · ${x.load} done` : ''}`),
                ),
              ),
            )
          : null,
        new Set(pickedTeams).size < pickedTeams.length ? h('p', { class: 'warn-line' }, 'Two of these are on the same team. That works, but one will be released if both accept.') : null,
        h(
          'div',
          { class: 'row end' },
          list.length ? h('button', { onclick: () => ((f.open = false), draw()) }, 'Cancel') : null,
          h(
            'button',
            {
              class: 'p',
              disabled: !f.slotDate || !f.picked.length,
              onclick: () =>
                createRequests(c, round, f).then(() => {
                  ui.forms[key] = { ...f, open: false, picked: [] };
                  rerender();
                }),
            },
            `Ask ${f.picked.length || ''}`.trim(),
          ),
        ),
      );
    }
    draw();
    return [box];
  }

  // Creates one request per picked person for the slot in f, and shows the Outlook text.
  function createRequests(c, round, f) {
    const ids = [...f.picked];
    return act(async () => {
      for (const id of ids) await S.add('invites', { campaignId: c.campaignId, candidateId: c.id, round, personId: id, slotDate: f.slotDate, time: f.time, room: f.room, status: 'pending', sentAt: nowIso(), via: 'outlook', mock: !!c.mock });
      ui.outlookDraft = requestDraft(c, round, { ...f, picked: ids });
      rerender();
    }, `${plural(ids.length, 'request')} created`);
  }

  // Suggested slots for a candidate whose availability is in and who has no requests out yet:
  // the candidate's times (or the days before the deadline), checked against the poll, with the
  // people furthest from their interview goal asked first.
  function slotSuggestions(c, s, round, roundObj) {
    const recv = s.done[round === 'deepdive' ? 'avail_received_final' : 'avail_received_r2'];
    if (!recv) return null;
    const camp = S.state.campaigns.find((x) => x.id === c.campaignId) || campaign();
    const settings = camp.settings || M.DEFAULT_SETTINGS;
    const until = (s.clock && s.clock.deadline) || M.addDays(TODAY, 7);
    const isWd = (d) => M.weekdayOf(d) >= 1 && M.weekdayOf(d) <= 5;
    const slots = (recv.data && recv.data.slots) || [];
    const options = [];
    const fits = (sl, t, end) => (!sl.from || sl.from <= t) && (!sl.to || sl.to >= end);
    if (slots.length) {
      for (const sl of slots) {
        if (sl.date <= TODAY || !isWd(sl.date)) continue;
        if (fits(sl, '10:00', '11:00')) options.push({ date: sl.date, time: '10:00' });
        if (fits(sl, '14:00', '15:00')) options.push({ date: sl.date, time: '14:00' });
      }
    } else {
      for (let d = M.addDays(TODAY, 1); d <= until; d = M.addDays(d, 1)) if (isWd(d)) options.push({ date: d, time: '10:00' }, { date: d, time: '14:00' });
    }
    const snaps = availSources();
    const freeOn = (pid, date, time) => {
      const a = M.availabilityOn(snaps, pid, roundObj.role, date);
      if (!a || !a.value) return null;
      if (a.value === 'no') return false;
      const half = time < '12:00' ? 'am' : 'pm';
      if (a.value !== 'all' && a.value !== half) return false;
      if (a.window && ((a.window.from && a.window.from > time) || (a.window.to && a.window.to < `${String(Number(time.slice(0, 2)) + 1).padStart(2, '0')}${time.slice(2)}`))) return false;
      return a.tentative ? null : true;
    };
    const goals = M.interviewGoals({ camp, cands: campCands(camp.id), invites: campInvites(camp.id), people: S.state.people, today: TODAY });
    const load = interviewLoad();
    const members = people().filter((p) => p.active !== false && inRound(c, round, p));
    const picks = M.suggestSlots({
      options,
      members,
      freeOn,
      need: (id) => (goals[id] ? goals[id].goal - goals[id].done - goals[id].planned : 0),
      load: (id) => load[id] || 0,
      interviewers: roundObj.interviewers || 2,
      perSlot: settings.invitesPerSlot || 3,
      differentTeams: roundObj.differentTeams,
      preferFridays: settings.preferFridays,
      max: 3,
    });
    return h(
      'div',
      { class: 'suggest' },
      h('div', { class: 'label' }, slots.length ? 'Suggested, from the candidate’s times and the poll' : `Suggested, before the deadline (${M.formatDay(until)}) and from the poll`),
      picks.length
        ? picks.map((o) => {
            const room = roomNames(camp).find((r) => !busyRooms(o.date, o.time, c.id).has(r)) || roomNames(camp)[0];
            const ppl = o.ask.map((id) => personById(id)).filter(Boolean);
            return h(
              'div',
              { class: 'suggest-row' },
              h('div', {}, h('b', {}, `${M.formatDay(o.date)}, ${o.time}`), h('span', { class: 'muted' }, ` · ${room}`), h('div', { class: 'small muted' }, `Ask ${ppl.map((p) => `${p.name} (${p.team})`).join(', ')} · ${o.free} free in the poll`)),
              h('button', { class: 'p', onclick: () => createRequests(c, round, { slotDate: o.date, time: o.time, room, picked: o.ask }) }, `Ask these ${ppl.length}`),
            );
          })
        : h('p', { class: 'small muted' }, 'No slot has a free pair from different teams in the poll. Pick a slot by hand below.'),
    );
  }

  // ------------------------------------------------------------------
  // Outlook. Until the Flux Microsoft 365 connection exists, every invite,
  // release and confirmation is a draft that opens in Outlook on the web,
  // filled in (people, room, time, text), for Natalie to check and send.
  // Replies come in through a provider (see outlookProviders below).
  // ------------------------------------------------------------------
  const roundWhat = (round) => (round === 'deepdive' ? 'a deep dive (final round)' : 'an advisor interview');
  const draftLen = (round) => (roundByKey(campaign(), round) || {}).durationMin || 60;
  const noEmail = (ids) => ids.map(personById).filter((p) => p && !p.email).map((p) => p.name);
  const emailsOf = (ids) => ids.map(personById).filter((p) => p && p.email).map((p) => p.email);

  // The hold request: one meeting to everyone asked, with the room as a resource.
  function requestDraft(c, round, f) {
    const what = roundWhat(round);
    const subject = `Hold: ${what} on ${M.formatDay(f.slotDate)} ${f.time}, ${f.room}`;
    const body = `Hi,\n\nCould you hold ${M.formatDay(f.slotDate)} from ${f.time} for ${what} with a trainee candidate (${first(c)})? It's ${draftLen(round)} minutes, in person, with a colleague from another team.\n\nPlease accept or decline this invite. If more people accept than we need, I'll release the extra slot with as much notice as I can.\n\nThanks,\nNatalie`;
    const to = [...emailsOf(f.picked), roomEmail(f.room)];
    return { candId: c.id, title: 'Hold request, ready in Outlook', hint: 'Opens a new meeting with everyone asked and the room filled in. Check it and press Send.', subject, body, missing: noEmail(f.picked), link: M.outlookMeetingLink({ subject, body, date: f.slotDate, time: f.time, durationMin: draftLen(round), location: f.room, to }) };
  }
  // Releasing someone: remove them from the hold meeting in Outlook (that sends the
  // cancellation), and this note says thanks and why.
  function releaseDraft(inv) {
    const c = S.state.candidates.find((x) => x.id === inv.candidateId) || { name: 'the candidate' };
    const p = personById(inv.personId) || { name: 'there' };
    const subject = `Released: ${roundWhat(inv.round)} on ${M.formatDay(inv.slotDate)} ${inv.time || ''}`.trim();
    const body = `Hi ${p.name.split(' ')[0]},\n\nThanks for holding ${M.formatDay(inv.slotDate)}${inv.time ? ` at ${inv.time}` : ''} for ${first(c)}. The pair is complete, so you're free again. I've taken you off the meeting.\n\nThanks,\nNatalie`;
    return { candId: inv.candidateId, title: `Release ${p.name}`, hint: `Remove ${p.name} from the hold meeting in Outlook (that sends the cancellation), then send this note.`, subject, body, missing: noEmail([inv.personId]), link: M.outlookMailLink({ to: emailsOf([inv.personId]), subject, body }) };
  }
  // The booking: the confirmed meeting for the pair and the room, and a note to the candidate.
  function bookingDraft(c, round, d) {
    const what = roundWhat(round);
    const ids = d.interviewers || [];
    const names = ids.map((id) => (personById(id) || {}).name || 'a colleague').join(' and ');
    const subject = `${round === 'deepdive' ? 'Deep dive' : 'Advisor interview'}: ${c.name.replace(/ \(demo\)$/, '')}, ${M.formatDay(d.slotDate)} ${d.time || ''}`.trim();
    const body = `Hi,\n\nConfirmed: ${what} with ${c.name.replace(/ \(demo\)$/, '')} on ${M.formatDay(d.slotDate)}${d.time ? ` at ${d.time}` : ''} in ${d.room || 'the office'}, with ${names}. The interview brief is in the Flux interviews app.\n\nThanks,\nNatalie`;
    const candSubject = `Your interview at Flux Partners on ${M.formatDay(d.slotDate)}`;
    const candBody = `Hi ${first(c)},\n\nYour next interview is on ${M.formatDay(d.slotDate)}${d.time ? ` at ${d.time}` : ''}, at our office (${d.room || 'reception will show you the way'}). You'll meet ${names}. It takes about ${draftLen(round)} minutes.\n\nKind regards,\nNatalie`;
    return {
      candId: c.id,
      title: 'Confirmed interview, ready in Outlook',
      hint: 'Send the hold holders the confirmed meeting with the room, then let the candidate know.',
      subject,
      body,
      missing: noEmail(ids),
      link: M.outlookMeetingLink({ subject, body, date: d.slotDate, time: d.time, durationMin: draftLen(round), location: d.room, to: [...emailsOf(ids), roomEmail(d.room)] }),
      extra: { label: c.email ? 'Email the candidate' : 'Email the candidate (no address yet)', link: M.outlookMailLink({ to: c.email ? [c.email] : [], subject: candSubject, body: candBody }) },
    };
  }
  function outlookPanel(c) {
    const d = ui.outlookDraft && ui.outlookDraft.candId === c.id ? ui.outlookDraft : null;
    if (!d) return null;
    const text = `Subject: ${d.subject}\n\n${d.body}`;
    return h(
      'div',
      { class: 'outlook-draft' },
      h('div', { class: 'row', style: 'justify-content:space-between' }, h('b', { class: 'small' }, d.title), h('button', { class: 'link small', 'aria-label': 'Close the draft', onclick: () => ((ui.outlookDraft = null), rerender()) }, 'Done')),
      h('p', { class: 'small muted' }, d.hint),
      d.missing && d.missing.length ? h('p', { class: 'small warn-t' }, `No email for ${d.missing.join(', ')}. Add it in Roster, or type it in Outlook.`) : null,
      h(
        'div',
        { class: 'row' },
        h('a', { class: 'btn p', href: d.link, target: '_blank', rel: 'noopener' }, 'Open in Outlook'),
        d.extra ? h('a', { class: 'btn', href: d.extra.link, target: '_blank', rel: 'noopener' }, d.extra.label) : null,
        h('button', { onclick: (e) => copyText(text, e.target) }, 'Copy text'),
      ),
      h('details', {}, h('summary', { class: 'small' }, 'Show the text'), h('pre', { class: 'small' }, text)),
    );
  }
  function copyText(text, btn) {
    try {
      navigator.clipboard.writeText(text).then(
        () => (btn.textContent = 'Copied'),
        () => (btn.textContent = 'Select the text to copy'),
      );
    } catch (e) {
      btn.textContent = 'Select the text to copy';
    }
  }
  function interviewLoad() {
    const load = {};
    for (const i of S.state.invites) if (i.status === 'accepted') load[i.personId] = (load[i.personId] || 0) + 1;
    return load;
  }

  // ------------------------------------------------------------------
  // Roster: link people to Claude accounts
  // ------------------------------------------------------------------
  function accountCell(p) {
    if (ui.linking === p.id) return accountPicker(p);
    if (p.access === 'manual' && !p.accountId) return h('span', { class: 'faint' }, 'No Claude · Outlook only');
    if (!p.accountId) return h('button', { class: 'link', onclick: () => ((ui.linking = p.id), rerender()) }, 'Link');
    const isMock = p.accountId.startsWith('mock:');
    if (!isMock) resolveNames([p.accountId]);
    return h(
      'span',
      { class: 'row' },
      h('span', { class: `chip ${isMock ? 'warn' : 'good'}` }, isMock ? 'Mock account' : names[p.accountId] || 'Linked'),
      memberOf(p.accountId) ? h('span', { class: 'chip good', title: `Said “I’m in” on ${M.formatDay(memberOf(p.accountId).acceptedAt.slice(0, 10))}` }, 'Joined ✓') : h('span', { class: 'faint small' }, 'Not joined yet'),
      h('button', { class: 'link', onclick: () => act(() => S.update('people', p.id, { accountId: null }), 'Unlinked') }, 'Unlink'),
    );
  }
  function accountPicker(p) {
    const box = h('div', { style: 'display:flex;flex-direction:column;gap:4px;min-width:220px' });
    const results = h('div', { style: 'display:flex;flex-direction:column;gap:2px' });
    const canSearch = S.user && typeof S.user.search === 'function';
    async function search(q) {
      if (!canSearch) return;
      try {
        const hits = await S.user.search(q);
        fill(
          results,
          (hits || []).slice(0, 6).map((hit) => h('button', { style: 'text-align:left', onclick: () => act(async () => { await S.update('people', p.id, { accountId: hit.id }); ui.linking = null; rerender(); }, `${p.name} linked`) }, hit.name || 'Unnamed account')),
          hits && hits.length ? null : h('span', { class: 'faint small' }, 'No one found in your organization.'),
        );
      } catch (e) {
        fill(results, h('span', { class: 'faint small' }, 'Search isn’t available here.'));
      }
    }
    fill(
      box,
      canSearch ? h('input', { id: `acct-${p.id}`, placeholder: `Search ${p.name}…`, onfocus: (e) => search(e.target.value), oninput: (e) => search(e.target.value) }) : h('span', { class: 'faint small' }, 'Account search works on claude.ai.'),
      results,
      h('div', { class: 'row' }, h('button', { onclick: () => act(async () => { await S.update('people', p.id, { accountId: `mock:${p.id}` }); ui.linking = null; rerender(); }, 'Mock account linked') }, 'Use a mock account'), h('button', { class: 'link', onclick: () => ((ui.linking = null), rerender()) }, 'Cancel')),
    );
    return box;
  }

  // ------------------------------------------------------------------
  // Mock sidecar: a test tool to feel the flow end to end
  // ------------------------------------------------------------------
  // ------------------------------------------------------------------
  // Mock: fast-forward the flow. You play Natalie; colleagues and
  // candidates answer on their own as the simulated days pass. Only mock
  // data (demo candidates and their requests) is touched.
  // ------------------------------------------------------------------
  const sim = (ui.sim = ui.sim || { replies: true, candidates: true, feedback: true, log: [], busy: false });
  function simLog(day, text) {
    sim.log.unshift({ day, text });
    sim.log.length = Math.min(sim.log.length, 80);
  }

  function sidecar() {
    if (!ui.mockOpen || !campaign()) return null;
    const mockCands = S.state.candidates.filter((c) => c.mock);
    const toggle = (k, label, hint) =>
      h('label', { class: 'check' }, h('input', { type: 'checkbox', id: `sim-${k}`, checked: sim[k], onchange: (e) => (sim[k] = e.target.checked) }), h('span', {}, label, h('span', { class: 'small faint' }, ` · ${hint}`)));
    return h(
      'aside',
      { class: 'sidecar', 'aria-label': 'Mock sidecar' },
      h('div', { class: 'row', style: 'justify-content:space-between' }, h('h2', {}, 'Mock: fast-forward'), h('button', { class: 'x', 'aria-label': 'Close mock sidecar', onclick: () => ((ui.mockOpen = false), rerender()) }, '×')),
      h('p', { class: 'small muted' }, 'You play Natalie. Move the days forward and the colleagues and candidates answer on their own, so you can watch an interview go from request to feedback. Only demo candidates are touched, and everything is marked as mock.'),
      mockCands.length
        ? null
        : h('div', { class: 'mock-card' }, h('p', { class: 'small' }, 'Start with a demo campaign: 16 candidates in every stage, three weeks of interviews, feedback and scores, and requests out for the week ahead.'), h('div', { class: 'row' }, h('button', { class: 'p', onclick: loadFullDemo }, 'Load demo campaign'), h('button', { onclick: loadDemo }, 'Load demo candidates'))),
      h(
        'section',
        { class: 'mock-sec' },
        h('h3', {}, 'Time'),
        h(
          'div',
          { class: 'row' },
          h('span', { class: 'small' }, 'Today is'),
          h('input', {
            type: 'date',
            id: 'mock-today',
            value: TODAY,
            onchange: (e) => {
              TODAY = e.target.value || REAL_TODAY;
              store('flux.mockToday', TODAY === REAL_TODAY ? '' : TODAY);
              rerender();
            },
          }),
          TODAY !== REAL_TODAY ? h('button', { class: 'link', onclick: () => shiftDay(0) }, 'Back to real today') : null,
        ),
        h(
          'div',
          { class: 'row' },
          h('button', { class: 'p', disabled: sim.busy, onclick: () => fastForward(1) }, 'Next day ▸'),
          h('button', { disabled: sim.busy, onclick: () => fastForward(7) }, 'Skip a week ▸▸'),
          h('button', { disabled: sim.busy, onclick: () => fastForward(0) }, 'Replies now'),
        ),
      ),
      h(
        'section',
        { class: 'mock-sec' },
        h('h3', {}, 'Who answers on their own'),
        toggle('replies', 'Colleagues answer requests', 'accept if the poll says they’re free'),
        toggle('candidates', 'Candidates send availability', 'the day after you ask'),
        toggle('feedback', 'Interviewers write feedback', 'the day after the interview'),
      ),
      h(
        'section',
        { class: 'mock-sec' },
        h('h3', {}, 'What happened'),
        sim.log.length
          ? h('ul', { class: 'sim-log' }, sim.log.map((x) => h('li', {}, h('span', { class: 'mono faint' }, short(x.day)), ' ', x.text)))
          : h('p', { class: 'small muted' }, 'Nothing yet. Press “Next day”, then check the to-do list.'),
      ),
      h(
        'section',
        { class: 'mock-sec' },
        h('h3', {}, 'Demo data'),
        h('div', { class: 'row' }, mockCands.length ? h('button', { onclick: loadDemo }, 'Add demo candidates') : null, h('button', { class: 'danger', onclick: clearMock }, 'Clear mock data')),
      ),
    );
  }

  function shiftDay(n) {
    TODAY = n ? M.addDays(TODAY, n) : REAL_TODAY;
    store('flux.mockToday', TODAY === REAL_TODAY ? '' : TODAY);
    rerender();
  }

  async function fastForward(days) {
    if (sim.busy) return;
    sim.busy = true;
    rerender();
    try {
      if (!days) await simulateDay();
      for (let i = 0; i < days; i++) {
        TODAY = M.addDays(TODAY, 1);
        store('flux.mockToday', TODAY === REAL_TODAY ? '' : TODAY);
        await simulateDay();
      }
    } catch (e) {
      toast(`Simulation stopped: ${(e && e.message) || 'error'}`);
    } finally {
      sim.busy = false;
      rerender();
    }
  }

  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const FEEDBACK = {
    pass: [
      'Structured answers and asked sharp questions about how we run tenders. Would like the deep dive to test planning under pressure.',
      'Calm, clear communicator. Gave a strong example of managing a difficult stakeholder at university. Go.',
      'Good analytical thinking on the case. A bit modest about own role; probe ownership in the next round.',
    ],
    unsure: [
      'Friendly and motivated, but examples stayed general. Not sure about client-facing confidence yet.',
      'Solid on content, hesitant when we pushed back. Would want a second opinion.',
    ],
    reject: [
      'Struggled to structure the case and didn’t ask any questions about the role. Not convinced.',
      'Motivation seemed to be mainly about the salary; little interest in the work itself.',
    ],
  };
  const LEAN_LABEL = { pass: 'Leaning yes', unsure: 'Unsure', reject: 'Leaning no' };
  const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  function candidateAvailabilityText() {
    const days = [];
    for (let d = M.addDays(TODAY, 2); days.length < 6; d = M.addDays(d, 1)) if (M.weekdayOf(d) >= 1 && M.weekdayOf(d) <= 5) days.push(d);
    const chosen = [...new Set([pick(days.slice(0, 3)), pick(days.slice(2)), days.find((d) => M.weekdayOf(d) === 5) || days[5]])].sort();
    const part = () => pick(['all day', 'in the morning', 'in the afternoon', 'all day']);
    return chosen.map((d) => `${WEEKDAY[M.weekdayOf(d)]} ${Number(d.slice(8))} ${M.formatDay(d).split(' ').pop()} ${part()}`).join(', ');
  }

  // Where Outlook replies come from. Each provider reads the answers to the
  // requests it is given and returns [{ invite, status, reason, respondedAt }].
  //  manual: Natalie reads Outlook and presses Accepted or Declined (nothing to read here).
  //  mock:   Mock answers for colleagues, following the poll.
  //  m365:   (later) reads the meeting responses through the Flux Microsoft 365 connection.
  const outlookProviders = {
    manual: { label: 'By hand', async readReplies() { return []; } },
    mock: {
      label: 'Mock',
      async readReplies(pending, { day, srcs }) {
        const out = [];
        for (const i of pending) {
          if ((i.sentAt || '').slice(0, 10) >= day) continue;
          const role = i.round === 'deepdive' ? 'teamlead' : 'advisor';
          const a = M.availabilityOn(srcs, i.personId, role, i.slotDate);
          const half = Number((i.time || '10').slice(0, 2)) < 12 ? 'am' : 'pm';
          const free = a && (a.value === 'all' || a.value === half);
          const yes = free ? Math.random() < 0.85 : a && a.value === 'no' ? false : Math.random() < 0.4;
          const reason = yes ? '' : free ? pick(['Client meeting came up', 'On a client site that day', 'Project deadline']) : 'Not available then';
          out.push({ invite: i, status: yes ? 'accepted' : 'declined', reason, respondedAt: `${day}T${pick(['08:40', '10:15', '13:05', '16:30'])}:00.000Z`, via: 'mock' });
        }
        return out;
      },
    },
  };
  async function applyOutlookReplies(replies) {
    let n = 0;
    for (const r of replies) {
      const i = r.invite;
      const c = S.state.candidates.find((x) => x.id === i.candidateId);
      await S.update('invites', i.id, { status: r.status, respondedAt: r.respondedAt || nowIso(), via: r.via || 'outlook', declineReason: r.reason || '' });
      if (c) simLog((r.respondedAt || nowIso()).slice(0, 10), `${pname(i.personId)} ${r.status === 'accepted' ? 'accepted' : `declined (${(r.reason || 'no reason').toLowerCase()})`} ${first(c)}’s ${M.formatDay(i.slotDate)} request.`);
      n++;
    }
    return n;
  }

  async function simulateDay() {
    const day = TODAY;
    const srcs = availSources();
    const byId = new Map(S.state.candidates.map((c) => [c.id, c]));
    let n = 0;
    // 1. Colleagues answer requests sent before today, through the mock Outlook.
    if (sim.replies) {
      const pending = S.state.invites.filter((x) => x.status === 'pending' && x.mock && byId.has(x.candidateId));
      n += await applyOutlookReplies(await outlookProviders.mock.readReplies(pending, { day, srcs }));
    }
    // 2. Candidates send availability the day after Natalie asks.
    if (sim.candidates) {
      for (const c of S.state.candidates.filter((x) => x.mock)) {
        const s = cstate(c);
        const trigger = s.next === 'avail_received_r2' ? s.done.avail_asked_r2 : s.next === 'avail_received_final' ? s.done.result_call_r2 : null;
        if (!trigger || trigger.at.slice(0, 10) >= day) continue;
        const text = candidateAvailabilityText();
        const ev = { id: S.uid('e'), step: s.next, at: day, outcome: null, recordedAt: nowIso(), note: '', data: { availability: text }, mock: true };
        await S.set('candidates', c.id, withSummary({ ...c, timeline: [...(c.timeline || []), ev] }));
        simLog(day, `${first(c)} sent availability: ${text}.`);
        n++;
      }
    }
    // 3. Interviews that happened yesterday or earlier get feedback.
    if (sim.feedback) {
      const notes = notesWithPerson();
      for (const iv of M.interviewsOf(S.state.candidates.filter((c) => c.mock), S.state.invites)) {
        if (iv.slotDate >= day) continue;
        if (notes.some((x) => x.kind === 'feedback' && x.personId === iv.personId && x.candidateId === iv.candidateId && x.round === iv.round)) continue;
        const p = personById(iv.personId);
        if (!p) continue;
        const lean = pick(['pass', 'pass', 'pass', 'unsure', 'reject']);
        // Feedback usually lands the day after, sometimes later.
        if (M.daysBetween(iv.slotDate, day) === 1 && Math.random() < 0.2) continue;
        await S.add('notes', { candidateId: iv.candidateId, campaignId: iv.campaignId, round: iv.round, kind: 'feedback', text: `${LEAN_LABEL[lean]}. ${pick(FEEDBACK[lean])}`, authorId: null, authorPersonId: p.id, authorLabel: p.name, mock: true, createdAt: `${day}T09:30:00.000Z` });
        simLog(day, `${p.name} sent feedback on ${first(byId.get(iv.candidateId))} (${LEAN_LABEL[lean].toLowerCase()}).`);
        n++;
      }
    }
    // Interviews happening today.
    for (const c of S.state.candidates.filter((x) => x.mock)) {
      for (const [round, key] of [['advisor', 'advisor_booked'], ['deepdive', 'deepdive_booked']]) {
        const b = cstate(c).done[key];
        if (b && b.data && b.data.slotDate === day) simLog(day, `${first(c)}’s ${ROUND_LABEL[round].toLowerCase()} takes place today${b.data.time ? ` at ${b.data.time}` : ''}. Record the result when the feedback is in.`);
      }
    }
  }

  function clearMock() {
    act(async () => {
      for (const coll of ['invites', 'notes', 'candidates', 'members', 'snapshots']) for (const d of S.state[coll].filter((x) => x.mock)) await S.remove(coll, d.id);
    }, 'Mock data cleared');
  }

  function loadDemo() {
    const camp = campaign();
    const d = (n) => M.addDays(TODAY, n);
    const now = nowIso();
    const e = (step, at, outcome, extra) => ({ id: S.uid('e'), step, at, outcome, recordedAt: now, note: '', ...(extra || {}) });
    // Next Friday at least 2 days out.
    let fri = d(2);
    while (M.weekdayOf(fri) !== 5) fri = M.addDays(fri, 1);
    const demo = [
      { name: 'Sanne de Vries (demo)', hrDate: d(-4), notes: 'Strong on tender writing. Available from January.', timeline: [e('hr_done', d(-4), 'pass'), e('avail_asked_r2', d(-4)), e('avail_received_r2', d(-2), null, { data: { availability: `Thursday morning, Friday all day` } })] },
      { name: 'Daan Bakker (demo)', hrDate: d(-1), notes: '', timeline: [e('hr_done', d(-1), 'pass'), e('avail_asked_r2', d(-1))] },
      { name: 'Lotte Visser (demo)', hrDate: d(-12), notes: 'Background in civil engineering.', timeline: [e('hr_done', d(-12), 'pass'), e('avail_asked_r2', d(-12)), e('avail_received_r2', d(-10)), e('advisor_booked', d(-9), null, { data: { slotDate: d(-6), time: '10:00', room: 'Room 1', interviewers: [] } }), e('advisor_done', d(-6), 'pass'), e('result_call_r2', d(-5))] },
      { name: 'Emma Jansen (demo)', hrDate: TODAY, notes: '', timeline: [] },
    ];
    act(async () => {
      const ids = [];
      for (const c of demo) ids.push(await S.add('candidates', withSummary({ ...c, campaignId: camp.id, email: '', phone: '', mock: true, createdAt: now })));
      // Sanne: three advisors asked for next Friday, from different teams.
      const pool = people().filter((p) => p.active !== false && (p.roles || []).includes('advisor'));
      const picked = [];
      const teams = new Set();
      for (const p of pool) {
        if (picked.length >= 3) break;
        if (teams.has(p.team)) continue;
        const a = M.availabilityOn(availSources(), p.id, 'advisor', fri);
        if (a && a.value === 'no') continue;
        picked.push(p);
        teams.add(p.team);
      }
      for (const p of picked) await S.add('invites', { campaignId: camp.id, candidateId: ids[0], round: 'advisor', personId: p.id, slotDate: fri, time: '10:00', room: 'Room 1', status: 'pending', sentAt: `${d(-1)}T09:00:00.000Z`, via: 'outlook', mock: true });
      // Lotte: feedback from the advisor round.
      const [a1, a2] = pool;
      if (a1) await S.add('notes', { candidateId: ids[2], campaignId: camp.id, round: 'advisor', kind: 'feedback', text: 'Leaning pass. Structured answers, good questions about the tender process. Less sure how she handles conflict with a client.', authorPersonId: a1.id, authorLabel: a1.name, mock: true, createdAt: `${d(-6)}T12:00:00.000Z` });
      if (a2) await S.add('notes', { candidateId: ids[2], campaignId: camp.id, round: 'advisor', kind: 'feedback', text: 'Leaning pass. Calm and analytical. Probe planning when several deadlines collide.', authorPersonId: a2.id, authorLabel: a2.name, mock: true, createdAt: `${d(-6)}T12:30:00.000Z` });
    }, 'Demo candidates loaded');
  }

  // A full demo campaign: three weeks of history and the week ahead, with
  // candidates in every stage, interviews held and booked, requests out,
  // feedback in, and (if there's no poll yet) a mock poll. Everything is
  // marked mock and goes with "Clear mock data". Built against today's date
  // and the current roster, so it always fits.
  async function buildFullDemo() {
    const camp = campaign();
    const T = TODAY;
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const isWd = (d) => M.weekdayOf(d) >= 1 && M.weekdayOf(d) <= 5;
    const wd = (n) => {
      let d = T;
      const step = n < 0 ? -1 : 1;
      for (let k = Math.abs(n); k > 0; ) {
        d = M.addDays(d, step);
        if (isWd(d)) k--;
      }
      if (!isWd(d)) while (!isWd(d)) d = M.addDays(d, step || 1);
      return d;
    };
    const now = nowIso();
    const active = people().filter((p) => p.active !== false);
    const advisors = active.filter((p) => (p.roles || []).includes('advisor'));
    const leads = active.filter((p) => (p.roles || []).some((r) => r === 'teamlead' || r === 'joker'));
    if (advisors.length < 4 || leads.length < 2) throw new Error('Add at least 4 advisors and 2 team leads to the roster first');

    // 1. A mock poll, only when the campaign has none.
    if (!snapshots().length) {
      const dates = [];
      for (let d = wd(-15); d <= wd(25); d = M.addDays(d, 1)) if (isWd(d)) dates.push(d);
      const cellFor = (d) => {
        const x = rnd() + (M.weekdayOf(d) === 5 ? 0.25 : 0);
        return x > 0.8 ? 'all' : x > 0.62 ? 'pm' : x > 0.45 ? 'am' : x > 0.08 ? 'no' : null;
      };
      const tab = (sheet, role, list) => ({ sheet, role, dates, rows: list.map((p) => ({ personId: p.id, name: p.name, team: p.team, remark: '', cells: Object.fromEntries(dates.map((d) => [d, cellFor(d)])), rules: [] })) });
      const tabs = [tab('Beschikbaarheid competentiegesprekken', 'advisor', advisors), tab('Beschikbaarheid Deepdive', 'teamlead', leads)];
      const r0 = tabs[0].rows[0];
      r0.remark = 'Op woensdagen tot uiterlijk 12 uur';
      r0.rules.push({ kind: 'window', dates: dates.filter((d) => M.weekdayOf(d) === 3), to: '12:00', summary: 'Wednesdays until 12:00', quote: r0.remark, source: 'claude', status: 'confirmed' });
      const snap = { campaignId: camp.id, fileName: 'Demo poll (mock).xlsx', pollDate: wd(-16), from: dates[0], to: dates[dates.length - 1], importedAt: now, tabs, mock: true };
      snap.stats = M.snapshotStats(snap);
      await S.add('snapshots', snap);
    }

    // 2. Interviewer pairs: two people from different teams, spreading the load.
    const load = new Map();
    const pair = (pool) => {
      const sorted = [...pool].sort((a, b) => (load.get(a.id) || 0) - (load.get(b.id) || 0) || rnd() - 0.5);
      const a = sorted[0];
      const b = sorted.find((p) => p.team !== a.team) || sorted[1];
      for (const p of [a, b]) load.set(p.id, (load.get(p.id) || 0) + 1);
      return [a, b];
    };
    const others = (pool, not, n) => [...pool].filter((p) => !not.includes(p)).sort(() => rnd() - 0.5).slice(0, n);
    const ev = (step, at, outcome, data, note) => ({ id: S.uid('e'), step, at, outcome: outcome || null, recordedAt: now, note: note || '', ...(data ? { data } : {}), mock: true });
    const avail = ['Tuesday all day, Thursday morning', 'Monday afternoon, Wednesday and Friday all day', 'Thursday and Friday all day', 'Any morning next week', 'Wednesday afternoon, Friday morning'];
    const times = ['09:30', '10:00', '13:30', '14:00', '15:30'];
    const rooms = ['Room 1', 'Room 2'];
    const FB = {
      pass: ['Leaning yes. Structured answers and sharp questions about how we run tenders. Test planning under pressure in the next round.', 'Leaning yes. Calm, clear communicator with a strong example of handling a difficult stakeholder.', 'Leaning yes. Good analytical thinking on the case. A bit modest about own role; probe ownership.'],
      reject: ['Leaning no. Struggled to structure the case and asked nothing about the role.', 'Leaning no. Examples stayed general and the motivation for consulting was thin.'],
      hire: ['Hire. Owned the case end to end and handled pushback well. Would fit TM or PM.', 'Hire. Mature, curious and clearly did homework on our clients.'],
    };

    // Each scenario: name, HR note, and how far the candidate got.
    const S_ = [
      ['Sanne de Vries', 'hired', -15], ['Thijs Mulder', 'hired', -14], ['Noor Hendriks', 'offer', -12],
      ['Bram Smit', 'dd_reject', -13], ['Lotte Visser', 'dd_booked', -9], ['Jesse van Dijk', 'dd_past', -10],
      ['Fleur de Boer', 'dd_requests', -8], ['Daan Bakker', 'adv_reject', -9], ['Emma Jansen', 'adv_call', -6],
      ['Lucas Meijer', 'adv_booked', -4], ['Sophie Bos', 'adv_past', -5], ['Milan de Groot', 'adv_requests', -3],
      ['Julia Peters', 'asked', -2], ['Tim Vos', 'avail_in', -2], ['Ruben Kok', 'hr_reject', -4], ['Eva van Leeuwen', 'hr_today', 0],
    ];
    const hrNotes = ['Strong on tender writing. Available from January.', 'Background in civil engineering; sharp on numbers.', 'Came via a referral from a former trainee.', 'Very motivated, a little nervous at the start.', '', ''];
    let made = 0;
    for (const [name, kind, hrN] of S_) {
      const hr = wd(hrN);
      const tl = [];
      const invites = [];
      const notes = [];
      const reject = kind === 'hr_reject';
      if (kind !== 'hr_today') tl.push(ev('hr_done', hr, reject ? 'reject' : 'pass'));
      if (reject) tl.push(ev('reject_call_hr', wd(hrN + 1), null, null, 'Told her kindly; open to a later intake.'), ev('closed', wd(hrN + 1), 'rejected'));
      const book = (round, pool, slot, opts) => {
        const [a, b] = pair(pool);
        const sent = M.addDays(slot, -4) < hr ? hr : M.addDays(slot, -4);
        const t = times[Math.floor(rnd() * times.length)];
        const room = rooms[Math.floor(rnd() * 2)];
        const reply = (h) => `${sent}T${String(9 + h).padStart(2, '0')}:${String(Math.floor(rnd() * 50) + 10)}:00.000Z`;
        for (const p of [a, b]) invites.push({ round, personId: p.id, slotDate: slot, time: t, room, status: 'accepted', sentAt: `${sent}T08:30:00.000Z`, respondedAt: reply(Math.floor(rnd() * 8)), via: rnd() < 0.7 ? 'outlook' : 'app' });
        for (const p of others(pool, [a, b], 1)) invites.push({ round, personId: p.id, slotDate: slot, time: t, room, status: rnd() < 0.5 ? 'declined' : 'released', sentAt: `${sent}T08:30:00.000Z`, respondedAt: reply(3), via: 'outlook', declineReason: 'Client meeting that day', releaseReason: 'Pair complete', releasedAt: `${sent}T15:00:00.000Z` });
        if (!opts || !opts.unbooked) tl.push(ev(`${round}_booked`, sent, null, { slotDate: slot, time: t, room, interviewers: [a.id, b.id] }));
        return [a, b];
      };
      const feedback = (round, pair_, slot, lean, both) => {
        pair_.slice(0, both ? 2 : 1).forEach((p, i) => notes.push({ round, kind: 'feedback', authorPersonId: p.id, authorLabel: p.name, text: FB[lean][(i + made) % FB[lean].length], createdAt: `${M.addDays(slot, i && rnd() < 0.3 ? 2 : 1)}T09:${10 + i * 20}:00.000Z` }));
      };
      const advFlow = ['hired', 'offer', 'dd_reject', 'dd_booked', 'dd_past', 'dd_requests', 'adv_reject', 'adv_call', 'adv_booked', 'adv_past', 'adv_requests', 'asked', 'avail_in'];
      if (advFlow.includes(kind)) {
        tl.push(ev('avail_asked_r2', hr));
        if (kind !== 'asked') tl.push(ev('avail_received_r2', wd(hrN + 1), null, { availability: avail[made % avail.length] }));
      }
      const advSlot = { hired: hrN + 3, offer: hrN + 3, dd_reject: hrN + 3, dd_booked: hrN + 3, dd_past: hrN + 3, dd_requests: hrN + 3, adv_reject: hrN + 3, adv_call: hrN + 4, adv_booked: 1, adv_past: -1 }[kind];
      if (advSlot !== undefined) {
        const slot = wd(advSlot);
        const pr = book('advisor', advisors, slot);
        if (slot < T) {
          const lean = kind === 'adv_reject' ? 'reject' : 'pass';
          feedback('advisor', pr, slot, lean, true);
          if (kind !== 'adv_past') tl.push(ev('advisor_done', M.addDays(slot, 1) > T ? T : wd(advSlot + 1), lean));
        }
      }
      if (kind === 'adv_requests') {
        const slot = wd(3);
        const ps = others(advisors, [], 3);
        const t = '10:00';
        [['accepted', 2], ['declined', 4], ['pending', 0]].forEach(([st, h], i) => ps[i] && invites.push({ round: 'advisor', personId: ps[i].id, slotDate: slot, time: t, room: 'Room 1', status: st, sentAt: `${wd(-1)}T08:30:00.000Z`, ...(st !== 'pending' ? { respondedAt: `${wd(-1)}T${10 + h}:05:00.000Z` } : {}), via: 'outlook', ...(st === 'declined' ? { declineReason: 'On a client site that day' } : {}) }));
      }
      const pastAdv = ['hired', 'offer', 'dd_reject', 'dd_booked', 'dd_past', 'dd_requests', 'adv_reject'];
      if (pastAdv.includes(kind)) {
        tl.push(ev('result_call_r2', wd(hrN + 5), null, null, kind === 'adv_reject' ? 'Disappointed but appreciated the feedback.' : 'Happy, asked what the deep dive looks like.'));
        if (kind === 'adv_reject') tl.push(ev('closed', wd(hrN + 5), 'rejected'));
        else tl.push(ev('avail_received_final', wd(hrN + 6), null, { availability: avail[(made + 2) % avail.length] }));
      }
      const ddSlot = { hired: hrN + 8, offer: -1, dd_reject: hrN + 8, dd_booked: 2, dd_past: -1 }[kind];
      if (ddSlot !== undefined) {
        const slot = wd(ddSlot);
        const pr = book('deepdive', leads, slot);
        if (slot < T) {
          const lean = kind === 'dd_reject' ? 'reject' : 'hire';
          feedback('deepdive', pr, slot, lean, kind !== 'dd_past');
          if (kind !== 'dd_past') tl.push(ev('deepdive_done', wd(ddSlot + (kind === 'offer' ? 0 : 1)), lean === 'hire' ? 'hire' : 'reject'));
        }
      }
      if (kind === 'dd_requests') {
        const slot = wd(4);
        const ps = others(leads, [], 3);
        [['accepted', 1], ['pending', 0], ['pending', 0]].forEach(([st, h], i) => ps[i] && invites.push({ round: 'deepdive', personId: ps[i].id, slotDate: slot, time: '14:00', room: 'Room 2', status: st, sentAt: `${wd(-1)}T08:30:00.000Z`, ...(st !== 'pending' ? { respondedAt: `${wd(-1)}T${10 + h}:40:00.000Z` } : {}), via: 'outlook' }));
      }
      if (kind === 'hired' || kind === 'dd_reject') {
        const d = wd(hrN + 10);
        tl.push(ev('final_call', d, null, null, kind === 'hired' ? 'Offer accepted on the phone. Starts in January.' : 'Took it well; asked for written feedback.'), ev('closed', d, kind === 'hired' ? 'hired' : 'rejected'));
      }
      const doc = withSummary({ name: `${name} (demo)`, campaignId: camp.id, email: '', phone: '', hrDate: hr, notes: hrNotes[made % hrNotes.length], timeline: tl, mock: true, createdAt: `${hr}T12:00:00.000Z` });
      const id = await S.add('candidates', doc);
      for (const i of invites) await S.add('invites', { campaignId: camp.id, candidateId: id, ...i, mock: true });
      for (const n of notes) await S.add('notes', { candidateId: id, campaignId: camp.id, authorId: null, mock: true, ...n });
      if (made % 3 === 0 && hrNotes[made % hrNotes.length]) await S.add('notes', { candidateId: id, campaignId: camp.id, round: 'hr', kind: 'note', text: `HR: ${hrNotes[made % hrNotes.length]}`, authorId: null, authorLabel: 'Natalie (HR)', mock: true, createdAt: `${hr}T13:00:00.000Z` });
      made++;
    }
    return made;
  }
  function loadFullDemo() {
    act(async () => {
      const n = await buildFullDemo();
      simLog(TODAY, `Loaded a demo campaign with ${n} candidates.`);
      ui.mockOpen = false;
      rerender();
    }, 'Demo campaign loaded. Today shows what needs you.');
  }

  // ------------------------------------------------------------------
  // Notes, feedback and Claude's interview brief
  // ------------------------------------------------------------------
  const NOTE_ROUNDS = [
    ['general', 'General'],
    ['hr', 'HR interview'],
    ['advisor', 'Advisor interview'],
    ['deepdive', 'Deep dive'],
  ];
  const names = {};
  let me = null;
  async function resolveNames(ids) {
    const u = S.user;
    const missing = ids.filter((id) => id && !(id in names));
    if (!u || !missing.length) return;
    missing.forEach((id) => (names[id] = ''));
    try {
      const ps = await u.profiles(missing);
      for (const id of missing) names[id] = (ps[id] && ps[id].name) || '';
      render();
    } catch (e) {
      /* names stay blank */
    }
  }
  function authorName(n) {
    if (n.authorId && me && n.authorId === me) return 'You';
    if (n.authorPersonId && personById(n.authorPersonId)) return `${personById(n.authorPersonId).name} (${personById(n.authorPersonId).team})${n.mock ? ' · mock' : ''}`;
    return (n.authorId && names[n.authorId]) || n.authorLabel || 'A colleague';
  }
  const notesFor = (c) => S.state.notes.filter((n) => n.candidateId === c.id).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

  function notesSection(c) {
    const list = notesFor(c);
    resolveNames([...new Set(list.map((n) => n.authorId))]);
    const s = cstate(c);
    const f = { text: '', round: s.stage === 'deepdive' ? 'deepdive' : s.stage === 'advisor' ? 'advisor' : 'general', kind: 'note' };
    const err = h('p', { class: 'err-line' });
    return h(
      'section',
      { class: 'dsec', 'aria-label': 'Notes and feedback' },
      h('h2', {}, 'Notes and feedback'),
      h(
        'div',
        { class: 'note-form' },
        h('textarea', { id: `note-text-${c.id}`, placeholder: 'What stood out, what to probe next round, your verdict and why…', oninput: (e) => (f.text = e.target.value) }),
        h(
          'div',
          { class: 'row' },
          h('select', { id: `note-round-${c.id}`, 'aria-label': 'About', onchange: (e) => (f.round = e.target.value) }, NOTE_ROUNDS.map(([k, l]) => h('option', { value: k, selected: f.round === k }, l))),
          h('select', { id: `note-kind-${c.id}`, 'aria-label': 'Type', onchange: (e) => (f.kind = e.target.value) }, h('option', { value: 'note' }, 'Note'), h('option', { value: 'feedback' }, 'Interview feedback')),
          h('span', { style: 'flex:1' }),
          h(
            'button',
            {
              class: 'p',
              onclick: () => {
                if (!f.text.trim()) return (err.textContent = 'Write something first.');
                const doc = { candidateId: c.id, campaignId: c.campaignId, round: f.round, kind: f.kind, text: f.text.trim().slice(0, 4000), authorId: me || null, authorLabel: me ? '' : 'You (test mode)', createdAt: new Date().toISOString() };
                act(() => S.add('notes', doc).then(rerender), 'Note added');
              },
            },
            'Add note',
          ),
        ),
        err,
      ),
      list.length
        ? h(
            'div',
            { class: 'note-list' },
            list.map((n) =>
              h(
                'div',
                { class: 'note-item' },
                h(
                  'div',
                  { class: 'meta' },
                  h('span', {}, [authorName(n), M.formatDay((n.createdAt || '').slice(0, 10)), (NOTE_ROUNDS.find((r) => r[0] === n.round) || ['', 'General'])[1], n.kind === 'feedback' ? 'feedback' : ''].filter(Boolean).join(' · ')),
                  n.authorId === me || !n.authorId ? h('button', { class: 'quiet', style: 'margin-left:auto;font-size:13px', onclick: () => act(() => S.remove('notes', n.id), 'Note deleted') }, 'Delete') : null,
                ),
                h('p', {}, n.text),
              ),
            ),
          )
        : h('p', { class: 'small muted' }, 'No notes yet. Natalie, advisors and team leads can all add them; they feed the interview brief.'),
    );
  }

  const briefs = {}; // candidate id -> { text, busy, error, focus, round }
  function briefPanel(c, s) {
    if (!sample) return null;
    const b = (briefs[c.id] = briefs[c.id] || { text: '', busy: false, error: '', focus: '', round: s.stage === 'deepdive' ? 'deepdive' : 'advisor' });
    const out = h('div', { class: 'brief-out' }, b.text);
    const status = h('p', { class: b.error ? 'err-line' : 'small muted' }, b.error || (b.busy ? 'Claude is writing the brief…' : ''));
    async function run() {
      b.busy = true;
      b.error = '';
      b.text = '';
      status.className = 'small muted';
      status.textContent = 'Claude is writing the brief…';
      out.textContent = '';
      if (b.ctrl) b.ctrl.abort();
      b.ctrl = new AbortController();
      try {
        const res = await sample(buildBriefPrompt(c, b.round, b.focus), {
          modelTier: 'default',
          signal: b.ctrl.signal,
          onText: ({ text }) => {
            b.text = text;
            out.textContent = text;
          },
        });
        b.text = res.text;
        out.textContent = res.text;
        status.textContent = res.truncated ? 'The brief was cut short.' : '';
      } catch (e) {
        if (e && e.name === 'AbortError') return;
        b.error = e && e.code === 'not_granted' ? 'Claude isn’t allowed on this page.' : e && e.code === 'rate_limited' ? 'Claude is busy. Try again in a minute.' : 'Claude couldn’t write the brief. Try again.';
        status.className = 'err-line';
        status.textContent = b.error;
      } finally {
        b.busy = false;
      }
    }
    return h(
      'section',
      { class: 'brief dsec', 'aria-label': 'Interview brief' },
      h('div', { class: 'bh' }, h('h3', {}, 'Interview brief'), h('span', {}, 'by Claude, from notes and timeline')),
      h(
        'div',
        { class: 'row' },
        h('select', { id: `brief-round-${c.id}`, 'aria-label': 'For which interview', onchange: (e) => (b.round = e.target.value) }, h('option', { value: 'advisor', selected: b.round === 'advisor' }, 'For the advisor interview'), h('option', { value: 'deepdive', selected: b.round === 'deepdive' }, 'For the deep dive')),
        h('input', { id: `brief-focus-${c.id}`, style: 'flex:1;min-width:160px', placeholder: 'What do you want to dig into? (optional)', value: b.focus, oninput: (e) => (b.focus = e.target.value) }),
        h('button', { class: b.text ? '' : 'p', onclick: run }, b.text ? 'Brief me again' : 'Brief me'),
      ),
      status,
      out,
    );
  }

  function buildBriefPrompt(c, round, focus) {
    return briefPromptFrom(briefRecord(c), round, focus);
  }
  function briefRecord(c) {
    const s = cstate(c);
    const timeline = (c.timeline || [])
      .filter((e) => !e.voided)
      .map((e) => {
        const step = M.STEP_BY_KEY[e.step];
        const d = e.data || {};
        return `- ${e.at.slice(0, 10)} ${step ? step.label : e.step}${e.outcome ? ` (${M.OUTCOME_LABELS[e.outcome]})` : ''}${e.note ? `: ${e.note}` : ''}${d.availability ? ` | availability: ${d.availability}` : ''}${d.interviewers ? ` | interviewers: ${d.interviewers.map(interviewerLabel).join(', ')}` : ''}`;
      })
      .join('\n');
    const notes = notesFor(c)
      .reverse()
      .map((n) => `- ${(n.createdAt || '').slice(0, 10)} ${authorName(n)} [${n.kind === 'feedback' ? 'interview feedback' : 'note'}, ${(NOTE_ROUNDS.find((r) => r[0] === n.round) || ['', 'general'])[1]}]: ${n.text}`)
      .join('\n');
    return [
      `Candidate: ${c.name}`,
      `Current stage: ${s.stage}; next step: ${s.prompt || 'none'}`,
      c.notes ? `Natalie's intake notes: ${c.notes}` : '',
      'Timeline:',
      timeline || '- nothing recorded yet',
      'Notes and feedback:',
      notes || '- none yet',
    ]
      .filter((x) => x !== '')
      .join('\n');
  }
  function briefPromptFrom(record, round, focus) {
    const roundText = round === 'deepdive' ? 'the final-round deep dive with two team leads (1 hour, in person)' : 'the advisor interview with two advisors from different teams (1 hour, in person)';
    return [
      'You help interviewers at Flux Partners, a Dutch consultancy that hires trainees into tender, project, contract and stakeholder management teams.',
      `Write a short brief for ${roundText}. The reader opens it minutes before the interview.`,
      'Use exactly these headings, each followed by 2 to 5 short bullet points:',
      'What matters most',
      'What colleagues noted',
      'What to dig into',
      'Questions to ask',
      'Base everything on the record below. Attribute colleague observations to their author. Do not invent facts; if the record is thin, say so in one bullet and suggest what to find out. Keep it under 250 words. Plain text, no Markdown symbols other than "- " bullets. Notes may be in Dutch; write the brief in English.',
      focus ? `The interviewer wants to focus on: ${focus}` : '',
      '',
      record,
    ]
      .filter((x) => x !== '')
      .join('\n');
  }

  // ------------------------------------------------------------------
  // Availability: import + saved snapshots, shown like the sheet
  // ------------------------------------------------------------------
  const NL = { all: 'Hele dag', am: 'Ochtend', pm: 'Middag', no: 'Niet' };

  function availabilityView() {
    if (ui.draft) return importView();
    const snaps = snapshots();
    const snap = snaps.find((s) => s.id === ui.snapId) || snaps[0];
    return [
      h(
        'div',
        { class: 'section gutter' },
        h(
          'div',
          { class: 'head' },
          h('div', {}, h('h1', {}, 'Availability'), h('p', {}, 'Import the monthly poll as it is. Claude reads the remarks, you confirm them, and each import is saved as a dated snapshot.')),
          snaps.length
            ? h(
                'label',
                { class: 'f' },
                'Snapshot',
                h(
                  'select',
                  {
                    id: 'snap-pick',
                    onchange: (e) => {
                      ui.snapId = e.target.value;
                      ui.sheetIdx = 0;
                      rerender();
                    },
                  },
                  snaps.map((s, i) => h('option', { value: s.id, selected: snap && s.id === snap.id }, `Poll of ${M.formatDay(s.pollDate, { year: true })}${i === 0 ? ' (latest)' : ''}`)),
                ),
              )
            : null,
        ),
        dropZone(),
      ),
      snap ? snapshotSheet(snap) : h('div', { class: 'empty gutter' }, h('p', {}, 'No poll imported yet for this campaign.')),
    ];
  }

  function dropZone() {
    const input = h('input', { type: 'file', id: 'poll-file', accept: '.xlsx,.xls,.csv', hidden: true, onchange: (e) => e.target.files[0] && readPoll(e.target.files[0]) });
    const zone = h(
      'div',
      {
        class: 'drop',
        ondragover: (e) => {
          e.preventDefault();
          zone.classList.add('over');
        },
        ondragleave: () => zone.classList.remove('over'),
        ondrop: (e) => {
          e.preventDefault();
          zone.classList.remove('over');
          const file = e.dataTransfer.files[0];
          if (file) readPoll(file);
        },
      },
      h('b', {}, 'Drop the poll xlsx here'),
      h('span', { class: 'small muted' }, 'Both tabs are read: advisors (competentiegesprekken) and team leads (Deepdive).'),
      h('button', { class: 'p', onclick: () => input.click() }, 'Choose file'),
      ui.error ? h('p', { class: 'err-line' }, ui.error) : null,
      input,
    );
    return zone;
  }

  async function readPoll(file) {
    ui.error = null;
    if (!window.XLSX) {
      ui.error = 'The spreadsheet reader didn’t load. Check your connection and reload the page.';
      rerender();
      return;
    }
    try {
      const buf = await file.arrayBuffer();
      const wb = window.XLSX.read(buf, { type: 'array' });
      const sheets = wb.SheetNames.map((name) => ({ name, rows: window.XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: null }) }));
      const pollDate = M.pollDateFromFileName(file.name) || TODAY;
      startDraft(sheets, file.name, pollDate);
    } catch (e) {
      ui.error = `Couldn’t read ${file.name}. Is it the poll xlsx?`;
      rerender();
    }
  }

  function startDraft(sheets, fileName, pollDate) {
    const draft = M.parsePoll(sheets, { pollDate });
    if (!draft.tabs.length) {
      ui.error = `${fileName} has no tab with a "Naam" column, so there’s nothing to import.`;
      rerender();
      return;
    }
    ui.draft = { sheets, fileName, draft, decisions: {}, rules: [], claude: null, editing: null };
    ui.sheetIdx = 0;
    rerender();
  }

  function importView() {
    const D = ui.draft;
    const review = M.reviewDraft(D.draft, S.state.people, D.decisions);
    const pendingRules = D.rules.filter((r) => r.status === 'pending').length;
    const remarks = D.draft.tabs.reduce((n, t) => n + t.entries.filter((e) => e.remark).length, 0);
    const canSave = review.blocking === 0 && pendingRules === 0;
    const why = review.blocking ? `Fix ${plural(review.blocking, 'name')} first.` : pendingRules ? `Confirm or dismiss ${plural(pendingRules, 'remark suggestion')} first.` : '';
    return [
      h(
        'div',
        { class: 'section gutter', style: 'padding-bottom:10px' },
        h(
          'div',
          { class: 'head' },
          h('div', {}, h('h1', {}, 'Check the import'), h('p', {}, `${D.fileName} · ${M.formatDay(D.draft.from)} to ${M.formatDay(D.draft.to, { year: true })} · ${plural(D.draft.tabs.reduce((n, t) => n + t.entries.length, 0), 'person', 'people')}`)),
          h(
            'div',
            { class: 'row' },
            h(
              'label',
              { class: 'f' },
              'Poll date',
              h('input', {
                type: 'date',
                id: 'poll-date',
                value: D.draft.pollDate,
                onchange: (e) => {
                  if (!e.target.value) return;
                  const keep = { decisions: D.decisions, rules: D.rules };
                  D.draft = M.parsePoll(D.sheets, { pollDate: e.target.value });
                  Object.assign(D, keep);
                  rerender();
                },
              }),
            ),
            h(
              'button',
              {
                onclick: () => {
                  ui.draft = null;
                  rerender();
                },
              },
              'Discard',
            ),
            remarks && sample ? h('button', { onclick: readRemarks, disabled: D.claude === 'busy' }, D.claude === 'busy' ? 'Claude is reading…' : D.claude === 'done' ? 'Read remarks again' : `Read ${plural(remarks, 'remark')} with Claude`) : null,
            h('button', { class: 'p', disabled: !canSave, onclick: () => saveSnapshot(review) }, 'Save snapshot'),
          ),
        ),
        why ? h('p', { class: 'warn-line' }, why) : null,
        typeof D.claude === 'string' && D.claude.startsWith('error:') ? h('p', { class: 'err-line' }, D.claude.slice(6)) : null,
        !sample && remarks ? h('p', { class: 'small muted' }, 'Claude isn’t available here, so add remark rules by hand with “+ Rule” next to each remark.') : null,
      ),
      fixList(review),
      pollSheet(
        D.draft.tabs.map((t) => ({
          sheet: t.sheet,
          role: t.role,
          dates: t.dates,
          rows: t.entries
            .filter((e) => !review.matches[e.key].skipped)
            .map((e) => ({ key: e.key, name: e.name, team: e.team, remark: e.remark, cells: e.cells, rules: D.rules.filter((r) => r.entryKey === e.key), person: review.matches[e.key].person })),
        })),
        true,
      ),
    ];
  }

  function fixList(review) {
    const D = ui.draft;
    const block = review.issues.filter((i) => i.severity === 'block');
    const warn = review.issues.filter((i) => i.severity === 'warn');
    const info = review.issues.filter((i) => i.severity === 'info');
    if (!review.issues.length) return h('div', { class: 'fixes gutter', style: 'background:var(--avail-soft)' }, h('div', { class: 'fix' }, 'Every name matches the roster.'));
    const entryOf = (key) => D.draft.tabs.flatMap((t) => t.entries.map((e) => ({ e, t }))).find((x) => x.e.key === key);
    const decide = (key, dec) => {
      D.decisions[key] = { ...(D.decisions[key] || {}), ...dec };
      rerender();
    };
    const line = (i) => {
      const actions = [];
      if (i.kind === 'unknown_name') {
        const { e, t } = entryOf(i.key);
        for (const p of i.suggestions) actions.push(h('button', { class: 'link', onclick: () => decide(i.key, { action: 'match', personId: p.id }) }, `It’s ${p.name} (${p.team}, ${roleLabel(p)})`));
        actions.push(h('button', { class: 'link', onclick: () => decide(i.key, { action: 'add', role: t.role || 'advisor' }) }, `Add ${e.name.trim()} as ${t.role === 'teamlead' ? 'team lead' : 'advisor'}, ${e.team || 'no team'}`));
        actions.push(h('button', { class: 'link', onclick: () => decide(i.key, { action: 'skip' }) }, 'Skip this row'));
      }
      if (i.kind === 'team_mismatch') {
        const { e } = entryOf(i.key);
        actions.push(h('button', { class: 'link', onclick: () => decide(i.key, { updateTeam: e.team, keepTeam: true }) }, `Update roster to ${e.team}`));
        actions.push(h('button', { class: 'link', onclick: () => decide(i.key, { keepTeam: true }) }, `Keep ${personById(i.personId).team}`));
      }
      return h('div', { class: 'fix' }, h('span', { class: `sev ${i.severity}` }, i.severity === 'block' ? 'Fix' : 'Check'), h('span', {}, i.message), actions);
    };
    const added = Object.entries(D.decisions).filter(([, d]) => d.action === 'add' || d.updateTeam || d.action === 'skip' || d.action === 'match');
    return h(
      'div',
      { class: 'fixes gutter' },
      block.map(line),
      warn.map(line),
      added.length
        ? h(
            'div',
            { class: 'fix' },
            h('span', { class: 'sev', style: 'color:var(--muted)' }, 'Done'),
            added.map(([key, d]) => {
              const x = entryOf(key);
              const name = x ? x.e.name.trim() : key;
              const what = d.action === 'add' ? `${name}: add to roster` : d.action === 'skip' ? `${name}: skipped` : d.action === 'match' ? `${name} = ${(personById(d.personId) || {}).name}` : `${name}: roster team → ${d.updateTeam}`;
              return h('span', {}, what, ' ', h('button', { class: 'link', onclick: () => { delete D.decisions[key]; rerender(); } }, 'undo'), ' ·');
            }),
          )
        : null,
      info.length ? h('details', {}, h('summary', {}, `FYI: ${plural(info.length, 'note')} (blanks, all “Niet”, values read loosely, people missing from the sheet)`), info.map((i) => h('div', { class: 'fix' }, h('span', {}, '·'), h('span', {}, i.message)))) : null,
    );
  }

  function roleLabel(p) {
    const r = p.roles || [];
    return r.includes('joker') ? 'joker' : r.includes('teamlead') ? 'team lead' : 'advisor';
  }

  async function readRemarks() {
    const D = ui.draft;
    const { prompt, count } = M.buildRemarkPrompt(D.draft);
    if (!count || !sample) return;
    D.claude = 'busy';
    rerender();
    try {
      const raw = await sample.json(prompt, { modelTier: 'default' });
      const fresh = M.cleanRemarkSuggestions(raw, D.draft);
      // Keep anything Natalie already decided; replace pending Claude suggestions.
      D.rules = [...D.rules.filter((r) => r.status !== 'pending' || r.source !== 'claude'), ...fresh];
      D.claude = 'done';
      toast(fresh.length ? `Claude suggested ${plural(fresh.length, 'rule')}. Confirm or edit each one.` : 'Claude found nothing in the remarks that changes availability.');
    } catch (e) {
      D.claude = `error:${e && e.code === 'not_granted' ? 'Claude isn’t allowed on this page, so add rules by hand.' : e && e.code === 'rate_limited' ? 'Claude is busy. Try again in a minute.' : 'Claude couldn’t read the remarks this time. Try again, or add rules by hand.'}`;
      rerender();
    }
  }

  async function saveSnapshot(review) {
    const D = ui.draft;
    await act(async () => {
      // Roster changes first, so new rows get their person ids.
      for (const tab of D.draft.tabs) {
        for (const e of tab.entries) {
          const dec = D.decisions[e.key];
          if (!dec) continue;
          if (dec.action === 'add') {
            const id = await S.add('people', { name: e.name.trim(), team: e.team, roles: [dec.role || tab.role || 'advisor'], aliases: [], active: true, email: '', createdAt: new Date().toISOString() });
            review.matches[e.key] = { person: { id }, skipped: false };
          }
          if (dec.updateTeam && review.matches[e.key].person) await S.update('people', review.matches[e.key].person.id, { team: dec.updateTeam });
          // Remember how this person writes their name on the sheet.
          const m = review.matches[e.key];
          if (dec.action === 'match' && m.person) {
            const p = personById(m.person.id);
            const alias = e.name.trim();
            if (p && M.normName(alias) !== M.normName(p.name) && !(p.aliases || []).map(M.normName).includes(M.normName(alias))) await S.update('people', p.id, { aliases: [...(p.aliases || []), alias] });
          }
        }
      }
      const snap = M.buildSnapshot(D.draft, review, D.rules, { campaignId: campaign().id, fileName: D.fileName });
      const id = await S.add('snapshots', snap);
      ui.draft = null;
      ui.snapId = id;
      ui.sheetIdx = 0;
      rerender();
    }, 'Snapshot saved');
  }

  function snapshotSheet(snap) {
    const tabs = snap.tabs.map((t) => ({ ...t, rows: t.rows.map((r, i) => ({ ...r, key: `${t.sheet}:${i}`, person: r.personId ? personById(r.personId) : null })) }));
    const st = snap.stats || M.snapshotStats(snap);
    return [
      h('div', { class: 'gutter', style: 'padding-bottom:10px' }, h('p', { class: 'small muted' }, `${snap.fileName || 'Poll'} · imported ${M.formatDay(snap.importedAt.slice(0, 10))} · ${st.responded} of ${st.people} answered · ${st.halfDays} half-days offered`, ' ', deleteSnapButton(snap))),
      pollSheet(tabs, false),
    ];
  }

  function deleteSnapButton(snap) {
    const holder = h('span');
    const draw = (confirm) =>
      holder.replaceChildren(
        confirm
          ? h('span', {}, 'Delete this snapshot? ', h('button', { class: 'link', onclick: () => draw(false) }, 'Keep'), ' ', h('button', { class: 'link danger', onclick: () => act(() => S.remove('snapshots', snap.id), 'Snapshot deleted') }, 'Delete'))
          : h('button', { class: 'link', onclick: () => draw(true) }, 'Delete snapshot'),
      );
    draw(false);
    return holder;
  }

  /** The poll, shown the way the xlsx looks: Naam, Team, one column per day, Opmerking. */
  function pollSheet(tabs, editable) {
    if (!tabs.length) return null;
    const idx = Math.min(ui.sheetIdx, tabs.length - 1);
    const full = tabs[idx];
    // Past weeks rarely matter when planning; hide them unless asked.
    const fromDay = M.weekStart(TODAY);
    const hiddenDays = full.dates.filter((d) => d < fromDay).length;
    const showAll = ui.showPast || hiddenDays === full.dates.length;
    const t = { ...full, dates: showAll ? full.dates : full.dates.filter((d) => d >= fromDay) };
    const head = h(
      'tr',
      {},
      h('th', { class: 'rn' }),
      h('th', {}, 'Naam'),
      h('th', {}, 'Team'),
      t.dates.map((d) => h('th', { class: M.weekdayOf(d) === 5 ? 'fri' : '', style: 'text-align:center' }, `${M.WEEKDAYS_NL[M.weekdayOf(d)]} ${short(d)}`)),
      h('th', {}, 'Opmerking'),
    );
    const body = t.rows.map((r, i) =>
      h(
        'tr',
        {},
        h('td', { class: 'rn' }, i + 1),
        h('td', { class: 'name' }, r.name, r.person && M.normName(r.person.name) !== M.normName(r.name) ? h('span', { class: 'faint small' }, ` = ${r.person.name}`) : null),
        h('td', { class: 'team' }, r.team),
        t.dates.map((d) => pollCell(r, d, editable)),
        h('td', { class: 'rem' }, r.remark || '', remarkRules(r, t, editable)),
      ),
    );
    const sum = h(
      'tr',
      { class: 'sum' },
      h('td', { class: 'rn' }),
      h('td', { style: 'text-align:left' }, 'Free (pair?)'),
      h('td'),
      t.dates.map((d) => {
        const c = M.dayCoverage(t.rows.map((r) => ({ ...r, rules: (r.rules || []).filter((x) => x.status === 'confirmed') })), d);
        const ok = c.pairAm || c.pairPm;
        return h('td', { class: ok ? 'ok' : '', title: `Morning ${c.am}${c.pairAm ? ' (pair possible)' : ''}, afternoon ${c.pm}${c.pairPm ? ' (pair possible)' : ''}` }, `${c.people}${ok ? ' ✓' : ''}`);
      }),
      h('td', { style: 'text-align:left;font-family:var(--font-ui)' }, '✓ = two people from different teams are free in the same half-day'),
    );
    const pastToggle = hiddenDays
      ? h(
          'div',
          { class: 'gutter small muted', style: 'padding-block:6px' },
          showAll ? `Showing all ${full.dates.length} poll days. ` : `Showing this week onward; ${plural(hiddenDays, 'earlier day')} hidden. `,
          h('button', { class: 'link', onclick: () => ((ui.showPast = !ui.showPast), rerender()) }, showAll ? 'Hide earlier days' : 'Show earlier days'),
        )
      : null;
    return [
      pastToggle,
      h('div', { class: 'sheet-wrap' }, h('table', { class: 'x' }, h('thead', {}, head), h('tbody', {}, body, sum))),
      h(
        'div',
        { class: 'sheet-tabs' },
        tabs.map((x, i) =>
          h(
            'button',
            {
              'aria-pressed': i === idx,
              onclick: () => {
                ui.sheetIdx = i;
                rerender();
              },
            },
            x.sheet,
          ),
        ),
      ),
      h(
        'div',
        { class: 'section gutter' },
        h(
          'div',
          { class: 'legend' },
          h('span', {}, h('span', { class: 'sw', style: 'background:var(--avail)' }), 'Hele dag'),
          h('span', {}, h('span', { class: 'sw', style: 'background:var(--avail-soft)' }), 'Ochtend or Middag'),
          h('span', {}, h('span', { class: 'sw', style: 'background:var(--no)' }), 'Niet'),
          h('span', {}, h('span', { class: 'sw', style: 'background:repeating-linear-gradient(135deg, transparent 0 4px, var(--s2) 4px 8px)' }), 'No answer (unknown, not unavailable)'),
          h('span', {}, h('span', { class: 'sw', style: 'box-shadow:inset 0 0 0 2px var(--accent)' }), 'Narrowed by a remark'),
          h('span', {}, h('span', { class: 'sw', style: 'box-shadow:inset 0 0 0 2px var(--warn)' }), 'Check first'),
          h('span', {}, h('span', { class: 'sw', style: 'box-shadow:inset 0 0 0 2px var(--bad)' }), 'Not available per remark'),
        ),
      ),
    ];
  }

  function pollCell(r, d, editable) {
    const v = r.cells[d];
    const rules = (r.rules || []).filter((x) => x.dates.includes(d) && x.status !== 'dismissed');
    const confirmed = rules.filter((x) => x.status === 'confirmed');
    const eff = M.effectiveCell(v, confirmed, d);
    let cls = `v ${eff.value || 'null'}`;
    let sub = null;
    if (eff.window) {
      cls += eff.window.kind === 'unavailable' ? ' unav' : ' win';
      sub = `${eff.window.from || ''}-${eff.window.to || ''}`;
    } else if (eff.value === 'no' && v !== 'no') cls += ' unav';
    if (eff.tentative) cls += ' ten';
    if (editable && rules.some((x) => x.status === 'pending')) cls += ' pend';
    const title = rules.map((x) => `${x.status === 'pending' ? 'Suggested: ' : ''}${x.summary}`).join('\n') || null;
    return h('td', { class: cls, title }, eff.value ? NL[eff.value] : '', sub ? h('small', {}, sub) : null);
  }

  function remarkRules(r, t, editable) {
    const rules = r.rules || [];
    const D = ui.draft;
    const out = rules.map((rule) => {
      if (editable && D.editing === rule.id) return ruleEditor(rule, t.dates);
      const tone = rule.status === 'confirmed' ? 'ok' : rule.status === 'dismissed' ? 'off' : '';
      const label = rule.status === 'pending' ? `${rule.source === 'claude' ? 'Claude' : 'You'}: ${rule.summary}` : rule.status === 'confirmed' ? `✓ ${rule.summary}` : rule.summary;
      return h(
        'div',
        { class: `ai ${tone}`, title: M.describeRule(rule) },
        h('span', {}, label),
        editable && rule.status === 'pending' ? h('button', { class: 'p', onclick: () => setRule(rule, { status: 'confirmed' }) }, 'Confirm') : null,
        editable && rule.status !== 'dismissed' ? h('button', { class: 'link', onclick: () => ((D.editing = rule.id), rerender()) }, 'Edit') : null,
        editable && rule.status === 'pending' ? h('button', { class: 'link', onclick: () => setRule(rule, { status: 'dismissed' }) }, 'Dismiss') : null,
        editable && rule.status !== 'pending' ? h('button', { class: 'link', onclick: () => setRule(rule, { status: 'pending' }) }, 'Undo') : null,
      );
    });
    if (editable && r.remark) {
      out.push(
        h(
          'div',
          {},
          h(
            'button',
            {
              class: 'link',
              style: 'font-size:11.5px',
              onclick: () => {
                const rule = { id: S.uid('r'), entryKey: r.key, kind: 'window', dates: [], from: null, to: null, summary: '', quote: '', source: 'manual', status: 'pending' };
                D.rules.push(rule);
                D.editing = rule.id;
                rerender();
              },
            },
            '+ Rule',
          ),
        ),
      );
    }
    return out;
  }

  function setRule(rule, patch) {
    Object.assign(rule, patch);
    rerender();
  }

  function ruleEditor(rule, dates) {
    const f = { ...rule, dates: [...rule.dates] };
    const box = h('div', { class: 'rule-edit' });
    function draw() {
      fill(box, 
        h(
          'div',
          { class: 'row' },
          h('select', { id: `re-kind-${rule.id}`, 'aria-label': 'Kind', onchange: (e) => ((f.kind = e.target.value), draw()) }, Object.entries(M.RULE_KINDS).map(([k, v]) => h('option', { value: k, selected: f.kind === k }, v))),
          f.kind === 'window' || f.kind === 'unavailable'
            ? [h('input', { type: 'time', id: `re-from-${rule.id}`, 'aria-label': 'From', value: f.from || '', oninput: (e) => (f.from = e.target.value || null) }), h('span', {}, 'to'), h('input', { type: 'time', id: `re-to-${rule.id}`, 'aria-label': 'To', value: f.to || '', oninput: (e) => (f.to = e.target.value || null) })]
            : null,
        ),
        h(
          'div',
          { class: 'toggles', role: 'group', 'aria-label': 'Days' },
          dates.map((d) =>
            h(
              'button',
              {
                type: 'button',
                'aria-pressed': f.dates.includes(d),
                onclick: () => {
                  f.dates = f.dates.includes(d) ? f.dates.filter((x) => x !== d) : [...f.dates, d].sort();
                  draw();
                },
              },
              `${M.WEEKDAYS_NL[M.weekdayOf(d)]} ${short(d)}`,
            ),
          ),
        ),
        h('input', { id: `re-sum-${rule.id}`, placeholder: 'Summary Natalie reads, e.g. Fri 4 Dec only 14:00-15:30', value: f.summary, oninput: (e) => (f.summary = e.target.value) }),
        h(
          'div',
          { class: 'row end' },
          h(
            'button',
            {
              type: 'button',
              onclick: () => {
                if (rule.source === 'manual' && !rule.summary) ui.draft.rules = ui.draft.rules.filter((x) => x !== rule);
                ui.draft.editing = null;
                rerender();
              },
            },
            'Cancel',
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'p',
              onclick: () => {
                if (f.kind !== 'note' && !f.dates.length) return;
                Object.assign(rule, { kind: f.kind, dates: f.dates, from: f.kind === 'window' || f.kind === 'unavailable' ? f.from : null, to: f.kind === 'window' || f.kind === 'unavailable' ? f.to : null, summary: f.summary.trim() || M.describeRule(f), status: 'confirmed' });
                ui.draft.editing = null;
                rerender();
              },
            },
            'Save and confirm',
          ),
        ),
      );
    }
    draw();
    return box;
  }

  // ------------------------------------------------------------------
  // Roster
  // ------------------------------------------------------------------
  function rosterView() {
    const ps = people();
    const latest = snapshots()[0];
    const manualOf = (p) => S.state.availability.find((a) => a.personId === p.id);
    const pollInfoText = (p) => {
      const m = manualOf(p);
      const base = pollInfoBase(p);
      return m ? `${base ? `${base}; ` : ''}set by hand ${M.formatDay(m.updatedAt.slice(0, 10))}` : base;
    };
    const pollInfoBase = (p) => {
      if (!latest) return '';
      for (const t of latest.tabs) {
        const r = t.rows.find((x) => x.personId === p.id);
        if (!r) continue;
        const vals = t.dates.map((d) => r.cells[d]);
        if (vals.every((v) => v === null)) return 'no response';
        const hd = vals.reduce((n, v) => n + (v === 'all' ? 2 : v === 'am' || v === 'pm' ? 1 : 0), 0);
        return `${hd} half-days`;
      }
      return 'not on the poll';
    };
    const load = {};
    for (const c of S.state.candidates) {
      for (const e of c.timeline || []) {
        if (e.voided || !e.data || !e.data.interviewers) continue;
        for (const id of e.data.interviewers) load[id] = (load[id] || 0) + 1;
      }
    }
    const groups = [
      ['advisor', 'Advisors'],
      ['teamlead', 'Team leads'],
      ['joker', 'Joker (HR)'],
    ];
    const counts = (role) => M.TEAM_CODES.map((t) => [t, ps.filter((p) => p.active !== false && (p.roles || []).includes(role) && p.team === t).length]).filter(([, n]) => n);
    const rows = [];
    for (const [role, label] of groups) {
      const list = ps.filter((p) => (role === 'advisor' ? (p.roles || []).includes('advisor') : role === 'teamlead' ? (p.roles || []).includes('teamlead') && !(p.roles || []).includes('advisor') : (p.roles || []).includes('joker') && !(p.roles || []).includes('teamlead')));
      if (!list.length) continue;
      rows.push(h('tr', { class: 'group' }, h('td', { colspan: 8 }, `${label} · ${list.filter((p) => p.active !== false).length} active · ${counts(role).map(([t, n]) => `${t} ${n}`).join(', ')}`)));
      for (const p of list) {
        if (ui.rosterEdit === p.id) {
          rows.push(h('tr', {}, h('td', { colspan: 8 }, personForm(p))));
          continue;
        }
        rows.push(
          h(
            'tr',
            { class: p.active === false ? 'inactive' : '' },
            h('td', { class: 'name' }, h('button', { onclick: () => ((ui.rosterEdit = p.id), rerender()) }, p.name)),
            h('td', { class: 'team' }, p.team),
            h('td', {}, (p.roles || []).map((r) => (M.ROLES.find((x) => x.key === r) || { label: r }).label).join(', ')),
            h('td', { class: 'small muted' }, (p.aliases || []).join(', ')),
            h('td', { class: 'small' }, accountCell(p)),
            h('td', { class: 'small' }, pollInfoText(p), ' ', h('button', { class: 'link', onclick: () => ((ui.availEdit = ui.availEdit === p.id ? null : p.id), rerender()) }, ui.availEdit === p.id ? 'Close' : 'Set')),
            h('td', { class: 'mono', style: 'text-align:center' }, load[p.id] || ''),
            h('td', { class: 'small' }, p.active === false ? 'Inactive' : p.access === 'manual' ? 'Active · no Claude' : 'Active'),
          ),
        );
        if (ui.availEdit === p.id) rows.push(h('tr', {}, h('td', { colspan: 8 }, availabilityEditor(p))));
      }
    }
    return [
      h(
        'div',
        { class: 'section gutter' },
        h('div', { class: 'head' }, h('div', {}, h('h1', {}, 'Roster'), h('p', {}, 'Everyone who interviews, across all campaigns. Interview counts are shared, so nobody gets overloaded by two drives at once.')), h('button', { class: 'p', onclick: () => ((ui.rosterEdit = 'new'), rerender()) }, '+ Person')),
        ui.rosterEdit === 'new' ? personForm(null) : null,
      ),
      ps.length
        ? h(
            'div',
            { class: 'sheet-wrap' },
            h(
              'table',
              { class: 'x' },
              h('thead', {}, h('tr', {}, ['Name', 'Team', 'Role', 'Also written as', 'Claude account', latest ? `Poll of ${M.formatDay(latest.pollDate)}` : 'Latest poll', 'Interviews', 'Status'].map((x) => h('th', {}, x)))),
              h('tbody', {}, rows),
            ),
          )
        : h('div', { class: 'empty gutter' }, h('p', {}, 'No one on the roster yet. Import a poll and add people from it, or add them here.')),
    ];
  }


  // Natalie sets someone's half-day availability by hand (for people without Claude, or a phoned-in change).
  function availabilityEditor(p) {
    const start = M.weekStart(TODAY);
    const days = [];
    for (let i = 0; i < 28; i++) {
      const d = M.addDays(start, i);
      const wd = M.weekdayOf(d);
      if (wd >= 1 && wd <= 5) days.push(d);
    }
    const existing = S.state.availability.find((a) => a.personId === p.id);
    const k = `avail:${p.id}`;
    ui.forms = ui.forms || {};
    const role = (p.roles || []).includes('advisor') ? 'advisor' : 'teamlead';
    const f =
      ui.forms[k] ||
      (ui.forms[k] = {
        days: Object.fromEntries(
          days.map((d) => {
            const a = M.availabilityOn(availSources(), p.id, role, d);
            return [d, a ? a.value : null];
          }),
        ),
        note: (existing && existing.note) || '',
      });
    const order = [null, 'all', 'am', 'pm', 'no'];
    const box = h('div', { style: 'display:flex;flex-direction:column;gap:8px;padding:6px 0' });
    function draw() {
      const weeks = [];
      for (let w = 0; w < 4; w++) weeks.push(days.filter((d) => M.weekStart(d) === M.addDays(start, w * 7)));
      fill(
        box,
        h('div', { class: 'small muted' }, `Availability for ${p.name}. Click a day to cycle: blank, Hele dag, Ochtend, Middag, Niet. This counts as their newest answer and wins over older polls.`),
        h(
          'div',
          { class: 'sheet-wrap', style: 'border:1px solid var(--grid);border-radius:4px' },
          h(
            'table',
            { class: 'x' },
            h('tbody', {}, weeks.map((wk) => h('tr', {}, h('th', { class: 'mono' }, `wk ${M.formatDay(wk[0])}`), wk.map((d) => {
              const v = f.days[d];
              return h('td', { class: `v ${v || 'null'}`, style: 'padding:0' }, h('button', { style: 'all:unset;display:block;width:100%;padding:5px 6px;cursor:pointer;text-align:center;box-sizing:border-box', 'aria-label': `${M.formatDay(d)}: ${v ? NL[v] : 'no answer'}`, onclick: () => { f.days[d] = order[(order.indexOf(v) + 1) % order.length]; draw(); } }, h('small', { style: 'font-size:10px;opacity:.75' }, `${M.WEEKDAYS_NL[M.weekdayOf(d)]} ${short(d)}`), h('span', { style: 'display:block' }, v ? NL[v] : '·')));
            })))),
          ),
        ),
        h('div', { class: 'row' }, ['all', 'no', null].map((v) => h('button', { onclick: () => { days.forEach((d) => (f.days[d] = v)); draw(); } }, v ? `All ${NL[v]}` : 'Clear all')), h('button', { onclick: () => { days.forEach((d) => (f.days[d] = M.weekdayOf(d) === 5 ? 'all' : f.days[d])); draw(); } }, 'Fridays Hele dag')),
        h('input', { id: `avail-note-${p.id}`, placeholder: 'Note, e.g. “phoned in: new project from January”', value: f.note, oninput: (e) => (f.note = e.target.value) }),
        h(
          'div',
          { class: 'row end' },
          h('button', { onclick: () => { delete ui.forms[k]; ui.availEdit = null; rerender(); } }, 'Cancel'),
          h(
            'button',
            {
              class: 'p',
              onclick: () =>
                act(async () => {
                  const kept = existing ? { ...existing.days } : {};
                  for (const d of days) {
                    if (f.days[d] === null) delete kept[d];
                    else kept[d] = f.days[d];
                  }
                  await S.set('availability', p.id, { personId: p.id, days: kept, note: f.note.trim(), source: 'manual', updatedAt: `${TODAY}T${new Date().toISOString().slice(11)}`, updatedBy: me || null });
                  delete ui.forms[k];
                  ui.availEdit = null;
                  rerender();
                }, `Availability saved for ${p.name}`),
            },
            'Save availability',
          ),
        ),
      );
    }
    draw();
    return box;
  }

  function personForm(p) {
    const f = { name: p ? p.name : '', team: p ? p.team : 'TM', roles: p ? [...(p.roles || [])] : ['advisor'], aliases: p ? (p.aliases || []).join(', ') : '', email: p ? p.email || '' : '', active: p ? p.active !== false : true, access: p ? p.access || 'app' : 'app' };
    const err = h('p', { class: 'err-line' });
    let confirmDel = false;
    const box = h('div', { class: 'step-form', style: 'margin:0' });
    function draw() {
      fill(box, 
        h(
          'div',
          { class: 'fg' },
          h('label', { class: 'f' }, 'Name', h('input', { id: 'pf-name', value: f.name, oninput: (e) => (f.name = e.target.value) })),
          h('label', { class: 'f' }, 'Team', h('select', { id: 'pf-team', onchange: (e) => (f.team = e.target.value) }, M.TEAMS.map((t) => h('option', { value: t.code, selected: f.team === t.code }, `${t.code} · ${t.name}`)))),
          h('label', { class: 'f' }, 'Email', h('input', { id: 'pf-email', type: 'email', value: f.email, oninput: (e) => (f.email = e.target.value) })),
          h('label', { class: 'f' }, 'Also written as (comma-separated)', h('input', { id: 'pf-alias', value: f.aliases, oninput: (e) => (f.aliases = e.target.value) })),
          h(
            'div',
            { class: 'row wide' },
            M.ROLES.map((r) =>
              h(
                'label',
                { class: 'check' },
                h('input', {
                  type: 'checkbox',
                  id: `pf-role-${r.key}`,
                  checked: f.roles.includes(r.key),
                  onchange: (e) => (f.roles = e.target.checked ? [...f.roles, r.key] : f.roles.filter((x) => x !== r.key)),
                }),
                r.label,
              ),
            ),
            h('label', { class: 'check' }, h('input', { type: 'checkbox', id: 'pf-active', checked: f.active, onchange: (e) => (f.active = e.target.checked) }), 'Active (can be asked to interview)'),
          ),
          h(
            'div',
            { class: 'wide', style: 'display:flex;flex-direction:column;gap:4px' },
            h('span', { class: 'small muted', style: 'font-weight:600' }, 'How they take part'),
            h('label', { class: 'check' }, h('input', { type: 'radio', name: 'pf-access', id: 'pf-access-app', checked: f.access === 'app', onchange: () => (f.access = 'app') }), 'Invite to the app: they answer requests, fill in their own availability and see briefs. Link their Claude account next, then share the app with them from the Share menu.'),
            h('label', { class: 'check' }, h('input', { type: 'radio', name: 'pf-access', id: 'pf-access-manual', checked: f.access === 'manual', onchange: () => (f.access = 'manual') }), 'Without Claude: they get Outlook invites only, and Natalie keeps their availability up to date here.'),
          ),
        ),
        err,
        h(
          'div',
          { class: 'row end' },
          p && !confirmDel ? h('button', { class: 'danger', onclick: () => ((confirmDel = true), draw()) }, 'Remove') : null,
          p && confirmDel ? [h('span', { class: 'err-line' }, 'Remove from the roster? Marking inactive keeps their history.'), h('button', { class: 'danger', onclick: () => act(async () => { await S.remove('people', p.id); ui.rosterEdit = null; rerender(); }, 'Removed') }, 'Remove for good')] : null,
          h('button', { onclick: () => ((ui.rosterEdit = null), rerender()) }, 'Cancel'),
          h(
            'button',
            {
              class: 'p',
              onclick: () => {
                if (!f.name.trim()) return (err.textContent = 'Add a name.');
                if (!f.roles.length) return (err.textContent = 'Pick at least one role.');
                const doc = { name: f.name.trim(), team: f.team, roles: f.roles, aliases: f.aliases.split(',').map((x) => x.trim()).filter(Boolean), email: f.email.trim(), active: f.active, access: f.access };
                act(async () => {
                  let id = p && p.id;
                  if (p) await S.update('people', p.id, doc);
                  else id = await S.add('people', { ...doc, createdAt: new Date().toISOString() });
                  ui.rosterEdit = null;
                  // Next step for app users: link their account. For others: set availability.
                  if (f.access === 'app' && !(p && p.accountId)) ui.linking = id;
                  if (f.access === 'manual' && !p) ui.availEdit = id;
                  rerender();
                }, p ? 'Saved' : `${doc.name} added`);
              },
            },
            p ? 'Save' : 'Add person',
          ),
        ),
      );
    }
    draw();
    return box;
  }

  // ------------------------------------------------------------------
  // Campaign
  // ------------------------------------------------------------------
  // ------------------------------------------------------------------
  // Rounds and scheduling settings: everyone reads, Natalie edits
  // ------------------------------------------------------------------
  // [key, label, kind, unit, live] — live: used by the app today; else from phase 2 (holds and matching)
  const SETTING_FIELDS = [
    ['invitesPerSlot', 'Invites per slot', 'num', '', false],
    ['topUpAfterDecline', 'Top up after a decline', 'bool', '', true],
    ['replyWindowWorkingDays', 'Reply window for interviewers', 'num', 'working days', true],
    ['holdBeforeCandidate', 'Hold slots before a candidate exists', 'bool', '', false],
    ['holdAheadWorkingDays', 'How far ahead to hold', 'num', 'working days', false],
    ['holdsPerWeek.advisor', 'Advisor holds per week', 'num', '', false],
    ['holdsPerWeek.deepdive', 'Deep dive holds per week', 'num', '', false],
    ['releaseUnfilledWorkingDays', 'Release an unfilled hold', 'num', 'working days before', false],
    ['cancellationWarningWorkingDays', 'Cancellation notice warning', 'num', 'working days', false],
    ['holdsPerMemberPerMonth', 'Holds per member per month', 'num', '', false],
    ['preferFridays', 'Prefer Fridays', 'bool', '', false],
  ];
  const getPath = (o, k) => k.split('.').reduce((x, part) => (x == null ? x : x[part]), o);
  function setPath(o, k, v) {
    const parts = k.split('.');
    let x = o;
    for (const part of parts.slice(0, -1)) x = x[part] = x[part] || {};
    x[parts[parts.length - 1]] = v;
  }
  const fmtSetting = (v, kind, unit) => (kind === 'bool' ? (v ? 'On' : 'Off') : `${v ?? '–'}${unit ? ` ${unit}` : ''}`);

  // draft: the wizard passes its own {rounds, settings} to edit before the campaign exists.
  function roundProblem(rounds) {
    const bad = rounds.find((r) => !(r.interviewers >= 1) || !(r.durationMin >= 15) || (r.maxDaysAfterPrevious != null && !(r.maxDaysAfterPrevious >= 1)));
    return bad ? `${bad.name}: at least 1 interviewer, 15 minutes and 1 day.` : '';
  }
  function rulesSection(c, editable, draft) {
    const editing = !!draft || (editable && ui.editRules === c.id);
    const settings = c.settings || M.DEFAULT_SETTINGS;
    const rounds = c.rounds || M.DEFAULT_ROUNDS;
    const f = draft || (editing ? (ui.rulesDraft = ui.rulesDraft || { settings: JSON.parse(JSON.stringify(settings)), rounds: JSON.parse(JSON.stringify(rounds)) }) : null);
    const err = h('p', { class: 'err-line' });
    const numIn = (id, val, onv) => h('input', { type: 'number', min: 0, max: 60, id, value: val, style: 'width:70px', oninput: (e) => onv(Number(e.target.value)) });
    const boolIn = (id, val, onv) => h('input', { type: 'checkbox', id, checked: !!val, onchange: (e) => onv(e.target.checked) });
    const roundCols = ['Round', 'Expected interviews', 'Interviewers', 'Different teams', 'Length (min)', 'Max days after previous', 'Fallbacks'];
    return h(
      'div',
      { class: 'section gutter', 'aria-label': 'Rounds and scheduling settings' },
      h(
        'div',
        { class: 'head' },
        h('div', {}, h('h2', {}, 'Rounds and scheduling rules'), h('p', {}, editable ? 'Everyone in the campaign can read these. Only you can change them.' : 'How interviews are planned in this campaign. Natalie sets these.')),
        draft ? null : editable && !editing ? h('button', { onclick: () => ((ui.editRules = c.id), (ui.rulesDraft = null), rerender()) }, 'Edit') : null,
      ),
      h(
        'div',
        { class: 'sheet-wrap', style: 'border:1px solid var(--grid);border-radius:6px' },
        h(
          'table',
          { class: 'x' },
          h('thead', {}, h('tr', {}, roundCols.map((x) => h('th', {}, x)))),
          h(
            'tbody',
            {},
            (editing ? f.rounds : rounds).map((r, i) =>
              h(
                'tr',
                {},
                h('td', { class: 'name' }, r.name),
                h('td', {}, r.role === 'hr' ? '–' : editing ? numIn(`r-exp-${r.key}`, M.expectedInterviews({ ...c, rounds: f.rounds }, r), (v) => (r.expected = v)) : `about ${M.expectedInterviews(c, r)}`),
                h('td', {}, r.role === 'hr' ? 'Natalie (HR)' : editing ? numIn(`r-int-${r.key}`, r.interviewers, (v) => (r.interviewers = v)) : `${r.interviewers} ${r.role === 'teamlead' ? 'team leads' : 'advisors'}`),
                h('td', {}, r.role === 'hr' ? '–' : editing ? boolIn(`r-diff-${r.key}`, r.differentTeams, (v) => (r.differentTeams = v)) : r.differentTeams ? 'Yes' : 'No'),
                h('td', {}, editing ? numIn(`r-len-${r.key}`, r.durationMin, (v) => (r.durationMin = v)) : `${r.durationMin} min`),
                h('td', {}, r.maxDaysAfterPrevious == null ? '–' : editing ? numIn(`r-max-${r.key}`, r.maxDaysAfterPrevious, (v) => (r.maxDaysAfterPrevious = v)) : `${r.maxDaysAfterPrevious} days`),
                h(
                  'td',
                  {},
                  r.role === 'hr'
                    ? '–'
                    : editing
                    ? h(
                        'div',
                        { class: 'row' },
                        [['joker', 'HR joker'], ['natalie', 'Natalie']].map(([k, l]) =>
                          h('label', { class: 'check' }, boolIn(`r-fb-${r.key}-${k}`, (r.fallbacks || []).includes(k), (v) => (r.fallbacks = v ? [...new Set([...(r.fallbacks || []), k])] : (r.fallbacks || []).filter((x) => x !== k))), l),
                        ),
                      )
                    : (r.fallbacks || []).map((x) => (x === 'joker' ? 'HR joker' : 'Natalie')).join(', ') || '–',
                ),
              ),
            ),
          ),
        ),
      ),
      h(
        'details',
        { class: 'round-sum', open: editing },
        h('summary', {}, h('b', {}, 'Scheduling settings'), h('span', { class: 'muted' }, ` · ${SETTING_FIELDS.length} settings, ${SETTING_FIELDS.filter((x) => x[4]).length} in use now`)),
        h(
        'div',
        { class: 'sheet-wrap', style: 'border:1px solid var(--grid);border-radius:6px' },
        h(
          'table',
          { class: 'x' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Setting'), h('th', {}, 'Value'), h('th', { class: 'wide-only' }, ''))),
          h(
            'tbody',
            {},
            SETTING_FIELDS.map(([k, label, kind, unit, live]) => {
              const v = getPath(editing ? f.settings : settings, k);
              return h(
                'tr',
                {},
                h('td', {}, label),
                h('td', { class: 'mono' }, editing ? h('span', { class: 'row' }, kind === 'bool' ? boolIn(`s-${k}`, v, (x) => setPath(f.settings, k, x)) : numIn(`s-${k}`, v, (x) => setPath(f.settings, k, x)), unit ? h('span', { class: 'small muted' }, unit) : null) : fmtSetting(v, kind, unit)),
                h('td', { class: 'small faint wide-only' }, live ? 'In use now' : 'Used when holds and matching arrive'),
              );
            }),
          ),
        ),
      ),
      ),
      roomsBlock(c, editing, f),
      editing && !draft
        ? h(
            'div',
            { class: 'row end' },
            err,
            h('button', { onclick: () => ((ui.editRules = null), (ui.rulesDraft = null), rerender()) }, 'Cancel'),
            h(
              'button',
              {
                class: 'p',
                onclick: () => {
                  const bad = roundProblem(f.rounds);
                  if (bad) return (err.textContent = bad);
                  if (!(f.settings.replyWindowWorkingDays >= 1)) return (err.textContent = 'The reply window needs at least 1 working day.');
                  if ((f.settings.rooms || []).some((r) => !r.name.trim())) return (err.textContent = 'Every room needs a name.');
                  if (new Set((f.settings.rooms || []).map((r) => r.name.trim())).size !== (f.settings.rooms || []).length) return (err.textContent = 'Two rooms have the same name.');
                  act(async () => {
                    await S.update('campaigns', c.id, { settings: f.settings, rounds: f.rounds });
                    ui.editRules = null;
                    ui.rulesDraft = null;
                    rerender();
                  }, 'Rules saved');
                },
              },
              'Save rules',
            ),
          )
        : null,
    );
  }

  // Rooms: a name for the app and the room's Outlook address, so the invite books it.
  function roomsBlock(c, editing, f) {
    const list = editing ? (f.settings.rooms = f.settings.rooms && f.settings.rooms.length ? f.settings.rooms : M.DEFAULT_SETTINGS.rooms.map((r) => ({ ...r }))) : roomList(c);
    const withMail = list.filter((r) => r.email).length;
    return h(
      'details',
      { class: 'round-sum', open: editing },
      h('summary', {}, h('b', {}, 'Rooms'), h('span', { class: 'muted' }, ` · ${plural(list.length, 'room')}, ${withMail === list.length ? 'all booked with the invite' : `${withMail} with an Outlook address`}`)),
      h(
        'div',
        { class: 'sheet-wrap room-list', style: 'border:1px solid var(--grid);border-radius:6px' },
        h(
          'table',
          { class: 'x' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Room'), h('th', {}, 'Outlook address'), editing ? h('th', {}, '') : null)),
          h(
            'tbody',
            {},
            list.map((r, i) =>
              h(
                'tr',
                {},
                h('td', {}, editing ? h('input', { id: `room-name-${i}`, 'aria-label': 'Room name', value: r.name, oninput: (e) => (r.name = e.target.value) }) : r.name),
                h('td', { class: 'mono' }, editing ? h('input', { id: `room-email-${i}`, type: 'email', 'aria-label': 'Room email', placeholder: 'room@fluxpartners.nl', value: r.email || '', oninput: (e) => (r.email = e.target.value.trim()) }) : r.email || h('span', { class: 'faint' }, 'none yet, Natalie books it by hand')),
                editing ? h('td', {}, list.length > 1 ? h('button', { class: 'link', onclick: () => (list.splice(i, 1), rerender()) }, 'Remove') : null) : null,
              ),
            ),
          ),
        ),
        editing ? h('div', { style: 'padding:8px 10px' }, h('button', { onclick: () => (list.push({ name: `Room ${list.length + 1}`, email: '' }), rerender()) }, 'Add room')) : null,
      ),
    );
  }

  // ------------------------------------------------------------------
  // New campaign: structure, rules, people per round, then invite
  // ------------------------------------------------------------------
  const roleWord = (r) => (r.role === 'hr' ? 'HR' : r.role === 'teamlead' ? 'team leads' : 'advisors');
  function newWizard() {
    const first = !campaigns().length;
    const st = M.STRUCTURES[M.DEFAULT_STRUCTURE];
    return {
      name: first ? 'Trainee hiring' : '',
      startDate: TODAY,
      endDate: '',
      targetHires: first ? 10 : '',
      targetInterviews: first ? 25 : '',
      structure: st.key,
      draft: { rounds: JSON.parse(JSON.stringify(st.rounds)), settings: JSON.parse(JSON.stringify(M.DEFAULT_SETTINGS)) },
      members: null, // filled from the roster on first render
    };
  }
  function defaultMembers(rounds) {
    const out = {};
    for (const r of rounds) out[r.key] = S.state.people.filter((p) => M.eligibleFor(r, p)).map((p) => p.id);
    return out;
  }

  // Toggle chips per team for one round.
  function memberPicker(round, members, onChange) {
    const eligible = people().filter((p) => M.eligibleFor(round, p));
    const chosen = new Set(members[round.key] || []);
    if (!eligible.length) return h('p', { class: 'small muted' }, `No ${roleWord(round)} on the roster yet. Add them on the Roster page; until you choose, everyone eligible takes part.`);
    const teams = [...new Set(eligible.map((p) => p.team))].sort();
    const teamCount = new Set(eligible.filter((p) => chosen.has(p.id)).map((p) => p.team)).size;
    const set = (ids) => {
      members[round.key] = ids;
      onChange();
    };
    return h(
      'div',
      { class: 'picker' },
      h(
        'div',
        { class: 'row', style: 'justify-content:space-between' },
        h('span', { class: 'muted' }, `${chosen.size} of ${eligible.length} ${roleWord(round)} · ${plural(teamCount, 'team')}`),
        h('span', { class: 'row' }, h('button', { class: 'link', onclick: () => set(eligible.map((p) => p.id)) }, 'Everyone'), h('button', { class: 'link', onclick: () => set([]) }, 'Nobody')),
      ),
      round.differentTeams && chosen.size && teamCount < 2 ? h('p', { class: 'warn-line' }, 'This round needs people from at least two teams.') : null,
      teams.map((t) =>
        h(
          'div',
          { class: 'picker-team' },
          h('span', { class: 'picker-label' }, t),
          h(
            'div',
            { class: 'chips' },
            eligible
              .filter((p) => p.team === t)
              .map((p) =>
                h(
                  'button',
                  {
                    class: 'pick',
                    'aria-pressed': chosen.has(p.id),
                    onclick: () => set(chosen.has(p.id) ? [...chosen].filter((x) => x !== p.id) : [...chosen, p.id]),
                  },
                  p.name,
                ),
              ),
          ),
        ),
      ),
    );
  }

  function campaignWizard() {
    const w = (ui.wiz = ui.wiz || newWizard());
    if (!w.members && S.state.loaded.people) w.members = defaultMembers(w.draft.rounds);
    const err = h('p', { class: 'err-line' });
    const st = M.STRUCTURES[w.structure];
    const step = (n, title, sub, ...body) => h('section', { class: 'wiz-step' }, h('div', { class: 'wiz-num' }, n), h('div', { class: 'wiz-body' }, h('h2', {}, title), sub ? h('p', { class: 'muted' }, sub) : null, ...body));
    return h(
      'div',
      { class: 'wizard' },
      step(
        1,
        'The basics',
        null,
        h(
          'div',
          { class: 'fg' },
          h('label', { class: 'f wide' }, 'Name', h('input', { id: 'cf-name-new', value: w.name, oninput: (e) => (w.name = e.target.value) })),
          h('label', { class: 'f' }, 'Start', h('input', { type: 'date', id: 'cf-start-new', value: w.startDate, oninput: (e) => (w.startDate = e.target.value) })),
          h('label', { class: 'f' }, 'End', h('input', { type: 'date', id: 'cf-end-new', value: w.endDate, oninput: (e) => (w.endDate = e.target.value) })),
          h('label', { class: 'f' }, 'Target hires', h('input', { type: 'number', min: 0, id: 'cf-hires-new', value: w.targetHires, oninput: (e) => (w.targetHires = e.target.value) })),
          h('label', { class: 'f' }, 'Expected interviews', h('input', { type: 'number', min: 0, id: 'cf-int-new', value: w.targetInterviews, oninput: (e) => (w.targetInterviews = e.target.value) })),
        ),
      ),
      step(
        2,
        'Structure',
        'How candidates move through the campaign. You can tune each round’s rules now or later.',
        h(
          'div',
          { class: 'structs' },
          Object.values(M.STRUCTURES).map((x) =>
            h(
              'button',
              {
                class: 'struct',
                'aria-pressed': x.key === w.structure,
                onclick: () => {
                  w.structure = x.key;
                  w.draft = { rounds: JSON.parse(JSON.stringify(x.rounds)), settings: w.draft.settings };
                  w.members = defaultMembers(w.draft.rounds);
                  rerender();
                },
              },
              h('b', {}, x.name),
              h('span', { class: 'muted' }, x.description),
            ),
          ),
          h('p', { class: 'small faint' }, 'More structures (for example a 2-round interview) are added by the developer.'),
        ),
        ui.wizRules ? rulesSection({ id: 'new' }, true, w.draft) : h('button', { class: 'link', style: 'align-self:flex-start', onclick: () => ((ui.wizRules = true), rerender()) }, `Adjust the rules of the ${st.rounds.length} rounds`),
      ),
      step(
        3,
        'Who is in each round',
        'Everyone you pick gets invited to the app. People without Claude still get Outlook invites.',
        w.members ? w.draft.rounds.map((r) => h('div', { class: 'wiz-round' }, h('h3', {}, r.name), memberPicker(r, w.members, rerender))) : h('p', { class: 'muted' }, 'Loading the roster…'),
      ),
      h(
        'div',
        { class: 'row end' },
        err,
        campaigns().length ? h('button', { onclick: () => ((ui.newCampaign = false), (ui.wiz = null), rerender()) }, 'Cancel') : null,
        h(
          'button',
          {
            class: 'p big-btn',
            onclick: () => {
              if (!w.name.trim()) return (err.textContent = 'Give the campaign a name.');
              const bad = roundProblem(w.draft.rounds);
              if (bad) return (err.textContent = bad);
              // Rounds with nobody eligible on the roster yet stay open to everyone eligible.
              const members = {};
              for (const r of w.draft.rounds) if (people().some((p) => M.eligibleFor(r, p))) members[r.key] = (w.members || {})[r.key] || [];
              act(async () => {
                const id = await S.add('campaigns', M.newCampaign({ ...w, open: !campaigns().length, name: w.name.trim(), rounds: w.draft.rounds, settings: w.draft.settings, members: Object.keys(members).length ? members : null }));
                ui.campaignId = id;
                store('flux.campaign', id);
                ui.newCampaign = false;
                ui.wiz = null;
                ui.wizRules = false;
                ui.showInvite = true;
                if (Object.keys(members).length) location.hash = '#campaign';
                rerender();
              }, 'Campaign created');
            },
          },
          'Create campaign',
        ),
      ),
    );
  }

  // People in the campaign and their invitations.
  function campaignPeople(c) {
    const editing = ui.editPeople === c.id;
    const m = editing ? (ui.peopleDraft = ui.peopleDraft || JSON.parse(JSON.stringify(c.members || defaultMembers(c.rounds || [])))) : null;
    const rounds = c.rounds || [];
    const all = [...new Map(rounds.flatMap((r) => M.roundMembers(c, r.key, S.state.people).map((p) => [p.id, { p, round: r }]))).values()];
    const invited = c.invited || {};
    const status = (p) => (memberOf(p.accountId) ? h('span', { class: 'chip good' }, 'Joined') : invited[p.id] ? h('span', { class: 'chip accent' }, `Invited ${M.formatDay(invited[p.id].slice(0, 10))}`) : h('span', { class: 'chip' }, 'Not invited'));
    const link = c.appLink || '';
    const inviteText = `Hi,\n\nYou’re on the interview panel for ${c.name}. We’re trying a new way of planning interviews: a small Claude app made for Flux.\n\nOpen it here: ${link || '[link to the app]'}\n\nIt shows your interview requests, a short brief before each interview and how your team is doing. You can still answer the Outlook invites as usual. It’s new, so please press Report in the app whenever something is unclear or could be better.\n\nThanks,\nNatalie`;
    const copyBtn = h('button', { onclick: (e) => copyText(inviteText, e.target) }, 'Copy invitation');
    return h(
      'div',
      { class: 'section gutter' },
      h(
        'div',
        { class: 'head' },
        h('div', {}, h('h2', {}, 'People in this campaign'), h('p', {}, `${all.length} people across ${plural(rounds.length, 'round')}. ${all.filter((x) => memberOf(x.p.accountId)).length} have joined the app.`)),
        editing ? null : h('button', { onclick: () => ((ui.editPeople = c.id), (ui.peopleDraft = null), rerender()) }, 'Change people'),
      ),
      editing
        ? [
            rounds.map((r) => h('div', { class: 'wiz-round' }, h('h3', {}, r.name), memberPicker(r, m, rerender))),
            h(
              'div',
              { class: 'row end' },
              h('button', { onclick: () => ((ui.editPeople = null), rerender()) }, 'Cancel'),
              h('button', { class: 'p', onclick: () => act(async () => { await S.update('campaigns', c.id, { members: m }); ui.editPeople = null; ui.peopleDraft = null; ui.showInvite = true; rerender(); }, 'People saved') }, 'Save people'),
            ),
          ]
        : null,
      ui.showInvite || Object.keys(invited).length < all.length
        ? h(
            'div',
            { class: 'invite-box' },
            h('h3', {}, 'Invite them'),
            h('label', { class: 'f' }, 'Link to this app (copy it from Share in Claude)', h('input', { id: 'app-link', value: link, placeholder: 'https://claude.ai/…', onchange: (e) => act(() => S.update('campaigns', c.id, { appLink: e.target.value.trim() }), 'Link saved') })),
            h('pre', { class: 'invite-text' }, inviteText),
            h(
              'div',
              { class: 'row' },
              copyBtn,
              h('button', { class: 'p', onclick: () => act(async () => { const now = new Date().toISOString(); const next = { ...invited }; for (const x of all) next[x.p.id] = next[x.p.id] || now; await S.update('campaigns', c.id, { invited: next }); ui.showInvite = false; rerender(); }, 'Marked as invited') }, 'Mark everyone as invited'),
              h('span', { class: 'small muted' }, 'Send it from Outlook or Teams. Sending from the app comes with the Outlook connection.'),
            ),
          )
        : null,
      rounds.map((r) => {
        const ps = M.roundMembers(c, r.key, S.state.people);
        const joined = ps.filter((p) => memberOf(p.accountId)).length;
        const inv = ps.filter((p) => invited[p.id]).length;
        return h(
          'details',
          { class: 'round-sum' },
          h('summary', {}, h('b', {}, r.name), h('span', { class: 'muted' }, ` · ${plural(ps.length, 'person', 'people')} · ${inv} invited · ${joined} joined`)),
          ps.length ? null : h('p', { class: 'small muted' }, 'Nobody is in this round yet. Use Change people to add someone.'),
          h('div', { class: 'people-list' }, ps.map((p) => h('div', { class: 'person-row' }, h('span', {}, h('b', {}, p.name), h('span', { class: 'muted' }, ` · ${p.team}`)), h('span', { class: 'row' }, p.accountId ? null : h('span', { class: 'small faint' }, 'Outlook only'), status(p))))),
        );
      }),
    );
  }

  function campaignView() {
    const c = campaign();
    return [
      ui.newCampaign
        ? h('div', { class: 'section gutter' }, h('h1', {}, 'New campaign'), campaignWizard())
        : h('div', { class: 'section gutter' }, h('div', { class: 'head' }, h('div', {}, h('h1', {}, c.name), h('p', {}, `${(M.STRUCTURES[c.structure] || M.STRUCTURES[M.DEFAULT_STRUCTURE]).name}. Switch campaigns with the picker at the top.`)), h('button', { onclick: () => ((ui.newCampaign = true), (ui.wiz = null), rerender()) }, '+ New campaign')), campaignForm(c)),
      ui.newCampaign ? null : campaignPeople(c),
      ui.newCampaign ? null : rulesSection(c, true),
      ui.newCampaign ? null : adminScoreboard(c),
      ui.newCampaign ? null : archivedCampaigns(),
    ];
  }

  // Archive keeps everything (candidates, interviews, counts) but hides the campaign;
  // it can be restored. Delete is only offered when nothing real hangs off it
  // (demo data goes with it), since it can't be undone.
  function campaignEnd(c) {
    const real = S.state.candidates.filter((x) => x.campaignId === c.id && !x.mock).length + S.state.invites.filter((x) => x.campaignId === c.id && !x.mock).length;
    const leave = () => {
      ui.endCampaign = null;
      const next = campaigns().find((x) => x.id !== c.id);
      ui.campaignId = next ? next.id : null;
      store('flux.campaign', ui.campaignId || '');
    };
    const archive = () =>
      act(async () => {
        await S.update('campaigns', c.id, { archived: true, open: false, archivedAt: nowIso() });
        leave();
      }, `${c.name} archived`);
    const remove = () =>
      act(async () => {
        for (const coll of ['invites', 'notes', 'candidates']) for (const d of S.state[coll].filter((x) => x.campaignId === c.id)) await S.remove(coll, d.id);
        await S.remove('campaigns', c.id);
        leave();
      }, `${c.name} deleted`);
    if (ui.endCampaign !== c.id)
      return h('div', { class: 'camp-end', style: 'flex-basis:100%' }, h('button', { class: 'link small', onclick: () => ((ui.endCampaign = c.id), rerender()) }, real ? 'Archive this campaign' : 'Archive or delete this campaign'));
    return h(
      'div',
      { class: 'camp-end confirm', style: 'flex-basis:100%' },
      h('p', { class: 'small' }, real ? `Archive ${c.name}? It leaves the campaign picker and interviewers’ home pages. Candidates and interview history are kept, and you can restore it from this page.` : `${c.name} has no real candidates or requests. Archive it to keep it, or delete it for good${S.state.candidates.some((x) => x.campaignId === c.id) ? ' (its demo data goes too)' : ''}.`),
      h('div', { class: 'row' }, h('button', { class: 'p', onclick: archive }, 'Archive'), real ? null : h('button', { class: 'danger', onclick: remove }, 'Delete for good'), h('button', { class: 'quiet', onclick: () => ((ui.endCampaign = null), rerender()) }, 'Cancel')),
    );
  }
  function archivedCampaigns() {
    const list = S.state.campaigns.filter((c) => c.archived);
    if (!list.length) return null;
    return h(
      'details',
      { class: 'round-sum section gutter' },
      h('summary', {}, h('b', {}, 'Archived campaigns'), h('span', { class: 'muted' }, ` · ${list.length}`)),
      list.map((c) =>
        h(
          'div',
          { class: 'row', style: 'justify-content:space-between;border-top:1px solid var(--line);padding:8px 0' },
          h('span', {}, h('b', {}, c.name), h('span', { class: 'small muted' }, c.archivedAt ? ` · archived ${M.formatDay(c.archivedAt.slice(0, 10))}` : '')),
          h('button', { onclick: () => act(() => S.update('campaigns', c.id, { archived: false }), `${c.name} restored (closed to interviewers)`) }, 'Restore'),
        ),
      ),
    );
  }

  function campaignForm(c) {
    // An existing campaign shows its details read-only; changing them is a
    // deliberate Edit, so the form can't be mistaken for "new campaign".
    if (c && ui.editCampaign !== c.id) {
      const fact = (label, value) => h('div', { class: 'kpi' }, h('span', { class: 'small muted' }, label), h('b', {}, value));
      return h(
        'div',
        { class: 'tpanel camp-facts', style: 'padding:18px 20px;display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end' },
        h('div', { class: 'kpis', style: 'flex:1' }, fact('Runs', `${c.startDate ? M.formatDay(c.startDate) : '?'} to ${c.endDate ? M.formatDay(c.endDate) : 'open end'}`), fact('Target hires', String(c.targetHires || '–')), fact('Expected interviews', String(c.targetInterviews || '–'))),
        h('button', { onclick: () => ((ui.editCampaign = c.id), rerender()) }, 'Edit details'),
        h(
          'div',
          { class: `camp-open ${isOpen(c) ? 'on' : ''}`, style: 'flex-basis:100%' },
          h('span', {}, isOpen(c) ? 'Open: advisors and team leads in this campaign see it on their home.' : 'Not open: only you see this campaign. Open it when you’re ready to invite people.'),
          h('button', { class: isOpen(c) ? 'quiet' : 'p', onclick: () => act(() => S.update('campaigns', c.id, { open: !isOpen(c) }), isOpen(c) ? `${c.name} is closed to interviewers` : `${c.name} is open to interviewers`) }, isOpen(c) ? 'Close to interviewers' : 'Open to interviewers'),
        ),
        campaignEnd(c),
      );
    }
    const f = c ? { name: c.name, startDate: c.startDate, endDate: c.endDate || '', targetHires: c.targetHires || '', targetInterviews: c.targetInterviews || '' } : { name: campaigns().length ? '' : 'Trainee hiring', startDate: TODAY, endDate: '', targetHires: campaigns().length ? '' : 10, targetInterviews: campaigns().length ? '' : 25 };
    const err = h('p', { class: 'err-line' });
    return h(
      'form',
      {
        class: 'tpanel',
        style: 'padding:14px;display:flex;flex-direction:column;gap:10px',
        onsubmit: (e) => {
          e.preventDefault();
          if (!f.name.trim()) return (err.textContent = 'Give the campaign a name.');
          act(async () => {
            if (c) {
              await S.update('campaigns', c.id, { name: f.name.trim(), startDate: f.startDate, endDate: f.endDate, targetHires: Number(f.targetHires) || 0, targetInterviews: Number(f.targetInterviews) || 0 });
              ui.editCampaign = null;
            }
            else {
              const id = await S.add('campaigns', M.newCampaign({ ...f, open: !campaigns().length }));
              ui.campaignId = id;
              store('flux.campaign', id);
              ui.newCampaign = false;
            }
            rerender();
          }, c ? 'Campaign saved' : 'Campaign created');
        },
      },
      h(
        'div',
        { class: 'fg' },
        h('label', { class: 'f wide' }, 'Name', h('input', { id: `cf-name-${c ? c.id : 'new'}`, value: f.name, oninput: (e) => (f.name = e.target.value) })),
        h('label', { class: 'f' }, 'Start', h('input', { type: 'date', id: `cf-start-${c ? c.id : 'new'}`, value: f.startDate, oninput: (e) => (f.startDate = e.target.value) })),
        h('label', { class: 'f' }, 'End', h('input', { type: 'date', id: `cf-end-${c ? c.id : 'new'}`, value: f.endDate, oninput: (e) => (f.endDate = e.target.value) })),
        h('label', { class: 'f' }, 'Target hires', h('input', { type: 'number', min: 0, id: `cf-hires-${c ? c.id : 'new'}`, value: f.targetHires, oninput: (e) => (f.targetHires = e.target.value) })),
        h('label', { class: 'f' }, 'Expected interviews', h('input', { type: 'number', min: 0, id: `cf-int-${c ? c.id : 'new'}`, value: f.targetInterviews, oninput: (e) => (f.targetInterviews = e.target.value) })),
      ),
      err,
      c ? h('p', { class: 'small muted' }, `You're changing ${c.name} itself. To start another campaign, use + New campaign.`) : null,
      h('div', { class: 'row end' }, c ? h('button', { type: 'button', class: 'quiet', onclick: () => ((ui.editCampaign = null), rerender()) }, 'Cancel') : null, h('button', { class: 'p', type: 'submit' }, c ? 'Save changes' : 'Create campaign')),
    );
  }


  // ------------------------------------------------------------------
  // Advisor / team lead view
  //
  // Interviewers can't read candidates, notes or invites. Natalie's page
  // writes each linked person an inbox/{accountId} doc holding only their
  // own requests, interviews (with the brief record) and scores, plus a
  // stats/{campaignId} doc with the campaign overview and team board.
  // Interviewers write answers and feedback to replies/{their id}; Natalie's
  // page applies them to invites and notes.
  // ------------------------------------------------------------------
  const ROUND_LABEL = { advisor: 'Advisor interview', deepdive: 'Deep dive' };
  const LEANS = [['pass', 'Leaning yes'], ['unsure', 'Unsure'], ['reject', 'Leaning no']];
  const interviewerPeople = () => people().filter((p) => p.active !== false && (p.roles || []).some((r) => r === 'advisor' || r === 'teamlead' || r === 'joker'));
  function notesWithPerson() {
    return S.state.notes.map((n) => {
      if (n.authorPersonId) return { ...n, personId: n.authorPersonId };
      const p = n.authorId && S.state.people.find((x) => x.accountId && x.accountId === n.authorId);
      return { ...n, personId: p ? p.id : null };
    });
  }
  const campCands = (campId) => S.state.candidates.filter((c) => c.campaignId === campId);

  // ------------------------------------------------------------------
  // Metrics: how the campaign is doing, for Natalie and for management
  // ------------------------------------------------------------------
  function metricsView() {
    const camp = campaign();
    const m = M.campaignMetrics({ camp, cands: campCands(camp.id), invites: campInvites(camp.id), notes: notesWithPerson().map((n) => ({ ...n, authorPersonId: n.personId })), people: S.state.people, today: TODAY });
    const pct = (x) => (x == null ? '–' : `${Math.round(x * 100)}%`);
    const days = (x) => (x == null ? '–' : `${Math.round(x * 10) / 10} ${x === 1 ? 'day' : 'days'}`);
    const hours = (x) => (x == null ? '–' : x < 24 ? `${Math.round(x)} h` : days(x / 24));
    const tile = (label, value, sub) => h('div', { class: 'kpi' }, h('span', { class: 'small muted' }, label), h('b', {}, value), sub ? h('span', { class: 'small muted' }, sub) : null);
    const weeksLeft = camp.endDate ? Math.max(1, Math.ceil(M.daysBetween(TODAY, camp.endDate) / 7)) : null;
    const pace = weeksLeft && m.targetInterviews > m.interviewsHeld ? Math.ceil((m.targetInterviews - m.interviewsHeld) / weeksLeft) : null;
    const maxF = Math.max(1, ...m.funnel.map((r) => r.n));
    const maxW = Math.max(1, pace || 0, ...m.weeks.map((w) => w.n));
    const table = (rows) => h('table', { class: 'x metrics-t' }, h('tbody', {}, rows.map(([k, v, note]) => h('tr', {}, h('td', {}, k), h('td', { class: 'num' }, v), h('td', { class: 'small muted wide-only' }, note || '')))));
    const summary = [
      `${camp.name}, ${M.formatDay(TODAY)}`,
      `Hires: ${m.hires}${m.targetHires ? ` of ${m.targetHires}` : ''} (${m.offers} offers). Interviews held: ${m.interviewsHeld}${m.targetInterviews ? ` of ${m.targetInterviews}` : ''}.`,
      `Funnel: ${m.funnel.map((r) => `${r.label} ${r.n}`).join(', ')}.`,
      `Speed: HR to advisor interview ${days(m.speed.toAdvisor)}, advisor to deep dive ${days(m.speed.toDeepdive)}, HR to offer ${days(m.speed.toOffer)}.`,
      `On time: advisor round ${pct(m.onTime.advisor.share)}, deep dive ${pct(m.onTime.deepdive.share)}.`,
      `Requests: ${m.requests.sent} sent, ${pct(m.requests.acceptShare)} accepted, reply in ${hours(m.requests.replyHours)}.`,
      `Feedback: ${pct(m.feedback.share)} of interviewers, after ${days(m.feedback.days)}.`,
    ].join('\n');
    return h(
      'div',
      { class: 'section gutter metrics' },
      h('div', { class: 'head' }, h('div', {}, h('h1', {}, 'Metrics'), h('p', {}, `${camp.name}, up to ${M.formatDay(TODAY)}. Interviews count once they are booked and their day has come.`)), h('button', { onclick: (e) => copyText(summary, e.target) }, 'Copy summary')),
      m.candidates
        ? [
            h('div', { class: 'kpis' }, tile('Hires', `${m.hires}${m.targetHires ? ` of ${m.targetHires}` : ''}`, `${plural(m.offers, 'offer')} made`), tile('Interviews held', `${m.interviewsHeld}${m.targetInterviews ? ` of ${m.targetInterviews}` : ''}`, pace ? `${pace} a week needed to ${M.formatDay(camp.endDate)}` : 'advisor rounds and deep dives'), tile('Candidates', String(m.candidates), `${m.open} open${m.withdrew ? `, ${m.withdrew} withdrew` : ''}`), tile('HR to offer', days(m.speed.toOffer), 'median')),
            h(
              'div',
              { class: 'metrics-grid' },
              h(
                'section',
                { class: 'tpanel', 'aria-label': 'Funnel' },
                h('div', { class: 'ph' }, 'Funnel', h('span', { class: 'faint' }, 'share is of the step before')),
                h(
                  'div',
                  { class: 'funnel' },
                  m.funnel.map((r) => h('div', { class: 'f-row', title: `${r.label}: ${r.n}${r.ofPrev != null ? `, ${pct(r.ofPrev)} of the step before` : ''}` }, h('span', { class: 'f-label' }, r.label), h('span', { class: 'f-track' }, h('span', { class: 'f-bar', style: `width:${(r.n / maxF) * 100}%` })), h('span', { class: 'f-num' }, String(r.n)), h('span', { class: 'f-pct small muted' }, r.ofPrev != null ? pct(r.ofPrev) : ''))),
                ),
              ),
              h(
                'section',
                { class: 'tpanel', 'aria-label': 'Interviews per week' },
                h('div', { class: 'ph' }, 'Interviews per week', h('span', { class: 'faint' }, pace ? `line: ${pace} a week needed` : 'advisor rounds and deep dives')),
                h(
                  'div',
                  { class: 'weeks', role: 'img', 'aria-label': m.weeks.map((w) => `week of ${M.formatDay(w.week)}: ${w.n}`).join('; ') },
                  pace ? h('span', { class: 'w-pace', style: `bottom:calc(28px + ${Math.round((pace / maxW) * 130)}px)` }) : null,
                  m.weeks.map((w) => h('div', { class: 'w-col', title: `Week of ${M.formatDay(w.week)}: ${plural(w.n, 'interview')}` }, h('span', { class: 'w-num small' }, w.n ? String(w.n) : ''), h('span', { class: 'w-bar', style: `height:${(w.n / maxW) * 100}%` }), h('span', { class: 'w-lab small muted' }, M.formatDay(w.week).replace(/^\w+ /, '')))),
                ),
              ),
              h('section', { class: 'tpanel', 'aria-label': 'Speed' }, h('div', { class: 'ph' }, 'Speed', h('span', { class: 'faint' }, 'medians, calendar days')), table([['HR interview to advisor interview', days(m.speed.toAdvisor)], ['Advisor interview to deep dive', days(m.speed.toDeepdive)], ['HR interview to offer', days(m.speed.toOffer)], ['Candidate sends availability', days(m.speed.availReply), 'after Natalie asks'], ['Advisor round on time', pct(m.onTime.advisor.share), `${m.onTime.advisor.met} of ${m.onTime.advisor.all} within the round’s limit`], ['Deep dive on time', pct(m.onTime.deepdive.share), `${m.onTime.deepdive.met} of ${m.onTime.deepdive.all} within the round’s limit`]])),
              h(
                'section',
                { class: 'tpanel', 'aria-label': 'Interviewer requests' },
                h('div', { class: 'ph' }, 'Interviewer requests'),
                table([
                  ['Requests sent', String(m.requests.sent), m.requests.pending ? `${m.requests.pending} waiting` : ''],
                  ['Accepted', pct(m.requests.acceptShare), `${m.requests.accepted} accepted, ${m.requests.declined} declined`],
                  ['Reply time', hours(m.requests.replyHours), 'median'],
                  ['Requests per booked interview', m.requests.perBooking == null ? '–' : String(Math.round(m.requests.perBooking * 10) / 10)],
                  ['Released', String(m.requests.released), m.requests.releaseNoticeDays != null ? `median ${days(m.requests.releaseNoticeDays)} notice` : ''],
                  ...m.requests.declineReasons.slice(0, 3).map(([r, n]) => [`Declined: ${r.toLowerCase()}`, String(n)]),
                ]),
              ),
              h(
                'section',
                { class: 'tpanel', 'aria-label': 'Feedback and load' },
                h('div', { class: 'ph' }, 'Feedback and load'),
                table([
                  ['Feedback written', pct(m.feedback.share), `${m.feedback.given} of ${m.feedback.expected} interviewers`],
                  ['Feedback arrives', days(m.feedback.days), 'median, after the interview'],
                  ['Interviewers involved', String(m.load.people), m.load.people ? `${m.load.min} to ${m.load.max} interviews each` : ''],
                  ...m.load.byTeam.map(([t, n]) => [`Team ${t}`, plural(n, 'interview'), '']),
                ]),
              ),
            ),
          ]
        : h('p', { class: 'muted' }, 'No candidates in this campaign yet. Metrics fill in as candidates move through the rounds.'),
    );
  }
  const campInvites = (campId) => S.state.invites.filter((i) => i.campaignId === campId);

  function scoresFor(camp) {
    // Only the people in this campaign's interview rounds take part.
    const ids = new Set((camp.rounds || []).filter((r) => r.role !== 'hr').flatMap((r) => M.roundMembers(camp, r.key, S.state.people).map((p) => p.id)));
    const sb = M.scoreboard({ cands: campCands(camp.id), invites: campInvites(camp.id), notes: notesWithPerson().filter((n) => n.campaignId === camp.id), people: S.state.people.filter((p) => ids.has(p.id)), today: TODAY });
    // Personal interview goals: each person's share of the campaign's expected interviews.
    const goals = M.interviewGoals({ camp, cands: campCands(camp.id), invites: campInvites(camp.id), people: S.state.people, today: TODAY });
    for (const x of sb.people) {
      const g = goals[x.personId];
      x.goal = g ? g.goal : 0;
      x.goalDone = g ? g.done : 0;
      x.goalPlanned = g ? g.planned : 0;
    }
    return sb;
  }

  function statsFor(camp) {
    const cands = campCands(camp.id);
    const ivs = M.interviewsOf(cands, campInvites(camp.id));
    const slots = new Map();
    for (const r of ivs) slots.set(`${r.candidateId}|${r.round}`, r.slotDate);
    const dates = [...slots.values()];
    const sb = scoresFor(camp);
    return {
      campaignId: camp.id,
      name: camp.name,
      startDate: camp.startDate || '',
      endDate: camp.endDate || '',
      targetHires: camp.targetHires || 0,
      targetInterviews: camp.targetInterviews || 0,
      expectedByRound: Object.fromEntries((camp.rounds || []).filter((r) => r.role !== 'hr').map((r) => [r.key, M.expectedInterviews(camp, r)])),
      pipeline: M.pipelineCounts(cands, TODAY),
      interviewsDone: dates.filter((d) => d <= TODAY).length,
      interviewsNext7: dates.filter((d) => d > TODAY && d <= M.addDays(TODAY, 7)).length,
      fairEach: sb.fairEach,
      teams: sb.teams,
      asOf: TODAY,
    };
  }

  function nudgeFor(row, list) {
    if (!row) return '';
    if (row.rank === 1) return !row.points ? 'Everyone starts level. Your first interview puts you on top.' : list.filter((x) => x.points === row.points).length > 1 ? 'You share the top spot.' : 'You’re top of the board. Nice work.';
    const above = list.filter((x) => x.points > row.points).sort((a, b) => a.points - b.points)[0];
    const newRank = 1 + list.filter((x) => x.points > above.points).length;
    const gap = above.points - row.points + 1;
    const n = Math.ceil(gap / M.POINTS.interview);
    return `${plural(n, 'more interview')} moves you up to #${newRank}.`;
  }

  function inboxFor(p) {
    const allCands = S.state.candidates;
    const open = new Set(allCands.filter((c) => cstate(c).status === 'open').map((c) => c.id));
    const byId = new Map(allCands.map((c) => [c.id, c]));
    const notes = notesWithPerson();
    const requests = S.state.invites
      .filter((i) => i.personId === p.id && i.status === 'pending' && open.has(i.candidateId) && i.slotDate >= TODAY)
      .sort((a, b) => a.slotDate.localeCompare(b.slotDate))
      .map((i) => ({ id: i.id, campaignId: i.campaignId, round: i.round, slotDate: i.slotDate, time: i.time || '', room: i.room || '', candidate: first(byId.get(i.candidateId)), sentAt: i.sentAt || '' }));
    const interviews = M.interviewsOf(allCands, S.state.invites)
      .filter((r) => r.personId === p.id && r.slotDate >= M.addDays(TODAY, -28))
      .map((r) => {
        const c = byId.get(r.candidateId);
        return {
          key: `${r.candidateId}:${r.round}`,
          candidateId: r.candidateId,
          campaignId: r.campaignId,
          name: c.name,
          round: r.round,
          slotDate: r.slotDate,
          time: r.time,
          room: r.room,
          booked: r.booked,
          partners: r.partners.map((id) => pname(id)),
          feedbackSent: notes.filter((n) => n.kind === 'feedback' && n.personId === p.id && n.candidateId === r.candidateId && n.round === r.round).length,
          record: briefRecord(c),
        };
      });
    const role = (p.roles || []).includes('teamlead') ? 'teamlead' : 'advisor';
    const srcs = availSources();
    const availability = {};
    for (let d = TODAY, n = 0; n < 20; d = M.addDays(d, 1)) {
      const wd = M.weekdayOf(d);
      if (wd < 1 || wd > 5) continue;
      const a = M.availabilityOn(srcs, p.id, role, d);
      availability[d] = a ? a.value || null : null;
      n++;
    }
    const scores = {};
    for (const camp of openCampaigns()) {
      const sb = scoresFor(camp);
      const row = sb.people.find((x) => x.personId === p.id);
      if (row) scores[camp.id] = { ...row, nudge: nudgeFor(row, sb.people) };
    }
    return { personId: p.id, name: p.name, team: p.team, role: roleLabel(p), requests, interviews, availability, scores, asOf: TODAY };
  }

  // ---- Natalie's page keeps the shared docs current ----
  const written = {};
  const applied = new Set();
  let syncTimer = null;
  function scheduleSync() {
    if (!S || !S.admin) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => syncShared().catch((e) => console.error('sync failed', e && e.message)), 1200);
  }
  async function writeIfChanged(coll, id, doc) {
    const body = JSON.stringify(doc);
    if (written[`${coll}/${id}`] === body) return;
    written[`${coll}/${id}`] = body;
    await S.set(coll, id, { ...doc, updatedAt: new Date().toISOString() });
  }
  async function syncShared() {
    if (!window.FluxStore.COLLECTIONS.every((c) => S.state.loaded[c])) return;
    await applyReplies();
    for (const camp of openCampaigns()) await writeIfChanged('stats', camp.id, statsFor(camp));
    const openIds = new Set(openCampaigns().map((c) => c.id));
    for (const d of S.state.stats) if (!openIds.has(d.id)) await S.remove('stats', d.id);
    const linked = S.state.people.filter((p) => p.accountId && !p.accountId.startsWith('mock:') && p.active !== false);
    for (const p of linked) await writeIfChanged('inbox', p.accountId, inboxFor(p));
    const keep = new Set(linked.map((p) => p.accountId));
    for (const d of S.state.inbox) if (!keep.has(d.id)) await S.remove('inbox', d.id);
  }
  // Same rules as the hourly routine (tools/apply-replies.js): M.planReplyWrites.
  async function applyReplies() {
    const writes = M.planReplyWrites({ replies: S.state.replies, people: S.state.people, invites: S.state.invites, candidates: S.state.candidates, notes: S.state.notes, reports: S.state.reports, now: nowIso() });
    for (const w of writes) {
      const k = `${w.collection}:${w.doc_id}`;
      if (applied.has(k)) continue;
      applied.add(k);
      if (w.op === 'update') await S.update(w.collection, w.doc_id, w.data);
      else await S.set(w.collection, w.doc_id, w.data);
    }
  }

  // ---- Which view to show ----
  function ivContext() {
    if (!S.admin) {
      const stats = S.state.stats;
      return { mode: 'viewer', inbox: S.state.mine.inbox, replies: S.state.mine.replies || null, stats, loading: S.state.mine.inbox === undefined };
    }
    const p = ui.viewAs && personById(ui.viewAs);
    if (!p || !campaign()) return null;
    return { mode: 'preview', person: p, inbox: inboxFor(p), replies: null, stats: openCampaigns().map(statsFor), loading: false };
  }

  // Top-bar switch: Admin (Natalie) / Advisor / Team lead. Picking a role
  // shows the busiest person in that role; the small select changes who.
  function busiest(role) {
    const ps = interviewerPeople().filter((p) => roleLabel(p) === role);
    const score = (p) => S.state.invites.filter((i) => i.personId === p.id).length;
    return [...ps].sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name))[0] || null;
  }
  function setViewAs(id, dev) {
    ui.dev = !!dev;
    ui.menuOpen = false;
    ui.viewAs = id || null;
    store('flux.viewAs', ui.viewAs || '');
    ui.forms = {};
    ui.candId = null;
    ui.openStep = null;
    rerender();
    window.scrollTo(0, 0);
  }
  function viewSwitch() {
    if (!S.admin || !campaign()) return null;
    const cur = ui.viewAs && personById(ui.viewAs);
    const curRole = ui.dev ? 'dev' : cur ? roleLabel(cur) : 'admin';
    const seg = [
      ['admin', 'Admin'],
      ['advisor', 'Advisor'],
      ['team lead', 'Team lead'],
      ['dev', `Developer${S.state.reports.filter((x) => (x.status || 'new') === 'new').length ? ` · ${S.state.reports.filter((x) => (x.status || 'new') === 'new').length}` : ''}`],
    ];
    return h(
      'div',
      { class: 'viewas', role: 'group', 'aria-label': 'View the app as' },
      h('span', { class: 'label' }, 'See the app as'),
      h(
        'div',
        { class: 'seg' },
        seg.map(([r, label]) =>
          h(
            'button',
            {
              'aria-pressed': curRole === r || (r === 'team lead' && curRole === 'joker'),
              onclick: () => {
                if (r === 'admin') return setViewAs(null);
                if (r === 'dev') return setViewAs(null, true);
                if (curRole === r) return;
                const p = busiest(r);
                if (p) setViewAs(p.id);
                else toast(`No ${r}s on the roster yet.`);
              },
            },
            label,
          ),
        ),
      ),
      cur
        ? h(
            'select',
            { id: 'view-as', 'aria-label': 'Which colleague', onchange: (e) => setViewAs(e.target.value) },
            interviewerPeople()
              .filter((p) => roleLabel(p) === curRole)
              .map((p) => h('option', { value: p.id, selected: p.id === cur.id }, `${p.name} (${p.team})`)),
          )
        : null,
    );
  }

  function ivTopBar(ctx) {
    const me2 = ctx.inbox;
    return h(
      'header',
      { class: 'bar gutter' },
      h('div', { class: 'brand' }, h('span', {}, 'Flux interviews')),
      h('nav', {}, h('a', { href: '#run', 'aria-current': 'page' }, 'My interviews')),
      h(
        'div',
        { class: 'end' },
        testPill(),
        ctx.mode === 'preview' ? h('button', { class: 'view-pill', title: `This is what ${ctx.person.name} (${roleLabel(ctx.person)}, ${ctx.person.team}) sees. Anything you answer here is saved as mock.`, onclick: () => setViewAs(null) }, `Viewing as ${ctx.person.name.split(' ')[0]} · back to admin`) : null,
        S.admin ? nameMenu() : me2 ? h('span', {}, me2.name.split(' ')[0]) : null,
        reportFab(),
      ),
    );
  }

  // ---- The page itself ----
  function interviewerView(ctx) {
    if (ctx.loading) return h('div', { class: 'home' }, h('div', { class: 'calm-head' }, h('p', { class: 'date' }, 'Loading…')));
    const inbox = ctx.inbox;
    // Only open campaigns reach this page; of those, show the ones this person is part of.
    const allStats = ctx.stats || [];
    const scored = ctx.inbox && ctx.inbox.scores ? allStats.filter((x) => ctx.inbox.scores[x.campaignId]) : [];
    const stats = scored.length ? scored : allStats;
    const st = stats.find((x) => x.campaignId === ui.ivCampaign) || stats[0] || null;
    if (!inbox)
      return h(
        'div',
        { class: 'home iv-home' },
        h('div', { class: 'calm-head' }, h('h1', {}, 'Welcome.'), h('p', { class: 'lead' }, 'Natalie hasn’t linked your Claude account to the interview roster yet, so there’s nothing for you here yet. Ask her to add you, then reopen this page.')),
        st ? h('div', { class: 'cols iv-cols' }, h('div', {}), h('aside', { class: 'iv-aside' }, campaignBlock(st))) : null,
      );
    const open = (inbox.requests || []).filter((r) => !replyFor(ctx, r.id));
    const role = `${inbox.role[0].toUpperCase()}${inbox.role.slice(1)}`;
    const lead = open.length ? (open.length === 1 ? 'One request is waiting for your answer.' : `${open.length} requests are waiting for your answer.`) : 'Nothing is waiting for you right now.';
    return h(
      'div',
      { class: 'home iv-home' },
      h(
        'div',
        { class: 'cols iv-cols' },
        h(
          'div',
          {},
          h('div', { class: 'calm-head' }, h('p', { class: 'kicker' }, [role, inbox.team, st ? st.name : ''].filter(Boolean).join(' · ')), h('h1', {}, `Hi ${inbox.name.split(' ')[0]}.`), h('p', { class: 'lead' }, lead)),
          st ? myGoal(inbox, st) : null,
          stats.length > 1 ? h('div', { class: 'row', style: 'margin-top:24px' }, stats.map((x) => h('button', { class: x === st ? 'p' : '', onclick: () => ((ui.ivCampaign = x.campaignId), rerender()) }, x.name))) : null,
          h('div', { style: 'margin-top:48px' }, ivRequests(ctx)),
          ivInterviews(ctx),
          h('div', { style: 'margin-top:8px' }, ivAvailability(inbox), ivRules(st)),
        ),
        h('aside', { class: 'iv-aside' }, st ? myScore(inbox, st) : null, st ? campaignBlock(st) : null),
      ),
    );
  }

  function ivRules(st) {
    const camp = st && S.state.campaigns.find((x) => x.id === st.campaignId);
    if (!camp) return null;
    return h('details', { class: 'fold', open: !!ui.ivRulesOpen, ontoggle: (e) => (ui.ivRulesOpen = e.target.open) }, h('summary', {}, 'How interviews are planned'), h('div', { class: 'fold-body' }, rulesSection(camp, false)));
  }
  function replyFor(ctx, id) {
    return ctx.replies && ctx.replies.invites && ctx.replies.invites[id];
  }
  async function saveReply(ctx, patch) {
    const cur = ctx.replies || {};
    // Reports carry a screenshot, so only the 3 newest stay in this doc; Natalie's page copies them to reports/.
    const reports = Object.entries({ ...(cur.reports || {}), ...(patch.reports || {}) })
      .sort((a, b) => (b[1].createdAt || '').localeCompare(a[1].createdAt || ''))
      .slice(0, 3);
    const doc = { invites: { ...(cur.invites || {}), ...(patch.invites || {}) }, feedback: { ...(cur.feedback || {}), ...(patch.feedback || {}) }, reports: Object.fromEntries(reports) };
    await S.set('replies', S.myId || 'local', doc);
  }
  function ivAnswer(ctx, req, status, reason) {
    if (ctx.mode === 'preview') {
      const inv = S.state.invites.find((i) => i.id === req.id);
      return act(() => S.update('invites', req.id, { status, respondedAt: nowIso(), via: 'app', declineReason: reason || '', mock: true }), status === 'accepted' ? 'Accepted' : 'Declined').then(() => inv);
    }
    return act(() => saveReply(ctx, { invites: { [req.id]: { status, reason: reason || '', at: new Date().toISOString() } } }), status === 'accepted' ? 'Accepted. Natalie will confirm the pair.' : 'Declined. Thanks for letting us know.');
  }
  function ivFeedback(ctx, iv, text) {
    if (ctx.mode === 'preview') {
      const p = ctx.person;
      return act(() => S.add('notes', { candidateId: iv.candidateId, campaignId: iv.campaignId, round: iv.round, kind: 'feedback', text, authorId: null, authorPersonId: p.id, authorLabel: p.name, mock: true, createdAt: nowIso() }), 'Feedback sent');
    }
    const k = S.uid('fb_');
    return act(() => saveReply(ctx, { feedback: { [k]: { candidateId: iv.candidateId, round: iv.round, text, at: new Date().toISOString() } } }), 'Feedback sent to Natalie');
  }

  function ivRequests(ctx) {
    const reqs = ctx.inbox.requests || [];
    const reasons = (ui.ivReasons = ui.ivReasons || {});
    const open = reqs.filter((r) => !replyFor(ctx, r.id));
    const answered = reqs.filter((r) => replyFor(ctx, r.id));
    return h(
      'div',
      { 'aria-label': 'Requests for you' },
      open.map((r) =>
        h(
          'section',
          { class: 'iv-request', 'aria-label': 'Interview request' },
          h('span', { class: 'kick' }, 'Interview request'),
          h('div', { class: 'when' }, `${M.formatDay(r.slotDate)}, ${r.time}`),
          h('p', {}, `${ROUND_LABEL[r.round]} with ${r.candidate.split(' ')[0]} · ${r.room || 'room tbc'} · one hour, together with a colleague from another team.`),
          h('div', { class: 'row' }, h('button', { class: 'p', onclick: () => ivAnswer(ctx, r, 'accepted') }, 'Accept'), h('button', { onclick: () => ivAnswer(ctx, r, 'declined', reasons[r.id]) }, 'Decline'), h('span', { class: 'small faint' }, 'or answer the Outlook invite')),
          h('details', { class: 'plus' }, h('summary', {}, '+ Add a reason if you decline'), h('input', { id: `iv-reason-${r.id}`, placeholder: 'Reason (optional)', value: reasons[r.id] || '', oninput: (e) => (reasons[r.id] = e.target.value) })),
        ),
      ),
      answered.length
        ? h(
            'div',
            { class: 'answered' },
            answered.map((r) => {
              const done = replyFor(ctx, r.id);
              return h('div', { class: 'a' }, h('span', {}, `${M.formatDay(r.slotDate)} ${r.time} · ${r.candidate}`), done.status === 'accepted' ? h('span', { class: 'pill-ok' }, '✓ You accepted. Natalie confirms the pair.') : h('span', { class: 'chip' }, 'You declined'));
            }),
          )
        : null,
      !reqs.length ? h('p', { class: 'muted' }, 'When Natalie asks you to interview, it shows up here and in Outlook.') : null,
    );
  }

  function ivInterviews(ctx) {
    const list = ctx.inbox.interviews || [];
    const upcoming = list.filter((x) => x.slotDate >= TODAY);
    const past = list.filter((x) => x.slotDate < TODAY || (x.slotDate === TODAY && !x.feedbackSent)).filter((x) => x.slotDate <= TODAY);
    const pendingFb = (iv) => Object.values((ctx.replies && ctx.replies.feedback) || {}).filter((f) => f.candidateId === iv.candidateId && f.round === iv.round).length;
    const card = (iv, isPast) => {
      const sent = iv.feedbackSent + (ctx.mode === 'viewer' ? pendingFb(iv) : 0);
      const fk = `ivfb:${iv.key}:${ctx.inbox.personId}`;
      const f = (ui.forms = ui.forms || {})[fk] || (ui.forms[fk] = { text: '', lean: 'pass', open: false });
      return h(
        'div',
        { class: 'iv-row' },
        h('div', { class: 'top' }, h('b', {}, iv.name), sent ? h('span', { class: 'pill-ok' }, '✓ Feedback sent') : isPast ? h('span', { class: 'chip warn' }, 'Feedback due') : null),
        h('div', { class: 'meta' }, `${ROUND_LABEL[iv.round]} · ${M.formatDay(iv.slotDate)} ${iv.time} · ${iv.room || 'room tbc'}${iv.partners.length ? ` · with ${iv.partners.join(', ')}` : ''}${iv.booked ? '' : ' · pair not confirmed yet'}`),
        ivBrief(iv),
        isPast && !sent
          ? h(
              'div',
              { class: 'step-form' },
              h('textarea', { id: `iv-fb-${iv.key}`, placeholder: 'How did it go? What stood out, what should the next round dig into?', value: f.text, oninput: (e) => (f.text = e.target.value) }),
              h(
                'div',
                { class: 'row' },
                h('select', { id: `iv-lean-${iv.key}`, 'aria-label': 'Your verdict', onchange: (e) => (f.lean = e.target.value) }, LEANS.map(([v, l]) => h('option', { value: v, selected: f.lean === v }, l))),
                h(
                  'button',
                  {
                    class: 'p',
                    onclick: () => {
                      if (!f.text.trim()) return;
                      const lean = LEANS.find((x) => x[0] === f.lean)[1];
                      ivFeedback(ctx, iv, `${lean}. ${f.text.trim()}`).then(() => {
                        ui.forms[fk] = { text: '', lean: 'pass' };
                        rerender();
                      });
                    },
                  },
                  'Send feedback',
                ),
                h('span', { class: 'small faint' }, 'Within a day earns 3 points'),
              ),
            )
          : null,
      );
    };
    return h(
      'section',
      { class: 'iv-sec', 'aria-label': 'Your interviews' },
      h('h2', {}, 'Your interviews'),
      upcoming.length || past.length ? null : h('p', { class: 'muted', style: 'padding:20px 0' }, 'No interviews planned for you yet.'),
      past.filter((x) => !x.feedbackSent).map((x) => card(x, true)),
      upcoming.filter((x) => x.slotDate > TODAY || x.feedbackSent).map((x) => card(x, false)),
      past.filter((x) => x.feedbackSent).length ? h('p', { class: 'iv-row earlier' }, `Earlier: ${past.filter((x) => x.feedbackSent).map((x) => `${x.name.split(' ')[0]} (${M.formatDay(x.slotDate)})`).join(', ')}`) : null,
    );
  }

  function ivBrief(iv) {
    if (!sample) return null;
    const key = `iv:${iv.key}`;
    const b = (briefs[key] = briefs[key] || { text: '', busy: false, error: '', focus: '', open: false });
    if (!b.open) return h('button', { class: 'link', style: 'align-self:flex-start', onclick: () => ((b.open = true), rerender()) }, b.text ? 'Show brief' : 'Brief me before the interview');
    const out = h('div', { class: 'small brief-out' }, b.text);
    const status = h('p', { class: b.error ? 'err-line' : 'small muted' }, b.error || (b.busy ? 'Claude is writing the brief…' : ''));
    async function run() {
      b.busy = true;
      b.error = '';
      status.className = 'small muted';
      status.textContent = 'Claude is writing the brief…';
      out.textContent = '';
      if (b.ctrl) b.ctrl.abort();
      b.ctrl = new AbortController();
      try {
        const res = await sample(briefPromptFrom(iv.record, iv.round, b.focus), { modelTier: 'default', signal: b.ctrl.signal, onText: ({ text }) => ((b.text = text), (out.textContent = text)) });
        b.text = res.text;
        out.textContent = res.text;
        status.textContent = res.truncated ? 'The brief was cut short.' : '';
      } catch (e) {
        if (e && e.name === 'AbortError') return;
        b.error = e && e.code === 'not_granted' ? 'Claude isn’t allowed on this page.' : e && e.code === 'rate_limited' ? 'Claude is busy. Try again in a minute.' : 'Claude couldn’t write the brief. Try again.';
        status.className = 'err-line';
        status.textContent = b.error;
      } finally {
        b.busy = false;
      }
    }
    return h(
      'div',
      { class: 'brief-box' },
      h('div', { class: 'row' }, h('input', { id: `iv-focus-${iv.key}`, style: 'flex:1;min-width:160px', placeholder: 'Anything you want to dig into? (optional)', value: b.focus, oninput: (e) => (b.focus = e.target.value) }), h('button', { class: 'p', onclick: run }, b.text ? 'Brief me again' : 'Brief me'), h('button', { class: 'link', onclick: () => ((b.open = false), rerender()) }, 'Hide')),
      status,
      out,
    );
  }

  function ivAvailability(inbox) {
    const days = Object.keys(inbox.availability || {}).sort();
    if (!days.length) return null;
    return h(
      'details',
      { class: 'fold', 'aria-label': 'Your availability', open: !!ui.ivAvailOpen, ontoggle: (e) => (ui.ivAvailOpen = e.target.open) },
      h('summary', {}, 'Your availability · what Natalie has for you'),
      h(
        'div',
        { class: 'fold-body' },
        h('p', { class: 'small muted' }, 'From the poll or what you told her. Something changed? Update the poll sheet or tell Natalie.'),
        h(
        'div',
        { class: 'sheet-wrap' },
        h(
          'table',
          { class: 'x avail-strip' },
          h('thead', {}, h('tr', {}, days.map((d) => h('th', { class: M.weekdayOf(d) === 1 ? 'wk' : '' }, short(d))))),
          h('tbody', {}, h('tr', {}, days.map((d) => h('td', { class: `v ${inbox.availability[d] || 'null'}`, title: NL[inbox.availability[d]] || 'No answer' }, inbox.availability[d] ? NL[inbox.availability[d]].split(' ')[0] : '')))),
        ),
      ),
      ),
    );
  }

  const hrs = (x) => (x === null || x === undefined ? '–' : x < 1 ? '<1 h' : x < 48 ? `${Math.round(x)} h` : `${Math.round(x / 24)} d`);

  const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;

  function myScore(inbox, st) {
    const s = inbox.scores && inbox.scores[st.campaignId];
    if (!s) return null;
    const mine = (st.teams || []).find((t) => t.team === inbox.team);
    return h(
      'section',
      { class: 'blk score', 'aria-label': 'Your score' },
      h('span', { class: 'label' }, 'Your score'),
      h('div', { class: 'rank' }, `#${s.rank} of ${s.of} overall,`, h('br'), `#${s.teamRank} of ${s.teamOf} in ${s.team}.`),
      h('p', {}, `${plural(s.points, 'point')}. ${s.nudge || ''}`.trim()),
      h(
        'details',
        { open: !!ui.ivNumbersOpen, ontoggle: (e) => (ui.ivNumbersOpen = e.target.open) },
        h('summary', {}, 'Your numbers'),
        h('div', { class: 'kpis' }, kpi('Interviews done', s.done, s.upcoming ? `${s.upcoming} coming up` : `fair share ${st.fairEach}`), kpi('Avg reply time', hrs(s.avgReplyHours), `${s.quickReplies} within a day`), kpi('Feedback on time', s.feedbackDue ? `${s.feedbackOnTime}/${s.feedbackDue}` : '–', 'within a day')),
        s.badges.length ? h('div', { class: 'row', style: 'margin-top:10px' }, s.badges.map((b) => h('span', { class: 'chip good' }, `★ ${b}`))) : null,
        h('p', { class: 'small faint', style: 'margin-top:10px' }, `${M.POINTS.interview} points per interview, ${M.POINTS.quickReply} for answering a request within a day, ${M.POINTS.quickFeedback} for feedback within a day. Only you and Natalie see your own numbers.`),
      ),
      h('details', { open: !!ui.ivBoardOpen, ontoggle: (e) => (ui.ivBoardOpen = e.target.open) }, h('summary', {}, mine ? `Team board · ${inbox.team} is ${ordinal(mine.rank)}` : 'Team board'), teamBoard(st, inbox.team, true)),
    );
  }

  // Your share of the campaign's interviews, and how far you are. Shown on
  // the home page right under the greeting.
  function myGoal(inbox, st) {
    const s = inbox.scores && inbox.scores[st.campaignId];
    if (!s || !s.goal) return null;
    const done = s.goalDone || 0;
    const planned = s.goalPlanned || 0;
    const pct = Math.min(100, Math.round((done / s.goal) * 100));
    const pctPlanned = Math.min(100 - pct, Math.round((planned / s.goal) * 100));
    const left = Math.max(0, s.goal - done - planned);
    const line = done >= s.goal ? 'Goal reached. Thank you. Every extra interview helps the campaign along.' : left ? `${plural(left, 'more interview')} to plan${planned ? `, ${planned} already booked` : ''}.` : `The rest is booked: ${plural(planned, 'interview')} coming up.`;
    return h(
      'section',
      { class: 'my-goal', 'aria-label': 'Your interview goal' },
      h('span', { class: 'label' }, `Your goal for ${st.name}`),
      h('div', { class: 'big-num' }, String(done), h('span', {}, ` of ${plural(s.goal, 'interview')} done`)),
      h('div', { class: 'track two' }, h('i', { style: `width:${pct}%` }), pctPlanned ? h('b', { style: `width:${pctPlanned}%` }) : null),
      h('p', {}, line),
      h('p', { class: 'small faint' }, `${st.name} needs about ${(st.expectedByRound || {})[/team lead|joker/i.test(inbox.role || '') ? 'deepdive' : 'advisor'] || st.targetInterviews || '?'} ${/team lead|joker/i.test(inbox.role || '') ? 'deep dives' : 'advisor interviews'}, each with two interviewers. Shared evenly, this is your part. If everyone reaches theirs, we reach ${st.targetHires || 'our'} hires together.`),
    );
  }

  // The campaign at a glance for interviewers: hires, the week ahead, where candidates are.
  function campaignBlock(st) {
    const p = st.pipeline || {};
    const pct = st.targetHires ? Math.min(100, Math.round(((p.hired || 0) / st.targetHires) * 100)) : 0;
    return h(
      'section',
      { class: 'blk', 'aria-label': 'Campaign overview' },
      h('span', { class: 'label' }, `Our hiring goal · ${st.name}`),
      h('div', { class: 'big-num' }, `${p.hired || 0}`, h('span', {}, ` of ${st.targetHires || '?'} hired`)),
      h('div', { class: 'track' }, h('i', { style: `width:${pct}%` })),
      h('p', {}, `${plural(st.interviewsNext7 || 0, 'interview')} in the next 7 days`),
      h('details', { open: !!ui.ivPipeOpen, ontoggle: (e) => (ui.ivPipeOpen = e.target.open) }, h('summary', {}, 'Where candidates are'), campaignOverview(st)),
    );
  }

  function kpi(label, value, sub) {
    return h('div', { class: 'kpi' }, h('span', { class: 'small muted' }, label), h('b', {}, String(value)), sub ? h('span', { class: 'small faint' }, sub) : null);
  }

  function teamBoard(st, myTeam, compact) {
    const show = (i) => !compact || i < 4;
    return h(
      'section',
      { class: 'tpanel iv-card', 'aria-label': 'Team board' },
      h('h2', {}, 'Team board'),
      h(
        'div',
        { class: 'sheet-wrap' },
        h(
          'table',
          { class: 'x' },
          h('thead', {}, h('tr', {}, ['#', 'Team', 'Points per person', 'Interviews', 'Fair share', 'Avg reply', 'Feedback on time'].map((x, i) => (show(i) ? h('th', { class: i > 4 ? 'wide-only' : '' }, x) : null)))),
          h(
            'tbody',
            {},
            (st.teams || []).map((t) =>
              h(
                'tr',
                { class: t.team === myTeam ? 'sel' : '' },
                h('td', { class: 'mono' }, t.rank),
                h('td', { class: 'name' }, t.team, t.team === myTeam ? h('span', { class: 'faint' }, ' (you)') : null),
                h('td', { class: 'mono' }, t.pointsPerMember),
                h('td', { class: 'mono' }, t.done, t.upcoming ? h('span', { class: 'faint' }, ` +${t.upcoming}`) : null),
                show(4) ? h('td', { class: `mono ${t.done < t.fairShare - 1 ? 'warn-t' : ''}` }, t.fairShare) : null,
                show(5) ? h('td', { class: 'mono wide-only' }, hrs(t.avgReplyHours)) : null,
                show(6) ? h('td', { class: 'mono wide-only' }, t.feedbackOnTimePct === null ? '–' : `${t.feedbackOnTimePct}%`) : null,
              ),
            ),
          ),
        ),
      ),
      h('p', { class: 'small faint' }, compact ? 'Ranked by points per person, so small teams can win.' : 'Ranked by points per person, so small teams can win. Fair share is the interviews a team would have done if load were spread evenly.'),
    );
  }

  function campaignOverview(st) {
    const p = st.pipeline || {};
    const bars = [['In HR round', p.hr], ['Advisor round', p.advisor], ['Deep dive', p.deepdive], ['Hired', p.hired], ['Closed', p.closed]];
    const max = Math.max(1, ...bars.map((b) => b[1] || 0));
    const pct = st.targetHires ? Math.min(100, Math.round(((p.hired || 0) / st.targetHires) * 100)) : 0;
    return h(
      'section',
      { class: 'tpanel iv-card', 'aria-label': 'Campaign overview' },
      h('h2', {}, st.name),
      h('div', { class: 'row small muted' }, st.endDate ? `Runs until ${M.formatDay(st.endDate)}` : `Started ${M.formatDay(st.startDate)}`),
      h('div', {}, h('div', { class: 'row', style: 'justify-content:space-between' }, h('b', {}, `${p.hired || 0} of ${st.targetHires || '?'} hired`), h('span', { class: 'small muted' }, `${pct}%`)), h('div', { class: 'meter' }, h('i', { style: `width:${pct}%` }))),
      h('div', { class: 'kpis' }, kpi('Interviews done', st.interviewsDone, st.targetInterviews ? `of about ${st.targetInterviews}` : ''), kpi('Next 7 days', st.interviewsNext7, 'interviews')),
      h('div', { class: 'bars' }, bars.map(([label, n]) => h('div', { class: 'bar-row' }, h('span', { class: 'small' }, label), h('div', { class: 'meter thin' }, h('i', { style: `width:${Math.round(((n || 0) / max) * 100)}%` })), h('span', { class: 'mono small' }, n || 0)))),
      h('p', { class: 'small faint' }, 'Counts only. Candidate names are visible to their interviewers and HR.'),
    );
  }

  // Natalie's full scoreboard on the Campaign page.
  function adminScoreboard(camp) {
    const sb = scoresFor(camp);
    const st = statsFor(camp);
    return h(
      'div',
      { class: 'section gutter' },
      h('h2', {}, 'Scoreboard'),
      h('p', { class: 'small muted' }, 'Interviewers see the team board and only their own row, rank and interview goal. Goals split this campaign\'s expected interviews over the people in each round (two seats per interview), so they add up to at least what the campaign needs. This full list is for you.'),
      teamBoard(st, null),
      h(
        'details',
        { class: 'round-sum' },
        h('summary', {}, h('b', {}, 'Everyone’s scores'), h('span', { class: 'muted' }, ` · ${sb.people.length} people`)),
        h(
        'div',
        { class: 'sheet-wrap', style: 'border:1px solid var(--grid);border-radius:6px' },
        h(
          'table',
          { class: 'x' },
          h('thead', {}, h('tr', {}, ['#', 'Name', 'Team', 'Interviews / goal', 'Points', 'Interviews', 'Coming up', 'Avg reply', 'Feedback on time', 'Badges', ''].map((x) => h('th', {}, x)))),
          h(
            'tbody',
            {},
            sb.people.map((x) => {
              const p = personById(x.personId);
              return h('tr', {}, h('td', { class: 'mono' }, x.rank), h('td', { class: 'name' }, p ? p.name : '?'), h('td', { class: 'mono' }, x.team), h('td', { class: `mono ${x.goal && x.goalDone >= x.goal ? 'ok-t' : ''}` }, x.goal ? `${x.goalDone} / ${x.goal}${x.goalPlanned ? ` +${x.goalPlanned}` : ''}` : '–'), h('td', { class: 'mono' }, x.points), h('td', { class: 'mono' }, x.done), h('td', { class: 'mono' }, x.upcoming || ''), h('td', { class: 'mono' }, hrs(x.avgReplyHours)), h('td', { class: 'mono' }, x.feedbackDue ? `${x.feedbackOnTime}/${x.feedbackDue}` : '–'), h('td', { class: 'small' }, x.badges.join(', ')), h('td', {}, h('button', { class: 'link', onclick: () => setViewAs(x.personId) }, 'View as')));
            }),
          ),
        ),
      ),
      ),
    );
  }

  // ------------------------------------------------------------------
  // Feedback reports: everyone can send a screenshot and a note to the
  // developer. Stored in reports/{id}; editors read them in the Developer view.
  // ------------------------------------------------------------------
  const BUILD = '__BUILD__';
  const recentErrors = [];
  window.addEventListener('error', (e) => recentErrors.push(`${new Date().toISOString().slice(11, 19)} ${e.message}`.slice(0, 300)) && recentErrors.length > 8 && recentErrors.shift());
  window.addEventListener('unhandledrejection', (e) => recentErrors.push(`${new Date().toISOString().slice(11, 19)} ${(e.reason && (e.reason.message || e.reason.code)) || e.reason}`.slice(0, 300)) && recentErrors.length > 8 && recentErrors.shift());
  const REPORT_KINDS = [['broken', 'Something’s broken'], ['confusing', 'Something’s confusing'], ['idea', 'An idea']];
  const REPORT_STATUS = [['new', 'New'], ['seen', 'Seen'], ['fixing', 'Fixing'], ['fixed', 'Fixed'], ['wontfix', 'Won’t fix']];

  function loadScript(src) {
    return new Promise((res, rej) => {
      const el = document.createElement('script');
      el.src = src;
      el.onload = res;
      el.onerror = () => rej(new Error('could not load'));
      document.head.appendChild(el);
    });
  }
  async function captureScreen() {
    if (!window.html2canvas) await loadScript('https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js');
    const canvas = await window.html2canvas(document.documentElement, {
      backgroundColor: getComputedStyle(document.body).backgroundColor,
      scale: 1,
      logging: false,
      x: window.scrollX,
      y: window.scrollY,
      width: window.innerWidth,
      height: window.innerHeight,
      windowWidth: window.innerWidth,
      windowHeight: window.innerHeight,
      // html2canvas draws the inside of closed <details> too, so skip those (and the report button and toasts).
      ignoreElements: (el) => (el.classList && (el.classList.contains('report-btn') || el.classList.contains('toast'))) || (el.parentElement && el.parentElement.tagName === 'DETAILS' && !el.parentElement.open && el.tagName !== 'SUMMARY'),
    });
    const max = 1100;
    const k = Math.min(1, max / canvas.width);
    const out = document.createElement('canvas');
    out.width = Math.round(canvas.width * k);
    out.height = Math.round(canvas.height * k);
    out.getContext('2d').drawImage(canvas, 0, 0, out.width, out.height);
    return out.toDataURL('image/jpeg', 0.62);
  }

  function reportContext() {
    const iv = S.admin ? (ui.viewAs ? 'advisor/team lead (preview)' : 'admin') : 'advisor/team lead';
    const p = !S.admin && S.state.mine.inbox ? S.state.mine.inbox : ui.viewAs ? personById(ui.viewAs) : null;
    return {
      view: iv,
      page: S.admin && !ui.viewAs ? ui.view : 'my interviews',
      drawer: ui.candId ? 'candidate drawer open' : '',
      as: p ? `${p.name} (${p.team})` : '',
      campaign: campaign() ? campaign().name : '',
      mockDate: TODAY !== REAL_TODAY ? TODAY : '',
      build: BUILD,
      size: `${window.innerWidth}×${window.innerHeight}`,
      agent: navigator.userAgent.slice(0, 160),
      errors: recentErrors.slice(-5),
    };
  }

  async function openReport() {
    if (ui.reportBusy) return;
    ui.reportBusy = true;
    // Take the screenshot first, so it shows the screen without the dialog.
    const r = { kind: 'broken', what: '', expected: '', shot: null, include: true, busy: false, error: '' };
    try {
      r.shot = await captureScreen();
    } catch (e) {
      r.error = 'Couldn’t take a screenshot here. You can still send the report.';
      r.include = false;
    }
    ui.reportBusy = false;
    ui.report = r;
    rerender();
  }

  function reportFab() {
    if (!S || ui.report) return null;
    return h('button', { class: 'report-btn', onclick: openReport, disabled: !!ui.reportBusy, title: 'Send a screenshot and a note to the developer' }, ui.reportBusy ? 'Taking screenshot…' : 'Report');
  }

  function reportDialog() {
    const r = ui.report;
    if (!r) return null;
    const close = () => ((ui.report = null), rerender());
    const err = h('p', { class: 'err-line' }, r.error && !r.shot ? r.error : '');
    return h(
      'div',
      { class: 'dialog-wrap', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'report-title' },
      h(
        'div',
        { class: 'dialog report' },
        h('div', { class: 'top' }, h('h1', { id: 'report-title' }, 'Send a report'), h('button', { class: 'x', 'aria-label': 'Close', onclick: close }, '×')),
        h('p', { class: 'sub' }, 'It goes straight to the person building the app.'),
        h('div', { class: 'choices' }, REPORT_KINDS.map(([k, l]) => h('button', { class: 'choice', 'aria-pressed': r.kind === k, onclick: () => ((r.kind = k), rerender()) }, l))),
        h('label', { class: 'f' }, 'What happened?', h('textarea', { id: 'report-what', rows: 3, value: r.what, placeholder: 'What were you doing, and what went wrong or felt odd?', oninput: (e) => (r.what = e.target.value) })),
        h('details', { class: 'plus', open: !!r.expected || !!r.expectOpen, ontoggle: (e) => (r.expectOpen = e.target.open) }, h('summary', {}, '+ What did you expect? (optional)'), h('textarea', { id: 'report-expected', rows: 2, 'aria-label': 'What did you expect?', value: r.expected, oninput: (e) => (r.expected = e.target.value), style: 'width:100%' })),
        r.busy
          ? h('p', { class: 'muted' }, 'Taking a screenshot…')
          : r.shot
          ? h('div', { class: 'shot' }, h('img', { src: r.shot, alt: 'Screenshot of the app' }), h('label', { class: 'check' }, h('input', { type: 'checkbox', id: 'report-include', checked: r.include, onchange: (e) => (r.include = e.target.checked) }), h('span', {}, 'Include this screenshot', h('span', { class: 'muted' }, ' · it may show candidate names; only Natalie and the developer see reports.'))))
          : null,
        err,
        h(
          'div',
          { class: 'foot plain' },
          h('button', { class: 'quiet', onclick: close }, 'Cancel'),
          h(
            'button',
            {
              class: 'p',
              disabled: r.busy,
              onclick: () => {
                if (!r.what.trim()) return (err.textContent = 'Write a sentence about what happened.');
                const who = !S.admin && S.state.mine.inbox ? S.state.mine.inbox.name : '';
                const doc = { kind: r.kind, what: r.what.trim().slice(0, 3000), expected: r.expected.trim().slice(0, 2000), screenshot: r.include && r.shot ? r.shot : null, context: reportContext(), authorId: me || null, authorName: who, status: 'new', createdAt: new Date().toISOString(), mock: TODAY !== REAL_TODAY };
                act(async () => {
                  if (S.admin) await S.add('reports', doc);
                  else await saveReply({ replies: S.state.mine.replies || null }, { reports: { [S.uid('rp_')]: doc } });
                  ui.report = null;
                  rerender();
                }, 'Thanks. Your report is with the developer.');
              },
            },
            'Send report',
          ),
        ),
      ),
    );
  }

  // ---- Developer view ----
  function devView() {
    const list = [...S.state.reports].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    resolveNames([...new Set(list.map((x) => x.authorId).filter(Boolean))]);
    const filter = ui.devFilter || 'open';
    const shown = list.filter((x) => (filter === 'open' ? !['fixed', 'wontfix'].includes(x.status) : filter === 'all' ? true : x.status === filter));
    const count = (st) => list.filter((x) => x.status === st).length;
    return h(
      'div',
      { class: 'section gutter dev' },
      h('div', { class: 'head' }, h('div', {}, h('h1', {}, 'Reports'), h('p', {}, 'What people sent with the Report button, newest first. Copy one into Claude Code to fix it, then mark it fixed.'))),
      h(
        'div',
        { class: 'seg' },
        [['open', `Open (${list.length - count('fixed') - count('wontfix')})`], ['new', `New (${count('new')})`], ['fixed', `Fixed (${count('fixed')})`], ['all', `All (${list.length})`]].map(([k, l]) => h('button', { 'aria-pressed': filter === k, onclick: () => ((ui.devFilter = k), rerender()) }, l)),
      ),
      shown.length ? shown.map(reportCard) : h('div', { class: 'calm-empty' }, h('p', {}, list.length ? 'Nothing here.' : 'No reports yet. They arrive here when someone presses Report.')),
      h('p', { class: 'small faint' }, `This build: ${BUILD}`),
    );
  }
  function reportCard(x) {
    const who = x.authorName || (x.authorId && names[x.authorId]) || (x.authorId ? 'A colleague' : 'Test mode');
    const kind = (REPORT_KINDS.find((k) => k[0] === x.kind) || ['', 'Report'])[1];
    const c = x.context || {};
    const prompt = [
      `A user of the Flux interview scheduling app (repo: scheduling-assistant, a claude.ai artifact built from src/) sent this feedback report.`,
      `Kind: ${kind}`,
      `What happened: ${x.what}`,
      x.expected ? `What they expected: ${x.expected}` : '',
      `Where: ${c.view || ''} view, page "${c.page || ''}"${c.drawer ? `, ${c.drawer}` : ''}${c.as ? `, seeing it as ${c.as}` : ''}, campaign "${c.campaign || ''}"${c.mockDate ? `, mock date ${c.mockDate}` : ''}`,
      `Build: ${c.build || ''} · window ${c.size || ''} · ${c.agent || ''}`,
      c.errors && c.errors.length ? `Recent errors:\n${c.errors.join('\n')}` : 'No script errors were recorded.',
      x.screenshot ? 'A screenshot is attached to the report in the app (Developer view).' : '',
      '',
      'Find the cause in the code, fix it, add or adjust a test, and explain the change in one paragraph.',
    ]
      .filter((l) => l !== '')
      .join('\n');
    return h(
      'article',
      { class: 'report-card' },
      h(
        'div',
        { class: 'row', style: 'justify-content:space-between;align-items:flex-start' },
        h('div', {}, h('b', {}, kind), h('span', { class: 'muted' }, ` · ${who} · ${M.formatDay((x.createdAt || '').slice(0, 10))} ${(x.createdAt || '').slice(11, 16)}`), x.mock ? h('span', { class: 'chip warn' }, 'mock') : null),
        h('select', { 'aria-label': 'Status', id: `rep-status-${x.id}`, onchange: (e) => act(() => S.update('reports', x.id, { status: e.target.value, statusAt: new Date().toISOString() }), 'Status saved') }, REPORT_STATUS.map(([k, l]) => h('option', { value: k, selected: (x.status || 'new') === k }, l))),
      ),
      h('p', { class: 'report-what' }, x.what),
      x.expected ? h('p', { class: 'muted' }, `Expected: ${x.expected}`) : null,
      h('p', { class: 'small faint' }, [c.view, c.page, c.as, c.campaign, c.mockDate ? `mock ${c.mockDate}` : '', c.size, c.build].filter(Boolean).join(' · ')),
      c.errors && c.errors.length ? h('pre', { class: 'small err-pre' }, c.errors.join('\n')) : null,
      x.screenshot ? h('a', { href: '#', class: 'shot', onclick: (e) => (e.preventDefault(), (ui.bigShot = ui.bigShot === x.id ? null : x.id), rerender()) }, h('img', { src: x.screenshot, alt: 'Screenshot sent with the report', class: ui.bigShot === x.id ? 'big' : '' })) : null,
      h('div', { class: 'row' }, h('button', { onclick: (e) => copyText(prompt, e.target) }, 'Copy for Claude Code'), h('button', { class: 'link danger', onclick: () => act(() => S.remove('reports', x.id), 'Report deleted') }, 'Delete')),
    );
  }

  // ------------------------------------------------------------------
  // Welcome card: shown once per person; "I'm in" is saved to members/{userId}
  // ------------------------------------------------------------------
  const WELCOME = {
    en: {
      title: 'Welcome to Flux Interviews',
      more: 'What’s a Claude app, and how do I give feedback?',
      body: [
        'Flux Partners is small, and our people are everything, including the people we hire next. We want to find them ourselves instead of leaning on expensive agencies, and that only works if interviewing runs smoothly for you.',
        'This app is our first step. It spreads interviews fairly across teams, gives you notice when plans change, and gives you a short brief on each candidate before you walk in. You can keep answering in Outlook if you prefer.',
        'This is a Claude app: a small tool built for us that runs inside Claude. Working this way is new for all of us, so your feedback matters. Whenever something is broken, confusing or could be better, press Report (top right). It sends a screenshot and your note straight to the person building the app, and we improve it for everyone.',
      ],
      privacy: 'Candidate details are only visible to the people interviewing them and to HR.',
      ok: 'I’m in',
      later: 'Not now',
      other: 'Nederlands',
    },
    nl: {
      title: 'Welkom bij Flux Interviews',
      more: 'Wat is een Claude-app, en hoe geef ik feedback?',
      body: [
        'Flux Partners is klein, en onze mensen zijn alles, ook de mensen die we hierna aannemen. We willen ze zelf vinden in plaats van te leunen op dure bureaus, en dat lukt alleen als interviewen voor jou soepel loopt.',
        'Deze app is onze eerste stap. Hij verdeelt interviews eerlijk over de teams, laat het je op tijd weten als plannen veranderen, en geeft je voor elk gesprek een korte brief over de kandidaat. Je kunt ook gewoon in Outlook blijven reageren.',
        'Dit is een Claude-app: een kleine tool, voor ons gebouwd, die in Claude draait. Op deze manier werken is voor ons allemaal nieuw, dus jouw feedback telt. Is er iets kapot, onduidelijk of kan het beter? Druk op Report (rechtsboven). Dan gaan een screenshot en jouw toelichting direct naar degene die de app bouwt, en verbeteren we hem voor iedereen.',
      ],
      privacy: 'Kandidaatgegevens zijn alleen zichtbaar voor de mensen die hen interviewen en voor HR.',
      ok: 'Ik doe mee',
      later: 'Niet nu',
      other: 'English',
    },
  };
  // ui.welcome: null (hidden) or { memberId, name?, mock? }
  async function checkWelcome() {
    const id = me || 'local';
    if (store(`flux.welcomed.${id}`)) return;
    let doc = null;
    try {
      doc = await S.get('members', id);
    } catch (e) {
      doc = null;
    }
    if (doc && doc.acceptedAt) {
      store(`flux.welcomed.${id}`, '1');
      return;
    }
    ui.welcome = { memberId: id };
    rerender();
  }
  function welcomeCard() {
    const w = ui.welcome;
    if (!w) return null;
    const lang = ui.welcomeLang || (/^nl\b/i.test(navigator.language || '') ? 'nl' : 'en');
    const t = WELCOME[lang];
    const close = () => ((ui.welcome = null), rerender());
    const accept = () =>
      act(async () => {
        await S.set('members', w.memberId, { acceptedAt: new Date().toISOString(), lang, ...(w.mock ? { mock: true } : {}) });
        if (!w.mock) store(`flux.welcomed.${w.memberId}`, '1');
        close();
      }, w.mock ? `${w.name} joined (mock)` : 'Welcome aboard');
    return h(
      'div',
      { class: 'dialog-wrap', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'welcome-title' },
      h(
        'div',
        { class: 'dialog welcome' },
        h('div', { class: 'top' }, h('span', {}, 'Flux Partners'), h('button', { class: 'link', onclick: () => ((ui.welcomeLang = lang === 'en' ? 'nl' : 'en'), rerender()) }, t.other)),
        h('h1', { id: 'welcome-title' }, `${t.title}.`),
        w.mock ? h('p', { class: 'warn-line' }, `Mock: this is what ${w.name} sees the first time they open the app.`) : null,
        h('p', { class: 'lead' }, t.body[0]),
        h('p', { class: 'lead soft' }, t.body[1]),
        h('details', { class: 'plus' }, h('summary', {}, `${t.more} ▸`), h('p', { class: 'lead soft' }, t.body[2])),
        h('div', { class: 'foot' }, h('span', { class: 'note' }, t.privacy), h('button', { class: 'quiet', onclick: close }, t.later), h('button', { class: 'p', onclick: accept }, t.ok)),
      ),
    );
  }
  const memberOf = (accountId) => accountId && S.state.members.find((m) => m.id === accountId && m.acceptedAt);

  // ------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------
  function route() {
    const v = (location.hash || '#run').slice(1);
    ui.view = ['run', 'availability', 'roster', 'campaign', 'metrics'].includes(v) ? v : 'run';
    rerender();
  }
  window.addEventListener('hashchange', route);

  async function boot() {
    S = await window.FluxStore.connect(
      () => {
        render();
        scheduleSync();
      },
      (coll, err) => !['members', 'inbox', 'replies'].includes(coll) && toast(`Couldn’t load ${coll}: ${err.code}`),
    );
    try {
      if (window.claude && window.claude.use) sample = await window.claude.use('sample');
    } catch (e) {
      sample = null;
    }
    try {
      if (S.user && S.user.id) me = await S.user.id();
    } catch (e) {
      me = null;
    }
    route();
    checkWelcome();
  }
  window.FluxApp = { startDraft: (...a) => startDraft(...a), state: () => S, ui };
  boot();
})();
