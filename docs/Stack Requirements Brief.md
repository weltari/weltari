<h1 align="center"><code>Weltari — Stack Requirements Brief <span style="color:#0080ff;">●</span></code></h1>

> [!info] Document status
> **DRAFT.** Requirements only — this document deliberately names **no languages and no frameworks**. It is the self-contained input for the stack-selection session; a stack engineer or an AI agent should be able to work from it without reading the full [Rev 4 spec](<Weltari V1 - Architecture & Structure (Rev 4).md>). Section references (§) point into Rev 4.

---

## 1. Runtime Shape

- **Single container, single process, single user** (V1). Local-first, self-hosted, SillyTavern-style distribution. (§1)
- **SQLite in WAL mode** is the store; **image pixels live as files on disk** (rows hold path + hash). (§1, §14)
- Designed **always-online**: users run it unattended on a NAS/VPS/home box (can run on windows / macOS in background too, but home box are the common case here) with the messenger gateway plugged in; the process must be safe to `kill -9` at any moment. (§13, §16)
- Multiplayer is V2, but three multiplayer-proofing constraints are baked in now: `actor_id` on every event, server-pushed event stream, repository layer. (§1)
- **Targets (Phase-2 decisions):** Windows, macOS, Linux and Docker releases; trivially easy deploy on Windows/macOS/Docker; **~256 MB RAM as the typical target** (may grow when the user installs heavy plugins — plugins spend the headroom, not the core); **self-update as a lightweight check, not a resident updater** — check on startup + periodic CRON, in-UI "update available" notice is the floor, one-click apply only where the platform makes it cheap (see Q6), never a framework that costs meaningful resident RAM; mobile browser support with a dedicated mobile UI.
- **CLI client (owner decision, 2026-07-06 — V1.5, not V1):** a terminal client ships after the GUI, once the event protocol stabilizes. Scoped feature set: Stream-mode scenes (Enter = sentence advance), chat, ASCII map drawn from the data layer with arrow-key navigation, Proposal diffs with y/n approval, config basics, cold-boot onboarding over SSH. VN mode, social feed and wiki browser are out of CLI scope. **V1 implication (binding now):** the protocol must be terminal-consumable — no browser-only assumptions.
- **Engine-as-a-service (owner decision, 2026-07-06):** the frontend/backend split is also an *engine boundary* — future external games must be able to plug into a running Weltari engine (over the same event stream + command API) to power their NPCs. This is Rev 4's deferred "API-level extensibility" (§18): V1 does not build it, but **must not foreclose it** — the built-in frontend must remain "just another client" of a documented, versioned, language-neutral (JSON) protocol with no private side-channels. (§1, §2 P11, §18)

## 2. Hard Constraints (implementer must not violate — Rev 4 refs)

1. **Event log is the source of truth; everything else is a rebuildable projection** (memory, wiki, CACHE, map overlays, engagement). Rendered artifacts are never truth. (§2 P1, §4.3)
2. **Job Ledger for all cold-path work:** durable job rows with states (`pending→running→committed/failed/parked`), **idempotency keys, leases, retries, dead-letter lane, per-world concurrency rules** (World Agent = 1 per world). Jobs are idempotent projections of the immutable log — no rollback, saga-style. (§4.2, §4.5, §10, §17)
3. **Single writer per entity — per-character mailboxes:** all durable writes to one character's state serialize through its mailbox (CACHE, memory deltas, social memory, location). Optimistic `version` columns are the backstop elsewhere. (§2 P4, §4.2)
4. **Crash-only recovery: the recovery path *is* the startup path.** Intent is durable before work happens (turn envelopes, atomic `scene.ended`+job enqueue, painter composite-on-success). Graceful shutdown is an optimization, never a correctness requirement. (§2 P5, §16)
5. **Server-pushed event stream; frontend renders only.** One persistent connection carries streaming narration, typing indicators, CRON arrivals, gateway echoes, backpack updates — on any page. The frontend holds zero game logic and never polls. (§1, §2 P11, §5)
6. **Prompt-prefix ordering in every context assembler:** stable-first (skills → personality → memory core → goals), dynamic tail last, so provider prompt caching hits. Binding for every prompt builder — retrofit means rewriting all of them. (§2 P9, §16)
7. **Repository layer over storage:** modules call repositories (`event_log.append(...)`), never raw SQL — caps the future SQLite→Postgres swap at "write a driver". (§1, §4.3)
8. **`actor_id` on every event, proposal and profile** — no module may assume a singleton user. (§1, §17)
9. **Proposal pipeline for all consent-gated mutation:** one uniform `Proposal{action, diff, rationale, approvers[]}` object → frontend renders diff → engine applies on approval → both logged as events. (§2 P10, §16)
10. Corollaries the stack must support cheaply: **LLM output is never directly durable** (engine validates every tool call) (§4.5); **knowledge-tier filtering and a private character channel** in context assembly (§7, §10); **monotonic engine-owned world clock** driving TTLs and replay (§16).

## 3. Integration Inventory

| Integration | Requirement | Ref |
|---|---|---|
| **Text LLMs** | OpenRouter-style and customisable plug-and-play endpoints; **per-character** model/params/endpoint config; **per-function routing** (narrator-class vs router-class models); streaming token output; prompt-cache-friendly calls. | §15, §16 |
| **Image backends** | Capability-routed: **mask-capable** (FLUX Fill, gpt-image-2) vs **mask-free** (region-in-words); code always composites back; ~1024×1024 square crops; long-running jobs behind the ledger. User-configurable, any community model. | §14 |
| **VLM** | Vision-language classification of map crops → structured JSON, on Flow B jump-in. Or a LLM that supports vision input. | §14 |
| **Telegram / WeChat bots** | Bidirectional gateway, **both channels in V1, both outbound-only (NAT-first)**: Telegram via long-polling; WeChat via a Hermes-style personal-account bridge (QR pairing, ToS-fragile → must be a swappable connector). Eager-generated pushes out; **deduplicated** return-path ingestion (messengers redeliver — key on message IDs); same `conversation_id` as in-app chat. Rate limits at implementation. | §13, §19, §7 c |
| **Browser notifications** | Required, since V1 ships an HTML/CSS frontend (Phase-2 decision) — gateway bridge lists it as a connector target. | §4.2 |
| **FTS5** | SQLite FTS5 (BM25) behind a `SearchIndex` repository interface; embedding retrieval (e.g. BGE-M3) must be a drop-in upgrade. | §4.2, §11 |

## 4. Workload Profile

- **Hot path (scene turn):** 3–5 **sequential** LLM calls worst case (Narrator → character → character query → narration); single-threaded by design; streamed to the client sentence-by-sentence. (§6, §16)
- **Concurrent with the hot path:** parallel **reflection fan-out** at scene end (one job per participant) alongside one World Agent job; **painter jobs** (long-running image generation, region-locked, survive interruption); **CRON** (movement, marker drops, social posts, eager gateway DMs, TTL sweeps, compactions, profile analysis). New-scene opens block only on *that world + involved characters'* pending jobs. (§4.5, §6, §14)
- **Time-skip replay bursts:** all due CRON instances in scheduled-game-timestamp order; code-class instantly, LLM-class in background under a per-skip budget (default ~10). (§14, §16)
- **Unbounded growth:** the append-only **event log**; **map pixels on disk** (outpainting grows forever); **memory deltas** (append-only, compacted but never overwritten). Retention/pruning exists only for CACHE and GC-swept objects. (§11, §14)
- **Context sizes:** character-class models need **256K min (1M max predicted)** context; engine warns the Narrator 5K before budget. (§6)
- **Kill -9 at any moment** must be survivable at every point in the table in §16 (mid-turn, between scene-end and commits, mid-reflection, mid-painter, mid-CRON, client disconnect).

## 5. UI-Driven Demands (constrain the frontend choice)

- **Streaming, sentence-by-sentence narration** with click/Auto-Advance pacing and **interrupt-anywhere** (turn envelope closes at the interruption point). (§5.3, §6)
- **VN character line-ups**: 1 centered / 2–5 animated line-up with speaker rise / >5 forces Stream mode; engine-validated **art switching**. (§5.3)
- **Pannable map** with grid fog (faint borders, hover overlay, click-to-Explore), overlay pins anchored to world coordinates, cluster collapse, **lasso/pencil drawing**, **per-square loading spinners** during materialization. (§14)
- **The map renderer is a pluggable frontend component** (owner decision, 2026-07-06): geometry, fog state, markers, placement and pixels remain backend-owned truth (§14 — "code owns all geometry"); the *rendering* consumes documented map connectors/events, so third-party developers (or plugging-in games) can replace the map UI wholesale.
- **Backdrop slide transitions** (PowerPoint-like) on sublocation change. (§6)
- **Per-world theming/reskinning** (recolor, re-font, restyle) and a **plugin-editable frontend** — plugin-level ease is a V1 requirement, ideally editable by third-party AI agents via `structure.md`/`skill.md`. (§2 P7)
- **Live projections:** backpack updates in the same frame as narration; day/night + weather overlays read engine state. (§7, §16)
- **Mobile browser support with a dedicated mobile UI** (Phase-2 decision).
- **Dev mode** (owner decision, 2026-07-06 — V1 requirement): a toggle that surfaces the log-only trail (agent thinking, tool calls, raw attempts, CACHE writes) inline in Scene/Chat/group chats for debugging. Display-only — agents' contexts are untouched. Stack implication: the event stream carries a **dev channel** of log-only events when enabled.
- Full binding list + per-surface inventory: see [UI Spec (skeleton)](<UI Spec (skeleton).md>).

## 6. Decided vs. Open (per Rev 4)

**Already fixed:** SQLite (WAL) · FTS5 behind `SearchIndex` · single container/process · repository layer · event log + job ledger + mailboxes · `actor_id` · server-pushed event stream · proposal pipeline · crash-only design · capability-routed image pipeline · per-character/per-function model routing.

**Explicitly left open (the stack session's job):** orchestration framework (e.g. graph-framework vs custom loop — Rev 4 front-matter) · **WebSocket vs SSE** (§1) · frontend framework (§2 P7 only demands plugin-ease) · backend language · plugin packaging format (§19) · exact API schemas.

## 7. My Answers (Phase 2 interview)

- **(a) Targets & envelope:** Windows, macOS, Linux, Docker — separate releases; V1 frontend is HTML/CSS ("almost certainly"). Must be *easy* to deploy on Windows/macOS/Docker because the app is designed always-online (gateway plugged in). **RAM ≈ 256 MB when possible.**
- **(b) Language priorities (ranked):** **LLM-ecosystem maturity > plugin-authoring ease > owner familiarity > single-binary/small-RAM distribution.** Consequences: Docker-first release posture is acceptable, the ~256 MB envelope is a target rather than a gate, and Q1 must be answered by optimizing the top two axes. Naming languages stays out of scope for this document.
- **(c) Gateway network reality (from Hermes-precedent research):** Hermes runs a fully bidirectional Telegram gateway with **zero public ingress** — the host firewall admits only SSH, no tunnel route exists for messaging, so inbound Telegram traffic can only arrive via **outbound long-polling** (getUpdates-style); its WeChat path is an unofficial pairing-based personal-account bridge, also outbound-only. Even on a public VPS the operator chose the closed-port posture. **Requirement derived:** the gateway must work purely behind NAT — **long-polling is the baseline for Telegram; webhook + tunnel/public endpoint is an optional optimization, never a requirement.** **Owner decision (2026-07-06): WeChat ships in V1 via a Hermes-style personal-account bridge** (outbound-only pairing, no public endpoint) — because typical self-hosters have outbound internet + optional Cloudflare-Tunnel inbound only, never a public IP. The *official* WeChat platform (public HTTPS callback, no polling mode) is explicitly not the V1 mechanism. Known trade-off, accepted: personal-account bridges are unofficial and ToS-fragile — the gateway module must treat WeChat connectivity as a swappable connector so a bridge breakage never blocks the core or the Telegram channel.
- **(d) Latency & cost targets:** time-to-first-content **5–10 s max** in a scene turn (UI covers it; then streaming begins) and **5–10 s** in chat. Token assumptions: **200K–500K per scene**, **1–5M per day** for a normal user playing 1–2 h/day — with an explicit mandate to *minimize* consumption (prompt caching, router-class models, pre-retrieval).
- **(e) Non-negotiables:** license **decided — AGPLv3 core + CLA for all outside contributions + MIT-licensed edges**: the plugin API/SDK **and** (added with the engine-as-a-service decision, §1) the client protocol schema + official client SDKs, with an explicit clarification that plugins and programs interacting solely through the documented network API are not derivative works. Rationale: AGPL deters third-party commercialization of the engine (network clause covers hosted forks); the CLA preserves the owner's sole relicensing/dual-licensing rights (commercial licenses for studios that bundle or can't accept AGPL); the MIT edges keep plugin authors and external game developers unafraid of copyleft. **Cloud dependencies are acceptable** (target users run on NAS/VPS, always on). **The app must self-update.** **Mobile browser support is required** with a dedicated mobile UI.

## 8. Open Questions for the Stack Session

Each is phrased so the session can answer with one concrete choice.

1. **Backend language:** given the owner's ranking — **ecosystem > plugins > familiarity > distribution** (see §7 b) — which language is it?
2. **Orchestration:** adopt an agent-orchestration framework or write the custom Scene-Engine loop by hand? (Rev 4 leans custom — the engine is a plain state machine + router; decide and name it.)
3. **Event stream transport:** WebSocket or SSE (+POST) — decide against the requirements: bidirectional input path, reconnect/replay semantics, proxy/NAS friendliness, mobile browser behavior, **and consumability by future external game clients and the V1.5 terminal client** (engine-as-a-service + CLI, §1). Decide too how the event/command schema is documented and versioned so non-JS clients can generate bindings.
4. **Frontend stack:** which framework/approach delivers the §5 demands (VN animation, map canvas with fog/lasso, streaming text) while staying **plugin-editable and per-world reskinnable** and shipping a dedicated mobile layout?
5. **Map rendering technology:** DOM/CSS grid vs canvas vs WebGL for the pannable fog-grid map with pins, lasso and per-square spinners?
6. **Packaging & self-update:** what is the release artifact per platform (Windows/macOS/Linux/Docker), and — given the decided baseline (startup + CRON update *check* with in-UI notice, zero resident-RAM updaters) — what is the *apply* mechanism per platform: download-and-swap-on-restart for native releases vs notify-and-let-host-pull (or an optional auto-pull sidecar) for Docker?
7. **Plugin packaging format:** what a plugin *is* on disk, how it registers (frontend themes + skills + agents), and its provenance metadata (source + hash). (§19)
8. **SQLite access pattern:** which driver/mode gives WAL + single-writer discipline + safe concurrent readers in one process, and how are repository transactions scoped?
9. **Job runner shape:** how are ledger workers scheduled inside the single process (worker pool sizing for reflections/painter/CRON) while keeping the 256 MB envelope?
10. ~~**Gateway connectivity**~~ **Resolved:** Telegram = long-polling; WeChat = Hermes-style personal-account bridge, both outbound-only, both V1 (§7 c). Remaining stack-session task: pick the concrete bridge library/mechanism for WeChat and the connector abstraction that keeps it swappable.
11. ~~**License**~~ **Resolved:** AGPLv3 core + CLA + MIT edges (plugin API **and** client protocol/SDKs) (§7 e). Remaining stack-session tasks: pick the CLA tooling (e.g. a PR-gating CLA bot), write the plugin-exception and network-client clarification clauses, and decide which repo artifacts fall on the MIT side (schema files, client SDK, plugin SDK).
12. **Browser notification mechanism:** which push approach works for a self-hosted app (service-worker Web Push needs HTTPS — decide how that interacts with Q10's networking choice)?

---

> [!note] Out of scope here
> Anything naming a concrete language, framework, or library as a *choice* (rather than as an example already in Rev 4) belongs to the stack session, not this brief.
