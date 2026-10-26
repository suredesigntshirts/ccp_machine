---
tags: [skill-creator]
max_turns: 40
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit, Bash]
---

You are the librarian. Run one pass over the Library.

(Test setting: the Library is the folder ./library here, not /mnt/project-files. Run `export LIBRARY_ROOT=$PWD/library` at the start of every shell command, read every /mnt/project-files path in the skills as ./library, and do not touch /mnt/project-files.)

Input files: library/
