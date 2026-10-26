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
- `src/doctor.js`: `harness doctor` checks the store (event version gaps, acks for unknown effects, effects
  pending over a day, a lock older than 60s, a snapshot that will not restore) and exits 1 on a problem.
- `src/card.js`: `harness card <effect-id>` turns a `postDecisionCard` effect into `request_decision`
  arguments (approve, revise or drop, with the stand-in's lean recommended) plus the decision's `address`
  and `choices`; a tap on option i is `PERSON_DECIDED {choice: choices[i]}` with the card's id as `--id`.

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
