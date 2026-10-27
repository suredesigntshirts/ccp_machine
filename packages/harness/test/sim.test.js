import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './tmp.js';
import { simulate, timeApplyAt, tablesInCards, script } from '../src/sim.js';

for (const wip of [3, 12]) {
  test(`12 items at WIP ${wip}: the limit holds, the queue drains, every effect is acked`, async () => {
    const r = await simulate({ items: 12, wip, dir: tempDir('harness-sim-') });
    assert.equal(r.peakInFlight, wip);
    assert.deepEqual([r.done, r.queued, r.inFlight, r.pending], [12, 0, 0, 0]);
    assert.deepEqual(r.refused, [], 'the scripted host sends only what the machine takes');
    assert.ok(r.doctor.ok, r.doctor.problems.join('; '));
    // The script covers each kind of trouble at least once.
    assert.ok(r.counts.RUN_FAILED && r.counts.CHECKS_FAILED && r.counts.BLOCK && r.counts.PERSON_DECIDED, JSON.stringify(r.counts));
    // Triage and the criteria checks come from actors of their own, never the requester, orchestrator or a worker.
    const by = (type) => new Set(r.store.events().filter((e) => e.event.type === type).map((e) => e.actor.id));
    assert.deepEqual([...by('TRIAGED')], ['sim-triager']);
    assert.deepEqual([...by('CRITERION_CHECKED')], ['sim-reviewer']);
    for (const party of ['sim-orchestrator', 'sim-worker']) assert.ok(!by('TRIAGED').has(party) && !by('CRITERION_CHECKED').has(party));
    assert.equal(r.store.events().filter((e) => e.event.type === 'TRIAGED').length, 13, 'each item triaged once, and item 5 again after its revise');
    assert.ok(r.store.events().some((e) => e.event.type === 'PERSON_DECIDED' && /:accept:/.test(e.to) && e.event.choice === 'revise'), 'an unmet criterion sends accept back');
    // Cards and taps go through the same path as a real host's: the ack names the card, the tap names it back.
    const cards = new Map(r.store.events().filter((e) => e.event.type === 'CARD_POSTED').map((e) => [e.to, e.event.card]));
    const taps = r.store.events().filter((e) => e.event.type === 'PERSON_DECIDED');
    assert.ok(taps.every((e) => e.actor.kind === 'person' && e.source.kind === 'tap' && cards.get(e.to) === e.source.ref), 'every tap is on its decision\'s posted card');
    assert.equal(cards.size, taps.length, 'one card per tap');
    assert.ok(r.store.events().every((e) => !('person' in e.event)), 'no event carries a person flag');
    assert.ok(r.peakAsks >= 3, 'cards pile up while the person is slow');
    assert.ok(Buffer.byteLength(r.html) < 1e6);
    assert.equal(tablesInCards(r.html), 0);
    assert.match(r.html, new RegExp(`${wip} / ${wip}`));
  });
}

test('one apply stays under 200 ms with 500 events in the store', async () => {
  const r = await simulate({ items: 12, wip: 12, dir: tempDir('harness-sim-') });
  assert.ok(timeApplyAt(r.store, 500) < 200);
  assert.ok(r.store.events().length >= 500);
});

test('the script mixes tiers and trouble', () => {
  const s = Array.from({ length: 12 }, (_, i) => script(i));
  assert.deepEqual([0, 1, 2].map((t) => s.filter((x) => x.tier === t).length), [4, 4, 4]);
  assert.equal(s.filter((x) => x.revise).length, 1);
  assert.equal(s.filter((x) => x.unmet).length, 1);
  assert.ok(s.every((x) => x.criteria.length > 0));
});
