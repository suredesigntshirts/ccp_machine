# Wakes, timers and waiting

A session costs money each time it wakes, and does nothing between wakes. This file covers what wakes
whom, how late timers fire, and how to wait cheaply.

## What wakes a session

| Event | Who wakes |
|---|---|
| The person writes in a thread | That thread, at once (`wake reason="mention"`) |
| The person writes in the project chat | The coordinator |
| A thread's `post_message` | **The coordinator**, a full turn of its context |
| `update_progress_checklist`, `edit_message`, `react`, cards, listings and reads | Nobody |
| `message_thread` / `message_coordinator` | The target, even a resolved thread (it acts in 1 to 2 min) |
| The person taps an option on a `request_decision` card | The thread that posted it, with the choice |
| `close_decision` (the thread closes its own card) | Nobody |
| The person answers `connect_device`, `start_remote_control` or `suggest_connectors` | The thread, with the outcome |
| `propose_skills` | The proposing thread, **at once**, with `outcome=shown` |
| A comment sent to Claude on an Artifact (the shell's Send to Claude, or page `comments.sendToClaude`) | Every session watching that Artifact, about 1 s later (artifacts-runtime.md) |
| An Artifact republished elsewhere | Sessions watching it |
| A plain comment on an Artifact, a page's database write, `room` events, `sample` | **Nobody** |
| A comment on a Claude Doc | **Not the thread that made it** (claude-docs.md) |
| The person's emoji reaction, a press on a widget button | Not a reliable wake; never use one as a sign-off |
| Subscribed PR events | The subscribed session (environment-and-github.md) |

## Timers and triggers

- `send_later` (a one-shot reminder into this session) lands 1 to 4 minutes late; the scheduler polls
  each minute. Don't use it for waits under about 5 minutes.
- A one-shot `create_trigger` with `run_once_at` fires 1 to 2 minutes after its time.
- `fire_trigger` records `fired_at` about 8 s after the call, and the turn arrives about 18 s after it.
- `fire_trigger`'s extra `text` is **dropped** when the trigger fires into the calling session. It reaches
  only other sessions.
- `fire_trigger` on a one-shot task whose time has passed but which has not fired yet starts a **second**
  run, and both run.
- A scheduled task with a fresh session per fire runs as a **new thread** of the project, on the
  project's default model unless the task names one, with the coordinator as its parent.
- In-session `CronCreate` fires only while the session is idle, and dies with the container.
- `list_triggers`, `list_sessions`, `list_repos` and `list_environments` are **account-wide**.
  `list_triggers` marks project-made tasks with `created_surface: ROUTINE_CREATED_SURFACE_HEARTH` and
  `hearth_channel_id`, so filter to your own project.
- `delete_trigger` on another project's task returns "not found", although `list_triggers` lists it.
- Deleting a trigger also deletes the sessions it started. A trigger-started session should disable its
  trigger (`enabled: false`) instead.
- One-shot reminders stay in the person's **Scheduled** list after firing (`ended_reason:
  run_once_fired`) and clutter it. Delete only reminders your own session created, and others' only with
  the person's go.
- A thread cannot compact itself: a "/compact" sent in by a trigger arrives as plain text.

## Waiting without polling

- A notification that arrives mid-turn (a trigger, a PR event, a Monitor line, an Artifact comment) sits
  in a queue that only `ReadNotifications` or the next turn consumes. Drain it when a notice says
  notifications are pending, and again before going idle.
- `Monitor` turns each stdout line of a background script into a notification (batched within 200 ms). A
  background Bash command gives one notification when it exits. **One background wait gives one wake for
  a whole set of threads**: a script that waits for several threads' Library files ends seconds after
  the last one lands, with no messages.
- `subscribe_pr_activity` turns PR events into wakes with no polling.
- `watch_url` creates an inbound webhook URL; a POST to it wakes the session with a `<webhook-payload>`.

## What a wake costs

- Every request re-reads the whole context. A thread's prompt cache lives **1 hour** (threads write only
  1-hour caches, subagents only 5-minute ones). A wake within the hour is warm; one after it rewrites the
  whole context (commonly 60k to 400k tokens), 40 times the cost of a warm wake on Opus 5.5 or Sonnet 5.5 (prices in
  cost-and-sessions.md).
- A fresh thread's first call reads about 37k tokens of shared system prompt from cache and writes about
  as much.
- So end a planned wait within about 50 minutes, and keep long reading in subagents.
