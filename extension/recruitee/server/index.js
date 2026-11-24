#!/usr/bin/env node
/*
 * Recruitee (read-only) MCP server for the Claude desktop app.
 *
 * Speaks MCP over stdio (newline-delimited JSON-RPC), with no dependencies,
 * so it runs on the Node that ships with Claude. Every call is a GET: it
 * never changes anything in Recruitee. Without a token it answers with mock
 * data in the same shapes, so the app can be tried before a token exists.
 *
 * Token and company id come from the extension settings (user_config), which
 * Claude keeps in the system keychain.
 */
'use strict';
const R = require('./recruitee.js');

const TOKEN = (process.env.RECRUITEE_TOKEN || '').trim();
const COMPANY = (process.env.RECRUITEE_COMPANY_ID || '').trim();
const LIVE = !!(TOKEN && COMPANY && !/^\$\{/.test(TOKEN));
const BASE = `https://api.recruitee.com/c/${encodeURIComponent(COMPANY)}`;

// ---------------------------------------------------------------- API
async function get(path, query) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' } });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch (e) {
    body = { raw: text.slice(0, 2000) };
  }
  if (!res.ok) {
    const err = new Error(res.status === 401 ? 'Recruitee refused the token (401). Check the token and company ID in the extension settings.' : `Recruitee answered ${res.status} for GET ${path}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

async function allCandidates(offerId) {
  const out = { candidates: [], references: [] };
  const limit = 100;
  for (let offset = 0; offset < 5000; offset += limit) {
    const page = await get('/candidates', { offer_id: offerId, limit, offset });
    const list = page.candidates || [];
    out.candidates.push(...list);
    out.references.push(...(page.references || []));
    if (list.length < limit) break;
  }
  return out;
}

async function offerDetail(offerId) {
  try {
    const d = await get(`/offers/${offerId}`);
    return d.offer || d;
  } catch (e) {
    return null;
  }
}

// The company-wide list path is /interview/events (from the Recruitee Ruby
// client); its filters aren't documented, so we try from/to and filter here,
// then fall back to asking per candidate.
async function interviews({ from, to, candidate_ids }) {
  const inRange = (e) => (!from || e.startsAt.slice(0, 10) >= from) && (!to || e.startsAt.slice(0, 10) <= to);
  const tried = [];
  try {
    const raw = await get('/interview/events', { from, to, start_date: from, end_date: to });
    return { events: R.normalizeEvents(raw).filter(inRange), via: 'company', tried };
  } catch (e) {
    tried.push(`/interview/events: ${e.status || e.message}`);
  }
  const events = [];
  for (const id of (candidate_ids || []).slice(0, 200)) {
    try {
      const raw = await get(`/interview/candidates/${id}/events`);
      events.push(...R.normalizeEvents(raw).map((e) => ({ ...e, candidateId: e.candidateId || id })));
    } catch (e) {
      tried.push(`/interview/candidates/${id}/events: ${e.status || e.message}`);
      if (e.status === 401) break;
    }
  }
  return { events: events.filter(inRange), via: 'per-candidate', tried: tried.slice(0, 5) };
}

// ---------------------------------------------------------------- tools
const today = () => new Date().toISOString().slice(0, 10);
const TOOLS = [
  {
    name: 'status',
    description: 'Whether this extension reads live Recruitee data or returns mock data, and for which company.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      if (!LIVE) return { mode: 'mock', company: R.mockRecruitee(today()).company, hint: 'Add a personal API token and company ID in the extension settings to read live data.' };
      const me = await get('/admin');
      const a = me.admin || me;
      return { mode: 'live', companyId: COMPANY, user: a.name || a.email || '', role: a.role_name || '' };
    },
  },
  {
    name: 'list_offers',
    description: 'Vacancies (offers) with their pipeline stages.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      if (!LIVE) return { mode: 'mock', offers: R.normalizeOffers(R.mockRecruitee(today()).offers) };
      const raw = await get('/offers');
      const offers = R.normalizeOffers(raw).filter((o) => o.kind !== 'talent_pool');
      // The list may leave out stages; read them per offer when missing.
      for (const o of offers) if (!o.stages.length) {
        const d = await offerDetail(o.id);
        if (d) o.stages = R.normalizeOffers([d])[0].stages;
      }
      return { mode: 'live', offers };
    },
  },
  {
    name: 'list_candidates',
    description: 'Candidates on one vacancy, each with the stage they are in now and whether they were disqualified.',
    inputSchema: { type: 'object', properties: { offer_id: { type: ['number', 'string'], description: 'The vacancy id from list_offers.' } }, required: ['offer_id'] },
    run: async ({ offer_id }) => {
      if (!LIVE) {
        const m = R.mockRecruitee(today());
        const offer = R.normalizeOffers(m.offers).find((o) => String(o.id) === String(offer_id)) || R.normalizeOffers(m.offers)[0];
        return { mode: 'mock', candidates: R.normalizeCandidates({ candidates: m.candidates }, offer.id, offer.stages) };
      }
      const d = await offerDetail(offer_id);
      const stages = d ? R.normalizeOffers([d])[0].stages : [];
      const raw = await allCandidates(offer_id);
      return { mode: 'live', candidates: R.normalizeCandidates(raw, offer_id, stages) };
    },
  },
  {
    name: 'list_interviews',
    description: 'Interviews booked in the Recruitee agenda between two dates (YYYY-MM-DD), with who sits on them. Pass candidate_ids so it can fall back to asking per candidate.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string' },
        to: { type: 'string' },
        candidate_ids: { type: 'array', items: { type: ['number', 'string'] } },
        mock_people: { type: 'array', description: 'Mock mode only: roster people to put on the mock interviews.', items: { type: 'object' } },
      },
    },
    run: async (args) => {
      if (!LIVE) return { mode: 'mock', events: R.normalizeEvents(R.mockRecruitee(today(), args.mock_people || []).events) };
      return { mode: 'live', ...(await interviews(args)) };
    },
  },
  {
    name: 'get',
    description: 'Read any Recruitee API path with GET, for checking what the data looks like. Path starts with a slash, e.g. /offers.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, query: { type: 'object' } }, required: ['path'] },
    run: async ({ path, query }) => {
      if (!/^\/[\w\-/.]*$/.test(path || '')) throw new Error('Path must start with / and contain only letters, digits, - _ . and /');
      if (!LIVE) return { mode: 'mock', note: 'No token yet, so nothing was read.' };
      return { mode: 'live', body: await get(path, query) };
    },
  },
];

// ---------------------------------------------------------------- MCP stdio
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined || id === null) return; // notification
  try {
    if (method === 'initialize') {
      return send({ jsonrpc: '2.0', id, result: { protocolVersion: (params && params.protocolVersion) || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'recruitee', version: '0.1.0' } } });
    }
    if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
    if (method === 'tools/list') {
      return send({ jsonrpc: '2.0', id, result: { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema, annotations: { readOnlyHint: true, openWorldHint: true } })) } });
    }
    if (method === 'tools/call') {
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) return send({ jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool ${params.name}` } });
      try {
        const out = await tool.run(params.arguments || {});
        return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out } });
      } catch (e) {
        const m = e.status ? e.message : `Couldn't reach Recruitee (${e.message}). Check the internet connection.`;
        return send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: m }], structuredContent: { error: m, status: e.status || null } } });
      }
    }
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (e) {
    send({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } });
  }
}
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      continue;
    }
    handle(msg);
  }
});
