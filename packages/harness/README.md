# @ccp/harness

The harness spec and the runtime that drives it.

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
- The envelope: every event carries `actor` {kind: person|session|github|timer, id} and `source`
  {kind: tap|github-wake|cli|timer, ref}; one without them is refused. Each `events.jsonl` row is
  `{id, version, at, to, actor, source, harness: {version, commit}, event}`, the last two naming the
  harness code that applied it. Who may send what is in the machines, as guards that refuse an event
  from the wrong party (SPEC.md lists them under Refused): `PERSON_DECIDED` only from a person's tap
  (ref: the card's message id), a run result only from an actor other than the orchestrator (its id is
  in context, set by `ORCHESTRATOR_STARTED`), CI and merge results only from a GitHub wake (ref: the
  GitHub fact `harness from-github` read), and `DECISION_MADE` and `BUDGET_MODE` only from inside the
  harness. The trust model is below.
- The stand-in's gate (`standInMayDecide`): each input has one supplier, and the stand-in's caller supplies
  none of the rules. Tier is the item's (still the filer's, from the request, until M2b). Autonomy is the
  ladder's rung for the class over `decisions.jsonl` (rows before the decision opened), set on the decision
  when it is spawned; a log that cannot be read gives `recommend`, so the person decides. Threshold is the
  constant in `decision.machine.json`'s context. Confidence is the stand-in's: `STAND_IN_ANSWERED` carries
  only choice, confidence and reason, is refused with autonomy or threshold or without a confidence, and is
  refused from the orchestrator and from every worker that reported a run for the item (both recorded on the
  decision at spawn). `test/paths.test.js` replays generated paths through all four
  machines (event payloads in `test/path-fixtures.json`) and checks each step against the machine.
- `src/store.js`: a folder per harness. `state.json` is replaced whole under a lock with
  compare-and-set on its version; `events.jsonl`, `outbox.jsonl` and `acks.jsonl` are append-only.
- `src/page.js`: mission control, one page with what needs the person, what is in flight, the host's
  to-do and recent events. Each item row links to its item page.
- `src/item-page.js`: one page per item (`items/<id>.html`) that answers "did it do what I expected":
  the request (`request.expect` if given, else its title), how it ended (state, CI, acceptance, PR),
  every gate with who decided and the stand-in's reason, each effect with the host's ack note, and the
  item's events. The host can put the PR link on any event it sends for the item (`"pr": "<url>"`).
- `src/decision-log.js`: `harness decisions` appends each `logPrecedent` effect to `decisions.jsonl` in
  the store (once per effect, backfilling acknowledged ones) and acks it. `decisions.html` shows, per
  decision class, how often the stand-in's lean matched the final choice and the class's rung, then every
  decision. `harness standin <class>` prints the rung (`ladder()`): a class starts at `recommend`, climbs
  one rung (to `act`) after 20 of the person's decisions since its last change at 90% agreement with the
  lean (`EARN_ACT`; a decision the stand-in made itself never counts), and drops
  one rung (to `shadow` at the floor) on each reversal, where the final choice differs from the lean.
- `src/digest.js`: `harness digest [--day YYYY-MM-DD]` sends `DIGEST_DUE` with id `digest-<UTC day>`, so a
  day gets one digest however often it runs, writes `digests/<day>.md` in the store (finished today, in
  flight, waiting on the person, decisions today, budget) and acks `publishDigest`. The host posts the text.
- `src/attention.js`: `attention(item, records)` is what an item cost: the person's touches (decision cards
  plus events marked `person: true`), stand-in decisions and the person's reversals of its lean, turns,
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
  pending over a day, a lock older than 60s, a snapshot that will not restore) and exits 1 on a problem.
- `scripts/pages-check.mjs`: `npm run pages:check` renders mission control, every item page and the decision
  log from a fixture store with `harness page`, then opens each in Chromium (Playwright, pinned as a root dev
  dependency) at 400 and 1200 px in light and dark. It fails on sideways scroll, a relative link to a missing
  file, an empty title or a page over 1 MB, and saves screenshots to `--shots` (default a temp folder,
  never the Library). CI runs it and uploads the shots.
- `src/repair.js`: `harness repair [--rebuild]` fixes only the safe faults: it drops a torn last line of a
  log and clears a stale lock. With `--rebuild`, it also rebuilds a `state.json` that is ahead of
  `events.jsonl` (a crash between the two writes) from the log, so the host can resend the lost event.
  It re-applies github-wake refs as logged, without reading GitHub; `harness verify-facts` re-checks them.
  `test/chaos.test.js` injects each fault: a crash, a stale lock, racing writer processes, duplicates,
  torn lines and a slow mount.
- `src/canary.js`: `harness canary` files the day's tier-0 canary item (bump `canary/last.txt`, PR, CI,
  merge) once per UTC day. `harness canary --check` times each stage and exits 1 with one attention line
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
  as `REQUEST_RECEIVED` (`req-<row id>`, idempotent) and prints the updates that mark rows taken.
- `src/expect-check.js`: `harness check <item> --init` writes `checks/<item>.md` from the request's `expect`, one
  line each, to mark `[met]`, `[unmet]` or `[unclear]` with evidence. `harness send` refuses a stand-in approve
  on an accept gate until every line is met, and the item page shows the check beside the ask.
- `src/sim.js`: `npm run sim` drives 12 synthetic items (every tier, a failed run, failed checks, a block,
  a person's revise) through a scratch store at WIP 3 and at WIP 12 with a scripted host. It checks the
  WIP limit, the queue, the outbox, doctor, the page size and an apply at 500 events, and saves the
  busiest mission control to `--out` (default a temp folder).
- `src/audit.js`: `harness audit` picks up to 3 decisions the stand-in made alone (untested classes, low
  confidence and old ones first) for one daily card; `--answer N` logs the tap as the person's decisions
  (0 confirms all, N reverses pick N), so calibration and the ladder get tested decisions. Doctor warns
  when a class goes over 20 stand-in decisions unchecked.
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
  and an existing merge commit; CANCEL needs the PR closed and not merged, after the same checks. The ref is that fact (`owner/repo#N@<head sha>:checks=success`,
  `owner/repo#N:merged@<merge sha>`, `owner/repo#N` for a close). If GitHub disagrees or cannot be read, it refuses with the reason and
  writes nothing. `harness send` refuses `--actor github` and `--source github-wake`.
  `HARNESS_LIVE_GITHUB=1 npm test -w @ccp/harness` also reads the real PR #21.
- `src/verify-facts.js`: `harness verify-facts [--store DIR]` re-reads GitHub for every github-wake event in
  the log and prints one line per fact: `ok`, `mismatch` (GitHub does not back the ref now: other checks, not
  merged at that commit, a commit not on the PR, or a PR that is not the item's own) or `unreachable`. It
  exits 1 on any mismatch (else 3 if any could not be read), never writes to the store, and takes the same
  injectable fetcher, so its tests run offline. Run it from outside the session that wrote the log. A
  `--store` with no `events.jsonl` is an error (exit 2) and no folder is made.
- `src/card.js`: `harness card <effect-id>` turns a `postDecisionCard` effect into `request_decision`
  arguments (approve, revise or drop, with the stand-in's lean recommended) plus the decision's `address`
  and `choices`; a tap on option i is `PERSON_DECIDED {choice: choices[i]}` sent with
  `--actor person:<id> --source tap:<card message id>`.
- `src/scenario.js` and `scenarios/*.json`: golden event stories. Each step is an event (with `to`, `id`,
  `now`) and an `expect` of `effects` (exact, `dispatchRun:<step>`), `items` `{id: state}`, `scheduler`,
  `budget`, `inFlight`, `queued`, `inbox`, `needsPerson`, `duplicate`, `refused` (`refused: <EVENT> in
  <state>`) or `standin` `{class: autonomy}`.
  `npm run scenarios` (`harness scenarios [FILE...]`) plays each on a scratch store; CI runs it.

## Trust model

- The machine checks who an event says it is from: actor and source kinds, that a ref is there, and that a worker is not the orchestrator.
- The GitHub read checks CI and merges: `from-github` applies them only when GitHub's REST API says the same, for the item's own PR, and `send` cannot claim GitHub.
- Local checks stop mistakes, not a hostile session. Code that runs inside a session can be forged by that session: a fake `gh` first on its PATH, an edited `github-read.js`, or a direct `apply()` with any ref. Nothing more is done locally against that. The check is `harness verify-facts`, which re-reads every GitHub fact in the log from GitHub, run afterwards from outside the session.
- Checked only afterwards: that session ids are who they say (a worker's run result), and that a tap happened (`--source tap:` through `send`, until M4).

## Use

```sh
harness init --wip 3                # this session ($CLAUDE_CODE_SESSION_ID) is the orchestrator
harness send '{"type":"DAY_STARTED","sevenDay":0.07,"fiveHour":0.04}' --to budget --id day-2026-10-26
harness send '{"type":"REQUEST_RECEIVED","request":{"id":"a","tier":1,"title":"Fix login"}}' --id req-a
harness send '{"type":"RUN_SUCCEEDED"}' --to item:a --actor session:<worker id> --source cli:<handback ref>
harness status                      # summary JSON; decisions carry their address
harness send '{"type":"PERSON_DECIDED","choice":"approve"}' --to item:a/decision:a:plan:1 \
  --actor person:<id> --source tap:<card message id>
harness from-github wake.txt        # CI and merges: the wake's text, applied once GitHub agrees
harness verify-facts --store .harness  # later, from outside: re-read every GitHub fact in the log
harness effects                     # what the host still has to do
harness ack e3.0 --note "posted"
harness page --standalone           # .harness/mission-control.html
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
