---
name: documentation-downloader
argument-hint: "[url...] [--discover url] [--refresh days]"
description: >
  Download and cache external documentation (libraries, SDKs, APIs) as local markdown.
  Use this skill PROACTIVELY — whenever you're about to write code that uses an external
  library, SDK, API, or framework, check for cached docs and fetch them if missing.
  Don't guess at API usage or method signatures — get the docs first.
  Triggers:
  - Before writing ANY code that imports or uses an external package
  - Before creating plans involving unfamiliar or complex APIs
  - When confused about library behavior, method signatures, or best practices
  - When the project uses a specific library version that may differ from your training data
  - When researching implementation approaches for a library or SDK
  - When WebFetch fails or returns incomplete JavaScript-rendered content
  - When you discover useful documentation — cache it for future sessions
  - When existing cached docs may be outdated (use --refresh)
  Always check docs/llms.txt first for existing cached docs before fetching new ones.
  If docs are missing, discover and fetch them automatically.
context: fork
agent: Bash
model: sonnet
---

# Documentation Downloader

Downloads documentation pages, converts to GitHub-flavored markdown, and caches locally.
Handles JavaScript-rendered pages via Playwright.

## Important

You MUST use the scripts below. Do NOT use WebFetch, curl, or write your own fetching logic.
These scripts handle JavaScript rendering, raw markdown source discovery, caching, content
extraction, and index management — things that simpler approaches miss.

## Locating this skill — run this FIRST

This skill can be installed in three places, so its own directory is resolved at run time rather
than hardcoded. Every command below refers to it as `$DD_SKILL_DIR`.

```bash
DD_SKILL_DIR=$(for d in "${CLAUDE_PLUGIN_ROOT:-}" "${CLAUDE_PROJECT_DIR:-$PWD}/.claude/skills/documentation-downloader" "$HOME/.claude/skills/documentation-downloader"; do [ -n "$d" ] && [ -f "$d/scripts/fetch-docs.js" ] && { echo "$d"; break; }; done)
echo "${DD_SKILL_DIR:?documentation-downloader not found — is the skill installed?}"
```

Resolution order, first hit wins:

| # | Location | When it applies |
|---|----------|-----------------|
| 1 | `$CLAUDE_PLUGIN_ROOT` | installed as a plugin — Claude Code sets this itself; it is the only official variable for a component's own directory |
| 2 | `$CLAUDE_PROJECT_DIR/.claude/skills/documentation-downloader` | committed into a repo, so it reaches cloud/CI sessions |
| 3 | `~/.claude/skills/documentation-downloader` | personal install on one machine |

Each is probed for `scripts/fetch-docs.js`, so a stale empty directory can't win.

> **Each Bash call is a fresh shell.** `DD_SKILL_DIR` does **not** survive from one command to the
> next. Either substitute the resolved literal path into subsequent commands, or prefix the
> one-liner above to any command that needs it. Never hardcode `~/.claude/...` back into this
> file — that is exactly what breaks a project or plugin install.

## Setup — once per machine, before the first fetch

The skill ships source only; nothing is vendored. Run this once:

```bash
cd "$DD_SKILL_DIR" && npm run setup
```

That is two steps and **both** are required — `npm install` gets the packages (~28 MB), and
`npm run install-browsers` downloads the browser binary (~150 MB), which `npm install` does not
do on its own.

If you are unsure whether the skill is ready, ask it rather than inferring from a crash:

```bash
cd "$DD_SKILL_DIR" && npm run doctor
```

`doctor` checks the Node version, the packages, and the browser binary; it prints the exact
command for anything missing and exits non-zero when the skill is not ready. `fetch-docs.js`
prints the same setup command if you run it before installing — so a missing install is never a
raw stack trace.

`package.json` is at the **skill root**, not in `scripts/`.

## Scripts

All scripts live at `$DD_SKILL_DIR/scripts/`

| Script | Purpose | Needs setup? |
|--------|---------|--------------|
| `fetch-docs.js` | Fetch, discover, and cache documentation pages | yes |
| `search-docs.js` | Search cached docs (check what's available) | no |
| `compare-docs.js` | Validate llms.txt index against docs/ folder | no |
| `fix-descriptions.js` | Fix poor-quality descriptions in llms.txt | no |
| `doctor.js` | Check that the install is complete | no |

Only `fetch-docs.js` needs the npm packages. **Step 1 below always works**, even on a machine
where setup has never been run — so check the cache first and only install if you actually need
to fetch.

## Workflow

Always run from the project root.

### Step 1: Check what's cached

Search the local docs index to see what's already available:

```bash
node "$DD_SKILL_DIR"/scripts/search-docs.js "library-name"
```

Or list everything:

```bash
node "$DD_SKILL_DIR"/scripts/search-docs.js --list
```

Or search within doc content for specific methods/classes:

```bash
node "$DD_SKILL_DIR"/scripts/search-docs.js --content "createCustomer"
```

### Step 2: Discover and fetch documentation

If docs aren't cached, discover what's available from the library's website. Many sites publish llms.txt or sitemap.xml listing their documentation:

```bash
node "$DD_SKILL_DIR"/scripts/fetch-docs.js \
  --discover "https://docs.example.com" \
  --output-dir docs/ \
  --skip-existing \
  --update-index
```

Discovery order: `llms-full.txt` → `llms.txt` → sitemaps. Sitemaps are located via the
`Sitemap:` directive in `robots.txt` first, then the conventional paths (`/sitemap.xml`,
`/sitemap-index.xml`, `/sitemap_index.xml`, `/sitemap/sitemap.xml`). A **sitemap index** is
expanded into its child sitemaps rather than mistaken for a list of pages.

Large sites are capped at 50 URLs; the cap is reported explicitly, and raising it is
`--max-discover <n>`. On multilingual sites, English/unprefixed pages are ordered first so a
capped run doesn't return 50 pages of translations.

### Step 3: Fetch specific URLs

If discovery didn't find what you need, or you have specific URLs:

```bash
node "$DD_SKILL_DIR"/scripts/fetch-docs.js \
  "https://example.com/docs/intro" \
  "https://example.com/docs/api" \
  --output-dir docs/ \
  --skip-existing \
  --update-index
```

Always pass multiple URLs in one command (batch mode is faster).

### Step 4: Follow linked documentation

After fetching docs, read them. If they reference additional pages that would be useful
(e.g., "see the API reference at..."), fetch those too. Build comprehensive local
documentation for the libraries the user is working with.

### Step 5: Refresh stale docs

Re-fetch docs that haven't been updated recently:

```bash
node "$DD_SKILL_DIR"/scripts/fetch-docs.js \
  --refresh 30 \
  --output-dir docs/ \
  --update-index
```

### Step 6: Validate

```bash
node "$DD_SKILL_DIR"/scripts/compare-docs.js
```

## fetch-docs.js Flags

| Flag | Short | Description |
|------|-------|-------------|
| `--output <path>` | `-o` | Output file path (single URL only) |
| `--output-dir <dir>` | `-d` | Base directory for auto-generated paths |
| `--concurrency <n>` | `-c` | Parallel browser contexts, 1-10 (default: 3) |
| `--urls <file>` | `-u` | File with URLs (one per line) |
| `--selector <css>` | `-s` | Custom CSS selector for content |
| `--no-front-matter` | | Omit YAML front matter |
| `--skip-existing` | | Skip URLs whose output file already exists |
| `--update-index` | | Auto-append new entries to docs/llms.txt |
| `--discover <url>` | | Discover docs via llms.txt / sitemaps at the URL's origin |
| `--max-discover <n>` | | Cap on URLs returned by `--discover` (default: 50) |
| `--refresh <days>` | | Re-fetch cached docs older than N days (default: 30) |

## search-docs.js Flags

| Flag | Description |
|------|-------------|
| `--list` | List all cached docs with descriptions |
| `<query>` | Search file names and descriptions by keyword |
| `--content <query>` | Search within doc content (grep-like) |
| `--stale <days>` | Show docs older than N days |

## fix-descriptions.js Flags

| Flag | Description |
|------|-------------|
| (none) | Dry run — preview fixable entries without writing |
| `--apply` | Apply deterministic fixes and deduplicate |
| `--stats` | Show quality stats only |
| `--deduplicate` | Remove duplicate path entries (keeps best description) |
| `--export-remaining <file>` | Export unfixable entries with content previews for agent |
| `--import-fixes <file>` | Import agent-generated descriptions (TSV: `path\tdescription` per line) |
| `--llms-file <path>` | Index to operate on (default: `docs/llms.txt`) |
| `--help`, `-h` | Show usage |

## compare-docs.js Flags

| Flag | Description |
|------|-------------|
| `--docs-dir, -d <path>` | Directory containing docs (default: docs) |
| `--llms-file, -l <path>` | Path to llms.txt (default: docs/llms.txt) |
| `--fix-paths` | Normalize double-slash paths (`docs//` → `docs/`) in llms.txt |

### Fixing Descriptions Workflow

```bash
# Step 1: Fix what can be fixed deterministically
node "$DD_SKILL_DIR"/scripts/fix-descriptions.js --apply

# Step 2: If entries remain, export for agent-assisted generation
node "$DD_SKILL_DIR"/scripts/fix-descriptions.js \
  --export-remaining /tmp/needs-descriptions.md

# Step 3: Read /tmp/needs-descriptions.md. For each entry, write a search-optimized
# description following the quality guidelines. Write results to /tmp/fixes.tsv
# (one "path\tdescription" per line, tab-separated)

# Step 4: Import
node "$DD_SKILL_DIR"/scripts/fix-descriptions.js \
  --import-fixes /tmp/fixes.tsv
```

**Description quality guidelines** (for Step 3 — when you generate descriptions):
- Under 120 characters
- Start with the library/service name (e.g., "Temporal — ", "Pulumi AWS — ")
- Include searchable keywords: specific API methods, config options, concepts
- No marketing language, no "Learn how to..."
- Example: "Temporal TypeScript SDK — activity heartbeats, cancellation, async completion patterns"

## Rules

1. **Always batch.** Multiple URLs go in one command.
2. **Always use `--skip-existing`** to avoid re-fetching cached docs.
3. **Always use `--update-index`** to keep docs/llms.txt in sync.
4. **Always use `--output-dir docs/`** for consistent file paths.
5. Paths follow `docs/<domain>/<url-path>.md`.
6. **After bulk fetches**, run `fix-descriptions.js --stats` to check description quality.

## Notes on behaviour

- **Cached files keep one front-matter block.** When the upstream source is already markdown
  with its own YAML front matter, provenance keys (`Source`/`Generated`/`Updated`) are merged
  into that block rather than stacked on top of it — so the upstream `title:`/`description:`
  stay readable and feed the llms.txt index.
- **Fenced code blocks are never rewritten.** Prose cleanup (heading spacing, blank-line
  collapsing) is applied outside fences only.
- **`--update-index` is safe under parallel agents.** The index is rewritten under a lock file
  (`llms.txt.lock`) and replaced atomically, so concurrent fetches into one `docs/` tree do not
  lose entries or duplicate `## domain` headers.
- **`--refresh` preserves `Generated:`** and honours `--concurrency`.

## Development

```bash
cd "$DD_SKILL_DIR" && npm test
```

Tests are `node:test` files in `scripts/test/` and need no network. Each case corresponds to a
failure that was observed in real output — add one alongside any fix.

## Troubleshooting

- **`Cannot find package 'playwright'` / `'turndown'`**: setup has not been run. The script
  prints the command; it is `cd "$DD_SKILL_DIR" && npm run setup`.
- **Chromium not installed**: `cd "$DD_SKILL_DIR" && npm run install-browsers`
- **`--discover` finds nothing**: the site may publish no llms.txt and no sitemap at any
  conventional path. Fall back to passing page URLs directly (Step 3).
- **`DD_SKILL_DIR` is empty**: the resolver found no install. Check the three locations above; in a
  cloud session a personal `~/.claude/skills/` install does **not** carry over — the skill must be
  committed to the repo or installed as a plugin.
- **Content not captured**: Try `--selector "article"` or `--selector "main"`
- **Rate limited**: Reduce `--concurrency 1` and retry
