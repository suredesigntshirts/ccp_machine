# harness

Design phase. The agent harness for Claude Projects and GitHub is being specified as XState v5
statecharts; nothing here is the implementation yet.

- `npm install` installs `xstate` (pinned to 5.33.3).
- `npm run xstate:src` clones the matching xstate source into `vendor/xstate` (gitignored) for reading.
- `npm run spike` runs `spike/*.test.js`: checks of the XState behaviours the design relies on
  (pure transitions, persisted snapshots, the actor system, inspection, emit, `xstate/graph`).
