---
title: Multi-agent research in the Library
summary: The folder layout, roles and citation format for research that several agents do together
kind: reference
---

# Multi-agent research in the Library

The person often asks for research "with citations and references of all the useful research found".
Several agents may work on one topic at once. The layout makes that safe (each agent writes only its
own files) and makes the result easy to find and to trust (one report, every claim cited).

## Layout

```
research/<topic>/
  README.md                         the report: answer first, every claim cited [S1]
  brief.md                          the question in the asker's words, scope, who asked, when
  sources.md                        every source used, one row per id
  notes/<writer>--<subquestion>.md  one file per researcher per subquestion
  data/                             optional: tables, extracts, downloads the report cites
```

Create it with `node "$L" new-topic <slug> --title "<title>" --question "<question>"`. First run
`node "$L" find <words>`: if a topic already covers the question, extend it (add notes, update the
report) instead of starting a second one. `<topic>` names the subject (`xstate-orchestration`), never
the date or the asker.

## Roles

| Role | Writes | Never writes |
|---|---|---|
| Lead (the thread that was asked) | `brief.md`, then the synthesis in `README.md` and `sources.md` | other agents' notes |
| Researcher (a subagent or thread per subquestion) | its own `notes/<writer>--<subquestion>.md` | `README.md`, `sources.md`, other notes |
| Librarian | indexes, signposts, moves; fixes links | the content of a report |

`<writer>` is the researcher's session or thread id (or a short role name the lead assigned, unique in
the topic). One file per researcher means no two sessions ever write the same file.

## A researcher's notes file

```
---
title: XState persistence options
summary: How XState v5 persists actor state, and what breaks on restore
kind: notes
topic: xstate-orchestration
author: <writer>
created: 2026-10-26
---

## Findings
- Snapshots are plain JSON and restore with `createActor(machine, { snapshot })` [1].
- ...

## Sources
1. Stately, "Persistence", https://stately.ai/docs/persistence, accessed 2026-10-26. Primary docs.
2. ...
```

Note sources are numbered locally. Quote the exact sentence when a claim is surprising. Mark what you
inferred rather than read ("inference:").

## The synthesis

The lead merges the notes into `README.md`: the answer first, then findings, open questions and the
method. Each claim cites a global id `[S<n>]`. `sources.md` holds one row per id:

```
| Id | Title | Author / publisher | Date | URL | Accessed | Reliability | Supports |
|----|-------|--------------------|------|-----|----------|-------------|----------|
| S1 | Persistence | Stately | 2025 | https://stately.ai/docs/persistence | 2026-10-26 | primary docs | F2, F3 |
```

Reliability is one of: primary docs, peer-reviewed, vendor blog, independent blog, forum, inference.
Keep every useful source, including ones that did not make it into the answer, under a "Further
reading" heading in `sources.md`: the person asked for all the useful research found.

Set `status: final` in `README.md` frontmatter when the report is delivered, and give it a one-line
`summary` that answers the question: the research index and the map show that line.

## Downloaded material

Whole documentation sites go to `docs/<domain>/` via the documentation-downloader skill, not into the
topic. A topic cites them by path. A PDF or dataset used only by this topic goes in its `data/`.
