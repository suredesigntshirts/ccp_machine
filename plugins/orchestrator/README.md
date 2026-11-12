# orchestrator (Claude Code mod)

The host of `packages/orchestrator` inside Claude Code. Every decision is made by `orchestrator step` (run
through `cli.js`); this mod does only what needs Claude Code:

- `mcp__orchestrator__start { dir, issue }` starts (or, without `issue`, resumes) the item kept in `dir`.
- Each session the item waits on is started with `$.agent.spawn` as a hidden agent type
  (`orchestrator:build`, `:verify`, `:ask`) with exactly that actor's tools plus the return tool.
- `mcp__orchestrator__return { claim }` checks a session's claim (so the session can fix it) and keeps it;
  the claim is handed on when the session's turn completes. A session that ends without one fails its run.
- Timers are set with `$.clock.after`; steps run one at a time.
- `mcp__orchestrator__wait` blocks up to 50 s in a child process and says where the item is.

It is inert until `start` is called. It needs the repository's `packages/orchestrator` and its `node_modules`
beside it, so it is a dogfooding plugin, not yet one that installs on its own.
