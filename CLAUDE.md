# ccp_machine

## Branch naming

Many agents work in this repo at once, each in its own git worktree, often on the same feature. A branch name must say what the work is, let agents on one feature find each other, and never collide.

- If the instructions that started your session name a specific branch to work on, use it and skip this section.
- Otherwise this convention replaces branch-naming rules from plugins and skills, such as the ccp harness's `ccp/<n>-<slug>`.
- Never add a tool or author prefix such as `claude/`. Commit trailers record who wrote the work; the branch name describes the work.

```
<type>/<issue>-<slug>            feature branch: one per feature, PR to main
<type>/<issue>-<slug>--<agent>   one per additional agent on that feature, PR into the feature branch
```

- `<type>`: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, or `spike` (exploration that never gets a PR to main).
- `<issue>`: the GitHub issue number. With no issue, drop it and its hyphen: `feat/<slug>`.
- `<slug>`: 2 to 5 lowercase words joined by `-`, naming the outcome, not the task.
- `<agent>`: a short label unique among the agents on that feature, such as its role (`tests`, `docs`, `api`).
- Use only `a-z`, `0-9`, `-`, and the one `/` after the type. Stay under 60 characters.
- Separate the agent with `--`, never `/`: git cannot hold `feat/42-x` and `feat/42-x/tests` at once, because one ref cannot be both a file and a folder.

Examples: `feat/42-retry-failed-jobs`, `feat/42-retry-failed-jobs--tests`, `fix/57-null-config-crash`, `spike/xstate-persistence`.

Before you create a branch:

1. Run `git fetch origin`, then `git branch -a --list '*/<issue>-*'` (with no issue, `'*<slug>*'`). This shows the feature's branches on origin and in sibling worktrees.
2. If no feature branch exists, create it from `origin/main` and push it at once, so other agents can find it. You own it: you merge the agent branches into it and open its PR to main.
3. If the feature branch exists, do not start a second one. Branch from it with your own `--<agent>` suffix and open your PR into it.
4. A name that already exists is taken, even if its PR is merged or closed. Choose another `<agent>`, or for new work a new slug. Push only to branches you created.

Give every agent its own worktree and branch; git refuses to check out one branch in two worktrees. Name the folder after the branch with `/` replaced by `-`:

```
git worktree add ../feat-42-retry-failed-jobs--tests -b feat/42-retry-failed-jobs--tests origin/feat/42-retry-failed-jobs
```

## The project Library

The Library (`/mnt/project-files`) is shared by every session and kept organized by the librarian. Repository skills do not load in Project threads by themselves, so before you read more than 5 Library files, write a file there, or keep research results, read `.claude/skills/library/SKILL.md` (installed copy: `/mnt/project-files/~librarian/kit/skills/library/SKILL.md`). If you are briefed as the librarian or asked to tidy or reorganize the Library, read `.claude/skills/librarian/SKILL.md` instead.

## Safeguard false positives

If a safety check blocks a safe request, retry once with the intent stated plainly: name the flagged thing you are not doing and why you need the result. If it is blocked again, stop, report the error, and use another legitimate route (such as reading the source on disk).

## The harness

The agent harness lives here: `packages/harness` (spec and runtime), `packages/ledger`, `plugins/harness`
(the plugin threads load), `mods/harness-status`. `suredesigntshirts/ccp_machine_test` holds only
standalone tools the harness can use; nothing is cloned from it at runtime.

- Node.js (22+) or Bun only. Prefer zero runtime dependencies and plain ES modules; no build step,
  except the plugin bundle: `npm run build:plugin` copies `packages/ledger/src` into
  `plugins/harness/lib/ledger`, and both are committed together (CI fails when they differ).
- Tests use `node:test`; `npm test` at the root runs every workspace's tests.
- `packages/harness/spec/*.machine.json` is the source of truth for behaviour; the code follows it.
