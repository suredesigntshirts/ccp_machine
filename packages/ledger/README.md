# @ccp/ledger

Turn-level audit of Claude Code sessions: every turn of a session, its API requests (deduplicated),
tokens by kind, cost at list price, tools called, and the subagents it started, plus the person's
5-hour and 7-day usage windows and today's budget status. Zero dependencies, Node 22+.

## Use

```sh
node packages/ledger/bin/ledger.js build                 # every session under ~/.claude/projects
node packages/ledger/bin/ledger.js usage events.json     # add usage samples from saved list_events output
node packages/ledger/bin/ledger.js report --title "This week"   # .ledger/report.html
node packages/ledger/bin/ledger.js turns <session.jsonl>  # one line per turn
```

`report` writes a page body for Artifact publishing; add `--standalone` for a full HTML document.

## Where the data comes from

- **Transcripts** (`~/.claude/projects/<cwd>/<session>.jsonl`, subagents under `<session>/subagents/`):
  turns are split at each numbered prompt (`turnPosition.turnIndex`); requests are deduplicated by
  `requestId`; a subagent is attached to the turn whose tool call started it (`meta.json` `toolUseId`).
  Only sessions in this container are on disk.
- **Usage windows** exist only in `rate_limit_event`s, read with the claude-code-remote `list_events`
  tool and saved to a file. They are not on disk and no hook sees them.
- **Prices** are API list prices (`src/pricing.js`, read 2026-10-26); the platform's own cost figure differs.

## Budget rules

They follow `budget.machine.json` in `suredesigntshirts/ccp_machine` (`harness/spec/`): a daily slice of
the 7-day window (default 10%), wrap up at 80% of it, pause at 100% or when the 5-hour window reaches 95%.
Options: `--daily-share`, `--soft-at`, `--five-hour-stop`, `--utc-offset` (minutes; sets the day boundary).
