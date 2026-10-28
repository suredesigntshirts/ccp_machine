# @ccp/orchestrator: the walking skeleton

XState runs one work item from issue to merged commit, and every piece of work is an actor the machine
starts. This package exists to test that design end to end before anything is built on it. The design is in
the doc "Harness on XState: what we model and how"; this README is the theory of the code.

## Three rules

1. **The machine starts the work.** Each state that needs work invokes an actor. Its result comes back as
   the actor's own completion (`xstate.done.actor.<id>`) carrying a run id the host issued, so nothing has to
   be attested and a late result from a run the machine has left is refused.
2. **Context is the artifact contract.** Context holds handles (brief paths, the PR's branch and head
   commit, the verdict and its report, the merge commit) that one state produces and the next consumes.
3. **Guards are preconditions.** A state's `meta.needs` names what must hold to enter it. Every transition
   into the state checks them against the context as the transition leaves it, so no state is ever entered
   without what it needs. Trust comes from where an input comes from and a schema check at the boundary.

## The pieces

| File | Concept |
| --- | --- |
| `spec/item.machine.json` | The item, as plain XState JSON. The only place behaviour is written. |
| `src/spec.js` | The interpreter for the JSON's four conventions: paths, `set`/`inc`, named guards, `needs`. |
| `src/host.js` | The host as a pure value: the journal of outside inputs replays to the snapshot, the runs in flight and the timers set. `accept()` refuses what the machine would not take and turns XState's own actions into effects: `run`, `stop`, `timer`, `cancel`. |
| `src/driver.js` | Carries out effects, journals each input before acting on it, resumes from the journal. |
| `src/step.js` | The same driver as a one-input-per-process protocol, for a host that runs sessions itself. |
| `src/sandbox.js`, `git.js` | The actors, against a local git repository standing in for GitHub. |
| `src/claude.js` | Sessions as `claude -p` runs: the headless sessions port. |
| `../../plugins/orchestrator` | The Claude Code mod: sessions as subagents, claims through a return tool. |

An actor is **local** (a function the host runs: briefs, merges) or an **agent** (`{ claim, tools, prepare,
finish }`). An agent actor's `prepare` writes the session's job, a session returns a *claim* that matches the
claim schema, and `finish` turns the claim into the actor's output by reading facts itself: the builder's
commit and the verified commit come from git, never from what a session says. The spec's `meta.actors`
holds each actor's *output* schema (what states exchange); the claim schema belongs to the actor (how it
gets there), so swapping the executor never touches the machine.

## Two hosts, one machine

- **Headless**: `node bin/orchestrator.js demo [dir]` drives an item in-process; sessions are `claude -p`
  runs with exactly the job's tools and `--json-schema` for the claim.
- **Inside Claude Code**: the mod in `plugins/orchestrator` calls `orchestrator step` once per input and
  starts the sessions it is told to with `$.agent.spawn`, as hidden agent types with exactly the job's tools.

Both resume from the journal: a run in flight is started again under the same run id, and a timer is set
for what is left of it.

## Run it

```
npm test -w @ccp/orchestrator
node packages/orchestrator/bin/orchestrator.js demo            # about 45 s and a few cents of Haiku
claude -p "Start a work item with mcp__orchestrator__start (dir: /tmp/item, issue: {...}), then call \
  mcp__orchestrator__wait until done" --plugin-dir plugins/orchestrator --model haiku \
  --allowedTools mcp__orchestrator__start mcp__orchestrator__wait mcp__orchestrator__return
```

## What the end-to-end runs taught

- A verifier that may not run commands judged FAIL because it "did not observe" the tests. The host now runs
  the tests and hands the output over as evidence; the session judges, the host gathers facts.
- After a failed build the stand-in replanned blind: the error never reached context. Errors and timeouts
  now land in `context.failure`, which the replanning ask is given.
- `$.agent.spawn`'s `cwd` did not reach the subagent (Claude Code 2.1.312), so the mod names the folder in
  the prompt.
- In `claude -p`, a mod can start a subagent only while the main turn is live, and a hook has 10 s of its own
  time; a `$.process.run` does not count against it. Hence `wait`, which blocks in a child process.
- The old harness plugin's Bash hook prefixes every command, which breaks narrow `--allowedTools` patterns.
  So the builder edits and the host commits, and no session needs Bash.
