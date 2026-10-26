# documentation-downloader

A [Claude Code](https://claude.com/claude-code) skill that downloads external documentation,
converts it to GitHub-flavored markdown, and caches it in the project you are working in — so an
agent reads a library's real API surface instead of recalling it from training data.

It is a plain set of Node CLIs, so it also works from a terminal, a script, or any agent that can
run a shell command.

## Why not just fetch the page

Documentation sites are among the worst pages to scrape naively:

- Most modern doc sites render client-side, so an HTTP GET returns an empty shell.
- Many publish the **markdown source** of a page (`page.md`, `raw.githubusercontent.com`, …).
  Fetching that is faster and cleaner than converting the rendered HTML, but only if you find it
  *and* verify it is the same page.
- Naive HTML→markdown conversion drags in nav, sidebars, cookie banners, and "Edit this page"
  links, which then poison anything built on top of the text.

This skill handles all three, then keeps an `llms.txt` index so the next session knows what is
already cached and does not refetch it.

## Requirements

- Node.js 20 or newer
- ~180 MB of disk (28 MB of npm packages, ~150 MB for the browser binary)

## Install

Pick the location that matches how you want to use it.

**Per project** — committed to a repo, so it reaches teammates and cloud/CI sessions:

```bash
git clone https://github.com/suredesigntshirts/skill-documentation-downloader \
  .claude/skills/documentation-downloader
cd .claude/skills/documentation-downloader && npm run setup
```

**Personal** — available in every project on one machine:

```bash
git clone https://github.com/suredesigntshirts/skill-documentation-downloader \
  ~/.claude/skills/documentation-downloader
cd ~/.claude/skills/documentation-downloader && npm run setup
```

`npm run setup` runs two steps and **both are required**:

| Step | What it does |
|------|--------------|
| `npm install` | turndown + playwright (~28 MB) |
| `npm run install-browsers` | the browser binary (~150 MB) — `npm install` does **not** fetch it |

> A personal install in `~/.claude/skills/` does **not** travel to a Claude Code cloud session.
> For cloud or CI, commit the skill into the repo.

## Verify the install

```bash
npm run doctor
```

```
documentation-downloader — /path/to/skill

  ok    Node.js        v24.7.0 (need >= 20)
  ok    npm packages   playwright, turndown, turndown-plugin-gfm
  ok    Browser binary chromium 151.0.7922.34

Ready.
```

Every failing check prints the exact command that fixes it. Exit code is 0 when ready, 1 when not.

## Quick start

Run from the root of the project you want the docs cached into.

```bash
SKILL=~/.claude/skills/documentation-downloader

# 1. What is already cached?
node $SKILL/scripts/search-docs.js --list

# 2. Discover what a site publishes, and fetch it
node $SKILL/scripts/fetch-docs.js --discover "https://docs.example.com" \
  --output-dir docs/ --skip-existing --update-index

# 3. Or fetch specific pages (batch them — one process, one browser)
node $SKILL/scripts/fetch-docs.js \
  "https://docs.example.com/intro" "https://docs.example.com/api" \
  --output-dir docs/ --skip-existing --update-index
```

Results land as `docs/<domain>/<url-path>.md`, indexed in `docs/llms.txt`.

## For agents

If you are an LLM picking this up, the whole contract is:

1. **Check the cache first.** `node scripts/search-docs.js <query>` — no dependencies needed, so
   this works even before setup.
2. **If setup is missing, every command tells you so** and prints the command to run. You never
   have to infer it from a stack trace.
3. **Fetch in one batch**, always with `--output-dir docs/ --skip-existing --update-index`.
4. **Read the cached markdown** rather than refetching.

Every CLI supports `--help`. `SKILL.md` is the full instruction set, and is what Claude Code loads
automatically.

## Commands

| Script | Purpose |
|--------|---------|
| `scripts/fetch-docs.js` | Fetch, discover, and cache pages |
| `scripts/search-docs.js` | Search the cache by name, description, or content |
| `scripts/compare-docs.js` | Check `llms.txt` against what is on disk |
| `scripts/fix-descriptions.js` | Improve index description quality |
| `scripts/doctor.js` | Check the install |

`search-docs`, `compare-docs`, and `fix-descriptions` are pure Node and need no dependencies at
all. Only `fetch-docs` needs playwright and turndown.

## How the cache works

```
docs/
  llms.txt                  index: "- <path>: <description>", grouped by domain
  docs.example.com/
    intro.md                YAML front matter carries Source / Generated / Updated
    api.md
```

Each file keeps **one** front-matter block. When the upstream source is already markdown with its
own front matter, provenance keys are merged into it rather than stacked on top, so the upstream
`title:` and `description:` survive and feed the index.

`--update-index` is safe under parallel agents: the index is rewritten under a lock file and
replaced atomically, so concurrent fetches into one `docs/` tree cannot lose entries.

Refresh anything stale:

```bash
node scripts/fetch-docs.js --refresh 30 --output-dir docs/ --update-index
```

`--refresh` preserves the original `Generated:` date and only moves `Updated:`.

## Claude Code cloud sessions

Cloud sessions route traffic through an egress proxy that a default Chromium launch cannot use —
every navigation fails with `ERR_CONNECTION_RESET` while `curl` to the same URL succeeds. When
`CLAUDE_CODE_REMOTE=true`, the skill switches to system Chrome with a TLS 1.2 pin, which is the
combination that works. Nothing to configure; local runs are untouched.

Cloud sessions need system Chrome present, which `npm run install-browsers` installs.

## Development

```bash
npm test
```

49 `node:test` cases, no network access. Every case corresponds to a failure observed in real
output — add one alongside any fix.

## License

MIT — see [LICENSE](LICENSE).
