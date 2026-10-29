# @ccp/harness

The harness spec and the runtime that drives it.

Who supplies what an item is judged by. The filer (a person's request box row, a backlog issue, the canary)
names the work and says what it expects in its own words; a request that sets a tier, criteria or anything
else the item's machine holds is refused. A triager, who is not the requester, the orchestrator or a worker,
sends `TRIAGED {tier, criteria}`; until it does, nothing leaves triage, and with no criteria the item waits
for the person (`needsCriteria`, tagged `needs-human`) and only a cancel ends it. A reviewer, who is neither
the orchestrator nor a worker, sends `CRITERION_CHECKED {criterion, verdict, evidence}` per criterion; a new
build clears them. A check while the accept decision is open keeps that decision when it leaves
`expectationsMet` as the decision has it, and reopens it once when it changes it (spec workItem,
`awaitingAcceptance`), so N checks leave one live accept decision and one pending ask. An item with a verifier brief leaves verifying only when CI has passed and the verifier's
verdict is recorded for the same head, in either order (spec workItem, `verifying`), so the verifier's checks
count before the accept decision opens. A FAIL verdict sends the item back to building, keeping its roles,
workers and verifier brief hash, so the same builder reports its next round's run and a verifier with the
same brief checks the new head (#83). The stand-in may approve accept only when every criterion is met with evidence from such a
reviewer (`expectationsMet`); an unmet, unclear or missing check sends the accept to the person. Tier 0 still
skips the plan and accept gates; that is acceptable for now because triage, not the filer, sets the tier.

- `spec/*.machine.json`: the XState machines as plain JSON, the only spec: what each state takes, from
  whom and with which guard is there and nowhere else. `npm run spec:render -w @ccp/harness` regenerates
  `spec/SPEC.md` (diagrams, state descriptions and tags); a test and CI fail when it is not a fresh render.
- `src/machines.js`: binds the JSON to XState v5. Effects that leave the machine go to a sink as data.
  `test/spec.test.js` fails when a name in the JSON has no implementation here, or the other way round.
- `src/runtime.js`: the backend-workflow loop. Every wake restores the root actor from the store,
  applies one event, persists, and queues the effects that event asked for. Event ids make it idempotent.
  A machine closes its own pending effects the same way (harness `meta.store` closes): when an item stops a
  decision that has not decided, the decision's pending `askStandIn` and `postDecisionCard` are acked in the
  same write, outcome `withdrawn`, so the outbox keeps no ask that no decision can take (#84).
  An event the addressed actor would not take (`snapshot.can`) is refused: nothing is written and the
  result says `refused: <EVENT> in <state>`. An item's PR is bound once, by the first event that names it
  (`"pr"`), and one PR binds to at most one item (`src/pr-binding.js`): an event naming another PR for a
  bound item, or a PR bound to another item, is refused the same way with the binding in the reason.
  A transition marked `"record": true` (harness `meta.store` records) takes its event as a fact in any state,
  a finished one included: the log row is written, and nothing else changes. An item takes `OUT_OF_BAND` so
  (#102): a session records work done outside the gates, such as a PR landed by GitHub's button, on the item
  even once it is done or cancelled, with the fields history.schema.json declares (`orderedBy`, `message`,
  `what`, `skipped`, `pr`, and the landed `sha`); from any other actor, or without one of them, it is refused.
- The envelope: every event carries `actor` {kind: person|session|agent|github|timer, id} (the kinds and their
  id forms are the spec's, `harness.machine.json` `meta.actors`; an agent is `<session_id>/<agent_id>`) and `source`
  {kind: tap|github-wake|cli|timer, ref}; one without them is refused, and so is one carrying `person`
  (no event marks itself as the person's). Each `events.jsonl` row is
  `{id, version, at, to, actor, source, harness: {version, commit}, route, event}`, `harness` naming the release
  that applied it: the plugin's version (`plugins/harness/.claude-plugin/plugin.json`) and the git commit; `route`
  the ids of the routes its transitions took (below). That release is the event's `harness`, never the sender's
  (a spawn records it), and the payload does not repeat it (harness `meta.invariants` `envelope`). Who may send what is in the machines, as admission rules
  (`"admission": true` on a guarded transition with no target and no actions) that refuse an event from the wrong
  party (SPEC.md lists them under Refused): `PERSON_DECIDED` only from a person's tap
  on the card the machine asked for (ref: the message id its decision recorded from the ack, see Cards
  below), a run result only from an actor other than the orchestrator (its id is
  in context, set by `ORCHESTRATOR_STARTED`), CI and merge results only from a GitHub wake (ref: the
  GitHub fact `harness from-github` read), and `DECISION_MADE` and `BUDGET_MODE` only from inside the
  harness. `TRIAGED` is refused from the requester, the orchestrator and every worker on the item, and
  `CRITERION_CHECKED` from the orchestrator and every worker. The trust model is below. Every other guarded
  transition is a route with a stable id (`"route": <id>`, SPEC.md lists them under Routes); `test/spec.test.js`
  fails a guarded transition marked as neither, so nothing is inferred from a transition's shape.
- The stand-in's gate (`standInMayDecide`, the ladder rule; under the person's grant `grantCovers` decides first, see `spec/grant.machine.json` below): each input has one supplier, and the stand-in's caller supplies
  none of the rules. Tier is the item's, set by triage (`TRIAGED`), never by the request. For an accept
  decision, `expectationsMet` is the item's, worked out at its accept gate from the criteria checks. Autonomy is the
  ladder's rung for the class over the store's own decided decisions (its `logPrecedent` effects and
  `AUDIT_ANSWERED` events, dated at or before the spawn), set on the decision when it is spawned, so a reversal
  lowers the very next decision's rung with no command run; a log that cannot be read gives `recommend`. Threshold is the
  constant in `decision.machine.json`'s context. Confidence is the stand-in's: `STAND_IN_ANSWERED` carries
  only choice, confidence and reason, is refused with autonomy or threshold or without a confidence, or with
  a choice that is not one of the decision's options (approve, revise, reject: `context.options`, the same the
  person's card offers, and the one list `harness answer`'s flags come from; approve moves the item on, revise
  sends it back to building, or to triage from the plan gate, and reject cancels it), and is
  refused from the orchestrator and from every worker that reported a run for the item, succeeded or failed
  (both recorded on the decision at spawn). `test/paths.test.js` replays generated paths through all six
  machines (event payloads in `test/path-fixtures.json`) and checks each step against the machine.
- `src/store.js`: a folder per harness. `state.json` is replaced whole under a lock with
  compare-and-set on its version, and carries the spec's `schemaVersion` (harness `meta.store`) and `writtenBy`, the
  newest release that has written it (a fact or a repair by an older release keeps the newer one); `events.jsonl`, `outbox.jsonl` and `acks.jsonl` are append-only. An older release
  does not write a store a newer one has written (harness `meta.invariants` `writerNotOlder`): `apply` refuses an
  event from an older plugin version or none, or from the same version on a commit the store's commit is not an
  ancestor of, and the refusal names both (`version@commit`). A state.json with no `writtenBy` (a release from
  before the field drops it) is judged by the newest release its log rows name; one that records no version takes
  any writer, and one whose version is not x.y.z takes none. Such a release never checks, so replay lists each row
  whose release is older than one before it (`admittedThen`), and `harness doctor` shows them.
- `src/page.js`: mission control, one page with what needs the person, what is in flight, the host's
  to-do and recent events. Each item row links to its item page.
- `pages/<page>/needs.json`, `src/pages.js` and `src/live.js`: the page needs contract. A page declares in its needs
  file the file it reads (`reads.file`, mission control's is `state.json`; flow replay also names one it reads beside
  it, `reads.with`), the `schemaVersion` range it
  understands, the fields it reads (paths into the store root, the harness snapshot and each child snapshot, the
  children told apart by spec machine id), and the spec states and events it names. `project()` copies only those
  fields; the renderer sees nothing else. `harness page --live --project chan_... --files-path <store path in the
  Library>` renders live mission control: the store as it was at render, how old that is, and a Refresh button.
  An item's row names each PASS carried to a merge of main (its `verdicts`): the sha the verifier gave it on, the
  head it carried to and the CI fact that carried it.
  Nothing reads the store until a viewer presses it; it then reads the file through the Artifact `files`
  capability, renders it, and adds one timing row (`{page, at, ms, storeVersion, schemaVersion, bytes, ok}`) to
  the `db` collection the spec names (`meta.pages`), and the page lists the recent rows. Publish it with
  capabilities `{files: {project}, db: {}}`. A store whose `schemaVersion` (spec `meta.store`, recorded by every
  write; absent means `absentMeans`) is outside the page's range shows a red banner naming both and no data.
  `harness doctor --refreshes PATH` (the collection's rows from ArtifactData) warns on a refresh slower than
  `meta.pages.refreshSlowMs`. `test/pages.test.js` builds a store with the sim (`contractStore`, never a frozen
  fixture) and fails naming the page and the missing piece: a spec state or event a page names, a field no row of
  its kind has, a field the renderer reads that the needs file does not declare, or a view state missing from the
  needs spec list.
- The ledger page (`pages/ledger/needs.json`, #89) is the same live page over the one history instead of a store:
  `harness page --live --page ledger --dir <history> --files-path <its path in the Library>` reads the history's
  `events.jsonl` (such as `scripts/history/join.mjs` writes) and shows, by item, the spawns (role, model), starts
  and runs, the usage samples, and in a corner each source's rows and the placeholders among the fields it reads,
  counted and never shown as values. Its needs file declares the fields of each event type it reads and the spec
  machines that take those types; `projectLog()` copies only those fields. The Refresh button, the timing row (its
  `storeVersion` is the history's row count, `bytes` its size), the trend and `harness doctor --refreshes` are
  mission control's. A history with a row whose `schemaVersion` (history.schema.json; absent means `absentMeans`)
  is outside the page's `reads.schemaVersion`, or a file that is not a history, shows the red banner and no data.
  `test/ledger-page.test.js` builds a history with the current code (`contractHistory`: the sim's contract store
  through `extract-store.mjs` and `join.mjs`), renders it and the golden history and checks every count the page
  shows against the rows; with `HARNESS_DOGFOOD2_DIR` set it does the same on a joined copy of that store.
  Under each item, a Time and tokens section (#132) is empty until the viewer opens it; opening it reads
  `usage.jsonl` beside the history (needs `reads.onDemand`, `history.schema.json` usage) through the same files
  capability, or, opened outside claude.ai, from beside the page over http, and shows a timeline (a lane per run,
  one bar per segment, coloured by role, the waiting gaps dashed, and the lead's turns) and a table: per run its
  start, wall duration, active time (the sum of its segments), tokens (input, cache read, cache write and output)
  and cost, the item's lead turns, the item total, and the whole file's total. A lead turn that wrote rows for
  several items is listed under each, names the others, and is in no item's total but once in the file's. A file
  that cannot be read is said in that section alone. `test/ledger-usage.test.js` builds the file from fixture
  ledgers and store rows; `pages:check` opens a section on the rendered page in Chromium, and once without the file.
- The flow replay and design log pages (`pages/flow-replay/needs.json`, `pages/design-log/needs.json`, #121) are the
  ledger's live page over the same history, rendered by `--page flow-replay` and `--page design-log` with the same
  projection, data age, Refresh, timing row and banner. Flow replay steps a row at a time (First, Previous, Next,
  Last, and a position counter) through the whole history in time order, or follows one group: an item (the `to`
  address; rows with no item address have a group of their own). Each step shows the row's type, time, sender
  (actor and source) and provenance origin and source, and what the row did, from `steps.jsonl` beside the history
  (#124; written by replay's `--steps`, see `src/replay.js`; history.schema.json `steps`): each actor whose state it changed, before
  and after, the context fields it changed, the effects it queued with their detail and acks, and its route; a step that changed
  nothing says so, and a row replay could not apply shows why. A step that carried a PASS to a merge of main names
  it under its `verdicts` change (the sha it was given on, the head, the fact). A value that is an object or array (a context value,
  an effect's detail) is pretty-printed in a scrollable monospace block; a scalar stays inline. Above the step, an
  architecture diagram of the harness (#130) lights, for the row shown, the box that sent it (the first sender rule
  its actor, source and type match), the actors whose state or context it changed, the store files it wrote (events
  always, state when applied, outbox when it queued effects, acks when one has an ack) and the arrows between them;
  clicking or focusing a box shows what it is and its repo path. The diagram is data, `pages/flow-replay/diagram.json`,
  which the needs file names (`diagram`): zones, boxes (id, label, zone, what this is, repo path, position), arrows,
  sender rules, actor kinds and writes. `checkPage` fails naming the box when a box's path does not exist or an arrow
  or rule names an undeclared box; `lights()` in `src/live.js` computes each card's `data-lit`, and the inlined
  `step()` lights the SVG from it. Its needs file declares the step fields it reads
  (`reads.with`), and Refresh reads both files; without the steps, or with the steps of another history, the page
  shows the banner and says how to build them. The design log lists, newest first, the out-of-band rows (who ordered each, the message, what
  was done, the gates it skipped) and the requests, stand-in answers (choice and reason), the person's decisions and
  grants, 50 a page (`LOG_PAGE` in `src/live.js`) with First, Previous, Next, Last and "page N of M · rows a to b of
  T" (#131). Its calendar shows each month with rows as a grid (weeks in rows, Monday first, UTC days), each day with
  rows a control marked with how many fall on it; choosing one shows only that day's rows, paged the same way, and its
  out-of-band cards, and All days returns. It opens on the newest row's month; Earlier and Later month move between
  months with rows. The page script's `turn()` does this in the browser; the tiles keep the whole history's counts.
  `test/history-pages.test.js` checks it on `test/fixtures/history-design-log/events.jsonl` (more than 50 rows over
  five days in two months), and `pages:check` clicks it through in Chromium at 390 and 1280 px, light and dark. On both, a placeholder is counted and never shown as a value, and every count carries `data-count` (flow
  replay's steps, refusals, changed actors and effects too). `test/history-pages.test.js` builds the steps of the
  golden history, the contract history and, with `HARNESS_DOGFOOD2_DIR` set, a joined copy of dogfood2, renders both
  pages on each and checks every count against the rows and the steps, and that every row is a step or a refusal.
  `test/flow-replay-diagram.test.js` checks the pretty-printed values, the diagram data against the repo, what each
  step lights, and the inlined `step()` lighting and explaining boxes.
- The introspection page (`pages/introspection/needs.json`, #143): where the time and money went, the ledger's live
  page over the same history with `usage.jsonl` beside it (`reads.with`, read with the history at render and on
  Refresh, as rows of their own: a file whose part of `history.schema.json` names a `key`, the steps, is joined to the
  rows instead). `harness page --live --page introspection --dir <history>` renders it; of each file it reads only
  the fields its needs file declares. `costsOf()` in `src/live.js` makes every figure from the two files, each agent's
  run (its segments) and each lead turn once: headline tiles (cost at list price, cost per landed PR, the overhead
  share of the runs whose role is one of the needs file's `view.overheadRoles`, named on the page and held by
  `checkPage` to the spawn roles, harness `meta.agentEvents.roles`; active time; the cost of work that ended in the
  hour and the day before the newest end in usage.jsonl), cost by role, by model (usage.jsonl has no model for a lead
  turn: its own bar) and by item (each bar split by role; selecting an item shows its runs and lead turns; a lead turn
  that wrote for several items is listed under each and counted once, on a Shared lead turns row), a timeline in tree
  order (each lead session, then the agents it spawned: wall time a pale bar, turns and segments solid, waits dashed;
  a session starts collapsed, saying the count and cost of the runs it hides, and `look()` expands and collapses it),
  every run (requests, input, cache read, cache write, output, own cost and cost with children; an item links to its
  PR, the merged one else the last one a run reported) and coverage: the subagents tied to no item, with their count
  and cost (usage.jsonl's session rows), the sessions the history names with no ledger, and the placeholders among the
  fields read. Each figure that leaves something out says so. `test/introspection.test.js` builds the files from
  fixture ledgers and store rows and checks the totals, the shared turn, the overhead share, the resumed agent and that
  doubling every cost doubles every dollar figure; `pages:check` expands and collapses a timeline row and selects an
  item in Chromium at 390 and 1280 px, light and dark.
- `spec/history.schema.json` and `src/history.js`: the one history (epic #59), the row every era's events take,
  with its provenance, placeholders, event versions and fact identity; `spec/SPEC.md` renders its rules (History).
  `src/history.js` only reads the schema: `validate` holds a row to it and to harness `meta.actors` and
  `meta.sources`, `upcast` migrates a row from a store that predates a field (the schema's `upcast`: each envelope
  field and each field its event type needs that the row lacks becomes a labelled `legacy` placeholder), `eraEnd`
  writes the `ERA_ENDED` row that ends a store's era (its actor and source placeholders, as no one sent it),
  `historyRows` reads a store's rows as a history (none when no row carries provenance), giving each row the runtime
  appended after the join's, which carries no provenance and is never rewritten, the schema's `live` provenance
  (origin `live`, `from` the history's own store),
  `placeholders` (by era: the store a row was read from, else the kind of source, then by field) and `outOfBand`
  list what doctor will report, and `dedupe` applies the identity
  rules and reports conflicts. A view that reads the history (`reads.file` `events.jsonl`: ledger, flow replay,
  design log) declares the event types and fields it reads instead of state fields, and `checkPage` holds it to the
  schema (each field a property of the envelope or of its type's schema, so dropping one fails naming the page and
  the field) and, given rows, to that history, and fails a read of a field it does not declare. The step fields a
  view reads beside the history (`reads.with`, `steps.jsonl`) are held the same way to the schema's `steps.row`
  (`stepProblems` holds a step to it) and, given the steps, to every step. `test/history.test.js` checks all of it against the golden history,
  `test/fixtures/history-golden/events.jsonl`.
- `scripts/history/`: tools that build the one history, outside the plugin and the runtime (tracer T, #65).
  `extract-store.mjs <store dir> <archive ref>` (E1) reads a store's `events.jsonl` and prints each row as a
  history row (provenance `migrated`, `from` the archive ref and the line, `placeholders` each field holding a
  `legacy` placeholder) or, on stderr, a skip naming the line
  and why. A row from before the event envelope (main's: no actor, source or harness, and its first CHECKS_PASSED
  and MERGED rows name no PR) is upcast first (`src/history.js` `upcast`), so each field it lacks is a placeholder
  labelled with the store's ref, never a skip and never read from another field. `extract-github.mjs <archive repo dir> <archive ref>` (E3) reads one repo's folder of the GitHub archive
  (`harness/archive/github/<owner>--<repo>/`), refusing it, with nothing written, unless every page the manifest
  lists matches its sha256, and prints a MERGED row per landed PR and a CHECKS_PASSED or CHECKS_FAILED row per
  completed check suite on a PR's head (provenance `recovered`, `from` the archive ref with the page file and the
  record's index; actor, source and harness `legacy` placeholders, since GitHub holds none). Each PR goes to its
  item by the store's PR binding (`src/pr-binding.js`: a branch naming an item filed in the repo's issues, else the
  Item id line of an issue it closes; one PR to one item, once) or to "no item" with why; stderr lists every PR,
  every skipped record with why, and the count, which must equal the pulls pages'.
  `extract-session.mjs <archive session dir> <archive ref>` (E2) reads one session's folder of the session archive
  (`harness/archive/sessions/<session id>/`), refusing it, with nothing written, unless `events.jsonl.gz` matches
  the manifest's gzSha256, sha256 and count, and prints a WORKER_SPAWNED row per Agent call (toolUseId, agent type,
  model, the sha256 of the brief as sent; role and item from its `Harness-Role:` line), a CARD_POSTED row per
  decision card posted (its message id, question, options and recommended index), a PERSON_DECIDED row per tap on
  one of those cards that reached the session (a `decision-chosen` wake, tied to its card by the `decision_id` it
  names; its `choice` the decision's own word for the tapped option, approve, revise or reject, by the card label
  `src/card.js` gives that choice, with `label` the option the card showed; an option no decision card shows has a
  `legacy` choice) and a MERGED row per merge_pull_request call whose result says it landed (the PR, the pinned head, the
  merge commit), each `recovered` with `from` the archive ref and the line. What the session does not hold (the
  harness release and source, an item no `Harness-Role:` line names, the actor of a subagent's call) is a `legacy`
  placeholder. stderr lists every Agent, request_decision and merge_pull_request call and every tap with its row id
  or why it was skipped (a call the platform refused, a tap on a card the session did not post), and the counts.
  All three extractors write through one candidate writer, `candidates.mjs`, which adds provenance, lists
  placeholders, validates and reports skips. Where a store and GitHub or a session hold one fact, the join keeps the
  store's row (for a landing no store holds, GitHub's) and puts the other sources in its `provenance.also`: a spawn
  by its toolUseId, a landing by its PR, a card by its message id and a tap by the card it answers (identity rules
  in `spec/SPEC.md`, History). `join.mjs <candidates>... --out <dir>` (M1) takes those rows (each must pass `validate`), keeps one
  per fact (`dedupe`), numbers them from 1 in time order, and makes `--out`, which must not exist, a store:
  `events.jsonl` is the history, `state.json` and `outbox.jsonl` come from replaying it with the current code,
  each row applied as a fact (harness `meta.store.facts`: no admission rule refuses a row the store admitted; a
  row takes the route it records, and with `--outbox <source outbox.jsonl>` a row from before routes were
  recorded takes the route its logged effects took, as replay does),
  and `report.json` lists the dropped rows, the conflicts and the rows that could not be applied at all (each with
  its reason; a second row of an id replay applied already is one). It writes nothing else and never edits an input.
  `join.mjs --from <harness dir> --out <dir>` builds the one history from every source in its fixed list (`SOURCES`),
  read from a copy of the Library's `harness/` folder: the stores `state/main`, `state/dogfood` and `state/dogfood2`
  (refs `main`, `dogfood`, `dogfood2`), both repos in `archive/github/` (`github/<owner>--<repo>`) and every session
  in `archive/sessions/` (`sessions/<id>`); a source missing refuses the build with nothing written. It runs the
  extractors on each and joins their rows. Each store is an era (#141, harness `meta.store.eras`): its rows were
  admitted by the rules of their time, so the join ends each one with an `ERA_ENDED` row after its last row
  (`history.js` `eraEnd`), carrying the store's `state.json` snapshot as it is and the effects its outbox holds that
  its acks never close. Replay does not apply an era's rows (the store's own, and a GitHub or session row addressed
  to an item the era's record holds, before its mark): their step names the era and changes nothing, and the mark
  puts the era's record of each of its items in place (a later era's record of an item wins), with its pending
  effects, each under a new id (`era:<store>.<n>`) and keeping the id its store gave it as `sourceId` (#146), so
  the host acks it by either id. Only the rows after an item's era, and rows no era holds, meet today's machine. Two stores' rows are never
  one fact, so an id two stores share is two rows, each a fact of its own era, and an item filed again in a later
  store is filed in both. `report.json` also lists each source with its rows and every skip with its reason, and
  `eras` gives each era's rows, the items its record holds and the effects it left pending. A store with no
  `state.json` refuses the build. Without `--from` no era is ended, and every effect is pending.
  An OUT_OF_BAND row is a fact its item takes in any state, so the replay applies it like any other row.
  `usage.mjs <ledger sessions dir> <events.jsonl>` (#132) reads the session ledgers the Stop hook files, the agent
  and call records beside them and a store's or a history's rows, and prints `usage.jsonl`: one row per agent
  segment (each start and resume of an agent tied to an item), one per lead turn that wrote rows for an item and one
  per session ledger it read, naming each subagent it lists that no item could be tied to (with why and its cost),
  as `history.schema.json` usage declares (its description is the rules, rendered in `spec/SPEC.md`); stderr lists
  each subagent it could not tie to an item, with why, and the counts.
  `recovered/dogfood2.jsonl` holds what dogfood2 recorded in other rows only, rebuilt as rows (origin
  `recovered`, with `from` and `also` naming the sources): the PR #66 landing out of band, which its CANCEL row and
  GitHub record. The store also holds that row, so extract-store's own rows cover it and a join of both would hold it twice.
  Point them at a copy of a store, never the live one. `test/history-tracer.test.js` runs both on the golden
  history and, when `HARNESS_DOGFOOD2_DIR` names a store, on a copy of it.
- `src/item-page.js`: one page per item (`items/<id>.html`) that answers "did it do what I expected":
  the request (`request.expect` if given, else its title), triage's criteria each with its latest check,
  how it ended (state, CI, acceptance, PR),
  every gate with who decided and the stand-in's reason, each effect with the host's ack note, and the
  item's events. The host can put the PR link on any event it sends for the item (`"pr": "<url>"`).
- `src/decision-log.js`: the decision log is the store's own records, with no file of its own: each
  `logPrecedent` effect in the outbox (a row as soon as it is queued) and each `AUDIT_ANSWERED` event, one
  person's decision per pick of its `AUDIT_PICKED` that names a stand-in decision in the outbox. No file is
  read: `audits/<day>.json` is neither written nor read, so a hand-written one changes nothing.
  `harness decisions` only acks the effects; `decisions.jsonl` is no longer written or read. `decisions.html` shows, per
  decision class, how often the stand-in's lean matched the final choice and the class's rung, then every
  decision. `harness standin <class>` prints the rung (`ladder()`): a class starts at `recommend`, climbs
  one rung (to `act`) after 20 of the person's decisions since its last change at 90% agreement with the
  lean (`EARN_ACT`; a decision the stand-in made itself never counts), and drops
  one rung (to `shadow` at the floor) on each reversal, where the final choice differs from the lean.
- `src/digest.js`: `harness digest [--day YYYY-MM-DD]` sends `DIGEST_DUE` with id `digest-<UTC day>`, so a
  day gets one digest however often it runs, writes `digests/<day>.md` in the store (finished today, in
  flight, waiting on the person, decisions today, budget) and acks `publishDigest`. The host posts the text.
- `src/attention.js`: `attention(item, records)` is what an item cost: the person's touches (cards posted
  for its decisions, `CARD_POSTED`; the person's taps on them; and audit answers that checked one of its
  decisions, from `AUDIT_ANSWERED`), stand-in decisions and the person's reversals of its lean, turns,
  tokens and cost from the session ledgers (n/a without one; items running at the same time share
  turns), and wall time. Mission control shows it as the Attention column of finished items; the digest
  shows touches per item today against the day before.
- `src/replay.js`: `harness replay` rebuilds the harness from `events.jsonl` on a scratch copy and compares
  state values, children and shared context keys with `state.json`, and regenerated effects with the outbox;
  it names the first divergent event and exits 1. Context keys only one side has are notes (a spec change).
  On a history whose stores' eras are ended (`ERA_ENDED`, harness `meta.store.eras`), an era's rows are not applied
  (`eraFacts`): the mark, applied as a fact only, puts the era's own record in place. Each other logged event is a fact (harness `meta.store.facts`): it was admitted by the release that wrote it, so it is
  applied with `apply(..., {fact})`, which runs no admission rule (no host refusal, no machine admission rule) and
  takes the route its row recorded (`route`): each route is taken exactly when the row names it, and a route that
  cannot be taken again is a divergence. A row from before routes were recorded has none: it takes today's routes
  when they give the effects the outbox logged for it, and otherwise the one route, taken or passed over, that
  does (a search, for such rows only). An event's closes (harness `meta.store` closes) are facts too: replay puts
  the host's own acks on its scratch copy in time order, so the same effects are pending, and the effects it closes
  must be the ones the log acks `withdrawn` by that event. A routed row that closes otherwise, or a log close replay
  does not give, is a divergence; an older row that closes more today was written by a release that closed less
  (before #84). A rule tightened (#55) or loosened (#67) since then changes nothing on replay: every event today's
  rules would refuse, route otherwise or close more for is listed in `admittedThen` with its id and the release
  that wrote it (a searched row says its route was found by its effects), and is not a difference.
  It re-applies github-wake refs as logged, without reading GitHub; `harness verify-facts` re-checks them.
  `harness replay --steps` also writes `steps.jsonl` beside `events.jsonl` (history.schema.json `steps`), from the
  same replay: for each row, the actors whose state it changed and the context fields it changed (the scratch copy
  before and after the row), the effects it queued with their detail and the store's acks for them, and its route; a row it cannot
  apply, or a second row of an id it applied already, is a step with the reason and no changes, and a row of an era an
  `ERA_ENDED` row ends is a step naming that era (`era`) and no changes. Run on a history
  `join.mjs` made, it gives the flow replay page what each row did.
- `src/stalled.js`: `harness stalled [--after 60m]` lists in-flight items whose last event is older than
  the limit; mission control shows how long ago each in-flight item moved.
- `src/doctor.js`: `harness doctor` checks the store (on a history, whose rows carry provenance, every row, a live one
  as `historyRows` reads it, against
  `history.schema.json`, each failure a `schema:` problem, and `history` lists the rows, the schema errors and the
  legacy placeholders by era and field; event version gaps, acks for unknown effects, effects
  pending over a day, a lock older than 60s, a snapshot that will not restore, an actor in a state whose spec
  names `meta.waitsOn` with no such effect pending for it, such as a decision in `askingStandIn` whose
  `askStandIn` was acked without its answer recorded), runs `verify-actors` and
  `verify-facts` (one async `doctor()`), lists every PR landed on main at or after the store's first event, in each repository the store names
  (its bound PRs' and its requests' issues'), bound to an item or not, and every landed PR bound to an item
  (its GitHub reads, and verify-facts', run `READS_AT_ONCE` at a time),
  whose landed head has no verifier PASS in the store (its own or one carried to it by a merge of main) or no PASS
  review on GitHub on the sha it was given on; a PR bound to
  no item has no PASS (`src/gates.js` `verifyMerges`, GitHub's REST API only), and
  exits 1 on a problem: a mismatch, a merge without its PASS, or a session's missing ledger for
  an event 10 minutes old or more. What cannot be checked yet (GitHub unreachable, a ledger not filed for a
  session that acted under 10 minutes ago) is listed as `unverifiable`, exit 0. Every OUT_OF_BAND row of the
  history (work done outside the gates) is listed as `outOfBand`: who ordered it, what, its PR and head, the gates it
  skipped. A merged PR whose landing such a row records (its `pr`, and its `sha` when it names one) is listed
  there, not counted as a problem. A landing that no row records is still a problem (harness `meta.invariants`
  `reviewOnHead`). Every event the rules have changed for since it was written (replay's `admittedThen`) is
  listed as `admittedThen`, with its id and the release that wrote it (`version@commit`), and is not a problem; a
  replay divergence or a rebuilt state that differs (a corrupt store or a lost event) still is. On a history whose
  eras are ended (#146), a landing is judged by the rules of the era it landed in, the first `ERA_ENDED` row at or
  after its `merged_at`: a landing before the last one with no PASS as today's rule reads it is not a problem, and
  `admittedThen` lists those landings in one line per era, with their count and PRs; a landing after the last
  `ERA_ENDED` row meets today's rule. A row the join's `report.json` (beside `events.jsonl`) lists as refused, with
  the reason replay gives it, is not a divergence: `history.refused` counts those rows by reason (quoted values as
  `"…"`). A row the report does not list still is.
- `scripts/pages-check.mjs`: `npm run pages:check` renders mission control, every item page and the decision
  log from a fixture store with `harness page`, then opens each in Chromium (Playwright, pinned as a root dev
  dependency) at 400 and 1200 px in light and dark. It fails on sideways scroll, a relative link to a missing
  file, an empty title or a page over 1 MB, and saves screenshots to `--shots` (default a temp folder,
  never the Library). It also renders live mission control from a sim-built store and the live ledger from that
  store as a history and, with a stand-in for the Artifact runtime, presses Refresh on each: the page must not read
  its file or record anything before the press, must re-render and record one timing row with the size it rendered
  after it, and must show the red banner and no table for data whose `schemaVersion` it does not read. CI runs it
  and uploads the shots.
- `src/repair.js`: `harness repair [--rebuild]` fixes only the safe faults: it drops a torn last line of a
  log and clears a stale lock. It holds the store's lock like every writer, so it is refused while another
  writer holds it (`oneWriter` in SPEC.md). With `--rebuild`, it also rebuilds a `state.json` that is ahead of
  `events.jsonl` (a crash between the two writes) from the log, so the host can resend the lost event.
  It re-applies github-wake refs as logged, without reading GitHub; `harness verify-facts` re-checks them.
  `test/chaos.test.js` injects each fault: a crash, a stale lock, racing writer processes, a writer held off by
  the lock (refused, it writes nothing, and lands once the holder lets go), repair held off by a writer and a
  writer held off by repair, two writers finding one stale lock, a writer that crashes after claiming a stale
  lock (its claim goes stale and the next writer takes it over), two writers finding one stale claim, a writer
  that finds a stale lock and stalls while others break it and take the lock again (refused, the new lock stays),
  duplicates, torn lines and a slow mount.
- `src/canary.js`: `harness canary` files the day's canary item (bump `canary/last.txt`, PR, CI,
  merge) once per UTC day, with no tier: its triager gives it tier 0. `harness canary --check` times each stage and exits 1 with one attention line
  when the canary failed or is not merged 2 hours after the request. The digest leads with the canary when
  a stage is slow (triage over 15m, build over 30m, verify over 30m, merge over 15m) or failed.
- `src/calibration.js`: `harness calibration [class]` asks, per decision class, whether the person can trust the
  stand-in there. It counts only the person's decisions made against a stand-in lean (agreement and
  reversals), gives a confidence-versus-outcome table with the Brier score, and shows time on each ladder rung.
  The verdict is one of: not yet (under 10 tested), overconfident (stays at recommend), calibrated (the
  threshold could drop), or partly. The decision log page shows the same answer per class.
- `src/retro.js`: `harness retro [--day D] [--out DIR] [--due]` compares the items finished in the last 7 days with
  the 7 before: touches, cost, median wall time, retries, stalls over 60m and reversals. It lists what got
  better and worse, and names the top 3 bottlenecks: where finished items' time went, by what each wait ended
  with (worker runs, stand-in, the person, CI, merging, blocked). Each comes as an issue draft with an expected
  change. It writes `<DIR>/<day>.md` and `.json`, and the next retro checks the last one's expectations.
- `src/intake.js`: the request box. `harness page --request-box` adds an "Ask for work" form to mission
  control that saves to the Artifact `db` collection `requests`; `harness intake PATH` (an ArtifactData `out_dir` folder, its inline list text, or JSON) files each new row
  as `REQUEST_RECEIVED` (`req-<row id>`, idempotent) and prints the updates that mark rows taken. A row
  carries no tier.
- `src/issue-request.js`: the one issue format, written by `issueBody` and read by `requestFromIssue`: an
  ``Item id: `x`.`` line and a `## Expect` section of bullets. `harness issue-request FILE` files an issue
  in it; `harness retro` prints its issue drafts in it; `.github/ISSUE_TEMPLATE/harness-backlog.md` is in it,
  and a test reads that file and checks the writer writes it exactly.
- `src/sim.js`: `npm run sim` drives 12 synthetic items (a triager giving every tier, a reviewer checking
  every criterion with one unmet, a failed run, failed checks, a block, a person's revise) through a scratch store at WIP 3 and at WIP 12 with a scripted host. It checks the
  WIP limit, the queue, the outbox, doctor, the page size and an apply at 500 events, and saves the
  busiest mission control to `--out` (default a temp folder).
- `src/audit.js` and `spec/audit.machine.json`: `harness audit` picks up to 3 decisions the stand-in made
  alone (untested classes, low confidence and old ones first), once a day (today in UTC: the machine refuses a
  day that is not the event's own), by sending `AUDIT_PICKED` to the
  harness, which opens the day's audit (`audit:<day>`) and queues `postAuditCard`. The host posts the card
  and acks the effect with its message id; the answer is the person's tap, `AUDIT_ANSWERED {option}` to
  `audit:<day>` (0 confirms all, N reverses pick N), bound to that card exactly as a decision's tap. The
  decision log reads the event, so calibration and the ladder get tested decisions. Doctor warns when a
  class goes over 20 stand-in decisions unchecked. Decisions made under the person's grant are picked first,
  and the card's context, like `harness audit`'s `granted`, lists every grant decision since the last audit
  with its reason.
- `spec/grant.machine.json`: the person's grant to the stand-in, which decision kinds it may decide alone and
  until when. When the person asks, a session sends `GRANT_ASKED` to the harness, which opens `grant:<n>` with
  a checklist the machine generates: `kind:<class>` for each class in the decision spec's `meta.classes`, the
  one-way-door box `one-way`, and `until:<time>` for each of `meta.checklist.endsAfterHours` after the ask. A
  new ask withdraws an unanswered one. `harness card` prints the checklist (`src/card.js`, `checklistFor`); the
  host posts it and acks `postGrantCard` with its message id, and the person's ticks come back as one tap,
  `PERSON_GRANTED {picks}`, taken only on that card and only with the card's own options and one end time. The
  grant actor reports `GRANT_GIVEN` to the harness, which holds one grant (`context.grant`) and refuses
  `GRANT_GIVEN` from outside: nothing else creates, widens or extends a grant, and a later tap replaces it
  whole (no kind ticked ends it). The person can also grant in their own words, with no checklist: the session
  that reads their chat message sends the same `PERSON_GRANTED {picks}` to the harness itself, as the person
  with `--source message:<cmsg id>` (the message's id), and the picks it reads from the words (kinds, the
  one-way box, at most one end time; none is no end time, so "stop asking" is every kind and `one-way`). The
  harness takes it only from a person with a message source and the grant's own vocabulary
  (`messageGrantOverreaches`); a session, an agent, the lead or a sender with no source is refused, and the CLI
  refuses `--actor person` in a subagent. A message grant replaces any earlier grant like a tap does, and
  `harness verify-taps` lists it with its message id for another session to read. Every decision carries its class's door (`meta.classes`: plan and accept are
  two-way, merge one-way). The decision reads the harness's grant as the stand-in's answer arrives and decides
  alone (`grantCovers`) only before the grant's end time (if it has one), for a class it names, and for a one-way door only
  with the box; the answer still needs a reason and, for accept, `expectationsMet`, but not the confidence
  threshold: under a grant the person has said they trust the stand-in's judgement, so an answer honest about
  doubt decides like a sure one, and its confidence goes on the granted row. Only an answer received before the
  guard's `thresholdBefore` (when #58's looser rule went live, as PR #60 landed) keeps the threshold it was logged under, so the
  history join run without the source's outbox routes an older log as it was routed. Replay does not need the cutoff:
  it takes each logged event's route from its row, or for an older row from its logged effects (harness
  `meta.store.facts`), so an answer an older
  release routed after the cutoff (#67) also replays as it was routed. Outside the grant the ladder rule (`standInMayDecide`) applies as before,
  threshold included. A decision already waiting on the person goes back to the stand-in for a fresh answer when
  the live grant covers it: the orchestrator sends `REASK_UNDER_GRANT {decision: <decision id>}` to the harness,
  which refuses it from anyone else and unless the decision is in the inbox and the grant covers its class and
  door at the event's own time (`grantMissesDecision`), then takes it out of the inbox and passes it through the
  item to the decision (both refuse it from outside). The decision clears its card (a tap on it decides nothing)
  and asks the stand-in again; if the fresh answer comes back to the person, a new card is asked for. The host
  acks the old card's `postDecisionCard` effect `--outcome failed` if it never posted it. Which one decided is logged
  (`authority`). A decision made under the grant also reports itself (`DECIDED_UNDER_GRANT`, refused from
  outside), and the harness keeps one compact row per decision in `state.json` (`context.granted`: address,
  item, class, door, choice, confidence, reason, the grant's card or message, time). Live mission control declares
  `context.grant` and `context.granted` in its needs file and shows "Decided under your grant": the grant
  (kinds, the one-way box, until or no end time, its card or message) and every row with its confidence, its reason and how to reverse it. `harness page` and the
  daily audit read the same list, each row with its confidence.
- `src/github.js`: `harness from-github FILE` turns one PR activity event (a wake's `<event source="github">`
  text or `{kind, data}` JSON) into the item event it means: a finished check suite is `CHECKS_PASSED`, a
  failed check `CHECKS_FAILED`, a merged PR `MERGED`, a PR closed unmerged `CANCEL`, each from actor github
  and source github-wake. PR refs normalise to one key (`src/pr-binding.js` `prKey`: owner/repo lowercased,
  the number an integer; `owner/repo#N`, `.../pull/N` and URLs alike), so a spelling variant of a bound PR
  is the same PR. CI ids name the PR (`ci-<owner/repo#N>-<sha7>-passed|failed`), so two items' PRs on one
  commit each get their result. It finds
  the item the PR is bound to (the first item whose events named it), then reads the PR from GitHub's REST API
  (`src/github-read.js`: `gh api` run by absolute path, `/usr/local/bin/gh` else what `command -v gh` finds,
  resolved once per process; or fetch with `GH_TOKEN` when there is no gh; the fetcher is injectable and tests
  serve recorded responses). It refuses a malformed answer (`number`, `head.sha` of 40 hex, `merged` boolean,
  `created_at`), and a PR that is not the item's own: created before the item's `REQUEST_RECEIVED`, or on a
  branch that does not name the item (see the branch form under Use). A CI result must name the PR's head by its full
  40-character sha (no sha or a short one is refused) and the head's combined check-run conclusion must agree
  (more runs than one page, `total_count` over the runs returned, is pending); MERGED needs `merged: true`
  and an existing merge commit, and names the head GitHub merged (`sha`), which the item's machine takes only
  when its latest verdict on that head is PASS; CANCEL needs the PR closed and not merged, after the same checks.
  A CI pass also carries the head fact (`head`, `src/github-read.js` `headFact`), read from the same REST API and
  never from the wake: the head's parents (`commits/<sha>`), the one parent `compare/<base>...<parent>` says is
  reachable from the PR's base branch (`onMain`), and, for such a merge, the diff hash against that parent of the head
  and of the other parent (`compare/<onMain>...<sha>`, `diffHash`: each file's added and removed lines, not the
  context or line numbers, null past GitHub's 300 files). With it a verifier's PASS carries to a head that only
  brings main in (spec workItem `merging`, #137): the merge of the passed sha and a commit on main, with the same
  diff and CI green, records the PASS on the new head with the sha it was given on (`givenOn`) and the fact that
  carried it, so it lands without a new verifier run; any other head still needs one. The ref is that fact (`owner/repo#N@<head sha>:checks=success`,
  `owner/repo#N:merged@<merge sha>`, `owner/repo#N` for a close). If GitHub disagrees or cannot be read, it refuses with the reason and
  writes nothing. `harness send` refuses `--actor github` and `--source github-wake`.
  `HARNESS_LIVE_GITHUB=1 npm test -w @ccp/harness` also reads the real PR #21.
- `src/gates.js`: the verifier's verdict and the merge gate (spec workItem, Workers). `harness verdict FILE
  --to item:<id> --pr PR --sha SHA`, run by the verifier subagent, reads PASS or FAIL from the file's first
  line, asks the machine first (a dry run: `apply(..., {dryRun: true})`), posts the text verbatim as a
  COMMENT review on the PR at that head sha (`commit_id`), ending with the item's verifier brief sha256, and
  sends the same verdict as `VERDICT_GIVEN` from its agent actor. A verdict the machine would refuse is never
  posted. (A `harness/verifier` commit status cannot be set: the session proxy refuses POST statuses with
  403, measured 2026-10-27.) `harness merge-gate --pr PR --sha SHA` is the plugin merge gate's question: the
  PR bound to an item, the head pinned, the item's machine taking `MERGED` of that head, and the PASS on
  GitHub as that review on that sha (for a PASS carried to a merge of main, on the sha it was given on); it exits 1
  naming the rule, and never writes.
- `src/verify-facts.js`: `harness verify-facts [--store DIR]` re-reads GitHub for every github-wake event in
  the log and prints one line per fact: `ok`, `mismatch` (GitHub does not back the ref now: other checks, not
  merged at that commit, a commit not on the PR, a CI pass's head fact that is not GitHub's, or a PR that is not
  the item's own) or `unreachable`. It
  exits 1 on any mismatch (else 3 if any could not be read), never writes to the store, and takes the same
  injectable fetcher, so its tests run offline. Run it from outside the session that wrote the log. A
  `--store` with no `events.jsonl` is an error (exit 2) and no folder is made.
- `src/verify-actors.js`: `harness verify-actors [--store DIR]` checks every `session:` actor in the log
  against the ledger the Stop hook files for that session (`$HARNESS_LIBRARY_DIR/ledger/sessions/<id>.json`,
  written after each turn, outside the model's choice). One line per actor: `ok`, `no ledger` (no session ran
  under that id) or `outside window` (an event dated outside the ledger's `start..end`, give or take 5
  minutes). Every `agent:` actor is checked against the SubagentStart hook's record
  (`ledger/sessions/<session_id>/agents/<agent_id>.json`): `ok`, `no record` (no such subagent started in that
  session, another agent_type, or no session ledger yet) or `outside window` (before the subagent started or
  after the session's last filed turn). The start is the earliest one recorded: that record's `at`, the
  bind's call record `ledger/sessions/<session_id>/calls/start-<agent_id>.json`, or the store's own
  `WORKER_STARTED` row naming that agent, sent by its parent session (an agent bound before call records
  existed has only that row); a row from any other session does not count. It exits 1 on any failure and never writes; run it once the sessions'
  turns have ended.
- Roles (spec workItem, Roles): an item records its requester, triagers, workers, criterion checkers and
  stand-in answerers by actor, a session or an agent (a subagent), and refuses an event from an actor that
  already holds another role on it. Two subagents of one session are two actors, and neither is the session. The person and GitHub are exempt from roles; the person acts only by a tap on a card (below).
- Cards (spec decision, audit and grant): a card exists only because the machine asked for it. A decision in
  `awaitingPerson` queues `postDecisionCard`, the day's audit `postAuditCard`, a grant ask `postGrantCard`
  (a checklist, see the grant above). `src/card.js`:
  `harness card <effect-id>` turns either into `request_decision` arguments (approve, revise or drop, with
  the stand-in's lean recommended) plus the `address` and `choices`. The host posts the card, then acks
  the effect alone and once with the card's message id (`harness ack <effect> --card cmsg_...`; `--note` never
  names a card, and a second ack of the effect is refused and writes nothing). The effect's detail carries
  the decision's `address`, where the ack and the tap go;
  the ack sends `CARD_POSTED {card, effect}` from the host session, and the decision or audit records it once
  (a message id already on another card is refused). `harness send` refuses `CARD_POSTED`. A tap on option
  i is `PERSON_DECIDED {choice: choices[i]}` (an audit's `AUDIT_ANSWERED {option: i}`) with
  `--actor person:<id> --source tap:<that message id>`; the machine refuses a tap before the card is
  posted, on another card or with an option the card did not offer (`tapUnbound`, `choiceNotOffered`,
  `optionNotOffered`, `picksNotOffered`). A person actor, or a tap source, on any other event is refused by `apply()`
  (`personEvents`, the events a machine takes from a person): the person triages, builds, checks and blocks
  nothing, and a message source is taken only for a grant.
- `src/verify-taps.js`: `harness verify-taps [--store DIR]` lists every tap and every message grant in the
  log, one line each: event id, time, the card's message id (or, for a grant in the person's words, `message`
  and the message's id), the decision, audit or checklist it went to, the choice (or picks) it claims, the
  person, and the session that relayed it (`relayedBy`, from `$CLAUDE_CODE_SESSION_ID`; inside a session a
  tap or message without it is refused). It never writes, and a `--store` with no `events.jsonl` is an error (exit 2). The machine binds a
  tap to its card, but only the platform knows whether the person tapped that option: verify-taps output
  must be checked by a session other than the one that sent the taps, reading each card with
  `read_messages_by_id` and, for a message grant, checking the picks match the person's words.
- `src/scenario.js` and `scenarios/*.json`: golden event stories. Each step is an event (with `to`, `id`,
  `now`) and an `expect` of `effects` (exact, `dispatchRun:<step>`), `items` `{id: state}`, `scheduler`,
  `budget`, `inFlight`, `queued`, `inbox`, `needsPerson`, `duplicate`, `refused` (`refused: <EVENT> in
  <state>`) or `standin` `{class: autonomy}`.
  `npm run scenarios` (`harness scenarios [FILE...]`) plays each on a scratch store; CI runs it.

## Trust model

- The machine checks who an event says it is from: actor and source kinds, that a ref is there, and that a worker is not the orchestrator.
- The GitHub read checks CI and merges: `from-github` applies them only when GitHub's REST API says the same, for the item's own PR, and `send` cannot claim GitHub.
- Local checks stop mistakes, not a hostile session. Code that runs inside a session can be forged by that session: a fake `gh` first on its PATH, an edited `github-read.js`, or a direct `apply()` with any ref. Nothing more is done locally against that. The check is `harness verify-facts`, which re-reads every GitHub fact in the log from GitHub, run afterwards from outside the session.
- A session's id is the platform's: `harness` takes `session:<id>` from `CLAUDE_CODE_SESSION_ID` and refuses an `--actor session:<id>` that differs (outside Claude Code, with no variable set, it takes the flag as given). A session can still set the variable or call `apply()` itself, so `harness verify-actors` checks every session id in the log against the platform's ledger afterwards.
- A subagent is an actor of its own: agent `<session_id>/<agent_id>`. Its Bash calls see its parent's environment, `CLAUDE_CODE_SESSION_ID` included; only hook input tells them apart (measured on Claude Code 2.1.311: a subagent's PreToolUse and SubagentStart carry `agent_id` and `agent_type`, the parent's PreToolUse neither). The plugin's PreToolUse hook (`plugins/harness/scripts/agent-actor.js`) exports `HARNESS_AGENT=<agent_id>:<agent_type>`, read-only, ahead of a subagent's command that names harness, and denies any command, the parent's included, that sets `HARNESS_AGENT` itself; the CLI then records the agent, and refuses `--actor session:<id>` or another agent for a subagent, and `--actor agent:...` for a session. Its SubagentStart hook files the record `harness verify-actors` checks agents against. Before that, the hook records the call (`$HARNESS_LIBRARY_DIR/ledger/sessions/<session>/calls/<tool_use_id>.json`: session, agent_id, tool_use_id, command hash, time, the sha256 of a fresh key, and whether the hook's own environment has `HARNESS_ENFORCE=1`), for the parent's harness calls too, and every Bash call under `HARNESS_ENFORCE=1`, and exports `HARNESS_CALL=<tool_use_id>:<key>` beside it. The CLI believes an actor only with that key and only when the record names that session and agent, so a variable-built or obfuscated `HARNESS_AGENT`, or an id a command writes itself, records nothing. A call recorded under `HARNESS_ENFORCE=1` marks its store enforced (`enforced.json`, naming the Library of the records); an enforced store takes a write only from a recorded call, and the CLI never reads `HARNESS_ENFORCE`, so a command that clears or overrides it, unsets `HARNESS_CALL` or `CLAUDE_CODE_SESSION_ID`, or points `HARNESS_LIBRARY_DIR` elsewhere writes nothing (spec harness `meta.invariants` `hookSawCall`). What this does not stop: a process that writes the Library's or the store's files directly (every session runs as the same user), and verify-actors cannot tell one real subagent of a session from another.
- Worker spawns and merges pass through the machine (spec workItem, Workers). The plugin's spawn gate records an item-role spawn (the brief's line `Harness-Role: <role> item:<id>`) as `WORKER_SPAWNED` before the Agent call runs, and its SubagentStart hook binds the agent to it; a builder spawn is refused until `VERIFIER_BRIEF_FIXED`, a verifier spawn whose brief hash differs from it is refused, and an agent sends only the events its role on the addressed item allows (harness `meta.agentEvents`: a triager `TRIAGED`, a builder `RUN_SUCCEEDED` and `RUN_FAILED`, a verifier `CRITERION_CHECKED` and `VERDICT_GIVEN`, a stand-in, spawned while a decision is open, `STAND_IN_ANSWERED`), so an agent with no role, or on another item, sends nothing. The merge gate asks `harness merge-gate` before `mcp__github__merge_pull_request`, the one route for a landing; it reads no Bash command, since a command's text cannot say what bash will do. Under `HARNESS_ENFORCE=1` both deny, naming the rule; without it they only record. A landing by any other route (a Bash command, a script that calls GitHub's API itself) is not blocked, so each gate leaves a record another session audits: the spawn in the store and the call record, and `harness doctor`'s check of every PR landed on main against its verifier's PASS.
- The merge gate and `harness doctor`'s audit of merged PRs compare the verdict review GitHub holds with the
  stored `VERDICT_GIVEN` text exactly, so a forged or edited review does not pass. They tolerate one rewrite: this
  host's GitHub proxy appends an attribution footer to every review a session posts, so the body may be the
  stored text followed by exactly that footer (harness `meta.reviewFooter`, defined there once; review
  5680229689 on #60 was refused for it, #61). Any other difference, text after the footer included, is refused.
- A tap is bound to the card the machine asked for: its ref must be the message id recorded from the ack of
  that decision's or audit's own card effect, and its choice one of the card's options. That the person
  really tapped it is checked only afterwards, against the platform: `harness verify-taps`, by another
  session.

## Use

```sh
harness init --wip 3                # this session ($CLAUDE_CODE_SESSION_ID) is the orchestrator
harness send '{"type":"WIP_SET","limit":2}'   # later, the orchestrator only: 1 to 4, raising starts queued items now
harness send '{"type":"REASK_UNDER_GRANT","decision":"decision:a:plan:1"}'   # the orchestrator only: back to the stand-in, if the live grant covers it
harness send '{"type":"DAY_STARTED","sevenDay":0.07,"fiveHour":0.04}' --to budget --id day-2026-10-26
harness send '{"type":"REQUEST_RECEIVED","request":{"id":"a","title":"Fix login","expect":"login works"}}' --id req-a
# each of these runs in its own thread, so it is sent as that session
harness send '{"type":"TRIAGED","tier":1,"criteria":["login works in Safari"]}' --to item:a           # the triager's
harness send '{"type":"RUN_SUCCEEDED"}' --to item:a --actor session:$CLAUDE_CODE_SESSION_ID --source cli:<handback ref>  # the worker's
harness send '{"type":"CRITERION_CHECKED","criterion":"login works in Safari","verdict":"met","evidence":"test/login.test.js"}' \
  --to item:a                                                                                            # the reviewer's
harness status                      # summary JSON; decisions carry their address
harness card e9.0                   # request_decision arguments for the decision's postDecisionCard
harness ack e9.0 --card cmsg_123    # after posting it: the card's message id, which the decision records
harness send '{"type":"PERSON_DECIDED","choice":"approve"}' --to item:a/decision:a:plan:1 \
  --actor person:<id> --source tap:cmsg_123   # the person's tap on that card
harness verify-taps --store .harness   # later, from another session: check each tap against its card
harness from-github wake.txt        # CI and merges: the wake's text, applied once GitHub agrees
harness verify-facts --store .harness  # later, from outside: re-read every GitHub fact in the log
harness verify-actors --store .harness # later: every session in the log has a ledger covering its events
# the lead fixes the verifier's brief before spawning a builder (sha256 of the exact Agent prompt)
harness send "{\"type\":\"VERIFIER_BRIEF_FIXED\",\"sha256\":\"$(sha256sum < verifier-brief.md | cut -d' ' -f1)\"}" --to item:a
harness verdict verdict.md --to item:a --pr <PR url> --sha <head sha>   # the verifier's: review + VERDICT_GIVEN
harness merge-gate --pr <PR url> --sha <head sha>   # may it merge now (the plugin's merge gate asks this)
harness effects                     # what the host still has to do (an era's effect shows its sourceId too)
harness ack e3.0 --note "dispatched"   # any other effect: a note, no card; acked already is a duplicate, not a second ack
harness page --standalone           # .harness/mission-control.html
harness page --live --project chan_... --files-path harness/state/dogfood   # live mission control, refreshed on a press
```

Workers put the item id in the branch name of their PR, as the whole slug, in exactly one of these forms:

- `<type>/<item id>`, such as `feat/login-fix`
- `<type>/<issue>-<item id>`, such as `feat/42-login-fix`
- `<type>/<issue>-<item id>--<agent>`, or `<type>/<item id>--<agent>`, such as `feat/42-login-fix--tests`

The rule (`branchNamesItem` in `src/pr-binding.js`): the slug after `<type>/`, less an optional leading
`<number>-` and an optional trailing `--<agent>`, must equal the item id. A branch that only contains the id
does not count: `feat/login-fix-2` and `feat/login-fix-from-github` are not item `login-fix`'s, and item `e`
matches only a slug that is exactly `e`. Open the PR after the item's request: from-github refuses CI,
merges and closes for a PR that is not the item's own, and the first event naming a PR binds it to that
item for good.

The host (an orchestrator thread) is the only writer. It runs each effect (dispatch a run, post a
decision card, merge a PR), acknowledges it, and turns what comes back (CI result, a person's tap)
into the next `send`, naming who sent it. A session that takes over a store sends
`{"type":"ORCHESTRATOR_STARTED"}` first, so runs it reports itself are refused.

## Making the one history the live store

A runbook for the lead (#146), not a command. The live store is `state/dogfood2`; the one history takes its place,
and dogfood2 is kept as it is, an archive the history was read from. Run it when no wake is running, so nothing
writes dogfood2 between the copy and the switch.

1. Copy the Library's `harness/` folder into a scratch folder: `cp -r /mnt/project-files/harness <scratch>/harness`.
2. Build the history: `node packages/harness/scripts/history/join.mjs --from <scratch>/harness --out <scratch>/history`.
   Its summary should show 0 conflicts; `report.json` lists the rows it could not apply, each with its reason.
3. Check it: `HARNESS_LIBRARY_DIR=<scratch>/harness harness --dir <scratch>/history doctor`. It should give 0 schema
   errors and `ok: true`, or name each problem left with a reason it is real (a session whose ledger does not cover
   its rows). Old eras' landings are in `admittedThen`, one line per era, and the rows `report.json` lists in
   `history.refused`, counted by reason.
4. Check the effects: `harness --dir <scratch>/history effects` lists every effect dogfood2 has not acked, as
   `era:dogfood2.<n>` with its dogfood2 id in `sourceId`; there are as many as `harness --dir <scratch>/harness/state/dogfood2 effects` lists.
5. Put it in place as a new store, `state/history`, and copy dogfood2's host files `enforced.json` (so the store
   stays enforced) and `handoff-notes.md` into it. Keep `report.json` there: doctor reads it.
6. Switch: set `HARNESS_DIR` to `/mnt/project-files/harness/state/history` wherever it names dogfood2: the lead's
   environment, and the `HARNESS_DIR` the lead's briefs name in each store command they hand an agent. The allow rule
   for the history is already in place: `.claude/settings.json` allows the store command with `state/history` next to
   the one with `state/dogfood2` (#150), so no session has to add a rule for itself. `session-start.sh` merges that
   file into the user settings when a session starts, so the switch takes effect in the session that starts after the
   rule lands, not in one already running. From then on the hooks and the CLI write the history, and dogfood2 is not
   written again.

The host does with an era's effects what it did before: it runs each and acks it, by the id it knows
(`harness ack e27.1`) or by the new one (`harness ack era:dogfood2.0`); either acks the same effect, and a second ack,
by either id, is a duplicate that writes nothing. An era's effects are queued at the time of its `ERA_ENDED` row, so
doctor counts one as pending over a day only a day after the build.
