# Cost, cache, context and session records

What sessions cost, and where a session can read its own and other sessions' numbers.

## What drives cost

- Most spend is the big model re-reading context: every request re-reads the whole context from cache.
- **Threads write only 1-hour caches; subagents write only 5-minute ones.** A session cannot choose. In a
  transcript this shows as `usage.cache_creation.ephemeral_1h_input_tokens` (threads) versus
  `ephemeral_5m_input_tokens` (subagents).
- A turn more than an hour after the last is cold and rewrites the whole context, about 40 times the cost
  of a warm turn on Opus. Most turns come within 5 minutes of the last; turns 5 to 60 minutes apart stay
  warm only because of the 1-hour cache.
- Every thread `post_message` costs the coordinator a turn over its whole (large) context.
- A Haiku probe thread costs a fraction of a Sonnet build thread; a build plus a separate reviewer thread
  costs about twice the build.
- So keep big reading in subagents (a cheaper model, and only a summary comes back), end planned waits
  within about 50 minutes, and run probes on the smallest model that can do them.

## Context window

- Autocompact is set by the environment: `CLAUDE_CODE_AUTO_COMPACT_WINDOW=500000` and
  `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=80` give a threshold of about 384k tokens (80% of the window after a
  reserve for output), **even on a 1M-context model**. Past it, earlier conversation is summarised and its
  detail is lost.
- `get_session` (no id means this session) gives `ccr.external_metadata.context_usage.used_tokens` and
  `max_tokens` (500000). `used_tokens` can read 0 while a session works, so check it more than once.
- A thread cannot compact itself on request.

## Reading cost and usage

- `get_session` holds the session's cost under `ccr.external_metadata.usage` (`cost_usd` and token
  counts), its model fields (`configured_model`, `last_served_model`), `parent_session_id`, tags and
  `effort_level`.
- **The platform's `cost_usd` runs above the CLI's own total for identical token counts**: a few percent
  for a coordinator, and up to 50 to 85% for short worker threads.
- `list_events` on a session (`kinds` filter, for example `result` or `rate_limit_event`) is complete as
  far back as it is paged. The last page omits `has_more` rather than sending false, and an empty page is
  `{"ccr":{}}`. The `kinds` filter is applied after paging, so a filtered page can be empty while
  `has_more` is true; keep paging.
- A `result` event's `total_cost_usd` and `modelUsage` are the session's **cumulative** totals across
  process restarts, subagents included.
- **The person's usage limits**: `list_events` on your own session with `kinds: ["rate_limit_event"]`
  gives `unifiedWindows.seven_day` and `five_hour`, each `{utilization 0..1, resetsAt}`, matching what
  claude.ai shows the person. The 7-day window is fixed, not rolling.
- `list_sessions` is account-wide, not per project, and its `tags` filter may be unavailable.
- A thread can read **any** session's record and events in the account.

## Transcripts on disk

- A session's transcript is `~/.claude/projects/<cwd slug>/<session id>.jsonl`. Subagents' are under
  `<session id>/subagents/agent-<id>.jsonl` with a `.meta.json`; large tool outputs are under
  `<session id>/tool-results/`.
- One API call can appear as several `assistant` lines with the same `requestId`, each repeating the same
  usage, so count each `requestId` once.
- An auto-compaction **appends** to the transcript; the lines before `compact_boundary` are kept.
- A headless `claude -p` run inside a cloud session, without `--session-id`, writes into the **calling
  session's** transcript. Give it `--session-id <uuid>` to keep it apart. It has no MCP tools.
