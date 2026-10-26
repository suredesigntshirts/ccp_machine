// Binds the JSON spec (spec/*.machine.json) to XState v5. The JSON holds every state, event, gate and the
// names of every effect; this file holds only what JSON cannot: guard logic, context updates, and
// stand-in effects that a real host replaces with machine.provide(). Keep it thin: if a rule matters
// to the person, it belongs in the JSON where it is visible and checked.
import { readFileSync } from 'node:fs';
import { setup, assign, enqueueActions } from 'xstate';

const load = (name) =>
  JSON.parse(readFileSync(new URL(`../spec/${name}.machine.json`, import.meta.url), 'utf8'));

export const specs = {
  budget: load('budget'),
  decision: load('decision'),
  workItem: load('workItem'),
  harness: load('harness')
};

// Input overrides the spec's default context by shallow merge (v6's context patches behave the same).
const withInput = (config) => ({
  ...config,
  context: ({ input }) => ({ ...config.context, ...(input ?? {}) })
});

// Effects that leave the machine (posts, GitHub writes, starting threads). Each one is handed to
// the sink as data ({ name, actor, params, subject, detail }); the host's outbox carries it out
// later, so detail holds what the host needs to do it without reading the snapshot.
// The default sink drops them, and pure transition() returns them by name either way.
const DETAIL = ['title', 'url', 'project', 'tier', 'decisionClass', 'question', 'choice', 'decidedBy', 'standIn'];
const external = (sink, ...names) =>
  Object.fromEntries(
    names.map((name) => [
      name,
      ({ self, context }, params) =>
        sink({
          name,
          actor: self.id,
          params: params ?? null,
          subject: context?.id ?? null,
          detail: Object.fromEntries(DETAIL.filter((k) => context?.[k] != null).map((k) => [k, context[k]]))
        })
    ])
  );

// Tell the parent actor, when there is one. A plain function (not sendParent) so that pure
// transition() returns it by name, like every other effect, and a standalone actor does not throw.
const toParent = (make) => ({ self, ...args }, params) => self._parent?.send(make({ self, ...args }, params));

// Today's spend accumulates sample by sample, so a 7-day window that resets mid-day (its resetsAt
// changes, or its utilization drops) restarts from 0 instead of going negative.
const usage = (c, e) => {
  const sevenDay = e.sevenDay ?? c.sevenDay;
  const resetsAt = e.sevenDayResetsAt ?? c.sevenDayResetsAt ?? null;
  const reset = (c.sevenDayResetsAt != null && resetsAt != null && resetsAt !== c.sevenDayResetsAt) || sevenDay < c.sevenDay;
  // A snapshot from before spentToday existed starts from its day-start difference.
  const spentToday = (c.spentToday ?? Math.max(0, c.sevenDay - c.dayStartSevenDay)) + Math.max(0, sevenDay - (reset ? 0 : c.sevenDay));
  return { sevenDay, fiveHour: e.fiveHour ?? c.fiveHour, sevenDayResetsAt: resetsAt, spentToday, sampledAt: e.at ?? c.sampledAt ?? null, estimated: e.type === 'USAGE_SAMPLED' ? e.estimated === true : (c.estimated ?? false) };
};
const spentShare = (c, u) => u.spentToday / c.dailyShare;

// One set of machines per sink, so a host can collect the effects of the events it applies.
export function createMachines(sink = () => {}) {
  const budgetMachine = setup({
    guards: {
      // No reading, or the newest is older than staleAfterMs at the tick's time: spend cannot be seen.
      usageStale: ({ context, event }) => context.sampledAt == null || Date.parse(event.now) - Date.parse(context.sampledAt) > context.staleAfterMs,
      fiveHourExhausted: ({ context, event }) => usage(context, event).fiveHour >= context.fiveHourStopAt,
      mustPause: ({ context, event }) => {
        const u = usage(context, event);
        return u.fiveHour >= context.fiveHourStopAt || spentShare(context, u) >= 1;
      },
      mustWrapUp: ({ context, event }) => {
        const u = usage(context, event);
        const s = spentShare(context, u);
        return u.fiveHour < context.fiveHourStopAt && s >= context.softAt && s < 1;
      },
      mayRun: ({ context, event }) => {
        const u = usage(context, event);
        return u.fiveHour < context.fiveHourStopAt && spentShare(context, u) < context.softAt;
      }
    },
    actions: {
      recordUsage: assign(({ context, event }) => usage(context, event)),
      startDay: assign(({ context, event }) => ({
        sevenDay: event.sevenDay ?? context.sevenDay,
        fiveHour: event.fiveHour ?? context.fiveHour,
        sevenDayResetsAt: event.sevenDayResetsAt ?? context.sevenDayResetsAt ?? null,
        dayStartSevenDay: event.sevenDay ?? context.sevenDay,
        spentToday: 0,
        sampledAt: event.at ?? context.sampledAt ?? null
      })),
      applyConfig: assign(({ event }) => event.config ?? {}),
      reportMode: toParent((_, params) => ({ type: 'BUDGET_MODE', mode: params.mode }))
    }
  }).createMachine(withInput(specs.budget));

  const decisionMachine = setup({
    guards: {
      // The stand-in decides alone only for tiers below 2, for a class whose autonomy is earned
      // ("act"), with confidence at or above that class's threshold.
      standInMayDecide: ({ context }) => {
        const a = context.standIn;
        return (
          !!a &&
          context.tier < 2 &&
          a.autonomy === 'act' &&
          typeof a.confidence === 'number' &&
          a.confidence >= (a.threshold ?? 1)
        );
      }
    },
    actions: {
      recordStandInAnswer: assign({ standIn: ({ event }) => event.answer }),
      acceptStandInChoice: assign({
        choice: ({ context }) => context.standIn.choice,
        decidedBy: 'stand-in'
      }),
      recordPersonChoice: assign({ choice: ({ event }) => event.choice, decidedBy: 'person' }),
      reportDecision: toParent(({ context }) => ({
        type: 'DECISION_MADE',
        choice: context.choice,
        decidedBy: context.decidedBy
      })),
      notifyInboxOpened: enqueueActions(({ enqueue, context, system }) => {
        const harness = system.get('harness');
        if (harness) enqueue.sendTo(harness, { type: 'DECISION_PENDING', decisionId: context.id });
      }),
      notifyInboxClosed: enqueueActions(({ enqueue, context, system }) => {
        const harness = system.get('harness');
        if (harness) enqueue.sendTo(harness, { type: 'DECISION_CLOSED', decisionId: context.id });
      }),
      ...external(sink, 'askStandIn', 'postDecisionCard', 'logPrecedent')
    }
  }).createMachine(withInput(specs.decision));

  const workItemMachine = setup({
    actors: { decision: decisionMachine },
    guards: {
      retriesLeft: ({ context }, params) => context.retries < params.max,
      tierBelow: ({ context }, params) => context.tier < params.tier,
      choiceIs: ({ event }, params) => event.choice === params.choice
    },
    actions: {
      recordRun: assign({ runs: ({ context }) => context.runs + 1, retries: 0 }),
      countRetry: assign({ retries: ({ context }) => context.retries + 1 }),
      recordChoice: assign({ choice: ({ event }) => event.choice }),
      // Each decision gets a fresh id; leaving its gate state (decided, blocked, cancelled) withdraws it,
      // so a stale card can never steer the item later.
      openDecision: enqueueActions(({ enqueue, context }, params) => {
        const id = `decision:${context.id}:${params.gate}:${context.decisions + 1}`;
        enqueue.assign({ decisions: context.decisions + 1, decisionId: id });
        enqueue.spawnChild('decision', {
          id,
          input: { id, decisionClass: params.gate, tier: context.tier, question: `${params.gate}: ${context.id}` }
        });
      }),
      withdrawDecision: enqueueActions(({ enqueue, context }) => {
        if (context.decisionId) enqueue.stopChild(context.decisionId);
        enqueue.assign({ decisionId: null });
      }),
      reportFinished: toParent(({ context }, params) => ({
        type: 'ITEM_FINISHED',
        id: context.id,
        outcome: params.outcome
      })),
      ...external(sink, 'dispatchRun', 'mergePullRequest', 'reportBlocked', 'checkpoint')
    }
  }).createMachine(withInput(specs.workItem));

  const harnessMachine = setup({
    actors: { budget: budgetMachine, workItem: workItemMachine },
    guards: {
      modeIs: ({ event }, params) => event.mode === params.mode,
      inboxEmpty: ({ context }) => context.inbox.length === 0
    },
    actions: {
      spawnWorkItem: enqueueActions(({ enqueue, event }) => {
        const id = event.request.id;
        enqueue.spawnChild('workItem', { id, systemId: `item:${id}`, input: event.request });
        enqueue.assign({ queued: ({ context }) => [...context.queued, id] });
      }),
      startReadyItems: enqueueActions(({ enqueue, context }) => {
        const free = Math.max(0, context.wipLimit - context.inFlight.length);
        const starting = context.queued.slice(0, free);
        for (const id of starting) enqueue.sendTo(id, { type: 'START' });
        enqueue.assign({
          queued: context.queued.slice(starting.length),
          inFlight: [...context.inFlight, ...starting]
        });
      }),
      releaseSlot: assign({
        inFlight: ({ context, event }) => context.inFlight.filter((id) => id !== event.id)
      }),
      wrapUpInFlight: enqueueActions(({ enqueue, context }) => {
        for (const id of context.inFlight) enqueue.sendTo(id, { type: 'WRAP_UP' });
      }),
      recordBudgetMode: assign({ budgetMode: ({ event }) => event.mode }),
      addToInbox: assign({ inbox: ({ context, event }) => [...context.inbox, event.decisionId] }),
      removeFromInbox: assign({
        inbox: ({ context, event }) => context.inbox.filter((d) => d !== event.decisionId)
      }),
      ...external(sink, 'publishDigest')
    }
  }).createMachine(withInput(specs.harness));

  return { budget: budgetMachine, decision: decisionMachine, workItem: workItemMachine, harness: harnessMachine };
}

export const machines = createMachines();

// Names the JSON refers to, so tests can prove the spec and the bindings agree.
export function referencedNames(config) {
  const names = { actions: new Set(), guards: new Set(), actors: new Set() };
  const asList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
  const addAction = (a) => names.actions.add(typeof a === 'string' ? a : a.type);
  const addTransition = (t) => {
    for (const tr of asList(t)) {
      if (typeof tr === 'string') continue;
      if (tr.guard) names.guards.add(typeof tr.guard === 'string' ? tr.guard : tr.guard.type);
      asList(tr.actions).forEach(addAction);
    }
  };
  const walk = (node) => {
    asList(node.entry).forEach(addAction);
    asList(node.exit).forEach(addAction);
    Object.values(node.on ?? {}).forEach(addTransition);
    addTransition(node.always);
    for (const inv of asList(node.invoke)) names.actors.add(inv.src);
    Object.values(node.states ?? {}).forEach(walk);
  };
  walk(config);
  return names;
}
