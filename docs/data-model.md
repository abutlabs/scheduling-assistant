# Data model

All collections live in the artifact database at the root.

## campaigns/{id}
`name`, `startDate`, `endDate`, `targetHires`, `targetInterviews`, `archived`, `createdAt`,
`open` (false: only Natalie sees it; advisors and team leads see open campaigns they're part of. Missing counts as open; new campaigns after the first start closed),
`rounds[]` (`key`, `name`, `role`, `interviewers`, `differentTeams`, `durationMin`, `maxDaysAfterPrevious`, `fallbacks`),
`recruitee` (`offerId`, `offerTitle`, `offers[]`, `stages[]`, `stageMap` (stage name to round, Natalie's corrections), `mode` (`live` or `mock`), `syncedAt`, `counts`),
`settings` (invites per slot, reply window, holds per week and so on; used from phase 2). `settings.rooms` is `[{ name, email }]`: the rooms to book, with the room's Outlook address so a meeting draft books the room too.

## people/{id}
The roster, shared by all campaigns. `name`, `team` (TM, PM, CP, OM, P&C), `roles[]` (`advisor`, `teamlead`, `joker`),
`aliases[]` (how the name appears on polls, e.g. "Koen B"), `email`, `active`,
`access` (`app`: uses the app with a linked Claude account; `manual`: Outlook only, Natalie keeps their availability),
`accountId` (the viewer id from the `user` capability, or `mock:<personId>` for a mock account).

## snapshots/{id}
One imported poll. `campaignId`, `fileName`, `pollDate`, `from`, `to`, `importedAt`, `stats`,
`tabs[]`: `sheet`, `role`, `dates[]`, `rows[]` with `personId`, `name`, `team`, `remark`,
`cells` (date → `all` | `am` | `pm` | `no` | null) and `rules[]`.

A rule narrows the poll for some dates: `kind` (`window`, `unavailable`, `tentative`, `note`), `dates[]`, `from`, `to`,
`summary`, `quote`, `source` (`claude` or `manual`), `status` (`confirmed` or `dismissed`).
Blank answers mean unknown, not unavailable.

## candidates/{id}
Synced from Recruitee: id `rc_<recruiteeId>`, plus `source: "recruitee"`, `recruiteeId`, `recruiteeUrl`, `recruiteeStage`,
`recruiteeRound`, `recruiteeDisqualified`, `syncedAt`; timeline entries from Recruitee have `source: "recruitee"` and ids `rc-<step>`.
`flow: "lite"` (V0) follows the short path without calls or a close step.

`campaignId`, `name`, `email`, `phone`, `hrDate`, `notes`, `createdAt`, `timeline[]`,
plus derived `status`, `stage`, `nextStep`, `updatedAt` (recomputed on every save so queries don't replay timelines).

A timeline entry: `id`, `step`, `at` (date), `outcome`, `note`, `data` (`availability`, `slots[]`, `slotDate`, `time`,
`room`, `interviewers[]`, `reason`), `recordedAt`, `voided`. The latest non-voided entry per step counts, so corrections
are new entries and history is kept.

Steps: `hr_done`, `reject_call_hr`, `avail_asked_r2`, `avail_received_r2`, `advisor_booked`, `advisor_done`,
`result_call_r2`, `avail_received_final`, `deepdive_booked`, `deepdive_done`, `final_call`, `closed`.

## invites/{id}
A request asking an interviewer to hold a slot for a candidate's round. `campaignId`, `candidateId`, `round` (`advisor` | `deepdive`),
`personId`, `slotDate`, `time`, `room`, `status` (`pending`, `accepted`, `declined`, `released`, `cancelled`), `sentAt`, `respondedAt`,
`via` (`outlook`, `app`, `mock`), `declineReason`, `releaseReason`, `releasedAt`, `noticeDays`, `mock`.
The pair is the first two accepts from different teams; `M.inviteState` works out who to release, who to chase and how many to top up.

## availability/{personId}
Half-day availability set by hand (by Natalie for people without Claude, or later by the person). `days` (date → value),
`note`, `source`, `updatedAt`, `updatedBy`. It is merged with poll snapshots; the newest answer per person and day wins.

## notes/{id}
`candidateId`, `campaignId`, `round` (`general`, `hr`, `advisor`, `deepdive`), `kind` (`note` or `feedback`), `text`,
`authorId` (viewer id from the `user` capability; names are looked up when shown), `authorPersonId` (roster person, used by the mock sidecar), `mock`, `createdAt`.

## members/{userId}

One doc per Claude account that pressed "I'm in" on the welcome card. The doc id
is the viewer's `user.id()`. Each person can write only their own doc; editors
read them all, and the roster shows "Joined" when a person's linked `accountId`
has a doc here.

| Field | Type | Notes |
| --- | --- | --- |
| acceptedAt | ISO time | When they pressed "I'm in" |
| lang | `en` or `nl` | Language the card was shown in |
| mock | bool | Set by the mock sidecar; removed by "Clear mock data" |

## inbox/{userId}

What one advisor or team lead sees, written by Natalie's page whenever data
changes (only for people whose `accountId` is a real Claude account). Readable
only by that person and editors.

| Field | Notes |
| --- | --- |
| personId, name, team, role | Roster entry |
| requests | Pending invites: id, round, slotDate, time, room, candidate first name |
| interviews | Interviews they sit on (last 4 weeks and upcoming): candidate name, round, slot, partners, feedbackSent, `record` (the brief input: timeline and colleague notes) |
| availability | Next 20 weekdays: `all`, `am`, `pm`, `no` or null |
| scores | Per campaign: their own points, stats, badges, rank overall and in team, nudge |

## replies/{userId}

Written by the interviewer. `invites: {inviteId: {status, reason, at}}` and
`feedback: {key: {candidateId, round, text, at}}`. Natalie's page applies
answers to pending invites (`via: "app"`) and adds feedback as notes with
`replyKey` so nothing is applied twice.

## stats/{campaignId}

Readable by everyone. Campaign name, dates, targets, pipeline counts per stage
(no names), interviews done and in the next 7 days, fair share per person, and
the team board (points per member, interviews, fair share, average reply time,
feedback on time). Individual scores are never in here.

## Scoring

10 points per interview held, 3 for answering a request within 24 hours, 3 for
feedback within a day of the interview. Ties share a rank. Teams are ranked by
points per member.

## campaigns/{id}: structure and people

`structure` names the structure in code (`three-round`). `rounds` holds the
rules per round (`hr`, `advisor`, `deepdive`). `members` maps a round key to the
roster ids chosen for it; a round without an entry is open to everyone eligible
by role. `invited` maps a roster id to when Natalie marked them invited.
`appLink` is the share link pasted into the invitation.

## reports/{id}

A feedback report from the Report button. `kind` (broken, confusing, idea),
`what`, `expected`, `screenshot` (JPEG data URL, about 1100 px wide, or null),
`context` {view, page, drawer, as, campaign, mockDate, build, size, agent,
errors}, `authorId`, `authorName`, `status` (new, seen, fixing, fixed, wontfix),
`createdAt`. Only editors read or write them; reports from advisors and team
leads arrive via `replies/{userId}.reports` (newest 3 kept) and are copied here
by Natalie's page.


## Interview goals

The campaign's hiring goal (`targetHires`) is shared: everyone sees "3 of 10
hired" as our goal. Each advisor and team lead also gets a personal goal of
interviews to take part in (`M.interviewGoals`). Per round the campaign needs
`targetInterviews × interviewers` seats; they are split evenly over that round's
members (the remainder goes to the first by name, with at least 1 each), so if
everyone meets theirs the campaign gets its interviews. `done` counts interviews
held up to today and `planned` the ones after. Each person's `goal`, `goalDone`
and `goalPlanned` travel in their `inbox` scores; Natalie sees everyone's in the
scoreboard.

## Outlook

Until the Flux Microsoft 365 connection exists, the app does not send mail. Asking
people, releasing someone and confirming a booking each open a filled-in draft in
Outlook on the web (`outlookMeetingLink`, `outlookMailLink` in `src/model.js`):
attendees from the roster emails, the room's address, the slot and the text.
Natalie checks it and presses Send.

Replies come in through a provider in `src/app.js` (`outlookProviders`). Each
returns `[{ invite, status, reason, respondedAt, via }]` for the requests it is
given, and `applyOutlookReplies` writes them to `invites`. `manual` reads nothing
(Natalie presses Accepted or Declined), `mock` answers for colleagues following the
poll. An `m365` provider reading meeting responses slots in here later, and
`icsEvent` is ready for sending REQUEST/CANCEL calendar files through it.

`roomsInUse` lists rooms taken around a slot (booked interviews, accepted holds and
waiting requests within the hour), for the clash warning and room suggestions.
