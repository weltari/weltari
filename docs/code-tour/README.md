# The code tour — every module in plain language

These pages explain Weltari's source code to a reader who is **not** a
professional developer: what each file is for, what its main functions do,
and how the modules connect. They are companions to the terse developer wiki
pages in [docs/INDEX.md](../INDEX.md) — same modules, friendlier altitude.
(Written 2026-07-10 against the post-week-10 codebase; if a module changes a
lot in later weeks, its tour page may lag behind the wiki page.)

## Suggested reading order

Follow the life of one player action — a click in the browser travels down
this exact chain and its consequences travel back up:

1. [web.md](web.md) — the browser app: what you see, and how it stays a
   pure display for what the server streams.
2. [packages.md](packages.md) — the shared protocol both sides speak, and
   the plugin SDK.
3. [http.md](http.md) — the server's front door: commands in, the live
   event stream out, and `main.ts` where everything is wired together.
4. [engine.md](engine.md) — the world brain: rules, scenes, chat, and the
   exact prompts sent to the AI.
5. [llm.md](llm.md) — the only code that talks to AI providers, and the
   fake AI that stands in for free.
6. [ledger.md](ledger.md) — crash-safe background jobs: how AI calls and
   scheduled work survive a kill -9.
7. [storage.md](storage.md) — the only code that touches the database; the
   append-only event log.
8. [painter.md](painter.md) — the only code that edits images; how the
   world map gets painted kill-safely.
9. [gateway.md](gateway.md) — the doors to outside messengers (Telegram).
10. [boundary.md](boundary.md) — trust checks at the edges: config, the
    plugin loader, signed self-update.
11. [observability.md](observability.md) — logging, secret redaction,
    crash handling, and the `validateAt` checkpoint.
12. [tests-and-tools.md](tests-and-tools.md) — the safety net: invariant
    tests, the kill harness, and the CI scripts.

## The one-paragraph version of how it all connects

The browser (`apps/web`) renders a stream of events and posts commands. The
HTTP layer validates every command and either answers directly or enqueues a
**ledger job**. The ledger runner picks jobs up under a lease and calls into
the **engine**, which reads world state through **storage** repositories,
assembles a byte-stable prompt, and sends it through the **llm** seam (real
OpenRouter or the fake). Whatever the AI answers must pass two gates — right
shape, then allowed by current world state — before the engine appends it to
the **events** table, the append-only log that *is* the world. Every append
is fanned out over the SSE stream, so the browser (and any Telegram user via
the **gateway**) sees it live. Images take the same trip through the
**painter**. The **boundary** module guards everything that enters from
outside — env config, plugins, updates — and **observability** makes sure
everything that happens is logged with secrets scrubbed and every failure
lands somewhere visible.
