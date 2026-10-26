# documentation-downloader

A [Claude Code](https://claude.com/claude-code) skill that caches external documentation **word
for word** as markdown inside the project you are working in, and answers questions from it
with **exact line ranges** — so an agent reads a library's real API surface, and only the part
it needs, instead of recalling it from training data.

It is a plain Node CLI (`scripts/docs.mjs`), so it also works from a terminal or any agent that
can run a shell command.

## What it does

```
question ─► docs search ─► hits? ──yes──► check ranges ─► reply: path:start-end (verbatim lines)
                              │
                              no ─► docs fetch <url> / --discover ─► search again
```

- **Fetch**: prefers the site's own markdown for the page (`<url>.md` or `Accept:
  text/markdown`) when it is complete and clean — many CDNs now auto-generate markdown that
  still carries the site's navigation, and that is detected and rejected; otherwise converts
  the page's HTML — the server's HTML without a browser once a site's first pages have been
  shown to convert the same as a Playwright render, else the render — picks the content area generically (landmarks, statistics, what
  repeats across the site's pages; optionally a model-derived site profile), and converts it.
  Bot-checks, error pages, empty JS shells and redirect stubs are never cached.
- **Markdown**: GitHub-flavoured; code blocks byte-exact (line-per-element editors rebuilt,
  gutters/copy buttons dropped); every tab panel kept and labelled; `<details>` expanded;
  callouts → GitHub alerts; simple tables → GFM, complex ones → minimal HTML; API entries
  (`dl > dt[id]`) → headings; absolute links; no `data:` URIs.
- **Large pages** (over ~25k tokens) become an index at the page's own path plus verbatim parts
  in `<page>.parts/`.
- **Search**: a section-level index (SQLite FTS5 via `node:sqlite`, pure-JS fallback on older
  Node) with identifier-aware tokenisation and a reranker; results are line ranges with the
  heading path.
- **Concurrency**: many agents can fetch into one cache at once — per-URL/per-domain locks,
  atomic writes, SQLite WAL, machine-wide caps on browsers and per-host request rate.

## Results

Measured by the eval suite in `eval/` (see [eval/README.md](eval/README.md)). Composite of content
kept, template removed, exact code blocks, headings, and markdown validity (0–100):

| | tuning pages (dev, 44) | held-out sites (test, 14) | **blind set** (25, unseen sites, independent gold) |
|---|---|---|---|
| a real v1 cache (harempants.com) | 66.5 | 83.0 | (3 of 25 pages cached) |
| v1 pipeline on the same pages | 76.2 | 87.4 | 84.5 |
| **v2** | **98.5** | **99.6** | **96.9** |

Blind set, by part — v1 → v2: exact code blocks 48 → 96, markdown validity 78 → 100, content
kept 97 → 99, template removed 92 → 94.

Search over a real 526-page cache (195 questions; answer's section in the top 5): v1
`search-docs` 3% (whole files), grep 41% (whole files, ~30k tokens each), **v2 93% dev / 82%
test** (line ranges, ~750 tokens to read the first hit). The top-level catalog is ~900 tokens
where the v1 `llms.txt` index was ~18k.

Speed, live from this cloud environment (`eval/bench/`, every change in
[eval/results/SPEED_LOG.md](eval/results/SPEED_LOG.md); kept only with identical output):

| | v1 | v2 `--browser always` | **v2 default (`auto`)** |
|---|---|---|---|
| 59 pages, 8 sites (8 per site) | 46–49 s | 54–58 s (was 143 s) | **45–47 s** |
| 90 pages, 3 sites (a `--discover` crawl) | 59 s | 61 s | **34 s** |

A single-page `docs fetch`: owner markdown ~0.8 s (was 1.6 s), an already cached URL ~0.2 s (was
0.9 s). The live gold-scored run of the 58 tuning/test pages: composite 96.9 in 131 s (285 s before).
v1 renders every page too, but converts it at 76–87 instead of 97–99.

## Requirements

- Node.js 20+ (22.13+ for the SQLite search index; older Node uses the JSON fallback)
- ~180 MB of disk (npm packages + a Chromium build)

## Install

**Per project** — committed to a repo, so it reaches teammates and cloud/CI sessions:

```bash
git clone https://github.com/suredesigntshirts/skill-documentation-downloader \
  .claude/skills/documentation-downloader
cd .claude/skills/documentation-downloader && npm run setup
```

**Personal** — every project on one machine: clone into `~/.claude/skills/documentation-downloader`
instead. (A personal install does not travel to a Claude Code cloud session.)

`npm run setup` = `npm install` + `npm run install-browsers` (Chromium). Check with
`npm run doctor`: it reports the browser it will use, the search backend, whether the `claude`
CLI is available for site profiles, and whether an old cache needs migrating.

## Commands

Run from the root of the project whose cache you are using (`SKILL=<skill dir>`):

```bash
node $SKILL/scripts/docs.mjs search "useEdgesState initial edges"     # ranked line ranges
node $SKILL/scripts/docs.mjs fetch https://reactflow.dev/api-reference/hooks/use-edges-state
node $SKILL/scripts/docs.mjs fetch --discover https://vite.dev/guide/ --max-discover 40
node $SKILL/scripts/docs.mjs outline external-docs/vite.dev/guide/features.md
node $SKILL/scripts/docs.mjs lookup https://vite.dev/guide/assets
node $SKILL/scripts/docs.mjs catalog
node $SKILL/scripts/docs.mjs fetch --refresh 30        # re-fetch pages older than 30 days
node $SKILL/scripts/docs.mjs reindex                   # rebuild index + generated files
node $SKILL/scripts/docs.mjs migrate [--apply]         # move a v1 docs/ cache
```

Every command has `--help`. `scripts/fetch-docs.js` and `scripts/search-docs.js` still accept the
v1 flags.

## The cache

```
external-docs/                  (default; --root or DD_DOCS_ROOT to change)
  .docs-cache.json              marker + schema version
  catalog.md                    generated: one line per site
  <host>/_outline.md            generated: one line per page
  <host>/<url-path>.md          one page, verbatim; front matter Source / Generated / Updated / Via
  <host>/<page>.parts/*.md      slices of a page too large for one read
  _profiles/<host>.json         site profiles (content-area selectors)
  .cache/                       search index + raw downloads (gitignored automatically)
```

The markdown files are the source of truth; everything generated or under `.cache/` is rebuilt
by `docs reindex`. The folder is not hidden on purpose: ripgrep (and so Claude's Grep/Glob)
skips hidden and gitignored paths.

### Moving a v1 `docs/` cache

`docs migrate` (dry run) then `docs migrate --apply`. Only pages this skill created (front matter
`Source:`) move; URL-shaped paths are kept, older layouts are re-derived from `Source:`; good
v1 `llms.txt` descriptions are carried into page front matter; stacked front matter is merged;
bot-check/error pages are flagged; other files are listed and left alone. Copy → verify →
remove, safe to interrupt and re-run. On a real 526-file cache: 506 pages moved, 36 large pages
split, index built, in ~10 s.

## Development

```bash
npm test                          # unit + integration tests, no network
node eval/run.mjs --variant v2 --split dev            # conversion eval (needs recorded snapshots)
node eval/search/run.mjs                              # search eval
```

`eval/record.mjs` records the corpus snapshots (gitignored) from the live sites; gold
annotations, results and experiment logs are committed. `DESIGN.md` is the design and the
reasoning behind it.

## License

MIT — see [LICENSE](LICENSE).
