# harness

Design phase. The agent harness for Claude Projects and GitHub is specified as XState statecharts;
nothing here is the implementation yet.

## The spec (`spec/`)

The living document the harness must follow.

- `*.machine.json`: the machines as plain JSON: every state, event, gate, tag, and the name and params of
  every effect. These files are the spec. Change them first.
  - `harness`: root actor held by the orchestrator thread: intake, scheduler (WIP limit, budget), the
    person's inbox.
  - `workItem`: one thing in flight, from request to merge, with gates by risk tier.
  - `decision`: one decision; the stand-in answers first and decides alone only where it has earned it.
  - `budget`: daily slice of the 7-day usage window, soft and hard limits, the 5-hour window.
- `implementations.js`: binds the JSON to XState v5: guard logic, context updates, and default (no-op)
  external effects that a real host replaces with `machine.provide()`.
- `spec.test.js`: checks that every name is bound, no gate is a dead end, every state is reachable
  (`xstate/graph`), and the gates, stand-in and budget behave as written.
- `portable.test.js`: the same JSON builds in XState v6 alpha (`xstate-v6`).
- `SPEC.md`: generated diagrams; `npm run spec:render` after changing the JSON.

## Commands

- `npm run spec`: the spec checks. `npm run spike`: the round-1 primitive checks in `spike/`.
- `npm run xstate:src`: clones the matching xstate source into `vendor/xstate` (gitignored) for reading.
