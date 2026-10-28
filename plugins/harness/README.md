# harness plugin

This folder is the installable plugin. The setup script links it as it is
(`infra/cloud-environment/setup.sh`): nothing is copied by hand. It is not in the marketplace
(`.claude-plugin/marketplace.json`) yet: marketplace plugins on this account sync into every project.

**Mid-session updates.** Updates on its own: the code hooks run, because the Stop hook fast-forwards the clone they run from to origin/main (at most every 10 minutes, only when safe).
A clone still running pre-S1 code (plugin 0.4.x or older, before `refresh()` shipped) never pulls that code in by itself: it needs a single manual fast-forward (`git -C <clone> merge --ff-only origin/main` after a fetch) or a new container, and refreshes itself from then on.
Needs a new session: the hook list and the skills list, which load at session start (a session started before a hook shipped never runs it).
To see which you are on, read the ledger stamp `harness`: `commit`/`version` (code that ran), `behind` and `refreshed` (the clone), and `hooks` (`["settings"]` alone means no plugin hooks: restart).

- **Per-project gate** (`scripts/host.js`): a marketplace plugin loads into every project of the
  account, so every hook does nothing (exit 0, no output, no writes) unless the project has installed
  the harness: the marker `$HARNESS_LIBRARY_DIR/install.json` exists (default
  `/mnt/project-files/harness/install.json`, read once, capped at 1 s). `HARNESS_DISABLED=1` turns every
  hook off even where the marker exists. The marker path and the variable are defined only in `host.js`.
- **SessionStart hook** (`scripts/session-start.js`): prints one line into the transcript, such as
  `harness 0.2.0 commit <sha> from <plugin root>, behind: no`. The commit comes from git when the plugin
  sits in a checkout (the setup script's skills-dir link); a synced copy prints `unknown (no git)` and
  its version names the build. `behind` compares with origin/main by `git ls-remote` (2.5 s cap), else
  `unknown`. Without the marker it prints only `available but not installed`. It always exits 0 within
  about 4 s.
- **UserPromptSubmit hook** (`scripts/notice-behind.js`): so a long-running session learns that its
  harness is old. At most once per 30 minutes per session (state in `$TMPDIR/harness-updates/<session>.json`,
  `updatesPath` in `host.js`; the check time is saved before any network call) and within about 3 s, it
  compares a checkout with origin/main (`behind()`, as SessionStart does) and a synced copy with its
  sibling folders `<folder>~gN` (plugin.json version). When behind, it tells the model once per newer
  version through `additionalContext`: the running version, the newest, and what to do. A checkout is
  fast-forwarded (`git fetch origin main` + `git merge --ff-only`) only when its tracked files are clean
  and HEAD is a branch tracking origin/main or detached at an ancestor of it; otherwise, and for synced
  copies, it only reports. Each update or skip is logged as `{ from, to, at, action }` and filed by the
  Stop hook as `harness.updates`.
- **Stop hook** (`scripts/file-turns.js`): after every turn, re-reads the session transcript and writes
  its ledger to `$HARNESS_LIBRARY_DIR/ledger/sessions/<session>.json`. Each record carries
  `harness: { name, version, commit, root, hook, hooks, behind, refreshed, updates? }`: `hook` is the registration that wrote it
  (`plugin` from `hooks/hooks.json`, `settings` from the repo's `.claude/settings.json`, passed as the
  first argument) and `hooks` every registration seen for the session, so a session where both fire
  shows both. With no argument, `hook` is `settings` when `~/.claude/settings.json` registers
  file-turns.js as a Stop hook (the old setup.sh did, without the argument), else `unknown`; a
  session whose `hooks` lacks `plugin` started before the plugin hooks shipped. Before filing, the hook
  refreshes the clone it runs from (`refresh()` in `host.js`): at most once per 10 minutes per clone
  (state in `$TMPDIR/harness-refresh/`), and only when it is not a linked worktree, no rebase, merge, cherry-pick, revert or bisect is in
  progress (`rebase-merge`, `rebase-apply`, `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `BISECT_LOG` or
  `sequencer` in the git dir), HEAD is detached or
  on main, tracked files are clean, `git fetch` succeeds within 5 s and the update is a fast-forward
  (`git merge --ff-only`); it never resets or discards. Its git calls drop the `GIT_*` variables that
  would point them at another repository (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, ...), all of them
  together fit in 12 s (`REFRESH_BUDGET_MS`), and the fetch runs in its own process group, killed whole
  when it times out, so no ssh child outlives the hook. The stamp gains `refreshed` (`{ at, from, to }`,
  or `{ at, skipped }` with the reason) and `behind` (commits behind origin/main as of the last fetch,
  `null` when unknown). Filing is idempotent (one file per session, replaced atomically). It never fails the
  session. `ledger collect` merges the filed sessions into one ledger for the report.
- **Agent hooks** (`scripts/agent-actor.js`, PreToolUse on Bash and SubagentStart): a subagent shares its
  parent's `CLAUDE_CODE_SESSION_ID`, and only hook input carries its `agent_id` and `agent_type`. Before a
  Bash command that names `harness`, or before every Bash command when the hook's own environment has
  `HARNESS_ENFORCE=1`, from a subagent or the parent, PreToolUse records the call at
  `$HARNESS_LIBRARY_DIR/ledger/sessions/<session>/calls/<tool_use_id>.json` (`{ sessionId, toolUseId, at, kind,
  agentId, agentType, commandSha256, keySha256, enforced }`, `agentId` null for the parent) and returns
  `updatedInput` with `export HARNESS_CALL='<tool_use_id>:<key>' HARNESS_AGENT='<agent_id>:<agent_type>';
  readonly ...` ahead of the command (`HARNESS_AGENT` for a subagent only; no permission decision: the
  permission rules still apply). The key is fresh per call and the record keeps only its sha256. The harness
  CLI believes an actor only with that key and only when the record names it, so an id a command writes
  itself (another call's, the SubagentStart record's) is refused. A call recorded under `HARNESS_ENFORCE=1`
  marks its store enforced (`enforced.json` in the store, naming this Library), and from then on the store
  takes a write only from a recorded call, whatever the command sets or unsets (spec harness
  `meta.invariants` `hookSawCall`); to lift it, remove that file by hand. Other commands are left
  as they are; a command that sets, exports, clears or passes `HARNESS_AGENT` or `HARNESS_CALL` itself is
  denied with the reason (`setsHarnessAgent`), from either. SubagentStart writes `{ sessionId, agentId,
  agentType, at }` to `$HARNESS_LIBRARY_DIR/ledger/sessions/<session>/agents/<agent>.json`, which
  `harness verify-actors` checks, and binds the agent to the newest spawn of its agent type the spawn gate
  recorded for the session and the store took, when that spawn is unbound (`WORKER_STARTED`). Its input names
  the agent and its type but not the Agent call, so this is sound only because a session has at most one
  unbound spawn of a type at a time (`oneUnboundSpawn`, below). Only a bind the store takes is written on the
  spawn's call record; the result, taken or refused, is added to the agent's record as `bind`. A resumed agent
  (SendMessage to one that ran) fires SubagentStart again: its record keeps its first `at` and `bind`, the new
  start time is added to `resumes`, and nothing is bound. Without `HARNESS_ENFORCE=1` the marker is
  read only for a command that would be changed or denied, so other Bash calls pay nothing.
- **Gates** (`scripts/gates.js`, PreToolUse on Agent and `mcp__github__merge_pull_request`): the spec
  decides (spec workItem, Workers; harness `meta.invariants`), asked through the harness CLI
  (`$HARNESS_BIN`, else `packages/harness/bin/harness.js` of the checkout the plugin sits in, with the
  session's `HARNESS_DIR`). The **spawn gate** reads the brief's one line `Harness-Role: <role> item:<id>`;
  a spawn naming one is sent to the store as `WORKER_SPAWNED` (role, sha256 of the prompt, agent type, model,
  the agent definition by content hash and plugin version, the harness version), which the machine takes or
  refuses (no verifier brief yet, an edited verifier brief, a role or agent type the item does not take now).
  A malformed or repeated role line, an item not in the store, or a `harness:builder` or `harness:verifier`
  spawn without one is `roleLine`. A second spawn of an agent type while the session's last one of that type,
  on any item, still waits for its agent is refused and denied (`oneUnboundSpawn`): the reason names the
  waiting spawn; wait for its agent to start, or, if it never will, close it with
  `harness send '{"type":"SPAWN_CLOSED","toolUseId":"<id>"}' --to item:<id>`. A spawn left waiting lapses after
  the bind window (5 minutes). Hooks of one message run at once, so a CLI run that finds the store's lock held
  is run again. A spawn with no role line is allowed and recorded nowhere: its agent can
  send nothing, since an agent sends only what its role on the item allows (harness `meta.agentEvents`). The
  **merge gate** judges the GitHub MCP merge tool, the one route for a landing, and reads no Bash command: a
  command's text cannot say what bash will do, so any word may appear in one. A landing by another route is
  not blocked; `harness doctor` lists it afterwards (every PR landed on main since the store began without the
  verifier's PASS on its head). The MCP tool asks `harness merge-gate`: the PR bound to an item (`mergeBound`), the head pinned
  (`expectedHeadSha`: `pinnedHead`), the item's machine taking `MERGED` of
  that head, which needs its verifier's PASS (`machine`), and that PASS on GitHub as a review on the sha
  (`reviewOnHead`). Under `HARNESS_ENFORCE=1` both deny, the reason starting `harness (<rule>): `, and a gate
  that cannot reach the store or the CLI denies (`storeReachable`); without it they only record and never
  deny. Each gated call's record says what the gate decided (`allowed`, `denied` or `would deny`, the rule
  and why). A deny that names no guard or host invariant fails `packages/harness/test/rules.test.js`.
- **Standing agents** (`agents/builder.md`, `agents/verifier.md`, agent types `harness:builder` and
  `harness:verifier`): the rules that must not drift from brief to brief (machines first, concepts counted,
  only what the item needs, SPEC.md and the README kept true; for the verifier, distrust, blind attacks and
  hard limits, and `harness verdict`). The machine refuses a builder or verifier spawn of another agent type,
  and the spawn record names the definition by its sha256 and the plugin version.
- **Status line and `/harness` pane** (`hooks/status.tsx`, the harness-status mod, named under `modules`
  in `hooks/hooks.json`; its `$.state` contract is `types/index.d.ts`). A hooks module, so it loads with
  the plugin by the same route, `harness@skills-dir` included; there is no separate copy. Placeholder
  content only: it runs `scripts/status.js`, which answers host.js's gate and version (one Library read,
  the marker; no network), at session start and then at most once a minute. The status line reads
  `harness 0.3.0 commit <sha7> · installed`, or `harness 0.3.0: available, not installed` without the
  marker; `HARNESS_DISABLED=1` shows nothing. `/harness` (registered only when installed) opens a pane
  with the same facts. Every hook swallows its errors.
- **Load record**: when the module loads in an installed project, `status.js --record <session>` writes
  `$HARNESS_LIBRARY_DIR/status-mod/<session>.json`, one JSON object
  `{ session, event: "loaded", plugin, version, commit, root, at }`, replaced at each load or reload.
  No file for a session that ran the hooks (its ledger exists) means the module did not load there; the
  reason is in that session's debug log as `hooks module harness@skills-dir not loaded: <reason>`. A
  headless `claude -p` loads it the same way (verified), but has no status row to draw in.
- **Version**: `.claude-plugin/plugin.json`. CI fails a pull request that changes `plugins/harness`
  without raising it (`scripts/check-plugin-version.mjs`), so one version is one build.
- **`lib/ledger/`**: a copy of `packages/ledger/src` (no dependencies), so the plugin needs no
  `npm ci`. Do not edit it here: change `packages/ledger/src`, run `npm run build:plugin` from the repo
  root, and commit both. `npm test` and CI run `npm run build:plugin -- --check`, which fails when the
  copy differs from a fresh build. `npm run build:plugin -- --zip` also writes `dist/harness-plugin.zip`.
- **Orchestrator skill: parked.** It is not in this plugin, because its prose had drifted from the
  XState machines (Library `research/harness-root-cause-audit/README.md`, R4 and R6). Its last version
  and its lint test are in `suredesigntshirts/ccp_machine_test` (`plugins/harness/skills/orchestrator/`,
  `packages/harness/test/skill-lint.test.js` at commit `1244253`). It comes back only once it is derived
  from the machines in `packages/harness/spec/`; see the Library `notes/harness-reflection/plan.md`.
