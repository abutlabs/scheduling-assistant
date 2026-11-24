# Flux interview scheduling assistant

An internal tool for Flux Partners HR to run interview campaigns: track
candidates through the advisor and team lead rounds, import the monthly
availability poll, and (in later phases) match interviewer pairs, send
Outlook invites and report metrics.

The app is a single page published as a private claude.ai artifact. Its data
lives in the artifact's built-in database, and it uses Claude (through the
page's `sample` capability) to read poll remarks, read candidate availability
and write interview briefs.

## Why this exists

Flux Partners is small, and its people are its strength. Recruiting through
agencies is expensive and keeps the process out of our hands. This app is a
first step toward running recruitment in-house with AI support: fair interview
load across teams, fast turnaround for candidates, and fewer emails for
everyone. It's built to improve through the feedback of the people who use it.

## Trying it out

- **See the app as Admin / Advisor / Team lead** (the name menu at top right, editors only) shows the page
  as an advisor or team lead sees it. Picking a role opens the busiest person
  in that role, and the small menu next to it switches person.
- **Mock** (also in the name menu) fast-forwards the flow. Load demo candidates, then press *Next day*
  or *Skip a week*: colleagues answer requests (accepting when the poll says
  they're free), candidates send availability the day after they're asked, and
  interviewers write feedback the day after the interview. A log shows what
  happened. You play Natalie: book, call and record results from the to-do list.
  Only demo data is touched.

- **Report** (orange-red, top right, every view) sends a screenshot, a note and the app
  context (view, page, build, recent script errors). Editors write straight to
  `reports/`; advisors and team leads send it through their `replies/` doc and
  Natalie's page copies it over. The
  **Developer** view lists them with a status and a *Copy for Claude Code* button
  that turns a report into a ready-to-paste fix request.

## Design

The calm redesign came from Claude Design and is kept in
`design-handoff/from-design/` (tokens, component CSS, the reference canvas and
PNG previews in `preview/`). `src/styles.css` starts with those tokens; the
sheet styles for the poll import, step matrix and roster follow, and the calm
layer at the end applies the design to the top bar, Today, the candidate
drawer, the advisor and team lead home, the welcome card and the Report dialog.
The working screens (Availability and the poll import, Roster, Campaign and
Developer reports) share the same page head and framed sheets, and every fold
opens to real content.

## Campaign structures

Structures live in code (`STRUCTURES` in `src/model.js`). The first is the
**3-round interview**: HR interview with Natalie, an advisor interview (two
advisors from different teams) and a team lead deep dive. Creating a campaign
picks a structure, lets Natalie tune each round's rules and choose who sits in
each round, then gives her an invitation to send. A new structure (for example a
2-round interview) is a new entry there plus its candidate steps.

## Versions

Flux already runs candidates through **Recruitee** (Tellent ATS), so the app
doesn't replace it mid-campaign. It plans who interviews and when.

| Version | What's in it |
| --- | --- |
| **V0 (live now)** | Natalie's admin view only. Availability poll, roster, interviewer pairs from different teams, Outlook requests and holds, fair load, metrics. Candidates and booked interviews come **read-only from Recruitee** through the desktop extension (mock data until a token exists); a light "who needs a pair" form is the fallback. |
| V1 | Polishing the Recruitee sync on real data. |
| V2 | Advisor and team lead pages, then the full candidate file (calls, notes, briefs, Claude advice, step table) as an in-house ATS. |

Later work is hidden, not deleted: the `FEATURES` switches at the top of
`src/app.js` (`recruitee`, `interviewerViews`, `ats`). The Developer view lists
them, and ticking one turns it on in that browser only, to preview it.

In V0 a candidate added by hand follows the short path (`flow: "lite"` in
`M.candidateState`): no calls, no availability-asked step, no close step. A
synced candidate's timeline is derived from its Recruitee stage and the
interviews booked in Recruitee's agenda; Natalie only books pairs for it, and
results come from Recruitee.

## Recruitee sync (read-only)

- `src/recruitee.js` turns Recruitee API JSON into app candidates (shared by the
  page and the extension). Stage names map to rounds by pattern (Dutch and
  English); the Campaign page lets Natalie correct a stage. Interviewers on a
  Recruitee booking are matched to the roster by email, name or alias; anyone
  unmatched is listed on Today so their interviews still count.
- `extension/recruitee/` is a Claude desktop extension (MCP server, no
  dependencies). `npm run pack:extension` writes `dist/recruitee.mcpb`. Natalie
  double-clicks it, pastes a personal API token and the company ID (Recruitee:
  Settings, Apps and plugins, Personal API tokens), and the token stays in the
  keychain. Every call is a GET. Without a token it returns mock data.
- The page calls it as `host:recruitee` (the `mcp` capability) from Natalie's
  page in the desktop app: on open when the last sync is over 15 minutes old,
  and with **Sync now** on Today. Synced candidates are saved under
  `candidates/rc_<recruiteeId>`. In a browser tab, **Use mock data** loads the
  same shapes, marked mock.
- API: `https://api.recruitee.com/c/{company_id}`, `Authorization: Bearer
  <token>`, 1,000 requests a minute. Used: `GET /admin`, `/offers`,
  `/offers/{id}`, `/candidates?offer_id=`, `/interview/events` (falling back to
  `/interview/candidates/{id}/events`). The interview paths and fields aren't in
  the public docs, so the extension's `get` tool is there to check real
  responses once a token exists.

## Phase 1 (built before the Recruitee change; parts now hidden)

- **Campaigns**: the first is Trainee hiring (target 10 hires, about 25 interviews).
  Rounds and scheduling defaults are stored on the campaign.
- **Today** (was Run view): the one next step large on top, then the rest of
  today's to-do list, with coming up folded away and campaign progress beside it.
  Below sits a simple candidate list; the step matrix (one row per candidate, one
  column per step) is one click away.
- **Candidate drawer**: the 11-step timeline from the plan (HR result, availability
  asked and received, advisor interview booked and done, result call, deep dive,
  final call, closed). Any step can be recorded out of order, corrected or removed.
  A reject routes to a call step and then closing. The 1-week clock per round
  starts when availability is asked.
- **Notes and feedback**: Natalie, advisors and team leads can leave notes or
  interview feedback per round. **Interview brief** asks Claude for a summary of
  what matters, colleague notes, what to dig into and questions, optionally
  steered by what the interviewer wants to focus on.
- **Availability import**: drop the poll xlsx. Both tabs are read and shown the
  way the sheet looks. Names are matched to the roster (with fixes for unknown
  names and team clashes), and Claude turns remarks into rules that Natalie
  confirms, edits or dismisses. Saved as a dated snapshot.
- **Roster**: advisors, team leads and the HR joker, with aliases, poll response
  and interview load across campaigns. Each person either uses the app (linked to
  their Claude account in the organization) or takes part without Claude (Outlook
  only), and Natalie can set anyone's half-day availability by hand.
- **Interviewer requests**: from the candidate drawer, pick a slot and ask people
  (different teams first, then free in the poll, then fewest interviews). Replies
  are tracked, the first different-team pair completes the booking, and the to-do
  list prompts to book, release extras, top up after a decline, or chase.
- **Outlook drafts**: asking people, releasing someone and confirming a booking each
  open a filled-in Outlook meeting or email (people, room, time, text) for Natalie to
  send. Rooms have an Outlook address (Campaign, Rooms) so the invite books the room,
  and the app warns when a room is already taken. Replies come in through a provider
  that Mock stands in for until the Microsoft 365 connection exists.
- **Metrics**: the campaign report. Hires and interviews against target, the funnel,
  interviews per week (with the pace needed when the campaign has an end date),
  speed and on-time share per round, request acceptance and reply time, released
  holds, feedback and load per team. *Copy summary* gives a short text for management.
- **Mock sidecar** (test tool, the Mock button): act as any colleague to accept or
  decline requests and leave feedback, answer every waiting request at once, move
  the date to watch clocks run, give everyone mock accounts, and load or clear demo
  candidates. Everything it creates is marked `mock`.

## Layout

| Path | What it is |
| --- | --- |
| `src/model.js` | Data model and pure logic: poll parsing, roster matching, remark rules, candidate state machine, clocks, funnel. No DOM. |
| `src/store.js` | Storage: the artifact database (`db` capability), or browser storage when opened outside claude.ai (test mode). |
| `src/app.js` | The screens. |
| `src/recruitee.js` | Recruitee API normalising, stage-to-round mapping, sync plan, mock data. |
| `extension/recruitee/` | The read-only Recruitee desktop extension (manifest and MCP server). |
| `tools/pack-extension.js` | Packs it into `dist/recruitee.mcpb`. |
| `src/styles.css`, `src/index.html` | Styles and page template. |
| `tools/build.js` | Inlines everything into `dist/index.html`, the file that gets published. |
| `test/model.test.js` | Unit tests for the model (synthetic poll fixture, no real names). |
| `test/e2e/smoke.js` | Browser smoke test with a fake Claude: import, remark review, candidates, notes, brief. |
| `design/` | The UI direction mockups. The chosen one is `d-combined.html`. |
| `docs/data-model.md` | Collections and document shapes. |

## Commands

```sh
npm run build   # writes dist/index.html
npm run pack:extension   # writes dist/recruitee.mcpb
npm test        # unit tests
node test/e2e/smoke.js <poll.xlsx> <xlsx.full.min.js> <screenshot dir>
```

Opening `dist/index.html` directly in a browser runs in test mode: data stays
in that browser and Claude features are hidden.

## Publishing

Publish `dist/index.html` as a claude.ai artifact with these capabilities:

```json
{
  "db": { "rules": [
    { "path": "", "read": "view", "write": "admin" },
    { "path": "candidates", "read": "admin", "write": "admin" },
    { "path": "notes", "read": "admin", "write": "admin" },
    { "path": "invites", "read": "admin", "write": "admin" },
    { "path": "snapshots", "read": "admin", "write": "admin" },
    { "path": "availability", "read": "admin", "write": "admin" },
    { "path": "members", "read": "admin", "write": "owner" },
    { "path": "members/{self}", "read": "view", "write": "interact" },
    { "path": "inbox", "read": "admin", "write": "admin" },
    { "path": "inbox/{self}", "read": "view", "write": "admin" },
    { "path": "replies", "read": "admin", "write": "owner" },
    { "path": "replies/{self}", "read": "view", "write": "interact" },
    { "path": "reports", "read": "admin", "write": "admin" }
  ] },
  "user": { "scopes": ["profile"] },
  "sample": {},
  "mcp": { "servers": [{ "server": "host:recruitee", "tools": ["status", "list_offers", "list_candidates", "list_interviews"] }] }
}
```

Host servers only answer for the artifact's owner, in the Claude desktop app,
so V0 is published from Natalie's account and she installs the extension.

Two views share one page. Editors (Natalie) get the full app. Everyone else
gets the advisor/team lead page: their own requests and interviews (with the
brief), the campaign overview, the scoreboard and the rules. Candidates, notes,
invites and availability are readable by editors only. Natalie's page copies
each linked person's own slice into `inbox/{userId}` and the campaign overview
into `stats/{campaignId}`. Interviewers' answers and feedback go to
`replies/{userId}`. They are applied when Natalie's page is open, and by an
hourly routine on weekdays (8:00 to 18:00 Amsterdam time) that runs
`tools/apply-replies.js` against the live database, so answers and feedback land
without her page open. Both use the same rules (`planReplyWrites` in
`src/model.js`), and applying twice writes nothing new.

Candidate records and notes are readable by editors only. Each person writes
only their own `members/{userId}` doc when they press "I'm in" on the welcome card. Interviewers get
their own access when the interviewer view is built. The page must be published
from a Flux Partners account so Natalie and colleagues in the organization can use it.
