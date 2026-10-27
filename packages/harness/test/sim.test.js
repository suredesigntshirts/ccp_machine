import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulate, timeApplyAt, tablesInCards, script } from '../src/sim.js';

for (const wip of [3, 12]) {
  test(`12 items at WIP ${wip}: the limit holds, the queue drains, every effect is acked`, () => {
    const r = simulate({ items: 12, wip });
    assert.equal(r.peakInFlight, wip);
    assert.deepEqual([r.done, r.queued, r.inFlight, r.pending], [12, 0, 0, 0]);
    assert.ok(r.doctor.ok, r.doctor.problems.join('; '));
    // The script covers each kind of trouble at least once.
    assert.ok(r.counts.RUN_FAILED && r.counts.CHECKS_FAILED && r.counts.BLOCK && r.counts.PERSON_DECIDED, JSON.stringify(r.counts));
    assert.ok(r.peakAsks >= 3, 'cards pile up while the person is slow');
    assert.ok(Buffer.byteLength(r.html) < 1e6);
    assert.equal(tablesInCards(r.html), 0);
    assert.match(r.html, new RegExp(`${wip} / ${wip}`));
  });
}

test('one apply stays under 200 ms with 500 events in the store', () => {
  const r = simulate({ items: 12, wip: 12 });
  assert.ok(timeApplyAt(r.store, 500) < 200);
  assert.ok(r.store.events().length >= 500);
});

test('the script mixes tiers and trouble', () => {
  const s = Array.from({ length: 12 }, (_, i) => script(i));
  assert.deepEqual([0, 1, 2].map((t) => s.filter((x) => x.tier === t).length), [4, 4, 4]);
  assert.equal(s.filter((x) => x.revise).length, 1);
});
