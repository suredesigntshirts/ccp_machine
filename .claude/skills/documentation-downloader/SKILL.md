---
name: documentation-downloader
argument-hint: "<question or library> [url...]"
description: >
  Answer questions about external libraries, SDKs, APIs and frameworks from their real
  documentation, cached word for word in the project (external-docs/). Use PROACTIVELY
  before writing code against any external package, when unsure of an API, method
  signature, config option or version difference, or when WebFetch returns incomplete
  JavaScript-rendered content. Pass the question (and any docs URL you know); the skill
  searches the cache, fetches missing pages, and returns exact file line ranges to read —
  never a paraphrase — so the main context only loads the lines that answer it.
context: fork
agent: Bash
model: sonnet
---

# Documentation Downloader

You are a throwaway subagent. The caller gave you a **question** (and maybe a library name or
docs URL). Your job: make sure the relevant documentation is cached, find the exact sections
that answer the question, check them, and reply with **line ranges** the caller will read
verbatim. Your own context is discarded afterwards — spend it freely; keep the reply small.

Never paraphrase or summarise documentation in the reply. The caller reads the original lines.

## Locate the skill — run this FIRST, and prefix it to every command

Each Bash call is a fresh shell, so define `docs` at the start of every command:

```bash
DD=$(for d in "${CLAUDE_PLUGIN_ROOT:-}" "${CLAUDE_PROJECT_DIR:-$PWD}/.claude/skills/documentation-downloader" "$HOME/.claude/skills/documentation-downloader"; do [ -n "$d" ] && [ -f "$d/scripts/docs.mjs" ] && { echo "$d"; break; }; done); docs() { node "$DD/scripts/docs.mjs" "$@"; }
```

(First hit wins: plugin install, then a project install under `.claude/skills/`, then a
personal install. Run commands from the project root: the cache is `external-docs/` there.)

If `docs fetch` says the skill is not installed: `cd "$DD" && npm run setup` (once per machine),
then `cd "$DD" && npm run doctor` to confirm.

## Workflow

### 1. Search what is cached (always first — works without setup)

```bash
docs search "<the question, or its key API names>"
```

Output, grouped by file, best first:

```
external-docs/code.claude.com/docs/en/hooks-guide.md — Automate actions with hooks
  550-571 (22 lines) How hooks work › Read input and return output › Hook output — …the following `PreToolUse` hook blocks a command:
```

- Exact identifiers work well (`onConflictDoUpdate`, `google.genai.types.GenerateContentConfig`);
  so do a few content words or a plain question.
- **No good hit? Rephrase and search again** (synonyms, the API name, the concept name). Narrow
  with `--domain <host>` when you know the site. `docs catalog` lists what is cached per site.
- A result in a `.parts/` folder is a slice of a very large page; that page's own file is the
  index of its parts.

### 2. Not cached → fetch it

```bash
docs lookup "<url>"                       # is this URL cached, and where?
docs fetch "<url>" ["<url2>" …]           # batch URLs in ONE command; cached URLs are skipped
docs fetch --discover "<docs-url>" --max-discover 40   # pages under that URL (same site + path prefix)
```

- Find docs URLs from what you know, the package's homepage/README, or `--discover` on the docs
  root. Discovery reads `llms.txt` links and sitemaps and never leaves the site or path prefix;
  it reports loudly when it caps.
- **Versions**: if the project pins a version (check `package-lock.json`, `pnpm-lock.yaml`,
  `uv.lock`, `poetry.lock`, `requirements*.txt`, `go.mod`, `Cargo.lock`…) and the site serves
  versioned URLs (`/v2/`, `/en/5.2/`, `/2026-10/`), fetch the matching version's URLs and pass
  `--version <v>` (and `--lib <package>`). If only the latest docs exist, fetch them and also
  the changelog/release notes covering the gap; say so in your reply.
- The fetcher prefers the site's own markdown for a page (`.md` variant or
  `Accept: text/markdown`) when it is complete and clean, otherwise converts the page's HTML:
  the server's HTML once the site's first pages have been checked against a browser render
  (much faster), else the rendered page. It refuses bot-checks, error pages and empty
  shells — report those. If a site's pages come out incomplete, re-fetch with
  `--force --browser always`.
- If a fetched page looks wrong (site navigation or footer text leaked in, content missing),
  re-fetch with `docs fetch "<url>" --force --llm-profiles haiku`: a model picks the page's
  content area once per site and saves it in `external-docs/_profiles/`.
- `docs fetch --refresh 30` re-fetches cached pages older than 30 days.

Then search again (step 1). The index updates itself after every fetch.

### 3. Check the ranges before returning them

Read each candidate range yourself (`sed -n '550,571p' <file>`). Get exact section boundaries
from `docs outline <file>` (every heading with its line range) — a range should start at its
section's heading and end where the section (or the part you need) ends. Keep only ranges
that actually answer the question; widen or add a range when the answer continues (e.g. the
parameter table two sections down); merge ranges that overlap or touch.

### 4. Reply

Return only this, and nothing from the docs themselves:

```
Answer is in (read these, verbatim — ~<total> lines):
- external-docs/<path>.md:<start>-<end> — <heading path> — <why it matters, ≤ 12 words>
- …
Also cached, if needed: <file> (<what it covers>)
Notes: <version mismatch / fetch failures / nothing found — only if relevant>
```

Aim for the smallest set of ranges that fully answers the question (typically 20–150 lines).

## Old `docs/` caches (v1 of this skill)

If the project has `docs/llms.txt` and no `external-docs/`, the cache is in the old layout.
Searching still works with `docs search "<q>" --root docs`. To move it:

```bash
docs migrate            # dry run: prints the plan
docs migrate --apply    # moves only pages this skill created (front matter Source:), splits large pages, builds the index
```

Only apply when the caller asked for it (it moves files in their repository); otherwise
mention it in your reply's Notes.

## Reference

| Command | Purpose |
|---|---|
| `docs search "<q>" [--domain d] [--limit n] [--json]` | ranked sections as `path:start-end` |
| `docs outline <file-or-url>` | a page's headings with line ranges |
| `docs lookup <url…>` | cached? which file? (exit 1 if not) |
| `docs catalog [--domain d]` | cached sites and page counts / one site's pages |
| `docs fetch <url…> [--discover u] [--refresh [days]] [--force] [--lib l] [--version v] [--browser auto\|always\|never] [--llm-profiles m]` | fetch into the cache |
| `docs reindex [--full]` | rebuild index, `catalog.md`, `_outline.md` files |
| `docs migrate [--apply]` | move a v1 `docs/` cache |
| `npm run doctor` (in the skill dir) | check the install |

Cache layout (`external-docs/`, safe to commit; `.cache/` inside it is gitignored
automatically):

```
external-docs/
  catalog.md                    generated: one line per site
  <host>/_outline.md            generated: one line per page — title: description
  <host>/<url-path>.md          one page, verbatim, front matter Source/Generated/Updated/
                                title/description/Via
  <host>/<page>.parts/*.md      slices of a page too large for one read (the page file is their index)
  _profiles/<host>.json         saved site profiles (content area selectors)
  .cache/                       search index, raw downloads — derived, gitignored
```

Each page's `description:` says what the page is for, taken from what the site published
(its llms.txt entry, the page's own front matter, its meta description, else its opening
sentence; `DescriptionFrom:` names which). Read `_outline.md` or grep descriptions to pick a
page without opening it. A description written by hand (no `DescriptionFrom:`) is never
replaced by a refresh.

Details and rationale: `DESIGN.md` in the skill directory; evals and results: `eval/README.md`.
