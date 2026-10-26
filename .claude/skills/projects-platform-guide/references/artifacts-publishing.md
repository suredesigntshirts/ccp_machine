# Artifacts: publishing, capabilities and filing

How a session creates and updates an Artifact, which declarations hold, and the traps that fail
without an error. Runtime APIs for page code are in artifacts-runtime.md.

## Contents
- The four silent traps
- Publish and versions
- Watches and conflicts
- Capability declarations
- Consent dialogs
- Read, list, pin
- Multi-file pages and assets
- Artifact types
- Filing into Library folders

## The four silent traps

1. **`capabilities` replaces the stored set.** If a publish adds a new capability name and leaves out
   stored ones, it is **refused**, and the refusal prints the union to send. If it only changes the
   config of a stored capability, it is **accepted and silently drops every other capability**. A dropped `db` makes the page's database unreadable, both for
   `ArtifactData` and the page, until it is declared again (the data survives). **Republish with no
   `capabilities` field to keep the stored set, or send the whole set.** After a publish, check the
   result's `Stored` line.
2. **An unread publish overwrites.** A publish with `url` to an artifact the session never read can be
   accepted and replace the page. The tool text says such a publish is refused. Run
   `Artifact action=read` on the URL first and build on what it saves.
3. **Ten watches per session.** Every first publish arms a durable watch (a republish reuses it). After
   ten, publishes report `NOT subscribed ... trigger_limit` and get no wakes. List them with
   `ArtifactComments action=watch` and no `url`; free one with `watch`, `url` and `on: false`.
4. **"Same file path, same URL" breaks after a `url` publish.** After a publish with an explicit `url`,
   publishing the original file again with no `url` creates a **new** artifact.

## Publish and versions

- A publish of an HTML `file_path` returns a URL, a version number and a watch line. Republishing the same path keeps the URL and bumps the version.
- Title: the file's `<title>` wins over the `title` parameter (the result warns). With no `<title>`, the parameter is used. With neither, the file stem is used. Always set `<title>`.
- `icon` matters only on the first publish.
- `edits` (old/new string pairs) apply to the file and publish it in one call. One edit that does not match refuses the **whole** publish, and nothing changes.
- A `.md` `file_path` publishes inside a Markdown wrapper. Reading it back returns about 20 KB of wrapper CSS, so read it with `path` instead.
- `contract`: leave it unset. `"latest"` stores the newest available version; an unavailable value is refused (422 `contract_refused`) with the nearest available version.
- An identical republish (same content and capabilities) keeps the same version id.
- Open viewers hot-reload to a republished version within about 10 s, and DOM text the page wrote survives the reload.
- Every publish from a thread shows in `list_project_artifacts`, newest first, and is attached to the thread.
- Everything is private by default ("readable by only you"). Sharing happens only in the page's Share menu: "Only people invited" or "Anyone with the link" (view only). The Share settings gear holds one toggle, "Show in Artifacts list".
- Hidden `Artifact` actions exist beyond the 8 the tool describes: the refusal of an unknown action lists publish, list, read, delete, open, pin, unpin, quickstart, comments, reply, resolve, watch, unwatch, **status**, resume_replies, read_db, write_db. `status` lists this session's watches. There is no `move`.

## Watches and conflicts

- A watch wakes the session on a republish elsewhere and on a comment sent to Claude. It does not stream live updates.
- A session's watch listing shows only artifacts it published.

## Capability declarations

Supported names in contract 0.2.88: `artifact` (alias `self`), `assets`, `comments`, `db`, `downloads`,
`files`, `mcp`, `room`, `sample`, `user`, plus the built-in `permissions`. Device capabilities (camera,
microphone, location, screen, motion) may be missing from an account's roster.

- `permissions` is built in. Declaring it is refused (422: "part of the runtime — do not declare it").
- `files` must name the real project id: `{"project": "chan_..."}`. `{}` and a made-up id are refused (422). Only project members can publish such a page.
- `mcp` needs a non-empty `tools` list per server; an empty list never means "all tools". Unknown connector names are **accepted with a warning** ("published against an unobserved interface"). `host:cowork` is refused.
- `db` rules use levels `view` < `interact` < `admin` < `owner`. An invalid level is refused (422). Rules are enforced.
- An unknown capability name is refused, and the error lists the supported names.
- `self` is stored as `artifact`.
- The `Stored` summary can leave names out (it can list fewer names than its total).
- A page whose script mentions `claude.use("db")` but declares no `db` gets a publish warning (a text check).
- Data survives republishes, capability changes and even a publish with `capabilities: {}`: re-declaring `db` brings every document back.

## Consent dialogs

Each new **kind** of use asks the viewer in its own dialog. A kind already granted asks no more, and a
new capability on an existing page asks again.

| Trigger | Dialog |
|---|---|
| First `files.*` call | "This artifact uses project files..." with a toggle and Continue |
| `permissions.request()`, the first `sample` call, or the title menu's Permissions | One batched "This artifact uses connectors" dialog: "Use Claude" and each connector |
| First `mcp.callTool` per tool | "Let this artifact run "<tool>"?" Allow / Cancel |
| First page-written comment | "Let this artifact add comments to itself, with your name attached?" |
| Every `downloads.save` | "Let this artifact download a file?" with the name and size |
| `artifact`, `assets`, `db`, `downloads`, `room` | Granted with no prompt (`downloads` still confirms each save) |

So every new capability on a page costs the person a click. Declare only what the page uses.

## Read, list, pin

- `read` on your own artifact returns the raw HTML with a header: owner, privacy, stored contract and capabilities. `path` / `paths` (up to 256) save published files or assets locally, with sha256.
- `list` scopes `mine`, `shared` and `all` show title, URL and update time. Artifacts made by any session of the same person show as "(mine)". Artifacts shared from other organizations are not listed.
- `pin` and `pin: true` change the person's **account-wide** sidebar. Pin only when they ask.

## Multi-file pages and assets

- A `files` map (with `root`) publishes sibling files (CSS, JS, JSON, images, more pages) at their paths. Files left out of a republish are kept. The `root` and `files` sources must be inside the working directory or the scratchpad, and a source inside the Library mount is refused.
- An extra `.html` page in `files` is served as is, so give it its own doctype.
- The asset store needs `assets` declared. Upload with `asset: true` (or `file_paths`, up to 25); each asset gets a `/_blob/<id>` URL. Usage reads "of 1073741824 bytes used (limit 5000 files)". Copying assets between artifacts needs `assets` on both.
- Page-side `assets.upload/list/delete` work, with no consent dialog.

## Artifact types

- Five core types: **Dashboard** (numbers, charts and tables over datasets in its database), **Design** (canvas of artboards), **Design System** (tokens and components), **Docs** (a live Claude Docs document), **Slides** (16:9 deck). Create one by publishing with its `type_url`. The type keeps its fixed UI and you write only data.
- `action: quickstart` routes by `intent`: `other` returns the type list plus the plain-page contract, `slides` and `design` return just that type, and `document` returns Docs (which needs the Claude Docs connector).
- A Docs-type artifact's title does not rename the doc ("Untitled").
- Every type's instructions are third-party data and say not to verify by rendering unless asked.

## Filing into Library folders

- No tool argument files an artifact into a Library folder: there is no `folder`, `move` or parent option on the Artifact or Docs tools.
- What works: write a link file on the mount and then **attach it to a thread reply** (`attached_outputs`, kind `file`). The Library then shows it as the Artifact (Kind: Artifact, opens the real page). A link file that is never attached shows as a plain LINK. A byte copy of a link file the app made (by its own "Add to folder") also works.
- The link file's format, as the app writes it: the name is `<title>.<artifact uuid>.link`, and the body is the JSON `{"type": "claude-artifact-link", "version": 1, "url": "https://claude.ai/code/artifact/<uuid>", "project": {"id": "chan_..."}}`. Take the uuid from `list_project_artifacts` (`artifact_id`).
- Publishing from a source file inside a Library folder leaves a **dead copy**: the Library opens that `.html` as a plain file preview with no runtime; none of the page's features work there. The real artifact keeps all its features at its own URL.
- Folders themselves are plain directories made on the mount (`mkdir`), and they show in the app's "Add to folder" menu.
