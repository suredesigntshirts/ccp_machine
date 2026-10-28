// Writes events.jsonl, the golden history (C5): about 30 hand-made rows across the three eras, the live runtime,
// sessions and GitHub, with one placeholder of each kind, one out-of-band event and one fact from two sources.
// Edit the rows here and run `node build.mjs`; the tests read events.jsonl, never this file.
import { writeFileSync } from 'node:fs';

const L = (why) => ({ legacy: why });
const NO_ENVELOPE = 'main predates the event envelope (M1)';
const H = (commit) => ({ version: '0.1.0', commit });
const S = 'session_01KfkB5JrJtRHxr12jv9nkHq';
const O = '2ce18a8f-fd3a-507a-82d3-2dea2ed3db49';
const sess = (id) => ({ kind: 'session', id });
const cli = (ref) => ({ kind: 'cli', ref });
const person = { kind: 'person', id: 'user_01KfkB5Jm6bszTAytbWYG5at' };
const pr = (n, repo = 'ccp_machine_test') => `https://github.com/suredesigntshirts/${repo}/pull/${n}`;
const store = (name, line) => ({ source: 'store', ref: `library/harness/state/${name}/events.jsonl`, line });

const rows = [];
const add = (id, at, to, event, who, provenance) => rows.push({ id, version: 0, at, to, ...who, event, provenance });

// main: no actor, source or harness on any row.
const main = (id, at, to, event, line, extra = []) =>
  add(id, at, to, event, { actor: L(NO_ENVELOPE), source: L(NO_ENVELOPE), harness: L(NO_ENVELOPE) },
    { origin: 'migrated', from: store('main', line), placeholders: ['actor', 'source', 'harness', ...extra] });
main('day-2026-10-26', '2026-10-26T17:55:34.288Z', 'budget', { type: 'DAY_STARTED', sevenDay: 0.07, fiveHour: 0.04 }, 1);
main('usage-1748', '2026-10-26T17:55:34.352Z', 'budget', { type: 'USAGE_SAMPLED', sevenDay: 0.07, fiveHour: 0.04 }, 2);
main('req-ledger', '2026-10-26T17:55:34.410Z', 'harness', { type: 'REQUEST_RECEIVED', request: { id: 'ledger', title: 'Session ledger', project: 'packages/ledger', url: pr(3) } }, 3);
main('sia-ledger-plan', '2026-10-26T17:56:02.000Z', 'item:ledger/decision:ledger:plan:1', { type: 'STAND_IN_ANSWERED', answer: { choice: 'approve', confidence: 0.92, reason: 'small, tested' } }, 4);
main('run-ledger', '2026-10-26T18:20:11.000Z', 'item:ledger', { type: 'RUN_SUCCEEDED', pr: pr(3), session: 'session_01HHcgPmfzeYXnH2BULtsewg' }, 5);
main('checks-ledger', '2026-10-26T18:24:40.000Z', 'item:ledger', { type: 'CHECKS_PASSED', pr: pr(3), sha: '1b7c0c7f4e9d2a65b1f0c3e8d9a7b6c5d4e3f2a1', observedAt: '2026-10-26T18:24:39Z' }, 6);
// The store saw the PR land but not its sha: a payload placeholder. GitHub's copy of the same fact wins (identity: merge).
main('merged-ledger', '2026-10-26T18:25:02.000Z', 'item:ledger', { type: 'MERGED', pr: pr(3), sha: L('main recorded no sha for it'), observedAt: '2026-10-26T18:25:01Z' }, 7, ['event.sha']);
add('gh-ccp_machine_test-pr-3', '2026-10-26T18:24:58.000Z', 'item:ledger', { type: 'MERGED', pr: pr(3), sha: '9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d' },
  { actor: { kind: 'github', id: 'github' }, source: { kind: 'github-wake', ref: 'pulls/3 merged_at' }, harness: L('recovered from GitHub; no harness applied it') },
  { origin: 'recovered', from: { source: 'github', ref: 'github/suredesigntshirts--ccp_machine_test/pages/pulls-001.json.gz', line: 3 }, placeholders: ['harness'] });
main('checks-failed-pages', '2026-10-26T19:02:00.000Z', 'item:pages', { type: 'CHECKS_FAILED', pr: pr(7), sha: '2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e4f5', check: 'test', conclusion: 'failure', reason: 'npm test' }, 8);
main('tick-1910', '2026-10-26T19:10:00.000Z', 'budget', { type: 'TICK', now: '2026-10-26T19:10:00Z', costSince: 0.4 }, 9);
main('digest-2026-10-26', '2026-10-26T23:00:00.000Z', 'harness', { type: 'DIGEST_DUE', day: '2026-10-26' }, 10);

// dogfood: the envelope, with relayedBy on taps.
const dog = (name, commit) => (id, at, to, event, line, who = {}) =>
  add(id, at, to, event, { actor: sess(O), source: cli('harness send'), harness: H(commit), ...who }, { origin: 'migrated', from: store(name, line) });
const d1 = dog('dogfood', '0b435826cc53c5ed5a559637fea8ecc8927198b6');
d1(`orchestrator-${O}`, '2026-10-27T18:36:18.446Z', 'harness', { type: 'ORCHESTRATOR_STARTED' }, 1, { source: cli('harness init') });
d1('req-issue36', '2026-10-27T18:36:19.013Z', 'harness', { type: 'REQUEST_RECEIVED', request: { id: 'spawn-gates', title: 'Gate worker spawns', project: 'packages/harness', url: 'https://github.com/suredesigntshirts/ccp_machine/issues/36' } }, 2);
d1('triage-issue36', '2026-10-27T18:37:00.000Z', 'item:spawn-gates', { type: 'TRIAGED', tier: 1, criteria: ['A spawn without a role line is denied'] }, 3);
d1('sia-issue36-plan', '2026-10-27T18:38:00.000Z', 'item:spawn-gates/decision:spawn-gates:plan:1', { type: 'STAND_IN_ANSWERED', answer: { choice: 'approve', confidence: 0.8, reason: 'touches the gates' } }, 4);
d1('card-issue36-plan', '2026-10-27T18:38:30.000Z', 'item:spawn-gates/decision:spawn-gates:plan:1', { type: 'CARD_POSTED', card: 'cmsg_01CRqZ2YoFXkbgk5p24fe6KkPlan36', effect: 'decision:spawn-gates:plan:1' }, 5);
d1('tap-issue36-plan', '2026-10-27T18:52:00.000Z', 'item:spawn-gates/decision:spawn-gates:plan:1', { type: 'PERSON_DECIDED', choice: 'approve' }, 6,
  { actor: person, source: { kind: 'tap', ref: 'cmsg_01CRqZ2YoFXkbgk5p24fe6KkPlan36' }, relayedBy: O });
d1('wip-3', '2026-10-27T18:53:00.000Z', 'harness', { type: 'WIP_SET', limit: 3 }, 7);
d1('run-issue36', '2026-10-27T20:10:00.000Z', 'item:spawn-gates', { type: 'RUN_SUCCEEDED', pr: pr(46, 'ccp_machine') }, 8, { actor: sess('builder-session-46') });
d1('crit-issue36-1', '2026-10-27T20:40:00.000Z', 'item:spawn-gates', { type: 'CRITERION_CHECKED', criterion: 'A spawn without a role line is denied', verdict: 'met', evidence: 'test/spawn-merge.test.js' }, 9, { actor: sess('verifier-session-46') });
d1('cancel-old', '2026-10-27T21:00:00.000Z', 'item:old-pages', { type: 'CANCEL', reason: 'superseded by #47' }, 10);

// A session shows the person ordered PR #46 landed by hand: work outside the gates, recorded, not hidden.
add(`${S}:evt-4410`, '2026-10-28T03:28:00.000Z', 'item:spawn-gates',
  { type: 'OUT_OF_BAND', orderedBy: person, message: 'cmsg_01CRqZ2YoFXkbgk5p24fe6KkOrder46', what: 'landed PR #46 by hand', skipped: ['acceptGate', 'mergeGate'], pr: pr(46, 'ccp_machine') },
  { actor: sess('old-lead-session'), source: { kind: 'message', ref: 'cmsg_01CRqZ2YoFXkbgk5p24fe6KkOrder46' }, harness: H(null) },
  { origin: 'recovered', from: { source: 'session', ref: `sessions/${S}/pages/page-0007.json.gz`, line: 41 }, confidence: 0.9 });

// dogfood2: the same orchestrator id as dogfood (ids are unique only within a source), a grant and a spawn.
const d2 = dog('dogfood2', '3e01ae44da45c847a133ba5ff97faf1d0c5c0dfb');
d2(`orchestrator-${O}`, '2026-10-28T03:50:58.758Z', 'harness', { type: 'ORCHESTRATOR_STARTED' }, 1, { source: cli('harness init') });
d2('grant-message-0317', '2026-10-28T03:51:15.333Z', 'harness', { type: 'PERSON_GRANTED', picks: ['plan', 'accept'] }, 2,
  { actor: person, source: { kind: 'message', ref: 'cmsg_01CRqZ2YoFXkbgk5p24fe6KkAzi1XSmfFULC3PS9A7Wqtt' }, relayedBy: O });
d2('req-issue58', '2026-10-28T04:02:00.000Z', 'harness', { type: 'REQUEST_RECEIVED', request: { id: 'grant-decides', title: 'Under a grant the stand-in decides', project: 'packages/harness', url: 'https://github.com/suredesigntshirts/ccp_machine/issues/58' } }, 3);
d2('brief-grant-decides', '2026-10-28T04:05:00.000Z', 'item:grant-decides', { type: 'VERIFIER_BRIEF_FIXED', sha256: 'a'.repeat(64) }, 4);
d2('spawn-grant-decides-builder', '2026-10-28T04:06:00.000Z', 'item:grant-decides', { type: 'WORKER_SPAWNED', role: 'builder', agentType: 'harness:builder', model: 'opus', toolUseId: 'toolu_01Builder58', briefSha256: 'b'.repeat(64) }, 5);
d2('start-grant-decides-builder', '2026-10-28T04:06:20.000Z', 'item:grant-decides', { type: 'WORKER_STARTED', agent: 'a1b2c3', agentType: 'harness:builder' }, 6, { actor: { kind: 'agent', id: `${O}/a1b2c3` } });
// The same spawn read back from the session transcript: one fact, and the store's row is kept.
add('session_01KfkB5G7CjokK4tvydb8B36:evt-912', '2026-10-28T04:06:01.000Z', 'item:grant-decides', { type: 'WORKER_SPAWNED', role: 'builder', agentType: 'harness:builder', toolUseId: 'toolu_01Builder58' },
  { actor: sess(O), source: cli('Agent'), harness: L('the transcript names no harness version') },
  { origin: 'recovered', from: { source: 'session', ref: 'sessions/session_01KfkB5G7CjokK4tvydb8B36/pages/page-0003.json.gz', line: 17 }, placeholders: ['harness'], confidence: 1 });

// The live runtime, writing the one history directly.
add('wip-4', '2026-10-28T10:30:00.000Z', 'harness', { type: 'WIP_SET', limit: 4 },
  { actor: sess(O), source: cli('harness send'), harness: H('3e01ae44da45c847a133ba5ff97faf1d0c5c0dfb') },
  { origin: 'live', from: { source: 'store', ref: 'library/harness/state/history/events.jsonl', line: 1 } });

rows.sort((a, b) => a.at.localeCompare(b.at)).forEach((r, i) => (r.version = i + 1));
writeFileSync(new URL('./events.jsonl', import.meta.url), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
console.log(`wrote ${rows.length} rows`);
