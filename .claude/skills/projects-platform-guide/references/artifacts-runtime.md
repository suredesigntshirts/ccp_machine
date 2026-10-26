# Artifacts at runtime: page capabilities and ArtifactData

What a published page can do in the viewer's browser, and how a session reads what the page and the
person did. Page code gets each capability with `await claude.use("<name>")`. Runtime contract 0.2.88.

## Contents
- Which page actions reach Claude
- comments: the wake path
- db and ArtifactData
- user
- files, sample, mcp, room, downloads, artifact (self)
- The viewer frame

## Which page actions reach Claude

| Action | Wakes a session? |
|---|---|
| The person comments in the shell with "Send to Claude" ticked (the default in the comment card) | Yes, about 1 s, every session watching the page |
| Page code `comments.sendToClaude({anchor, text})` | Yes, the same second; each press gives one wake |
| Page code `comments.create` / `reply` (plain), or a plain shell comment | **No**. The thread shows "NOT activated", and Claude cannot reply to it or resolve it |
| A page or Claude writes to `db` | **No**. Claude must pull with `ArtifactData` |
| `room` emits and presence, `sample` calls, `assets` uploads | No |
| A republish (by Claude or by page code via `artifact.publish`) | Yes, to sessions watching the page |

So a page that collects input should end with a Send to Claude step (a button that calls
`sendToClaude`), or the person should say "done" in the thread.

## comments: the wake path

- The wake is an **id-only** notification, `{"slug","event":"comment","version","thread","emitted_at"}`. Read the content with `ArtifactComments action=read`.
- A comment sent to Claude reaches sessions in two ways. (1) Every session watching the page gets a watch wake about 1 s later, wherever the person opened the page. (2) The person's app **also** posts a copy as the person's own message ("[Artifact comment sent to Claude] ... Please handle it in this session") into one thread, 5 to 40 s later. That thread is the one beside which the page was open, or the one whose card holds the page when it was opened from the project chat. When the page was opened in its own tab, no copy is posted. A session cannot choose which thread gets the copy.
- So one press can wake **two** threads (the last publisher and an earlier watcher or copy holder). Decide in advance which one acts.
- The coordinator holds no watch. It sees a copy only as thread activity, cut off too short to act on.
- A `sendToClaude` text keeps its newlines and arrives whole. The room presence object the page set is appended as `[presence when sent] {...}`, so a page can attach structured context without the person typing it.
- `canSendToClaude()` returns `available`, `writers_only`, `no_session` or `off`.
- Reply once per request: a second Claude reply after a standing one is refused unless `acknowledge_duplicate: true`. Claude's reply shows live in the open card within about 3 s. While the session is mid-turn, the card shows "Queued while Claude is busy".
- `ArtifactComments` brackets attribute authors ("the user (owner), posted by the artifact", "sent to you", "Claude (via the user)"). The tool has no create action.
- Page comment API: `create, reply, sendToClaude, canSendToClaude, resolve, delete, openComposer, anchorFor, customAnchors`. `anchorFor(el)` gives a CSS-path anchor plus a fractional position.

## db and ArtifactData

- `db` is a per-artifact JSON document store shared by viewers. Paths alternate collection / document. Documents are ≤256 KiB serialized and ≤32 levels deep, with at most 25,000 documents per artifact. Last writer wins, with no transactions.
- Access levels: `view` (viewer, commenter, signed-in visitor), `interact` (contributor; org member via public link), `admin` (editor or owner grant), `owner` (the artifact's owner only). The default root rule is read `view`, write `interact`. A rule covers its path and below, and write is never below read. `{self}` must be the last segment: `votes/{self}` lets each viewer write only `votes/<their id>`.
- `data/users/<id>/…` is **private to that viewer, even from the owner**. Addressing it as `me` needs both `db` and `user` declared.
- **`ArtifactData` acts as the person's account**: any session can write anything the owner can, and no write records which session made it. So a value in the database is not proof that the person entered it. For attributable input, use comments or card taps.
- Writes to an **existing** document need `if_version` (`set`, `update`, `delete`); without it they are refused with `version_mismatch` and the current version. `str_replace` (top-level string fields only) works without `if_version`.
- `update` merges nested objects and replaces arrays. `{"__delete__": true}` removes a field at any depth, but not inside an array and not in `set`. **Write top-level fields**: a nested `data` key hides fields.
- `query`: at most 10 `where` clauses; `in` and `not-in` take at most 30 values; top-level fields only (dotted paths are refused); `ne` and `not-in` **include documents missing the field**; one `order_by`, with missing fields last. An ordered query returns one page with no cursor (`limit` ≤1000); an unordered one pages with `next_cursor`.
- `batch` commits atomically. Parallel batches are applied one after another, about 2 s apart. Deleting a parent leaves its children readable.
- Under `if_version`, many writers lose nothing but get most concurrent writes refused. Give each writer its own document.
- `list` on a never-written collection returns "No documents matched".
- `out_dir` writes one JSON file per document holding only the data (no id or version).
- Any thread in the project can read and write an artifact's database.
- Page side: `claude.use("db")` resolves to `null` when the database cannot run, so render an empty state. It offers `onSnapshot` (realtime; one write can fire several snapshots), and `acquire` leases that are cooperative, not security.

## user

- `isOwner()`, `canEdit()` and `can(...)` return **promises**.
- `user: {}` gives the viewer's `id`; `scopes: ["profile"]` adds name and avatar; `email` needs the `email` scope. Ids are `u_` plus 22 characters, stable within one organization. Store ids, never names.
- From Claude's side, `ArtifactData profiles` returns no names even with `profile` declared. The page does get names.

## files, sample, mcp, room, downloads, artifact (self)

| Capability | What it does |
|---|---|
| `files` | Reads the project's Library as the viewer: `list` (up to 500 names a page), `read`, `download`, `asSampleTools`. Consent is asked once per artifact. **Reads are rate-limited hard**: reading a few hundred files, even six at a time, fails for more than half of them and takes minutes. Design pages around lists, not one read per file |
| `sample` | A stateless model call from the viewer's browser, on the viewer's usage: `sample(text)`, `sample.json`, page-defined tools, `modelTier`. `limits()` reports `maxPromptBytes` 262144 and 16 tools. It cannot reach the thread or project files |
| `mcp` | Calls the viewer's claude.ai connectors with consent per tool. `listTools`, `describeTool` and `callTool` work |
| `room` | Live presence and events for viewers who have the page open now; nothing persists and nothing wakes. `sendToClaudeSession` goes to the **viewer's own** Claude: `deliver:"stage"` navigates the person's browser **away from the page** into a new chat with the data staged, and `deliver:"send"` with no chat pane open is refused (`claude_unavailable`) |
| `downloads` | `downloads.save({filename, data})` asks for confirmation on every save. Plain `<a download>` links do nothing in the sandbox. Declining returns `{code:"declined"}` |
| `artifact` (`self`) | `publish` writes a new version as the viewer. `edit` and `sync` work **only on live docs**: on an ordinary page `edit` is refused (`not_writer`), even for the owner. `metadata(urls)` returns the titles of other artifacts |

## The viewer frame

- The page runs at `https://<uuid>.frame.claudeusercontent.com`, not at the top level. `localStorage` and the clipboard API work, and `#hash` passes through to the page.
- `location.href` is the sandbox host, so a page cannot learn its own artifact URL that way.
- The shell around every page offers comment mode, Chat, Share, Export (HTML, Markdown, PDF) and a title menu (Copy as Markdown, Install, Rename, Duplicate, Permissions, Refresh, Pin, Storage, Delete). Claude learns nothing about shell actions except comments.
