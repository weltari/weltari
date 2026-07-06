Read "D:\devproj\weltari\Weltari V1 - Architecture & Structure (Rev 4).md" in full.

Your task: produce a "Stack Requirements Brief" (new file, "D:\devproj\weltari\Stack Requirements Brief.md", 2–3 pages max) that a stack engineer and an AI agent can read WITHOUT reading the full spec. This session decides requirements only — do NOT propose or discuss any concrete stack choices (no languages, no frameworks); flag anything that drifts that way as out of scope.

Work in three phases:

PHASE 1 — Extract from Rev 4:

1. Runtime shape: single container, single process, single user, SQLite WAL, local-first self-hosted.

2. Hard constraints an implementer must not violate — each with its section reference: event log as source of truth + projections; ledger job idempotency/leases/per-world concurrency; single-writer mailboxes; crash-only recovery (recovery path = startup path); server-pushed event stream, frontend renders only; prompt-prefix ordering for cache hits; repository layer over storage; actor_id everywhere; proposal pipeline.

3. Integration inventory: OpenRouter-style text LLMs (per-character +per-function routing), image backends (mask-capable + mask-free, capability routing), VLM, Telegram/WeChat bots (bidirectional, deduplicated), browser notification if decided to go with HTML CSS, and FTS5.

4. Workload profile: what runs concurrently (scene hot path 3–5 sequential LLM calls, parallel reflection fan-out, painter jobs, CRON), what grows unboundedly (event log, map pixels on disk, memory deltas), what must survive kill -9 at any moment.

5. UI-driven demands (these constrain the frontend choice): streaming sentence-by-sentence narration with interrupt; VN character line-ups and art switching; pannable map with grid fog, hover/click states, overlay pins, lasso drawing, per-square loading spinners; backdrop slide transitions; per-world theming/reskinning; plugin-editable frontend.

6. Decided vs. open: list what Rev 4 already fixes (SQLite, FTS5, container, repository layer) vs. what it explicitly leaves open (orchestration framework, WS vs SSE, frontend framework, backend language).

PHASE 2 — Interview me for the questions left or the decisions that have to be made by me. These are NOT in the spec and only I can answer; ask me with the trade-off each answer drives. Before you ask, I have aleady given answer to some of the listed questions (A:)

a. Target hardware + OS for self-hosters (my dev machine AND the typical user's box), and rough RAM/disk envelope.
A: Target hardware is Windows, MacOS, linux and Docker. Different releases, but V1 will almost have a HTML CSS frontend. Since this world is designed to be always-online since you will plug it in gateway, this must be easy to deploy on windows Macos and docker for easy hosting. RAM is expected to be at about 256MB when possible.

b. Backend language priorities: LLM ecosystem maturity vs. easy plugin authoring vs. single-binary distribution vs. my own familiarity — rank them (do not pick a language).
A: Tell me what is the difference and trade off of different languages for my use case.

c. Gateway network reality: is requiring a tunnel/public endpoint acceptable for gateway users, or must it work purely behind NAT (polling)?
A: Research (you can fan out sonnet 5 subagents) on how hermes agent works around with gateway. Then return me the results.

d. Latency + cost targets as numbers: acceptable time-to-first-sentence in a scene turn; rough per-scene and per-day token budget assumptions.
A: Since UI can cover most of the loading time, the actual wait time should be around 5 - 10 seconds max inside the scene, (Then the content begin to stream.) 5 - 10 seconds for the chat module.  
Per-scene token lands at 200k - 500k, per day 1 - 5M for normal users that spend 1 - 2 hour playing with the app per day. But we should minimize the token consumption.

e. Non-negotiable (licensing, no cloud dependencies, mobile browser support, etc.).
A: The license that allows open core and no one else to commercialise my product. I am looking into APGL. Cloud dependencies is ok, since most user will run this on NAS / VPS without shutting it down. The app must be able to update itself.
Mobile browser support is required. A UI will be designed specificly for it.

PHASE 3 — Write the brief with sections: Runtime Shape · Hard Constraints (with Rev 3 refs) · Integrations · Workload Profile · UI Demands · Decided vs. Open · My Answers (from Phase 2) · Open Questions for the Stack Session. Every open question should be phrased so the stack session can answer it with a concrete choice.


Also create "D:\devproj\weltari\UI Spec (skeleton).md": section 1 fully written (binding constraints imported from Rev 4, with links), then a stubbed per-surface inventory (World page, Scene VN/Stream, Map, Chat, Field, Wiki, Config, cold-boot onboarding) listing for each only: purpose, key states, event-stream bindings. No visual design yet; i will then later edit and expand that document, with some prototype screenshot or code I draw / created in figma.

Show me both drafts for review before finalizing. Anything that i still didn't state clear before we begin?