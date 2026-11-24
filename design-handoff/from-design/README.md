# Flux Interviews · calm redesign (from Claude Design)

- `tokens.css` — colour (light + dark), type scale, spacing, radius. Replaces the old tokens.
- `calm.css` — component styles using the existing class names from `src/styles.css` where possible. New classes: `.act-hero`, `.test-pill`, `.track`, `.drawer`, `.step`, `.brief`, `.iv-request`, `.rank`, `.pill-ok`, `.dialog`, `.choice`.
- `Flux Interviews Calm.dc.html` (project root) — the reference screens: Natalie home, advisor home, candidate drawer, welcome, report dialog; desktop + phone, light + dark; token sheet.

## Structural changes for app.js
1. "Run view" → "Today".
2. Test-mode banner → `.test-pill` in the bar. View switcher and Mock → name menu at top right.
3. Report button moves from the floating FAB into the top bar (`.report-btn`) on every view. Welcome copy: "press Report (top right)".
4. Natalie home: first action renders as `.act-hero` with a primary button; remaining actions under "Then"; progress in a right aside (stacks on phone).
5. Advisor home: open request is the hero; score, team board, numbers, availability and "how interviews are planned" fold into `<details>`.
6. Drawer: next-step block on top; done steps fold into one line; future steps beyond the next two fold away; brief and notes below.
7. Welcome: third paragraph (Claude app + Report) folds into a disclosure.
8. Report dialog: "What did you expect?" is a disclosure; Send is the primary button.
