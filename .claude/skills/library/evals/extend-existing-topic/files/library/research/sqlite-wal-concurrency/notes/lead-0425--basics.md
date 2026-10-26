---
title: WAL basics
summary: What WAL changes about locking
kind: notes
topic: sqlite-wal-concurrency
author: lead-0425
created: 2026-10-24
---

## Findings
- Readers do not block writers [1].

## Sources
1. https://www.sqlite.org/wal.html
