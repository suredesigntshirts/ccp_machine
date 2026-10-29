// E3 of epic #59 (#127): the GitHub extractor (scripts/history/extract-github.mjs) reads one repo's folder of the
// salvage archive (harness/archive/github/<owner>--<repo>/: manifest.json and gzipped REST pages) and writes a
// MERGED row per landed PR and a CHECKS_PASSED or CHECKS_FAILED row per completed check suite on a PR head. The
// archive here is built from fixture pages in a temp folder, so the test needs no network and no Library.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate, factKey } from '../src/history.js';
import { tempDir } from './tmp.js';

const SCRIPTS = fileURLToPath(new URL('../scripts/history/', import.meta.url));
const REF = 'github/acme--widgets';
const URL_OF = (n) => `https://github.com/acme/widgets/pull/${n}`;
const H = (c) => c.repeat(40);
const rowsOf = (text) => text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const run = (script, args) => spawnSync(process.execPath, [join(SCRIPTS, script), ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME } });
const sha = (b) => createHash('sha256').update(b).digest('hex');
const shaDir = (dir) => {
  const h = createHash('sha256');
  for (const f of readdirSync(dir, { recursive: true }).sort()) if (statSync(join(dir, f)).isFile()) h.update(`${f}\n`).update(readFileSync(join(dir, f)));
  return h.digest('hex');
};

const pr = (number, ref, head, { merged_at = null, state = 'closed', body = null, created_at } = {}) => ({
  number,
  state,
  html_url: URL_OF(number),
  title: `PR ${number}`,
  body,
  created_at: created_at ?? `2026-10-2${number}T09:00:00Z`,
  merged_at,
  head: { ref, sha: head },
  base: { ref: 'main' },
});
const issue = (number, body) => ({ number, title: `issue ${number}`, body, html_url: `https://github.com/acme/widgets/issues/${number}` });
const runOf = (id, suite, head, status, conclusion, completed_at) => ({ id, name: `job-${id}`, head_sha: head, status, conclusion, completed_at, check_suite: { id: suite } });

// #1 landed by hand on a branch no item names; #2 an item's PR, which the store also holds; #3 closed unlanded, closing
// an issue whose item #2 already bound; #4 open, bound by the issue it closes; #5 an item's PR the store disagrees on.
const PAGES = {
  'issues-001': [
    issue(12, 'Item id: `wip-set`.\n\n## Expect\n\n- a'),
    issue(13, 'Item id: `readme`.\n\n## Expect\n\n- b'),
    issue(14, 'Item id: `other-thing`.\n\n## Expect\n\n- c'),
    issue(15, 'An epic with no item line.'),
    { ...issue(2, 'Item id: `not-an-item`.'), pull_request: { url: 'x' } },
  ],
  'pulls-001': [
    pr(1, 'claude/project-thread-abc', H('1'), { merged_at: '2026-10-21T10:00:00Z' }),
    pr(2, 'feat/12-wip-set', H('2'), { merged_at: '2026-10-22T10:00:00Z' }),
    pr(3, 'fix/12-stale-thing', H('3'), { body: 'Closes #12' }),
  ],
  'pulls-002': [pr(4, 'docs/readme-words', H('4'), { state: 'open', body: 'Some text.\n\nFixes #13' }), pr(5, 'feat/other-thing', H('5'), { merged_at: '2026-10-25T10:00:00Z' })],
  'check-runs-1-001': { total_count: 0, check_runs: [] },
  'check-runs-2-001': {
    total_count: 4,
    check_runs: [
      runOf(21, 100, H('2'), 'completed', 'success', '2026-10-22T09:30:00Z'),
      runOf(22, 100, H('2'), 'completed', 'neutral', '2026-10-22T09:40:00Z'),
      runOf(23, 101, H('2'), 'in_progress', null, null),
      runOf(24, 102, H('9'), 'completed', 'success', '2026-10-22T09:41:00Z'),
    ],
  },
  'check-runs-3-001': { total_count: 1, check_runs: [runOf(31, 200, H('3'), 'completed', 'failure', '2026-10-23T09:30:00Z')] },
  'check-runs-4-001': { total_count: 3, check_runs: [] },
  'check-runs-5-001': { total_count: 1, check_runs: [runOf(51, 300, H('5'), 'completed', 'success', '2026-10-25T09:30:00Z')] },
  'reviews-2-001': [],
};
const API = (file) => {
  const n = /-(\d+)-\d+$/.exec(file)?.[1];
  const head = H(String(n));
  if (file.startsWith('check-runs')) return `https://api.github.com/repos/acme/widgets/commits/${head}/check-runs?per_page=100`;
  if (file.startsWith('reviews')) return `https://api.github.com/repos/acme/widgets/pulls/${n}/reviews?per_page=100`;
  return `https://api.github.com/repos/acme/widgets/${file.replace(/-\d+$/, '')}?state=all&per_page=100&direction=asc`;
};

/** An archive repo folder as the salvage wrote it: pages/<name>.json.gz and manifest.json with each page's sha256. */
function archive(pages = PAGES) {
  const dir = join(tempDir('history-github-'), 'acme--widgets');
  mkdirSync(join(dir, 'pages'), { recursive: true });
  const entries = Object.entries(pages).map(([name, json]) => {
    const raw = Buffer.from(JSON.stringify(json, null, 2));
    const gz = gzipSync(raw);
    writeFileSync(join(dir, 'pages', `${name}.json.gz`), gz);
    return { file: `pages/${name}.json.gz`, url: API(name), items: Array.isArray(json) ? json.length : json.check_runs.length, bytes: raw.length, sha256: sha(raw), gzSha256: sha(gz) };
  });
  const pulls = Object.entries(pages).filter(([n]) => n.startsWith('pulls')).reduce((s, [, j]) => s + j.length, 0);
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ source: 'github', id: 'acme/widgets', fetched_at: '2026-10-28T08:53:35.187Z', pages: entries, totals: { pulls } }, null, 2));
  return dir;
}
const extract = (dir) => {
  const r = run('extract-github.mjs', [dir, REF]);
  const said = rowsOf(r.stderr);
  return { r, rows: rowsOf(r.stdout), prs: said.filter((l) => l.pr), skips: said.filter((l) => l.skip), count: said.at(-1) };
};

test('E3: a landed PR is one MERGED row and a completed suite on its head one CHECKS row, recovered and valid', () => {
  const { r, rows, count } = extract(archive());
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(rows.flatMap(validate), []);
  assert.deepEqual(
    rows.map((x) => [x.event.type, x.event.pr, x.event.sha, x.to, x.at]),
    [
      ['MERGED', URL_OF(1), H('1'), 'harness', '2026-10-21T10:00:00Z'],
      ['MERGED', URL_OF(2), H('2'), 'item:wip-set', '2026-10-22T10:00:00Z'],
      ['CHECKS_PASSED', URL_OF(2), H('2'), 'item:wip-set', '2026-10-22T09:40:00Z'],
      ['CHECKS_FAILED', URL_OF(3), H('3'), 'harness', '2026-10-23T09:30:00Z'],
      ['MERGED', URL_OF(5), H('5'), 'item:other-thing', '2026-10-25T10:00:00Z'],
      ['CHECKS_PASSED', URL_OF(5), H('5'), 'item:other-thing', '2026-10-25T09:30:00Z'],
    ],
  );
  for (const x of rows) {
    assert.equal(x.provenance.origin, 'recovered');
    assert.equal(x.provenance.from.source, 'github');
    // GitHub holds no harness actor, source or release for a recovered row: each is a labelled placeholder.
    assert.deepEqual(x.provenance.placeholders, ['actor', 'source', 'harness']);
    for (const p of x.provenance.placeholders) assert.match(x[p].legacy, /GitHub/);
  }
  // from names the archive ref, the page file and the record in it.
  const merged5 = rows.find((x) => x.event.type === 'MERGED' && x.event.pr === URL_OF(5));
  assert.deepEqual(merged5.provenance.from, { source: 'github', ref: `${REF}/pages/pulls-002.json.gz`, line: 2 });
  const checks2 = rows.find((x) => x.event.type === 'CHECKS_PASSED' && x.event.pr === URL_OF(2));
  assert.deepEqual(checks2.provenance.from, { source: 'github', ref: `${REF}/pages/check-runs-2-001.json.gz`, line: 1 });
  assert.equal(new Set(rows.map((x) => x.id)).size, rows.length, 'ids are unique');
  assert.deepEqual(count, { ref: REF, rows: 6, skips: 3, prs: 5, pulls: 5, noItem: 2 });
});

test('E3: every PR maps to its item by the store\'s PR binding, or to "no item" with why; every skip names its record', () => {
  const { prs, skips } = extract(archive());
  assert.deepEqual(
    prs.map((p) => [p.pr, p.state, p.item]),
    [
      [URL_OF(1), 'merged', 'no item'],
      [URL_OF(2), 'merged', 'wip-set'],
      [URL_OF(3), 'closed', 'no item'],
      [URL_OF(4), 'open', 'readme'],
      [URL_OF(5), 'merged', 'other-thing'],
    ],
  );
  assert.match(prs[0].why, /claude\/project-thread-abc names no item/);
  assert.match(prs[0].why, /closes no issue/);
  // #3 closes #12, whose item #2 bound first: one PR binds to one item, once.
  assert.match(prs[2].why, /wip-set is bound to acme\/widgets#2/);
  assert.equal(prs[1].why, undefined);
  assert.deepEqual(
    skips.map((s) => [s.skip.ref, s.skip.line, s.reason.split(':')[0]]),
    [
      [`${REF}/pages/check-runs-2-001.json.gz`, 3, 'check suite 101 is not completed'],
      [`${REF}/pages/check-runs-2-001.json.gz`, 4, `check run 24 is on ${H('9')}`],
      [`${REF}/pages/check-runs-4-001.json.gz`, undefined, 'the pages hold 0 of 3 check runs'],
    ],
  );
});

test('E3: a page whose bytes do not match the manifest is refused, and nothing is written; the archive is only read', () => {
  const dir = archive();
  const before = shaDir(dir);
  assert.equal(extract(dir).r.status, 0);
  assert.equal(shaDir(dir), before, 'the extractor never writes the archive');
  const page = join(dir, 'pages', 'check-runs-3-001.json.gz');
  writeFileSync(page, gzipSync(Buffer.from(JSON.stringify({ total_count: 1, check_runs: [runOf(31, 200, H('3'), 'completed', 'success', '2026-10-23T09:30:00Z')] }, null, 2))));
  const bad = extract(dir);
  assert.notEqual(bad.r.status, 0);
  assert.equal(bad.r.stdout, '');
  assert.match(bad.r.stderr, /pages\/check-runs-3-001\.json\.gz.*sha256/);
  // The PR count must match the archive's pulls pages: a manifest that counts otherwise is refused too.
  const short = archive();
  const m = JSON.parse(readFileSync(join(short, 'manifest.json'), 'utf8'));
  m.pages.find((p) => p.file === 'pages/pulls-002.json.gz').items = 3;
  writeFileSync(join(short, 'manifest.json'), JSON.stringify(m));
  const miscount = extract(short);
  assert.notEqual(miscount.r.status, 0);
  assert.equal(miscount.r.stdout, '');
  assert.match(miscount.r.stderr, /pulls/);
});

// A store's rows for the same PRs, as the runtime wrote them: CI by the wake's short sha, a merge by the full head.
const STORE = [
  { id: 'req-wip-set', at: '2026-10-21T08:00:00.000Z', to: 'harness', event: { type: 'REQUEST_RECEIVED', request: { id: 'wip-set', title: 'wip' } } },
  { id: 'ci-2-passed', at: '2026-10-22T09:41:00.000Z', to: 'item:wip-set', event: { type: 'CHECKS_PASSED', pr: URL_OF(2), sha: H('2').slice(0, 7) } },
  { id: 'merge-pr2', at: '2026-10-22T10:00:05.000Z', to: 'item:wip-set', event: { type: 'MERGED', pr: URL_OF(2), sha: H('2') } },
  { id: 'merge-pr5', at: '2026-10-25T10:00:05.000Z', to: 'item:other-thing', event: { type: 'MERGED', pr: URL_OF(5), sha: H('6') } },
].map((r, i) => ({ version: i + 1, actor: { kind: 'github', id: 'github' }, source: { kind: 'github-wake', ref: r.id }, harness: { version: '0.8.0', commit: null }, ...r }));

test('E3 with E1: the join keeps one row per merge and checks fact, the store\'s, with GitHub in also; it reports a conflict', () => {
  const tmp = tempDir('history-github-join-');
  mkdirSync(join(tmp, 'store'));
  writeFileSync(join(tmp, 'store', 'events.jsonl'), STORE.map((r) => JSON.stringify(r) + '\n').join(''));
  const e1 = run('extract-store.mjs', [join(tmp, 'store'), 'library/harness/state/fixture/events.jsonl']);
  assert.equal(e1.status, 0, e1.stderr);
  const e3 = run('extract-github.mjs', [archive(), REF]);
  assert.equal(e3.status, 0, e3.stderr);
  writeFileSync(join(tmp, 'e1.jsonl'), e1.stdout);
  writeFileSync(join(tmp, 'e3.jsonl'), e3.stdout);
  const out = join(tmp, 'out');
  const j = run('join.mjs', [join(tmp, 'e1.jsonl'), join(tmp, 'e3.jsonl'), '--out', out]);
  assert.equal(j.status, 0, j.stderr);
  const history = rowsOf(readFileSync(join(out, 'events.jsonl'), 'utf8'));
  const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'));
  const facts = (type) => history.filter((r) => r.event.type === type).map((r) => [r.event.pr, r.id, r.provenance.from.source, (r.provenance.also ?? []).map((f) => f.source)]);
  assert.deepEqual(facts('MERGED'), [
    // Landed outside any store: GitHub's record is the only one, a recovered row.
    [URL_OF(1), 'gh-widgets-pr-1-merged', 'github', []],
    [URL_OF(2), 'merge-pr2', 'store', ['github']],
    [URL_OF(5), 'merge-pr5', 'store', ['github']],
  ]);
  assert.equal(history.find((r) => r.event.pr === URL_OF(1)).provenance.origin, 'recovered');
  // The store names a head by its short sha, GitHub by the full one: one fact.
  assert.deepEqual(facts('CHECKS_PASSED'), [
    [URL_OF(2), 'ci-2-passed', 'store', ['github']],
    [URL_OF(5), 'gh-widgets-pr-5-checks-300', 'github', []],
  ]);
  assert.deepEqual(facts('CHECKS_FAILED'), [[URL_OF(3), 'gh-widgets-pr-3-checks-200', 'github', []]]);
  // The store and GitHub disagree on the head #5 landed at: reported, never merged silently.
  assert.deepEqual(report.conflicts.map((c) => [c.fact, c.field, c.kept, c.other]), [[`merge:${URL_OF(5)}`, 'event.sha', 'merge-pr5', 'gh-widgets-pr-5-merged']]);
});

test('C4: a checks fact keys the head by its short sha, so the store\'s CI row and GitHub\'s are one fact', () => {
  const at = '2026-10-22T09:41:00.000Z';
  const prov = (source) => ({ origin: source === 'store' ? 'migrated' : 'recovered', from: { source, ref: source } });
  const store = { id: 's', at, event: { type: 'CHECKS_PASSED', pr: URL_OF(2), sha: H('2').slice(0, 7) }, provenance: prov('store') };
  const gh = { id: 'g', at, event: { type: 'CHECKS_PASSED', pr: URL_OF(2), sha: H('2') }, provenance: prov('github') };
  assert.equal(factKey(store), factKey(gh));
  assert.notEqual(factKey(gh), factKey({ ...gh, event: { ...gh.event, sha: H('3') } }));
});

test('E1 and E3 share one candidate writer: both extractors turn records into rows through it', () => {
  for (const script of ['extract-store.mjs', 'extract-github.mjs']) assert.match(readFileSync(join(SCRIPTS, script), 'utf8'), /from '\.\/candidates\.mjs'/, script);
});
