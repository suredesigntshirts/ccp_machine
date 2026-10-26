---
tags: [skill-creator]
max_turns: 40
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit, Bash]
---

I collected three excerpts about SQLite's WAL mode in ./sources. Write them up as a cited research report in the Library on whether a read-heavy service on one machine can use WAL safely, so other threads can find it later. Keep every useful source.

(Test setting: the Library is the folder ./library here, not /mnt/project-files. Run `export LIBRARY_ROOT=$PWD/library` at the start of every shell command, read every /mnt/project-files path in the skills as ./library, and do not touch /mnt/project-files.)

Input files: sources/sqlite-wal-docs.md, sources/blog-wal-in-production.md, sources/forum-nfs.md, library/
