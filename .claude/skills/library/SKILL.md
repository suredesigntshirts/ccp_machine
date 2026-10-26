---
name: library
description: How to find, read, write and cite files in the project Library (/mnt/project-files), the folder every thread shares. Use it whenever a session will search the Library, read more than a few files there, save anything there (research, notes, reports, data, a hand-off for another thread), run multi-agent research with citations, or cannot find a file it expected, even if the person never says "Library". It gives the fast search command, where each kind of file goes, the frontmatter every file needs, and one command (put) that writes a file safely.
---

# The Library

The Library is the project's shared folder, mounted at `/mnt/project-files` in every session. It
outlives every thread. The **librarian** (the `librarian` skill) keeps it organized; this skill is
what every other session needs to use it well.

The tool is one script, `library.mjs`, installed on the mount so it works in any session. Set `L` at
the start of every shell command, because `$L` does not carry over between commands:

```
L="/mnt/project-files/~librarian/kit/skills/library/scripts/library.mjs"
node "$L" help
```

(In a checkout of the repository it is also at `.claude/skills/library/scripts/library.mjs`.)

Your id (`<your-id>` below) is your session or thread id, or the role name your lead assigned you.

## Three facts that shape everything

1. **A cold file costs about 100 ms to open; a warm one under 1 ms.** The whole mount allows about 85
   opens a second, and a container's cache keeps a file for about 45 minutes. So never walk or grep
   the Library to find something: use `node "$L" find` (the script's subcommand, not Unix `find`),
   which searches the catalog in `~librarian/catalog/` (one file per area). Before you read many
   files, warm them: `node "$L" warm <folder>` (or `warm --hot` for the map and catalog). `warm`
   already opens 16 files at a time, the useful limit; do not run your own parallel reads beside it.
   Re-warm after about 40 minutes.
2. **Sessions see only the first names of the Library** in their prompt, sorted by full path. Those
   names are `00-START-HERE.md` and the signposts in `01-map/`. Never create a top-level file or
   folder: it would push the map out of that view. Write inside an existing area.
3. **Other sessions see your writes about 40 seconds late, and there are no locks.** Two sessions
   editing one file both think they won, and one loses its work. So write only new files with your id
   in the name, leave files that someone else may be writing alone, and write through `put` (below),
   which writes a dot-prefixed temp file and renames it into place so no reader sees half a file. Do
   not expect a peer's new file to show up in the first minute.

## Finding things

| You want | Do |
|---|---|
| Anything by subject | `node "$L" find <words> [--area research] [--kind report]` |
| What the Library holds | read `00-START-HERE.md`, then the area's `README.md` or `INDEX.md` |
| A path that no longer exists | `node "$L" resolve <path>`: the librarian logs every move |
| What links to a file | `node "$L" refs <path>` |

A `find` that returns nothing is logged for the librarian, so it learns what people look for. If you
needed something and found nothing, write a request (below).

## Where to write

| Content | Place | Notes |
|---|---|---|
| Research the person asked for | `research/<topic>/` | First `find`: if a topic covers the question, extend it. Otherwise `node "$L" new-topic <slug> --title "<title>" --question "<question>"`. Each researcher writes only its own `notes/<your-id>--<subquestion>.md`; only the lead writes `README.md` and `sources.md`; every claim in the report cites `[S<n>]` defined in `sources.md`. Full rules: [references/research.md](references/research.md) |
| External docs (libraries, APIs) | `docs/<domain>/...` | Only via the documentation-downloader skill, with `--root /mnt/project-files/docs` (its own default, `external-docs/`, would be a stray top-level folder; versions before 2.0 used `--output-dir`) |
| A note, review or memo that is not a research topic | `notes/<slug>.md` | |
| Anything a tool keeps for itself | the tool's own folder (its Owner in `00-START-HERE.md`) | Only through that tool |
| You are not sure | `drop/<your-id>--<slug>.md` | The librarian files it |

`00-START-HERE.md` lists the current areas; the librarian adds areas as the Library grows, so trust
that file over this table.

**Every markdown file starts with frontmatter**, because the catalog is built from it and readers find
files by it. `title`, `summary` and `kind` are required (lint fails without them); fill in the rest
for reports and notes:

```
---
title: XState v5 actors for long-running agent workflows
summary: One sentence that says what a reader learns here
kind: report        # report | notes | sources | brief | reference | memo | review | index | data | request
topic: xstate-orchestration
status: draft       # draft | final | superseded
author: <your-id>
created: 2026-10-26
tags: [xstate, orchestration]
---
```

Names: lowercase-kebab, `.md` for markdown, no dates in topic folder names (put dates in
frontmatter). Link to other Library files with relative markdown links (`[report](../x/README.md)`) or
full `/mnt/project-files/...` paths; links must point to files that exist. The librarian rewrites both
forms when it moves a file.

**Write with `put`.** It adds the frontmatter (with your id as `author` and today as `created`),
writes safely, lints the file and announces it, so `find` shows it to other sessions before the
librarian's next catalog scan:

```
node "$L" put notes/mount-cache.md --title "How long the mount cache lasts" \
  --summary "Measured warm-cache lifetime on the Library mount" --kind notes --tags cache,mount <<'EOF'
# How long the mount cache lasts
...
EOF
```

It refuses a top-level path, a folder another tool owns, and an existing file (pass `--replace` only
for your own file, such as a stub `new-topic` made for you). If you wrote files another way, run
`node "$L" lint <your files>` before you finish and fix what it reports; a clean lint announces them
too.

## Asking the librarian

- For a small thing (file this, this name is confusing, I could not find X), write
  `~librarian/requests/<your-id>--<slug>.md` with frontmatter `kind: request` and what you need. The
  librarian reads requests on every run.
- Move, rename or edit only files you created in this session (inside a folder you created, anything).
  A move by hand leaves every link to the old path dangling; the librarian's `mv` fixes them. For any other move, rename or reorganization, write a request and then ask for a librarian:
  a Project thread asks the coordinator (`message_coordinator`), or messages the running librarian
  thread (`message_thread`) if there is one; a subagent says so in its report to the session that
  started it.
