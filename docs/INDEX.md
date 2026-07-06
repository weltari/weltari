# Weltari docs index

One line per wiki page (builder.md §2). Spec/session documents (Coding Guide, Stack Session, Brief, UI Spec, Rev 3/4) are owner documents — agents read, never modify.

## Module wiki (grows with the code, same-commit rule)

- [repo.md](repo.md) — repo root: toolchain, workspaces, gate scripts, CI.
- [protocol.md](protocol.md) — @weltari/protocol: Zod v4 wire schemas, emitted JSON Schemas, SSE frame conventions.
- [storage.md](storage.md) — apps/server/src/storage: WAL SQLite, WriteGate, hash-locked migrations, event-log repository.
- [ledger.md](ledger.md) — job ledger: states/leases/idempotency, runner (the C7 catch site), croner scheduler.
- [dependencies.md](dependencies.md) — the dependency ledger (one `##` heading per package; CI keys on headings).
