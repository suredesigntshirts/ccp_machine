// #102: OUT_OF_BAND is a fact the store takes against an item in any state, done and cancelled included: no state
// change, no effects (spec workItem, on.OUT_OF_BAND). Doctor then lists the landing it records out of band instead
// of counting it as a problem (harness meta.invariants reviewOnHead). The real case is PR #66, item review-footer,
// landed at 2d04bb4 by GitHub's button: its recovered row is scripts/history/recovered/dogfood2.jsonl. GitHub is a
// fake: no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openStore, init, doctor, status } from '../src/index.js';
import { apply as applyEvent } from '../src/runtime.js';
import { apply, start } from './send.js';
import { tempDir } from './tmp.js';

const recovered = readFileSync(new URL('../scripts/history/recovered/dogfood2.jsonl', import.meta.url), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((r) => r.id === 'oob-review-footer-pr66');
const PR = recovered.event.pr;
const LANDED = recovered.event.sha;
const ITEM = 'review-footer';
const session = { actor: { kind: 'session', id: 'lead-session' }, source: { kind: 'cli', ref: 'harness send' } };
const github = { actor: { kind: 'github', id: 'github' }, source: { kind: 'github-wake', ref: 'ci' } };
// The recovered row's event, sent as the lead sends it: from its own session, by the CLI.
const oob = (over = {}) => ({ ...recovered.event, ...session, ...over });
const without = (k) => { const { [k]: _, ...rest } = oob(); return rest; };

const itemState = (store) => status(store).items.find((i) => i.id === ITEM).state;
const ok = (r, label) => assert.ok(!r.refused && !r.duplicate, `${label}: ${r.why}`);

// Item review-footer, built on PR #66 (the PR is bound to it), then taken to `end`: done (merged at a head its
// verifier passed, as the scripted host does), cancelled, or left verifying.
function itemOn66(end) {
  const store = openStore(tempDir('harness-oob-'));
  init(store);
  start(store);
  ok(apply(store, { type: 'REQUEST_RECEIVED', request: { id: ITEM } }), 'request');
  ok(apply(store, { type: 'TRIAGED', tier: 0, criteria: ['it works'] }, { to: `item:${ITEM}` }), 'triage');
  ok(apply(store, { type: 'RUN_SUCCEEDED', pr: PR }, { to: `item:${ITEM}` }), 'run');
  if (end === 'done') {
    ok(apply(store, { type: 'CHECKS_PASSED', pr: PR, ...github }, { to: `item:${ITEM}` }), 'ci');
    ok(apply(store, { type: 'MERGED', pr: PR }, { to: `item:${ITEM}` }), 'merged');
  }
  if (end === 'cancelled') ok(applyEvent(store, { type: 'CANCEL', reason: 'landed out of band', ...session }, { to: `item:${ITEM}` }), 'cancel');
  return store;
}

// GitHub as it was for #66: merged at 2d04bb4, with no PASS review on that head.
const fetcher = async (path) => {
  if (path === 'repos/suredesigntshirts/ccp_machine/pulls/66') return { number: 66, merged: true, head: { sha: LANDED } };
  if (path === 'repos/suredesigntshirts/ccp_machine/pulls/66/reviews?per_page=100') return [];
  throw new Error(`HTTP 404 ${path}`);
};
const report = (store) => doctor(store, { ledgers: tempDir('harness-ledgers-'), fetcher });

for (const end of ['done', 'cancelled', 'verifying']) {
  test(`the store takes OUT_OF_BAND on an item ${end}, as a fact: no state change, no effects`, () => {
    const store = itemOn66(end);
    const before = itemState(store);
    const { version } = store.read();
    const pending = store.pending().length;
    const r = applyEvent(store, oob(), { to: `item:${ITEM}`, id: 'oob-pr66' });
    ok(r, 'OUT_OF_BAND');
    assert.deepEqual(r.effects, [], 'no effects');
    assert.equal(itemState(store), before, 'the item stays where it was');
    assert.equal(store.read().version, version + 1);
    assert.equal(store.pending().length, pending);
    const row = store.events().at(-1);
    assert.deepEqual([row.id, row.to, row.actor, row.event], ['oob-pr66', `item:${ITEM}`, session.actor, recovered.event], 'the log row records the fact');
  });
}

test('OUT_OF_BAND is refused from an agent, a person or GitHub, and without a field the history needs', () => {
  const store = itemOn66('done');
  const refused = (event, label) => {
    const r = applyEvent(store, event, { to: `item:${ITEM}` });
    assert.equal(r.refused, true, `${label}: taken`);
    return r.why;
  };
  refused(oob({ actor: { kind: 'agent', id: 'lead-session/builder-1' } }), 'an agent');
  refused(oob({ actor: { kind: 'person', id: recovered.event.orderedBy.id } }), 'the person');
  refused(oob({ actor: { kind: 'github', id: 'github' }, source: { kind: 'github-wake', ref: 'x' } }), 'GitHub');
  for (const k of ['orderedBy', 'what', 'pr', 'message', 'skipped']) assert.match(refused(without(k), `no ${k}`), /OUT_OF_BAND in done \(unrecordable\)/);
  assert.match(refused(oob({ sha: '2d04bb4' }), 'a short sha'), /unrecordable/);
  assert.match(refused(oob({ orderedBy: { kind: 'someone' } }), 'orderedBy not an actor'), /unrecordable/);
  assert.match(refused(oob({ what: '' }), 'an empty what'), /unrecordable/);
  assert.equal(store.events().filter((e) => e.event.type === 'OUT_OF_BAND').length, 0, 'nothing written');
});

test('doctor lists #66 out of band once the store holds its OUT_OF_BAND row, and as a problem without it', async () => {
  for (const end of ['done', 'cancelled']) {
    const store = itemOn66(end);
    const bare = await report(store);
    assert.ok(bare.problems.some((l) => l.startsWith('merges: problem suredesigntshirts/ccp_machine#66 item:review-footer')), `${end}, no row: ${bare.problems.join('\n')}`);
    assert.deepEqual(bare.outOfBand, []);
    ok(applyEvent(store, oob(), { to: `item:${ITEM}`, id: 'oob-pr66' }), 'OUT_OF_BAND');
    const after = await report(store);
    assert.deepEqual(after.problems, [], `${end}, with the row`);
    assert.equal(after.outOfBand.length, 1);
    assert.match(after.outOfBand[0], /^oob-pr66: landed PR #66 .* \(suredesigntshirts\/ccp_machine#66 item:review-footer at 2d04bb4\), ordered by person:user_01KfkB5Jm6bszTAytbWYG5at, skipped awaitingAcceptance, integrationGate, unverifiedHead, reviewOnHead$/);
  }
});
