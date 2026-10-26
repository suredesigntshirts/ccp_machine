import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, cpSync, chmodSync, statSync, symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  planMigration, applyMigration, formatPlan, planToJson, parseLegacyIndex, destinationFor,
} from '../lib/store/migrate.mjs';
import { parseFrontMatter } from '../lib/store/frontmatter.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS_CLI = join(HERE, '..', 'docs.mjs');
const CRASH = join(HERE, 'helpers', 'migrate-crash.mjs');
const FIXTURE = '/home/user/fixtures/harempants-docs';

let tmp;
before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dd-migrate-'));
  process.env.DD_MACHINE_DIR = join(tmp, 'machine');
});
after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;

const LONG = 'This page documents the widget API in enough words to be real content, not a stub. '.repeat(5);
const page = (fm, body = `# Title\n\n${LONG}\n`) => `---\n${fm}\n---\n\n${body}`;

/** A small v1 cache exercising every migration rule. */
const V1_TREE = {
  'llms.txt': [
    '# Documentation index',
    '',
    '## example.com',
    '',
    '- docs/example.com/guide.md: Example guide — how to configure the widget',
    '- /home/someone-else/proj/docs/example.com/api.md: Widget API reference — every endpoint and field',
    '- docs/example.com/has-desc.md: Index description that must not override the page',
    '- docs/example.com/bad.md: bad',
    '- docs/example.com/challenge.md: Widget challenge page description',
    '- docs/example.com.md: Example home page overview',
    '- docs/google/support/ads/answer/123.md: Structured snippet assets help article',
    '- docs/notes/handwritten.md: My own notes about the widget',
    '',
    '  A hand-written note under an entry.',
    '',
  ].join('\n'),
  'example.com/guide.md': page('Source: https://example.com/guide\nGenerated: 2026-01-01\nUpdated: 2026-01-02'),
  'example.com/api.md': page('Source: https://example.com/api\nGenerated: 2026-01-01\nUpdated: 2026-01-01'),
  'example.com/has-desc.md': page('Source: https://example.com/has-desc\nGenerated: 2026-01-01\nUpdated: 2026-01-01\ndescription: The page\'s own description'),
  'example.com/bad.md': page('Source: https://example.com/bad\nGenerated: 2026-01-01\nUpdated: 2026-01-01'),
  'example.com/challenge.md': page('Source: https://example.com/challenge\nGenerated: 2026-01-01\nUpdated: 2026-01-01', '# Just a moment...\n'),
  'example.com.md': page('Source: https://example.com/\nGenerated: 2026-01-01\nUpdated: 2026-01-01'),
  'google/support/ads/answer/123.md': page('Source: https://support.google.com/ads/answer/123\nGenerated: 2026-01-01\nUpdated: 2026-01-01'),
  'google/llms.txt': '- google/support/ads/answer/123.md: sub index\n',
  'example.com/stacked.md': `---\nSource: https://example.com/stacked\nGenerated: 2026-01-01\nUpdated: 2026-01-01\n---\n\n---\ntitle: "Stacked"\ndescription: Upstream description\n---\n\n# Stacked\n\n${LONG}\n`,
  'example.com/dup.md': page('Source: https://example.com/dup\nGenerated: 2026-01-01\nUpdated: 2026-01-01', `# Old dup\n\n${LONG}\n`),
  'old-layout/dup-copy.md': page('Source: https://example.com/dup\nGenerated: 2026-05-05\nUpdated: 2026-05-05', `# New dup\n\n${LONG}\n`),
  'new.example.com/moved.md': page('Source: https://old.example.com/moved\nGenerated: 2026-01-01\nUpdated: 2026-01-01'),
  'example.com/Some%20Page.md': page('Source: https://example.com/Some%20Page\nGenerated: 2026-01-01\nUpdated: 2026-01-01'),
  'react.example.md': page('Source: https://old-react.example/\nGenerated: 2026-01-01\nUpdated: 2026-01-01'),
  'example.com/weird.md': page('Source: not-a-url\nGenerated: 2026-01-01'),
  'example.com/nosrc.md': page('title: No source here'),
  'notes/handwritten.md': '# My notes\n\nNot from the skill.\n',
  'CLAUDE.md': '# docs/ is a cache\n',
  'example.com/image.png': 'PNGDATA',
};

function makeTree(files, name = `proj-${++n}`) {
  const proj = join(tmp, name);
  for (const [rel, content] of Object.entries(files)) {
    const p = join(proj, 'docs', rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return { proj, from: join(proj, 'docs'), to: join(proj, 'external-docs') };
}

/** relPath → sha256 of every file under dir (lock dirs and the timestamped journal excluded). */
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const rel = relative(dir, p).split(sep).join('/');
      if (e.isDirectory()) { if (!rel.startsWith('.cache/locks')) walk(p); }
      else if (rel !== '.cache/legacy/migrated.jsonl') out[rel] = createHash('sha256').update(readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

const read = (p) => readFileSync(p, 'utf-8');

describe('planMigration (dry run)', () => {
  test('changes nothing on disk and classifies every file', async () => {
    const { from, to } = makeTree(V1_TREE);
    const before = snapshot(from);
    const plan = await planMigration({ from, to });
    assert.deepEqual(snapshot(from), before);
    assert.equal(existsSync(to), false);

    const moves = Object.fromEntries(plan.moves.map(m => [m.from, m]));
    assert.deepEqual(Object.keys(moves).sort(), [
      'example.com.md', 'example.com/Some%20Page.md', 'example.com/api.md', 'example.com/bad.md', 'example.com/challenge.md',
      'example.com/guide.md', 'example.com/has-desc.md', 'example.com/stacked.md',
      'google/support/ads/answer/123.md', 'new.example.com/moved.md', 'old-layout/dup-copy.md', 'react.example.md',
    ]);
    // Paths follow the final URL: URL-shaped old paths are kept (even when Source
    // redirected elsewhere); only root pages and non-URL layouts are re-pathed.
    assert.equal(moves['example.com.md'].to, 'example.com/index.md');
    assert.equal(moves['example.com.md'].relocated, 'root-page');
    assert.equal(moves['react.example.md'].to, 'react.example/index.md', 'root page: host from the file name');
    assert.equal(moves['react.example.md'].redirected, true);
    assert.equal(moves['example.com/Some%20Page.md'].to, 'example.com/Some Page.md');
    assert.equal(moves['example.com/Some%20Page.md'].relocated, 'normalised');
    assert.equal(moves['google/support/ads/answer/123.md'].to, 'support.google.com/ads/answer/123.md');
    assert.equal(moves['google/support/ads/answer/123.md'].relocated, 'non-url-path');
    assert.equal(moves['new.example.com/moved.md'].to, 'new.example.com/moved.md');
    assert.equal(moves['new.example.com/moved.md'].relocated, null);
    assert.equal(moves['new.example.com/moved.md'].redirected, true);
    assert.equal(moves['example.com/guide.md'].relocated, null);
    assert.equal(moves['example.com/guide.md'].redirected, false);
    assert.equal(plan.counts.redirectedKeptPath, 2);
    assert.deepEqual(plan.counts.relocatedByKind, { 'root-page': 2, normalised: 1, 'non-url-path': 2 });

    const skipped = Object.fromEntries(plan.skipped.map(s => [s.path, s.reason]));
    assert.deepEqual(skipped, {
      'CLAUDE.md': 'agent-instructions',
      'example.com/dup.md': 'collision-older',
      'example.com/image.png': 'not-markdown',
      'example.com/nosrc.md': 'no-source',
      'example.com/weird.md': 'invalid-source',
      'google/llms.txt': 'sub-index',
      'notes/handwritten.md': 'no-front-matter',
    });

    // Collision: newest Updated wins even from a non-URL-shaped path.
    assert.deepEqual(plan.collisions, [{
      to: 'example.com/dup.md',
      winner: { from: 'old-layout/dup-copy.md', updated: '2026-05-05' },
      losers: [{ from: 'example.com/dup.md', updated: '2026-01-01', source: 'https://example.com/dup' }],
    }]);

    // Descriptions: carried when good and the page has none (absolute-path entries too).
    assert.equal(moves['example.com/guide.md'].carriedDescription, 'Example guide — how to configure the widget');
    assert.equal(moves['example.com/api.md'].carriedDescription, 'Widget API reference — every endpoint and field');
    assert.equal(moves['example.com.md'].carriedDescription, 'Example home page overview');
    assert.equal(moves['example.com/has-desc.md'].carriedDescription, null);
    assert.equal(moves['example.com/bad.md'].carriedDescription, null);
    assert.equal(moves['example.com/challenge.md'].carriedDescription, null, 'not onto a bad page');
    assert.deepEqual(plan.rejectedDescriptions.map(r => [r.from, r.reason]).sort(), [
      ['example.com/bad.md', 'single_word'],
      ['example.com/challenge.md', 'page flagged interstitial'],
    ]);

    assert.deepEqual(plan.badPages.map(b => [b.from, b.reason]), [['example.com/challenge.md', 'interstitial']]);
    assert.equal(moves['example.com/stacked.md'].mergedStackedFrontMatter, true);

    // The v1 index still lists a file that won't move, so it stays.
    assert.equal(plan.legacyIndex.willRetire, false);
    assert.deepEqual(plan.legacyIndex.unmigratedEntries.map(e => [e.path, e.why]),
      [['docs/notes/handwritten.md', 'no-front-matter']]);
    assert.equal(plan.legacyIndex.notes, 1);

    assert.deepEqual(plan.counts.skippedByReason, {
      'agent-instructions': 1, 'collision-older': 1, 'not-markdown': 1, 'no-source': 1,
      'invalid-source': 1, 'sub-index': 1, 'no-front-matter': 1,
    });
    const text = formatPlan(plan);
    assert.match(text, /dry run/);
    assert.match(text, /collisions\s+1/);
    assert.match(text, /notes\/handwritten\.md/);
    assert.ok(!('out' in planToJson(plan).moves[0]), 'JSON plan carries no file contents');
  });
});

describe('applyMigration', () => {
  test('moves, rewrites only what needs it, leaves the rest, and is idempotent', async () => {
    const { from, to } = makeTree(V1_TREE);
    const res = await applyMigration({ from, to });
    assert.deepEqual(res.applied.errors, []);
    assert.equal(res.applied.moved, 12);

    // Verbatim when nothing needs changing.
    assert.equal(read(join(to, 'example.com/has-desc.md')), V1_TREE['example.com/has-desc.md']);
    // A redirected page keeps its path and its Source (the requested URL); no Final.
    assert.equal(read(join(to, 'new.example.com/moved.md')), V1_TREE['new.example.com/moved.md']);
    assert.ok(existsSync(join(to, 'example.com/Some Page.md')));
    // Carried description, provenance untouched.
    const guide = parseFrontMatter(read(join(to, 'example.com/guide.md'))).data;
    assert.deepEqual(guide, {
      Source: 'https://example.com/guide', Generated: '2026-01-01', Updated: '2026-01-02',
      description: 'Example guide — how to configure the widget',
    });
    // Stacked blocks merged into one.
    const stacked = read(join(to, 'example.com/stacked.md'));
    assert.equal(stacked.match(/^---$/gm).length, 2);
    assert.equal(parseFrontMatter(stacked).data.title, 'Stacked');
    assert.equal(parseFrontMatter(stacked).data.description, 'Upstream description');
    // Collision winner's content.
    assert.match(read(join(to, 'example.com/dup.md')), /# New dup/);
    assert.ok(existsSync(join(to, 'example.com/index.md')));
    assert.ok(existsSync(join(to, 'support.google.com/ads/answer/123.md')));
    // Bad page moved, not deleted.
    assert.ok(existsSync(join(to, 'example.com/challenge.md')));

    // Left in place: exactly the skipped files plus the v1 index.
    assert.deepEqual(Object.keys(snapshot(from)).sort(), [
      'CLAUDE.md', 'example.com/dup.md', 'example.com/image.png', 'example.com/nosrc.md',
      'example.com/weird.md', 'google/llms.txt', 'llms.txt', 'notes/handwritten.md',
    ]);
    assert.ok(!existsSync(join(from, 'google/support')), 'emptied directories pruned');
    assert.ok(!existsSync(join(from, 'old-layout')));
    assert.ok(existsSync(join(to, '.docs-cache.json')));
    assert.equal(res.applied.retiredIndex, false);

    // Re-run: a no-op.
    const snapFrom = snapshot(from), snapTo = snapshot(to);
    const again = await applyMigration({ from, to });
    assert.equal(again.moves.length, 0);
    assert.equal(again.applied.moved, 0);
    assert.equal(again.previouslyMigrated, 12);
    assert.deepEqual(snapshot(from), snapFrom);
    assert.deepEqual(snapshot(to), snapTo);
    assert.deepEqual(again.skipped.find(x => x.path === 'example.com/dup.md')?.reason, 'collision-older');
  });

  test('retires the v1 llms.txt to .cache/legacy/ once every entry was migrated', async () => {
    const files = {
      'llms.txt': '## example.com\n\n- docs/example.com/guide.md: Example guide — configuring widgets\n- /elsewhere/docs/example.com/api.md: API\n',
      'example.com/guide.md': V1_TREE['example.com/guide.md'],
      'example.com/api.md': V1_TREE['example.com/api.md'],
      'CLAUDE.md': 'not a page',
    };
    const { from, to } = makeTree(files);
    const plan = await planMigration({ from, to });
    assert.equal(plan.legacyIndex.willRetire, true);
    const res = await applyMigration({ from, to });
    assert.equal(res.applied.retiredIndex, true);
    assert.equal(read(join(to, '.cache/legacy/llms.txt')), files['llms.txt']);
    assert.ok(!existsSync(join(from, 'llms.txt')));
    assert.ok(existsSync(join(from, 'CLAUDE.md')));

    const again = await applyMigration({ from, to });
    assert.equal(again.legacyIndex, null);
    assert.equal(again.retiredIndexExists, true);
    assert.match(formatPlan(again), /already retired/);
  });

  test('a destination that already holds a different version is never overwritten', async () => {
    const { from, to } = makeTree({ 'example.com/guide.md': V1_TREE['example.com/guide.md'] });
    mkdirSync(join(to, 'example.com'), { recursive: true });
    writeFileSync(join(to, 'example.com/guide.md'), 'v2 content');
    const res = await applyMigration({ from, to });
    assert.equal(res.applied.moved, 0);
    assert.deepEqual(res.skipped.map(s => s.reason), ['destination-exists']);
    assert.equal(read(join(to, 'example.com/guide.md')), 'v2 content');
    assert.ok(existsSync(join(from, 'example.com/guide.md')));
  });

  test('an interrupted run (error after copy, before removal) is completed by re-running', async () => {
    const clean = makeTree(V1_TREE);
    await applyMigration(clean);

    const { from, to } = makeTree(V1_TREE);
    let copies = 0;
    await assert.rejects(applyMigration({
      from, to,
      hooks: { rethrow: true, afterCopy: () => { if (++copies === 3) throw new Error('simulated crash'); } },
    }), /simulated crash/);
    const mid = await planMigration({ from, to });
    assert.equal(mid.counts.alreadyCopied, 1, 'the half-moved page is recognised');
    assert.equal(mid.moves.length, 10);

    await applyMigration({ from, to });
    assert.deepEqual(snapshot(from), snapshot(clean.from));
    assert.deepEqual(snapshot(to), snapshot(clean.to));
  });

  test('a SIGKILLed run leaves no half-moved page and is completed by re-running', async () => {
    const clean = makeTree(V1_TREE);
    await applyMigration(clean);

    const { from, to } = makeTree(V1_TREE);
    const r = spawnSync(process.execPath, [CRASH, from, to, '4'], { env: { ...process.env } });
    assert.equal(r.signal, 'SIGKILL', r.stderr?.toString());
    // Every page exists whole somewhere: original, copy, or both identical.
    const mid = await planMigration({ from, to });
    assert.equal(mid.counts.alreadyCopied, 1);
    assert.equal(mid.moves.length + mid.previouslyMigrated, 12);

    // The dead process's locks are still on disk; they go stale and are reclaimed.
    const prev = process.env.DD_LOCK_STALE_MS;
    process.env.DD_LOCK_STALE_MS = '2000';
    try {
      await applyMigration({ from, to });
    } finally {
      if (prev === undefined) delete process.env.DD_LOCK_STALE_MS; else process.env.DD_LOCK_STALE_MS = prev;
    }
    assert.deepEqual(snapshot(from), snapshot(clean.from));
    assert.deepEqual(snapshot(to), snapshot(clean.to));
  });

  test('refuses nonsense directories', async () => {
    const { from } = makeTree({ 'a.md': 'x' });
    await assert.rejects(planMigration({ from, to: from }), /same directory/);
    await assert.rejects(planMigration({ from: join(tmp, 'missing'), to: join(tmp, 'x') }), /does not exist/);
  });
});

describe('helpers', () => {
  test('parseLegacyIndex: entries with relative and absolute paths, notes counted', () => {
    const { entries, notes } = parseLegacyIndex('# T\n\n## d\n\n- docs/a/b.md: Desc: with colon\n- /abs/docs/c.md: X\n- docs/sub/llms.txt: idx\nfree text\n');
    assert.deepEqual(entries.map(e => [e.path, e.description]), [
      ['docs/a/b.md', 'Desc: with colon'], ['/abs/docs/c.md', 'X'], ['docs/sub/llms.txt', 'idx'],
    ]);
    assert.equal(notes, 1);
  });

  test('destinationFor: path follows the final URL v1 encoded in the old path', () => {
    const d = (from, src) => destinationFor(from, src);
    assert.deepEqual(d('a.com/x.md', 'https://a.com/x'), { to: 'a.com/x.md', kind: null, redirected: false });
    assert.deepEqual(d('code.claude.com/docs/a.md', 'https://platform.claude.com/docs/a'),
      { to: 'code.claude.com/docs/a.md', kind: null, redirected: true });
    assert.deepEqual(d('fly.io.md', 'http://fly.io/'), { to: 'fly.io/index.md', kind: 'root-page', redirected: false });
    assert.deepEqual(d('react.dev.md', 'https://reactjs.org/'), { to: 'react.dev/index.md', kind: 'root-page', redirected: true });
    assert.deepEqual(d('google/support/x/1.md', 'https://support.google.com/x/1'),
      { to: 'support.google.com/x/1.md', kind: 'non-url-path', redirected: false });
    assert.deepEqual(d('google-search-console/q.md', 'https://developers.google.com/q'),
      { to: 'developers.google.com/q.md', kind: 'non-url-path', redirected: false });
    assert.deepEqual(d('l.io/en/A%20b.md', 'https://l.io/en/A%20b'), { to: 'l.io/en/A b.md', kind: 'normalised', redirected: false });
    assert.equal(d('l.io/bad%zz.md', 'https://l.io/x').to, 'l.io/bad%zz.md', 'malformed escape: old spelling kept');
  });
});

describe('docs migrate CLI', () => {
  test('defaults to docs/ → external-docs/, dry run, --json, --apply, usage errors', () => {
    const { proj, from, to } = makeTree(V1_TREE);
    const env = { ...process.env, DD_DOCS_ROOT: '' };
    const dry = spawnSync(process.execPath, [DOCS_CLI, 'migrate', '--json'], { cwd: proj, env, encoding: 'utf-8' });
    assert.equal(dry.status, 0, dry.stderr);
    const plan = JSON.parse(dry.stdout);
    assert.equal(plan.counts.moves, 12);
    assert.equal(plan.to, to);
    assert.equal(existsSync(to), false);

    const applied = spawnSync(process.execPath, [DOCS_CLI, 'migrate', '--apply'], { cwd: proj, env, encoding: 'utf-8' });
    assert.equal(applied.status, 0, applied.stderr);
    assert.match(applied.stdout, /^Migrated docs\/ → external-docs\//);
    assert.ok(existsSync(join(to, 'example.com/guide.md')));
    assert.ok(existsSync(join(from, 'CLAUDE.md')));

    const bad = spawnSync(process.execPath, [DOCS_CLI, 'migrate', '--bogus'], { cwd: proj, env, encoding: 'utf-8' });
    assert.equal(bad.status, 2);
  });
});

describe('docs migrate --apply splits every large page in the root', () => {
  test('interrupted migration then re-run → all large pages split, not just the re-run\'s moves', async () => {
    const bigBody = (name) => `# ${name}\n\n${Array.from({ length: 8 }, (_, i) =>
      `## Part ${i + 1}\n\n${`${name} words of real documentation. `.repeat(400)}\n\n`).join('')}`;
    const files = Object.fromEntries(['one', 'two', 'three'].map(name =>
      [`example.com/${name}.md`, page(`Source: https://example.com/${name}\nGenerated: 2026-01-01\nUpdated: 2026-01-01`, bigBody(name))]));
    files['example.com/small.md'] = V1_TREE['example.com/guide.md'];
    const { proj, from, to } = makeTree(files);

    // First run dies after its second copy: `one` is fully moved, the rest are not.
    let copies = 0;
    await assert.rejects(applyMigration({
      from, to, hooks: { rethrow: true, afterCopy: () => { if (++copies === 2) throw new Error('simulated crash'); } },
    }), /simulated crash/);
    assert.ok(existsSync(join(to, 'example.com/one.md')) && !existsSync(join(from, 'example.com/one.md')));

    const env = { ...process.env, DD_DOCS_ROOT: '' };
    const r = spawnSync(process.execPath, [DOCS_CLI, 'migrate', '--apply', '--json'], { cwd: proj, env, encoding: 'utf-8' });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out.post.split.map(s => s.page).sort(),
      ['example.com/one.md', 'example.com/three.md', 'example.com/two.md']);
    for (const name of ['one', 'two', 'three']) {
      const index = read(join(to, `example.com/${name}.md`));
      assert.match(index, /^Parts: \d+$/m, `${name} is an index`);
      assert.ok(readdirSync(join(to, `example.com/${name}.parts`)).length >= 2);
    }
    assert.doesNotMatch(read(join(to, 'example.com/small.md')), /^Parts:/m);
    assert.equal(out.post.indexed, true);
  });
});

describe('real v1 cache fixture', { skip: !existsSync(FIXTURE) && 'fixture not present on this machine' }, () => {
  test('harempants-docs: plan numbers, apply, idempotent', { timeout: 120_000 }, async () => {
    const proj = join(tmp, 'fixture');
    cpSync(FIXTURE, join(proj, 'docs'), { recursive: true });
    const makeWritable = (d) => {
      chmodSync(d, 0o755);
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) makeWritable(p); else chmodSync(p, 0o644);
      }
    };
    makeWritable(join(proj, 'docs'));
    const from = join(proj, 'docs'), to = join(proj, 'external-docs');

    const plan = await planMigration({ from, to });
    assert.equal(plan.counts.moves, 506);
    assert.equal(plan.counts.skipped, 21);
    assert.deepEqual(plan.counts.skippedByReason, { 'no-front-matter': 18, 'no-source': 1, 'agent-instructions': 1, 'sub-index': 1 });
    assert.equal(plan.counts.collisions, 0);
    assert.equal(plan.counts.carriedDescriptions, 315);
    assert.deepEqual(plan.counts.relocatedByKind, { 'root-page': 4, 'non-url-path': 27, normalised: 1 });
    assert.equal(plan.counts.redirectedKeptPath, 61);
    assert.equal(plan.counts.mergedStackedFrontMatter, 60);
    assert.equal(plan.counts.badPages, 6);
    assert.equal(plan.legacyIndex.entries.length, 461);
    assert.equal(plan.legacyIndex.willRetire, false);

    const res = await applyMigration({ from, to });
    assert.deepEqual(res.applied.errors, []);
    assert.equal(res.applied.moved, 506);
    const snap = snapshot(to);
    const again = await applyMigration({ from, to });
    assert.equal(again.applied.moved, 0);
    assert.deepEqual(snapshot(to), snap);
    assert.ok(statSync(join(from, 'llms.txt')).isFile(), 'v1 index kept: some entries point at unmigrated files');
  });
});

describe('migrate never deletes the only copy', () => {
  const tree = () => ({
    'example.com/guide.md': V1_TREE['example.com/guide.md'],
    'example.com/api.md': V1_TREE['example.com/api.md'],
  });

  test('--to is a symlink to --from: refused, nothing touched', async () => {
    const { proj, from } = makeTree(tree());
    const to = join(proj, 'external-docs');
    symlinkSync('docs', to);
    const before = snapshot(from);
    await assert.rejects(planMigration({ from, to }), /same directory/);
    await assert.rejects(applyMigration({ from, to }), /same directory/);
    assert.deepEqual(snapshot(from), before, 'no marker, no .cache written into --from');
    // Spelled through a symlinked parent as well.
    const alias = join(tmp, `alias-${n}`);
    symlinkSync(proj, alias);
    await assert.rejects(applyMigration({ from, to: join(alias, 'docs') }), /same directory/);
    assert.deepEqual(snapshot(from), before);
  });

  test('--from inside --to reached through a symlink: refused', async () => {
    const { proj, from } = makeTree(tree());
    const to = join(tmp, `proj-link-${n}`);
    symlinkSync(proj, to); // `to` is the project dir; from = proj/docs is inside it
    await assert.rejects(applyMigration({ from, to }), /inside --to/);
    assert.ok(existsSync(join(from, 'example.com/guide.md')));
  });

  test('a destination directory symlinked back into --from: pages skipped as same-file, kept', async () => {
    const { from, to } = makeTree(tree());
    mkdirSync(to, { recursive: true });
    symlinkSync(join(from, 'example.com'), join(to, 'example.com'));
    const before = snapshot(from);
    const plan = await planMigration({ from, to });
    assert.deepEqual(plan.skipped.map(s => s.reason), ['same-file', 'same-file']);
    const res = await applyMigration({ from, to });
    assert.equal(res.applied.moved, 0);
    assert.deepEqual(snapshot(from), before);
  });

  test('the unlink guard: source and destination turn out to be one file → original kept', async () => {
    const { from, to } = makeTree(tree());
    const res = await applyMigration({
      from, to,
      hooks: {
        afterCopy: (m) => {
          // Replace the verified copy's directory with a symlink back to the source's.
          rmSync(join(to, dirname(m.to)), { recursive: true, force: true });
          symlinkSync(join(from, dirname(m.from)), join(to, dirname(m.to)));
        },
      },
    });
    assert.equal(res.applied.moved, 0);
    assert.ok(res.applied.errors.length > 0 && res.applied.errors.every(e => /same file/.test(e.error)),
      JSON.stringify(res.applied.errors));
    assert.equal(read(join(from, 'example.com/guide.md')), V1_TREE['example.com/guide.md']);
    assert.equal(read(join(from, 'example.com/api.md')), V1_TREE['example.com/api.md']);
  });
});
