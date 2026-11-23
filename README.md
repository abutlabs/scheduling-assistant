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

## Phase 1 (this branch)

- **Campaigns**: the first is Trainee hiring (target 10 hires, about 25 interviews).
  Rounds and scheduling defaults are stored on the campaign.
- **Run view**: a to-do list of next actions grouped into overdue, today and
  coming up, above a step matrix with one row per candidate and one column per step.
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
| `src/styles.css`, `src/index.html` | Styles and page template. |
| `tools/build.js` | Inlines everything into `dist/index.html`, the file that gets published. |
| `test/model.test.js` | Unit tests for the model (synthetic poll fixture, no real names). |
| `test/e2e/smoke.js` | Browser smoke test with a fake Claude: import, remark review, candidates, notes, brief. |
| `design/` | The UI direction mockups. The chosen one is `d-combined.html`. |
| `docs/data-model.md` | Collections and document shapes. |

## Commands

```sh
npm run build   # writes dist/index.html
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
    { "path": "members", "read": "admin", "write": "owner" },
    { "path": "members/{self}", "read": "view", "write": "interact" }
  ] },
  "user": { "scopes": ["profile"] },
  "sample": {}
}
```

Candidate records and notes are readable by editors only. Each person writes
only their own `members/{userId}` doc when they press "I'm in" on the welcome card. Interviewers get
their own access when the interviewer view is built. The page must be published
from a Flux Partners account so Natalie and colleagues in the organization can use it.
