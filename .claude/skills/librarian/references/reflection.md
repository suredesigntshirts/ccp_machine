---
title: How the librarian reflects and changes its own rules
summary: The evidence the librarian reads each run, the questions it answers, and how it decides what to change in its policy, skills, agent and tool
kind: reference
---

# Reflection: how the librarian improves itself

The Library will outgrow every rule written today. Reflection is how the rules keep up: each run ends
by asking whether the layout served the sessions that used it, from evidence rather than taste, and
changing the smallest thing that removes the cause (Five Whys: fix the rule that produced the mess, not
only the mess).

## Evidence (read every run)

| Source | Command | What it tells you |
|---|---|---|
| Audit findings | `audit` | Where the Library breaks its own rules now |
| Trend | `trend --n 10` (empty on a first run) | Whether findings, files and signposts are growing, shrinking or stuck |
| Signals | `signals --days 7` | What sessions searched for and did not find, paths they could not resolve, lint failures |
| Requests | `~librarian/requests/` | What sessions asked for in words |
| Drop zone | `audit` (`drop-waiting`) | What sessions could not place, which means an area is missing or unclear |
| The window | `window | tail -1` | Whether the map still fits and starts first |
| Scan cost | `scan --write` JSON (`opened`, `walk_ms`, `total_ms`) | Whether the catalog keeps reads cheap as the Library grows |

## The questions

Answer each in a line or two in the journal entry. "Nothing" is a fine answer.

1. **What did sessions fail to find?** Group `find-miss` queries. A repeated miss for content that
   exists means its title, summary or tags do not say what people call it: fix the frontmatter, or
   add a signpost. A miss for content that does not exist is a request for research: list it for the
   coordinator.
2. **What did sessions fail to place?** Several drops of one kind mean an area is missing: register it.
   Lint failures that repeat one mistake mean the `library` skill is unclear on that point: propose a
   wording fix.
3. **Which finding keeps coming back?** A finding that reappears after you fixed it has a cause upstream:
   a writer that does not know the rule, a tool that writes to the wrong place, a convention that
   fights how agents work. Find the cause and change it (skill text, tool default, layout), then watch
   that the count falls in later runs.
4. **Does the window still work?** Signposts within the window, START-HERE first. When topics outgrow the
   dynamic budget, decide what deserves a slot (most active, most asked for) and whether research needs
   sub-areas with their own signposts.
5. **Is reading still cheap?** If `scan` time or shard size grows faster than the file count, split
   shards or restructure the slowest area.
6. **What did I do by hand that a rule or the tool should do?** Anything done twice by hand is a
   candidate for `policy.json`, a `build` rule, or a tool command.
7. **What would I do differently if I designed the Library today?** Note it even if it is not yet worth
   doing. When the same note appears in three journals, plan it as a reorganization.

## Deciding what to change

| Kind of change | How | Bar |
|---|---|---|
| Frontmatter, links, filing, signposts, area READMEs | Do it now | Always within a run |
| `policy.json`: add or retire an area, change a layout, limits, map pins | Edit the file (write to a dot temp, rename), journal line with reason | Evidence from this run or the trend |
| A reorganization (over 50 files, or an area's layout) | Plan in the journal, then a series of `mv` | The same problem in two runs, or a fan-out or window error |
| This skill, the `library` skill, the agent, `library.mjs` | Pull request with tests | A cause found by question 2, 3 or 6, or a constraint in theory.md that changed |
| Anything that deletes content or changes what the person sees | Ask the person, with a recommendation | Always |

Every change answers "what evidence, what cause, what result do I expect, how will the next run see
it". The next run checks that the result happened; if not, undo or try the next cause.

When a measurement in [theory.md](theory.md) is re-probed, update the row and the choice that rests on
it in the same pull request.

## Housekeeping of the evidence

`scan --write` deletes signal files older than 30 days. `trend` is empty until the first journal
entry exists and says little until there are several. The journal is kept; when a day's
folder holds more than about 50 entries, the runs are too frequent for what they find.
