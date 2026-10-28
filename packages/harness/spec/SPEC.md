# Harness spec (generated)

Generated from `packages/harness/spec/*.machine.json` by `npm run spec:render`. Do not edit by hand: change the JSON.

## budget (v0.1.0)

Spends a daily slice of the person's 7-day Claude usage window and watches the 5-hour window. Utilization values are 0..1 shares of each window. Today's spend (spentToday) accumulates per sample; when the 7-day window resets mid-day (sevenDayResetsAt changes or utilization drops) it counts on from 0. A TICK judges an old reading by the work done since, not by its age alone: with no reading, or one older than backstopMs (24h), it drains a normal budget to wrappingUp. A TICK that carries costSince (the dollars of ledger turns filed since the newest reading) projects today's spend as spentToday + costSince x costRate (7-day share per dollar, conservative by default) and drains only when that reaches the soft limit, so an idle harness keeps accepting on an old reading. A TICK without costSince keeps the plain age rule (staleAfterMs). A fresh reading lifts it.

```mermaid
stateDiagram-v2
  state "normal" as normal
  state "wrappingUp" as wrappingUp
  state "paused" as paused
  note right of paused : budget-stop
  [*] --> normal
  normal --> paused : USAGE_SAMPLED [mustPause]
  normal --> wrappingUp : USAGE_SAMPLED [mustWrapUp]
  normal --> wrappingUp : TICK [usageStale]
  wrappingUp --> paused : USAGE_SAMPLED [mustPause]
  wrappingUp --> normal : USAGE_SAMPLED [mayRun]
  paused --> normal : USAGE_SAMPLED [mayRun]
  paused --> wrappingUp : USAGE_SAMPLED [mustWrapUp]
  note left of paused : from any state on DAY_STARTED
  note left of normal : from any state on DAY_STARTED
```

States:

- `normal`: Work may start.
- `wrappingUp`: Soft limit reached: start nothing new, bring work in flight to a checkpoint.
- `paused` (tags: `budget-stop`): Daily allowance spent or the 5-hour window nearly full: no turns except to save state.

Effects and context updates: `applyConfig`, `recordUsage`, `reportMode`, `startDay`

Guards: `fiveHourExhausted`, `mayRun`, `mustPause`, `mustWrapUp`, `usageStale`

## decision (v0.1.0)

One decision. The stand-in answers first; it decides alone only where the person's live grant covers the decision (grantCovers, spec grant) or its autonomy for this decision class is earned (standInMayDecide, the ladder), otherwise the person decides on a card with its recommendation. Every decision says its door (meta.classes): a two-way door is cheaply reversible, a one-way door is not. Each input of standInMayDecide has one supplier, and none of them is the stand-in's caller: tier is the item's, set by triage (TRIAGED), never by the request; expectationsMet is the item's, from its acceptGate, for an accept decision; autonomy is the ladder's rung for the class over the store's own decided decisions (its logPrecedent effects and the AUDIT_ANSWERED events dated at or before the spawn; no file kept by hand), which the harness reads when it spawns the decision (recommend if they cannot be read, so the person decides); threshold is the constant in this machine's context; confidence is the stand-in's, the only number its answer carries. Only a person's tap decides for the person, and only on the card the machine asked for: postDecisionCard asks the host to post the card (its detail carries the decision's item and address, item:<item>/<id>, where the ack and the tap go), the host's ack of that effect names the card's message id (CARD_POSTED, which the decision records once), and PERSON_DECIDED is taken only from the person with source tap:<that id> and a choice among the card's options. A tap on no card, an unposted card or another decision's card is refused; that the tap is real is checked afterwards against the platform (harness verify-taps, by another session, which names the session that relayed each tap: relayedBy on the log row). The item passes in its roles when it opens the decision (requester, triagers, workers, checkers, answerers; spec workItem, Roles), and a stand-in answer from a session holding another of them is refused; the answering session is reported to the item (STAND_IN_RECORDED), which records it as an answerer.

Decision classes:

- `plan`: two-way door. Approving a plan only lets the build start; a revise or a cancel later undoes it.
- `accept`: two-way door. Accepting the work only moves the item on toward its merge; nothing reaches main until it merges.
- `merge`: one-way door. Merging puts the change on main for everyone; undoing it takes a revert.

Each decision class has one door, two-way (cheaply reversible) or one-way, and a decision takes its class's door when the item opens it (context.door); a class not listed here is a one-way door. The grant's checklist offers these classes, and a grant decides a one-way door only when it names that class and has the one-way-door box ticked (spec grant).

```mermaid
stateDiagram-v2
  state "askingStandIn" as askingStandIn
  state "routing" as routing
  state "awaitingPerson" as awaitingPerson
  note right of awaitingPerson : needs-human
  state "decided ✓" as decided
  [*] --> askingStandIn
  askingStandIn --> routing : STAND_IN_ANSWERED
  askingStandIn --> awaitingPerson : STAND_IN_FAILED
  routing --> decided : always [grantCovers]
  routing --> decided : always [standInMayDecide]
  routing --> awaitingPerson : always
  awaitingPerson --> decided : PERSON_DECIDED
```

States:

- `routing`: The stand-in decides alone under the person's grant (grantCovers) when the harness's grant, read as the answer arrived (readLiveGrant: the one grant the harness holds, so a replaced grant is gone), has not ended by the answer's own time (receivedAt, before until), names this decision's class, and, for a one-way door, has the one-way-door box; the answer carries a reason, its confidence is at or above the machine's threshold, and for an accept decision the item's expectationsMet was true when it opened. Tier and autonomy do not matter there. Otherwise, as before the grant (the ladder rule, standInMayDecide), it decides alone when the tier is below 2, the class's autonomy (set at spawn from the ladder) is act, its confidence is at or above the machine's threshold, and, for an accept decision, the item's expectationsMet was true when the decision opened (false or unknown is not); otherwise the person decides. Which rule decided is recorded (authority: grant or ladder) and logged with the precedent, so every grant decision can be listed for the person.
- `awaitingPerson` (tags: `needs-human`): A decision card is in front of the person, with the stand-in's recommendation. The card is the one the machine asked for (postDecisionCard); its message id arrives with the ack (CARD_POSTED), and only a tap on it decides.

Refused (nothing changes and nothing is written):

- `STAND_IN_ANSWERED` in `askingStandIn`, when `unattested` {"actor":["session","agent"]}: Refused unless a session or an agent sends it: the stand-in is a session or a subagent of one (harness meta.actors).
- `STAND_IN_ANSWERED` in `askingStandIn`, when `answeredByOrchestratorOrWorker`: Refused from the orchestrator and from every worker that reported a run for this item (both recorded on the decision when it is spawned): only the stand-in answers, never the party whose work it judges or the one that routes it. The machine compares the ids it is given; who the sessions are is checked afterwards.
- `STAND_IN_ANSWERED` in `askingStandIn`, when `holdsAnotherRole` {"role":"answerer"}: Refused when the sender, a session or an agent (harness meta.actors), already holds another role on the item (requester, triager, worker or criterion checker; the item passes them in when it opens the decision): the stand-in that answers played no other part. The person and GitHub are exempt. The machine compares the whole actor; harness verify-actors checks sessions against the platform's ledger and agents against the SubagentStart records.
- `STAND_IN_ANSWERED` in `askingStandIn`, when `answerOverreaches`: Refused unless the answer is exactly a choice, a confidence between 0 and 1, and optionally a reason. An answer that carries autonomy or threshold is refused: the machine holds both. A missing confidence is refused; there is no default.
- `CARD_POSTED` in `awaitingPerson`, when `unattested` {"actor":"session"}: Refused unless a session sends it: the host session that posted the card acks the postDecisionCard effect with the card's message id (harness ack <effect> --card <cmsg id>, the only way to name it). A second ack of the effect is refused and writes nothing.
- `CARD_POSTED` in `awaitingPerson`, when `cardOverreaches`: Refused unless it names one message id (cmsg_...) and this decision has no card yet: one decision, one card, recorded once.
- `PERSON_DECIDED` in `awaitingPerson`, when `unattested` {"actor":"person","source":"tap"}: Refused unless the actor is a person and the source a tap.
- `PERSON_DECIDED` in `awaitingPerson`, when `tapUnbound`: Refused unless the tap's ref is this decision's card: the message id CARD_POSTED recorded when the host acked this decision's postDecisionCard effect. A tap before the card is posted, on another decision's card or on no card at all changes nothing. Whether the tap happened is checked afterwards against the platform (harness verify-taps).
- `PERSON_DECIDED` in `awaitingPerson`, when `choiceNotOffered`: Refused unless the choice is one of the card's options (the decision's options: approve, revise, reject).

Effects and context updates: `acceptStandInChoice`, `askStandIn`, `logPrecedent`, `notifyInboxClosed`, `notifyInboxOpened`, `postDecisionCard`, `readLiveGrant`, `recordCard`, `recordPersonChoice`, `recordStandInAnswer`, `reportAnswerer`, `reportDecision`

Guards: `answerOverreaches`, `answeredByOrchestratorOrWorker`, `cardOverreaches`, `choiceNotOffered`, `grantCovers`, `holdsAnotherRole`, `standInMayDecide`, `tapUnbound`, `unattested`

## audit (v0.1.0)

The day's stand-in audit. A class nobody checks never moves its ladder, so once a day the harness picks up to 3 decisions the stand-in made alone (AUDIT_PICKED, sent to the harness by the session that read the decision log; the picks are logPrecedent effect ids, which the decision log resolves from the store's own outbox and ignores when they name no stand-in decision). The audit asks the host to post one card (postAuditCard): option 0 confirms every pick, option i reverses pick i. The host's ack of that effect names the card's message id (CARD_POSTED), and the answer is AUDIT_ANSWERED from the person, by a tap on that card, exactly as a decision's PERSON_DECIDED. The decision log and the ladder read the answer from the event log (one person's decision per pick, dated when the person answered); no file in the store is read for a rung.

```mermaid
stateDiagram-v2
  state "awaitingPerson" as awaitingPerson
  note right of awaitingPerson : needs-human
  state "answered ✓" as answered
  [*] --> awaitingPerson
  awaitingPerson --> answered : AUDIT_ANSWERED
```

States:

- `awaitingPerson` (tags: `needs-human`): The audit card is in front of the person. Its message id arrives with the ack of postAuditCard (CARD_POSTED), and only a tap on it answers.
- `answered`: The person answered. The event log holds the answer; the decision log turns it into one person's decision per pick.

Refused (nothing changes and nothing is written):

- `CARD_POSTED` in `awaitingPerson`, when `unattested` {"actor":"session"}: Refused unless a session sends it: the host session that posted the card acks the postAuditCard effect with the card's message id (harness ack <effect> --card <cmsg id>).
- `CARD_POSTED` in `awaitingPerson`, when `cardOverreaches`: Refused unless it names one message id (cmsg_...) and this audit has no card yet.
- `AUDIT_ANSWERED` in `awaitingPerson`, when `unattested` {"actor":"person","source":"tap"}: Refused unless the actor is a person and the source a tap.
- `AUDIT_ANSWERED` in `awaitingPerson`, when `tapUnbound`: Refused unless the tap's ref is this audit's card, the message id CARD_POSTED recorded on the ack of its postAuditCard effect. A tap on no card, an unposted card or another card changes nothing.
- `AUDIT_ANSWERED` in `awaitingPerson`, when `optionNotOffered`: Refused unless the option is one of the card's: 0 (all right) or i, 1 to the number of picks (reverse pick i).

Effects and context updates: `postAuditCard`, `recordAuditAnswer`, `recordCard`

Guards: `cardOverreaches`, `optionNotOffered`, `tapUnbound`, `unattested`

## grant (v0.1.0)

The person's grant to the stand-in: which decision kinds it may decide alone, and until when. A session the person asked sends GRANT_ASKED to the harness, which opens this actor (grant:<n>) with a checklist the machine generates (meta.checklist): one tick per decision class (spec decision meta.classes, each marked with its door), the one-way-door box, and end times counted from the ask. The actor asks the host to post the checklist card (postGrantCard); the host's ack names the card's message id (CARD_POSTED), and the person's ticks arrive as one tap event naming that card, PERSON_GRANTED {picks}, taken exactly like PERSON_DECIDED. The grant it reports to the harness (GRANT_GIVEN) is {card, kinds, oneWay, until, at} built from the picks alone; the harness holds one grant, so the tap replaces any earlier one. A grant decides a two-way door whose class it names, and a one-way door only when it names the class and has the one-way-door box; it decides nothing at or after until. Tapping a checklist with no kind ticked ends the live grant.

Checklist: end times 2, 8, 24, 72 hours after the ask. The options, generated when the ask is opened: kind:<class> for every class in spec decision meta.classes, one-way (the one-way-door box), and until:<ISO time> for each of endsAfterHours after the ask's own time (receivedAt). A tap names any of the kinds, the box or not, and exactly one end time.

```mermaid
stateDiagram-v2
  state "awaitingPerson" as awaitingPerson
  note right of awaitingPerson : needs-human
  state "granted ✓" as granted
  [*] --> awaitingPerson
  awaitingPerson --> granted : PERSON_GRANTED
```

States:

- `awaitingPerson` (tags: `needs-human`): The checklist card is in front of the person. Its message id arrives with the ack of postGrantCard (CARD_POSTED), and only a tap on it grants.
- `granted`: The person ticked the checklist. The harness holds the grant (GRANT_GIVEN) until its end time or the next tap on a checklist.

Refused (nothing changes and nothing is written):

- `CARD_POSTED` in `awaitingPerson`, when `unattested` {"actor":"session"}: Refused unless a session sends it: the host session that posted the checklist acks the postGrantCard effect with the card's message id (harness ack <effect> --card <cmsg id>).
- `CARD_POSTED` in `awaitingPerson`, when `cardOverreaches`: Refused unless it names one message id (cmsg_...) and this ask has no card yet.
- `PERSON_GRANTED` in `awaitingPerson`, when `unattested` {"actor":"person","source":"tap"}: Refused unless the actor is a person and the source a tap: no session, agent or timer can grant.
- `PERSON_GRANTED` in `awaitingPerson`, when `tapUnbound`: Refused unless the tap's ref is this ask's card, the message id CARD_POSTED recorded on the ack of its postGrantCard effect. A tap on no card, an unposted card, a decision's or an audit's card, or an earlier checklist changes nothing.
- `PERSON_GRANTED` in `awaitingPerson`, when `picksNotOffered`: Refused unless picks is a list of the card's own options, each at most once, with exactly one end time: a kind, a box or an end time the machine did not generate is refused.

Effects and context updates: `postGrantCard`, `recordCard`, `recordPicks`, `reportGrant`

Guards: `cardOverreaches`, `picksNotOffered`, `tapUnbound`, `unattested`

## workItem (v0.1.0)

One thing moving through the pipeline: a change to one project of the monorepo, from request to merge. Runs and merges happen outside the machine; their results come back as events on later wakes. The request names the work (id, project, title, what the person expects in their own words) and nothing the machine holds: tier and criteria come from TRIAGED, sent by a triager who is not the requester, the orchestrator or a worker, and nothing leaves triage before it. Run results come from a worker other than the orchestrator, whose id the harness passes in (orchestrator); every worker that reports a run, succeeded or failed, is recorded (workers), and both ids go to every decision the item opens, so neither can answer as the stand-in. Each criterion is checked by CRITERION_CHECKED from an actor who is neither the orchestrator nor a worker; the stand-in may approve accept only when expectationsMet holds, and a new build clears the checks. A tier, once triage sets it, never goes down: a re-triage after a revise may keep or raise it. Tier 0 still has no plan or accept gate. That is acceptable for now because the tier comes from triage, not from the filer. CI and merge results come only from GitHub wakes, which from-github applies only after GitHub's REST API agrees. The machine checks actor and source kinds, that a ref is there, and that ids differ; who the sessions are is checked afterwards against the platform.

Roles: the item records who played each part, by actor: its requester (REQUEST_RECEIVED), triagers (TRIAGED), workers (RUN_SUCCEEDED, RUN_FAILED), criterion checkers (CRITERION_CHECKED) and stand-in answerers (STAND_IN_ANSWERED on any of its decisions, which the decision reports up as STAND_IN_RECORDED). One actor plays one part on an item: an event whose actor already holds a different role there is refused (holdsAnotherRole), so the triager cannot build, check or answer, a worker cannot triage, check or answer, a checker cannot build or answer, and the stand-in cannot triage, build or check. Each decision the item opens takes the roles as they stand. Roles are held by the worker actors, sessions and agents (harness meta.actors), compared by the whole actor: a subagent is agent <session_id>/<agent_id>, so two subagents of one session are distinct from each other and from their parent session, and the lead's triager, builder and checker subagents can play different parts. The person and GitHub are exempt: they are never recorded or compared. A session id is the platform's: the CLI takes CLAUDE_CODE_SESSION_ID and refuses an --actor session:<id> that differs; for a subagent it takes the agent from the plugin's PreToolUse hook (HARNESS_AGENT) and refuses any --actor session or other agent. harness verify-actors checks every session in the log against the Stop hook's ledger and every agent against the SubagentStart hook's record.

```mermaid
stateDiagram-v2
  state "active" as active
  state "blocked" as blocked
  state "done ✓" as done
  state "failed ✓" as failed
  state "cancelled ✓" as cancelled
  [*] --> active
  active --> blocked : BLOCK
  state "queued" as active_queued
  state "triaging" as active_triaging
  state "needsCriteria" as active_needsCriteria
  note right of active_needsCriteria : needs-human
  state "planGate" as active_planGate
  state "awaitingPlanDecision" as active_awaitingPlanDecision
  note right of active_awaitingPlanDecision : gated
  state "building" as active_building
  state "verifying" as active_verifying
  state "acceptGate" as active_acceptGate
  state "awaitingAcceptance" as active_awaitingAcceptance
  note right of active_awaitingAcceptance : gated
  state "integrationGate" as active_integrationGate
  state "awaitingMergeDecision" as active_awaitingMergeDecision
  note right of active_awaitingMergeDecision : gated
  state "merging" as active_merging
  state "hist" as active_hist
  [*] --> active_queued
  active_queued --> active_triaging : START
  active_triaging --> active_needsCriteria : TRIAGED [noCriteria]
  active_triaging --> active_planGate : TRIAGED
  active_triaging --> active_triaging : RUN_FAILED [retriesLeft {"max":2}]
  active_triaging --> failed : RUN_FAILED
  active_needsCriteria --> cancelled : CANCEL
  active_planGate --> active_building : always [tierBelow {"tier":1}]
  active_planGate --> active_awaitingPlanDecision : always
  active_awaitingPlanDecision --> active_building : DECISION_MADE [choiceIs {"choice":"approve"}]
  active_awaitingPlanDecision --> active_triaging : DECISION_MADE [choiceIs {"choice":"revise"}]
  active_awaitingPlanDecision --> cancelled : DECISION_MADE
  active_building --> active_verifying : RUN_SUCCEEDED
  active_building --> active_building : RUN_FAILED [retriesLeft {"max":2}]
  active_building --> failed : RUN_FAILED
  active_verifying --> active_acceptGate : CHECKS_PASSED
  active_verifying --> active_building : CHECKS_FAILED [retriesLeft {"max":2}]
  active_verifying --> blocked : CHECKS_FAILED
  active_acceptGate --> active_integrationGate : always [tierBelow {"tier":1}]
  active_acceptGate --> active_awaitingAcceptance : always [expectationsMet]
  active_acceptGate --> active_awaitingAcceptance : always
  active_awaitingAcceptance --> active_integrationGate : DECISION_MADE [choiceIs {"choice":"approve"}]
  active_awaitingAcceptance --> active_building : DECISION_MADE [choiceIs {"choice":"revise"}]
  active_awaitingAcceptance --> cancelled : DECISION_MADE
  active_awaitingAcceptance --> active_acceptGate : CRITERION_CHECKED
  active_integrationGate --> active_merging : always [tierBelow {"tier":2}]
  active_integrationGate --> active_awaitingMergeDecision : always
  active_awaitingMergeDecision --> active_merging : DECISION_MADE [choiceIs {"choice":"approve"}]
  active_awaitingMergeDecision --> active_building : DECISION_MADE [choiceIs {"choice":"revise"}]
  active_awaitingMergeDecision --> cancelled : DECISION_MADE
  active_merging --> done : MERGED
  active_merging --> blocked : MERGE_FAILED
  blocked --> active_hist : UNBLOCKED
  note left of cancelled : from any state on CANCEL
```

States:

- `active.queued`: Waiting for the scheduler to give it a slot.
- `active.triaging`: Scope, project, tier and acceptance criteria. The triage run's result is TRIAGED {tier, criteria}, from the triager; the item leaves triage only on it. A revise at the plan gate comes back here, and the tier it already has is a floor: a later triage may raise it, never lower it. A triager's failed run is a worker's run like any other.
- `active.needsCriteria` (tags: `needs-human`): Triage gave no criteria, so nothing could ever show the work is done: the item waits for the person and nothing proceeds from here. Missing criteria never count as met. It is in the person's inbox while it is here (counted and listed with the decisions that wait on the person), and it gives up its work-in-progress slot on entry (ITEM_PARKED), so other work starts while it waits. BLOCK and UNBLOCKED bring it back here, never to building. The way out is to cancel it; a new request with what done looks like starts again.
- `active.awaitingPlanDecision` (tags: `gated`)
- `active.building`: A worker thread builds on its own branch and opens a PR. Every build starts with no criterion checked: a check of an earlier build is not evidence for this one.
- `active.verifying`: CI, spec checks and a reviewer run against the acceptance criteria. The reviewer sends one CRITERION_CHECKED {criterion, verdict, evidence} per criterion; the latest verdict for a criterion counts.
- `active.acceptGate`: expectationsMet is true only when every criterion's latest CRITERION_CHECKED says met, with evidence, from an actor who is neither the orchestrator nor one of the item's workers now. Unmet, unclear, unchecked or no criteria are not met. The accept decision opens with the answer, and when it is false the stand-in cannot decide it, so the person does.
- `active.awaitingAcceptance` (tags: `gated`): Evidence against each acceptance criterion: is the work doing what the person expected? A criterion checked now takes the item back through acceptGate, which withdraws this decision and opens a new one with the new answer.
- `active.awaitingMergeDecision` (tags: `gated`): Merge to main, a one-way door: the person decides and the stand-in recommends, unless the person's live grant names merge and has the one-way-door box (spec decision, grantCovers).
- `blocked`: Waiting on something outside the item (a dependency, a conflict, a failing check). Resumes where it stopped.

Refused (nothing changes and nothing is written):

- `ORCHESTRATOR_STARTED` in any state, when `fromOutside`: Sent by the harness when an orchestrator starts inside the harness; the same event from outside (any event with an actor) is refused.
- `STAND_IN_RECORDED` in any state, when `fromOutside`: Sent by the item's own decision when the stand-in's answer is recorded, naming the answering session; the same event from outside (any event with an actor) is refused.
- `TRIAGED` in `active.triaging`, when `triagedByParty`: Refused from the requester's actor, the orchestrator (or while none is known), every worker on the item and an event with no actor: the tier and the criteria are not set by the party that asked for the work, routes it or does it. The machine compares the ids it is given; who the sessions are is checked afterwards.
- `TRIAGED` in `active.triaging`, when `holdsAnotherRole` {"role":"triager"}: Refused when the sender, a session or an agent (harness meta.actors), already holds another role on this item (requester, worker, criterion checker or stand-in answerer): the triager plays no other part. The person and GitHub are exempt. The machine compares the whole actor; harness verify-actors checks sessions against the platform's ledger and agents against the SubagentStart records.
- `TRIAGED` in `active.triaging`, when `triageOverreaches`: Refused unless tier is 0, 1 or 2, and criteria, when given, is a list of non-empty strings. A missing criteria list is no criteria.
- `TRIAGED` in `active.triaging`, when `tierLowered`: Refused when the item already has a tier and this TRIAGED gives a lower one (or none). A revise sends the plan back to triage, which runs again and may keep or raise the tier but never lower it, so a second triage cannot skip a gate the first one set. The guard reads the previous tier from context, which a revise keeps; an equal or higher tier is taken.
- `RUN_FAILED` in `active.triaging`, when `reportedByOrchestrator`: Refused when the orchestrator reports the run itself, or no orchestrator is known yet: a run result comes from a worker, an actor other than the orchestrator. The machine compares the ids it is given; that the worker really ran is checked afterwards.
- `RUN_FAILED` in `active.triaging`, when `holdsAnotherRole` {"role":"worker"}: Refused when the sender, a session or an agent (harness meta.actors), already holds another role on this item (requester, triager, criterion checker or stand-in answerer): the triager, a checker or the stand-in cannot build. The person and GitHub are exempt. The machine compares the whole actor; harness verify-actors checks sessions against the platform's ledger and agents against the SubagentStart records.
- `DECISION_MADE` in `active.awaitingPlanDecision`, when `fromOutside`: Sent by the item's own decision when it is decided inside the harness; the same event from outside (any event with an actor) is refused.
- `RUN_SUCCEEDED` in `active.building`, when `reportedByOrchestrator`: Refused when the orchestrator reports the run itself, or no orchestrator is known yet: a run result comes from a worker, an actor other than the orchestrator. The machine compares the ids it is given; that the worker really ran is checked afterwards.
- `RUN_SUCCEEDED` in `active.building`, when `holdsAnotherRole` {"role":"worker"}: Refused when the sender, a session or an agent (harness meta.actors), already holds another role on this item (requester, triager, criterion checker or stand-in answerer): the triager, a checker or the stand-in cannot build. The person and GitHub are exempt. The machine compares the whole actor; harness verify-actors checks sessions against the platform's ledger and agents against the SubagentStart records.
- `RUN_FAILED` in `active.building`, when `reportedByOrchestrator`: Refused when the orchestrator reports the run itself, or no orchestrator is known yet: a run result comes from a worker, an actor other than the orchestrator. The machine compares the ids it is given; that the worker really ran is checked afterwards.
- `RUN_FAILED` in `active.building`, when `holdsAnotherRole` {"role":"worker"}: Refused when the sender, a session or an agent (harness meta.actors), already holds another role on this item (requester, triager, criterion checker or stand-in answerer): the triager, a checker or the stand-in cannot build. The person and GitHub are exempt. The machine compares the whole actor; harness verify-actors checks sessions against the platform's ledger and agents against the SubagentStart records.
- `CHECKS_PASSED` in `active.verifying`, when `unattested` {"actor":"github","source":"github-wake"}: Refused unless a CI result comes from GitHub: actor github, source github-wake, with the GitHub fact as ref. The machine checks the kinds and that a ref is there; harness from-github sends it only after reading the PR from GitHub's REST API and finding the same result, which the ref names.
- `CHECKS_FAILED` in `active.verifying`, when `unattested` {"actor":"github","source":"github-wake"}: Refused unless a CI result comes from GitHub: actor github, source github-wake, with the GitHub fact as ref. The machine checks the kinds and that a ref is there; harness from-github sends it only after reading the PR from GitHub's REST API and finding the same result, which the ref names.
- `CRITERION_CHECKED` in `active.verifying`, when `checkedByParty`: Refused from the orchestrator (or while none is known), every worker on the item and an event with no actor: a criterion is checked by someone who did not do or route the work. The machine compares the ids it is given; who the sessions are is checked afterwards.
- `CRITERION_CHECKED` in `active.verifying`, when `holdsAnotherRole` {"role":"checker"}: Refused when the sender, a session or an agent (harness meta.actors), already holds another role on this item (requester, triager, worker or stand-in answerer): the triager or the stand-in cannot check a criterion. The person and GitHub are exempt. The machine compares the whole actor; harness verify-actors checks sessions against the platform's ledger and agents against the SubagentStart records.
- `CRITERION_CHECKED` in `active.verifying`, when `checkOverreaches`: Refused unless criterion is one of the item's criteria, verdict is met, unmet or unclear, and a met verdict carries evidence (a non-empty string).
- `DECISION_MADE` in `active.awaitingAcceptance`, when `fromOutside`: Sent by the item's own decision when it is decided inside the harness; the same event from outside (any event with an actor) is refused.
- `CRITERION_CHECKED` in `active.awaitingAcceptance`, when `checkedByParty`: Refused from the orchestrator (or while none is known), every worker on the item and an event with no actor: a criterion is checked by someone who did not do or route the work. The machine compares the ids it is given; who the sessions are is checked afterwards.
- `CRITERION_CHECKED` in `active.awaitingAcceptance`, when `holdsAnotherRole` {"role":"checker"}: Refused when the sender, a session or an agent (harness meta.actors), already holds another role on this item (requester, triager, worker or stand-in answerer): the triager or the stand-in cannot check a criterion. The person and GitHub are exempt. The machine compares the whole actor; harness verify-actors checks sessions against the platform's ledger and agents against the SubagentStart records.
- `CRITERION_CHECKED` in `active.awaitingAcceptance`, when `checkOverreaches`: Refused unless criterion is one of the item's criteria, verdict is met, unmet or unclear, and a met verdict carries evidence (a non-empty string).
- `DECISION_MADE` in `active.awaitingMergeDecision`, when `fromOutside`: Sent by the item's own decision when it is decided inside the harness; the same event from outside (any event with an actor) is refused.
- `MERGED` in `active.merging`, when `unattested` {"actor":"github","source":"github-wake"}: Refused unless a merge comes from GitHub: actor github, source github-wake, with the GitHub fact as ref. The machine checks the kinds and that a ref is there; harness from-github sends it only after reading the PR from GitHub's REST API and finding the same result, which the ref names.

Effects and context updates: `checkpoint`, `clearChecks`, `countRetry`, `dispatchRun`, `giveUpSlot`, `mergePullRequest`, `notifyInboxClosed`, `notifyInboxOpened`, `openDecision`, `recordAnswerer`, `recordCheck`, `recordChoice`, `recordExpectations`, `recordOrchestrator`, `recordRun`, `recordTriage`, `recordWorker`, `reportBlocked`, `reportFinished`, `withdrawDecision`

Guards: `checkOverreaches`, `checkedByParty`, `choiceIs`, `expectationsMet`, `fromOutside`, `holdsAnotherRole`, `noCriteria`, `reportedByOrchestrator`, `retriesLeft`, `tierBelow`, `tierLowered`, `triageOverreaches`, `triagedByParty`, `unattested`

## harness (v0.1.0)

The root actor, held by the orchestrator thread. Takes requests, keeps 2-4 items in flight within budget, and keeps the person's inbox. The orchestrator is the session that sent ORCHESTRATOR_STARTED last; items take its id from here. It also opens the day's stand-in audit (AUDIT_PICKED), once per day, as a child audit actor (spec audit). It holds the person's grant to the stand-in (context.grant, spec grant): GRANT_ASKED from a session opens a checklist card (a child grant actor, one open at a time: a new ask withdraws the unanswered one), and only the person's tap on that card, reported up as GRANT_GIVEN, sets or replaces the grant.

Actors:

- `person`: The person: acts only by a tap on a card the machine asked for, and holds no role.
- `session` (id `^[^/]+$`), holds roles: A Claude Code session (a thread): id CLAUDE_CODE_SESSION_ID, which the CLI takes from the platform. It never contains '/'.
- `agent` (id `^[^/]+/[^/]+$`), holds roles: A subagent of a session: id <session_id>/<agent_id>, the session's CLAUDE_CODE_SESSION_ID and the agent_id of the hook input, so it names both; type is its agent_type. The plugin's PreToolUse hook hands it to every harness call a subagent runs (HARNESS_AGENT=<agent_id>:<agent_type>) and the CLI records it as this actor; its SubagentStart hook files a record that harness verify-actors checks it against. Two subagents of one session are two actors, and neither is the session.
- `github`: GitHub: only through harness from-github, after its REST API agrees.
- `timer`: The harness's own clock (tick, digest, canary).

Actors marked roles (session and agent) are recorded in an item's roles and compared there by the whole actor, kind and id: the id patterns are disjoint, so the recorded id names one actor. An event whose actor is not one of these kinds, or whose id does not match its kind's pattern, is refused before any machine sees it.

Store: `schemaVersion` 1. The layout of a store's state.json. Every write records the spec's schemaVersion beside the snapshot; a state.json without one was written before the field and has layout absentMeans. A page declares the range it reads (pages/<page>/needs.json, reads.schemaVersion) and, on a store outside it, shows a red banner naming the mismatch and no data. Raise it when a change moves or renames anything a page reads.

Pages: a refresh slower than 3000 ms is flagged; rows go to `refreshes`. A page refreshes only when a viewer presses its refresh button: nothing refreshes on a schedule or without a viewer. Each refresh is timed from the press to the rendered page and recorded as one row in the Artifact db collection refreshCollection ({page, at, ms, storeVersion, schemaVersion, bytes, ok}); the page shows the recent rows, and harness doctor --refreshes flags a row slower than refreshSlowMs.

```mermaid
stateDiagram-v2
  state "intake" as intake
  state "scheduler" as scheduler
  state "attention" as attention
  state "listening" as intake_listening
  [*] --> intake_listening
  scheduler --> scheduler_halted : BUDGET_MODE [modeIs {"mode":"paused"}]
  scheduler --> scheduler_draining : BUDGET_MODE [modeIs {"mode":"wrappingUp"}]
  scheduler --> scheduler_accepting : BUDGET_MODE
  state "accepting" as scheduler_accepting
  state "draining" as scheduler_draining
  state "halted" as scheduler_halted
  note right of scheduler_halted : budget-stop
  [*] --> scheduler_accepting
  attention --> attention_needsPerson : DECISION_PENDING
  state "quiet" as attention_quiet
  state "needsPerson" as attention_needsPerson
  note right of attention_needsPerson : needs-human
  [*] --> attention_quiet
  attention_needsPerson --> attention_quiet : always [inboxEmpty]
```

States:

- `scheduler`: Holds the WIP limit. WIP_SET from the orchestrator records a new wipLimit (the first one keeps init's as wipLimitAtInit, which replay starts from); outside accepting it starts nothing, and lowering it never stops an item in flight. An item that finishes, even one cancelled while still queued, leaves inFlight and queued, so no slot goes to it; and whenever items start, any id in inFlight or queued whose item has already finished is dropped (a store from before that rule), so a finished item never holds a slot.
- `scheduler.accepting`: Start ready items while fewer than wipLimit are in flight, and again at once when WIP_SET raises the limit.
- `scheduler.draining`: Soft budget limit: nothing new starts; items in flight are told to wrap up.
- `scheduler.halted` (tags: `budget-stop`): Budget stop: nothing runs until usage allows.
- `attention.quiet`: Nothing needs the person.
- `attention.needsPerson` (tags: `needs-human`): The person's inbox is not empty: it holds every open decision and every item waiting in needsCriteria, and each leaves it when it closes (DECISION_CLOSED).

Refused (nothing changes and nothing is written):

- `ORCHESTRATOR_STARTED` in any state, when `unattested` {"actor":"session"}: Refused unless the actor is a session. Its id becomes the orchestrator's, here and in every queued or in-flight item, so no run it reports itself is taken.
- `AUDIT_PICKED` in any state, when `unattested` {"actor":"session"}: Refused unless a session sends it: the session that read the decision log and picked (harness audit).
- `AUDIT_PICKED` in any state, when `auditOverreaches` {"max":3}: Refused unless its day is the UTC day of the event's own time (receivedAt: the at the runtime logs it with, never the sender's word), so a past or future day is refused and there is at most one audit per real day, a day not audited before, and it names 1 to max picks, each a logPrecedent effect id. The picks name decisions only; what each decided is read from the store's own outbox, never from the event.
- `GRANT_ASKED` in any state, when `unattested` {"actor":"session"}: Refused unless a session sends it: the session the person asked, to put the grant checklist in front of the person. Asking grants nothing: the card's options are the machine's (spec grant), and only the person's tap on it records a grant.
- `GRANT_GIVEN` in any state, when `fromOutside`: Sent by a grant actor when the person taps its checklist card; the same event from outside (any event with an actor) is refused. Nothing else creates, widens or extends a grant.
- `REQUEST_RECEIVED` in `intake.listening`, when `requestOverreaches`: Refused when the request has no id, or sets a field the work item's machine holds (tier, criteria, checks, workers, orchestrator, requester and the rest of its context, all but id and project). The filer names the work; triage sets the tier and the criteria. The requester is the event's actor, recorded by the item.
- `BUDGET_MODE` in `scheduler`, when `fromOutside`: Sent by the budget actor when its mode changes inside the harness; the same event from outside (any event with an actor) is refused.
- `ITEM_PARKED` in `scheduler`, when `fromOutside`: Sent by an item when it enters needsCriteria: it waits on the person and gives up its slot. The same event from outside (any event with an actor) is refused.
- `WIP_SET` in `scheduler`, when `notFromOrchestrator`: Refused unless the orchestrator's own session sends it (the actor is a session whose id is context.orchestrator): any other session, an agent, the person or a tap is refused. The orchestrator routes the work, so it alone sets how much runs at once.
- `WIP_SET` in `scheduler`, when `wipOutOfRange` {"min":1,"max":4}: Refused unless limit is an integer from min to max.
- `REQUEST_RECEIVED` in `scheduler.accepting`, when `requestOverreaches`: Refused when the request has no id, or sets a field the work item's machine holds (tier, criteria, checks, workers, orchestrator, requester and the rest of its context, all but id and project). The filer names the work; triage sets the tier and the criteria. The requester is the event's actor, recorded by the item.
- `ITEM_PARKED` in `scheduler.accepting`, when `fromOutside`: Sent by an item when it enters needsCriteria: it waits on the person and gives up its slot. The same event from outside (any event with an actor) is refused.
- `WIP_SET` in `scheduler.accepting`, when `notFromOrchestrator`: Refused unless the orchestrator's own session sends it (the actor is a session whose id is context.orchestrator): any other session, an agent, the person or a tap is refused. The orchestrator routes the work, so it alone sets how much runs at once.
- `WIP_SET` in `scheduler.accepting`, when `wipOutOfRange` {"min":1,"max":4}: Refused unless limit is an integer from min to max.

Effects and context updates: `addToInbox`, `openAudit`, `openGrantAsk`, `publishDigest`, `recordBudgetMode`, `recordGrant`, `recordOrchestrator`, `recordWipLimit`, `releaseSlot`, `removeFromInbox`, `spawnWorkItem`, `startReadyItems`, `wrapUpInFlight`

Guards: `auditOverreaches`, `fromOutside`, `inboxEmpty`, `modeIs`, `notFromOrchestrator`, `requestOverreaches`, `unattested`, `wipOutOfRange`
