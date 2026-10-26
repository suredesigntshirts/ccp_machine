// Run: node --test .claude/skills/library/scripts/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const CLI = path.join(HERE, '..', 'library.mjs');
const SEED = path.join(HERE, '..', '..', '..', 'librarian', 'policy.seed.json');

function lib(root, args, { writer = 'w1', ok = true } = {}) {
  try {
    return execFileSync('node', [CLI, ...args], { env: { ...process.env, LIBRARY_ROOT: root, LIBRARY_WRITER: writer }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (ok) throw new Error(`${args.join(' ')} failed: ${e.stderr}`);
    return { code: e.status, stderr: e.stderr, stdout: e.stdout };
  }
}

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'library-test-'));
}

function put(root, rel, text = 'x\n', ageMin = 60) {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
  const t = new Date(Date.now() - ageMin * 60e3);
  fs.utimesSync(f, t, t);
}

const md = (title, body = '', extra = '') => `---\ntitle: ${title}\nsummary: about ${title}\nkind: notes\n${extra}---\n\n# ${title}\n\n${body}\n`;

function seeded() {
  const root = tmpRoot();
  lib(root, ['init', '--seed', SEED]);
  const pol = JSON.parse(fs.readFileSync(path.join(root, '~librarian/policy.json'), 'utf8'));
  pol.settle_minutes = 5;
  fs.writeFileSync(path.join(root, '~librarian/policy.json'), JSON.stringify(pol));
  lib(root, ['lease', 'acquire', '--wait', '0']);
  lib(root, ['install']);
  return root;
}

test('window order reproduces the session file list measured on 2026-10-26', () => {
  // Fixture: a real thread's "Project files" list, copied verbatim by a probe thread.
  const listing = fs.readFileSync(path.join(HERE, 'fixtures', 'session-file-list-2026-10-26.md'), 'utf8');
  const lines = listing.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2).replace(/ \([\d.]+ [KMG]?B\)$/, ''));
  const expected = lines.filter((l) => !l.startsWith('.') && !l.startsWith('…'));
  const root = tmpRoot();
  for (const l of expected) {
    if (l.endsWith('/')) fs.mkdirSync(path.join(root, l), { recursive: true });
    else put(root, l);
  }
  // uploads/ children are not listed by the platform; policy marks the area unlisted.
  put(root, 'uploads/hearth/c6909300-0c61-4250-9017-664fa9b758d2');
  fs.mkdirSync(path.join(root, '~librarian'), { recursive: true });
  fs.copyFileSync(SEED, path.join(root, '~librarian/policy.json'));
  const out = lib(root, ['window', '--live', '--all']).split('\n').filter((l) => /^\s+\d+ {2}/.test(l)).map((l) => l.replace(/^\s+\d+ {2}/, ''));
  const got = out.filter((l) => !l.startsWith('~librarian'));
  assert.deepEqual(got.slice(0, expected.length), expected);
});

test('build puts START-HERE first and the map right after it; audit is clean', () => {
  const root = seeded();
  put(root, 'notes/a-note.md', md('A note'));
  lib(root, ['new-topic', 'xstate-orchestration', '--title', 'XState orchestration']);
  lib(root, ['build']);
  const win = lib(root, ['window']).split('\n');
  assert.match(win[0], /^\s+1 {2}00-START-HERE\.md$/);
  assert.match(win[1], /01-map\/$/);
  assert.ok(win.some((l) => l.includes('01-map/50-research--xstate-orchestration--draft.md')));
  const { metrics, findings } = JSON.parse(lib(root, ['audit', '--json']));
  const errors = findings.filter((f) => f.sev === 'error');
  assert.deepEqual(errors, []);
  assert.equal(metrics.window.first, '00-START-HERE.md');
  assert.ok(fs.existsSync(path.join(root, 'research/INDEX.md')));
  assert.ok(fs.existsSync(path.join(root, 'drop/README.md')));
});

test('scan is incremental: an unchanged tree opens nothing', () => {
  const root = seeded();
  put(root, 'notes/one.md', md('One'));
  lib(root, ['scan', '--write']);
  const second = JSON.parse(lib(root, ['scan', '--write']).trim());
  assert.equal(second.changed, 0);
  assert.equal(second.opened, 0);
});

test('find searches titles, summaries and paths', () => {
  const root = seeded();
  put(root, 'notes/rclone-cache.md', md('Rclone cache timings'));
  put(root, 'notes/other.md', md('Something else'));
  lib(root, ['scan', '--write']);
  const out = lib(root, ['find', 'rclone']);
  assert.match(out, /notes\/rclone-cache\.md/);
  assert.doesNotMatch(out, /other\.md/);
});

test('mv moves a file, rewrites relative, absolute and anchored links, logs the move', () => {
  const root = seeded();
  put(root, 'notes/target.md', md('Target', 'see [self](#top)'));
  put(root, 'notes/linker.md', md('Linker', 'rel [t](target.md#sec) abs /mnt/project-files/notes/target.md. and [up](../notes/target.md)'));
  put(root, 'research/t1/README.md', md('T1', 'cite [t](../../notes/target.md)'));
  lib(root, ['scan', '--write']);
  const dry = JSON.parse(lib(root, ['mv', 'notes/target.md', 'research/t1/target.md']));
  assert.equal(dry.applied, false);
  assert.ok(fs.existsSync(path.join(root, 'notes/target.md')));
  const res = JSON.parse(lib(root, ['mv', 'notes/target.md', 'research/t1/target.md', '--apply']));
  assert.equal(res.applied, true);
  assert.ok(fs.existsSync(path.join(root, 'research/t1/target.md')));
  const linker = fs.readFileSync(path.join(root, 'notes/linker.md'), 'utf8');
  assert.match(linker, /\[t\]\(\.\.\/research\/t1\/target\.md#sec\)/);
  assert.match(linker, /\/mnt\/project-files\/research\/t1\/target\.md\./);
  assert.match(linker, /\[up\]\(\.\.\/research\/t1\/target\.md\)/);
  assert.match(fs.readFileSync(path.join(root, 'research/t1/README.md'), 'utf8'), /\[t\]\(target\.md\)/);
  assert.match(lib(root, ['resolve', 'notes/target.md']), /notes\/target\.md -> research\/t1\/target\.md/);
  assert.match(lib(root, ['refs', 'research/t1/target.md']), /notes\/linker\.md/);
  const { findings } = JSON.parse(lib(root, ['audit', '--json']));
  assert.deepEqual(findings.filter((f) => f.code === 'dangling-link'), []);
});

test('mv of a folder keeps the moved files\' own relative links pointing at the same targets', () => {
  const root = seeded();
  put(root, 'notes/shared.md', md('Shared'));
  put(root, 'research/old-name/README.md', md('Old', '[s](sources.md) [n](../../notes/shared.md)'));
  put(root, 'research/old-name/sources.md', md('Sources'));
  lib(root, ['scan', '--write']);
  lib(root, ['mv', 'research/old-name', 'research/archive/new-name', '--apply']);
  const readme = fs.readFileSync(path.join(root, 'research/archive/new-name/README.md'), 'utf8');
  assert.match(readme, /\[s\]\(sources\.md\)/);
  assert.match(readme, /\[n\]\(\.\.\/\.\.\/\.\.\/notes\/shared\.md\)/);
  assert.match(lib(root, ['resolve', 'research/old-name/sources.md']), /-> research\/archive\/new-name\/sources\.md/);
});

test('mv refuses foreign areas, recently changed files, and writing without the lease', () => {
  const root = seeded();
  put(root, 'external-docs/example.com/x.md', 'x');
  put(root, 'notes/fresh.md', md('Fresh'), 0);
  put(root, 'notes/old.md', md('Old'));
  lib(root, ['scan', '--write']);
  assert.match(lib(root, ['mv', 'external-docs/example.com/x.md', 'notes/x.md'], { ok: false }).stderr, /owned by tool:documentation-downloader/);
  assert.match(lib(root, ['mv', 'notes/fresh.md', 'notes/f2.md', '--apply'], { ok: false }).stderr, /changed in the last/);
  assert.match(lib(root, ['mv', 'notes/old.md', 'notes/o2.md', '--apply'], { ok: false, writer: 'w2' }).stderr, /does not hold the librarian lease/);
});

test('lease: a second writer cannot take a live lease', () => {
  const root = seeded();
  const other = JSON.parse(lib(root, ['lease', 'acquire', '--wait', '0'], { writer: 'w2' }));
  assert.equal(other.acquired, false);
  assert.equal(other.holder.writer, 'w1');
  lib(root, ['lease', 'release']);
  assert.equal(JSON.parse(lib(root, ['lease', 'acquire', '--wait', '0'], { writer: 'w2' })).acquired, true);
});

test('lint flags missing frontmatter, bad names and dangling links', () => {
  const root = seeded();
  put(root, 'notes/Bad Name.md', '# no frontmatter\n\n[x](missing.md)\n');
  put(root, 'stray.md', md('Stray'));
  const r = lib(root, ['lint', 'notes/Bad Name.md', 'stray.md'], { ok: false });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /no frontmatter/);
  assert.match(r.stdout, /uppercase or spaces/);
  assert.match(r.stdout, /missing\.md does not resolve/);
  assert.match(r.stdout, /stray\.md: not under a registered area/);
});

test('audit reports strays, topics without sources, and the drop backlog', () => {
  const root = seeded();
  put(root, 'random-folder/x.md', md('X'));
  put(root, 'research/t2/README.md', md('T2'));
  put(root, 'drop/w9--thing.md', md('Thing'));
  lib(root, ['build']);
  const { findings } = JSON.parse(lib(root, ['audit', '--json']));
  const codes = new Set(findings.map((f) => `${f.code}:${f.p}`));
  assert.ok(codes.has('stray-root:random-folder'));
  assert.ok(codes.has('topic-no-sources:research/t2'));
  assert.ok(codes.has('drop-waiting:drop/w9--thing.md'));
});

test('build signposts uploads by what they are', () => {
  const root = seeded();
  put(root, 'uploads/hearth/c6909300-0c61-4250-9017-664fa9b758d2', '%PDF-1.7 blah');
  put(root, 'uploads/hearth/a1b2c3d4-0000-0000-0000-000000000000', 'Quarterly plan for shirts\nmore\n');
  lib(root, ['build']);
  const map = fs.readdirSync(path.join(root, '01-map'));
  assert.ok(map.includes('60-upload--pdf--c6909300.md'), map.join(','));
  assert.ok(map.includes('60-upload--Quarterly-plan-for-shirts--a1b2c3d4.md'), map.join(','));
});

test('journal and trend', () => {
  const root = seeded();
  lib(root, ['build']);
  assert.match(lib(root, ['audit', '--journal', 'first run']), /journal: ~librarian\/journal\//);
  assert.match(lib(root, ['trend']), /errors=0/);
});

test('relink fixes links that mv deferred because the linking file was unsettled', () => {
  const root = seeded();
  put(root, 'notes/target.md', md('Target'));
  put(root, 'notes/busy.md', md('Busy', '[t](target.md)'), 0);
  lib(root, ['scan', '--write']);
  const res = JSON.parse(lib(root, ['mv', 'notes/target.md', 'notes/archive/target.md', '--apply']));
  assert.equal(res.deferred.length, 1);
  assert.match(fs.readFileSync(path.join(root, 'notes/busy.md'), 'utf8'), /\[t\]\(target\.md\)/);
  const t = new Date(Date.now() - 60 * 60e3);
  fs.utimesSync(path.join(root, 'notes/busy.md'), t, t);
  const fix = JSON.parse(lib(root, ['relink', '--apply']));
  assert.equal(fix.rewrite.length, 1);
  assert.match(fs.readFileSync(path.join(root, 'notes/busy.md'), 'utf8'), /\[t\]\(archive\/target\.md\)/);
  assert.match(lib(root, ['find', 'target']), /notes\/archive\/target\.md/);
  assert.doesNotMatch(lib(root, ['find', 'target']), /01-map/);
});

test('lint accepts README.md and full /mnt/project-files paths from any folder', () => {
  const root = seeded();
  lib(root, ['new-topic', 'abc', '--title', 'ABC']);
  put(root, 'research/abc/README.md', md('ABC'));
  assert.match(lib(root, ['lint', 'research/abc/README.md']), /^ok/);
  const out = execFileSync('node', [CLI, 'lint', `${root}/research/abc/README.md`], { cwd: path.join(root, 'research/abc'), env: { ...process.env, LIBRARY_ROOT: root }, encoding: 'utf8' });
  assert.match(out, /^ok/);
  const rel = execFileSync('node', [CLI, 'lint', 'README.md'], { cwd: path.join(root, 'research/abc'), env: { ...process.env, LIBRARY_ROOT: root }, encoding: 'utf8' });
  assert.match(rel, /^ok/);
});

test('find sees a file that passed lint before the next scan', () => {
  const root = seeded();
  lib(root, ['scan', '--write']);
  put(root, 'notes/fresh-thing.md', md('Fresh thing'), 0);
  assert.match(lib(root, ['find', 'fresh']), /no match/);
  assert.match(lib(root, ['lint', 'notes/fresh-thing.md']), /^ok/);
  assert.match(lib(root, ['find', 'fresh'], { writer: 'w2' }), /notes\/fresh-thing\.md/);
});

test('put writes with frontmatter, refuses top level, foreign areas and overwrites, and is findable at once', () => {
  const root = seeded();
  const run = (args, input, writer = 'w1') => {
    try {
      return { out: execFileSync('node', [CLI, ...args], { input, env: { ...process.env, LIBRARY_ROOT: root, LIBRARY_WRITER: writer }, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }) };
    } catch (e) {
      return { err: e.stderr };
    }
  };
  const ok = JSON.parse(run(['put', 'notes/cache-notes.md', '--title', 'Cache notes', '--summary', 'What warms the cache', '--kind', 'notes', '--tags', 'cache,mount'], '# Cache notes\n\nbody\n').out);
  assert.equal(ok.lint, 'ok');
  const text = fs.readFileSync(path.join(root, 'notes/cache-notes.md'), 'utf8');
  assert.match(text, /^---\ntitle: Cache notes\nsummary: What warms the cache\nkind: notes\nauthor: w1\ncreated: \d{4}-\d\d-\d\d\ntags: \[cache, mount\]\n---\n/);
  assert.match(text, /# Cache notes\n\nbody\n$/);
  assert.match(run(['put', 'top.md', '--title', 'x', '--summary', 'x', '--kind', 'notes'], 'x').err, /registered area/);
  assert.match(run(['put', 'external-docs/x.md', '--title', 'x', '--summary', 'x', '--kind', 'notes'], 'x').err, /owned by/);
  assert.match(run(['put', 'notes/cache-notes.md', '--title', 'x', '--summary', 'x', '--kind', 'notes'], 'x').err, /exists/);
  assert.match(run(['put', 'notes/no-title.md', '--summary', 'x', '--kind', 'notes'], 'x').err, /--title/);
  assert.match(lib(root, ['find', 'warms'], { writer: 'w2' }), /notes\/cache-notes\.md/);
  run(['put', 'notes/cache-notes.md', '--replace'], '# Cache notes\n\nbody v2\n', 'w3');
  const v2 = fs.readFileSync(path.join(root, 'notes/cache-notes.md'), 'utf8');
  assert.match(v2, /title: Cache notes\n/);
  assert.match(v2, /author: w1\n/);
  assert.match(v2, /updated: \d{4}-\d\d-\d\d\n/);
  assert.match(v2, /body v2/);
});

test('a link rewrite by mv keeps the file settled, so a folder can be filed one file at a time', () => {
  const root = seeded();
  put(root, 'notes/a.md', '---\ntitle: A\nsummary: a\nkind: notes\n---\n\n[b](b.md)\n');
  put(root, 'notes/b.md', '---\ntitle: B\nsummary: b\nkind: notes\n---\n\n[a](a.md)\n');
  const old = new Date(Date.now() - 3600e3);
  for (const f of ['notes/a.md', 'notes/b.md']) fs.utimesSync(path.join(root, f), old, old);
  lib(root, ['scan', '--write']);
  lib(root, ['mv', 'notes/a.md', 'notes/x/a.md', '--apply']);
  assert.match(fs.readFileSync(path.join(root, 'notes/b.md'), 'utf8'), /\[a\]\(x\/a\.md\)/);
  lib(root, ['mv', 'notes/b.md', 'notes/x/b.md', '--apply']);
  assert.match(fs.readFileSync(path.join(root, 'notes/x/a.md'), 'utf8'), /\[b\]\(b\.md\)/);
  assert.match(fs.readFileSync(path.join(root, 'notes/x/b.md'), 'utf8'), /\[a\]\(a\.md\)/);
});
