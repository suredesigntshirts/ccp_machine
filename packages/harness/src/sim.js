// The scale simulation: a scripted host drives many synthetic items through a scratch store, the way an
// orchestrator would, to show what a busy day does to the WIP limit, the outbox, the store and the page.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from './store.js';
import { init, apply, ack, status, cardAddress } from './runtime.js';
import { logPrecedents } from './decision-log.js';
import { doctor } from './doctor.js';
import { renderPage } from './page.js';

const sure = { choice: 'approve', confidence: 0.95, reason: 'simulated' };

// The parties a scripted host plays, each sending what it sends for real: a triager sets tier and criteria, a
// worker reports runs, a reviewer checks the criteria, the stand-in answers, GitHub reports CI and merges, the
// person taps a card (ref: the card's message id), and the orchestrator sends the rest (requests and card posts included).
const SESSIONS = { triager: 'sim-triager', worker: 'sim-worker', reviewer: 'sim-reviewer', 'stand-in': 'sim-stand-in' };
export function scripted(type, ref = 'sim') {
  const party = { TRIAGED: 'triager', RUN_SUCCEEDED: 'worker', RUN_FAILED: 'worker', CRITERION_CHECKED: 'reviewer', CHECKS_PASSED: 'github', CHECKS_FAILED: 'github', MERGED: 'github', PERSON_DECIDED: 'person', PERSON_GRANTED: 'person', STAND_IN_ANSWERED: 'stand-in' }[type];
  if (SESSIONS[party]) return { actor: { kind: 'session', id: SESSIONS[party] }, source: { kind: 'cli', ref } };
  if (party === 'github') return { actor: { kind: 'github', id: 'github' }, source: { kind: 'github-wake', ref } };
  if (party === 'person') return { actor: { kind: 'person', id: 'sim-person' }, source: { kind: 'tap', ref }, relayedBy: 'sim-orchestrator' };
  return { actor: { kind: 'session', id: 'sim-orchestrator' }, source: { kind: 'cli', ref } };
}

/** The host posts the card a postDecisionCard effect asks for and acks it with the card's message id; the person taps `choice` on it. */
export function postAndTap(store, effect, choice, { now, id } = {}) {
  const card = `cmsg_${effect.id.replace(/\W/g, '_')}`;
  ack(store, [effect.id], { card, by: scripted('CARD_POSTED'), now });
  return apply(store, { type: 'PERSON_DECIDED', choice, ...scripted('PERSON_DECIDED', card) }, { to: cardAddress(effect), now, id });
}

/** What triage gives item i and what goes wrong for it: a mix of tiers, a failed run, failed checks, a block, a person's revise and an unmet criterion. */
export const script = (i) => ({
  tier: i % 3,
  criteria: [`item ${i} works`, `item ${i} has a test`],
  unmet: i === 4,
  failRun: i % 4 === 1,
  failChecks: i % 5 === 2,
  block: i % 6 === 3,
  revise: i === 5
});

/**
 * Run `items` synthetic items with WIP `wip` until no effect is pending. Returns the counts the
 * assertions need and mission control rendered when the most items were in flight.
 */
export async function simulate({ items = 12, wip = 3, dir = mkdtempSync(join(tmpdir(), 'harness-sim-')), t0 = Date.parse('2026-10-26T09:00:00Z') } = {}) {
  const store = openStore(dir);
  let clock = t0;
  const now = () => new Date((clock += 60_000)).toISOString();
  init(store, { wipLimit: wip }, now());
  let n = 0;
  // The host reports what the machine refuses and goes on; the scripted host should cause none.
  const refused = [];
  const check = (r, to) => r.refused && refused.push(`${to ?? 'harness'}: ${r.why}`);
  const send = (event, to) => { const id = `sim-${n++}`; check(apply(store, { ...event, ...scripted(event.type, id) }, { to, id, now: now() }), to); };
  const seen = {};
  const once = (key) => !seen[key] && (seen[key] = true);
  let peak = { inFlight: 0, asks: 0, html: '' };
  send({ type: 'ORCHESTRATOR_STARTED' });
  for (let i = 0; i < items; i++) send({ type: 'REQUEST_RECEIVED', request: { id: `item-${i}`, title: `Synthetic item ${i}`, project: 'sim' } });
  let steps = 0;
  for (;;) {
    const st = status(store);
    if (st.context.inFlight.length > st.context.wipLimit) throw new Error(`WIP ${st.context.inFlight.length} over ${st.context.wipLimit}`);
    // Keep the page from the busiest moment: most items in flight, then most waiting on the person.
    const asks = st.items.reduce((k, i) => k + i.decisions.filter((d) => d.state === 'awaitingPerson').length, 0);
    if (st.context.inFlight.length * 100 + asks > peak.inFlight * 100 + peak.asks)
      peak = { inFlight: st.context.inFlight.length, asks, html: renderPage(st, { events: store.events(), pending: store.pending(), title: `Busy day: ${items} items at WIP ${wip}` }) };
    // The person is slow: cards are answered only when nothing else is left to do.
    const pending = store.pending();
    const e = pending.find((x) => x.name !== 'postDecisionCard') ?? pending[0];
    if (!e) break;
    if (++steps > 5000) throw new Error('the simulation did not settle');
    // Gate effects carry their item in detail; the rest name the item.
    const id = e.detail?.item || (e.subject ?? e.actor);
    const s = script(Number(String(id).split('-')[1]));
    const item = `item:${id}`;
    if (e.name === 'logPrecedent') {
      logPrecedents(store);
      continue;
    }
    // A card is posted, then acked with its message id, as a real host does; every other effect is acked as done.
    if (e.name !== 'postDecisionCard') ack(store, [e.id], { note: 'simulated host', now: now() });
    if (e.name === 'dispatchRun') {
      const step = e.params?.step;
      if (step === 'build' && s.block && once(`block-${id}`)) {
        send({ type: 'BLOCK', reason: 'waiting on a credential' }, item);
        send({ type: 'UNBLOCKED' }, item);
      } else if (step === 'build' && s.failRun && once(`run-${id}`)) send({ type: 'RUN_FAILED', reason: 'simulated failure' }, item);
      else if (step === 'triage') send({ type: 'TRIAGED', tier: s.tier, criteria: s.criteria }, item);
      else if (step === 'verify') {
        // The reviewer checks each criterion; one item's first build leaves one unmet, so its accept goes to the person.
        for (const [k, criterion] of s.criteria.entries()) {
          const unmet = s.unmet && k === 1 && once(`unmet-${id}`);
          send({ type: 'CRITERION_CHECKED', criterion, verdict: unmet ? 'unmet' : 'met', evidence: unmet ? 'no test yet' : `test for ${criterion}` }, item);
        }
        send(s.failChecks && once(`ci-${id}`) ? { type: 'CHECKS_FAILED' } : { type: 'CHECKS_PASSED' }, item);
      }
      else send({ type: 'RUN_SUCCEEDED', pr: step === 'build' ? `https://example.test/pr/${id}` : undefined }, item);
    } else if (e.name === 'askStandIn') send({ type: 'STAND_IN_ANSWERED', answer: sure }, `${item}/${e.subject}`);
    else if (e.name === 'postDecisionCard') {
      // The person revises a plan once, and sends back an accept whose criteria are not all met.
      const revise = (s.revise && /:plan:/.test(e.subject) && once(`revise-${id}`)) || (/:accept:/.test(e.subject) && e.detail?.expectationsMet !== true);
      check(postAndTap(store, e, revise ? 'revise' : 'approve', { now: now(), id: `sim-${n++}` }), cardAddress(e));
    }
    else if (e.name === 'mergePullRequest') send({ type: 'MERGED' }, item);
    // reportBlocked, checkpoint and publishDigest need nothing back.
  }
  const st = status(store);
  return {
    dir,
    store,
    wip,
    items: st.items.length,
    done: st.items.filter((i) => i.state === 'done').length,
    states: Object.fromEntries(st.items.map((i) => [i.id, i.state])),
    peakInFlight: peak.inFlight,
    peakAsks: peak.asks,
    counts: Object.fromEntries(['RUN_FAILED', 'CHECKS_FAILED', 'BLOCK', 'PERSON_DECIDED'].map((t) => [t, store.events().filter((x) => x.event.type === t).length])),
    queued: st.context.queued.length,
    refused,
    inFlight: st.context.inFlight.length,
    pending: store.pending().length,
    events: store.events().length,
    doctor: await doctor(store, { verify: false }),
    html: peak.html
  };
}

/** Pad the store to `events` events with budget settings (always taken), then time one more apply (ms). */
export function timeApplyAt(store, events = 500) {
  let k = store.events().length;
  while (k < events) apply(store, { type: 'CONFIGURE', config: {}, ...scripted('CONFIGURE') }, { to: 'budget', id: `pad-${k++}` });
  const start = performance.now();
  apply(store, { type: 'REQUEST_RECEIVED', request: { id: 'timed' }, ...scripted('REQUEST_RECEIVED') }, { id: 'timed' });
  return performance.now() - start;
}

/** Tables inside "Needs you" cards: a card should stay readable at any width. */
export const tablesInCards = (html) => (html.match(/<div class="card"[^]*?<\/div>\s*<\/div>/g) ?? []).filter((c) => c.includes('<table')).length;

/**
 * A store the page contract test reads: the simulation's finished items, then, on top, one of every row a page
 * shows that a settled simulation no longer has: a budget reading, a decision waiting on the person with its card
 * posted, an item triage gave no criteria, one building, one queued, and the day's open stand-in audit. Built
 * with the current runtime every time, never a frozen fixture.
 */
export async function contractStore(dir) {
  const { store } = await simulate({ items: 6, wip: 3, dir });
  let clock = Date.parse(store.read().updatedAt);
  const now = () => new Date((clock += 60_000)).toISOString();
  const send = (event, to, id, at = now()) => {
    const r = apply(store, { ...event, ...scripted(event.type, id) }, { to, id, now: at });
    if (r.refused) throw new Error(`contract store: ${r.why}`);
    return r;
  };
  send({ type: 'DAY_STARTED', sevenDay: 0.07, fiveHour: 0.04 }, 'budget', 'c-day');
  send({ type: 'REQUEST_RECEIVED', request: { id: 'c-asks', title: 'A tier-2 change', project: 'sim', url: 'https://example.test/issues/1' } }, undefined, 'c-1');
  send({ type: 'TRIAGED', tier: 2, criteria: ['it works'] }, 'item:c-asks', 'c-2');
  send({ type: 'STAND_IN_ANSWERED', answer: { ...sure, choice: 'revise', reason: 'too big for one PR' } }, 'item:c-asks/decision:c-asks:plan:1', 'c-3');
  const card = store.pending().find((e) => e.name === 'postDecisionCard' && cardAddress(e) === 'item:c-asks/decision:c-asks:plan:1');
  ack(store, [card.id], { card: 'cmsg_contract', by: scripted('CARD_POSTED'), now: now() });
  send({ type: 'REQUEST_RECEIVED', request: { id: 'c-none', title: 'Make it better', project: 'sim' } }, undefined, 'c-4');
  send({ type: 'TRIAGED', tier: 1, criteria: [] }, 'item:c-none', 'c-5');
  send({ type: 'REQUEST_RECEIVED', request: { id: 'c-build', project: 'sim' } }, undefined, 'c-6');
  send({ type: 'TRIAGED', tier: 0, criteria: ['it works'] }, 'item:c-build', 'c-7');
  // The person's grant (plan, two-way doors, 8 hours) and a plan the stand-in decided under it.
  send({ type: 'GRANT_ASKED' }, undefined, 'c-ask');
  const checklist = store.pending().find((e) => e.name === 'postGrantCard');
  ack(store, [checklist.id], { card: 'cmsg_checklist', by: scripted('CARD_POSTED'), now: now() });
  send({ type: 'PERSON_GRANTED', picks: ['kind:plan', checklist.detail.options.find((o) => o.startsWith('until:') && o > `until:${new Date(clock + 36e5).toISOString()}`)] }, cardAddress(checklist), 'cmsg_checklist');
  send({ type: 'REQUEST_RECEIVED', request: { id: 'c-granted', title: 'A plan under the grant', project: 'sim' } }, undefined, 'c-g1');
  send({ type: 'TRIAGED', tier: 2, criteria: ['it works'] }, 'item:c-granted', 'c-g2');
  send({ type: 'STAND_IN_ANSWERED', answer: { ...sure, reason: 'small, and the grant covers plans' } }, 'item:c-granted/decision:c-granted:plan:1', 'c-g3');
  send({ type: 'REQUEST_RECEIVED', request: { id: 'c-queued' } }, undefined, 'c-8');
  const picks = store.outbox().filter((e) => e.name === 'logPrecedent').slice(0, 2).map((e) => e.id);
  const day = now();
  send({ type: 'AUDIT_PICKED', day: day.slice(0, 10), picks }, undefined, 'c-audit', day);
  return { store, dir };
}
