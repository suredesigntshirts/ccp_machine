// The harness as a backend workflow: every wake restores the root actor from the store, applies one
// event, persists the new snapshot and queues the effects that event asked for. Nothing stays in
// memory between wakes, so any session holding the store can be the orchestrator.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createActor } from 'xstate';
import { createMachines } from './machines.js';
import { bindingError } from './pr-binding.js';
import { ladder, readDecisionLog } from './decision-log.js';

const SEEN_IDS_KEPT = 500;

// The envelope every event carries: who sent it and where it came from. The machines' guards read both.
export const ACTOR_KINDS = ['person', 'session', 'github', 'timer'];
export const SOURCE_KINDS = ['tap', 'github-wake', 'cli', 'timer'];
const envelopeError = ({ actor, source }) =>
  !actor ? 'without an actor'
  : !ACTOR_KINDS.includes(actor.kind) || typeof actor.id !== 'string' || !actor.id ? `with actor ${JSON.stringify(actor)} (kind ${ACTOR_KINDS.join('|')} and an id)`
  : !source ? 'without a source'
  : !SOURCE_KINDS.includes(source.kind) || typeof source.ref !== 'string' ? `with source ${JSON.stringify(source)} (kind ${SOURCE_KINDS.join('|')} and a ref)`
  : null;

// The harness that applied an event, so a finding can be matched to the code that produced it.
let applied;
export function harnessVersion() {
  if (applied) return applied;
  const dir = new URL('..', import.meta.url).pathname;
  let commit = null;
  try {
    commit = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {}
  return (applied = { version: JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version, commit });
}

// Resolve an address: "harness" (the root), a system id ("item:a", "budget"), or a path of child
// ids below one ("item:a/decision:a:plan:1"). A finished child leaves the system but keeps its systemId.
function resolve(root, to) {
  if (!to || to === 'harness') return root;
  const [head, ...rest] = to.split('/');
  const children = root.getSnapshot().children;
  let actor = root.system.get(head) ?? Object.values(children).find((c) => c.systemId === head) ?? children[head];
  for (const id of rest) actor = actor?.getSnapshot().children[id];
  if (!actor) throw new Error(`no actor at "${to}"`);
  return actor;
}

// A decision opening now takes its class's rung from the store's decided decisions up to now; unreadable gives recommend.
const rungAt = (store, now) => (cls) => { try { return ladder(readDecisionLog(store).filter((r) => r.at <= now), cls).autonomy; } catch { return 'recommend'; } };

function restore(state, input, sink, rung) {
  const { harness } = createMachines(sink, { rung });
  return createActor(harness, { systemId: 'harness', ...(state ? { snapshot: state.snapshot } : { input }) });
}

/** Restore the stored snapshot without applying anything; returns the error if it cannot start. */
export function tryRestore(store) {
  const state = store.read();
  if (!state) return { error: 'no state.json' };
  try {
    const actor = restore(state, null, () => {}).start();
    const snap = actor.getSnapshot();
    actor.stop();
    return snap.status === 'error' ? { error: String(snap.error) } : {};
  } catch (e) {
    return { error: e.message };
  }
}

export function init(store, input = {}, now = new Date().toISOString()) {
  return store.withLock(() => {
    if (store.read()) throw new Error(`a harness already exists in ${store.dir}`);
    const actor = restore(null, input, () => {}).start();
    store.write({ version: 1, snapshot: actor.getPersistedSnapshot(), appliedIds: [], updatedAt: now }, 0);
    actor.stop();
    return { version: 1 };
  });
}

/**
 * Apply one event. The event carries `actor` {kind, id} and `source` {kind, ref}; one without them is
 * refused. The log row holds them beside the event, with the harness version that applied it.
 * `id` makes it idempotent: an id already applied is skipped, so a retried wake or
 * a duplicated delivery cannot double-apply.
 * An event the target actor would not take (`snapshot.can`, which reads the actor and source too) is
 * refused: nothing is written, and the result says `refused: <EVENT> in <state>`. So is an event naming a
 * PR (`pr`) that is bound to another item, or to an item already bound to another PR.
 * @returns {{version: number, duplicate?: boolean, refused?: boolean, why?: string, effects: object[]}}
 */
export function apply(store, event, { to, id, now = new Date().toISOString() } = {}) {
  if (!event?.type) throw new Error('an event needs a type');
  const bad = envelopeError(event);
  if (bad) return { version: store.read()?.version ?? 0, refused: true, why: `refused: ${event.type} ${bad}`, effects: [] };
  return store.withLock(() => {
    const state = store.read();
    if (!state) throw new Error(`no harness in ${store.dir}; run init first`);
    const eventId = id ?? `e${state.version}`;
    if (state.appliedIds.includes(eventId)) return { version: state.version, duplicate: true, effects: [] };

    // A PR is bound to one item, once; the log holds every binding (see pr-binding.js).
    const bound = event.pr != null && bindingError(store.events(), to, event.pr);
    if (bound) return { version: state.version, refused: true, why: `refused: ${event.type} ${bound}`, effects: [] };

    const effects = [];
    let collecting = false;
    const actor = restore(state, null, (e) => collecting && effects.push(e), rungAt(store, now));
    actor.start();
    const target = resolve(actor, to);
    const snap = target.getSnapshot();
    // The machine is the only judge of what an event may do: one it would not take changes nothing.
    if (snap.status !== 'active' || !snap.can(event)) {
      actor.stop();
      return { version: state.version, refused: true, why: `refused: ${event.type} in ${snap.status === 'active' ? valueText(snap.value) : snap.status}`, effects: [] };
    }
    collecting = true;
    target.send(event);
    collecting = false;
    const snapshot = actor.getPersistedSnapshot();
    actor.stop();
    if (snapshot.status === 'error') throw new Error(`event ${event.type} put the harness in error: ${snapshot.error}`);

    const version = state.version + 1;
    const queued = effects.map((e, i) => ({ id: `${eventId}.${i}`, eventId, at: now, ...e }));
    store.write({ version, snapshot, appliedIds: [...state.appliedIds, eventId].slice(-SEEN_IDS_KEPT), updatedAt: now }, state.version);
    const { actor: by, source, ...rest } = event;
    store.appendEvents([{ id: eventId, version, at: now, to: to ?? 'harness', actor: by, source, harness: harnessVersion(), event: rest }]);
    store.appendOutbox(queued);
    return { version, effects: queued };
  });
}

/** Mark effects as carried out (or failed), so they leave the pending list. */
export function ack(store, effectIds, { outcome = 'done', note, now = new Date().toISOString() } = {}) {
  const known = new Set(store.outbox().map((e) => e.id));
  const unknown = effectIds.filter((id) => !known.has(id));
  if (unknown.length) throw new Error(`unknown effects: ${unknown.join(', ')}`);
  store.appendAcks(effectIds.map((effectId) => ({ effectId, outcome, note: note ?? null, at: now })));
  return { acked: effectIds.length };
}

const valueText = (v) => (typeof v === 'string' ? v : Object.entries(v).map(([k, c]) => `${k}.${valueText(c)}`).join(', '));

/** A plain summary of the stored harness: what the pages and the orchestrator read. */
export function status(store) {
  const state = store.read();
  if (!state) return null;
  const s = state.snapshot;
  const children = Object.entries(s.children ?? {});
  const items = children
    .filter(([, c]) => c.src === 'workItem')
    .map(([key, c]) => {
      const snap = c.snapshot;
      const id = c.systemId ?? key;
      const decisions = Object.entries(snap.children ?? {}).map(([did, d]) => ({
        id: did,
        address: `${id}/${did}`,
        state: valueText(d.snapshot.value),
        ...pick(d.snapshot.context, ['decisionClass', 'tier', 'question', 'choice', 'decidedBy', 'autonomy']),
        standIn: d.snapshot.context.standIn ?? null
      }));
      return {
        id: snap.context.id,
        address: id,
        state: valueText(snap.value),
        done: snap.status === 'done' || ['done', 'failed', 'cancelled'].includes(snap.value),
        ...pick(snap.context, ['project', 'title', 'tier', 'criteria', 'checks', 'runs', 'retries', 'choice', 'url']),
        decisions
      };
    });
  const budget = children.find(([, c]) => c.src === 'budget')?.[1]?.snapshot;
  return {
    waitingOnPerson: waitingOnPerson(items),
    version: state.version,
    updatedAt: state.updatedAt,
    state: s.value,
    context: s.context,
    needsPerson: s.value.attention === 'needsPerson',
    budget: budget ? { mode: valueText(budget.value), ...pick(budget.context, ['sevenDay', 'fiveHour', 'dayStartSevenDay', 'dailyShare', 'softAt', 'sampledAt', 'estimated']) } : null,
    items
  };
}

/**
 * What waits on the person, in item order: an item triage gave no criteria (needsCriteria), and every
 * decision whose card is in front of the person (awaitingPerson). Mission control, the digest and
 * `harness status` count and list the same rows.
 */
export function waitingOnPerson(items) {
  return items
    .filter((i) => !i.done)
    .flatMap((i) => [
      ...(i.state.split('.').pop() === 'needsCriteria' ? [{ item: i.id, address: i.address, why: 'no criteria' }] : []),
      ...i.decisions.filter((d) => d.state === 'awaitingPerson').map((d) => ({ item: i.id, address: d.address, why: `${d.decisionClass} gate` }))
    ]);
}

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o?.[k] !== undefined).map((k) => [k, o[k]]));
