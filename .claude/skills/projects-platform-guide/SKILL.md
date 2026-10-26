---
name: projects-platform-guide
description: How Claude Projects work for the Claude sessions inside them, covering the coordinator, threads, wakes, cards, timers, Artifacts and their capabilities, Claude Docs, the shared Library folder, memory, cost and the cloud environment. Use it whenever you work as a session inside a Claude Project, before you design a workflow, start or message threads, build an Artifact page, plan a wait, or trust a tool description about who gets woken, what persists or what the person sees.
---

# Claude Projects: how the platform works

Facts about how a Claude Project behaves from the inside: the project chat and its coordinator, threads,
Artifacts, Claude Docs, the Library, memory and the cloud container. Where real behaviour differs from a
tool's own description, this guide says so. The platform changes fast, so when a fact decides something
important, check it once against your own tool list or `env` before you build on it.

## The rules that matter most

1. **Only `mcp__hearthbot__*` calls reach the person.** Plain assistant text goes nowhere. A Stop hook
   re-prompts a turn that ends without a terminal call, up to 3 times. The terminal set is in
   `CCR_REPLY_STOP_HOOK_TERMINAL_TOOLS`; it includes `post_message`, `no_reply_needed`, `react`,
   `edit_message`, `update_progress_checklist`, `request_decision`, `post_widget`,
   `message_coordinator` and `message_thread`. `set_thread_resolved`, `close_decision` and
   `rename_thread` are not terminal, so end the turn with a terminal call after them.
   → [threads-and-coordinator.md](references/threads-and-coordinator.md)
2. **Every thread `post_message` wakes the coordinator**, a full turn of its large context. Checklist
   updates, edits, reactions and cards wake nobody. Keep progress on the checklist; reply only with
   results, blockers and questions. → [wakes-and-scheduling.md](references/wakes-and-scheduling.md)
3. **Subagents inherit every hearthbot tool**, `post_message` and `message_coordinator` included, but
   by default cannot start subagents of their own (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1`; only a
   setup script that writes `~/.claude/settings.json` can raise it). Put "do not call any
   mcp__hearthbot__ tool" in every subagent prompt. → [threads-and-coordinator.md](references/threads-and-coordinator.md)
4. **Only the coordinator can start a thread.** A thread can message another thread directly
   (`message_thread`). `message_thread` and `message_coordinator` share hourly caps: 20 messages per
   hour from one thread, 60 per hour across a project's threads. Plan fan-out to fit.
   → [threads-and-coordinator.md](references/threads-and-coordinator.md)
5. **What wakes a session:** the person's message, a decision-card tap, a "Send to Claude" comment on an
   Artifact the session watches, events on a subscribed PR, answers to connector, skill and device
   cards, `message_thread` / `message_coordinator` (even to a resolved thread), `send_later` reminders
   and scheduled triggers. **Nothing else.** Artifact database writes, plain comments, Doc comments and
   Library files are pulls. → [wakes-and-scheduling.md](references/wakes-and-scheduling.md)
6. **Timers fire late**: 1 to 4 minutes for `send_later`, 1 to 2 minutes for one-shot triggers. Don't use
   `send_later` for waits under about 5 minutes. A notification that arrives mid-turn waits until you
   call `ReadNotifications` or the next turn starts.
   → [wakes-and-scheduling.md](references/wakes-and-scheduling.md)
7. **An Artifact's `capabilities` replaces the stored set.** A republish that changes one capability's
   config silently drops all the others. Republish with no `capabilities` field to keep them, or send
   the whole set. → [artifacts-publishing.md](references/artifacts-publishing.md)
8. **Read an Artifact before you publish over it.** A publish with `url` to an artifact the session never
   read can be accepted and overwrite it, although the tool text says it is refused.
   → [artifacts-publishing.md](references/artifacts-publishing.md)
9. **A session holds at most 10 Artifact watches.** After ten, publishes report `NOT subscribed ...
   trigger_limit` and get no wakes. → [artifacts-publishing.md](references/artifacts-publishing.md)
10. **A Claude Doc comment does not reach the thread that made the Doc.** A plain comment wakes nobody;
    a "Send to Claude" comment is answered by a separate doc-scoped responder. Use a decision card or a
    message when you need the person's answer. → [claude-docs.md](references/claude-docs.md)
11. **The Library (`/mnt/project-files`) is a network mount, separate in each session.** Another session
    sees a write after up to about 40 s, and locks do not hold across sessions. A file reaches the
    person only when a reply attaches it. → [library-and-memory.md](references/library-and-memory.md)
12. **Threads act on GitHub as the person's own account**, so nothing on GitHub tells a thread from the
    person. For a sign-off, use a `request_decision` card: a tap records who tapped.
    → [environment-and-github.md](references/environment-and-github.md)
13. **A repository's own `.claude/` skills, hooks and settings do not load in cloud threads.** Ship
    them as a plugin enabled in Project settings, or have the environment's setup script link the skills
    into `~/.claude/skills/` and merge settings into `~/.claude/settings.json`.
    → [environment-and-github.md](references/environment-and-github.md)

## Which file to read

| Before you | Read |
|---|---|
| plan roles, start or brief threads, message between sessions, end a turn, or resolve | [threads-and-coordinator.md](references/threads-and-coordinator.md) |
| wait for anything, set a timer or trigger, follow a PR, or estimate a wake's cost | [wakes-and-scheduling.md](references/wakes-and-scheduling.md) |
| ask the person for anything, or pick a card, widget, checklist or notification | [person-surfaces.md](references/person-surfaces.md) |
| publish, republish, watch, list or pin an Artifact, or start one from a type | [artifacts-publishing.md](references/artifacts-publishing.md) |
| write page code that uses `db`, `comments`, `user`, `files`, `sample`, `mcp`, `room`, `assets` or `downloads`, or use `ArtifactData` | [artifacts-runtime.md](references/artifacts-runtime.md) |
| create, edit, comment on or export a Claude Doc | [claude-docs.md](references/claude-docs.md) |
| write shared files, file things into Library folders, or use project memory | [library-and-memory.md](references/library-and-memory.md) |
| read costs, cache behaviour, context limits, session records or transcripts | [cost-and-sessions.md](references/cost-and-sessions.md) |
| load plugins or skills, rely on setup scripts or hooks, use GitHub, or meet the auto-mode classifier | [environment-and-github.md](references/environment-and-github.md) |
