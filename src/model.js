/*
 * Flux interview scheduling: data model and pure logic.
 *
 * Everything in this file is free of DOM and storage so it can be unit
 * tested with `node --test` and reused by later phases (matching, metrics).
 * It is loaded in the page as a plain script (global `FluxModel`) and in
 * Node through `module.exports`.
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------------
  // Teams, roles, availability values
  // ---------------------------------------------------------------------

  const TEAMS = [
    { code: 'TM', name: 'Tender management' },
    { code: 'PM', name: 'Project management' },
    { code: 'CP', name: 'Contract management' },
    { code: 'OM', name: 'Stakeholder management' },
    { code: 'P&C', name: 'People & Culture (HR)' },
  ];
  const TEAM_CODES = TEAMS.map((t) => t.code);

  const ROLES = [
    { key: 'advisor', label: 'Advisor', plural: 'Advisors' },
    { key: 'teamlead', label: 'Team lead', plural: 'Team leads' },
    { key: 'joker', label: 'Joker (HR team lead)', plural: 'Jokers' },
  ];

  // Cell values in the poll. Dutch on the sheet, short codes in the data.
  const VALUES = {
    all: { label: 'All day', nl: 'Hele dag' },
    am: { label: 'Morning', nl: 'Ochtend' },
    pm: { label: 'Afternoon', nl: 'Middag' },
    no: { label: 'Not available', nl: 'Niet' },
  };
  const NL_TO_VALUE = {
    'hele dag': 'all',
    heledag: 'all',
    'hele dag.': 'all',
    ochtend: 'am',
    "'s ochtends": 'am',
    middag: 'pm',
    "'s middags": 'pm',
    niet: 'no',
    nee: 'no',
  };

  const WEEKDAYS_NL = ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'];
  const WEEKDAYS_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // ---------------------------------------------------------------------
  // Dates (ISO yyyy-mm-dd strings, computed in UTC so no timezone drift)
  // ---------------------------------------------------------------------

  function pad(n) {
    return String(n).padStart(2, '0');
  }
  function isoDate(y, m, d) {
    return `${y}-${pad(m)}-${pad(d)}`;
  }
  function parseIso(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  }
  function toIso(date) {
    return isoDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
  }
  function addDays(iso, n) {
    const d = parseIso(iso);
    d.setUTCDate(d.getUTCDate() + n);
    return toIso(d);
  }
  function daysBetween(a, b) {
    return Math.round((parseIso(b) - parseIso(a)) / 86400000);
  }
  function weekdayOf(iso) {
    return parseIso(iso).getUTCDay();
  }
  function formatDay(iso, opts) {
    if (!iso) return '';
    const d = parseIso(iso);
    const wd = WEEKDAYS_EN[d.getUTCDay()];
    const s = `${wd} ${d.getUTCDate()} ${MONTHS_EN[d.getUTCMonth()]}`;
    return opts && opts.year ? `${s} ${d.getUTCFullYear()}` : s;
  }
  // Monday of the ISO week, used to group grid columns per week.
  function weekStart(iso) {
    const wd = weekdayOf(iso);
    return addDays(iso, wd === 0 ? -6 : 1 - wd);
  }
  function todayIso(now) {
    const d = now || new Date();
    return isoDate(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }

  /** Pull a yyyy-mm-dd poll date out of a file name like
   *  "Beschikbaarheid_traineegesprekken_Flux_2026-11-06.xlsx". */
  function pollDateFromFileName(name) {
    const m = /(\d{4})-(\d{2})-(\d{2})/.exec(name || '');
    return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
  }

  /**
   * Parse a column header like "ma 9-11" or "vr 4-12" into an ISO date.
   * The poll has no year, so pick the year that puts the date closest to
   * the poll date (handles a December poll that runs into January).
   * Returns null when the header is not a day column.
   */
  function parseDayHeader(header, pollDate) {
    const m = /^\s*(ma|di|wo|do|vr|za|zo)\w*\.?\s+(\d{1,2})\s*[-/.]\s*(\d{1,2})\s*$/i.exec(String(header || ''));
    if (!m) return null;
    const wd = WEEKDAYS_NL.indexOf(m[1].toLowerCase());
    const day = Number(m[2]);
    const month = Number(m[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const baseYear = Number((pollDate || todayIso()).slice(0, 4));
    let best = null;
    for (const y of [baseYear - 1, baseYear, baseYear + 1]) {
      const iso = isoDate(y, month, day);
      if (toIso(parseIso(iso)) !== iso) continue; // 31-11 etc.
      const dist = Math.abs(daysBetween(pollDate || todayIso(), iso));
      if (!best || dist < best.dist) best = { iso, dist };
    }
    if (!best) return null;
    return { date: best.iso, weekday: wd, weekdayMatches: weekdayOf(best.iso) === wd, label: m[0].trim() };
  }

  /** Normalise one poll cell. */
  function normalizeValue(raw) {
    if (raw === null || raw === undefined) return { value: null };
    const text = String(raw).trim();
    if (text === '') return { value: null };
    const key = text.toLowerCase().replace(/\s+/g, ' ');
    if (key in NL_TO_VALUE) {
      const value = NL_TO_VALUE[key];
      const canonical = VALUES[value].nl;
      return text === canonical ? { value } : { value, fixed: true, raw: text };
    }
    return { value: null, unknown: true, raw: text };
  }

  function normName(s) {
    return String(s || '')
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .trim()
      .replace(/\s+/g, ' ')
      .toLowerCase();
  }

  // ---------------------------------------------------------------------
  // Poll import
  // ---------------------------------------------------------------------

  function roleFromSheetName(name) {
    const n = normName(name);
    if (/deep\s*dive|teamlead|team lead/.test(n)) return 'teamlead';
    if (/competentie|advis/.test(n)) return 'advisor';
    return null;
  }

  function isSummaryRow(name, cells) {
    const n = normName(name);
    if (!n) return true;
    if (/^voorbeeld/.test(n)) return true;
    if (/^(aantal|waarvan|totaal|total)/.test(n)) return true;
    // Formula rows: numbers or formulas in the day cells, no text answers.
    const nonEmpty = cells.filter((c) => c !== null && c !== undefined && String(c).trim() !== '');
    if (nonEmpty.length && nonEmpty.every((c) => typeof c === 'number' || /^=|^\d+$/.test(String(c).trim()))) return true;
    return false;
  }

  /**
   * Turn the raw sheets of a poll workbook into a draft snapshot.
   * `sheets` is [{ name, rows }] where rows are arrays of cell values
   * (SheetJS `sheet_to_json(ws, { header: 1, raw: false })`).
   */
  function parsePoll(sheets, opts) {
    const pollDate = (opts && opts.pollDate) || todayIso();
    const tabs = [];
    const problems = [];
    for (const sheet of sheets) {
      const rows = sheet.rows || [];
      const headerIdx = rows.findIndex((r) => r && normName(r[0]) === 'naam');
      if (headerIdx < 0) {
        problems.push({ kind: 'sheet_skipped', sheet: sheet.name, message: `Tab "${sheet.name}" has no "Naam" header row, so it was skipped.` });
        continue;
      }
      const header = rows[headerIdx];
      const teamCol = header.findIndex((h) => normName(h) === 'team');
      const remarkCol = header.findIndex((h) => /^opmerking/.test(normName(h)));
      const days = [];
      header.forEach((h, col) => {
        const parsed = parseDayHeader(h, pollDate);
        if (parsed) days.push({ col, ...parsed });
      });
      for (const d of days) {
        if (!d.weekdayMatches) {
          problems.push({ kind: 'weekday_mismatch', sheet: sheet.name, message: `Column "${d.label}" in "${sheet.name}" says ${d.label.slice(0, 2)} but ${formatDay(d.date, { year: true })} is a ${WEEKDAYS_EN[weekdayOf(d.date)]}.` });
        }
      }
      const role = roleFromSheetName(sheet.name);
      const entries = [];
      for (let i = headerIdx + 1; i < rows.length; i++) {
        const r = rows[i] || [];
        const name = r[0] == null ? '' : String(r[0]).trim();
        const dayCells = days.map((d) => r[d.col]);
        if (isSummaryRow(name, dayCells)) continue;
        const cells = {};
        const fixes = [];
        const unknowns = [];
        days.forEach((d, j) => {
          const n = normalizeValue(dayCells[j]);
          cells[d.date] = n.value;
          if (n.fixed) fixes.push({ date: d.date, raw: n.raw, value: n.value });
          if (n.unknown) unknowns.push({ date: d.date, raw: n.raw });
        });
        const team = teamCol >= 0 && r[teamCol] != null ? String(r[teamCol]).trim() : '';
        const remark = remarkCol >= 0 && r[remarkCol] != null ? String(r[remarkCol]).trim() : '';
        entries.push({ key: `${tabs.length}:${i}`, row: i + 1, name, team, remark, cells, fixes, unknowns });
      }
      tabs.push({ sheet: sheet.name, role, dates: days.map((d) => d.date), entries });
    }
    const allDates = [...new Set(tabs.flatMap((t) => t.dates))].sort();
    return {
      pollDate,
      from: allDates[0] || null,
      to: allDates[allDates.length - 1] || null,
      tabs,
      problems,
    };
  }

  function levenshtein(a, b) {
    const m = a.length;
    const n = b.length;
    const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
    for (let j = 1; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
    }
    return dp[m][n];
  }

  function personNames(p) {
    return [p.name, ...(p.aliases || [])].map(normName).filter(Boolean);
  }

  function personHasRole(p, role) {
    if (!role) return true;
    const roles = p.roles || [];
    if (roles.includes(role)) return true;
    // The HR joker answers the team-lead poll.
    return role === 'teamlead' && roles.includes('joker');
  }

  /** Find roster suggestions for a name that did not match exactly. */
  function suggestMatches(name, team, role, people) {
    const n = normName(name);
    const first = n.split(' ')[0];
    const scored = [];
    for (const p of people) {
      let best = Infinity;
      for (const pn of personNames(p)) {
        let score = levenshtein(n, pn);
        const pFirst = pn.split(' ')[0];
        if (pFirst === first) score = Math.min(score, 1);
        if (pn.startsWith(n) || n.startsWith(pn)) score = Math.min(score, 1);
        best = Math.min(best, score);
      }
      if (best > Math.max(2, Math.floor(n.length / 3))) continue;
      if (personHasRole(p, role)) best -= 0.5;
      if (team && p.team === team) best -= 0.25;
      scored.push({ person: p, score: best });
    }
    return scored.sort((a, b) => a.score - b.score).slice(0, 3).map((s) => s.person);
  }

  /**
   * Check a draft against the roster. Returns per-entry match info and
   * a list of problems Natalie resolves before saving.
   * `decisions` maps entry key -> { action: 'match'|'add'|'skip', personId?, keepTeam? }.
   */
  function reviewDraft(draft, people, decisions) {
    decisions = decisions || {};
    const active = people.filter((p) => p.active !== false);
    const issues = [];
    const matches = {};
    for (const tab of draft.tabs) {
      for (const e of tab.entries) {
        const dec = decisions[e.key];
        let person = null;
        if (dec && dec.action === 'match') person = people.find((p) => p.id === dec.personId) || null;
        if (!person && !(dec && dec.action)) {
          const n = normName(e.name);
          const exact = people.filter((p) => personNames(p).includes(n));
          person = exact.find((p) => personHasRole(p, tab.role)) || exact[0] || null;
        }
        matches[e.key] = { person, skipped: !!(dec && dec.action === 'skip'), add: !!(dec && dec.action === 'add') };
        if (dec && dec.action === 'skip') continue;
        if (!person && !(dec && dec.action === 'add')) {
          issues.push({
            kind: 'unknown_name',
            severity: 'block',
            key: e.key,
            message: `"${e.name}" (${e.team || 'no team'}) is not on the roster.`,
            suggestions: suggestMatches(e.name, e.team, tab.role, active),
          });
        }
        if (person && e.team && person.team && e.team !== person.team && !(dec && dec.keepTeam)) {
          issues.push({
            kind: 'team_mismatch',
            severity: 'warn',
            key: e.key,
            personId: person.id,
            message: `${e.name} is in ${e.team} on the sheet but ${person.team} on the roster.`,
          });
        }
        if (e.team && !TEAM_CODES.includes(e.team)) {
          issues.push({ kind: 'unknown_team', severity: 'warn', key: e.key, message: `${e.name} has team "${e.team}", which is not a known team code.` });
        }
        if (person && tab.role && !personHasRole(person, tab.role)) {
          issues.push({ kind: 'role_mismatch', severity: 'info', key: e.key, message: `${person.name} answered the ${tab.role === 'teamlead' ? 'team lead' : 'advisor'} poll but isn't listed with that role.` });
        }
        const vals = tab.dates.map((d) => e.cells[d]);
        if (vals.every((v) => v === null)) {
          issues.push({ kind: 'no_response', severity: 'info', key: e.key, message: `${e.name} left every day blank. Counted as no response, not as unavailable.` });
        } else if (vals.every((v) => v === 'no')) {
          issues.push({ kind: 'none_available', severity: 'info', key: e.key, message: `${e.name} answered "Niet" for every day.` });
        }
        if (e.fixes.length) {
          issues.push({ kind: 'value_fixed', severity: 'info', key: e.key, message: `${e.name}: read ${e.fixes.map((f) => `"${f.raw}" on ${formatDay(f.date)} as ${VALUES[f.value].nl}`).join(', ')}.` });
        }
        if (e.unknowns.length) {
          issues.push({ kind: 'unknown_value', severity: 'warn', key: e.key, message: `${e.name}: couldn't read ${e.unknowns.map((u) => `"${u.raw}" on ${formatDay(u.date)}`).join(', ')}. Treated as no answer.` });
        }
      }
    }
    // Rostered people of a polled role who are missing from the sheet.
    const seen = new Set(Object.values(matches).filter((m) => m.person).map((m) => m.person.id));
    const roles = draft.tabs.map((t) => t.role).filter(Boolean);
    for (const p of active) {
      if (!seen.has(p.id) && roles.some((r) => personHasRole(p, r))) {
        issues.push({ kind: 'missing_from_sheet', severity: 'info', personId: p.id, message: `${p.name} (${p.team}) is on the roster but not on the sheet.` });
      }
    }
    for (const pr of draft.problems) issues.push({ ...pr, severity: 'warn' });
    return { issues, matches, blocking: issues.filter((i) => i.severity === 'block').length };
  }

  // ---------------------------------------------------------------------
  // Remarks: Claude suggests, Natalie confirms
  // ---------------------------------------------------------------------

  const RULE_KINDS = {
    window: 'Only between set hours',
    unavailable: 'Not available',
    tentative: 'Tentative, check first',
    note: 'Note only',
  };

  /** Build the prompt asking Claude to read the poll remarks. */
  function buildRemarkPrompt(draft) {
    const items = [];
    for (const tab of draft.tabs) {
      for (const e of tab.entries) {
        if (!e.remark) continue;
        items.push({
          row: e.key,
          name: e.name,
          answers: Object.fromEntries(tab.dates.map((d) => [`${d} (${WEEKDAYS_NL[weekdayOf(d)]})`, e.cells[d] ? VALUES[e.cells[d]].nl : '']).filter(([, v]) => v)),
          remark: e.remark,
          poll_dates: tab.dates,
        });
      }
    }
    const instructions = [
      'You help an HR coordinator at Flux Partners (a Dutch consultancy) schedule 1-hour, in-person interviews.',
      'Colleagues answered a half-day availability poll (Dutch). Each answer is Hele dag (all day), Ochtend (morning), Middag (afternoon) or Niet (not available).',
      'Some added a free-text remark (usually Dutch). For each remark, propose rules that narrow or qualify specific poll dates.',
      '',
      'Rule kinds:',
      '- "window": only available between from and to (HH:MM, 24h) on those dates. Use from or to alone for "until 12:00" or "from 11:00". "Graag einde middag" (preferably late afternoon) is a window from 15:00.',
      '- "unavailable": not available on those dates at all, or in the given hours.',
      '- "tentative": answers on those dates may change ("onder voorbehoud", "check my agenda"); the coordinator should check first.',
      '- "note": useful context that maps to no hours, such as a location ("bij Boskalis in Amsterdam") or "only in an emergency". Put dates on it if the remark names them.',
      '',
      'Rules:',
      '- Dates must come from that row\'s poll_dates. Resolve weekday words (woensdagen = every Wednesday in poll_dates; "vr 20" = the Friday the 20th; "vanaf 24/11" = 24 Nov and later).',
      '- One remark can produce several rules. Skip a remark only if it says nothing about availability.',
      '- "summary" is one short English sentence Natalie reads, e.g. "Fri 4 Dec only 14:00-15:30".',
      '- "quote" is the exact part of the remark the rule comes from.',
      '',
      'Reply with only a JSON array, no prose. Example:',
      '[{"row":"0:3","kind":"window","dates":["2026-12-04"],"from":"14:00","to":"15:30","summary":"Fri 4 Dec only 14:00-15:30","quote":"op vrijdag 4-12 alleen van 14-15.30 uur"}]',
      '',
      'Poll rows with remarks:',
      JSON.stringify(items, null, 1),
    ];
    return { prompt: instructions.join('\n'), count: items.length };
  }

  const HHMM = /^([01]?\d|2[0-3])[:.]([0-5]\d)$/;
  function normTime(t) {
    if (t == null || t === '') return null;
    const m = HHMM.exec(String(t).trim());
    if (!m) {
      const h = /^([01]?\d|2[0-3])$/.exec(String(t).trim());
      return h ? `${pad(Number(h[1]))}:00` : null;
    }
    return `${pad(Number(m[1]))}:${m[2]}`;
  }

  /** Validate Claude's reply against the draft; drop anything malformed. */
  function cleanRemarkSuggestions(raw, draft) {
    const list = Array.isArray(raw) ? raw : raw && Array.isArray(raw.rules) ? raw.rules : [];
    const byKey = {};
    for (const tab of draft.tabs) for (const e of tab.entries) byKey[e.key] = { e, tab };
    const out = [];
    list.forEach((s, i) => {
      if (!s || typeof s !== 'object') return;
      const hit = byKey[String(s.row)];
      if (!hit) return;
      const kind = RULE_KINDS[s.kind] ? s.kind : 'note';
      const dates = (Array.isArray(s.dates) ? s.dates : []).map(String).filter((d) => hit.tab.dates.includes(d));
      const from = normTime(s.from);
      const to = normTime(s.to);
      if (kind === 'window' && !from && !to) return;
      if (kind !== 'note' && !dates.length) return;
      out.push({
        id: `r${Date.now().toString(36)}${i}`,
        entryKey: hit.e.key,
        kind,
        dates,
        from: kind === 'window' || kind === 'unavailable' ? from : null,
        to: kind === 'window' || kind === 'unavailable' ? to : null,
        summary: String(s.summary || '').slice(0, 200) || RULE_KINDS[kind],
        quote: String(s.quote || '').slice(0, 300),
        source: 'claude',
        status: 'pending',
      });
    });
    return out;
  }

  function describeRule(r) {
    const days = r.dates.length ? r.dates.map((d) => formatDay(d)).join(', ') : 'no specific days';
    if (r.kind === 'window') return `${days}: ${r.from && r.to ? `${r.from}-${r.to}` : r.from ? `from ${r.from}` : `until ${r.to}`}`;
    if (r.kind === 'unavailable') return `${days}: not available${r.from || r.to ? ` ${r.from || ''}-${r.to || ''}` : ''}`;
    if (r.kind === 'tentative') return `${days}: check first`;
    return r.summary;
  }

  /**
   * Effective availability for one person-day: the poll value plus any
   * confirmed rules. Returns { value, window, tentative, notes }.
   */
  function effectiveCell(value, rules, date) {
    const out = { value, window: null, tentative: false, notes: [] };
    for (const r of rules || []) {
      if (r.status !== 'confirmed') continue;
      if (r.dates.length && !r.dates.includes(date)) continue;
      if (!r.dates.length && r.kind !== 'note') continue;
      if (r.kind === 'unavailable' && !r.from && !r.to) out.value = 'no';
      else if (r.kind === 'window' || r.kind === 'unavailable') out.window = r;
      else if (r.kind === 'tentative') out.tentative = true;
      if (r.dates.length) out.notes.push(r.summary);
    }
    return out;
  }

  /** Per-day coverage across a set of rows: who is free in each half-day,
   *  and whether a pair from different teams is possible. */
  function dayCoverage(rows, date) {
    const half = { am: [], pm: [] };
    for (const r of rows) {
      const c = effectiveCell(r.cells[date], r.rules, date);
      if (c.value === 'all' || c.value === 'am') half.am.push(r);
      if (c.value === 'all' || c.value === 'pm') half.pm.push(r);
    }
    const teams = (list) => new Set(list.map((r) => r.team).filter(Boolean)).size;
    return {
      am: half.am.length,
      pm: half.pm.length,
      pairAm: teams(half.am) >= 2,
      pairPm: teams(half.pm) >= 2,
      people: new Set([...half.am, ...half.pm]).size,
    };
  }

  /** Turn a reviewed draft into the snapshot document saved to the db. */
  function buildSnapshot(draft, review, rules, meta) {
    const tabs = draft.tabs.map((tab) => ({
      sheet: tab.sheet,
      role: tab.role,
      dates: tab.dates,
      rows: tab.entries
        .filter((e) => !review.matches[e.key].skipped)
        .map((e) => {
          const m = review.matches[e.key];
          return {
            personId: m.person ? m.person.id : null,
            name: e.name,
            team: e.team,
            remark: e.remark,
            cells: e.cells,
            rules: rules.filter((r) => r.entryKey === e.key && r.status !== 'dismissed').map(({ entryKey, ...r }) => r),
          };
        }),
    }));
    return {
      campaignId: meta.campaignId,
      fileName: meta.fileName || '',
      pollDate: draft.pollDate,
      from: draft.from,
      to: draft.to,
      importedAt: meta.importedAt || new Date().toISOString(),
      tabs,
      stats: snapshotStats({ tabs }),
    };
  }

  function snapshotStats(snap) {
    let people = 0;
    let responded = 0;
    let halfDays = 0;
    for (const t of snap.tabs) {
      for (const r of t.rows) {
        people++;
        const vals = t.dates.map((d) => r.cells[d]);
        if (vals.some((v) => v !== null)) responded++;
        for (const v of vals) halfDays += v === 'all' ? 2 : v === 'am' || v === 'pm' ? 1 : 0;
      }
    }
    return { people, responded, halfDays };
  }

  // ---------------------------------------------------------------------
  // Campaigns
  // ---------------------------------------------------------------------

  const DEFAULT_SETTINGS = {
    invitesPerSlot: 3,
    topUpAfterDecline: true,
    replyWindowWorkingDays: 2,
    holdBeforeCandidate: true,
    holdAheadWorkingDays: 10,
    holdsPerWeek: { advisor: 3, deepdive: 2 },
    releaseUnfilledWorkingDays: 3,
    cancellationWarningWorkingDays: 3,
    holdsPerMemberPerMonth: 2,
    preferFridays: true,
  };

  const HR_ROUND = { key: 'hr', name: 'HR interview', role: 'hr', interviewers: 1, differentTeams: false, durationMin: 45, maxDaysAfterPrevious: null, fallbacks: [] };
  const DEFAULT_ROUNDS = [
    { key: 'advisor', name: 'Advisor interview', role: 'advisor', interviewers: 2, differentTeams: true, durationMin: 60, maxDaysAfterPrevious: 7, fallbacks: ['natalie'] },
    { key: 'deepdive', name: 'Team lead deep dive', role: 'teamlead', interviewers: 2, differentTeams: true, durationMin: 60, maxDaysAfterPrevious: 7, fallbacks: ['joker', 'natalie'] },
  ];

  /**
   * Campaign structures live in code. A structure fixes the rounds (and the
   * candidate steps that go with them); Natalie adjusts each round's rules
   * and picks who sits in each round when she creates a campaign. New
   * structures (for example a 2-round interview) are added here.
   */
  const STRUCTURES = {
    'three-round': {
      key: 'three-round',
      name: '3-round interview',
      description: 'HR interview with Natalie, then an advisor interview with two advisors from different teams, then a deep dive with two team leads.',
      rounds: [HR_ROUND, ...DEFAULT_ROUNDS],
    },
  };
  const DEFAULT_STRUCTURE = 'three-round';

  /** Who can sit in a round, by roster role. */
  function eligibleFor(round, person) {
    if (!person || person.active === false) return false;
    const roles = person.roles || [];
    if (round.role === 'hr') return person.team === 'P&C' || roles.includes('joker');
    if (round.role === 'teamlead') return roles.includes('teamlead') || roles.includes('joker');
    return roles.includes(round.role);
  }

  /** The people in a campaign round: the chosen members, or everyone eligible when none were chosen. */
  function roundMembers(camp, roundKey, people) {
    const round = ((camp && camp.rounds) || STRUCTURES[DEFAULT_STRUCTURE].rounds).find((r) => r.key === roundKey);
    if (!round) return [];
    const chosen = camp && camp.members && camp.members[roundKey];
    if (chosen) return people.filter((p) => chosen.includes(p.id) && p.active !== false);
    return people.filter((p) => eligibleFor(round, p));
  }

  function newCampaign(fields) {
    const structure = STRUCTURES[fields.structure] || STRUCTURES[DEFAULT_STRUCTURE];
    return {
      name: fields.name || 'New campaign',
      startDate: fields.startDate || todayIso(),
      endDate: fields.endDate || '',
      targetHires: Number(fields.targetHires) || 0,
      targetInterviews: Number(fields.targetInterviews) || 0,
      structure: structure.key,
      rounds: JSON.parse(JSON.stringify(fields.rounds || structure.rounds)),
      settings: JSON.parse(JSON.stringify(fields.settings || DEFAULT_SETTINGS)),
      members: fields.members ? JSON.parse(JSON.stringify(fields.members)) : null,
      invited: {},
      archived: false,
      createdAt: new Date().toISOString(),
    };
  }

  // ---------------------------------------------------------------------
  // Candidates: step-by-step timeline
  // ---------------------------------------------------------------------

  /*
   * The main path, in order. `outcome` lists the choices Natalie picks
   * for a step; a reject outcome routes to a call step and then closing.
   */
  const STEPS = [
    { key: 'hr_done', n: 1, label: 'HR interview done', actor: 'Natalie', round: 'hr', outcome: ['pass', 'reject'], prompt: (c) => `Record HR result for ${c}` },
    { key: 'avail_asked_r2', n: 2, label: 'Availability asked', actor: 'Natalie', round: 'advisor', prompt: (c) => `Ask ${c} for next week's availability` },
    { key: 'avail_received_r2', n: 3, label: 'Availability received', actor: 'Natalie', round: 'advisor', fields: ['availability'], prompt: (c) => `Match ${c} to an advisor slot` },
    { key: 'advisor_booked', n: 4, label: 'Advisor interview booked', actor: 'Tool + Natalie', round: 'advisor', fields: ['slot', 'interviewers'], prompt: (c) => `Send ${c}'s invite` },
    { key: 'advisor_done', n: 5, label: 'Advisor interview done', actor: 'Advisors → Natalie', round: 'advisor', outcome: ['pass', 'reject'], prompt: (c) => `Get the advisors' verdict on ${c}` },
    { key: 'result_call_r2', n: 6, label: 'Result call made', actor: 'Natalie', round: 'advisor', call: true, prompt: (c, s) => (s.rejectedAt === 'advisor' ? `Call ${c}: not moving on` : `Call ${c}: passed the advisor round`) },
    { key: 'avail_received_final', n: 7, label: 'Availability received (final)', actor: 'Natalie', round: 'deepdive', fields: ['availability'], prompt: (c) => `Match ${c} to a deep dive` },
    { key: 'deepdive_booked', n: 8, label: 'Deep dive booked', actor: 'Tool + Natalie', round: 'deepdive', fields: ['slot', 'interviewers'], prompt: (c) => `Send ${c}'s deep dive invite` },
    { key: 'deepdive_done', n: 9, label: 'Deep dive done', actor: 'Team leads → Natalie', round: 'deepdive', outcome: ['hire', 'reject'], prompt: (c) => `Get the team leads' verdict on ${c}` },
    { key: 'final_call', n: 10, label: 'Final call made', actor: 'Natalie', round: 'deepdive', call: true, prompt: (c, s) => (s.rejectedAt === 'deepdive' ? `Call ${c}: not hired` : `Call ${c}: offer`) },
    { key: 'closed', n: 11, label: 'Closed', actor: 'Natalie', round: 'end', outcome: ['hired', 'rejected', 'withdrew', 'no_show'], prompt: (c) => `Close ${c}'s file` },
  ];
  const HR_REJECT_CALL = { key: 'reject_call_hr', n: '1b', label: 'Call: not moving on', actor: 'Natalie', round: 'hr', call: true, prompt: (c) => `Call ${c}: not moving on after HR` };
  const ALL_STEPS = [STEPS[0], HR_REJECT_CALL, ...STEPS.slice(1)];
  const STEP_BY_KEY = Object.fromEntries(ALL_STEPS.map((s) => [s.key, s]));

  const OUTCOME_LABELS = {
    pass: 'Passed',
    reject: 'Not moving on',
    hire: 'Hire',
    hired: 'Hired',
    rejected: 'Rejected',
    withdrew: 'Withdrew',
    no_show: 'No-show',
  };

  /** The latest entry per step (entries can be corrected by re-recording). */
  function latestByStep(timeline) {
    const map = {};
    for (const e of timeline || []) {
      if (e.voided) continue;
      const cur = map[e.step];
      if (!cur || e.at > cur.at || (e.at === cur.at && (e.recordedAt || '') >= (cur.recordedAt || ''))) map[e.step] = e;
    }
    return map;
  }

  /**
   * Work out where a candidate is: which steps are done, which one is
   * next, which round they're in, and the 1-week clock for that round.
   */
  function candidateState(cand, today, limits) {
    today = today || todayIso();
    const lim = limits || {};
    const done = latestByStep(cand.timeline);
    const name = (cand.name || 'candidate').split(' ')[0];
    let rejectedAt = null;
    if (done.hr_done && done.hr_done.outcome === 'reject') rejectedAt = 'hr';
    else if (done.advisor_done && done.advisor_done.outcome === 'reject') rejectedAt = 'advisor';
    else if (done.deepdive_done && done.deepdive_done.outcome === 'reject') rejectedAt = 'deepdive';

    let path;
    if (rejectedAt === 'hr') path = ['hr_done', 'reject_call_hr', 'closed'];
    else if (rejectedAt === 'advisor') path = ['hr_done', 'avail_asked_r2', 'avail_received_r2', 'advisor_booked', 'advisor_done', 'result_call_r2', 'closed'];
    else path = STEPS.map((s) => s.key);

    let next = null;
    if (!done.closed) {
      // First missing step after the furthest recorded one, so steps
      // entered out of order don't send Natalie backwards.
      let furthest = -1;
      path.forEach((k, i) => {
        if (done[k]) furthest = i;
      });
      for (let i = furthest + 1; i < path.length; i++) {
        if (!done[path[i]]) {
          next = path[i];
          break;
        }
      }
    }
    const skipped = path.filter((k, i) => !done[k] && next && i < path.indexOf(next));

    const closed = done.closed || null;
    let status = 'open';
    if (closed) status = closed.outcome || 'closed';

    // Stage for the funnel.
    let stage = 'hr';
    if (done.hr_done && done.hr_done.outcome === 'pass') stage = 'advisor';
    if (done.advisor_done && done.advisor_done.outcome === 'pass') stage = 'deepdive';
    if ((done.deepdive_done && done.deepdive_done.outcome === 'hire') || (closed && closed.outcome === 'hired')) stage = 'hired';

    // 1-week clock: runs from the moment availability is asked until the
    // interview of that round takes place.
    let clock = null;
    if (!closed && !rejectedAt) {
      if (stage === 'advisor') {
        const start = (done.avail_asked_r2 || done.hr_done).at;
        clock = makeClock('advisor', start, done.advisor_booked, done.advisor_done, today, lim.advisor);
      } else if (stage === 'deepdive' && done.result_call_r2) {
        clock = makeClock('deepdive', done.result_call_r2.at, done.deepdive_booked, done.deepdive_done, today, lim.deepdive);
      }
    }

    const step = next ? STEP_BY_KEY[next] : null;
    return {
      done,
      path,
      next,
      skipped,
      status,
      stage,
      rejectedAt,
      clock,
      prompt: step ? step.prompt(name, { rejectedAt }) : null,
    };
  }

  function makeClock(round, start, booked, held, today, maxDays) {
    const max = maxDays || 7;
    const deadline = addDays(start.slice(0, 10), max);
    const interviewDate = booked && booked.data && booked.data.slotDate ? booked.data.slotDate : null;
    if (held) return { round, start, deadline, max, state: 'met', interviewDate: held.at.slice(0, 10), late: held.at.slice(0, 10) > deadline };
    const day = daysBetween(start.slice(0, 10), today);
    if (interviewDate) {
      return { round, start, deadline, max, state: interviewDate > deadline ? 'booked_late' : 'booked', interviewDate, day, daysLeft: daysBetween(today, deadline) };
    }
    const daysLeft = daysBetween(today, deadline);
    return { round, start, deadline, max, day, daysLeft, state: daysLeft < 0 ? 'overdue' : daysLeft <= 2 ? 'urgent' : 'running' };
  }

  /** Funnel counts for a campaign. */
  function funnel(cands) {
    const f = { total: cands.length, passedHr: 0, advisorDone: 0, passedAdvisor: 0, deepdiveDone: 0, hired: 0, open: 0, closed: 0 };
    for (const c of cands) {
      const s = candidateState(c);
      const d = s.done;
      if (d.hr_done && d.hr_done.outcome === 'pass') f.passedHr++;
      if (d.advisor_done) f.advisorDone++;
      if (d.advisor_done && d.advisor_done.outcome === 'pass') f.passedAdvisor++;
      if (d.deepdive_done) f.deepdiveDone++;
      if (s.stage === 'hired') f.hired++;
      if (s.status === 'open') f.open++;
      else f.closed++;
    }
    return f;
  }

  /** Same-team check for a proposed interviewer pair. */
  function pairProblems(ids, people, round) {
    const ps = ids.map((id) => people.find((p) => p.id === id)).filter(Boolean);
    const problems = [];
    if (round && ps.length < round.interviewers) problems.push(`Pick ${round.interviewers} interviewers.`);
    if (round && round.differentTeams) {
      const teams = ps.map((p) => p.team);
      if (new Set(teams).size < teams.length) problems.push('Two interviewers are from the same team.');
    }
    return problems;
  }

  /** Who is available on a date, by half-day, according to the latest snapshot covering that date for a role. */
  function availabilityOn(snapshots, personId, role, date) {
    const sorted = [...snapshots].sort((a, b) => (b.pollDate || '').localeCompare(a.pollDate || '') || (b.importedAt || '').localeCompare(a.importedAt || ''));
    for (const s of sorted) {
      for (const t of s.tabs || []) {
        if (role && t.role && t.role !== role) continue;
        if (!t.dates.includes(date)) continue;
        const row = t.rows.find((r) => r.personId === personId);
        if (!row) continue;
        return { ...effectiveCell(row.cells[date], row.rules, date), pollDate: s.pollDate };
      }
    }
    return null;
  }


  // ---------------------------------------------------------------------
  // Interviewer requests (invites) for one candidate's round
  // ---------------------------------------------------------------------

  const INVITE_STATUS = {
    pending: 'Waiting for a reply',
    accepted: 'Accepted',
    declined: 'Declined',
    released: 'Released',
    cancelled: 'Cancelled',
  };

  /**
   * Work out where a set of interviewer requests stands.
   * Rule from the plan: the pair is the first 2 accepts from different
   * teams. Once one person from a team accepts, other pending people from
   * that team are released; once the pair is complete, everyone still
   * pending is released. A decline (or no reply within the window)
   * means topping up from the next person.
   */
  function inviteState(invites, people, opts) {
    opts = opts || {};
    const need = opts.need || 2;
    const today = opts.today || todayIso();
    const replyDays = opts.replyDays == null ? 2 : opts.replyDays;
    const team = (id) => {
      const p = people.find((x) => x.id === id);
      return p ? p.team : '?';
    };
    const live = invites.filter((i) => i.status !== 'cancelled');
    const accepted = live.filter((i) => i.status === 'accepted').sort((a, b) => (a.respondedAt || '').localeCompare(b.respondedAt || ''));
    const pair = [];
    const teams = new Set();
    for (const i of accepted) {
      if (pair.length >= need) break;
      if (teams.has(team(i.personId))) continue;
      pair.push(i);
      teams.add(team(i.personId));
    }
    const complete = pair.length >= need;
    const pending = live.filter((i) => i.status === 'pending');
    const toRelease = [];
    const sameTeamAccepted = accepted.filter((i) => !pair.includes(i));
    for (const i of pending) {
      if (complete) toRelease.push({ invite: i, why: 'pair_filled' });
      else if (teams.has(team(i.personId))) toRelease.push({ invite: i, why: 'same_team' });
    }
    for (const i of sameTeamAccepted) toRelease.push({ invite: i, why: complete ? 'pair_filled' : 'same_team' });
    const overdue = pending.filter((i) => i.sentAt && daysBetween(i.sentAt.slice(0, 10), today) >= replyDays);
    const declined = live.filter((i) => i.status === 'declined');
    // How many more people to ask so a pair is still possible.
    const stillPossible = pending.filter((i) => !teams.has(team(i.personId)));
    const shortBy = complete ? 0 : Math.max(0, need - pair.length - new Set(stillPossible.map((i) => team(i.personId))).size);
    return { pair: pair.map((i) => i.personId), complete, pending, accepted, declined, toRelease, overdue, shortBy, teams: [...teams] };
  }

  const RELEASE_REASONS = {
    same_team: 'another colleague from your team accepted first',
    pair_filled: 'the interview pair is complete',
    no_candidate: 'no candidate was matched to this slot',
    candidate_cancelled: 'the candidate cancelled',
    rescheduled: 'the interview was rescheduled',
  };


  // ------------------------------------------------------------------
  // Interviews and the scoreboard
  // ------------------------------------------------------------------
  const POINTS = { interview: 10, quickReply: 3, quickFeedback: 3 };

  /**
   * Every interview a person sits on: from booked steps (interviewers on the
   * booking) plus accepted requests that aren't booked yet. One row per
   * candidate, round and person.
   */
  function interviewsOf(cands, invites) {
    const rows = new Map();
    for (const c of cands) {
      const done = latestByStep(c.timeline);
      for (const [round, key] of [['advisor', 'advisor_booked'], ['deepdive', 'deepdive_booked']]) {
        const e = done[key];
        const d = (e && e.data) || {};
        if (!e || !d.slotDate) continue;
        for (const pid of d.interviewers || []) rows.set(`${c.id}|${round}|${pid}`, { candidateId: c.id, campaignId: c.campaignId, round, personId: pid, slotDate: d.slotDate, time: d.time || '', room: d.room || '', partners: (d.interviewers || []).filter((x) => x !== pid), booked: true });
      }
    }
    const byCand = new Map(cands.map((c) => [c.id, c]));
    for (const i of invites) {
      if (i.status !== 'accepted' || !byCand.has(i.candidateId)) continue;
      const k = `${i.candidateId}|${i.round}|${i.personId}`;
      if (rows.has(k)) continue;
      // A booking for that round with other people means this hold wasn't used.
      const booked = [...rows.values()].some((r) => r.candidateId === i.candidateId && r.round === i.round);
      if (booked) continue;
      const partners = invites.filter((x) => x.candidateId === i.candidateId && x.round === i.round && x.status === 'accepted' && x.personId !== i.personId).map((x) => x.personId);
      rows.set(k, { candidateId: i.candidateId, campaignId: byCand.get(i.candidateId).campaignId, round: i.round, personId: i.personId, slotDate: i.slotDate, time: i.time || '', room: i.room || '', partners, booked: false });
    }
    return [...rows.values()].sort((a, b) => (a.slotDate || '').localeCompare(b.slotDate || '') || (a.time || '').localeCompare(b.time || ''));
  }

  const hoursBetween = (a, b) => (Date.parse(b) - Date.parse(a)) / 36e5;

  /**
   * Points and stats per interviewer and per team for one campaign.
   * notes must carry `personId` (the author's roster id) for feedback to count.
   */
  function scoreboard({ cands, invites, notes, people, today }) {
    today = today || todayIso();
    const ivs = interviewsOf(cands, invites);
    const interviewers = people.filter((p) => p.active !== false && (p.roles || []).some((r) => r === 'advisor' || r === 'teamlead' || r === 'joker'));
    const per = {};
    for (const p of interviewers) per[p.id] = { personId: p.id, team: p.team, done: 0, upcoming: 0, replies: 0, quickReplies: 0, replyHours: [], feedbackDue: 0, feedbackOnTime: 0, feedbackLate: 0, points: 0, badges: [] };
    for (const r of ivs) {
      const x = per[r.personId];
      if (!x) continue;
      if (r.slotDate <= today) {
        x.done++;
        const fb = notes.filter((n) => n.kind === 'feedback' && n.personId === r.personId && n.candidateId === r.candidateId && n.round === r.round);
        if (r.slotDate < today || fb.length) x.feedbackDue++;
        if (fb.length) {
          const first = fb.map((n) => (n.createdAt || '').slice(0, 10)).sort()[0];
          if (daysBetween(r.slotDate, first) <= 1) x.feedbackOnTime++;
          else x.feedbackLate++;
        }
      } else x.upcoming++;
    }
    for (const i of invites) {
      const x = per[i.personId];
      if (!x || !i.respondedAt || !i.sentAt || i.status === 'pending') continue;
      if (i.status === 'released' && !i.respondedAt) continue;
      const hrs = Math.max(0, hoursBetween(i.sentAt, i.respondedAt));
      x.replies++;
      x.replyHours.push(hrs);
      if (hrs <= 24) x.quickReplies++;
    }
    const totalDone = Object.values(per).reduce((n, x) => n + x.done, 0);
    const fairEach = interviewers.length ? totalDone / interviewers.length : 0;
    for (const x of Object.values(per)) {
      x.points = x.done * POINTS.interview + x.quickReplies * POINTS.quickReply + x.feedbackOnTime * POINTS.quickFeedback;
      x.avgReplyHours = x.replyHours.length ? x.replyHours.reduce((a, b) => a + b, 0) / x.replyHours.length : null;
      x.fairShare = fairEach;
      if (x.done >= 1) x.badges.push('First interview');
      if (x.quickReplies >= 3 && x.quickReplies === x.replies) x.badges.push('Quick replier');
      if (x.feedbackOnTime >= 2 && !x.feedbackLate) x.badges.push('Feedback within a day');
      if (totalDone >= interviewers.length && x.done >= Math.ceil(fairEach)) x.badges.push('Fair share');
      delete x.replyHours;
    }
    const teams = {};
    for (const x of Object.values(per)) {
      const t = (teams[x.team] = teams[x.team] || { team: x.team, members: 0, done: 0, upcoming: 0, points: 0, replies: 0, quickReplies: 0, feedbackDue: 0, feedbackOnTime: 0, replyHoursSum: 0, replyCount: 0 });
      t.members++;
      t.done += x.done;
      t.upcoming += x.upcoming;
      t.points += x.points;
      t.replies += x.replies;
      t.quickReplies += x.quickReplies;
      t.feedbackDue += x.feedbackDue;
      t.feedbackOnTime += x.feedbackOnTime;
      if (x.avgReplyHours !== null) {
        t.replyHoursSum += x.avgReplyHours * x.replies;
        t.replyCount += x.replies;
      }
    }
    const teamList = Object.values(teams).map((t) => ({
      team: t.team,
      members: t.members,
      done: t.done,
      upcoming: t.upcoming,
      points: t.points,
      pointsPerMember: t.members ? Math.round((t.points / t.members) * 10) / 10 : 0,
      fairShare: Math.round(fairEach * t.members * 10) / 10,
      avgReplyHours: t.replyCount ? Math.round((t.replyHoursSum / t.replyCount) * 10) / 10 : null,
      feedbackOnTimePct: t.feedbackDue ? Math.round((t.feedbackOnTime / t.feedbackDue) * 100) : null,
    }));
    teamList.sort((a, b) => b.pointsPerMember - a.pointsPerMember || b.done - a.done || a.team.localeCompare(b.team));
    // Ties share a rank (1, 1, 3), so a level start doesn't put anyone last.
    teamList.forEach((t) => (t.rank = 1 + teamList.filter((u) => u.pointsPerMember > t.pointsPerMember).length));
    const personList = Object.values(per).sort((a, b) => b.points - a.points || b.done - a.done);
    personList.forEach((x) => {
      x.rank = 1 + personList.filter((y) => y.points > x.points).length;
      x.of = personList.length;
      const mates = personList.filter((y) => y.team === x.team);
      x.teamRank = 1 + mates.filter((y) => y.points > x.points).length;
      x.teamOf = mates.length;
    });
    return { totalDone, fairEach: Math.round(fairEach * 10) / 10, teams: teamList, people: personList };
  }

  /** Counts per stage for the campaign overview (no names). */
  function pipelineCounts(cands, today) {
    const out = { total: cands.length, hr: 0, advisor: 0, deepdive: 0, hired: 0, closed: 0 };
    for (const c of cands) {
      const s = candidateState(c, today);
      if (s.stage === 'hired') out.hired++;
      else if (s.status !== 'open') out.closed++;
      else out[s.stage] = (out[s.stage] || 0) + 1;
    }
    return out;
  }

  const api = {
    TEAMS,
    TEAM_CODES,
    ROLES,
    VALUES,
    WEEKDAYS_NL,
    WEEKDAYS_EN,
    RULE_KINDS,
    STEPS,
    ALL_STEPS,
    STEP_BY_KEY,
    HR_REJECT_CALL,
    OUTCOME_LABELS,
    DEFAULT_SETTINGS,
    DEFAULT_ROUNDS,
    addDays,
    daysBetween,
    weekdayOf,
    weekStart,
    formatDay,
    todayIso,
    pollDateFromFileName,
    parseDayHeader,
    normalizeValue,
    normName,
    parsePoll,
    reviewDraft,
    suggestMatches,
    personHasRole,
    buildRemarkPrompt,
    cleanRemarkSuggestions,
    describeRule,
    effectiveCell,
    dayCoverage,
    buildSnapshot,
    snapshotStats,
    newCampaign,
    latestByStep,
    candidateState,
    funnel,
    pairProblems,
    availabilityOn,
    normTime,
    INVITE_STATUS,
    RELEASE_REASONS,
    inviteState,
    STRUCTURES,
    DEFAULT_STRUCTURE,
    eligibleFor,
    roundMembers,
    POINTS,
    interviewsOf,
    scoreboard,
    pipelineCounts,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FluxModel = api;
})(typeof window !== 'undefined' ? window : globalThis);
