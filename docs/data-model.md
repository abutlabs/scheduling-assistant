# Data model

All collections live in the artifact database at the root.

## campaigns/{id}
`name`, `startDate`, `endDate`, `targetHires`, `targetInterviews`, `archived`, `createdAt`,
`rounds[]` (`key`, `name`, `role`, `interviewers`, `differentTeams`, `durationMin`, `maxDaysAfterPrevious`, `fallbacks`),
`settings` (invites per slot, reply window, holds per week and so on; used from phase 2).

## people/{id}
The roster, shared by all campaigns. `name`, `team` (TM, PM, CP, OM, P&C), `roles[]` (`advisor`, `teamlead`, `joker`),
`aliases[]` (how the name appears on polls, e.g. "Koen B"), `email`, `active`.

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

## notes/{id}
`candidateId`, `campaignId`, `round` (`general`, `hr`, `advisor`, `deepdive`), `kind` (`note` or `feedback`), `text`,
`authorId` (viewer id from the `user` capability; names are looked up when shown), `createdAt`.
