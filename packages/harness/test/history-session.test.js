// E2 of epic #59 (#129): the session extractor (scripts/history/extract-session.mjs) reads one session's folder of
// the salvage archive (harness/archive/sessions/<session id>/: manifest.json and events.jsonl.gz, list_events records)
// and writes a WORKER_SPAWNED row per Agent call, a CARD_POSTED row per decision card, a PERSON_DECIDED row per tap
// on one of its cards that reached the session (a decision-chosen wake naming the card's message id) and a MERGED
// row per merge_pull_request call that landed. The archive here is built from fixture events in a temp folder, so
// the test needs no network and no Library.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, cpSync, existsSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate, factKey } from '../src/history.js';
import { openStore } from '../src/store.js';
import { doctor } from '../src/doctor.js';
import { choiceOf } from '../src/card.js';
import { tempDir } from './tmp.js';

const SCRIPTS = fileURLToPath(new URL('../scripts/history/', import.meta.url));
const SID = 'session_01Fixture';
const REF = `sessions/${SID}`;
const LEAD = '2ce18a8f-fd3a-507a-82d3-2dea2ed3db49';
const PERSON = 'user_01KfkB5Jm6bszTAytbWYG5at';
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

// list_events records as the archive holds them: { created_at, <kind>: {...} }.
let clock = 0;
const at = () => new Date(Date.UTC(2026, 9, 27, 10, 0, clock++)).toISOString().replace('Z', '123Z'); // microseconds, as list_events writes
const assistant = (blocks, { parent = null, session = LEAD } = {}) => ({ created_at: at(), assistant: { uuid: `a-${clock}`, internal_anthropic_catchall: { session_id: session, parent_tool_use_id: parent, message: { role: 'assistant', content: blocks } } } });
const call = (id, name, input) => ({ type: 'tool_use', id, name, input });
const result = (id, text, is_error) => ({ created_at: at(), user: { uuid: `u-${clock}`, internal_anthropic_catchall: { session_id: LEAD, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }], ...(is_error && { is_error: true }) }] } } } });
const wake = (card, index, uuid) => ({
  created_at: at(),
  user: {
    uuid,
    internal_anthropic_catchall: {
      inbound_origin: 'hearth_human',
      message: { role: 'user', content: `<wake reason="decision-chosen">Chose an option on the decision card</wake>` },
      wake_envelope: { reason: 'decision-chosen', messages: [{ author_id: PERSON, body: 'Chose an option', from: 'human', trigger: true }], notes: [`decision_id=${card}`, `option=${'AB'[index]}`, `option_index=${index}`, `actor_account_id=${PERSON}`, 'A member answered your decision card.'] },
    },
  },
});
const launched = 'Async agent launched successfully.\nagentId: a0123456789abcdef';
const BUILDER_BRIEF = 'Build it.\n\nHarness-Role: builder item:wip-set\n\nRead the issue.';
const PLAIN_BRIEF = 'Run the tests and report.';
const card = (q) => ({ question: q, context: 'why', options: [{ label: 'Approve', consequence: 'it goes on' }, { label: 'Revise', consequence: 'it goes back' }], recommended: 0, reason: 'the plan matches' });
const posted = (cmsg) => JSON.stringify({ message_id: cmsg, note: 'Card posted in this thread.' });
const landed = (commit) => JSON.stringify({ sha: commit, merged: true, message: 'Pull Request successfully merged' });

/** One session's events: spawns with and without a role line, cards, taps and landings, and calls that failed. */
function events(cardId = 'cmsg_01Card1') {
  clock = 0;
  return [
    { created_at: at(), user: { uuid: 'u-ctx', internal_anthropic_catchall: { isSynthetic: true, message: { role: 'user', content: '<session-context>the project</session-context>' } } } },
    assistant([{ type: 'text', text: 'Spawning.' }, call('toolu_Builder', 'Agent', { description: 'Build wip-set', prompt: BUILDER_BRIEF, subagent_type: 'harness:builder', model: 'opus' })]), // line 2
    result('toolu_Builder', launched),
    assistant([call('toolu_Plain', 'Agent', { description: 'Run tests', prompt: PLAIN_BRIEF })]), // line 4: no role line, type or model
    result('toolu_Plain', launched),
    assistant([call('toolu_Twice', 'Agent', { description: 'Two roles', prompt: 'Harness-Role: builder item:a\nHarness-Role: verifier item:a', subagent_type: 'general-purpose' })]), // line 6
    result('toolu_Twice', launched),
    assistant([call('toolu_Denied', 'Agent', { description: 'Denied', prompt: 'Harness-Role: verifier item:wip-set', subagent_type: 'harness:verifier' })]), // line 8
    result('toolu_Denied', 'roleLine: denied by the spawn gate', true),
    assistant([call('toolu_Card', 'mcp__hearthbot__request_decision', card('Approve the plan for wip-set?'))]), // line 10
    result('toolu_Card', posted(cardId)),
    assistant([call('toolu_CardBad', 'mcp__hearthbot__request_decision', card('Too long?'))]), // line 12
    result('toolu_CardBad', 'request_decision: options[0].consequence exceeds 200 bytes', true),
    wake(cardId, 1, 'u-tap1'), // line 14: the person taps Revise on the card above
    wake('cmsg_01NotThisSession', 0, 'u-tap2'), // line 15: a card this session did not post
    assistant([call('toolu_Merge2', 'mcp__github__merge_pull_request', { owner: 'acme', repo: 'widgets', pullNumber: 2, expectedHeadSha: H('2'), merge_method: 'merge' })]), // line 16
    result('toolu_Merge2', landed(H('c'))),
    assistant([call('toolu_Merge3', 'mcp__github__merge_pull_request', { owner: 'acme', repo: 'widgets', pullNumber: 3, merge_method: 'merge' })]), // line 18
    result('toolu_Merge3', 'failed to merge pull request: 405 Pull Request is not mergeable', true),
    assistant([call('toolu_Merge7', 'mcp__github__merge_pull_request', { owner: 'acme', repo: 'widgets', pullNumber: 7, merge_method: 'squash' })]), // line 20: no head pinned
    result('toolu_Merge7', landed(H('d'))),
    assistant([call('toolu_Nested', 'Agent', { description: 'Helper', prompt: 'Look it up.', subagent_type: 'Explore', model: 'haiku' })], { parent: 'toolu_Plain' }), // line 22: a subagent's call
    result('toolu_Nested', launched),
  ];
}

/** A session folder as the salvage wrote it: events.jsonl.gz and manifest.json with its count, kinds and sha256s. */
function archive(lines = events(), sid = SID) {
  const dir = join(tempDir('history-session-'), sid);
  mkdirSync(dir, { recursive: true });
  const raw = Buffer.from(lines.map((l) => JSON.stringify(l) + '\n').join(''));
  const gz = gzipSync(raw);
  writeFileSync(join(dir, 'events.jsonl.gz'), gz);
  const kinds = {};
  for (const l of lines) for (const k of Object.keys(l)) if (k !== 'created_at') kinds[k] = (kinds[k] ?? 0) + 1;
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ source: 'sessions', id: sid, title: 'Fixture session', events: { file: 'events.jsonl.gz', count: lines.length, kinds, sha256: sha(raw), gzSha256: sha(gz) }, problems: [] }, null, 2));
  return dir;
}
const extract = (dir, ref = REF) => {
  const r = run('extract-session.mjs', [dir, ref]);
  const said = r.status ? [] : rowsOf(r.stderr);
  return { r, rows: rowsOf(r.stdout), calls: said.filter((l) => l.call || l.skip?.call), taps: said.filter((l) => l.tap || l.skip?.tap), count: said.at(-1) };
};
const one = (rows, id) => rows.find((x) => x.id === id) ?? assert.fail(`no row ${id}`);
const FROM = (line) => ({ source: 'session', ref: `${REF}/events.jsonl.gz`, line });

test('E2: an Agent call is one WORKER_SPAWNED, its role and item from the Harness-Role: line, else legacy placeholders', () => {
  const { r, rows } = extract(archive());
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(rows.flatMap(validate), []);
  for (const x of rows) {
    assert.equal(x.provenance.origin, 'recovered');
    assert.equal(x.provenance.from.source, 'session');
    // No harness applied a recovered row, and no harness source read a call (a tap's source is its card).
    for (const p of x.event.type === 'PERSON_DECIDED' ? ['harness'] : ['source', 'harness']) {
      assert.ok(x.provenance.placeholders.includes(p), `${x.id} lists no ${p} placeholder`);
      assert.match(x[p].legacy, /session/);
    }
  }
  const builder = one(rows, 'spawn-toolu_Builder');
  assert.equal(builder.to, 'item:wip-set');
  assert.equal(builder.at, events()[1].created_at);
  assert.deepEqual(builder.actor, { kind: 'session', id: LEAD });
  assert.deepEqual(builder.event, { type: 'WORKER_SPAWNED', role: 'builder', agentType: 'harness:builder', model: 'opus', briefSha256: sha(BUILDER_BRIEF), toolUseId: 'toolu_Builder' });
  assert.deepEqual(builder.provenance.from, FROM(2));
  assert.deepEqual(builder.provenance.placeholders, ['source', 'harness']);

  // No role line: the item and role are labelled placeholders, never guessed from the brief's words; so are the
  // agent type and model the call did not name.
  const plain = one(rows, 'spawn-toolu_Plain');
  assert.equal(plain.to, 'harness');
  assert.equal(plain.event.briefSha256, sha(PLAIN_BRIEF));
  assert.deepEqual(plain.provenance.placeholders.sort(), ['event.agentType', 'event.item', 'event.model', 'event.role', 'harness', 'source']);
  assert.match(plain.event.item.legacy, /no Harness-Role: line/);
  assert.match(plain.event.model.legacy, /no model/);
  // Two role lines name no one item: placeholders, saying why.
  const twice = one(rows, 'spawn-toolu_Twice');
  assert.equal(twice.to, 'harness');
  assert.match(twice.event.role.legacy, /2 Harness-Role: lines/);
  // A call a subagent made: the record does not name that agent, so the actor is a placeholder.
  const nested = one(rows, 'spawn-toolu_Nested');
  assert.match(nested.actor.legacy, /subagent/);
  assert.ok(nested.provenance.placeholders.includes('actor'));
  // A call the platform refused spawned nothing.
  assert.equal(rows.find((x) => x.id === 'spawn-toolu_Denied'), undefined);
});

test('E2: a card is one CARD_POSTED with its question, options and recommended index; a tap on it is one PERSON_DECIDED tied to it', () => {
  const { rows } = extract(archive());
  const c = one(rows, 'card-cmsg_01Card1');
  assert.deepEqual(c.event, {
    type: 'CARD_POSTED',
    card: 'cmsg_01Card1',
    question: 'Approve the plan for wip-set?',
    options: card('').options,
    recommended: 0,
    item: c.event.item,
  });
  assert.match(c.event.item.legacy, /names no item/);
  assert.equal(c.to, 'harness');
  assert.deepEqual(c.provenance.from, FROM(10));
  assert.deepEqual(c.actor, { kind: 'session', id: LEAD });
  // The tap: the wake that names the card's message id (decision_id), from the person, relayed by this session.
  const tap = one(rows, 'tap-u-tap1');
  assert.deepEqual(tap.actor, { kind: 'person', id: PERSON });
  assert.deepEqual(tap.source, { kind: 'tap', ref: 'cmsg_01Card1' });
  assert.equal(tap.relayedBy, LEAD);
  assert.equal(tap.event.type, 'PERSON_DECIDED');
  assert.equal(tap.event.card, 'cmsg_01Card1');
  // The choice in the store's words (the decision's, src/card.js), the label the card showed beside it.
  assert.equal(tap.event.choice, 'revise');
  assert.equal(tap.event.label, 'Revise');
  assert.equal(tap.event.option, 1);
  // Each decision card label is its choice's; any other label is no decision card's, and E2 writes no choice for it.
  assert.deepEqual(['Approve', 'Revise', 'Drop it', 'Revise: every 6 hours only', 'approve'].map(choiceOf), ['approve', 'revise', 'reject', undefined, undefined]);
  assert.deepEqual(tap.provenance.from, FROM(14));
  assert.deepEqual(tap.provenance.placeholders.sort(), ['event.item', 'harness']);
  assert.equal(rows.filter((x) => x.event.type === 'CARD_POSTED').length, 1, 'a card the platform refused was never posted');
  assert.equal(rows.filter((x) => x.event.type === 'PERSON_DECIDED').length, 1, 'a tap on a card this session did not post is not tied to one');
});

test('E2: a merge_pull_request call whose result says it landed is one MERGED with the PR and the landed head and commit', () => {
  const { rows } = extract(archive());
  const m = rows.filter((x) => x.event.type === 'MERGED');
  assert.deepEqual(m.map((x) => x.id), ['merge-toolu_Merge2', 'merge-toolu_Merge7']);
  assert.deepEqual(m[0].event, { type: 'MERGED', pr: URL_OF(2), sha: H('2'), commit: H('c'), item: m[0].event.item });
  assert.equal(m[0].at, events()[16].created_at, 'it landed when the result came back');
  assert.deepEqual(m[0].provenance.from, FROM(16));
  // A call that pinned no head: the head is a placeholder; the merge commit is the result's.
  assert.equal(m[1].event.commit, H('d'));
  assert.match(m[1].event.sha.legacy, /pinned no head/);
  assert.ok(m[1].provenance.placeholders.includes('event.sha'));
});

test('E2: stderr lists every Agent, card and landing call with its row id or why it was skipped, and the counts match the events', () => {
  const dir = archive();
  const { calls, taps, count } = extract(dir);
  // Count the tool calls in the events file, as the verifier will.
  const lines = gunzipSync(readFileSync(join(dir, 'events.jsonl.gz'))).toString().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const used = lines.flatMap((l) => (l.assistant?.internal_anthropic_catchall?.message?.content ?? []).filter((b) => b.type === 'tool_use'));
  const n = (name) => used.filter((b) => b.name === name).length;
  assert.deepEqual(count.calls, { Agent: n('Agent'), mcp__hearthbot__request_decision: n('mcp__hearthbot__request_decision'), mcp__github__merge_pull_request: n('mcp__github__merge_pull_request') });
  assert.deepEqual(count.calls, { Agent: 5, mcp__hearthbot__request_decision: 2, mcp__github__merge_pull_request: 3 });
  assert.equal(calls.length, 10, 'one report line per call');
  assert.deepEqual(
    calls.map((c) => [c.call ?? c.skip.call, c.toolUseId ?? c.skip.toolUseId, c.line ?? c.skip.line, c.row ?? c.reason.split(':')[0]]),
    [
      ['Agent', 'toolu_Builder', 2, 'spawn-toolu_Builder'],
      ['Agent', 'toolu_Plain', 4, 'spawn-toolu_Plain'],
      ['Agent', 'toolu_Twice', 6, 'spawn-toolu_Twice'],
      ['Agent', 'toolu_Denied', 8, 'the call was refused'],
      ['mcp__hearthbot__request_decision', 'toolu_Card', 10, 'card-cmsg_01Card1'],
      ['mcp__hearthbot__request_decision', 'toolu_CardBad', 12, 'the call was refused'],
      ['mcp__github__merge_pull_request', 'toolu_Merge2', 16, 'merge-toolu_Merge2'],
      ['mcp__github__merge_pull_request', 'toolu_Merge3', 18, 'the call was refused'],
      ['mcp__github__merge_pull_request', 'toolu_Merge7', 20, 'merge-toolu_Merge7'],
      ['Agent', 'toolu_Nested', 22, 'spawn-toolu_Nested'],
    ],
  );
  assert.deepEqual(
    taps.map((t) => [t.tap ?? t.skip.tap, t.line ?? t.skip.line, t.row ?? t.reason.split(':')[0]]),
    [
      ['cmsg_01Card1', 14, 'tap-u-tap1'],
      ['cmsg_01NotThisSession', 15, 'no request_decision call in this session posted the card it answers'],
    ],
  );
  assert.equal(count.taps, 2);
  assert.equal(count.rows, 8);
  assert.equal(count.skips, 4);
});

test('E2: an events file that does not match the manifest is refused and nothing is written; the archive is only read', () => {
  const dir = archive();
  const before = shaDir(dir);
  assert.equal(extract(dir).r.status, 0);
  assert.equal(shaDir(dir), before, 'the extractor never writes the archive');
  // One byte changed in the gzipped file: its gzSha256 no longer matches.
  const file = join(dir, 'events.jsonl.gz');
  const gz = readFileSync(file);
  gz[gz.length - 1] ^= 1;
  writeFileSync(file, gz);
  const bad = extract(dir);
  assert.notEqual(bad.r.status, 0);
  assert.equal(bad.r.stdout, '');
  assert.match(bad.r.stderr, /events\.jsonl\.gz.*sha256/);
  // A file recompressed from changed events: its bytes are new, and so is the sha256 of its JSON.
  const other = archive();
  const m = JSON.parse(readFileSync(join(other, 'manifest.json'), 'utf8'));
  const raw = Buffer.from(gunzipSync(readFileSync(join(other, 'events.jsonl.gz'))).toString().replace('wip-set', 'wip-sat'));
  const regz = gzipSync(raw);
  writeFileSync(join(other, 'events.jsonl.gz'), regz);
  writeFileSync(join(other, 'manifest.json'), JSON.stringify({ ...m, events: { ...m.events, gzSha256: sha(regz) } }));
  const changed = extract(other);
  assert.notEqual(changed.r.status, 0);
  assert.equal(changed.r.stdout, '');
  assert.match(changed.r.stderr, /JSONL's sha256/);
  // A manifest that counts other events than the file holds is refused too.
  const short = archive();
  const s = JSON.parse(readFileSync(join(short, 'manifest.json'), 'utf8'));
  writeFileSync(join(short, 'manifest.json'), JSON.stringify({ ...s, events: { ...s.events, count: s.events.count + 1 } }));
  const miscount = extract(short);
  assert.notEqual(miscount.r.status, 0);
  assert.equal(miscount.r.stdout, '');
  assert.match(miscount.r.stderr, /count/);
});

// GitHub's archive of the same repo (E3): #2 the item's PR, which the session landed; #7 landed by the session too.
function github() {
  const dir = join(tempDir('history-session-gh-'), 'acme--widgets');
  mkdirSync(join(dir, 'pages'), { recursive: true });
  const pr = (number, ref, head, merged_at) => ({ number, state: 'closed', html_url: URL_OF(number), title: `PR ${number}`, body: null, created_at: '2026-10-26T09:00:00Z', merged_at, head: { ref, sha: head }, base: { ref: 'main' } });
  const pages = {
    'issues-001': [{ number: 12, title: 'wip', body: 'Item id: `wip-set`.\n\n## Expect\n\n- a', html_url: 'https://github.com/acme/widgets/issues/12' }],
    'pulls-001': [pr(2, 'feat/12-wip-set', H('2'), '2026-10-27T10:00:16Z'), pr(7, 'docs/words', H('7'), '2026-10-27T10:00:20Z')],
  };
  const entries = Object.entries(pages).map(([name, json]) => {
    const raw = Buffer.from(JSON.stringify(json));
    const gz = gzipSync(raw);
    writeFileSync(join(dir, 'pages', `${name}.json.gz`), gz);
    return { file: `pages/${name}.json.gz`, items: json.length, sha256: sha(raw), gzSha256: sha(gz) };
  });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ source: 'github', id: 'acme/widgets', pages: entries, totals: { pulls: 2 } }));
  return dir;
}

// A store's rows (E1): the gate recorded the builder spawn and the nested one (by another agent type: a conflict), and
// the card and its tap.
const STORE = [
  { id: 'req-wip-set', at: '2026-10-27T09:00:00.000Z', to: 'harness', event: { type: 'REQUEST_RECEIVED', request: { id: 'wip-set', title: 'wip' } } },
  { id: 'spawn-toolu_Builder', at: '2026-10-27T10:00:01.500Z', to: 'item:wip-set', event: { type: 'WORKER_SPAWNED', role: 'builder', agentType: 'harness:builder', briefSha256: sha(BUILDER_BRIEF), model: 'opus', toolUseId: 'toolu_Builder' } },
  { id: 'spawn-toolu_Nested', at: '2026-10-27T10:00:21.500Z', to: 'item:wip-set', event: { type: 'WORKER_SPAWNED', role: 'checker', agentType: 'general-purpose', model: 'haiku', toolUseId: 'toolu_Nested' } },
  { id: 'card-plan', at: '2026-10-27T10:00:10.500Z', to: 'item:wip-set/decision:wip-set:plan:1', event: { type: 'CARD_POSTED', card: 'cmsg_01Card1', effect: 'standin-decision:wip-set:plan:1.0' } },
  { id: 'e14', at: '2026-10-27T10:00:13.500Z', to: 'item:wip-set/decision:wip-set:plan:1', actor: { kind: 'person', id: PERSON }, source: { kind: 'tap', ref: 'cmsg_01Card1' }, relayedBy: LEAD, event: { type: 'PERSON_DECIDED', choice: 'revise' } },
].map((r, i) => ({ version: i + 1, actor: { kind: 'session', id: LEAD }, source: { kind: 'cli', ref: 'harness send' }, harness: { version: '0.8.0', commit: null }, ...r }));

test('E2 with E1 and E3: the join keeps one row per spawn, card, tap and landing, the session in also, and reports a conflict', () => {
  const tmp = tempDir('history-session-join-');
  mkdirSync(join(tmp, 'store'));
  writeFileSync(join(tmp, 'store', 'events.jsonl'), STORE.map((r) => JSON.stringify(r) + '\n').join(''));
  const e1 = run('extract-store.mjs', [join(tmp, 'store'), 'library/harness/state/fixture/events.jsonl']);
  assert.equal(e1.status, 0, e1.stderr);
  const e3 = run('extract-github.mjs', [github(), 'github/acme--widgets']);
  assert.equal(e3.status, 0, e3.stderr);
  const e2 = run('extract-session.mjs', [archive(), REF]);
  assert.equal(e2.status, 0, e2.stderr);
  // A second session that posted its own card: its first card is not the first session's.
  const e2b = run('extract-session.mjs', [archive(events('cmsg_01Card2'), 'session_01Other'), 'sessions/session_01Other']);
  assert.equal(e2b.status, 0, e2b.stderr);
  const files = { e1: e1.stdout, e3: e3.stdout, e2: e2.stdout, e2b: e2b.stdout };
  for (const [f, text] of Object.entries(files)) writeFileSync(join(tmp, `${f}.jsonl`), text);
  const out = join(tmp, 'out');
  const j = run('join.mjs', [...Object.keys(files).map((f) => join(tmp, `${f}.jsonl`)), '--out', out]);
  assert.equal(j.status, 0, j.stderr);
  const history = rowsOf(readFileSync(join(out, 'events.jsonl'), 'utf8'));
  const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'));
  const of = (type, key) => history.filter((r) => r.event.type === type).filter((r) => r.event[key[0]] === key[1]).map((r) => [r.id, r.provenance.from.source, (r.provenance.also ?? []).map((f) => f.ref)]);
  const S1 = `${REF}/events.jsonl.gz`;
  const S2 = 'sessions/session_01Other/events.jsonl.gz';
  // The store's spawn and the session's Agent call with its toolUseId are one fact: the store's row, the sessions in also.
  assert.deepEqual(of('WORKER_SPAWNED', ['toolUseId', 'toolu_Builder']), [['spawn-toolu_Builder', 'store', [S1, S2]]]);
  // An Agent call no store recorded is a recovered WORKER_SPAWNED row (both fixture sessions hold the same call id).
  const plain = history.filter((r) => r.event.toolUseId === 'toolu_Plain');
  assert.equal(plain.length, 1);
  assert.equal(plain[0].provenance.origin, 'recovered');
  assert.equal(plain[0].provenance.from.source, 'session');
  // A landing the session made and GitHub holds is one fact; GitHub's row is kept, since it binds the PR to its item.
  assert.deepEqual(of('MERGED', ['pr', URL_OF(2)]), [['gh-widgets-pr-2-merged', 'github', [S1, S2]]]);
  assert.equal(history.find((r) => r.event.pr === URL_OF(2)).to, 'item:wip-set');
  assert.deepEqual(of('MERGED', ['pr', URL_OF(7)]), [['gh-widgets-pr-7-merged', 'github', [S1, S2]]]);
  // The store's card and tap are kept with the session in also; the other session's card is its own fact.
  assert.deepEqual(of('CARD_POSTED', ['card', 'cmsg_01Card1']), [['card-plan', 'store', [S1]]]);
  assert.deepEqual(of('CARD_POSTED', ['card', 'cmsg_01Card2']), [['card-cmsg_01Card2', 'session', []]]);
  assert.deepEqual(history.filter((r) => r.event.type === 'PERSON_DECIDED').map((r) => [r.id, r.source.ref, (r.provenance.also ?? []).map((f) => f.ref)]), [
    ['tap-u-tap1', 'cmsg_01Card2', []],
    ['e14', 'cmsg_01Card1', [S1]],
  ]);
  // Where the store and a session disagree, it is reported and never merged silently: they name another agent type
  // for the nested spawn. The tap is no conflict: the session's row names the tapped option by the decision's choice,
  // as the store does, with the card's label beside it.
  assert.equal(history.find((r) => r.id === 'e14').event.choice, 'revise');
  assert.deepEqual(
    report.conflicts.map((c) => [c.fact, c.field, c.kept, c.other]),
    [
      ['spawn:toolu_Nested', 'event.agentType', 'spawn-toolu_Nested', 'spawn-toolu_Nested'],
      ['spawn:toolu_Nested', 'event.agentType', 'spawn-toolu_Nested', 'spawn-toolu_Nested'],
    ],
  );
});

test('C4: a card is keyed by its message id and a tap by the card it answers, so two sessions\' cards stay two facts', () => {
  const prov = (ref) => ({ origin: 'recovered', from: { source: 'session', ref } });
  const c = (ref, cmsg) => ({ id: 'c', at: '2026-10-27T10:00:00Z', to: 'harness', event: { type: 'CARD_POSTED', card: cmsg }, provenance: prov(ref) });
  assert.notEqual(factKey(c('a', 'cmsg_1')), factKey(c('b', 'cmsg_2')));
  assert.equal(factKey(c('a', 'cmsg_1')), factKey({ ...c('store', 'cmsg_1'), to: 'item:x/decision:x:plan:1' }));
  const tap = (to, ref) => ({ id: 't', at: '2026-10-27T10:00:00Z', to, source: { kind: 'tap', ref }, event: { type: 'PERSON_DECIDED', choice: 'x' }, provenance: prov('a') });
  assert.equal(factKey(tap('harness', 'cmsg_1')), factKey(tap('item:x/decision:x:plan:1', 'cmsg_1')));
  assert.notEqual(factKey(tap('harness', 'cmsg_1')), factKey(tap('harness', 'cmsg_2')));
});

test('E1, E2 and E3 share one candidate writer', () => {
  assert.match(readFileSync(join(SCRIPTS, 'extract-session.mjs'), 'utf8'), /from '\.\/candidates\.mjs'/);
});

// M1 (#138): join.mjs --from builds the one history from every source in its fixed list, laid out as the Library's
// harness/ folder: the stores main, dogfood and dogfood2 (state/<name>), both GitHub repos (archive/github/<repo>) and
// every archived session (archive/sessions/<id>).
const REPOS = ['suredesigntshirts--ccp_machine', 'suredesigntshirts--ccp_machine_test'];
// A store from before the event envelope, as main is: no actor, source or harness, and a CHECKS_PASSED naming no PR.
const MAIN = [
  { id: 'req-old', version: 2, at: '2026-10-26T09:00:00.000Z', to: 'harness', event: { type: 'REQUEST_RECEIVED', request: { id: 'old', title: 'old' } } },
  { id: 'ci-old', version: 3, at: '2026-10-26T09:00:01.000Z', to: 'item:old', event: { type: 'CHECKS_PASSED' } },
];
/** A copy of the Library's harness/ folder holding every source join --from reads; `drop` leaves one out. */
function library({ drop } = {}) {
  const root = join(tempDir('history-build-'), 'harness');
  const put = (rel, rows) => {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), rows.map((r) => JSON.stringify(r) + '\n').join(''));
  };
  put('state/main/events.jsonl', MAIN);
  put('state/dogfood/events.jsonl', STORE);
  // dogfood2's outbox and acks: the effects its rows queued (as the join replays them), each acked by the host.
  const pre = tempDir('history-build-pre-');
  put('state/dogfood2/events.jsonl', STORE.slice(0, 1).map((r) => ({ ...r, id: 'req-wip-set-2', event: { ...r.event, request: { id: 'wip-set-2', title: 'wip 2' } } })));
  const e1 = run('extract-store.mjs', [join(root, 'state/dogfood2'), 'dogfood2']);
  writeFileSync(join(pre, 'c.jsonl'), e1.stdout);
  assert.equal(run('join.mjs', [join(pre, 'c.jsonl'), '--out', join(pre, 'out')]).status, 0);
  const queued = rowsOf(readFileSync(join(pre, 'out', 'outbox.jsonl'), 'utf8'));
  assert.ok(queued.length >= 1, 'the dogfood2 row queues an effect');
  put('state/dogfood2/outbox.jsonl', queued);
  put('state/dogfood2/acks.jsonl', queued.map((e) => ({ effectId: e.id, outcome: 'done', note: 'run done', at: '2026-10-27T09:30:00.000Z' })));
  cpSync(github(), join(root, 'archive/github', REPOS[1]), { recursive: true });
  const empty = join(root, 'archive/github', REPOS[0]);
  mkdirSync(join(empty, 'pages'), { recursive: true });
  writeFileSync(join(empty, 'manifest.json'), JSON.stringify({ source: 'github', id: 'suredesigntshirts/ccp_machine', pages: [], totals: { pulls: 0 } }));
  cpSync(archive(), join(root, 'archive/sessions', SID), { recursive: true });
  cpSync(archive(events('cmsg_01Card2'), 'session_01Other'), join(root, 'archive/sessions/session_01Other'), { recursive: true });
  if (drop) rmSync(join(root, drop), { recursive: true });
  return root;
}

test('M1: join --from builds the one history from every listed source, on a copy it never writes, with each skip and refusal listed', async () => {
  const root = library();
  const before = shaDir(root);
  const out = join(tempDir('history-build-out-'), 'history');
  const j = run('join.mjs', ['--from', root, '--out', out]);
  assert.equal(j.status, 0, j.stderr);
  assert.equal(shaDir(root), before, 'the sources are only read');
  const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'));
  const history = rowsOf(readFileSync(join(out, 'events.jsonl'), 'utf8'));
  assert.deepEqual(history.flatMap(validate), []);
  // Every source in the list, in its order, read as its archive ref, with its rows and each skip with its reason.
  assert.deepEqual(report.sources.map((x) => x.ref), ['main', 'dogfood', 'dogfood2', ...REPOS.map((r) => `github/${r}`), `sessions/${SID}`, 'sessions/session_01Other']);
  assert.deepEqual(report.sources.find((x) => x.ref === 'main'), { ref: 'main', rows: MAIN.length, skips: [] }, 'every main event is a row');
  const skips = report.sources.flatMap((x) => x.skips);
  assert.ok(skips.length > 0 && skips.every((k) => k.ref && k.reason), 'each skip names where and why');
  assert.equal(report.read, report.sources.reduce((n, x) => n + x.rows, 0));
  // The old era's rows hold labelled placeholders for what main did not record.
  const ci = history.find((r) => r.id === 'ci-old');
  assert.deepEqual(ci.provenance.placeholders.sort(), ['actor', 'event.pr', 'harness', 'source']);
  assert.equal(ci.event.pr.legacy, 'main recorded no event.pr on its CHECKS_PASSED rows then');
  // The tap joins without a conflict: the session names the choice as the store does.
  assert.deepEqual(report.conflicts.filter((c) => c.field === 'event.choice'), []);
  // A row replay cannot apply is listed with its reason.
  assert.ok(report.refused.every((r) => /^[^:]+: .+/.test(r)));
  // dogfood2's acks reach the effects replay queued again for its rows, so none of them is pending.
  const store = openStore(out);
  const acked = rowsOf(readFileSync(join(root, 'state/dogfood2/acks.jsonl'), 'utf8')).map((a) => a.effectId);
  assert.equal(report.acks, acked.length);
  assert.deepEqual(store.pending().filter((e) => acked.includes(e.id)), []);
  // doctor on the history: no schema error, and its placeholders counted by era (a store, or the kind of source) and field.
  const d = await doctor(store, { verify: false });
  assert.deepEqual(d.history.schemaErrors, []);
  assert.equal(d.history.rows, history.length);
  assert.deepEqual(d.history.placeholders.main, { actor: 2, source: 2, harness: 2, 'event.pr': 1 });
  assert.deepEqual(Object.keys(d.history.placeholders).sort(), ['github', 'main', 'session']);
  assert.ok(!d.problems.some((p) => /^schema:/.test(p)));
  assert.ok(!d.problems.some((p) => acked.some((id) => p.startsWith(`effect ${id} `))), 'no effect its source acked is pending');
});

test('M1: join --from refuses a list with a source missing, writing nothing; doctor names a row that breaks the schema', async () => {
  const root = library({ drop: 'state/dogfood' });
  const out = join(tempDir('history-build-out-'), 'history');
  const j = run('join.mjs', ['--from', root, '--out', out]);
  assert.equal(j.status, 1);
  assert.match(j.stderr, /state\/dogfood: a source of the one history is missing/);
  assert.equal(existsSync(out), false);
  assert.match(run('join.mjs', ['--from', root, join(root, 'x.jsonl'), '--out', out]).stderr, /usage/, 'a list or candidates, not both');
  // A history row that does not hold to the schema is a schema error doctor names.
  const ok = library();
  const built = join(tempDir('history-build-out-'), 'history');
  assert.equal(run('join.mjs', ['--from', ok, '--out', built]).status, 0);
  const file = join(built, 'events.jsonl');
  const rows = rowsOf(readFileSync(file, 'utf8'));
  const i = rows.findIndex((r) => !r.provenance.placeholders);
  rows[i] = { ...rows[i], actor: { legacy: 'not listed' } };
  writeFileSync(file, rows.map((r) => JSON.stringify(r) + '\n').join(''));
  const d = await doctor(openStore(built), { verify: false });
  assert.deepEqual(d.history.schemaErrors, [`${rows[i].id}: actor: holds a legacy placeholder that provenance.placeholders does not list`]);
  assert.ok(d.problems.includes(`schema: ${d.history.schemaErrors[0]}`));
});
