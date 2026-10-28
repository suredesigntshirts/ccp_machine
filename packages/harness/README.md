# @ccp/harness

The harness spec and the runtime that drives it.

Who supplies what an item is judged by. The filer (a person's request box row, a backlog issue, the canary)
names the work and says what it expects in its own words; a request that sets a tier, criteria or anything
else the item's machine holds is refused. A triager, who is not the requester, the orchestrator or a worker,
sends `TRIAGED {tier, criteria}`; until it does, nothing leaves triage, and with no criteria the item waits
for the person (`needsCriteria`, tagged `needs-human`) and only a cancel ends it. A reviewer, who is neither
the orchestrator nor a worker, sends `CRITERION_CHECKED {criterion, verdict, evidence}` per criterion; a new
build clears them. An item with a verifier brief leaves verifying only when CI has passed and the verifier's
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
  An event the addressed actor would not take (`snapshot.can`) is refused: nothing is written and the
  result says `refused: <EVENT> in <state>`. An item's PR is bound once, by the first event that names it
  (`"pr"`), and one PR binds to at most one item (`src/pr-binding.js`): an event naming another PR for a
  bound item, or a PR bound to another item, is refused the same way with the binding in the reason.
- The envelope: every event carries `actor` {kind: person|session|agent|github|timer, id} (the kinds and their
  id forms are the spec's, `harness.machine.json` `meta.actors`; an agent is `<session_id>/<agent_id>`) and `source`
  {kind: tap|github-wake|cli|timer, ref}; one without them is refused, and so is one carrying `person`
  (no event marks itself as the person's). Each `events.jsonl` row is
  `{id, version, at, to, actor, source, harness: {version, commit}, event}`, the last two naming the
  harness code that applied it. Who may send what is in the machines, as guards that refuse an event
  from the wrong party (SPEC.md lists them under Refused): `PERSON_DECIDED` only from a person's tap
  on the card the machine asked for (ref: the message id its decision recorded from the ack, see Cards
  below), a run result only from an actor other than the orchestrator (its id is
  in context, set by `ORCHESTRATOR_STARTED`), CI and merge results only from a GitHub wake (ref: the
  GitHub fact `harness from-github` read), and `DECISION_MADE` and `BUDGET_MODE` only from inside the
  harness. `TRIAGED` is refused from the requester, the orchestrator and every worker on the item, and
  `CRITERION_CHECKED` from the orchestrator and every worker. The trust model is below.
- The stand-in's gate (`standInMayDecide`, the ladder rule; under the person's grant `grantCovers` decides first, see `spec/grant.machine.json` below): each input has one supplier, and the stand-in's caller supplies
  none of the rules. Tier is the item's, set by triage (`TRIAGED`), never by the request. For an accept
  decision, `expectationsMet` is the item's, worked out at its accept gate from the criteria checks. Autonomy is the
  ladder's rung for the class over the store's own decided decisions (its `logPrecedent` effects and
  `AUDIT_ANSWERED` events, dated at or before the spawn), set on the decision when it is spawned, so a reversal
  lowers the very next decision's rung with no command run; a log that cannot be read gives `recommend`. Threshold is the
  constant in `decision.machine.json`'s context. Confidence is the stand-in's: `STAND_IN_ANSWERED` carries
  only choice, confidence and reason, is refused with autonomy or threshold or without a confidence, and is
  refused from the orchestrator and from every worker that reported a run for the item, succeeded or failed
  (both recorded on the decision at spawn). `test/paths.test.js` replays generated paths through all six
  machines (event payloads in `test/path-fixtures.json`) and checks each step against the machine.
- `src/store.js`: a folder per harness. `state.json` is replaced whole under a lock with
  compare-and-set on its version, and carries the spec's `schemaVersion` (harness `meta.store`); `events.jsonl`, `outbox.jsonl` and `acks.jsonl` are append-only.
- `src/page.js`: mission control, one page with what needs the person, what is in flight, the host's
  to-do and recent events. Each item row links to its item page.
- `pages/<page>/needs.json`, `src/pages.js` and `src/live.js`: the page needs contract. A page declares in its needs
  file the one store file it reads (`reads.file`, mission control's is `state.json`), the `schemaVersion` range it
  understands, the fields it reads (paths into the store root, the harness snapshot and each child snapshot, the
  children told apart by spec machine id), and the spec states and events it names. `project()` copies only those
  fields; the renderer sees nothing else. `harness page --live --project chan_... --files-path <store path in the
  Library>` renders live mission control: the store as it was at render, how old that is, and a Refresh button.
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
- `spec/history.schema.json` and `src/history.js`: the one history (epic #59), the row every era's events take,
  with its provenance, placeholders, event versions and fact identity; `spec/SPEC.md` renders its rules (History).
  `src/history.js` only reads the schema: `validate` holds a row to it and to harness `meta.actors` and
  `meta.sources`, `placeholders` and `outOfBand` list what doctor will report, and `dedupe` applies the identity
  rules and reports conflicts. A view that reads the history (`reads.file` `events.jsonl`: ledger, flow replay,
  design log) declares the event types and fields it reads instead of state fields, and `checkPage` holds it to the
  schema and, given rows, to that history. `test/history.test.js` checks all of it against the golden history,
  `test/fixtures/history-golden/events.jsonl`.
- `scripts/history/`: tools that build the one history, outside the plugin and the runtime (tracer T, #65).
  `extract-store.mjs <store dir> <archive ref>` (E1) reads a store's `events.jsonl` and prints each row as a
  history row (provenance `migrated`, `from` the archive ref and the line) or, on stderr, a skip naming the line
  and why. `join.mjs <candidates>... --out <dir>` (M1) takes those rows (each must pass `validate`), keeps one
  per fact (`dedupe`), numbers them from 1 in time order, and makes `--out`, which must not exist, a store:
  `events.jsonl` is the history, `state.json` and `outbox.jsonl` come from replaying it with the current code,
  and `report.json` lists the dropped rows, the conflicts and the rows the current code refuses. It writes
  nothing else and never edits an input. Acks are not history, so every effect of the joined store is pending.
  An OUT_OF_BAND row is history only (no machine takes it), so the replay counts it among the refused rows.
  `recovered/dogfood2.jsonl` holds what dogfood2 recorded in other rows only, rebuilt as rows (origin
  `recovered`, with `from` and `also` naming the sources): the PR #66 landing out of band, which its CANCEL row and
  GitHub record. Join it with dogfood2's extracted rows.
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
  It re-applies github-wake refs as logged, without reading GitHub; `harness verify-facts` re-checks them.
- `src/stalled.js`: `harness stalled [--after 60m]` lists in-flight items whose last event is older than
  the limit; mission control shows how long ago each in-flight item moved.
- `src/doctor.js`: `harness doctor` checks the store (event version gaps, acks for unknown effects, effects
  pending over a day, a lock older than 60s, a snapshot that will not restore, an actor in a state whose spec
  names `meta.waitsOn` with no such effect pending for it, such as a decision in `askingStandIn` whose
  `askStandIn` was acked without its answer recorded), runs `verify-actors` and
  `verify-facts` (one async `doctor()`), lists every merged PR bound to an item whose merge head has no
  verifier PASS in the store or no PASS review on GitHub on that sha (`src/gates.js` `verifyMerges`), and
  exits 1 on a problem: a mismatch, a merge without its PASS, or a session's missing ledger for
  an event 10 minutes old or more. What cannot be checked yet (GitHub unreachable, a ledger not filed for a
  session that acted under 10 minutes ago) is listed as `unverifiable`, exit 0. Every OUT_OF_BAND row of the
  history (work done outside the gates) is listed as `outOfBand`: who ordered it, what, its PR and head, the gates it
  skipped. A merged PR whose landing such a row records (its `pr`, and its `sha` when it names one) is listed
  there, not counted as a problem. A landing that no row records is still a problem (harness `meta.invariants`
  `reviewOnHead`).
- `scripts/pages-check.mjs`: `npm run pages:check` renders mission control, every item page and the decision
  log from a fixture store with `harness page`, then opens each in Chromium (Playwright, pinned as a root dev
  dependency) at 400 and 1200 px in light and dark. It fails on sideways scroll, a relative link to a missing
  file, an empty title or a page over 1 MB, and saves screenshots to `--shots` (default a temp folder,
  never the Library). It also renders live mission control from a sim-built store and, with a stand-in for the
  Artifact runtime, presses Refresh: the page must not read the store or record anything before the press, must
  re-render and record one timing row with the store version after it, and must show the red banner and no table
  for a store whose `schemaVersion` it does not read. CI runs it and uploads the shots.
- `src/repair.js`: `harness repair [--rebuild]` fixes only the safe faults: it drops a torn last line of a
  log and clears a stale lock. With `--rebuild`, it also rebuilds a `state.json` that is ahead of
  `events.jsonl` (a crash between the two writes) from the log, so the host can resend the lost event.
  It re-applies github-wake refs as logged, without reading GitHub; `harness verify-facts` re-checks them.
  `test/chaos.test.js` injects each fault: a crash, a stale lock, racing writer processes, duplicates,
  torn lines and a slow mount.
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
  guard's `thresholdBefore` (when #58's looser rule went live, as PR #60 landed) keeps the threshold it was logged under, so replay
  routes an older log as it was routed. Outside the grant the ladder rule (`standInMayDecide`) applies as before,
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
  when its verifier's latest verdict on that head is PASS; CANCEL needs the PR closed and not merged, after the same checks. The ref is that fact (`owner/repo#N@<head sha>:checks=success`,
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
  GitHub as that review on that sha; it exits 1 naming the rule, and never writes.
- `src/verify-facts.js`: `harness verify-facts [--store DIR]` re-reads GitHub for every github-wake event in
  the log and prints one line per fact: `ok`, `mismatch` (GitHub does not back the ref now: other checks, not
  merged at that commit, a commit not on the PR, or a PR that is not the item's own) or `unreachable`. It
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
  after the session's last filed turn). The start is the earliest one a hook recorded: that record's `at`, or the
  bind's call record `ledger/sessions/<session_id>/calls/start-<agent_id>.json`. It exits 1 on any failure and never writes; run it once the sessions'
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
- Worker spawns and merges pass through the machine (spec workItem, Workers). The plugin's spawn gate records an item-role spawn (the brief's line `Harness-Role: <role> item:<id>`) as `WORKER_SPAWNED` before the Agent call runs, and its SubagentStart hook binds the agent to it; a builder spawn is refused until `VERIFIER_BRIEF_FIXED`, a verifier spawn whose brief hash differs from it is refused, and an agent sends only the events its role on the addressed item allows (harness `meta.agentEvents`: a triager `TRIAGED`, a builder `RUN_SUCCEEDED` and `RUN_FAILED`, a verifier `CRITERION_CHECKED` and `VERDICT_GIVEN`, a stand-in, spawned while a decision is open, `STAND_IN_ANSWERED`), so an agent with no role, or on another item, sends nothing. The merge gate asks `harness merge-gate` before `mcp__github__merge_pull_request` and before a Bash call that is exactly one gated form (`gh pr merge <number> --repo <owner>/<repo> --match-head-commit <sha>` or `gh api -X PUT repos/<owner>/<repo>/pulls/<number>/merge -f sha=<sha>`); any other merge is denied: `gh pr merge` or a `gh api` path naming a merge endpoint, a word the shell rewrites (expansion, brace, glob, tilde) where it decides what `gh pr`, `gh api`, `curl` or `wget` does, or the word `merge` with `gh`, `curl`, `wget`, `api` or `graphql` in a call that runs what the gate cannot read (bash syntax outside the reader's allow-list, which the spec lists, an environment assignment other than `HARNESS_DIR` or `HARNESS_LIBRARY_DIR`, a shell, an interpreter, `eval`, a wrapper, a script, a variable; the words of `gh` commands that never run an argument (`api`, `issue`, `label`, `pr`, `release`, `run`, `search`, `status`, `help`, `version`), `echo`, `printf`, `cat`, `jq` and the harness CLI are data unless the call writes a file; any other `gh` command, such as `codespace ssh`, is not), and a GitHub write built from variables, a `gh` alias or extension, or a GraphQL mutation is denied too (`readableGitHubWrite`). Under `HARNESS_ENFORCE=1` both deny, naming the rule; without it they only record. A program that calls GitHub's API itself (a script in node or python) is not read, so each gate leaves a record another session audits: the spawn in the store and the call record, and `harness doctor`'s check of every merged PR against its verifier's PASS.
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
harness effects                     # what the host still has to do
harness ack e3.0 --note "dispatched"   # any other effect: a note, no card
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
