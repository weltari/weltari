# Weltari docs index

One line per wiki page (builder.md §2). Spec/session documents (Coding Guide, Stack Session, Brief, UI Spec, Rev 3/4) are owner documents — agents read, never modify.

## Orientation & handover

- [handover.md](handover.md) — for the next AI agent: state at handover, the working contract, how to continue from the Week 11 kickoff.
- [project-overview.md](project-overview.md) — for humans: what the app is, where it stands, what's left, how to run and test it.
- [code-tour/](code-tour/README.md) — plain-language tour of every source module, with a suggested reading order.
- [kickoffs/](kickoffs/) — the historical weekly kickoff prompts (weeks 1–11 + debug sessions); the CURRENT week's prompt lives at the repo root.

## Module wiki (grows with the code, same-commit rule)

- [repo.md](repo.md) — repo root: toolchain, workspaces, gate scripts, CI.
- [protocol.md](protocol.md) — @weltari/protocol: Zod v4 wire schemas, emitted JSON Schemas, SSE frame conventions.
- [plugin-sdk.md](plugin-sdk.md) — @weltari/plugin-sdk: GatewayConnector interface + framework-free conformance suite (MIT edge).
- [storage.md](storage.md) — apps/server/src/storage: WAL SQLite, WriteGate, hash-locked migrations, event-log repository.
- [data-model.md](data-model.md) — every table: entity, sole writer, projections (read this + migrations instead of the DB file); fixtures/ loads a seeded example world.
- [ledger.md](ledger.md) — job ledger: states/leases/idempotency, runner (the C7 catch site), croner scheduler.
- [observability.md](observability.md) — root logger + redaction, fatal(), catchAndLog, validateAt, env boundary.
- [http.md](http.md) — SSE stream (Last-Event-ID replay), Zod-validated commands, buses, main.ts composition root.
- [engine.md](engine.md) — ContextAssembler (byte-stable prefix + tail, B14 wrappers), fixture world.
- [llm.md](llm.md) — LlmClient seam, ModelRegistry pinning, OpenRouter client (cached_tokens observability), FakeLLM, scripted scene turn.
- [painter.md](painter.md) — apps/server/src/painter: kill-safe sharp compositing (crop → feather → composite, temp+rename), stub image source, region leases.
- [gateway.md](gateway.md) — apps/server/src/gateway: connector host (B7 validate/cap/dedup), grammY Telegram long-polling echo.
- [plugins.md](plugins.md) — boundary/plugins + plugins/: drop-in loader (B10 hash verification, plugin.rejected), zero-build asset serving, frontend injection.
- [update.md](update.md) — boundary/update: self-update path (B12) — release check, SHA-256 + minisign verification (node:crypto, zero deps), VerifiedArtifact-confined pointer flip.
- [packaging.md](packaging.md) — Dockerfile (multi-arch, notify-only updates), Windows zip + launcher (exit-code contract), release checklist.
- [tools.md](tools.md) — kill harness (I4, 25/PR + 100/nightly) and offline consistency verifier.
- [web.md](web.md) — apps/web: bare React 19 + Vite 8 stream renderer (render-only client).
- [week1-results.md](week1-results.md) — Week-1 success-criteria measurements, model shootout, cost.
- [week2-results.md](week2-results.md) — Milestone 2 success-criteria results (extended kill table, RSS, time-skip).
- [week3-results.md](week3-results.md) — Milestone 3 part-1 results (drop-in proof, lint-verified map, interrupt durability, idle RSS).
- [week4-results.md](week4-results.md) — Milestone 3 part-2 results (mid-update kill safety, packaged boots, §1.14 masking, packaged RSS, real-provider tool spot check).
- [week5-results.md](week5-results.md) — Milestone 4 part-1 results (shell + rail, display modes, Map/Gameday/Config routes, roster event, all criteria PASS).
- [week6-results.md](week6-results.md) — Milestone 4 part-2 results (splash + History, fog/Explore/materialization, wl-map 0.3.0, mid_materialize kill safety, all criteria PASS).
- [week7-results.md](week7-results.md) — Milestone 5 part-1 results (the painted map on real generation backends, two real-backend bugs fixed, all criteria PASS at $2.82).
- [week8-results.md](week8-results.md) — Milestone 5 part-2 results (Flow A write into / Flow B read out of the map, sharp-feather + edit-model finds, all criteria PASS at $0.93).
- [week9-results.md](week9-results.md) — Milestone 6 part-1 results (in-scene creation loop, mid-call query seam on real provider, all criteria PASS at $0.33).
- [week10-results.md](week10-results.md) — Milestone 6 part-2 results (Weltari Chat part one: DM core, presence, reflect_chat, startscene bridge, subwiki pass — all criteria PASS at $0.19).
- [week11-results.md](week11-results.md) — Milestone 6 part-3 results (Weltari Chat part two: character-led startscene, proactive CRON DMs + freeze, query escalation, the Wiki page — all criteria PASS at $0.03).
- [dependencies.md](dependencies.md) — the dependency ledger (one `##` heading per package; CI keys on headings).
