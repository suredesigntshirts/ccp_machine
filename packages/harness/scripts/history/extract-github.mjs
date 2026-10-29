#!/usr/bin/env node
// E3 (epic #59): the GitHub extractor. Reads one repo's folder of the salvage archive (harness/archive/github/
// <owner>--<repo>/: manifest.json and the gzipped REST pages it lists) and writes, through the shared candidate
// writer (candidates.mjs), one MERGED row per landed PR and one CHECKS_PASSED or CHECKS_FAILED row per completed check
// suite on a PR's head, each recovered, `from` naming the archive ref and page file (ref) and the record in it (line).
// GitHub holds no harness actor, source or release, so each is a legacy placeholder. Each PR goes to its item by the
// store's PR binding (src/pr-binding.js: a branch that names an item filed in the repo's issues, else the Item id line
// of an issue it closes; one PR binds to one item, once), or to "no item" with why. Every page's sha256 is checked
// against the manifest before any is read, and a mismatch refuses the archive, writing nothing. It only reads.
// Rows go to stdout as JSONL; stderr has one line per PR, one per skipped record and the count, each a JSON object.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { join, resolve, sep } from 'node:path';
import { candidates } from './candidates.mjs';
import { prKey, prMap, branchNamesItem } from '../../src/pr-binding.js';
import { combined } from '../../src/github-read.js';
import { requestFromIssue } from '../../src/issue-request.js';

const [dir, ref] = process.argv.slice(2);
if (!dir || !ref) {
  console.error('usage: extract-github.mjs <archive repo dir> <archive ref>');
  process.exit(2);
}
const fail = (msg) => {
  console.error(`extract-github: ${msg}; nothing written`);
  process.exit(1);
};
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

let manifest;
try {
  manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
} catch (e) {
  fail(`${join(dir, 'manifest.json')} cannot be read: ${e.message}`);
}
// Every page the manifest lists, checked (the gzipped bytes and the JSON in them) before any is read.
const root = resolve(dir);
const pages = [];
for (const p of manifest.pages ?? []) {
  const file = resolve(root, String(p.file));
  if (!file.startsWith(root + sep)) fail(`${p.file} is outside ${dir}`);
  if (!p.sha256 || !p.gzSha256) fail(`${p.file}: the manifest holds no sha256 for it`);
  let gz;
  try {
    gz = readFileSync(file);
  } catch {
    fail(`${p.file}: the manifest lists it and the archive does not hold it`);
  }
  if (sha256(gz) !== p.gzSha256) fail(`${p.file}: its bytes' sha256 ${sha256(gz)} is not the manifest's ${p.gzSha256}`);
  const raw = gunzipSync(gz);
  if (sha256(raw) !== p.sha256) fail(`${p.file}: its JSON's sha256 ${sha256(raw)} is not the manifest's ${p.sha256}`);
  pages.push({ ...p, ref: `${ref}/${p.file}`, json: JSON.parse(raw) });
}
const of = (kind) => pages.filter((p) => new RegExp(`^pages/${kind}-\\d+\\.json\\.gz$`).test(p.file)).sort((a, b) => a.file.localeCompare(b.file));

// The PRs, each with where it was read; their count must be the archive's.
const prs = of('pulls').flatMap((page) => page.json.map((p, i) => ({ p, from: { source: 'github', ref: page.ref, line: i + 1 } })));
const listed = of('pulls').reduce((n, page) => n + page.items, 0);
if (prs.length !== listed || (manifest.totals?.pulls ?? listed) !== listed) fail(`the pulls pages hold ${prs.length} PRs, the manifest counts ${listed} (totals.pulls ${manifest.totals?.pulls})`);

// The items filed in the repo's issues (Item id line), by issue number.
const items = new Map();
for (const page of of('issues'))
  for (const i of page.json) {
    if (i.pull_request) continue;
    try {
      items.set(i.number, requestFromIssue(i).id);
    } catch {}
  }
const ids = [...new Set(items.values())];
const CLOSES = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi;
const closes = (body) => [...String(body ?? '').matchAll(CLOSES)].map((m) => Number(m[1]));
// The item each PR names, then bound as the store binds: in the order the PRs were opened, one PR to one item, once.
const named = prs.map(({ p }) => ids.find((id) => branchNamesItem(p.head?.ref, id)) ?? closes(p.body).map((n) => items.get(n)).find(Boolean) ?? null);
const opened = prs.map((_, i) => i).sort((a, b) => String(prs[a].p.created_at).localeCompare(String(prs[b].p.created_at)) || prs[a].p.number - prs[b].p.number);
const bound = prMap(opened.filter((i) => named[i]).map((i) => ({ to: `item:${named[i]}`, event: { pr: prs[i].p.html_url } })));
const boundTo = (item) => Object.keys(bound).find((k) => bound[k] === item);

const out = candidates(ref);
const name = String(manifest.id ?? '').split('/').pop();
const LEGACY = {
  actor: { legacy: "recovered from GitHub's archive: GitHub's record names no harness actor" },
  source: { legacy: "recovered from GitHub's archive: no harness source read it" },
  harness: { legacy: "recovered from GitHub's archive: no harness applied it" },
};
let version = 0;
const write = (from, { id, at, to, event }) => out.write({ id, version: ++version, at, to, ...LEGACY, event }, { origin: 'recovered', from });

let noItem = 0;
prs.forEach(({ p, from }, i) => {
  const pr = p.html_url;
  const key = prKey(pr);
  const item = named[i] && bound[key] === named[i] ? named[i] : null;
  const why = item
    ? undefined
    : named[i]
      ? `item ${named[i]} is bound to ${boundTo(named[i])} (an item's PR is bound once, by the first event naming it)`
      : `branch ${p.head?.ref || '(none)'} names no item filed in this repo's issues (<type>/[<issue>-]<item id>[--<agent>]), and it closes no issue with an Item id line${closes(p.body).length ? ` (it closes ${closes(p.body).map((n) => `#${n}`).join(', ')})` : ''}`;
  if (!item) noItem++;
  out.say({ pr, state: p.merged_at ? 'merged' : p.state, item: item ?? 'no item', ...(why && { why }) });
  const to = item ? `item:${item}` : 'harness';
  if (p.merged_at) write(from, { id: `gh-${name}-pr-${p.number}-merged`, at: p.merged_at, to, event: { type: 'MERGED', pr, sha: p.head?.sha } });

  // CI on the PR's head: the check runs the archive holds for it, one row per completed suite.
  const runPages = of(`check-runs-${p.number}`);
  if (!runPages.length) return;
  const runs = runPages.flatMap((page) => (page.json.check_runs ?? []).map((r, j) => ({ r, ref: page.ref, line: j + 1 })));
  const total = runPages[0].json.total_count ?? runs.length;
  if (runs.length < total) return out.skip({ ref: runPages[0].ref }, `the pages hold ${runs.length} of ${total} check runs: the archive lacks some of this head's CI`);
  const suites = new Map();
  for (const x of runs) {
    if (x.r.head_sha !== p.head?.sha) out.skip({ ref: x.ref, line: x.line }, `check run ${x.r.id} is on ${x.r.head_sha}: not the PR's head ${p.head?.sha}`);
    else if (x.r.check_suite?.id == null) out.skip({ ref: x.ref, line: x.line }, `check run ${x.r.id} names no check suite`);
    else suites.set(x.r.check_suite.id, [...(suites.get(x.r.check_suite.id) ?? []), x]);
  }
  for (const [suite, of] of suites) {
    const open = of.find((x) => x.r.status !== 'completed');
    if (open) {
      out.skip({ ref: open.ref, line: open.line }, `check suite ${suite} is not completed: run ${open.r.id} is ${open.r.status}`);
      continue;
    }
    const type = combined(of.map((x) => x.r)) === 'failure' ? 'CHECKS_FAILED' : 'CHECKS_PASSED';
    const at = of.map((x) => x.r.completed_at).sort().at(-1);
    write({ source: 'github', ref: of[0].ref, line: of[0].line }, { id: `gh-${name}-pr-${p.number}-checks-${suite}`, at, to, event: { type, pr, sha: p.head.sha } });
  }
});
out.done({ prs: prs.length, pulls: listed, noItem });
