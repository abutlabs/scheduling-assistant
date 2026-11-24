#!/usr/bin/env node
// Plans the database writes that apply interviewers' answers, feedback and
// reports (replies/{accountId}) without Natalie's page being open. Used by the
// hourly routine; the rules are M.planReplyWrites, shared with the app.
//
//   node tools/apply-replies.js <db dir>
//
// <db dir> holds the collections as saved by ArtifactData list with out_dir:
// <db dir>/<collection>/<doc id>.json, for replies, people, invites,
// candidates, notes and reports. Paste the text of the invites listing into
// <db dir>/invites.list.txt so updates can be pinned to the version read
// ('"in_abc"  812 bytes  version 4'). Prints { writes: [[...≤50], ...], summary }.
const fs = require('fs');
const path = require('path');
const M = require('../src/model.js');

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node tools/apply-replies.js <db dir>');
  process.exit(2);
}
const load = (coll) => {
  const d = path.join(dir, coll);
  if (!fs.existsSync(d)) return [];
  return fs
    .readdirSync(d)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ id: f.slice(0, -5), ...JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')) }));
};
const versions = (coll) => {
  const f = path.join(dir, `${coll}.list.txt`);
  const out = {};
  if (!fs.existsSync(f)) return out;
  for (const m of fs.readFileSync(f, 'utf8').matchAll(/"([^"]+)"[^\n]*?version (\d+)/g)) out[m[1]] = Number(m[2]);
  return out;
};

const db = Object.fromEntries(['replies', 'people', 'invites', 'candidates', 'notes', 'reports'].map((c) => [c, load(c)]));
const writes = M.planReplyWrites({ ...db, now: new Date().toISOString() });
const inviteVersions = versions('invites');
const missing = [];
for (const w of writes) {
  if (w.op !== 'update') continue;
  const v = inviteVersions[w.doc_id];
  if (v) w.if_version = v;
  else missing.push(w.doc_id);
}
const chunks = [];
for (let i = 0; i < writes.length; i += 50) chunks.push(writes.slice(i, i + 50));
const count = (coll) => writes.filter((w) => w.collection === coll).length;
console.log(
  JSON.stringify(
    {
      summary: `${count('invites')} answers, ${count('notes')} feedback notes, ${count('reports')} reports`,
      missingVersions: missing,
      writes: chunks,
    },
    null,
    2,
  ),
);
