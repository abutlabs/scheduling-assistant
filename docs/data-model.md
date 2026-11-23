# Data model

All collections live in the artifact database at the root.

## campaigns/{id}
`name`, `startDate`, `endDate`, `targetHires`, `targetInterviews`, `archived`, `createdAt`,
`rounds[]` (`key`, `name`, `role`, `interviewers`, `differentTeams`, `durationMin`, `maxDaysAfterPrevious`, `fallbacks`),
`settings` (invites per slot, reply window, holds per week and so on; used from phase 2).

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

