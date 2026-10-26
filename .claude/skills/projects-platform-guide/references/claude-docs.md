# Claude Docs

Living documents that the person reads, edits and comments on.

## Who has the tools

- A thread starts with only `batch`, `guide` and `update` loaded. `create`, `read`, `delete`, `export`
  and `query` are deferred: load them with ToolSearch before deciding Docs tools are missing.
- **The coordinator has no Docs tools.** A thread writes Docs.
- Every write is authored as **the owner (the person)**, in the version history and on comments made by
  the tools. If provenance matters, put the session's name in the text.

## Making and filling a Doc

- One `batch` with `container.create` makes the Doc, its first tab and body, and returns its artifact URL
  (`claude.ai/artifact/<id>`). Docs are private by default.
- `pending` blocks show the plan while you fill them, one `replace` per section. One call per section lets
  the person watch the Doc fill; a single call shows nothing until it ends.
- These render: H1 to H3, inline marks, nested bullets, numbered lists, checklists, quotes, pipe tables,
  code blocks, `latex`, a `csv` block (shown as a grid), a `markdown` block (an exhibit with a Source
  toggle), date chips and mention chips. Charts from rows or CSV, image uploads and diagram widgets (an
  SVG module) are supported too.
- Changing a checklist to a bullet list with `set attrs.kind` drops the ticks. To tick, use the `check`
  kind with `checked: true`.
- Whole-block replace and delete need `ifHash` and `ifRev` (or `force`); targets found by `find` do not.
  Acks print what was written, so you need no re-read between your own writes.
- Adding a second tab needs a patch that places it (`tabs.<id>` name and order). Once a Doc has more than
  one tab, the tab bar moves to a left rail (`display.tabsLocation: "left"`).
- `read` with `{"kind":"screenshot"}` returns a PNG of a diagram widget. Values typed into a widget are
  lost on reload.
- Version history is coarse: many writes collapse into a few entries. `read` with `atRev` shows a past
  revision, and an `update` with a `restore` op rewinds a tab.
- `export` formats: `markdown` (structure kept; **date and mention chips become plain text**; comments
  dropped), `text`, `html`, `docx` (a `maxBytes` below the size is refused `doc_too_large`), `pdf`,
  `notion`. Export returns base64.
- Concurrent appends from two writers with no reads between them all land, interleaved.
- Limits: 1,000 comment threads per Doc, 100 comments per thread, 4,096-byte comment bodies. A comment
  cannot ride in a `batch`.
- A Docs-type Artifact's title does not rename the Doc (it stays "Untitled"). Rename through the Docs
  tools.
- There is no folder operation: no tool puts a Doc into a Library folder.

## Getting a Doc to the person

- A Doc reaches the project's Library only when a reply **attaches** it (`attached_outputs`, kind `link`).
- The person can share it (invite by email, or "Anyone with the link" to view) and export it to Word, PDF
  or Markdown, or send it to Google Docs or Notion.

## Comments do not reach the thread

- A plain comment on a Doc wakes **nobody**, not even the session that made the Doc.
- When the person selects text and comments, the composer starts with an `@Claude` chip and **"Send to
  Claude" ticked by default**. Such a comment is answered within about 20 s by a **doc-scoped responder**
  that writes as the owner. The thread that made the Doc gets no wake and no copy.
- So when you need a reply from a thread, message that thread. When you need the person's decision, use
  a decision card, not a Doc comment.
- Artifact comments behave differently: Send to Claude on a non-Doc Artifact does wake the watching
  thread (artifacts-runtime.md).
