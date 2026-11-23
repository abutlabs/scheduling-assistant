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
  const ROOMS = ['Room 1', 'Room 2'];

  // ------------------------------------------------------------------
  // Tiny DOM helper
  // ------------------------------------------------------------------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
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
  const cstate = (c) => M.candidateState(c, TODAY);
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
    toast: null,
    busy: {},
    error: null,
  };
  let sample = null;

  const people = () => [...S.state.people].sort((a, b) => a.name.localeCompare(b.name));
  const campaigns = () => S.state.campaigns.filter((c) => !c.archived).sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
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
    root.replaceChildren(...[topBar(), banner(), h('main', {}, view()), drawer(), sidecar(), ui.toast ? h('div', { class: 'toast', role: 'status' }, ui.toast) : null].flat().filter(Boolean));
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
    const cands = candidates();
    const nav = [
      ['run', 'Run view', cands.filter((x) => cstate(x).status === 'open').length],
      ['availability', 'Availability', null],
      ['roster', 'Roster', S.state.people.filter((p) => p.active !== false).length],
      ['campaign', 'Campaign', null],
    ];
    const f = M.funnel(cands);
    return h(
      'header',
      { class: 'bar gutter' },
      h('div', { class: 'brand' }, h('i'), 'Flux interviews'),
      h('nav', {}, nav.map(([k, label, n]) => h('a', { href: `#${k}`, 'aria-current': ui.view === k ? 'page' : null }, label, n ? h('span', { class: 'n' }, n) : null))),
      c
        ? h(
            'div',
            { class: 'camp' },
            h(
              'select',
              {
                'aria-label': 'Campaign',
                id: 'campaign-pick',
                onchange: (e) => {
                  ui.campaignId = e.target.value;
                  store('flux.campaign', ui.campaignId);
                  rerender();
                },
              },
              campaigns().map((x) => h('option', { value: x.id, selected: x.id === c.id }, x.name)),
            ),
            h('span', {}, `${f.hired} of ${c.targetHires || '?'} hired`),
            h('button', { class: ui.mockOpen ? 'p' : '', 'aria-pressed': !!ui.mockOpen, title: 'Test tool: act as colleagues, fake replies, change the date', onclick: () => ((ui.mockOpen = !ui.mockOpen), rerender()) }, TODAY !== REAL_TODAY ? `Mock · ${M.formatDay(TODAY)}` : 'Mock'),
          )
        : null,
    );
  }

  function banner() {
    if (S.mode === 'db') return null;
    return h('div', { class: 'banner gutter' }, 'Test mode: data is kept in this browser only. Open the published page on claude.ai, signed in, to share it with the team.');
  }

  function view() {
    if (!campaign()) return setupView();
    if (ui.view === 'availability') return availabilityView();
    if (ui.view === 'roster') return rosterView();
    if (ui.view === 'campaign') return campaignView();
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
      h('div', { class: 'head' }, h('div', {}, h('h1', {}, 'Set up your first campaign'), h('p', {}, 'A campaign is one hiring drive with its own rounds, targets and availability polls. Candidates, holds and metrics all hang off it.'))),
      campaignForm(null),
    );
  }

  // ------------------------------------------------------------------
  // Run view: to-do list + holds/summary + step matrix
  // ------------------------------------------------------------------
  const KIND = {
    hr_done: ['Record', ''],
    reject_call_hr: ['Call', 'accent'],
    avail_asked_r2: ['Ask', 'accent'],
    avail_received_r2: ['Match', 'accent'],
    advisor_booked: ['Book', 'accent'],
    advisor_done: ['Record', ''],
    result_call_r2: ['Call', 'accent'],
    avail_received_final: ['Match', 'accent'],
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
        reason = `Day ${s.clock.day} of 7: the ${s.clock.round === 'advisor' ? 'advisor interview' : 'deep dive'} deadline was ${M.formatDay(s.clock.deadline)}.`;
      } else if (s.clock && (s.clock.state === 'urgent' || s.clock.state === 'booked_late')) {
        group = 'today';
        t = 'warn';
        reason = s.clock.state === 'booked_late' ? `Booked for ${M.formatDay(s.clock.interviewDate)}, after the 7-day deadline (${M.formatDay(s.clock.deadline)}).` : `Day ${s.clock.day} of 7, deadline ${M.formatDay(s.clock.deadline)}.`;
      } else if (s.clock && s.clock.state === 'booked' && s.clock.interviewDate <= TODAY) {
        group = 'today';
        reason = s.clock.interviewDate === TODAY ? 'The interview is today.' : `The interview was on ${M.formatDay(s.clock.interviewDate)}.`;
      } else if (s.clock && s.clock.state === 'booked') {
        group = 'later';
        reason = `Interview booked for ${M.formatDay(s.clock.interviewDate)}.`;
      } else if (/call|avail_asked|reject/.test(s.next)) {
        group = 'today';
        reason = s.clock ? `Day ${s.clock.day} of 7.` : 'Every candidate hears back, and the call is logged.';
      } else if (s.next === 'hr_done') {
        const d = c.hrDate;
        group = d && d <= TODAY ? 'today' : 'later';
        reason = d ? `HR interview ${d === TODAY ? 'today' : d < TODAY ? `was on ${M.formatDay(d)}` : `on ${M.formatDay(d)}`}.` : 'No HR interview date yet.';
      } else {
        reason = s.clock ? `Day ${s.clock.day} of 7, deadline ${M.formatDay(s.clock.deadline)}.` : '';
      }
      const inv = roundInvites(c);
      if (inv.state.complete && s.next.endsWith('_booked')) continue;
      if (inv.list.length && /avail_received|_booked$/.test(s.next) && !inv.state.complete && k !== 'Overdue') {
        k = 'Waiting';
        t = t === 'warn' ? 'warn' : '';
        reason = `${inv.state.accepted.length} of 2 accepted, ${inv.state.pending.length} waiting. ${reason}`;
      }
      if (s.skipped.length) reason += ` ${plural(s.skipped.length, 'earlier step')} not recorded.`;
      items.push({ group, kind: k, tone: t, who: c.name, text: `${s.prompt}. ${reason}`.trim(), btn: k === 'Overdue' ? 'Open' : kind, cand: c.id, step: s.next, sortKey: s.clock ? s.clock.daysLeft ?? 99 : 50 });
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

  function runView() {
    const items = todoItems();
    const groups = [
      ['overdue', 'Overdue'],
      ['today', 'Today'],
      ['later', 'Coming up'],
    ];
    const todo = h(
      'section',
      { class: 'tpanel', 'aria-label': 'To do' },
      h('div', { class: 'ph' }, 'To do', h('span', { class: 'faint' }, items.length ? `${items.length} · deadlines first` : '')),
      items.length
        ? groups.map(([g, label]) => {
            const list = items.filter((i) => i.group === g);
            if (!list.length) return null;
            return [
              h('div', { class: 'grp' }, label),
              list.map((i) =>
                h(
                  'div',
                  { class: 'act' },
                  h('span', { class: `kind k-${i.tone}` }, i.kind),
                  h('div', {}, h('b', {}, i.who), h('p', {}, i.text)),
                  h(
                    'button',
                    {
                      class: i.tone === 'accent' || i.tone === 'bad' ? 'p' : '',
                      onclick: () => {
                        if (i.go) location.hash = i.go;
                        else if (i.invite) releaseInvite(i.invite, i.why);
                        else if (i.prefill) {
                          const c = S.state.candidates.find((x) => x.id === i.cand);
                          const r = roundInvites(c);
                          ui.candId = c.id;
                          prefillBooking(c, i.step, r.list, r.state);
                        } else openCandidate(i.cand, i.step);
                      },
                    },
                    i.btn,
                  ),
                ),
              ),
            ];
          })
        : h('div', { class: 'empty' }, h('p', {}, 'Nothing to do right now. Add a candidate after their HR interview and the next steps appear here.'), h('button', { class: 'p', onclick: () => openCandidate('new') }, '+ Candidate')),
    );

    const c = campaign();
    const f = M.funnel(candidates());
    const target = c.targetHires || 0;
    const statRow = (label, n, of) => h('div', { class: 'stat' }, h('span', {}, label), h('b', {}, of ? `${n} / ${of}` : n), of ? h('div', { class: 'bar-track' }, h('i', { style: `width:${Math.min(100, (n / of) * 100)}%` })) : null);
    const side = h(
      'section',
      { class: 'tpanel', 'aria-label': 'Campaign progress' },
      h('div', { class: 'ph' }, 'Campaign progress', h('span', { class: 'faint' }, c.name)),
      statRow('Candidates', f.total),
      statRow('Passed HR', f.passedHr),
      statRow('Passed advisor round', f.passedAdvisor),
      statRow('Hired', f.hired, target || null),
      h('div', { class: 'stat' }, h('span', { class: 'faint' }, 'Holds and interviewer invites arrive with matching and Outlook (phases 2 and 3).')),
    );

    return [
      h('div', { class: 'section band gutter' }, h('div', { class: 'cols' }, todo, side)),
      h(
        'div',
        { class: 'section' },
        h(
          'div',
          { class: 'head gutter' },
          h('div', { class: 'row' }, h('h2', {}, 'Candidates'), h('button', { class: 'p', onclick: () => openCandidate('new') }, '+ Candidate'), filterButtons()),
          h('p', { class: 'small' }, 'Orange = next step. Click any cell to record or correct it. Clock = days since availability was asked (target 7).'),
        ),
        matrix(),
      ),
    ];
  }

  function filterButtons() {
    const all = candidates().map((c) => cstate(c).status === 'open');
    const open = all.filter(Boolean).length;
    return [
      ['open', `Open (${open})`],
      ['closed', `Closed (${all.length - open})`],
      ['all', `All (${all.length})`],
    ].map(([k, label]) =>
      h(
        'button',
        {
          'aria-pressed': ui.candFilter === k,
          class: ui.candFilter === k ? 'p' : '',
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

  function candidateDetail(c) {
    if (!c) return h('p', { class: 'muted' }, 'This candidate was removed.');
    const s = cstate(c);
    const clk = s.clock && s.clock.state !== 'met' ? s.clock : null;
    const header = h(
      'div',
      { style: 'display:flex;flex-direction:column;gap:4px;padding-right:30px' },
      h('div', { class: 'row', style: 'justify-content:space-between' }, h('h2', {}, c.name), clk ? h('span', { class: `chip ${clk.state === 'overdue' ? 'bad' : clk.daysLeft <= 2 ? 'warn' : 'accent'}` }, clk.state === 'booked' ? `booked ${M.formatDay(clk.interviewDate)}` : `day ${Math.max(0, clk.day)} of 7`) : h('span', { class: `chip ${s.status === 'hired' ? 'good' : s.status === 'open' ? 'accent' : ''}` }, s.status === 'open' ? 'Open' : M.OUTCOME_LABELS[s.status] || s.status)),
      h('div', { class: 'contact' }, c.email ? h('span', {}, c.email) : null, c.phone ? h('span', {}, c.phone) : null, c.hrDate ? h('em', {}, `HR interview ${M.formatDay(c.hrDate)}`) : null),
      c.notes ? h('p', { class: 'small muted', style: 'white-space:pre-wrap' }, c.notes) : null,
    );
    const keys = s.rejectedAt === 'hr' ? ['hr_done', 'reject_call_hr', ...M.STEPS.slice(1).map((x) => x.key)] : M.STEPS.map((x) => x.key);
    const steps = h(
      'div',
      { class: 'steps' },
      keys.map((key) => {
        const step = M.STEP_BY_KEY[key];
        const e = s.done[key];
        const onPath = s.path.includes(key);
        let cls = 'up';
        if (e) cls = e.outcome === 'reject' ? 'done rej' : 'done';
        else if (s.next === key) cls = 'next';
        else if (s.skipped.includes(key)) cls = 'skip';
        else if (!onPath) cls = 'na';
        const isOpen = ui.openStep === key;
        let when = '';
        if (e) when = M.formatDay(e.at.slice(0, 10));
        else if (s.next === key) when = 'next';
        else if (s.skipped.includes(key)) when = 'not recorded';
        else if (!onPath) when = 'n/a';
        return h(
          'div',
          { class: `${cls}${isOpen ? ' open' : ''}` },
          h(
            'button',
            {
              class: 'st',
              'aria-expanded': isOpen,
              onclick: () => {
                ui.openStep = isOpen ? null : key;
                rerender();
              },
            },
            h('i', {}, e ? (e.outcome === 'reject' ? '✗' : '✓') : step.n),
            h('span', {}, step.label, e && e.outcome ? ` · ${M.OUTCOME_LABELS[e.outcome]}` : ''),
            h('span', { class: 'when' }, when),
          ),
          e && !isOpen ? entryDetail(e) : null,
          isOpen ? stepForm(c, key, e) : null,
        );
      }),
    );
    return h(
      'div',
      { style: 'display:flex;flex-direction:column;gap:14px' },
      header,
      s.prompt ? h('p', { class: 'small' }, h('b', {}, 'Next: '), s.prompt) : null,
      requestsSection(c, s),
      steps,
      briefPanel(c, s),
      notesSection(c),
      candidateAdmin(c, s),
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
    const round = step.round === 'advisor' ? campaign().rounds[0] : step.round === 'deepdive' ? campaign().rounds[1] : null;
    const prev = existing || {};
    const pd = prev.data || {};
    // Keep what's been typed across re-renders (another note saved, data arriving).
    ui.forms = ui.forms || {};
    const fk = `${c.id}:${key}:${prev.id || 'new'}`;
    if (!existing && !ui.forms[fk] && key.endsWith('_booked')) {
      const r = roundInvites(c, key === 'deepdive_booked' ? 'deepdive' : 'advisor');
      if (r.state.complete) {
        const slot = r.list.find((i) => r.state.pair.includes(i.personId)) || r.list[0];
        ui.forms[fk] = { at: TODAY, outcome: null, note: '', availability: '', slots: [], slotDate: slot.slotDate, time: slot.time || '', room: slot.room || ROOMS[0], interviewers: [...r.state.pair], reason: '' };
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
      room: pd.room || ROOMS[0],
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
      if (step.fields && step.fields.includes('slot')) parts.push(slotFields(f, round, draw));
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

  function slotFields(f, round, draw) {
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
        h('label', { class: 'f' }, 'Room', h('select', { id: 'sf-room', onchange: (e) => (f.room = e.target.value) }, ROOMS.map((r) => h('option', { selected: f.room === r }, r)))),
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

  function releaseInvite(inv, why) {
    return act(() => S.update('invites', inv.id, { status: 'released', releaseReason: why || 'pair_filled', releasedAt: nowIso(), noticeDays: M.daysBetween(TODAY, inv.slotDate) }), `${pname(inv.personId)} released`);
  }
  function answerInvite(inv, status, via, reason) {
    return act(() => S.update('invites', inv.id, { status, respondedAt: nowIso(), via: via || 'outlook', declineReason: reason || '' }), `${pname(inv.personId)}: ${status}`);
  }

  function requestsSection(c, s) {
    if (s.status !== 'open' || s.stage === 'hr') return null;
    const { round, list, state } = roundInvites(c);
    const bookedKey = round === 'deepdive' ? 'deepdive_booked' : 'advisor_booked';
    const roundObj = round === 'deepdive' ? campaign().rounds[1] : campaign().rounds[0];
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
        ? h('div', { class: 'row', style: 'justify-content:space-between;padding:8px 10px' }, h('span', { class: 'small' }, h('b', {}, 'Pair complete: '), state.pair.map(pname).join(' + ')), !s.done[bookedKey] ? h('button', { class: 'p', onclick: () => prefillBooking(c, bookedKey, list, state) }, 'Book with this pair') : h('span', { class: 'chip good' }, 'Booked'))
        : h('p', { class: 'small', style: 'padding:8px 10px' }, `${M.formatDay(list[0].slotDate)} ${list[0].time || ''}, ${list[0].room || ''}: ${state.accepted.length} of ${roundObj.interviewers} accepted, ${state.pending.length} waiting${state.shortBy ? `. Ask ${plural(state.shortBy, 'more person', 'more people')}.` : '.'}`)
      : null;
    return h(
      'section',
      { class: 'tpanel', 'aria-label': 'Interviewer requests' },
      h('div', { class: 'ph' }, `Interviewer requests · ${roundObj.name}`, h('span', { class: 'faint' }, 'replies come from Outlook or the app')),
      head,
      rows,
      !state.complete ? askForm(c, round, roundObj, list) : null,
    );
  }

  function prefillBooking(c, key, list, state) {
    ui.forms = ui.forms || {};
    const slot = list.find((i) => state.pair.includes(i.personId)) || list[0];
    ui.forms[`${c.id}:${key}:new`] = { at: TODAY, outcome: null, note: '', availability: '', slots: [], slotDate: slot.slotDate, time: slot.time || '', room: slot.room || ROOMS[0], interviewers: [...state.pair], reason: '' };
    ui.openStep = key;
    rerender();
  }

  function askForm(c, round, roundObj, list) {
    const key = `ask:${c.id}:${round}`;
    ui.forms = ui.forms || {};
    const asked = new Set(list.filter((i) => i.status !== 'cancelled').map((i) => i.personId));
    const f = ui.forms[key] || (ui.forms[key] = { open: !list.length, slotDate: list[0] ? list[0].slotDate : '', time: list[0] ? list[0].time : '10:00', room: list[0] ? list[0].room : ROOMS[0], picked: [] });
    const box = h('div', { style: 'border-top:1px solid var(--line);padding:8px 10px;display:flex;flex-direction:column;gap:8px' });
    const role = roundObj.role;
    const load = interviewLoad();
    function candidatesFor() {
      const snaps = availSources();
      return people()
        .filter((p) => p.active !== false && (M.personHasRole(p, role) || (role === 'teamlead' && (p.roles || []).includes('joker'))) && !asked.has(p.id))
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
          h('label', { class: 'f' }, 'Room', h('select', { id: `ask-room-${c.id}`, onchange: (e) => (f.room = e.target.value) }, ROOMS.map((r) => h('option', { selected: f.room === r }, r)))),
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
                act(async () => {
                  for (const id of f.picked) await S.add('invites', { campaignId: c.campaignId, candidateId: c.id, round, personId: id, slotDate: f.slotDate, time: f.time, room: f.room, status: 'pending', sentAt: nowIso(), via: 'outlook', mock: !!c.mock });
                  ui.forms[key] = { ...f, open: false, picked: [] };
                  ui.inviteText = { candId: c.id, text: inviteText(c, round, f) };
                  rerender();
                }, `${plural(f.picked.length, 'request')} created`),
            },
            `Ask ${f.picked.length || ''}`.trim(),
          ),
        ),
      );
    }
    draw();
    const txt = ui.inviteText && ui.inviteText.candId === c.id ? ui.inviteText.text : null;
    return [
      box,
      txt
        ? h(
            'div',
            { style: 'border-top:1px solid var(--line);padding:8px 10px;display:flex;flex-direction:column;gap:6px' },
            h('div', { class: 'row', style: 'justify-content:space-between' }, h('b', { class: 'small' }, 'Invite text, ready to send from Outlook'), h('button', { onclick: (e) => copyText(txt, e.target) }, 'Copy')),
            h('pre', { class: 'small', style: 'white-space:pre-wrap;margin:0;font-family:var(--font-ui);background:var(--s1);padding:8px;border-radius:4px' }, txt),
          )
        : null,
    ];
  }

  function inviteText(c, round, f) {
    const what = round === 'deepdive' ? 'a deep dive (final round)' : 'an advisor interview';
    return `Subject: Hold: ${what} on ${M.formatDay(f.slotDate)} ${f.time}, ${f.room}\n\nHi,\n\nCould you hold ${M.formatDay(f.slotDate)} from ${f.time} for ${what} with a trainee candidate (${first(c)})? It's 1 hour, in person, with a colleague from another team.\n\nPlease accept or decline this invite. If more people accept than we need, I'll release the extra slot with as much notice as I can.\n\nThanks,\nNatalie`;
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
  function sidecar() {
    if (!ui.mockOpen || !campaign()) return null;
    const ps = people().filter((p) => p.active !== false);
    const asId = ui.actAs && personById(ui.actAs) ? ui.actAs : null;
    const me2 = asId ? personById(asId) : null;
    const panel = h(
      'aside',
      { class: 'sidecar', 'aria-label': 'Mock sidecar' },
      h('div', { class: 'row', style: 'justify-content:space-between' }, h('h2', {}, 'Mock sidecar'), h('button', { class: 'x', 'aria-label': 'Close mock sidecar', onclick: () => ((ui.mockOpen = false), rerender()) }, '×')),
      h('p', { class: 'small muted' }, 'A test tool. Act as a colleague, answer requests, leave feedback and move the date, to see how the flow feels. Everything it creates is marked as mock.'),
      h(
        'section',
        { class: 'mock-sec' },
        h('h3', {}, 'Date'),
        h(
          'div',
          { class: 'row' },
          h('span', { class: 'small' }, 'Pretend today is'),
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
          h('button', { onclick: () => shiftDay(1) }, '+1 day'),
          TODAY !== REAL_TODAY ? h('button', { class: 'link', onclick: () => shiftDay(0) }, 'Back to today') : null,
        ),
      ),
      h(
        'section',
        { class: 'mock-sec' },
        h('h3', {}, 'Act as a colleague'),
        h(
          'select',
          { id: 'mock-actas', onchange: (e) => ((ui.actAs = e.target.value || null), rerender()) },
          h('option', { value: '' }, 'Choose someone…'),
          ps.map((p) => h('option', { value: p.id, selected: p.id === asId }, `${p.name} (${p.team}, ${roleLabel(p)})${p.accountId ? '' : ' · no account linked'}`)),
        ),
        me2 ? actAsPanel(me2) : null,
      ),
      h(
        'section',
        { class: 'mock-sec' },
        h('h3', {}, 'Everyone at once'),
        h('div', { class: 'row' }, h('button', { onclick: simulateReplies }, 'Answer all waiting requests'), h('span', { class: 'small muted' }, 'Accepts when the poll says they’re free, declines otherwise.')),
      ),
      h(
        'section',
        { class: 'mock-sec' },
        h('h3', {}, 'Demo data'),
        h('div', { class: 'row' }, h('button', { onclick: loadDemo }, 'Load demo candidates'), h('button', { class: 'danger', onclick: clearMock }, 'Clear mock data'), h('button', { onclick: linkAllMock }, 'Give everyone a mock account')),
      ),
    );
    return panel;
  }

  function shiftDay(n) {
    TODAY = n ? M.addDays(TODAY, n) : REAL_TODAY;
    store('flux.mockToday', TODAY === REAL_TODAY ? '' : TODAY);
    rerender();
  }

  function actAsPanel(p) {
    const mine = S.state.invites.filter((i) => i.personId === p.id);
    const cand = (i) => S.state.candidates.find((c) => c.id === i.candidateId);
    const pending = mine.filter((i) => i.status === 'pending' && cand(i));
    const accepted = mine.filter((i) => i.status === 'accepted' && cand(i));
    const released = mine.filter((i) => i.status === 'released');
    const reasons = (ui.mockReasons = ui.mockReasons || {});
    return h(
      'div',
      { style: 'display:flex;flex-direction:column;gap:8px' },
      !p.accountId ? h('p', { class: 'warn-line' }, `${p.name} has no Claude account linked yet, so in real life they would only get the Outlook invite.`) : null,
      h('b', { class: 'small' }, `Requests for ${p.name}`),
      pending.length
        ? pending.map((i) =>
            h(
              'div',
              { class: 'mock-card' },
              h('div', { class: 'small' }, h('b', {}, `${M.formatDay(i.slotDate)} ${i.time || ''}`), ` · ${i.room || ''} · ${i.round === 'deepdive' ? 'deep dive' : 'advisor interview'} with ${first(cand(i))}`),
              h('input', { id: `mock-reason-${i.id}`, placeholder: 'Reason if declining (optional)', value: reasons[i.id] || '', oninput: (e) => (reasons[i.id] = e.target.value) }),
              h('div', { class: 'row' }, h('button', { class: 'p', onclick: () => answerInvite(i, 'accepted', 'mock') }, 'Accept'), h('button', { onclick: () => answerInvite(i, 'declined', 'mock', reasons[i.id]) }, 'Decline')),
            ),
          )
        : h('p', { class: 'small muted' }, 'Nothing waiting.'),
      accepted.length ? h('b', { class: 'small' }, 'Interviews') : null,
      accepted.map((i) => {
        const c = cand(i);
        const k = `fb:${i.id}`;
        const f = (ui.forms = ui.forms || {})[k] || (ui.forms[k] = { text: '', lean: 'pass' });
        const done = i.slotDate <= TODAY;
        const sent = S.state.notes.filter((n) => n.candidateId === c.id && n.authorPersonId === p.id && n.round === i.round).length;
        return h(
          'div',
          { class: 'mock-card' },
          h('div', { class: 'row small', style: 'justify-content:space-between' }, h('span', {}, h('b', {}, c.name), ` · ${M.formatDay(i.slotDate)} ${i.time || ''}`), h('button', { class: 'link', onclick: () => openCandidate(c.id) }, 'Open brief')),
          sent ? h('span', { class: 'chip good', style: 'align-self:flex-start' }, `✓ ${plural(sent, 'feedback note')} sent`) : null,
          done
            ? [
                h('textarea', { id: `mock-fb-${i.id}`, placeholder: `Feedback from ${p.name} after the interview`, value: f.text, oninput: (e) => (f.text = e.target.value) }),
                h(
                  'div',
                  { class: 'row' },
                  h('select', { id: `mock-lean-${i.id}`, onchange: (e) => (f.lean = e.target.value) }, [['pass', 'Leaning pass'], ['unsure', 'Unsure'], ['reject', 'Leaning no']].map(([v, l]) => h('option', { value: v, selected: f.lean === v }, l))),
                  h(
                    'button',
                    {
                      class: 'p',
                      onclick: () => {
                        if (!f.text.trim()) return;
                        const lean = { pass: 'Leaning pass', unsure: 'Unsure', reject: 'Leaning no' }[f.lean];
                        act(async () => {
                          await S.add('notes', { candidateId: c.id, campaignId: c.campaignId, round: i.round, kind: 'feedback', text: `${lean}. ${f.text.trim()}`, authorId: null, authorPersonId: p.id, authorLabel: p.name, mock: true, createdAt: nowIso() });
                          ui.forms[k] = { text: '', lean: 'pass' };
                          rerender();
                        }, 'Feedback added');
                      },
                    },
                    'Send feedback',
                  ),
                ),
              ]
            : h('p', { class: 'small muted' }, `Feedback opens on the interview day. Use “+1 day” above to get there.`),
        );
      }),
      released.length ? h('p', { class: 'small muted' }, `Released from ${plural(released.length, 'slot')}: ${released.map((i) => M.RELEASE_REASONS[i.releaseReason] || 'released').join('; ')}.`) : null,
    );
  }

  function simulateReplies() {
    const snaps = availSources();
    act(async () => {
      let n = 0;
      for (const i of S.state.invites.filter((x) => x.status === 'pending')) {
        const c = S.state.candidates.find((x) => x.id === i.candidateId);
        if (!c) continue;
        const role = i.round === 'deepdive' ? 'teamlead' : 'advisor';
        const a = M.availabilityOn(snaps, i.personId, role, i.slotDate);
        const half = Number((i.time || '10').slice(0, 2)) < 12 ? 'am' : 'pm';
        const free = a && (a.value === 'all' || a.value === half);
        const yes = free ? Math.random() < 0.85 : a && a.value === 'no' ? false : Math.random() < 0.4;
        await S.update('invites', i.id, { status: yes ? 'accepted' : 'declined', respondedAt: nowIso(), via: 'mock', declineReason: yes ? '' : free ? 'Client meeting came up' : 'Not available then' });
        n++;
      }
      toast(n ? `${plural(n, 'request')} answered` : 'No requests waiting');
    });
  }

  function linkAllMock() {
    act(async () => {
      for (const p of S.state.people) if (!p.accountId) await S.update('people', p.id, { accountId: `mock:${p.id}` });
    }, 'Everyone has a mock account');
  }

  function clearMock() {
    act(async () => {
      for (const coll of ['invites', 'notes', 'candidates']) for (const d of S.state[coll].filter((x) => x.mock)) await S.remove(coll, d.id);
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
      { style: 'display:flex;flex-direction:column;gap:8px', 'aria-label': 'Notes and feedback' },
      h('h3', {}, 'Notes and feedback'),
      h(
        'div',
        { class: 'step-form', style: 'margin:0' },
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
        ? list.map((n) =>
            h(
              'div',
              { class: 'tpanel', style: 'padding:8px 10px;display:flex;flex-direction:column;gap:3px' },
              h(
                'div',
                { class: 'row small' },
                h('b', {}, authorName(n)),
                h('span', { class: `chip ${n.kind === 'feedback' ? 'accent' : ''}` }, n.kind === 'feedback' ? 'Feedback' : 'Note'),
                h('span', { class: 'chip' }, (NOTE_ROUNDS.find((r) => r[0] === n.round) || ['', 'General'])[1]),
                h('span', { class: 'faint mono' }, M.formatDay((n.createdAt || '').slice(0, 10))),
                n.authorId === me || !n.authorId ? h('button', { class: 'link', style: 'margin-left:auto;font-size:12px', onclick: () => act(() => S.remove('notes', n.id), 'Note deleted') }, 'Delete') : null,
              ),
              h('p', { style: 'white-space:pre-wrap;overflow-wrap:anywhere' }, n.text),
            ),
          )
        : h('p', { class: 'small muted' }, 'No notes yet. Natalie, advisors and team leads can all add them; they feed the interview brief.'),
    );
  }

  const briefs = {}; // candidate id -> { text, busy, error, focus, round }
  function briefPanel(c, s) {
    if (!sample) return null;
    const b = (briefs[c.id] = briefs[c.id] || { text: '', busy: false, error: '', focus: '', round: s.stage === 'deepdive' ? 'deepdive' : 'advisor' });
    const out = h('div', { class: 'small', style: 'white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.5' }, b.text);
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
      { class: 'tpanel', style: 'padding:10px 12px;display:flex;flex-direction:column;gap:8px;background:var(--s1)', 'aria-label': 'Interview brief' },
      h('div', { class: 'row', style: 'justify-content:space-between' }, h('h3', {}, 'Interview brief'), h('span', { class: 'small muted' }, 'by Claude, from the notes and timeline')),
      h(
        'div',
        { class: 'row' },
        h('select', { id: `brief-round-${c.id}`, 'aria-label': 'For which interview', onchange: (e) => (b.round = e.target.value) }, h('option', { value: 'advisor', selected: b.round === 'advisor' }, 'For the advisor interview'), h('option', { value: 'deepdive', selected: b.round === 'deepdive' }, 'For the deep dive')),
        h('input', { id: `brief-focus-${c.id}`, style: 'flex:1;min-width:160px', placeholder: 'What do you want to dig into? (optional)', value: b.focus, oninput: (e) => (b.focus = e.target.value) }),
        h('button', { class: 'p', onclick: run }, b.text ? 'Brief me again' : 'Brief me'),
      ),
      status,
      out,
    );
  }

  function buildBriefPrompt(c, round, focus) {
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
  function campaignView() {
    const c = campaign();
    const s = c.settings || M.DEFAULT_SETTINGS;
    const settingRows = [
      ['Invites per slot', s.invitesPerSlot],
      ['Top up after a decline', s.topUpAfterDecline ? 'On' : 'Off'],
      ['Reply window for interviewers', `${s.replyWindowWorkingDays} working days`],
      ['Hold slots before a candidate exists', s.holdBeforeCandidate ? 'On' : 'Off'],
      ['How far ahead to hold', `${s.holdAheadWorkingDays} working days`],
      ['Holds per week', `Advisor ${s.holdsPerWeek.advisor}, deep dive ${s.holdsPerWeek.deepdive}`],
      ['Release an unfilled hold', `${s.releaseUnfilledWorkingDays} working days before`],
      ['Cancellation notice warning', `Under ${s.cancellationWarningWorkingDays} working days`],
      ['Holds per member per month', s.holdsPerMemberPerMonth],
      ['Prefer Fridays', s.preferFridays ? 'On' : 'Off'],
    ];
    return [
      h('div', { class: 'section gutter' }, h('div', { class: 'head' }, h('div', {}, h('h1', {}, c.name), h('p', {}, 'Name, dates and targets for this hiring drive. Rounds and scheduling settings are used by matching from phase 2.')), h('button', { onclick: () => ((ui.newCampaign = !ui.newCampaign), rerender()) }, ui.newCampaign ? 'Close' : '+ New campaign')), ui.newCampaign ? campaignForm(null) : campaignForm(c)),
      h(
        'div',
        { class: 'section gutter' },
        h('h2', {}, 'Rounds'),
        h(
          'div',
          { class: 'sheet-wrap', style: 'border:1px solid var(--grid);border-radius:6px' },
          h(
            'table',
            { class: 'x' },
            h('thead', {}, h('tr', {}, ['Round', 'Interviewers', 'Different teams', 'Length', 'Max days after previous', 'Fallbacks'].map((x) => h('th', {}, x)))),
            h(
              'tbody',
              {},
              c.rounds.map((r) => h('tr', {}, h('td', { class: 'name' }, r.name), h('td', {}, `${r.interviewers} ${r.role === 'teamlead' ? 'team leads' : 'advisors'}`), h('td', {}, r.differentTeams ? 'Yes' : 'No'), h('td', {}, `${r.durationMin} min`), h('td', {}, `${r.maxDaysAfterPrevious} days`), h('td', {}, r.fallbacks.map((x) => (x === 'joker' ? 'HR joker' : 'Natalie')).join(', ')))),
            ),
          ),
        ),
      ),
      h(
        'div',
        { class: 'section gutter' },
        h('h2', {}, 'Scheduling settings'),
        h('p', { class: 'small muted' }, 'Defaults from the plan. They become adjustable when holds and matching arrive.'),
        h('div', { class: 'sheet-wrap', style: 'border:1px solid var(--grid);border-radius:6px' }, h('table', { class: 'x' }, h('tbody', {}, settingRows.map(([k, v]) => h('tr', {}, h('td', {}, k), h('td', { class: 'mono' }, v)))))),
      ),
    ];
  }

  function campaignForm(c) {
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
            if (c) await S.update('campaigns', c.id, { name: f.name.trim(), startDate: f.startDate, endDate: f.endDate, targetHires: Number(f.targetHires) || 0, targetInterviews: Number(f.targetInterviews) || 0 });
            else {
              const id = await S.add('campaigns', M.newCampaign(f));
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
      h('div', { class: 'row end' }, h('button', { class: 'p', type: 'submit' }, c ? 'Save campaign' : 'Create campaign')),
    );
  }

  // ------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------
  function route() {
    const v = (location.hash || '#run').slice(1);
    ui.view = ['run', 'availability', 'roster', 'campaign'].includes(v) ? v : 'run';
    rerender();
  }
  window.addEventListener('hashchange', route);

  async function boot() {
    S = await window.FluxStore.connect(
      () => render(),
      (coll, err) => toast(`Couldn’t load ${coll}: ${err.code}`),
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
  }
  window.FluxApp = { startDraft: (...a) => startDraft(...a), state: () => S, ui };
  boot();
})();
