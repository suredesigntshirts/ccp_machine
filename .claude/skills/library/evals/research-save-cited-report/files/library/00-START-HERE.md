---
title: "Library map: start here"
summary: What is in the Library, where each kind of content goes, and how to find anything
kind: index
built: "2026-10-26T13:37:17Z"
---

# Library map: start here

This Library is organized and kept tidy by the **librarian**. Its kit (agent, skills, tool) is installed at `~librarian/kit/` and its source is the repository's `.claude/` folder. It holds 6 files. Built 2026-10-26T13:37:17Z.

**Coordinator and threads:** a session's prompt lists only the first names of the Library (a thread's list held 199 entries; plan on 150), sorted by full path. Those first names are this file and the signposts in `01-map/`: each signpost's name is the path it points to, with `--` standing for `/`. You have no file tools, so to read anything ask a thread or a worker to open it. To have the Library reorganized, cleaned up or searched, start a thread that loads the **librarian** skill.

**Threads and agents:** read `/mnt/project-files/~librarian/kit/skills/library/SKILL.md` before you read or write here (repository skills do not load in Project threads by themselves). In short:

1. Find before you fetch: `node "/mnt/project-files/~librarian/kit/skills/library/scripts/library.mjs" find <words>` searches the catalog (one file) instead of opening thousands.
2. Warm before you read many files: `library.mjs warm <folder>` opens them 16 at a time (cold opens cost ~100 ms each, warm ones <1 ms for ~45 min).
3. Write only new files, named by you, in the area below that fits; give every markdown file frontmatter (`title`, `summary`, `kind`). Unsure where? Write it to `drop/` and the librarian files it.
4. A path that no longer exists may have moved: `library.mjs resolve <path>`.

## Areas

| Folder | What goes there | Layout | Owner | Files |
|---|---|---|---|---|
| `research/` | Research the person asked for: one folder per topic, a cited report, its sources, and each researcher's notes | `research/<topic>/{README.md, brief.md, sources.md, notes/<writer>--<subquestion>.md}` | librarian | 0 |
| `docs/` | External documentation downloaded as markdown, one folder per domain | `docs/<domain>/<url path>.md, indexed by docs/llms.txt` | tool:documentation-downloader | 0 |
| `notes/` | Notes, reviews and memos from threads that are not a research topic | `notes/<slug>.md (sharded into notes/<yyyy-mm>/ once it nears the fan-out limit)` | librarian | 1 |
| `drop/` | Anything whose place is unclear: the librarian files it on its next run | `drop/<writer>--<slug>.<ext>` | any | 0 |
| `ccp/` | The ccp harness: worklog, usage, conformance, items. Written by the ccp plugin's CLI | `ccp/<area>/... (see the ccp skill)` | ccp | 0 |
| `uploads/` | Files the person uploaded in a thread, named by id. Their names are not in the session file list, so the map signposts them | `uploads/hearth/<id>` | platform | 0 |

Owner `librarian` areas are reorganized by the librarian; other owners' folders are catalogued but never moved or edited.

## Indexes

- [research/INDEX.md](research/INDEX.md): every research topic.
- `~librarian/catalog/*.jsonl`: one line per file (path, title, summary, kind, links), the source of `find` and `refs`.
- `~librarian/moves/`: every move the librarian made, so old paths still resolve.
- `~librarian/journal/`: the librarian's runs and reflections.
