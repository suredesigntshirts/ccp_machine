---
title: SQLite WAL mode for concurrent readers
summary: WAL lets readers and one writer run concurrently on one host; it is unsupported on network filesystems
kind: report
topic: sqlite-wal-concurrency
status: final
author: lead-0425
created: 2026-10-24
tags: [sqlite, wal, concurrency]
---

# SQLite WAL mode for concurrent readers

## Findings
- F1. Readers and a single writer proceed concurrently in WAL mode [S1].
- F2. WAL needs shared memory, so it does not work over a network filesystem [S1].

## Sources
See [sources.md](sources.md).
