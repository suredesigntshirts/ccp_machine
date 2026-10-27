#!/usr/bin/env node
// npm run sim [-- --out FILE]: 12 synthetic items at WIP 3 and at WIP 12. Prints what happened, saves the
// busy page from the WIP 12 run, and exits 1 if an assertion fails.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { simulate, timeApplyAt, tablesInCards } from '../src/sim.js';

const { values: o } = parseArgs({ options: { out: { type: 'string', default: '/mnt/project-files/harness/state/sim/busy-day.html' }, items: { type: 'string', default: '12' } } });
const failures = [];
const check = (ok, what) => ok || failures.push(what);
let busy;
for (const wip of [3, Number(o.items)]) {
  const r = simulate({ items: Number(o.items), wip });
  const ms = timeApplyAt(r.store, 500);
  console.log(`WIP ${wip}: ${r.done}/${r.items} done, peak ${r.peakInFlight} in flight and ${r.peakAsks} cards, ${r.events} events, ${JSON.stringify(r.counts)}, apply at 500 events ${ms.toFixed(1)} ms`);
  check(r.peakInFlight <= wip, `WIP ${wip}: ${r.peakInFlight} in flight`);
  check(r.done === r.items && r.queued === 0 && r.inFlight === 0, `WIP ${wip}: queue did not drain`);
  check(r.pending === 0, `WIP ${wip}: ${r.pending} effects not acked`);
  check(r.doctor.ok, `WIP ${wip}: doctor: ${r.doctor.problems.join('; ')}`);
  check(Buffer.byteLength(r.html) < 1e6, `WIP ${wip}: page is ${Buffer.byteLength(r.html)} bytes`);
  check(tablesInCards(r.html) === 0, `WIP ${wip}: a Needs-you card holds a table`);
  check(ms < 200, `WIP ${wip}: apply took ${ms.toFixed(0)} ms at 500 events`);
  busy = r;
}
if (o.out) {
  mkdirSync(dirname(o.out), { recursive: true });
  writeFileSync(o.out, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${busy.html}</body></html>`);
  console.log(`busy page: ${o.out}`);
}
if (failures.length) {
  console.error(failures.map((f) => `fail: ${f}`).join('\n'));
  process.exitCode = 1;
}
