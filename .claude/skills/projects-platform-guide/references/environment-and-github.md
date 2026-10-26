# Environment, plugins, the classifier and GitHub

The cloud container behind each session, what loads into it, and what GitHub allows from it.

## The container and setup script

- Each thread runs in its own cloud container with a fresh clone of the project's repositories. The person sets up the environment (setup script, network, environment variables) in Project settings, and **only the person can edit it**.
- The setup script runs when a container is built, after the clone and before Claude Code starts. **The environment then caches that container**: later sessions start from the cached image without rerunning the script, while the repository clone is still fresh. So anything the script installs is frozen at the last cache build. Editing the script rebuilds the cache.
- The setup script sees the container **before** the Library mount and the branch checkout exist.
- A resumed thread gets a new container (uptime 0, every Library file cold), and its SessionStart hooks run again.

## Plugins, skills and hooks

- A cloud workspace is **untrusted**, so the repository's own `.claude/` hooks, skills, `permissions.allow`, `extraKnownMarketplaces` and `enabledPlugins` **do not load** in threads.
- What does load: a plugin added on claude.ai (Customize > Plugins > Add marketplace with the GitHub `owner/repo`, then add the plugin) and turned on in **Project settings > Plugins**. It loads as `<name>@synced`, with its skills and its SessionStart, UserPromptSubmit and PreToolUse hooks all firing, and it reaches already-running threads at their next resume. It loads for the coordinator too.
- A plugin folder (or a symlink to one) at `~/.claude/skills/<name>`, made by the setup script, loads as `<name>@skills-dir`. A coordinator does **not** run the hooks of a plugin loaded this way.
- The same route works for plain skills and settings: a setup script that symlinks the repository's `.claude/skills/*` into `~/.claude/skills/` and merges the repository's `.claude/settings.json` into `~/.claude/settings.json` makes them load in every new thread. Link rather than copy, because the clone is fresh each session while the container image is cached. An environment variable set in Project settings does not override the platform's own launch values (such as the subagent spawn depth).
- claude.ai refuses to install a plugin that has a top-level `bin/` directory, and `claude plugin validate` does not flag it.
- A synced plugin update arrives 3 to 10 minutes after its release, as a **second folder** beside the old one. A running session keeps the copy it started with, so threads started at different times can run different versions at once. Ship plugin changes in fewer, larger releases.
- A SessionStart hook that runs past its `timeout` is cancelled, **all its output is dropped**, and the first turn waits the whole timeout. Keep SessionStart hooks fast and away from the Library mount.
- A running session keeps the hook commands it started with. If a hook's script moves, its hooks fail for the rest of the session.
- A plugin PreToolUse hook fires on MCP tools (for example `mcp__hearthbot__post_message`) in a real thread.
- The platform's own hooks in `~/.claude/` (reply gate, checklist nudge, prompt reminder, git check) are described in threads-and-coordinator.md.
- A headless `claude -p` inside a thread has **no MCP tools** (no hearthbot, Docs or GitHub), so it cannot post.

## The auto-mode classifier

- The classifier can refuse edits and commits under `.claude/` as "Self-Modification". The owner's authorization in words, in the thread or relayed, does not lift it; allow rules the owner commits to the repository settings do.
- The same command can be refused in one session and allowed in another.
- Reading mount configuration or environment variables can be refused as "Credential Exploration".
- In a scheduled run, Artifact asset uploads of files from `/tmp` can be refused as "Data Exfiltration".
- When a command is refused, don't retry it and don't work around it. Save the intended change as a file and ask the person to apply it or to grant it.

## GitHub from a session

- A thread acts on GitHub **as the person's account**: `get_me` returns the owner, PRs are authored by the owner, and requesting the owner's review is refused ("cannot be requested from pull request author"). Commits are authored `Claude <noreply@anthropic.com>` but pushed with the owner's access. **No gate can rest on GitHub identity**.
- The thread's system prompt pins its work branch (`claude/project-thread-…`). The prompt, not git, stops pushes to other branches.
- PR events on a subscribed PR arrive fast: reviews and review comments 1 to 2 s after submit, a red check 21 s after the push, a green check suite 8 to 25 s after, close 2 s. Commit statuses, draft toggles and bot comments wake too. The session's own conversation comment, labels and milestones produce no event.
- `gh auth status` can say the token is invalid while `gh api` works (a proxy injects a token). Paths under `repos/{owner}/{repo}/` answer; other paths (`search/`, `users/`, GraphQL) are refused in some sessions and answer in others. `gh api --paginate` breaks after page 1, so page with `?page=N`.
- The proxy refuses repository settings writes, status and check-run writes, releases, ref and tag deletes, and the hooks, secrets and pages APIs. A workflow's `GITHUB_TOKEN` can do these, and sessions can start one with `workflow_dispatch`.
- MCP `search_issues` and `search_code` can return nothing for terms that exist in a private repository. List by page, or search the clone with `git grep`.
- On GitHub Free: branch protection, rulesets and auto-merge are unavailable (403 or 422). Actions on a private repo get 2,000 minutes a month, and each job rounds up to a whole minute. With minutes exhausted, every job fails in about 3 s with a spending-limit annotation.
