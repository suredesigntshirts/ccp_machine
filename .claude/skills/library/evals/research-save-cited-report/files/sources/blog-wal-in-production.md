# "SQLite WAL in production" (excerpt) — https://example-engineering.blog/sqlite-wal-production (2025-03-14)
- We switched a read-heavy service to WAL and saw p99 read latency drop from 40 ms to 6 ms under write load.
- Long-running read transactions prevented checkpoints from completing, and the WAL file grew to 3 GB ("checkpoint starvation").
- We now set PRAGMA journal_size_limit and run PRAGMA wal_checkpoint(TRUNCATE) from a maintenance job.
