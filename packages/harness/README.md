# @ccp/harness

The harness spec and the runtime that drives it.

- `spec/*.machine.json`: the XState machines as plain JSON (the SPEC the harness is built against).
  `npm run spec:render -w @ccp/harness` regenerates `spec/SPEC.md` (Mermaid diagrams). The JSON also
  loads in XState v6 (`machineFromJSON`); the v6 check lives in ccp_machine `harness/spec/portable.test.js`.
- `src/machines.js`: binds the JSON to XState v5. Effects that leave the machine go to a sink as data.
- `src/runtime.js`: the backend-workflow loop. Every wake restores the root actor from the store,
  applies one event, persists, and queues the effects that event asked for. Event ids make it idempotent.
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
- `src/stalled.js`: `harness stalled [--after 60m]` lists in-flight items whose last event is older than
  the limit; mission control shows how long ago each in-flight item moved.
- `src/doctor.js`: `harness doctor` checks the store (event version gaps, acks for unknown effects, effects
  pending over a day, a lock older than 60s, a snapshot that will not restore) and exits 1 on a problem.
- `scripts/pages-check.mjs`: `npm run pages:check` renders mission control, every item page and the decision
  log from a fixture store with `harness page`, then opens each in Chromium (Playwright, pinned as a root dev
  dependency) at 400 and 1200 px in light and dark. It fails on sideways scroll, a relative link to a missing
  file, an empty title or a page over 1 MB, and saves screenshots to `--shots` (default
  `/mnt/project-files/harness/state/sim/shots` when the Library is mounted). CI runs it and uploads the shots.
- `src/repair.js`: `harness repair [--rebuild]` fixes only the safe faults: it drops a torn last line of a
  log and clears a stale lock. With `--rebuild`, it also rebuilds a `state.json` that is ahead of
  `events.jsonl` (a crash between the two writes) from the log, so the host can resend the lost event.
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
  control that saves to the Artifact `db` collection `requests`; `harness intake FILE` files each new row
  as `REQUEST_RECEIVED` (`req-<row id>`, idempotent) and prints the updates that mark rows taken.
- `src/sim.js`: `npm run sim` drives 12 synthetic items (every tier, a failed run, failed checks, a block,
  a person's revise) through a scratch store at WIP 3 and at WIP 12 with a scripted host. It checks the
  WIP limit, the queue, the outbox, doctor, the page size and an apply at 500 events, and saves the
  busiest mission control to `--out`.
- `src/audit.js`: `harness audit` picks up to 3 decisions the stand-in made alone (untested classes, low
  confidence and old ones first) for one daily card; `--answer N` logs the tap as the person's decisions
  (0 confirms all, N reverses pick N), so calibration and the ladder get tested decisions. Doctor warns
  when a class goes over 20 stand-in decisions unchecked.
- `src/card.js`: `harness card <effect-id>` turns a `postDecisionCard` effect into `request_decision`
  arguments (approve, revise or drop, with the stand-in's lean recommended) plus the decision's `address`
  and `choices`; a tap on option i is `PERSON_DECIDED {choice: choices[i]}` with the card's id as `--id`.
- `src/scenario.js` and `scenarios/*.json`: golden event stories. Each step is an event (with `to`, `id`,
  `now`) and an `expect` of `effects` (exact, `dispatchRun:<step>`), `items` `{id: state}`, `scheduler`,
  `budget`, `inFlight`, `queued`, `inbox`, `needsPerson`, `duplicate` or `standin` `{class: autonomy}`.
  `npm run scenarios` (`harness scenarios [FILE...]`) plays each on a scratch store; CI runs it.

## Use

```sh
harness init --wip 3
harness send '{"type":"DAY_STARTED","sevenDay":0.07,"fiveHour":0.04}' --to budget --id day-2026-10-26
harness send '{"type":"REQUEST_RECEIVED","request":{"id":"a","tier":1,"title":"Fix login"}}' --id req-a
harness send '{"type":"RUN_SUCCEEDED"}' --to item:a
harness status                      # summary JSON; decisions carry their address
harness send '{"type":"PERSON_DECIDED","choice":"approve"}' --to item:a/decision:a:plan:1
harness effects                     # what the host still has to do
harness ack e3.0 --note "posted"
harness page --standalone           # .harness/mission-control.html
```

The host (an orchestrator thread) is the only writer. It runs each effect (dispatch a run, post a
decision card, merge a PR), acknowledges it, and turns what comes back (CI result, a person's tap)
into the next `send`.
