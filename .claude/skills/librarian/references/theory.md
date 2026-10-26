---
title: Why the Library is organized this way
summary: The measured constraints of the Library and the reason for each design choice, so a later librarian can rebuild or change the design
kind: reference
---

# Why the Library is organized this way

A program is the theory in its builders' heads (Naur); this file is that theory for the Library, so a
librarian that has never seen this conversation can change the design without breaking what it was
for. Each choice names the constraint it serves. When a measurement here changes, change the choice,
then the row (keep the old value as `(was ..., <date>)`).

## The constraints, measured

| # | Constraint | Value | Evidence |
|---|---|---|---|
| C1 | Cold file open on the mount | ~100 ms each serially; ~13 ms each at 16 in flight; ~85 opens/s for the whole mount | ccp platform-facts, "The Library mount" (2026-10-22, n=3 containers) |
| C2 | Stat after a directory listing | under 0.5 ms (attributes come with the listing); a cold listing 100 to 170 ms for a small folder, up to ~490 ms for 430 entries | 2026-10-26 10:40 UTC, this design's probe on `ccp/usage`, `ccp/worklog`; platform-facts |
| C3 | Warm cache lifetime | a read file stays warm ~45 to 60 min in its container; a resumed thread starts cold | platform-facts (2026-10-22) |
| C4 | Cross-session visibility | ~40 s; no cross-session locks (`O_EXCL` does not exclude) | platform-facts (2026-10-21) |
| C5 | Session file list | each session's prompt lists Library entries: full paths, folders included (trailing `/`), sorted as the bare path in code-unit order; dot files listed; children of `uploads/` not listed; a thread's list was cut after 199 entries with "… the list is cut here" | 2026-10-26 10:43 UTC, probe thread `cmsg_01CRqZ2YoFXkbgk5p24fe6Kk7g7zaeGawYS3vgCXhGxnyx`; the list is the test fixture `session-file-list-2026-10-26.md` |
| C6 | The coordinator's list | the person reports the coordinator sees the first 150 names; on 2026-10-26 the coordinator said its context held no list at all | person's brief; coordinator relay 10:39 UTC. Open: re-ask after a coordinator restart |
| C7 | Repository skills | `.claude/skills/` in the repo does not load in Project threads | another thread's finding, 2026-10-26 10:43 UTC (worklog), and this thread's skill list |
| C8 | Scale | up to 50k files | the person's brief |
| C9 | Hard and symbolic links | unsupported on the mount | platform-facts |
| C10 | Session identity | every container's hostname is `vm`; `CLAUDE_CODE_SESSION_ID` differs per session; `/mnt/project-files` is a symlink to `/mnt/attach/project-files` | 2026-10-26 11:03 UTC, `hostname`, `env`, `process.cwd()` in a thread |

Sort order in practice (C5): `!` `#` `.` < digits < uppercase < `_` < lowercase < `~`; a space sorts
before `-`, and `-` before `.` before `/`. So `00-…` sorts first and `~…` last.

## The choices

**The window is the map (C5, C6).** Whatever sorts first is all most sessions see without opening a
file, and the coordinator cannot open files at all. So the first names are generated, not organic:
`00-START-HERE.md`, then `01-map/` with one signpost per destination, each named for the path it points
to (`--` for `/`) with a short hint. Content areas sort after the map, and the librarian's machinery
sorts last (`~librarian/`) so it never takes a slot. `build` keeps the map within
`window - reserve` entries (150 - 12) and falls back to "N older topics, see research/INDEX.md". A
new top-level name is a stray because, sorting anywhere before `~`, it pushes signposts out or
splits the map.

**Signposts are files, not folders (C5).** Every folder costs a slot too. One file per destination is
the densest map; the size the list shows next to it is noise we accept.

**Uploads get signposts (C5).** Their children are not listed and their names are ids. A signpost
named for what the upload is (sniffed type or first line) is the only way a session learns it exists
without opening it.

**The catalog replaces walking (C1, C2, C8).** Opening 50k files cold is ~10 minutes of the mount's
whole capacity. Listings are cheap and carry size and mtime, so `scan` re-opens only files whose size
or mtime changed, and `find`, `refs` and `audit` read the catalog, one shard per area, a handful of
opens. The catalog is a cache: losing it costs one full scan, nothing else.

**Links are indexed at scan time, so moves never grep (C1, C8).** Each catalog entry keeps its
outbound Library links; `mv` finds every file that links to what moves from the catalog and rewrites
only those, and rewrites the moved files' own relative links. Foreign files (ccp, uploads) and files
changed in the last 10 minutes are not edited; the moves log (`~librarian/moves/`) lets `resolve` and
`audit` map old paths to new ones instead. No stubs are left behind: links are unsupported (C9), and a
stub file would cost a window slot and a listing entry forever.

**One librarian at a time, by lease (C4, C10).** The lease names the writer by the first 8 characters of the session id (or `LIBRARY_WRITER`), never the hostname, which is the same in every container. Moves race; derived files do not (two builds write the
same content). So only writers that move or restructure take the lease, and acquiring waits 45 s and
re-reads, because a competing write is invisible for ~40 s. A lease expires (90 min) so a dead run
cannot block the next.

**Everyone else writes only new files under their own name (C4).** This is the ccp harness's rule too.
Research notes are one file per researcher (`notes/<writer>--<subquestion>.md`); requests and signals
are files named by their writer. The librarian edits other sessions' files only to fix links, and only
once they have been still for 10 minutes.

**Warm before reading, and the hot set (C1, C3).** `warm` opens 16 at a time, which is 7x faster than
serial and the knee of the curve (32 to 128 were no better). `~librarian/hot.txt` names the few files
every reader needs first (map, catalog, moves, policy), so `warm --hot` costs well under a second.

**The kit lives on the mount; the source lives in the repo (C7).** Repo skills do not auto-load, but
every session has the mount. So `install` copies the reviewed skills, agent and tool into
`~librarian/kit/`, and `00-START-HERE.md` points there. Changes to the kit go through a pull request
(tests, review, history); changes to data and policy (`policy.json`) the librarian makes directly.
That split keeps it autonomous where a mistake is cheap and reviewed where a mistake would mislead every
other agent.

**Simple first (Gall's Law).** Per-topic `sources.md` instead of a global source registry; one shard per
area instead of a database; `find` as substring scoring instead of an index. Each has a known limit;
change it when the journal shows the limit being hit, not before.

## Open questions and the probe for each

| Question | Probe |
|---|---|
| Is the coordinator's list cut at 150 entries or by bytes, and does it refresh each turn or only at session start? | Ask the coordinator to quote its list after it restarts, with more than 150 entries present and long names |
| Is a thread's list cut by count (199) or by size? | Repeat the C5 probe with 160 names of 120+ characters |
| Does a warm read refresh the cache lifetime? | Read a file every 30 min for 2 h; time each read |
| Does a folder `rename` on the mount cost per file inside it? | Time `mv` of a 400-file folder |
