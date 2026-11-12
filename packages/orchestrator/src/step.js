// The protocol for a host that runs the sessions itself, such as the Claude Code mod: one input in, the item
// carried as far as it goes without a session, and what it now waits on out. Each call is its own process and
// the journal carries everything between calls, so such a host keeps nothing but which sessions it started.
// Calls on one item must not overlap: the host runs them one at a time.
import { drive } from './driver.js';
import { openItem } from './item.js';
import { check } from './schema.js';

/** Where an item is: its state, whether it is done (and its output then), and how long its journal is. */
export const where = (host) => ({
  state: host.snapshot?.value ?? null,
  done: host.done,
  seq: host.journal.length,
  ...(host.done ? { output: host.snapshot.output } : {})
});

/** Why an input about a run cannot be taken ({ refused } or { rejected }), or null when it can. */
export const refusal = ({ host, actors }, { run, claim }) => {
  const open = host.pending.find((p) => p.run === run);
  if (!open) return { refused: `run ${run} is not in flight` };
  const problems = claim === undefined ? [] : check(actors[open.actor].claim, claim);
  return problems.length ? { rejected: problems } : null;
};

const noTimers = { now: () => new Date().toISOString(), setTimeout: () => null, clearTimeout: () => {} };

/**
 * One step. The input is { event, source } (the start, a timer, an event from GitHub), { run, claim, source }
 * (a session's claim), { run, failed, source } (a session that ended without one), or null (just resume).
 * Returns where the item is, the sessions to start ({ run, actor, prompt, cwd, tools, schema }) and the timers
 * to set; or { refused } / { rejected } when the input cannot be taken.
 */
export const step = async (item, input) => {
  const no = input?.run && refusal(item, input);
  if (no) return no;
  const { host } = item;

  // The sessions port for this one step: the run this input answers gets its claim (or its failure); every
  // other run's job is noted as a session to start, and its work parks until a later step answers it.
  const toStart = [];
  const sessions = (job, { run }) => {
    if (run !== input?.run) {
      toStart.push({ run, ...job });
      return new Promise(() => {});
    }
    if ('failed' in input) return Promise.reject(new Error(input.failed));
    return Promise.resolve({ claim: input.claim, source: input.source });
  };

  const refused = [];
  const driver = drive({ ...item, sessions, clock: noTimers, log: (x) => x.refused && refused.push(x.refused) });
  if (input?.event) driver.send(input);
  await Promise.race([driver.settled, driver.idle()]);

  const openRuns = new Map(host.pending.filter((p) => p.type === 'run').map((p) => [p.run, p]));
  return {
    ...where(host),
    ...(refused.length ? { refused: refused.join('; ') } : {}),
    sessions: toStart
      .filter(({ run }) => openRuns.has(run))
      .map(({ run, prompt, cwd, tools, schema }) => ({ run, actor: openRuns.get(run).actor, prompt, cwd, tools, schema })),
    timers: host.pending.filter((p) => p.type === 'timer')
  };
};

/** Where the item in dir is, once its journal grows past seq or after seconds: a cheap way to watch it. */
export const wait = async (dir, seq, seconds = 50) => {
  const until = Date.now() + seconds * 1000;
  while (openItem(dir).journal.read().length <= seq && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return where(openItem(dir).host);
};
