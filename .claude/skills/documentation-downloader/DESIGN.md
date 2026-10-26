# documentation-downloader v2 — design

This is the agreed design for the v2 rebuild. It is the brief for anyone (human or agent)
working on the skill. Decisions here were made deliberately; change them only with a
measured reason (see [Evals](#evals)).

## Purpose

Cache external documentation **word for word** as markdown in the project, so a coding agent
reads the real API surface instead of recalling it. The cache is keyed by URL: an agent that
meets a docs URL asks "is this cached?" and fetches it if not.

Two costs matter, in this order:

1. **Correctness** — the stored markdown says exactly what the page says, nothing more (no
   nav/sidebars/footers/banners), nothing less (no dropped tabs, tables, code).
2. **The main agent's context** — the main agent should read only the lines that answer its
   question. Fetching, searching and verifying happen in a throwaway subagent (the skill runs
   `context: fork` on Sonnet), which returns `path:start-end` line ranges, never paraphrase.

## Non-goals

- Summarising documentation. Content is stored verbatim; only *reading* is narrowed.
- Per-site hardcoded rules. Mechanisms must be generic: web standards (HTML semantics, ARIA),
  statistics (what repeats across a site's pages is template, not content), documentation
  generator families (identified by the page itself, e.g. `<meta name="generator">`), and an
  LLM when those fail. A rule is accepted only if it improves eval scores across sites.
- An MCP server (may come later as a thin wrapper over the CLI).
- Using `llms-full.txt` as content. `llms.txt` is fine for *discovering* URLs.

## Cache layout

Default root: **`external-docs/`** (overridable: `--root`, or `DD_DOCS_ROOT`). Paths come from
the **final** URL after redirects; `Source:` records the URL that was requested (and `Final:`
when they differ), so a refresh re-follows the redirect and lookups work by either URL. Not hidden —
ripgrep, and therefore Claude's Grep/Glob, skip dot-directories and gitignored paths.

```
external-docs/
  .docs-cache.json              marker: schema version, settings (committed)
  catalog.md                    GENERATED — one line per domain/library (small, always)
  <domain>/                     URL-shaped paths, `www.` stripped
    _outline.md                 GENERATED — pages in this domain, one line each
    <url-path>.md               one page, verbatim markdown
    <big-page>.md               a page too large for one Read: an index of its parts
    <big-page>.parts/<slug>.md  verbatim slices of it, split on its own headings
                                (`.parts`, not `<big-page>/`, which may hold child pages)
  _profiles/<host>.json         site extraction profiles (committed; small)
  .cache/                       GITIGNORED — derived or re-downloadable
    index.sqlite                search index (rebuildable from the markdown)
    index.json                  fallback index when node:sqlite is unavailable
    raw/<sha256>                raw fetched bytes, content-addressed (re-convert offline)
    raw-map.jsonl               url → raw hash, fetch time, status, content-type
    assets/                     downloaded images (opt-in)
    locks/                      lock files
```

Only the names above that the tool writes itself (`catalog.md`, `.docs-cache.json`, `_profiles/`
at the root, `<domain>/_outline.md`, `.cache/`, temp files) are skipped by the tools that walk the
cache; any other path is a page, including URL segments starting with `_` or `.` (`__main__`,
Sphinx `_modules/`, `.well-known/`). A URL segment that would land on one of those names — or on a
`<page>.parts/` directory — gets one more trailing `_` (`https://host/_outline` →
`host/_outline_.md`, `/x.parts/…` → `x.parts_/…`; names already ending in `_` too, so the mapping
stays one-to-one).

The markdown files are the **source of truth**. Everything marked GENERATED and everything in
`.cache/` is rebuilt from them by `docs reindex`; nothing is ever hand-edited or patched in
place by concurrent writers.

### Page files

```markdown
---
Source: https://example.com/docs/guide/select
Generated: 2026-09-30
Updated: 2026-09-30
title: Select
description: …                  (what the page is for; see "Descriptions" below)
DescriptionFrom: llms.txt       (llms.txt | front-matter | meta | lead; absent = written by hand)
Library: drizzle-orm            (optional; from --lib or inferred)
DocsVersion: 0.44               (optional; from the URL or version switcher)
LibraryVersion: 0.44.2          (optional; from the project's lockfile)
VersionMatch: exact|minor|major|latest|unversioned
Via: markdown|source-link|html|text (how the content was obtained)
---
```

Upstream front matter keys are merged into the tool's block, never stacked.

### Descriptions

A page's `description:` is one or two sentences an agent reads in `_outline.md`, search
results or grep to choose the page without opening it. The tool never writes one itself; it
takes the first of these that passes the checks (`lib/convert/describe.mjs`):

1. **The site's llms.txt entry** for the page: the origin's llms.txt and those one and two
   path segments deep (`/docs/llms.txt`), deepest first, each fetched once and remembered for
   7 days (`.cache/llms/`). Written by the site for LLMs.
2. **The page's own front matter** (`description:` in its markdown source).
3. **The page's HTML metadata**: `<meta name="description">`, `og:description`,
   `twitter:description`, JSON-LD. Only when it is about this page: not the site's home-page
   description, not one already seen on a page with another title (`.cache/sources/`), and
   at least half its words found in the page.
4. **The page's opening**: the summary line under its title (`> …`), else its first prose
   paragraph — skipping notices ("Note:", "Requires…", all-bold banners), steps ("Let's…",
   "The following…"), parameter lists, and stubs that only introduce a list ("…the API to:").

Every candidate is cleaned to one line of plain text (entities, `\n`, links and emphasis) and
must pass: at least 20 characters and three words; no markup, URL path, unfilled template
token or unbalanced bracket; and, from sources 1–3, more than the title's own words. A
site-written description that only restates the title is still kept ahead of the opening
(a reader rated it above an opening that turned out to be a fragment). It is cut at a
sentence end near 300 characters (an opening near 250, ending in `…` when cut inside a
sentence).

`DescriptionFrom:` records the source, and a refresh never replaces a description with one
from a worse source; one without `DescriptionFrom` (written by hand, carried over from a v1
index) is never replaced. On the 483 harempants.com pages: a description for 97% (was 26%:
only front matter); an independent reader rated a 120-page sample 1.6 of 2 (llms.txt 1.84,
opening 1.62, front matter 1.50, meta 1.40), and the fixes that followed raised the 18 rows
they changed from 1.0 to 1.4. Cost: no extra requests for sources 2–4; llms.txt and the home
page a few requests per site per week.

## Fetch pipeline

Per URL, first success wins:

1. **Owner-published markdown for that page**: `<url>.md` variant, and `Accept: text/markdown`
   content negotiation. Validated (looks like markdown, not HTML/JSON/an error, identity check
   against the page title). Light cleanup only: strip MDX imports/exports, convert common MDX
   components (callouts → GitHub alerts, tabs → labelled blocks), drop injected preambles.
   Every request (plain GET, probes, discovery) carries a desktop Chrome user agent **and the
   headers Chrome sends with it** (`sec-ch-ua*`, `Sec-Fetch-*`, `Upgrade-Insecure-Requests`,
   `Accept-Language`), with one version throughout; renders use the launched browser's own
   version in its user agent, so its client hints agree. A Chrome UA without Chrome's headers is
   refused by some hosts (developers.facebook.com: HTTP 400 for every page and `.md` twin).
2. **A source link on the page** ("view source", raw GitHub link) — same validation.
3. **Rendered HTML → markdown**: Playwright renders (JS sites are common), the page is
   *expanded* in the browser (click ARIA tabs whose panels are lazy, open `<details>`), the DOM
   is captured, and conversion runs **in Node on the captured HTML** (a pure function, so it
   can be re-run offline from the raw cache and unit/eval tested without a browser).

Other rules:
- The browser is launched lazily (`lib/browser.mjs`), resolved from what is installed, and held
  per render (machine-wide slots). In Claude Code cloud sessions the egress proxy intercepts
  TLS 1.3 with its own CA and passes TLS 1.2 through, so every full Chrome/Chromium is launched
  with `--ssl-version-max=tls1.2` and uses its own network (1–3 s per page, the origin's real
  certificate — checked from the response's negotiated protocol). Playwright's default headless
  shell ignores that flag; it is the last candidate and has its requests re-issued from Node
  (`route.fetch`). No `ignoreHTTPSErrors`: it turned the certificate error into ~38 s loads;
  a certificate error now retries the page via Node. (`DD_RENDER_NETWORK=browser|node`
  overrides.) Source: the harempants.com handbook `CLOUD-BROWSER-AUTOMATION.md`, re-measured here.
- **Raw first, verified per site** (`--browser auto`, the default). Most documentation sites
  serve the whole page in their HTML; the browser only matters for the ones that build it with
  scripts, and it costs seconds per page. So when the plain GET already looks like the page
  (not a shell, bot check, error or stub; ≥ 2000 chars of text; no redirect to a `?hl=`-style
  variant), it is converted first, and whether that conversion can be used without a render is
  decided per *scope* (host + first path segment — one generator), in
  `lib/fetch/verdicts.mjs`:
  - a scope's first pages are rendered too, both conversions are compared without gold
    (`lib/convert/compare.mjs`: the render's words, code and headings must all be in the
    server HTML's conversion, and the server HTML must not carry text the render lacks);
    after 2 agreeing pages the scope is trusted, one disagreement makes it render-only;
  - a page with a feature no verified page of the scope had (code blocks, tables) is
    verified before being trusted, every 20th trusted page is spot-checked, and verdicts
    expire after 30 days; an unusable render (error page, failed) proves nothing;
  - when the server HTML's conversion is refused (error page, tiny) the page is rendered
    instead of failing.
  Verdicts live in `.cache/sources/<host>.json`. `--browser always` renders every page (the
  previous behaviour); `--browser never` never launches one. Calibration on the 76 recorded
  pages with both HTMLs (`eval/tools/raw-vs-render.mjs`): the comparison never called a worse
  server HTML "same" (0 of 76), and caught all 4 where it was worse (a locale redirect ×2,
  line-per-element code, a tabbed code block).
- **Speed, measured** (every item: `eval/results/SPEED_LOG.md`, paired live benchmarks, kept
  only with identical output). A render: lazy shared browser → one browser context per host,
  reused so its HTTP cache keeps the site's CSS/JS (recycled after 40 pages) → ads/trackers
  blocked by the EasyList/EasyPrivacy lists (`lib/fetch/blocklist.mjs`; never by "another
  domain", which removed real content) → DOMContentLoaded → settle until no tracked request has
  been in flight for 250 ms (counted from when settling starts) → the page's clock is run ahead
  so timer-driven animations are complete (then settled again if that started requests) →
  expansion (every `<details>` opened: some sections render only on open) → capture. HTTP:
  per-host token bucket (on average one request start per 200 ms, bursts of 6), and the
  owner-markdown probes a site has never used are skipped after 3 pages (spot check every 10th).
  59 pages, 8 sites, `--browser always`: 143 s → ~65 s; a 90-page, 3-site crawl with `auto`:
  86 s → 38 s.
- Owner markdown is judged against our own conversion of the plain-GET HTML (completeness,
  identity, CDN-conversion fingerprints such as leading breadcrumbs / raw `<dl>` / `¶`), so
  accepting it never needs a browser.
- A URL that is itself a file is stored as that file, never as a browser's view of it:
  markdown (`.md`, `llms.txt`, `text/markdown`) as markdown even when it is mostly one code
  block; other text (YAML, JSON, source code) verbatim as one fenced block, language from the
  extension (`Via: text`, no browser). When only the browser gets the file (the plain GET is
  refused), its document body is used; a site that wraps a `.md`/`.txt` file in an HTML
  `<pre>` gives the `<pre>`'s text.
- Detect and fail (never cache) bot-check / interstitial pages ("Just a moment…", Cloudflare,
  captcha) and soft-404s.
- Discovery (`--discover`): `llms.txt` links, sitemaps (incl. indexes and `.xml.gz`),
  restricted to the same site **and the URL's path prefix**; off-site links are never queued.
- Redirects: the cache key is the final URL, and `--skip-existing` checks the final URL too.

## Markdown rules

GitHub-flavored markdown (the user reviews the cache on GitHub).

- **Verbatim**: every word of the main content, including hidden tab panels and collapsed
  `<details>` (expanded, summary in bold). Never summarise.
- **Remove**: site template (nav, sidebars, headers, footers, breadcrumbs, cookie/promo banners,
  feedback widgets, "Edit this page", copy buttons, heading permalink anchors `¶`/`#`).
- **Headings** keep their hierarchy; one `#` title per page. API reference entries that the
  generator renders as anchored blocks rather than headings (e.g. Sphinx `dl.py > dt[id]`)
  become headings, so sections are addressable.
- **Code blocks** are byte-exact: indentation and blank lines preserved; line-number gutters,
  `$ ` prompts rendered as separate UI, and copy buttons removed. Language label only from the
  site's markup — never guessed.
- **Tabs**: every panel kept; each preceded by its tab label in bold (`**Python**`), not a
  heading. Detected generically via ARIA (`role=tablist/tab/tabpanel`, `aria-controls`,
  `aria-labelledby`); unrecognised widgets degrade to consecutive unlabelled blocks — nothing lost.
- **Code samples switched by a `<select>`** ("Select language": PHP / Python / cURL, as on
  developers.facebook.com) are tabs too: in the browser each option is selected in turn and the
  code it shows kept, labelled with the option. Only a select whose own block holds code (≤3
  `<pre>`, no headings), outside site chrome, whose options are not links, and only when changing
  it changed the code — a version picker rewrites the whole article and is left alone.
- **Callouts** → GitHub alerts (`> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`,
  `[!CAUTION]`); a callout's own title kept verbatim as a bold first line.
- **Tables**: simple → GFM tables (`|` escaped as `\|`); merged cells or block content in cells
  → minimal HTML table (only `rowspan`/`colspan` attributes kept).
- **Links**: absolute URLs (measured: +1.4% size on a 23 MB cache — worth it for correctness and
  clickability on GitHub). Same-page links stay `#fragment`. `utm_*` params dropped.
- **Images**: `![alt](absolute URL)`; decorative ones (icons, logos, avatars, tracking pixels)
  dropped; `data:` URIs always dropped (alt text kept). Optional `--images` downloads into
  `.cache/assets/`.
- **Maths** stays LaTeX; API signatures stay as written.

### Boilerplate removal (generic, layered)

1. Semantic HTML / ARIA landmarks, and a content extractor library (Defuddle / Readability — the
   eval decides).
2. **Cross-page template detection**: blocks that repeat across a site's pages are template.
   The container whose content varies page-to-page is the content root.
3. **LLM site profile** (opt-in: `--llm-profiles haiku` / `DD_PROFILE_LLM`; saved profiles are
   always used), only when 1–2 look wrong (high link density, repeated text, very short
   output, or no confident content root). The tool builds a compact DOM skeleton (tags, ids,
   classes, text length, link density — not raw HTML) of the first page, asks a model (`claude -p`
   with Haiku/Sonnet when available; otherwise it returns the skeleton to the calling agent) for
   `{contentSelector, removeSelectors}`, validates it on the page, and saves
   `_profiles/<host>.json`. Later pages on that host use the profile; if the selector stops
   matching, the page **fails loudly** and the profile is re-derived with the failure as context.

### Large pages

A page over ~25k tokens (the most one Read call returns) is split along its own structure: the
page's file becomes an index of its parts, and the verbatim parts go to `<page>.parts/` (each
with `Source: <url>#<anchor>`; concatenated in order they reproduce the page exactly). A section that
cannot be split (one giant table) is still searchable: the index chunks it into line windows.

## Search & index (tool: `docs`)

- Sections = markdown heading tree; each indexed with its heading path and line range.
- **SQLite FTS5** (`node:sqlite`, Node ≥ 22.13) with BM25 ranking, porter stemming; a pure-JS
  fallback index (same interface) when `node:sqlite` is missing.
- A **symbol index**: identifiers from headings and code (function/class/field names) for
  exact-name lookup.
- Output is bounded by design (`--limit`, `--budget` tokens) and available as `--json`.

```
docs search "<query>" [--domain d] [--lib l] [--json] [--limit n]
      → ranked sections: path:start-end, heading path, line count, snippet
docs outline <path|url>        → headings with line ranges (a page's table of contents)
docs lookup <url>              → cached? which file? (URL is the key)
docs catalog                   → domains/libraries with page counts
docs fetch <url...> [--discover] [--refresh [days]] [--lib] [--version]
docs reindex                   → rebuild every generated file and the search index
docs migrate [--from docs] [--apply]
docs doctor
```

The old script names (`fetch-docs.js`, `search-docs.js`, …) stay as compatible entry points.

## Versions

Prefer docs matching the project's installed version: read the lockfile, find the versions the
site offers (URL segments, version switcher links, `versions.json`, Read the Docs), choose exact
→ same minor → same major → latest, and record `VersionMatch`. If the site only has latest,
fetch latest, mark it, and fetch the changelog/release notes covering installed→latest.

## Concurrency

Many subagents may run the tool at once against one cache.

- Page files: written to a temp file and renamed (atomic). A per-URL lock dedupes in-flight
  fetches: the second requester waits, then finds the page cached. A per-page-FILE lock
  covers the write and the large-page split together (several URLs can land on one file), and
  a split never treats an existing index (`Parts:`) as page content.
- Per-domain generated files and site profiles: written only under that domain's lock.
- `catalog.md`: regenerated from the per-domain files under a short global lock; never appended.
- Search index: SQLite in WAL mode with a busy timeout — concurrent readers, serialized writers.
- Raw cache: content-addressed, write-once.
- Locks: `proper-lockfile` (stale-lock recovery); never "proceed without the lock".
- Machine-wide caps: max concurrent browsers, and a per-host request rate shared across
  processes (parallel agents hammering one host is how bot-checks get triggered): at most 3 in
  flight, a token bucket of one start per 200 ms on average with bursts of 6
  (`DD_HOST_CONCURRENCY`, `DD_HOST_INTERVAL_MS`, `DD_HOST_BURST`).
- Per-site learned state (`.cache/sources/<host>.json`: raw-vs-render verdicts, probe memory):
  read-modify-written under a per-host lock; a lost update only costs one extra check.

## Migration

`docs migrate` moves an old `docs/` cache into `external-docs/`:
- Only files the skill created (front matter with `Source:`) are moved; the destination path is
  re-derived from `Source` (not the old path — some old files live at non-URL-shaped paths).
- Files without `Source:` are listed for the user, not moved.
- Old `llms.txt` descriptions that pass quality checks are carried over.
- Dry run by default; idempotent; never leaves a half-moved cache (copy, verify, then remove).

## Evals

Results so far (composite 0–100; see README.md): v1 pipeline dev 76.2 / test 87.4 / blind 84.5
→ v2 98.5 / 99.6 / 96.9. Search hit@5 on a real 526-page cache: v1 3% → v2 93% dev / 82% test.

Everything is measured. See `eval/README.md`. No change is kept unless it improves the composite
score without regressing any tracked metric beyond tolerance, on a held-out split as well as the
dev split.
