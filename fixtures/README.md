# fixtures — the seeded example world (builder.md §4.3)

Data-file fixtures agents (and the owner) can load to look at **real rows**
when debugging, instead of guessing from column names. The database itself is
never read directly — agents read the schema
([apps/server/migrations/](../apps/server/migrations/)), the repositories
([apps/server/src/storage/repositories/](../apps/server/src/storage/repositories/)),
and [docs/data-model.md](../docs/data-model.md); this folder exists so a real
SQLite full of representative rows is one command away.

## Contents

| Path | What it is |
| --- | --- |
| `example-world/events.jsonl` | One append-input row per line (`world_id`/`actor_id`/`type`/`payload` — `id`/`ts` are assigned by the repository). Covers the whole event vocabulary as of protocol 0.8.0 (incl. `sublocation.materialized` — a seeded fixture square and an explored one): a played scene (open → roster → turns incl. an interrupted one → tool effects → soft close), the reflection/World-Agent fan-out, a time skip with both cron replay classes, a painter composite, a refused plugin, and the update pair. |
| `load-example-world.mjs` | Loads the JSONL into a fresh SQLite **through the repository layer** (the only SQL site), safeParse-checking every row against `@weltari/protocol` first — the fixture cannot drift from the wire format silently. |

## Usage

```
npm run build            # or: npx tsc -b   (the loader imports compiled dist/)
node fixtures/load-example-world.mjs                 # -> data/example-world.sqlite
node fixtures/load-example-world.mjs path/to/my.sqlite
```

Then inspect with any SQLite tool, e.g.:

```
sqlite3 data/example-world.sqlite "SELECT id, type, actor_id FROM events"
```

The output database is gitignored (`data/`, `*.sqlite`) — regenerate at will.

## Rules

- Rows must stay valid against the protocol union; the loader fails loudly on
  drift (run it after any protocol change that touches these event types).
- This is inspection data, not game content: the engine seeds its own fixture
  world from code (`apps/server/src/engine/fixture/rainy-inn.ts`).
