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
