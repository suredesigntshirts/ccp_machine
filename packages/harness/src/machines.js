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
  audit: load('audit'),
  workItem: load('workItem'),
  harness: load('harness')
};

/** Every event, in any machine, with a transition that `test` picks (such as one guarded by tapUnbound). */
export const eventsWhere = (test, out = new Set()) => {
  const walk = (node) => {
    for (const [ev, on] of Object.entries(node.on ?? {})) if ([on].flat().some(test)) out.add(ev);
    Object.values(node.states ?? {}).forEach(walk);
  };
  Object.values(specs).forEach(walk);
  return out;
};
// The events a person may send: those whose machine binds the tap to its posted card. apply() refuses the rest.
export const tapEvents = eventsWhere((t) => t.guard?.type === 'tapUnbound');

// Input overrides the spec's default context by shallow merge (v6's context patches behave the same).
const withInput = (config) => ({
  ...config,
  context: ({ input }) => ({ ...config.context, ...(input ?? {}) })
});

// Effects that leave the machine (posts, GitHub writes, starting threads). Each one is handed to
// the sink as data ({ name, actor, params, subject, detail }); the host's outbox carries it out
// later, so detail holds what the host needs to do it without reading the snapshot.
// The default sink drops them, and pure transition() returns them by name either way.
const DETAIL = ['item', 'address', 'title', 'url', 'project', 'tier', 'criteria', 'expectationsMet', 'decisionClass', 'question', 'choice', 'decidedBy', 'standIn', 'autonomy', 'day', 'picks'];
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

// Tell the parent actor, when there is one and make gives an event. A plain function (not sendParent) so that
// pure transition() returns it by name, like every other effect, and a standalone actor does not throw.
const toParent = (make) => ({ self, ...args }, params) => {
  const event = make({ self, ...args }, params);
  if (event) self._parent?.send(event);
};

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

const isText = (s) => typeof s === 'string' && s.trim() !== '';
export const VERDICTS = ['met', 'unmet', 'unclear'];
/** Every criterion's latest check says met, with evidence, from neither the orchestrator nor a worker on the item now. */
export const expectationsMet = ({ context: c }) =>
  c.criteria.length > 0 &&
  c.criteria.every((k) => {
    const v = c.checks?.[k];
    return v?.verdict === 'met' && isText(v.evidence) && v.by != null && v.by !== c.orchestrator && !(c.workers ?? []).includes(v.by);
  });

// Workers (spec workItem, Workers): spawns recorded by the lead, bound to their agent when it starts, and verdicts.
const HEX = (n) => new RegExp(`^[0-9a-f]{${n}}$`);
const SPAWN_ROLES = ['builder', 'verifier', 'triager', 'stand-in'];
const VERDICT_KINDS = ['PASS', 'FAIL'];
// The unbound spawn a starting agent belongs to: the sender's oldest of that agent type, at most withinMs old.
const spawnToBind = ({ context: c, event: e }, withinMs) =>
  (c.spawns ?? []).find((s) => !s.agent && s.by === e.actor?.id && s.agentType === e.agentType && Date.parse(e.receivedAt) - Date.parse(s.at) <= withinMs);
const workers = {
  briefOverreaches: ({ context, event }) => context.verifierBrief != null || !HEX(64).test(String(event.sha256 ?? '')),
  spawnOverreaches: ({ event: e }) => !SPAWN_ROLES.includes(e.role) || !HEX(64).test(String(e.briefSha256 ?? '')) || !isText(e.agentType) || (e.model != null && typeof e.model !== 'string'),
  roleNotHere: ({ event }, { roles }) => !roles.includes(event.role),
  agentTypeIsNot: ({ event }, types) => event.role in types && event.agentType !== types[event.role],
  noVerifierBrief: ({ context }) => context.verifierBrief == null,
  briefDiffers: ({ context, event }) => event.role === 'verifier' && (context.verifierBrief == null || event.briefSha256 !== context.verifierBrief),
  noSpawnToBind: (args, { withinMs }) => {
    const { context: c, event: e } = args;
    const [sid, aid, ...more] = String(e.agent ?? '').split('/');
    return sid !== e.actor?.id || !aid || more.length || (c.spawns ?? []).some((s) => s.agent === e.agent) || !spawnToBind(args, withinMs);
  },
  verdictOverreaches: ({ context, event: e }) =>
    !VERDICT_KINDS.includes(e.verdict) || !HEX(40).test(String(e.sha ?? '')) || !Number.isInteger(e.review) || !isText(e.text) || context.verifierBrief == null || !e.text.trimEnd().endsWith(context.verifierBrief),
  unverifiedHead: ({ context, event }) => context.verdicts?.[event.sha]?.verdict !== 'PASS'
};
const workerActions = {
  recordVerifierBrief: assign({ verifierBrief: ({ event }) => event.sha256 }),
  recordSpawn: assign({
    spawns: ({ context, event: e }) => [...(context.spawns ?? []), {
      role: e.role, briefSha256: e.briefSha256, agentType: e.agentType, model: e.model ?? null, toolUseId: e.toolUseId ?? null,
      definition: e.definition ?? null, harness: e.harness ?? null, by: e.actor.id, at: e.receivedAt, agent: null
    }]
  }),
  bindSpawn: assign({
    spawns: (args, { withinMs }) => {
      const s = spawnToBind(args, withinMs);
      return args.context.spawns.map((x) => (x === s ? { ...x, agent: args.event.agent } : x));
    }
  }),
  recordVerdict: assign({ verdicts: ({ context, event: e }) => ({ ...context.verdicts, [e.sha]: { verdict: e.verdict, review: e.review, by: e.actor.id, at: e.receivedAt } }) })
};

// Who sent an event. runtime.apply() takes only events with an actor and a source; the machines send each
// other events without them. These guards are the refusing first transition of an event (true refuses).
// They check kinds, that a ref is there and that ids differ. from-github reads a GitHub ref's fact from GitHub
// before it sends; whether a tap or a session id is real is checked afterwards.
// One actor plays one part on an item (spec workItem, Roles). Each role is a list of actor ids on the item's
// context (the decision gets a copy at spawn); an event from an actor holding another role is refused. Only the
// kinds marked roles in harness meta.actors (sessions and agents) are recorded; their id forms are disjoint
// (the runtime refuses any other), so an id names the whole actor. The person, GitHub and timers are exempt.
const holdsRoles = (actor) => specs.harness.meta.actors[actor?.kind]?.roles === true;
const ROLES = { requester: (c) => [c.requester], triager: (c) => c.triagers, worker: (c) => c.workers, checker: (c) => c.checkers, answerer: (c) => c.answerers };
const holdsAnotherRole = ({ context: c, event: { actor } }, { role }) =>
  holdsRoles(actor) && Object.entries(ROLES).some(([r, ids]) => r !== role && (ids(c) ?? []).includes(actor.id));
const asSession = (list, actor) => (holdsRoles(actor) ? [...new Set([...(list ?? []), actor.id])] : list ?? []);

// A card the machine asked for: CARD_POSTED records its message id once, on the ack of the card effect, and a
// tap is taken only with that id (decision and audit alike).
const cards = {
  cardOverreaches: ({ context, event }) => context.card != null || typeof event.card !== 'string' || !/^cmsg_[A-Za-z0-9_-]+$/.test(event.card),
  tapUnbound: ({ context, event }) => context.card == null || event.source?.kind !== 'tap' || event.source.ref !== context.card
};
const recordCard = assign({ card: ({ event }) => event.card });

const provenance = {
  unattested: ({ event }, p) => (p.actor != null && ![p.actor].flat().includes(event.actor?.kind)) || (p.source != null && (event.source?.kind !== p.source || !event.source.ref)),
  fromOutside: ({ event }) => event.actor != null
};

// One set per sink, so a host collects the effects it applies; rung(class): the ladder's autonomy as a decision opens.
export function createMachines(sink = () => {}, { rung } = {}) {
  const budgetMachine = setup({
    guards: {
      // Judge an old reading by the work since it: an idle harness spends almost nothing, so its last
      // reading stays a safe bound. With costSince the projected spend decides; without it, age alone.
      usageStale: ({ context, event }) => {
        if (context.sampledAt == null) return true;
        const age = Date.parse(event.now) - Date.parse(context.sampledAt);
        if (age > (context.backstopMs ?? 864e5)) return true;
        if (typeof event.costSince !== 'number') return age > context.staleAfterMs;
        const projected = (context.spentToday ?? 0) + event.costSince * (context.costRate ?? 0.002);
        return projected / context.dailyShare >= context.softAt;
      },
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

  const auditMachine = setup({
    guards: {
      unattested: provenance.unattested,
      ...cards,
      optionNotOffered: ({ context, event: { option } }) => !Number.isInteger(option) || option < 0 || option > context.picks.length
    },
    actions: {
      recordCard,
      recordAuditAnswer: assign({ option: ({ event }) => event.option }),
      ...external(sink, 'postAuditCard')
    }
  }).createMachine(withInput(specs.audit));

  const decisionMachine = setup({
    guards: {
      unattested: provenance.unattested,
      ...cards,
      choiceNotOffered: ({ context, event }) => !context.options.includes(event.choice),
      holdsAnotherRole,
      answeredByOrchestratorOrWorker: ({ context, event }) => event.actor?.id === context.orchestrator || (context.workers ?? []).includes(event.actor?.id),
      answerOverreaches: ({ event: { answer: a } }) =>
        !a || typeof a.choice !== 'string' || typeof a.confidence !== 'number' || !(a.confidence >= 0 && a.confidence <= 1) || Object.keys(a).some((k) => !['choice', 'confidence', 'reason'].includes(k)),
      // Tier from the item, autonomy and threshold from this decision's context, confidence from the stand-in.
      // An unknown tier is not below 2, and an accept decision needs the item's expectationsMet to be true.
      standInMayDecide: ({ context: c }) =>
        typeof c.tier === 'number' && c.tier < 2 && c.autonomy === 'act' && c.standIn.confidence >= c.threshold && (c.decisionClass !== 'accept' || c.expectationsMet === true)
    },
    actions: {
      recordStandInAnswer: assign({ standIn: ({ event }) => event.answer }),
      reportAnswerer: toParent(({ event }) => holdsRoles(event.actor) && { type: 'STAND_IN_RECORDED', by: event.actor.id }),
      acceptStandInChoice: assign({
        choice: ({ context }) => context.standIn.choice,
        decidedBy: 'stand-in'
      }),
      recordPersonChoice: assign({ choice: ({ event }) => event.choice, decidedBy: 'person' }),
      recordCard,
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
      ...provenance,
      ...workers,
      holdsAnotherRole,
      reportedByOrchestrator: ({ context, event }) => !context.orchestrator || event.actor?.id === context.orchestrator,
      triagedByParty: ({ context: c, event }) => !c.orchestrator || !event.actor?.id || [c.requester, c.orchestrator, ...(c.workers ?? [])].includes(event.actor?.id),
      // A tier, once set, is a floor: a re-triage (after a revise) may keep or raise it, never lower it.
      tierLowered: ({ context: c, event: e }) => typeof c.tier === 'number' && !(typeof e.tier === 'number' && e.tier >= c.tier),
      triageOverreaches: ({ event: e }) => ![0, 1, 2].includes(e.tier) || (e.criteria != null && !(Array.isArray(e.criteria) && e.criteria.every(isText))),
      noCriteria: ({ event }) => !event.criteria?.length,
      checkedByParty: ({ context: c, event }) => !c.orchestrator || !event.actor?.id || [c.orchestrator, ...(c.workers ?? [])].includes(event.actor?.id),
      checkOverreaches: ({ context, event: e }) =>
        !context.criteria.includes(e.criterion) || !VERDICTS.includes(e.verdict) || (e.verdict === 'met' && !isText(e.evidence)) || (e.evidence != null && typeof e.evidence !== 'string'),
      expectationsMet,
      retriesLeft: ({ context }, params) => context.retries < params.max,
      tierBelow: ({ context }, params) => typeof context.tier === 'number' && context.tier < params.tier,
      choiceIs: ({ event }, params) => event.choice === params.choice
    },
    actions: {
      recordOrchestrator: assign({ orchestrator: ({ event }) => event.orchestrator }),
      ...workerActions,
      recordTriage: assign(({ context, event }) => ({ tier: event.tier, criteria: [...new Set(event.criteria ?? [])], checks: {}, triagers: asSession(context.triagers, event.actor) })),
      recordCheck: assign(({ context, event: e }) => ({ checks: { ...context.checks, [e.criterion]: { verdict: e.verdict, evidence: e.evidence ?? '', by: e.actor?.id ?? null } }, checkers: asSession(context.checkers, e.actor) })),
      recordAnswerer: assign({ answerers: ({ context, event }) => [...new Set([...(context.answerers ?? []), event.by])] }),
      clearChecks: assign({ checks: {} }),
      recordExpectations: assign((_, params) => ({ expectationsMet: params.met })),
      recordRun: assign({ runs: ({ context }) => context.runs + 1, retries: 0 }),
      recordWorker: assign({ workers: ({ context, event }) => [...new Set([...(context.workers ?? []), event.actor?.id].filter(Boolean))] }),
      countRetry: assign({ retries: ({ context }) => context.retries + 1 }),
      recordChoice: assign({ choice: ({ event }) => event.choice }),
      // Each decision gets a fresh id; leaving its gate state (decided, blocked, cancelled) withdraws it,
      // so a stale card can never steer the item later.
      openDecision: enqueueActions(({ enqueue, context }, params) => {
        const id = `decision:${context.id}:${params.gate}:${context.decisions + 1}`;
        enqueue.assign({ decisions: context.decisions + 1, decisionId: id });
        enqueue.spawnChild('decision', {
          id,
          input: { id, item: context.id, address: `item:${context.id}/${id}`, decisionClass: params.gate, tier: context.tier, question: `${params.gate}: ${context.id}`, orchestrator: context.orchestrator,
            requester: context.requester, triagers: context.triagers ?? [], workers: context.workers ?? [], checkers: context.checkers ?? [], answerers: context.answerers ?? [],
            ...(params.gate === 'accept' && { expectationsMet: context.expectationsMet }), ...(rung && { autonomy: rung(params.gate) }) }
        });
      }),
      withdrawDecision: enqueueActions(({ enqueue, context }) => {
        if (context.decisionId) enqueue.stopChild(context.decisionId);
        enqueue.assign({ decisionId: null });
      }),
      // needsCriteria: the item waits on the person, in the person's inbox, and gives its slot back.
      giveUpSlot: toParent(({ context }) => ({ type: 'ITEM_PARKED', id: context.id })),
      notifyInboxOpened: enqueueActions(({ enqueue, context, system }) => {
        const harness = system.get('harness');
        if (harness) enqueue.sendTo(harness, { type: 'DECISION_PENDING', decisionId: `needsCriteria:${context.id}` });
      }),
      notifyInboxClosed: enqueueActions(({ enqueue, context, system }) => {
        const harness = system.get('harness');
        if (harness) enqueue.sendTo(harness, { type: 'DECISION_CLOSED', decisionId: `needsCriteria:${context.id}` });
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
    actors: { budget: budgetMachine, workItem: workItemMachine, audit: auditMachine },
    guards: {
      ...provenance,
      // The event's own UTC day (receivedAt, set by the runtime), not audited before, and 1 to max distinct logPrecedent effect ids.
      auditOverreaches: ({ context, event: { day, picks, receivedAt } }, { max }) =>
        typeof day !== 'string' || day !== String(receivedAt).slice(0, 10) || (context.audited ?? []).includes(day) ||
        !Array.isArray(picks) || !picks.length || picks.length > max || !picks.every(isText) || new Set(picks).size !== picks.length,
      // The filer names the work; a request that sets anything the item's machine holds is refused.
      requestOverreaches: ({ event: { request: r } }) => !r || typeof r.id !== 'string' || !r.id || Object.keys(r).some((k) => k in specs.workItem.context && !['id', 'project'].includes(k)),
      // Only the orchestrator's own session routes the work, so only it sets how much runs at once.
      notFromOrchestrator: ({ context, event: { actor } }) => actor?.kind !== 'session' || !context.orchestrator || actor.id !== context.orchestrator,
      wipOutOfRange: ({ event: { limit } }, { min, max }) => !Number.isInteger(limit) || limit < min || limit > max,
      modeIs: ({ event }, params) => event.mode === params.mode,
      inboxEmpty: ({ context }) => context.inbox.length === 0
    },
    actions: {
      // The orchestrator's id comes from here, never from the request or a report.
      recordOrchestrator: enqueueActions(({ enqueue, context, event }) => {
        enqueue.assign({ orchestrator: event.actor.id });
        for (const id of [...context.queued, ...context.inFlight]) enqueue.sendTo(id, { type: 'ORCHESTRATOR_STARTED', orchestrator: event.actor.id });
      }),
      spawnWorkItem: enqueueActions(({ enqueue, context, event }) => {
        const id = event.request.id;
        enqueue.spawnChild('workItem', { id, systemId: `item:${id}`, input: { ...event.request, orchestrator: context.orchestrator, requester: event.actor?.id ?? null } });
        enqueue.assign({ queued: ({ context }) => [...context.queued, id] });
      }),
      // inFlight and queued hold only items still running. An item that finished without its slot being released
      // (cancelled while queued in a store from before releaseSlot cleared the queue, then started) is dropped
      // here, so it never holds a slot. A child spawned by this same event is not in the snapshot yet: it stays.
      startReadyItems: enqueueActions(({ enqueue, context, self }) => {
        const running = (id) => (self.getSnapshot?.()?.children?.[id]?.getSnapshot?.().status ?? 'active') === 'active';
        const inFlight = context.inFlight.filter(running);
        const queued = context.queued.filter(running);
        const starting = queued.slice(0, Math.max(0, context.wipLimit - inFlight.length));
        for (const id of starting) enqueue.sendTo(id, { type: 'START' });
        enqueue.assign({ queued: queued.slice(starting.length), inFlight: [...inFlight, ...starting] });
      }),
      // An item that finishes while still queued (cancelled before it started) leaves the queue too.
      releaseSlot: assign({
        inFlight: ({ context, event }) => context.inFlight.filter((id) => id !== event.id),
        queued: ({ context, event }) => context.queued.filter((id) => id !== event.id)
      }),
      // The first change keeps the limit init gave, so replay can rebuild from it.
      recordWipLimit: assign({
        wipLimit: ({ event }) => event.limit,
        wipLimitAtInit: ({ context }) => context.wipLimitAtInit ?? context.wipLimit
      }),
      wrapUpInFlight: enqueueActions(({ enqueue, context }) => {
        for (const id of context.inFlight) enqueue.sendTo(id, { type: 'WRAP_UP' });
      }),
      recordBudgetMode: assign({ budgetMode: ({ event }) => event.mode }),
      openAudit: enqueueActions(({ enqueue, context, event: { day, picks } }) => {
        const id = `audit:${day}`;
        enqueue.spawnChild('audit', { id, systemId: id, input: { id, day, picks } });
        enqueue.assign({ audited: [...(context.audited ?? []), day] });
      }),
      addToInbox: assign({ inbox: ({ context, event }) => [...context.inbox, event.decisionId] }),
      removeFromInbox: assign({
        inbox: ({ context, event }) => context.inbox.filter((d) => d !== event.decisionId)
      }),
      ...external(sink, 'publishDigest')
    }
  }).createMachine(withInput(specs.harness));

  return { budget: budgetMachine, decision: decisionMachine, audit: auditMachine, workItem: workItemMachine, harness: harnessMachine };
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
