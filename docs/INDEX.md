# Weltari docs index

One line per wiki page (builder.md §2). Spec/session documents (Coding Guide, Stack Session, Brief, UI Spec, Rev 3/4) are owner documents — agents read, never modify.

## Module wiki (grows with the code, same-commit rule)

- [repo.md](repo.md) — repo root: toolchain, workspaces, gate scripts, CI.
- [protocol.md](protocol.md) — @weltari/protocol: Zod v4 wire schemas, emitted JSON Schemas, SSE frame conventions.
- [plugin-sdk.md](plugin-sdk.md) — @weltari/plugin-sdk: GatewayConnector interface + framework-free conformance suite (MIT edge).
- [storage.md](storage.md) — apps/server/src/storage: WAL SQLite, WriteGate, hash-locked migrations, event-log repository.
- [ledger.md](ledger.md) — job ledger: states/leases/idempotency, runner (the C7 catch site), croner scheduler.
- [observability.md](observability.md) — root logger + redaction, fatal(), catchAndLog, validateAt, env boundary.
- [http.md](http.md) — SSE stream (Last-Event-ID replay), Zod-validated commands, buses, main.ts composition root.
- [engine.md](engine.md) — ContextAssembler (byte-stable prefix + tail, B14 wrappers), fixture world.
- [llm.md](llm.md) — LlmClient seam, ModelRegistry pinning, OpenRouter client (cached_tokens observability), FakeLLM, scripted scene turn.
- [painter.md](painter.md) — apps/server/src/painter: kill-safe sharp compositing (crop → feather → composite, temp+rename), stub image source, region leases.
- [gateway.md](gateway.md) — apps/server/src/gateway: connector host (B7 validate/cap/dedup), grammY Telegram long-polling echo.
- [plugins.md](plugins.md) — boundary/plugins + plugins/: drop-in loader (B10 hash verification, plugin.rejected), zero-build asset serving, frontend injection.
- [update.md](update.md) — boundary/update: self-update path (B12) — release check, SHA-256 + minisign verification (node:crypto, zero deps), VerifiedArtifact-confined pointer flip.
- [tools.md](tools.md) — kill harness (I4, 25/PR + 100/nightly) and offline consistency verifier.
- [web.md](web.md) — apps/web: bare React 19 + Vite 8 stream renderer (render-only client).
- [week1-results.md](week1-results.md) — Week-1 success-criteria measurements, model shootout, cost.
- [week2-results.md](week2-results.md) — Milestone 2 success-criteria results (extended kill table, RSS, time-skip).
- [week3-results.md](week3-results.md) — Milestone 3 part-1 results (drop-in proof, lint-verified map, interrupt durability, idle RSS).
- [dependencies.md](dependencies.md) — the dependency ledger (one `##` heading per package; CI keys on headings).
