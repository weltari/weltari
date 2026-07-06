# Weltari — Builder Documentation Rules

> [!info] Who this is for
> The **AI builder agents** that implement Weltari (not the stack-selection agent). These rules govern how the codebase documents itself so that (a) future AI agents can navigate it cheaply and correctly, and (b) the owner — not a professional developer — can always understand what exists and how it connects. These rules are binding from the first commit; documentation debt is architecture debt here, because AI agents are the primary maintainers.

---

## 1. Repo-root `CLAUDE.md` — yes, write one, keep it small

Every AI coding session auto-loads the repo's `CLAUDE.md`, so it is the highest-leverage file in the project. Rules:

- **Content:** how to run/build/test (exact commands) · a one-line-per-module architecture map · the project vocabulary pointer ("terms come from Rev 4 §3 — use them exactly") · where the deeper docs live (`docs/`) · the 3–5 conventions that must never be violated (repository layer only — no raw SQL outside repositories; every event carries `actor_id`; prompt builders are stable-prefix ordered; LLM output is never directly durable).
- **Size cap: ~1 page.** It is loaded into every session's context — every token here is paid on every single task, forever. It is an *index with rules*, not a wiki. Anything longer links out to `docs/`.
- Also add a `CLAUDE.md` (or `structure.md`) **per top-level module directory** with: what this module owns, what it may write (its single-writer authority), and what it must never touch. This mirrors the Rev 4 module-contract pattern (§4.4) and doubles as the plugin-facing `structure.md` requirement from Rev 4 §2 P7.

## 2. The product wiki (`docs/`) — module-level, updated in the same commit

The owner wants a wiki explaining what every code file does and how files connect. Build it like this:

- **Structure:** `docs/INDEX.md` (one line per page) → one page per module (`docs/scene-engine.md`, `docs/job-ledger.md`, …). Each module page contains: purpose · the module contract (inputs/tools/outputs/lifecycle/scope, same shape as Rev 4 §4.4) · **a file table: one line per source file** ("what it does, what it talks to") · the module's events consumed/emitted.
- **The one rule that keeps it alive: docs change in the same commit as the code they describe.** A PR that changes a module's behavior or adds/removes a file without touching its docs page is incomplete. Stale docs are worse than no docs — an AI agent will trust and act on them.
- **Do not duplicate the specs.** The wiki explains *the code*; design rationale lives in Rev 4 and the Stack Requirements Brief — link to them, never paraphrase them (paraphrases drift).
- Pages are read on demand (agents open only the page they need), so the wiki can be thorough without a token cost per session — the token discipline applies to `CLAUDE.md`, not to `docs/`.

## 3. In-code notes — constraint comments, agent-judged

Owner's decision, phrased deliberately: agents are told to **"write notes inside the code"** and decide *themselves* where a note is warranted — the word "important" is intentionally not used, so the judgment stays with the writer.

- A note earns its place when it states something **the code cannot say itself**: an invariant ("this must run inside the mailbox — a raw write here races the scene turn"), a non-obvious why ("feather the mask *before* resize; the model returns arbitrary sizes"), a cross-module contract ("this event shape is mirrored in the frontend schema — change both"), or a spec anchor ("Rev 4 §10: speech is never wiki-eligible").
- Never write comments that narrate what the next line does, restate the function name, or talk to a reviewer. If a comment explains *what*, delete it and name the function better; keep comments that explain *why* and *must*.

## 4. Making the database AI-readable (the owner's main worry)

The fear: "AI fails to read a complicated database." The design already dissolves most of this, and three cheap habits close the rest:

1. **Agents never read the database file — they read the schema and the repositories.** The repository layer (Brief §2.7) means every table has exactly one code module that touches it; an agent that wants to know "how do memory deltas work" reads `repositories/memory.*`, which is ordinary documented code. This is the single biggest reason the repository rule must never be bypassed.
2. **The schema is a document.** Keep migrations in plain, ordered SQL files with a comment on **every table and every non-obvious column** ("-- lease_until: worker lease expiry; expired+running ⇒ retryable, Rev 4 §4.2"). Maintain `docs/data-model.md`: one section per table mapping it to its Rev 4 §17 entity, its sole writer, and its projections. An agent reading schema + data-model page understands the database without ever opening it.
3. **Ship dev fixtures:** a tiny seeded example world (`fixtures/`) that agents can load to *look at* real rows when debugging. Inspecting 20 example rows beats guessing from column names.

## 5. Naming: the spec vocabulary is the API

Use Rev 4 §3 glossary terms **exactly** in code identifiers: `mailbox`, `ledger_job`, `cache_entry`, `marker`, `sublocation`, `turn_envelope`, `proposal`, `reflection`. Never invent synonyms (no `queue` for mailbox, no `task` for ledger job, no `poi` for sublocation). This makes spec ↔ code ↔ wiki a single vocabulary, which is the cheapest comprehension aid an AI agent can get: reading the spec *is* reading the code map.

## 6. Types and tests are documentation too

- The shared **event/command schema** (the protocol types) is the master document of the system's behavior — every event type gets a doc-comment (when emitted, by whom, consumed by whom). External clients, the CLI, and the wiki all derive from it.
- Every hard constraint in Brief §2 gets at least one **test that fails loudly when violated** (e.g. a test that greps for SQL outside `repositories/`; a kill-during-turn recovery test). For an AI-maintained codebase, tests are the enforcement arm of the docs: a rule without a failing test will eventually be broken politely and confidently.

---

> [!note] Summary for the owner
> Yes — a root `CLAUDE.md` is exactly the right call and is standard practice; the real craft is keeping it one page and pushing depth into `docs/` pages that agents open only when needed (that's the token answer). Your database worry is handled structurally: agents read schema + repositories, not database files — that's a benefit the repository layer was already buying you. And your instinct on comments is correct as phrased: "write notes inside the code," writer decides where.
