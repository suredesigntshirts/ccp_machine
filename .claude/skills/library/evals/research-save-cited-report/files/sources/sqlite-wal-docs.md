# Write-Ahead Logging (excerpt) — https://www.sqlite.org/wal.html
- WAL allows readers and a writer to proceed concurrently: readers do not block writers and a writer does not block readers.
- There can only be one writer at a time.
- All processes using a database must be on the same host computer; WAL does not work over a network filesystem, because it needs shared memory (the -shm file).
- By default SQLite runs a checkpoint automatically when the WAL reaches 1000 pages (wal_autocheckpoint).
