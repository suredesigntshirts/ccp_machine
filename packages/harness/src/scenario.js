// Scenarios: golden event stories for the spec. Each scenario file names a story, a list of events and
// what should hold after each one. runScenario plays the story through the real runtime on a scratch
// store, so a spec change that breaks a story fails here with the step that broke.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from './store.js';
import { init, apply, status } from './runtime.js';
import { logPrecedents, readDecisionLog, ladder } from './decision-log.js';

export const SCENARIOS_DIR = new URL('../scenarios/', import.meta.url).pathname;

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// dispatchRun is named with its step, so a story says which run it expects.
const effectName = (e) => (e.params?.step ? `${e.name}:${e.params.step}` : e.name);

function observe(store, result, expect) {
  const st = status(store);
  const item = (id) => st.items.find((i) => i.id === id)?.state ?? null;
  const got = {
    effects: () => result.effects.map(effectName),
    duplicate: () => Boolean(result.duplicate),
    scheduler: () => st.state.scheduler,
    budget: () => st.budget?.mode ?? null,
    inFlight: () => st.context.inFlight,
    queued: () => st.context.queued,
    inbox: () => st.context.inbox,
    needsPerson: () => st.needsPerson,
    items: () => Object.fromEntries(Object.keys(expect.items).map((id) => [id, item(id)])),
    standin: () => {
      logPrecedents(store);
      const rows = readDecisionLog(store);
      return Object.fromEntries(Object.keys(expect.standin).map((c) => [c, ladder(rows, c).autonomy]));
    }
  };
  return Object.keys(expect).map((k) => {
    if (!got[k]) return { key: k, expected: expect[k], actual: 'unknown expectation' };
    return { key: k, expected: expect[k], actual: got[k]() };
  });
}

/**
 * Play one scenario on a scratch store.
 * @param {{name: string, init?: object, steps: {event: object, to?: string, id?: string, now?: string, expect?: object}[]}} scenario
 * @returns {{name: string, ok: boolean, steps: number, failures: {step: number, key: string, expected: any, actual: any}[]}}
 */
export function runScenario(scenario) {
  const dir = mkdtempSync(join(tmpdir(), 'harness-scenario-'));
  const failures = [];
  try {
    const store = openStore(dir);
    init(store, scenario.init ?? {}, scenario.steps[0]?.now ?? '2026-10-26T00:00:00Z');
    scenario.steps.forEach((s, i) => {
      const result = apply(store, s.event, { to: s.to, id: s.id, now: s.now });
      for (const c of observe(store, result, s.expect ?? {})) if (!same(c.expected, c.actual)) failures.push({ step: i + 1, ...c });
    });
  } catch (e) {
    failures.push({ step: null, key: 'error', expected: null, actual: e.message });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return { name: scenario.name, ok: failures.length === 0, steps: scenario.steps.length, failures };
}

/** Run scenario files (default: every *.json in scenarios/). */
export function runScenarios(files = readdirSync(SCENARIOS_DIR).filter((f) => f.endsWith('.json')).sort().map((f) => join(SCENARIOS_DIR, f))) {
  return files.map((f) => ({ file: f, ...runScenario(JSON.parse(readFileSync(f, 'utf8'))) }));
}
