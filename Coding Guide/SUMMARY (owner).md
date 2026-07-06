I merged the five research chapters and their fact-check verdicts into your five deliverables: the master "AI Coding Guide.md" (rules for the coding agents, each with a plain-language reason and how a machine enforces it), a clean strict tsconfig.json, a complete eslint.config.mjs, a one-page Task Completion Checklist, and the Invariants & Test Templates file.

The most important rules, one line each:
1. Two commands decide "done", not opinions: type-check and lint (plus format, tests, dependency hygiene) must all pass — same commands locally and in CI.
2. The escape hatches AI agents abuse are banned outright: no `any`, no type casts, no thrown-away promises, no empty error-swallowing catch blocks.
3. Every piece of outside data (LLM output, Telegram/WeChat messages, plugins, config, updates, uploads) must pass one Zod v4 safeParse gate before the code trusts it — bypassing the gate fails the build.
4. Dangerous libraries are fenced into single folders (SQLite → storage, AI SDK → llm, Telegram → gateway), so there's only ever one place to audit or swap.
5. Deliberate crashing is the safety strategy: on a detected bug the app exits and restarts from its durable log — and a kill-the-process-repeatedly harness runs in CI forever to prove restarts are safe.
6. Your game's non-negotiables each have a permanent test: the event log can never be edited, jobs can't be lost or duplicated, and prompt prefixes stay byte-stable so caching keeps your token bill ~90% lower.
7. Editing an existing invariant test requires a label only you can apply — an agent cannot quietly "fix" a failing safety test.
8. Every new dependency needs a written justification entry, an exact version pin, and a compatible license, checked by CI.
9. Secrets live only in environment variables; a secret scanner runs on every push (updated to the v3 action — the v2 one the research named is deprecated and would have died in September).

Contradictions I settled: TypeBox is dropped — the protocol package uses Zod v4 for everything (the fact-check proved Fastify now fully supports it, and one schema language can't drift against itself); the chapters' differing folder names were reconciled into one canonical layout; the test runner is Vitest 4 (pinned exactly); the formatter is Prettier; there's one shared Result error convention and no third-party Result library; Rev 4's "LOG" concept is named `trail` in code so it never collides with diagnostic logs; corrupt-data crashes exit with code 3 so you know not to blindly restart.

Things that genuinely need you: (1) the WeChat "official claw bot" library still has to be verified at the gateway milestone — nothing concrete was confirmed; (2) the nightly cache-hit test spends a small amount of real API tokens (~20 turns/night) — say the word if you'd rather run it weekly; (3) TypeScript 6 and AI SDK v7 exist but we deliberately pinned the older, proven majors — they're flagged for your monthly dependency-update review.
