# The Library (shared files) and project memory

## The Library mount

`/mnt/project-files/` is the project's shared folder, shown as the Library tab. It outlives every thread.
It can be a symlink (to `/mnt/attach/project-files`), so always write the path with a trailing slash.

- Each session mounts the Library through **its own** FUSE mount (`fuse.rclone`, an HTTP backend to the
  project's file store, cache in RAM).
- Inside one session these work: write, append, positional write, fsync, rename, rename-over, `O_EXCL`
  create (`EEXIST` on an existing file) and exclusive `mkdir`. **Hard links (`ENOTSUP`) and symlinks
  (`ENOSYS`) do not.**
- Another session sees a write after up to about **40 s**. A reader that starts seconds after a burst of
  writes may see only some of them. Treat shared folders as eventually complete.
- `O_EXCL` gives **no lock across sessions**: a second session's create of the same name succeeds until
  the first one's write propagates. So never have two sessions write the same file. Give each writer files
  named with its own id, never rewrite another's file, and derive any shared view by reading everyone's
  files.
- Many threads writing their own files at overlapping times lose nothing and tear nothing.
- Write to a dot-prefixed temp name, then rename, so a reader never sees half a file.
- **The cost is opening files, not their size.** A cold open (first read in this container) takes about
  100 ms one at a time, and about 13 ms per file with 16 in flight; more than 16 is no faster. The mount
  manages about 85 opens per second. A warm re-open takes under 1 ms.
- After a few seconds idle, the first stat in a folder re-lists the whole folder (hundreds of ms for a few
  hundred entries). Keep busy folders small, for example one folder per day.
- The read cache keeps a file warm for about 45 to 60 minutes. A resumed thread gets a new container, so
  everything is cold again.
- The Library shows a `.md` file's frontmatter as YAML. An unquoted `#` in a value cuts the value off, so
  quote frontmatter values.
- Files the person uploads land in `uploads/hearth/`, named by bare id with no extension.
- A Library write wakes nobody. To give the person a file, **attach** it to a reply (`attached_outputs`
  kind `file`).
- A page's `files` capability can read the Library as the viewer, but it is heavily rate-limited
  (artifacts-runtime.md).
- An HTML file in the Library opens as a plain preview with no artifact runtime; it is not the artifact
  (artifacts-publishing.md, "Filing into Library folders").

## Project memory

- A thread sees memory as plain files in a synced folder (`/tmp/claude/memory/team/<name>/`, set by
  `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE`): a `MEMORY.md` index plus one file per subject, with
  `.memory-sync` and `.memory-sync-basis` bookkeeping files beside them. The index is recalled into
  context at session start; other files are recalled when judged relevant, and only their first 4 KB is
  shown.
- The coordinator uses `read_memory` and `update_memory`. **`update_memory` replaces the whole text.**
- The coordinator's memory writes reach threads by their next start.
- Memory changes reach a session at its next start or resume, not mid-session. A fact the coordinator
  must act on now goes by `message_coordinator` as well as into memory.
- Keep `MEMORY.md` short and move detail into subject files.
- What belongs in memory: what a later session would otherwise have to ask the person again (their
  preferences, grants, ids, decisions). What doesn't: anything the repository or the Library already
  records.
