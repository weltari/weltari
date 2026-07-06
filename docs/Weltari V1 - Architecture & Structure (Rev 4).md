
<h1 align="center"><code>Weltari <span style="color:#0080ff;">●</span></code></h1>

> [!info] Document status
> This is the **V1 structure/architecture spec** for Weltari, **Revision 4**. It supersedes Rev 1/2 and incorporates the full structural review: event-sourced logging, the Job Ledger, the Scene Engine / Narrator split, per-entity single-writer concurrency, the knowledge-tier model with **source-typed observability**, the **Object & Backpack system**, the **world clock**, the **sublocation creation & materialization pipeline**, lazy-loaded map events with CRON governance, VN-style pacing, gateway caps, crash-only recovery, and multiplayer-readiness constraints.
>
> It remains intentionally **conceptual**: it defines modules, contracts, lifecycles and data shapes, but leaves concrete tech-stack choices (framework, exact API schemas, LangGraph vs. custom orchestration) to the implementation phase. Anything not yet decided is marked `> [!todo]`.
>
> **V1 focus:** frontend experience + the agent/data backbone behind it — Map, Narrator Scene, Direct Messaging, Social Media, and the Gateway. Deep drama mechanics (resolve loop, FEL/DES, inter-agent comms, multiplayer) are deferred — see [§18](#18-v1-scope-vs-deferred-v2v3).

---

## 1. Overview & Vision

**Weltari is an agentic roleplay / gameplay engine.** The user joins a persistent, stateful **world** and roams it freely — closer to an **open-world life-sim (think Stardew Valley)** than a galgame. The world keeps living when the user isn't looking: characters move between sublocations (CRON-driven in V1), post to a social feed, and reach out on their own. It is conceptually similar to SillyTavern, but with three defining differences:

1. **A cleaner, app-like UI** — visual-novel scenes, a whatsapp-style chat, a living map, a social feed.
2. **An agentic Narrator** that *drives* scenes (introduces, builds tension, moves the story forward) instead of just answering, and orchestrates characters as independent subagents.
3. **Strict Narrator ⇄ Character separation.** Characters are independent subagents with their own memories, personalities, goals — and **secrets**. The Narrator owns the scene; it never *is* a character, it *calls* them.

The world is **persisted and stateful**: generated content, memories, and wiki facts are saved, not recomputed. The story emerges from the interaction of separate agents over a shared, durable world state.

### Deployment model (decided)

**V1 is local-first, single-user, self-hosted** — SillyTavern-style, shipped as a container. One process, one user, SQLite as the store.

**Multiplayer (co-present users in shared worlds and shared scenes) is V2.** To avoid a rewrite, V1 bakes in three multiplayer-proofing constraints *now* (they are cheap today, brutal to retrofit):

1. **`actor_id` on every event.** No module may assume "the user" is a singleton; every event, proposal, and profile is keyed by an actor (user or agent).
2. **The frontend is a consumer of a server-pushed event stream** (WebSocket/SSE — a persistent connection over which the backend pushes updates), never a poller. V1 needs this anyway for streaming narration, typing indicators, and CRON messages arriving on any page.
3. **Storage behind a repository layer** (a code layer that owns all database access per entity — modules call `event_log.append(...)`, never raw SQL). This caps the future SQLite→Postgres swap at "write a driver."

---

## 2. Architectural Principles

Binding constraints for every module in this document.

1. **The Event Log is the source of truth.** Everything that happens is an append-only event. All other state — memory, wiki, CACHE, map bubbles, engagement signals, world truth — is a **projection**: a derived view computed from events, rebuildable and repairable. Rendered artifacts (a map image, a chat bubble) are never truth.
2. **The LLM proposes; the engine validates and commits.** Deterministic code (the Scene Engine and friends) owns all bookkeeping: session boundaries, presence, turn order, geometry, IDs, state transitions. Agents invoke tools; the engine checks validity and executes. (Same philosophy as the map: *code owns all geometry, the AI only fills pixels.*)
3. **Durable change happens only through the Job Ledger or an engine-validated event.** Cold-path commits (reflection, World Agent, painter, CRON) are ledger jobs: durable, idempotent, retryable. The narrow hot-path exceptions (character location changes, object holder/payload events, sublocation identity stubs) are engine-committed events, never raw LLM writes.
4. **Single writer per entity.** Every character's durable state has exactly one serialized writer (its **mailbox**). The World Agent is the sole wiki/truth writer (GM writes truth only via user consent with hard code "allow" option in UI or CLI, like claude code). Map geometry is written only by map code. Optimistic versioning (every mutable row carries a version number; writes fail cleanly if stale) is the backstop for anything that can't route through a mailbox.
5. **Crash-only design.** The recovery path *is* the startup path. Intent is written before work happens; the app is always safe to kill. There is no state that only survives a "clean" shutdown. (See [§16](#16-cross-cutting-concerns).)
6. **Scopes are named explicitly.** For every piece of state, the contract states: who can know it (knowledge tier), who can write it (single writer), who must approve it (proposal routing), and who is present (session participants). Implicit singletons ("the user", "the scene") are forbidden.
7. **Heavy modularity / plugin-first.** Every agent and store is a self-contained module with a clean contract. Swappable without touching others. Community plugins are a headline feature; plugin-level ease is a V1 requirement (API-level extensibility is not). If possible, even a structure.md and skill.md for third party AI Agent (like claude code) to directly edit and write plugins. espcially frontend, it must be easy to change, recolor, change font to fit the current world style.
8. **Skills, not hardcoded prose.** Agent behavior lives in editable skill modules. Skills describe *how to use* tools; they can never *grant* tools — tools are granted by the engine per module contract. Injected skill text carries **provenance** (core / user / community, with source hash) in the context assembler — labeling only in V1, no enforcement.
9. **Prompt-prefix ordering.** Every agent prompt is assembled *stable-first* (skills → personality → memory core → goals) with dynamic context and latest turns last, so prompt caching (provider-side reuse of identical prompt prefixes at ~10% cost) works. This is a binding contract rule for every context assembler, because retrofitting it means rewriting every prompt builder.
10. **User consent gates world mutation** — via one uniform **Proposal pipeline** ([§16](#16-cross-cutting-concerns)), not per-tool conventions.
11. **Backend talks, frontend shows.** All inter-module logic is backend. The frontend renders the event stream and captures input; it contains no game logic.
12. **Structured state for code, prose for models.** Structured fields are legitimate when *code* consumes them (the world clock, holder pointers, subgoal snapshots, presence). They are forbidden when they compress semantic meaning into keys/enums that only LLMs produce and interpret (no fact key-value systems, no flag vocabularies, no access enums). Where an LLM is the consumer, the field is prose.

---

## 3. Glossary

| Term                    | Definition                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **World**               | A persistent, self-contained setting the user joins. Has its own characters, map, wiki, and storytelling config.                                                                                                                                                                                                                                                                                                |
| **Chapter**             | A higher-order story arc within a world. Carries a **seed** + **style investments** + story goals. *Injected to the Narrator only — never to characters.                                                                                                                                                                                                                                                        |
| **Scene**               | An immersive RP encounter the Narrator drives, based on a **sublocation**. Narrator can change the sublocation inside a scene when it thinks that everyone is moving to it. Contains one or more sessions.                                                                                                                                                                                                      |
| **Session**             | A unit *inside* a scene bounded by **participant** join/leave (participant = character *or, in V2, users too*). It contains only exposed scene content — **the Narrator's narration plus verbatim speech** — never character thinking and never raw `attempt` text (the Narrator narrates an attempt's *observable surface*; the raw attempt is log-only). It is the unit a participant can selectively recall. |
| **Sublocation**         | The **atomic point unit** of place. At largest, the largest atomic thing inside a city — a building, a street, a bridge, a park — **never** a region/district/town, because a sublocation lands as a **single point** on the map. Two classes: **exterior-atomic** (a map point) and **interior** (parents directly to its exterior-atomic location — flat, one level: the storage room's parent is the café, not the kitchen; the Narrator decides which atomic location owns it). Litmus test: **one sublocation = one backdrop image**. Exists as an identity **stub** until **materialized**. Scopes wiki *relevance* and scene context ([§14](#14-map-system-and-cron)).                                                                                                                                                                                                                                                    |
| **Materialization**     | The cold path giving an exterior-atomic stub its map presence (fog grid square, geometry, pixels) via the `materialize_sublocation` ledger job — **eagerly enqueued the moment a parentless stub is created**; reuses the painter pipeline + region locks ([§14](#14-map-system-and-cron)). Backdrop images are separate: generated immediately at creation for *every* new sublocation (parented or not), so in-scene switching stays fluid.                                              |
| **Event Log**           | The append-only record of everything that happens. Source of truth; all stores are projections of it.                                                                                                                                                                                                                                                                                                           |
| **Job Ledger**          | Durable table of work items (`pending → running → committed / failed`) with retries and idempotency keys. Runs reflections, World Agent, painter jobs, CRON, compaction, marker expiry.                                                                                                                                                                                                                         |
| **Scene Engine**        | Deterministic code owning scene bookkeeping: sessions, presence, turn envelopes, turn budgets, tool validation, subgoal-state persistence. The Narrator's tools are Scene Engine functions.                                                                                                                                                                                                                     |
| **Mailbox**             | Per-character serialized command queue. All durable writes to one character's state pass through its mailbox, one at a time.                                                                                                                                                                                                                                                                                    |
| **Projection**          | Derived state computed from events (memory, wiki, CACHE view, map overlay…). Rebuildable.                                                                                                                                                                                                                                                                                                                       |
| **Actor**               | Whoever caused an event: a user or an agent. Every event carries an `actor_id`.                                                                                                                                                                                                                                                                                                                                 |
| **Fact**                | A description of the **observable-now state** of the world (a place, an object's visible surface, an organism, the aftermath of a public event) worth recording in the **wiki**. Never speech-sourced, never an event transcript ([§10](#10-world-agent)).                                                                                                                                                      |
| **Wiki**                | World-knowledge store. **Open wiki** (common knowledge) and **Sublocation wiki** (injected only when contextually there — a *relevance* scope, not a secrecy mechanism). Written only by the World Agent.                                                                                                                                                                                                       |
| **World TRUTH (W-DB)**  | Authoritative ground-truth of the world. The wiki is its *knowable/observed* projection. Written by the World Agent (scene-end deltas) and the GM (consent-gated).                                                                                                                                                                                                                                              |
| **Knowledge tier**      | Who can know a piece of information: open wiki → sublocation wiki → session log (participants only) → character memory (one character). See [§10](#10-world-agent).                                                                                                                                                                                                                                             |
| **CACHE**               | A per-character, private 1–2 line "what just happened to me" recap, written every trigger. A **pointer**, not the recall mechanism. One append-only store per character; entries carry `origin`. No flags, no keys ([§11](#11-memory--cache-model)).                                                                                                                                                            |
| **Memory**              | A character's durable, curated subjective recall, committed as **append-only deltas** by Reflection, compacted periodically.                                                                                                                                                                                                                                                                                    |
| **Secret**              | Memory/knowledge private to one character. Held by *choice in private deliberation* ("saying this would be bad for me"), not by refusal lines. The reason characters are separate subagents.                                                                                                                                                                                                                    |
| **Marker (event drop)** | A lazy intent placed on the map ("!" bubble) or in chat (message bubble). Stores only metadata + premise; **content generates on click**, with precondition re-validation and TTL expiry. TTLs are expressed in **game time**. The map always holds **1–5 live chance-encounter markers** ([§8](#8-messaging-system-chat), [§14](#14-map-system)).                                                              |
| **Object**              | A durable item row, materialized only on interaction with durable consequence. `{id, world_id, name, holder, payload, version}`. Holder ∈ {sublocation, character, user} in V1 ([§14](#14-map-system)).                                                                                                                                                                                                         |
| **Backpack**            | A character's or the user's private item space — simply the set of objects whose holder is that actor. **Owner-exclusive by engine rule** (backpack = secret; sublocation-held = public). Characters are told space is "limited but you can't know how much" — deliberate scarcity pressure so only narratively important things become objects ([§7](#7-character-system--c-module)).                          |
| **World clock**         | Engine-owned fictional `{date, time}` in W-DB. **Monotonic** (forward only). Injected into Narrator and character prompts; drives weather, day/night UI, TTLs, CRON scheduling, and user time-skips ([§16](#16-cross-cutting-concerns)).                                                                                                                                                                        |
| **Outreach thread**     | A character's proactive-DM state toward the user: unanswered pushes are counted; hard cap 3, then the thread **freezes** until the user replies ([§8](#8-messaging-system-chat)).                                                                                                                                                                                                                               |
| **Turn envelope**       | Engine events `turn_open` / `turn_close` wrapping each hot-path turn, so recovery can void in-flight turns cleanly.                                                                                                                                                                                                                                                                                             |
| **Goal / Subgoal**      | Storytelling objectives. The Narrator decomposes goals into subgoals; the engine persists subgoal progress as scene state.                                                                                                                                                                                                                                                                                      |
| **Skill**               | An editable instruction module teaching an agent behavior/tool use. Primary extensibility + product-self-knowledge surface. Cannot grant tools.                                                                                                                                                                                                                                                                 |
| **Proposal**            | The uniform consent object: `{action, diff, rationale, approvers[]}`. Any consent-gated mutation flows through it ([§16](#16-cross-cutting-concerns)).                                                                                                                                                                                                                                                          |

---

## 4. System Architecture

### 4.1 Agents (LLM modules)

| Agent                    | Role                                                                                                                                                                                                                  | Lives in                            |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| **Narrator**             | Scene-scoped creative agent. Drives the scene: narrates, advances story goals, decides whom to call, requests joins/leaves/art via engine tools. **Reads** world truth + wiki; **writes nothing durable directly.**   | [§6](#6-scene-system)               |
| **Character (C-Module)** | A character as a subagent (separate API session). Own skills, memory, personality, goals, secrets. Replies via tools. Reasoning is a **private channel by contract** — never injected into any other agent's context. | [§7](#7-character-system--c-module) |
| **GM**                   | Separate meta-agent. Consent-gated world authoring (via Proposals) + user profiling. Frontend persona "GM"; different backend prompt.                                                                                 | [§9](#9-gm-agent)                   |
| **World Agent**          | Post-scene ledger job: summarizes, writes wiki entries **and world-truth deltas**, reports engagement to GM. Sole normal-path writer of wiki/truth.                                                                   | [§10](#10-world-agent)              |
| **Group-chat Narrator**  | Lightweight router for group messaging. **NO NARRATION** — routes turns under a hard turn budget.                                                                                                                     | [§8](#8-messaging-system-chat)      |
| **Character Reflection** | Post-session (and post-chat) ledger job: commits a character's memory deltas from session/chat history.                                                                                                               | [§11](#11-memory--cache-model)      |

### 4.2 Engine modules (deterministic code — NEW in Rev 2)

| Module                | Role                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Scene Engine**      | State machine for scenes: opens/closes sessions on participant join/leave, assigns all IDs, validates every Narrator tool call (e.g., rejects `charactercall` on an absent character), enforces turn budgets, wraps turns in envelopes, persists subgoal state, manages presence (`available / in_scene`), handles resume + re-grounding.                                               |
| **Job Ledger**        | Durable job queue with states, retries, leases, idempotency keys, dead-letter lane, and per-world concurrency rules (e.g., World Agent jobs serialize per world). Runs: reflections, World Agent, painter, sublocation materialization ([§14](#14-map-system-and-cron)), CRON drops, eager gateway generation, compaction, marker expiry, profile analysis.                                                                                           |
| **Event Log**         | Append-only store of all events, each with `actor_id`, timestamps, and provenance. The write path for everything.                                                                                                                                                                                                                                                                       |
| **Mailboxes**         | Per-character serialized writers for CACHE entries, memory deltas, social-memory updates, location changes.                                                                                                                                                                                                                                                                             |
| **Context Assembler** | Builds every agent prompt: stable-prefix ordering, knowledge-tier filtering, provenance tagging, pre-retrieval of likely wiki/memory snippets via the Search Index.                                                                                                                                                                                                                     |
| **Search Index**      | Full-text retrieval over memory deltas, wiki, and recaps. **V1: SQLite FTS5** (built-in full-text search, BM25 keyword ranking — zero extra dependencies), behind a `SearchIndex` repository interface so embedding retrieval (e.g., BGE-M3) is a drop-in upgrade if recall provably hurts in playtesting. Queries are written by LLMs, which generate good keyword variants naturally. |
| **World Clock**       | Engine-owned time authority: advances the clock, validates user skips (≤48h, forward-only, never during an active scene), stamps TTLs, and drives time-skip catch-up replay ([§16](#16-cross-cutting-concerns)).                                                                                                                                                                        |
| **Proposal pipeline** | Uniform consent flow: agent emits Proposal → frontend renders diff → approval applies via engine → event logged.                                                                                                                                                                                                                                                                        |
| **CRON scheduler**    | Fires scheduled jobs into the ledger: social posts, proactive DM drops, character movement, marker TTL sweeps.                                                                                                                                                                                                                                                                          |
| **Gateway bridge**    | Telegram/WeChat/Browser notification connector: eager-generation trigger, push, return-path ingestion with dedup.                                                                                                                                                                                                                                                                       |


### 4.3 Data stores (all projections of the Event Log unless noted)

| Store                            | Holds                                                                                                                                                                                                                                                                                                     | Authoritative for                                                               | Sole writer                                                                                                                                    |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Event Log**                    | Every event (turns, joins/leaves, commits, proposals, location changes…)                                                                                                                                                                                                                                  | What happened, verbatim                                                         | Engine (append-only)                                                                                                                           |
| **W-DB** (merged World + Map DB) | World truth · wiki (open + sublocation) · sublocations with geometry (coordinate, footprint, type, persistence flag) · **objects** (holder-pointed, [§14](#14-map-system)) · markers · character locations · **world clock**. **Image pixels live as files on disk**; rows hold path + content hash only. | What is true / knowable / where things are                                      | World Agent (truth+wiki), Scene Engine (sublocation identity stubs — Narrator-proposed, engine-committed), map code via the `materialize_sublocation` job (geometry + pixels), mailboxes (character location), CRON (markers) — merged storage, **separate write authorities** |
| **Character DB (C-DB)**          | Per character: skills, memory deltas + compactions, social-media memory, personality (lockable), goals, secrets, per-character model config                                                                                                                                                               | Who characters are                                                              | That character's mailbox (reflection output routes through it)                                                                                 |
| **CACHE store**                  | Per-character append-only CACHE entries `{origin, session_or_conversation_id, sublocation_id, timestamp, one_line}`; "latest" and "latest-per-origin" are views                                                                                                                                           | A character's "just happened" state across Scene/Chat/Social/Gateway boundaries | That character's mailbox                                                                                                                       |
| **Job Ledger**                   | Work items + states                                                                                                                                                                                                                                                                                       | What must still run                                                             | Engine                                                                                                                                         |
| **User Profile**                 | Per-user (keyed by `actor_id`): GM-owned hypotheses + engagement history. Viewable / exportable / deletable by the user (GDPR).                                                                                                                                                                           | How to tailor the experience                                                    | GM's ledger jobs                                                                                                                               |

### 4.4 Module contract pattern

Every module exposes a contract in this shape (so any module is swappable / pluggable):

```
Module
  Inputs    — what it reads (from stores or other modules)
  Tools     — actions it may take (each engine-validated; some consent-gated)
  Outputs   — <expose>   : surfaced to frontend / other modules
              <log-only> : recorded, never surfaced or cross-injected
  Lifecycle — when it starts / ends, and what it commits on end
  Scope     — knowledge tier of inputs; write authority of outputs; approvers if gated
```

### 4.5 Data flow — the two timescales, restated

- **Live (hot path):** User ⇄ Frontend (event stream) ⇄ Scene Engine ⇄ {Narrator | Group-Narrator | Character | GM}. Works against CACHE + Event Log. Each turn is wrapped in a **turn envelope**. The only durable hot-path mutations are engine-committed events (turn content, joins/leaves, **character location changes, object holder/payload events, and sublocation identity stubs** — deliberate, documented exceptions, committed via mailbox/engine because map, CRON, chat, and the backpack UI need them fresh).
- **Commit (cold path):** milestone events atomically enqueue ledger jobs — `scene.ended` enqueues `reflect(char, session)` per participant + `world_agent(scene)`; chat `exit()`/timeout enqueues `reflect_chat(char, conversation)`. Jobs are **idempotent projections of the immutable log**: no rollback exists or is needed — a failed step is simply *pending*, retryable forever, because its input never changes (saga model, not transactions). **V1 scene transitions block, scoped:** opening a new scene awaits only pending jobs of *that world + the involved characters* (never the whole ledger); reflections fan out in parallel while the single World Agent job runs alongside, and natural transition dead-time (map browsing, sublocation generation) covers it ([§6](#6-scene-system)).

> [!important] The cardinal rule (Rev 2 form)
> **Durable change is either a ledger job or an engine-validated event. LLM output is never directly durable.** Chat never mutates the world; a character may reflect from chat (own memory only), or commit request to start a scene with users or other characters (when that character is available). Scenes are where the world changes.

---

## 5. Frontend Surfaces

> [!note] Frontend = render only
> These pages render the **server-pushed event stream** and capture input. No game logic. Streaming narration, typing indicators, CRON arrivals, and gateway echoes all ride the same stream.

### 5.1 World Page

The entry point — pick a world before playing.

- Last-played world centered with **"Continue"**; other worlds listed/selectable.
- **Top-right buttons:** **Weltari Chat** (global chat across all worlds; inside a world, filtered to that world), **Config** ([§15](#15-config)), **Github**.

### 5.2 World Sidebar

| Item                        | Goes to                                                                            |
| --------------------------- | ---------------------------------------------------------------------------------- |
| **Scene**(play button icon) | The immersive RP surface ([§5.3](#53-scene-page)).                                 |
| **Map** (map icon)          | The world map ([§14](#14-map-system)).                                             |
| **Field** (camera icon)     | The social-media feed ([§12](#12-social-media-system-camera)).                     |
| **Chat**(chat bubble icon)  | Messaging / Weltari Chat ([§8](#8-messaging-system-chat)).                         |
| Wiki(book icon)             | Open Wiki and sublocation wiki.                                                    |
| **Setting** (gear icon)     | Config ([§15](#15-config)) + gateway settings ([§13](#13-gateway-telegramwechat)). |

> [!todo] Mail — not in V1 (deferred, [§18](#18-v1-scope-vs-deferred-v2v3)).

### 5.3 Scene page

**Landing state:** blue-sky background, drifting clouds, welcome line, three buttons: **History Scene**, **Open Map**, **Hang Around**.

**History Scene.** Browse and **resume any past scene**. Resume rules (Rev 2, engine-enforced):
1. Resume = **Revisit**. With a "Revisit <sublocation_name>" button at the bottom. Resume only shares the same sublocation with no characters joining the scene with the user - and it works exactly like the user clicked a random location on the map and start exploring, but from that history scene's sublocation. Note that no other characters join with the user.
2. **Re-ground in current truth.** The Narrator receives the old scene's summary + *current* W-DB state, and explicitly narrates drift ("the tavern you remember is now a burned shell"; departed characters are absent and it nudges toward new content). Old context is never replayed as if still true.
3. On leave, the normal cold path runs for this new scene.

**Open Map.** → Map page.

**Hang Around.** Drops the user at a random **materialized** sublocation with content chosen by the Narrator using storytelling goals + the user's profile hypotheses — or, when the story wants somewhere genuinely new, the Narrator may spin up a **new parentless sublocation** via the standard creation workflow ([§6](#6-scene-system)), which enqueues materialization as usual. Kept un-boring: usually someone known, sometimes strangers, always grounded.

**Two display modes** (toggle, top-right):
- **Visual Novel mode** — galgame-style; art for everyone present; the Narrator switches art via engine tool (validated against the character's actual art set). 1 character centered; 2–5 animated line-up with speaker rise; **>5 ⇒ Stream mode only**.
- **Stream mode** — SillyTavern-style; Narrator in *italic* without avatar; characters with avatar + name; sublocation background behind a semi-transparent panel.

**Pacing (the primary latency mask).** Narration advances **sentence-by-sentence per click** (galgame paradigm), with an **Auto-Advance mode** at a configurable delay. Reading pace decouples from generation pace: while the user clicks through delivered sentences, the pipeline is already generating ahead. The user can **interrupt the Narrator's stream at any point** — sending a message or clicking a tool pops a window guiding them into the chatbox; the engine closes the turn envelope at the interruption point.

---

## 6. Scene System

The heart of Weltari. **Split in Rev 2:** the **Scene Engine** (deterministic) runs the scene; the **Narrator** (LLM) voices it.

> [!note] V1 simplification — no resolve loop
> No mechanical adjudication in V1. When a character returns an `attempt`, the Narrator narrates it. Success is governed by **facts** (if the door *is* locked per truth/wiki, it stays locked) and **storytelling goals**. The full `attempt → resolve(event) → outcome` engine is V2.

### Scene Engine — module contract

**Owns (deterministic, never LLM):**
- Session lifecycle: open/close on participant join/leave; simultaneous joins allowed; sessions may contain zero characters (but the user is present); **all session/scene IDs assigned here**.
- Presence: `available | in_scene(scene_id)` per character. Scene start reserves its characters (bypass mailbox); the CRON mover and other scenes skip reserved characters. *(Chat is deliberately non-exclusive: a character can be DM'd while in a scene — that is exactly what CACHE is for.)* V2 adds `locked` scenes ([§18](#18-v1-scope-vs-deferred-v2v3)). Quote on chat UI: when character presence = in_scene, the character is offline in chat. A **pending `startscene()` invitation** reserves its characters through this same mechanism (presence = `in_scene` on the pending scene): their chance-encounter map anchor is removed the moment the invitation is sent and CRON movement skips them; if the invitation expires, a hardcoded routine flips them back to `available` ([§7](#7-character-system--c-module)).
- Turn envelopes (`turn_open`/`turn_close`) and **turn budgets** (max N character turns per user turn, then yield to the user — applies to Narrator subgoal loops too).
- Tool validation: every Narrator tool call is checked (present characters only, valid art assets, valid sublocations) before execution. Queries on open wikis are allowed. Includes `create_sublocation`'s **query-first precondition** for parentless creates and the name→ID resolver's did-you-mean dedup. 
- Subgoal-state persistence: goal/subgoal progress snapshotted as scene state after each turn, so resume restores story position.
- `determine_who_next` execution: **returns a set of character IDs** (V1 policy: always size one → strictly sequential; the set-typed contract keeps V2 group fan-out open at zero cost).
- Context_warning. Check context budget every round and if the context window is about to reach in 5k, a warning is send to the narrator. This compares the scene context with max context budget. Note that the max context budget is actually designed for **character LLM**, because characters have to get context injected to them too and characters are often weaker small models that have limited budget. Recommended pro session is 256K MIN, 1M MAX inside this document as a predict.

**What the Scene Engine is, mechanically:** not an agent, receives no prompt — a plain code module: a **state machine** (explicit current state: open sessions, presence, turn counter, subgoal snapshot; only defined transitions permitted) plus an **orchestration loop** (the code deciding which LLM to call next, with what context). It does not *consume* context; it *routes* context to the LLMs. One user turn:

```
1. User input arrives → engine appends input event, opens turn envelope
2. Engine asks the Context Assembler for the Narrator prompt
   (truth + wiki + subgoal state + clock/weather + latest turns) → calls Narrator
3. Narrator streams narration; emits tool calls. For each:
   engine VALIDATES against state (character present? art exists? holder rules?)
   → executes(optional): charactercall → assembler builds character prompt → C-Module runs
     → message/attempt return to the Narrator (raw attempt is log-only;
       the Narrator narrates its observable surface into the session);
     interact_object → engine commits the object event directly
     (payloads never route through the Narrator)
4. Turn-budget check → persist subgoal snapshot if updated → close envelope
   → push events to frontend (narration, backpack updates, art switches)
```

### Narrator — module contract

**Inputs (stable-prefix order):**
1. Narrator skills (tool use + storytelling).
2. Chapter seed + style investments + story goals — *Narrator only, never characters.*
3. Scene goals — from GM, or from a character's `startscene()` handoff.
4. World TRUTH + wiki (sublocation + open), pre-retrieved by the Context Assembler; `query_wiki` for on-demand extras.
5. Persisted subgoal state (on resume).
6. User input / latest turns (dynamic tail).

**Tools (all Scene-Engine functions):** 
- `make_character(present|absent)` 
- `charactercall(...)` 
- `resolve(event)` *(V1: narrate only)* 
- `determine_who_next` 
- `query_wiki` 
- `query_sublocations(mode)` — hard-coded lookup, three modes: **(a)** list all parentless (exterior-atomic) sublocations, **(b)** list all children under a named parentless sublocation, **(c)** keyword search across all sublocations. Mode (a) is the **strict prerequisite** for any parentless create; (c) is a soft option. 
- `create_sublocation(name, type, parent?, brief, narrative_anchor?)` *(engine commits the identity stub — a documented hot-path exception. Child creates (parent = the current exterior-atomic location) are free-form; **parentless creates without a preceding all-parentless query in this scene are refused** with the fixed instruction: "Before creating a sublocation that has no parent sublocation, you have to use the query tool to lookup for existing sublocations. If the sublocation you are looking for can refer to an already existing sublocation, please use the change_sublocation tool; otherwise, create a new one." The name→ID resolver additionally rejects near-duplicates with a did-you-mean. On commit: the backdrop-image job fires immediately for every new sublocation; parentless stubs also eagerly enqueue `materialize_sublocation` ([§14](#14-map-system-and-cron)).)* 
- `change_sublocation(→ sublocation)` *(switches the scene's stage — presence scope, wiki scope, and the backdrop swap with a slide-style transition UI, PowerPoint-like. Works on stubs: the eagerly generated backdrop is what makes mid-scene switching fluid.)* 
- `move_character(→ sublocation)` *(engine commits the location event via the character's mailbox immediately — the documented hot-path exception)* 
- `character_leave` 
- `switch_art`(based on character message and attempt) 
- `transfer_object(object_ref → new_holder)` *(possession changes involving the user — "you pocket the letter"; engine-validated like all object ops)* 
- `update_goals(...)` *(structured subgoal snapshot, below)* 
- `end_scene`
	  (can choose what type of scene to end. New_scene_available, new_scene_unavailable or context_limit_reached. For context_limit_reached, the scene engine will send a warning. So the narrator can call this tool later as the reason) .
	  When new_scene_available, the Narrator must register the **`next_scene_registration`** payload — `{sublocation: existing_id | new_stub, time_offset, expected_participants[], premise_seed, brief_history, carried_goals[]}` — otherwise the Scene Engine returns an error with the reason and the Narrator must call again. The engine checks validity. A `new_stub` names a not-yet-existing place and goes through the standard `create_sublocation` workflow (query-first rule applies); materialization is enqueued immediately, so the next scene can open on the stub while the map catches up. `brief_history` + `carried_goals` are what make "Jump to the next scene" a continuation instead of a cold open — the World Agent recap cannot substitute, because the jump may fire before the cold path finishes. **`new_scene_unavailable` strictly means: this scene has absolutely no further continuity — only the narrative goal has been reached.** It is never a fallback for missing sublocations.

### Sublocation creation — Narrator-side workflow

**Prose first.** Mentioning a place costs nothing — like objects, ~95% of narrated places never become rows. A row is created only when the story *commits*: the scene moves there (`change_sublocation`), a character or object must anchor there, or `end_scene` registers the next scene there.

**Child creates (the common case).** A new interior of the current atomic location ("the café's kitchen"): create freely; parent = the current exterior-atomic sublocation, **always flat** (the storage room parents to the café, not the kitchen — the Narrator decides which atomic location owns it). The backdrop job fires immediately so the scene can switch into it fluidly.

**Parentless creates (rare).** A genuinely new place ("a park", when none exists): the query-first rule is engine-enforced (see `create_sublocation`); the Narrator skill instructs *prefer an existing sublocation whenever it plausibly fits; create only when the story truly needs a new place*. On commit: identity stub (hot path) + backdrop job (immediate) + `materialize_sublocation` (eager, [§14](#14-map-system-and-cron)). The new sublocation's wiki stays **empty until the World Agent's scene-end pass** — tolerated by design ([§10](#10-world-agent)).

**The "atomic point" skill problem.** Models will instinctively call a park an "area". The Narrator/GM skills must pin the constraint with the litmus test **one sublocation = one backdrop image**: if a single background image can stage it, it is atomic (park ✓, market square ✓, bridge ✓, street ✓); if only an aerial/composite view could, it is not a sublocation — name the stage *inside* it instead (district ✗ → the market square in it; forest region ✗ → the clearing). Skills carry positive/negative examples; the resolver + class check are the code-side backstop.

**Outputs:** `<expose>` streamed narration + character speech/action rendering. `<log-only>` its own reasoning. **The Narrator reads characters' `message` + `attempt` only — never their thinking** ([§7](#7-character-system--c-module)).

**Sequencing (decided):** the Narrator→Character→Narrator loop is **inherently serial** — the character's reply is an input to the narration. V1 is single-threaded by design to minimize uncertainty; parallel fan-out (group scenes) is V2 and already permitted by the set-typed `determine_who_next` contract. (to keep secret.)

### Narrator output & pacing

The Narrator's output **can and should be long enough** — a substantial narrative block before halting for user input, not turn-by-turn drip. **Every Narrator API call carries the current subgoal** ("what this output should accomplish") in its dynamic context, so the Narrator drives the story forward on its own instead of the user pushing it forward trigger-by-trigger (the core UX complaint with existing platforms). The frontend's sentence-by-sentence advance + Auto-Advance ([§5.3](#53-scene-page)) absorbs the generation time; the user can interrupt the stream at any point. (Then the narrator STOPS and receives new input, then generate the new response.)
Only when the context does not have enough information, or the Narrator would rather wait for user input before proceeding, will it generate short responses. **We should create the skill file to teach the Narrator how to decide.**

**Resolving user input (decided).** Every user message is resolved by the Narrator as a `message`, an `attempt`, or an object interaction. Narrator intelligence does that. For `transfer_object` edge cases — the user's prose claims an item the Narrator never granted ("I take the crown") — the Narrator adjudicates in narration; the Narrator skill must spell out graceful refusal vs. acceptance.

### Storytelling goals → subgoals (V1)

- Per-world toggle. Sources: GM goals + the Narrator's storytelling skill. (V2 adds FEL/Director sources.)
- The Narrator decomposes goals into subgoals and advances every turn until a subgoal is met; the engine enforces the turn budget so goal-chasing can't loop.

**Subgoal persistence (decided mechanism):** the Narrator has an explicit tool `update_goals(goals: [{id, text, status: pending|active|done}])` — a full structured schema, which LLMs fill reliably (the opposite of semantic key-compression: the model writes out complete explicit state; code just stores it). The engine persists the last-committed snapshot as scene state and **reinjects it every turn**. No per-turn verification pass (that would tax every turn with an extra call); the design is event-driven and self-correcting — if the Narrator forgets to call it, the stale snapshot reappears next turn against its own fresher narration and gets corrected, worst case lagging one beat, which resume tolerates.

### Scene end — soft-close (cold path)

Scene end is asynchronous bookkeeping, never a wall. The Narrator detects the scene is ending (natural closure or a met storytelling goal) and narrates a brief outro. The user may stay in the scene, navigate away (map, another scene, world page), be idle until timeout, or explicitly quit. The frontend renders a subtle divider ("— evening falls —"), not a "scene over" screen; the scene remains scroll-back readable.
There are different types of scene ending:
- **Natural closure** — "see you tomorrow!" This usually means the user is the only one left, or it no longer makes sense for the conversation to continue (characters have already said goodbye). The Narrator narrates a brief outro; the user navigates away (map, another scene, world page), idle-timeout, or explicit quit.
- **Storytelling goal reached** (decided by the Narrator) — the scene does *not* end immediately. In V2 the user can continue freely with the Narrator only reacting to user actions and character attempts, until the context length nears its limit. In V1, when the goal is met, the Narrator calls characters with a seed that suggests they might leave; each character then behaves naturally and states why they have to leave, based on the seed and context. The Narrator may split the seed across two rounds.
- context limit reached (Scene Engine Warning) - same as storytelling goal where scene does not end immediately and narrator plant seed to quit naturally.
If the user wants to keep talking, the available buttons depend on which type the Narrator selected with the `end_scene` tool:
#### When a continuation to a new scene is available

Three buttons are provided:
- **"Stay longer"** — triggers the resume path ([§5.3](#53-scene-page)): characters still present join, a new scene loads with the same sublocation, re-grounded — indistinguishable from continuation. The user experiences an endless conversation; the engine segments it into committed units underneath. Clicking this button advances the game-time instantly to the time after the ended scene.
- **"Jump to the next scene"** — opens a scene that may have a different sublocation or time (for example, "see you tomorrow" jumps to tomorrow). It works exactly like clicking an event marker on the map at that in-game moment. Clicking this button advances the game-time instantly to the time after the ended scene.
- **"Open map"** — `scene.ended` is triggered and the user is redirected to the map page with new events. Clicking this button advances the game-time instantly to the time after the ended scene.
#### When a continuation to a new scene is unavailable
- **"Stay longer"** — same as above.
- **"Open map"** — same as above.
The "Jump to the next scene" button is absent here.
#### User quit
In the top-right corner of the scene page there are "auto" and "exit" buttons.
- **Exit button:** clicking the exit button shows a pop-up: "Are you sure you want to leave now?" If confirmed, the Narrator renders a natural, in-character reason for the user inside the scene. Once clicked, the user sees their own reason sent in the scene; after confirming, they exit and `scene.ended` runs in background. The user lands back on the Scene page.
- **Idle timeout:** when the user stops interacting with the scene without closing the app, the scene pauses instead of quitting. After an idle timeout (likely 2–3 hours), `scene.ended` runs, characters become available again, and CRON continues.
- **App shutdown:** if the user shuts down the game (including the backend) — normally or unexpectedly — the in-game clock does not change; they can resume right where they left off.
- **Changing sublocation / joining another event while in a scene:** the user must end the current scene first. A pop-up will appear when they attempt to leave while inside a scene.
To summarize: a smooth transition still runs the old `scene.ended` wiki edits and character reflections, and creates a new scene as normal, but with buttons that let the user stay on the scene page and continue directly. When the user clicks a continue button, they wait until all reflection jobs finish.

`end_scene` → engine writes `scene.ended` **and atomically enqueues**: `reflect(character, session)` for every session participant (fanned out in parallel — independent), then `world_agent(scene)`. Steps are independent, idempotent, retryable ([§4.5](#45-data-flow--the-two-timescales-restated)). **Scene end also feeds the marker loop:** the ending scene may propose a follow-up chance-encounter marker; if it has no follow-up content, the engine/CRON generates one — maintaining the map's 1–5 live markers ([§14](#14-map-system)). **Opening the next scene blocks, scoped** (this world + involved characters only), covered by natural transition time; if the user is unusually fast, a few seconds of loading state. This deletes tail-injection heuristics and priority-bump machinery from V1 entirely.

---

## 7. Character System — C-Module

A character is an **independent subagent** with its own API session. The Narrator owns the scene and the task; the C-Module assembles one prompt, sends it, returns the reply. Separation exists so characters can hold **secrets**.

### How secrets are actually held

A character holds a secret **by choice in private deliberation** — "saying this would be bad for me, so I won't" — not by canned refusals. This requires a contract-level guarantee:

> [!important] The private-channel contract
> The character's reasoning and internal tool use are `<log-only>` and are **excluded from every other agent's context**. The Narrator receives `message` (verbatim) and `attempt` — but **the raw attempt is itself log-only**: it is *input to the Narrator*, not session content. What enters the session is the Narrator's narration of the attempt's **observable surface** ("Elias scribbled something hastily and locked it in the safe"), while speech stays verbatim (words spoken are words heard). Consequently the World Agent — which reads sessions — never sees raw attempts or thinking at all, and an *unspoken* secret physically cannot reach it. A secret spoken *out loud* is a deliberate in-fiction act — see [§10](#10-world-agent) for why it still doesn't teleport into the wiki. **Reflection is the exception:** a character's own reflection reads its own log-only trail (raw attempts, payloads it authored, CACHE sequence) in addition to session history — so Elias remembers what his letter said even though nobody else can ([§11](#11-memory--cache-model)).

### C-Module — module contract

**Inputs (stable-prefix order):** character skills (RP + chat) → personality (lockable: `mutable=false` freezes it) → **memory core** (always-injected tier, [§11](#11-memory--cache-model)) → goals (main+sub) → secrets → *(dynamic tail)* pre-retrieved memory/wiki snippets + scene/chat context passed by the caller + latest CACHE when crossing contexts.

> [!note] Characters never see the story's hand
> Chapter seed, style investments, and Narrator story goals are never injected into a character.

**Tools:**

| Tool                                                      | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `query`                                                   | Internal lookup (own memory tiers, wiki, **sublocation lookup** — query only, characters can never create sublocations — own sessions via scene-query, chat_history with user or group). Bounded: max 1–2 iterations; the Context Assembler pre-retrieves likely snippets so the common case is zero extra calls.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `message`                                                 | Spoken words. Empty ⇒ deliberately silent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `attempt`                                                 | Action attempt. Empty -> Character didn't do anything.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `CACHE`                                                   | **Mandatory** 1–2 line recap, every trigger ([§11](#11-memory--cache-model)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `interact_object(visible_surface, object_ref?, payload?)` | Create/take/give/store/drop an item, or author hidden content (a letter's text goes in `payload` — engine→truth directly, never through the Narrator). **Engine gate:** accepted only if it changes a holder or writes a payload; anything else is rejected with "express it in your attempt instead" — prose stays prose by construction. Max 2 object ops per turn; `object_ref` matching an existing name at the same holder resolves to the existing row (dedup).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `explore(sublocation)`                                    | Pure retrieval, no LLM call: returns the sublocation wiki + the objects publicly held there, and the sublocations one level deeper that this sublocation contains. (For example, an apartment sublocation will then return the characters' rooms, and they are accessible.) More on sublocation later. Exploring is the character's choice; character may discuss it with the user too since user is also present; the information is open to anyone present.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `startscene()`                                            | Chat-side bridge: proposes ending the chat into a Scene ([§8](#8-messaging-system-chat)). <br>Characters cannot `exit()` a chat, while startscene() will actually end the chat, but character LLM does not know it will in skills. If the character submitted the scene but the user actually didnt join and that scene expired, a entry will be written inside their memory so they get notified. <br>They will complain about it. In v1, they will not send message from themselves to complain, but will complain next time they got triggered ( in scene, in chat.. like CACHE) it is up to model intelligence if they still want to meet or not. When user continue to chat, they can still createscene and the same entry will be recorded too. This should be indicated in skill.<br>This can also invite other characters, but only when that character is available. Since character can not chat with other character, they will indicate the user to ask naturally, and when user returned yes, character A AND character B can fire chat scene, and if the hallucination happened on that character B, Scene Engine wont allow it to join and narrator will give natural reason. <br>**Sublocation parameter (required):** the character selects an existing sublocation or types a free-text place string (e.g. "park"); the Narrator receives it at scene open and resolves it via the standard workflow ([§6](#6-scene-system)) — existing match → use it; no match → `create_sublocation` (query-first). Characters may **query** sublocations first, but if the place is not present they are never allowed to create one themselves. <br>**No map marker in V1:** a start_scene invitation registers no map event marker (an unknown sublocation has nowhere to anchor before materialization); the invitation lives in chat/gateway with its TTL. On **send**, the character is reserved via presence (`in_scene` on the pending scene) — chance-encounter anchor removed, CRON movement blocked; on expiry, a hardcoded routine flips them back to `available`. |


> [!bug] Debug invariant
> Prompt length > 0 but `message`, `attempt` AND `cache` all empty ⇒ likely broken. A healthy silent turn still writes CACHE.

**Outputs:** `<expose>` `message` + `attempt` (surfaced via narration or chat). `<log-only>` reasoning, lookups, CACHE.
### Objects & containers (V1)

Durable items, **materialized only on touch**: the Narrator narrates scenery freely as prose; an object becomes a DB row only when an interaction has a durable consequence (someone takes it, stores it, authors hidden content into it). The engine creates the row on the first `interact_object` referencing it; ~95% of narrated stuff is never touched and never becomes data.

```
Object { id, world_id, name, holder, payload?, version }
  holder ∈ { sublocation_id | character_id | user_actor_id }   // V1
  payload = what the object is and/or contains (prose)
```

- **Binary visibility (V1):** `holder = character/user` → **backpack, owner-exclusive** (engine rule — no other agent can read it); `holder = sublocation` → **public** (listed by `explore`, observable-now, takeable by anyone present). No access notes, no per-object locks: protection = keep it in your backpack; the only way at a character's held item is the social route — meet them in a scene and persuade/trade/trick, adjudicated by character intelligence.
- **Object-in-object nesting is V2** (needed when the Director seeds clues — a letter planted in a desk/safe). V1 semantic nesting (card in wallet) stays at prose level; characters have the semantic intelligence to not stuff a phone inside a gun, taught by one skill line.
- **Cross-scene identity (decided):** dedup by (name, holder) within a scene is specced; when a later scene references an object by prose name alone, resolution searches the **reachable holders** and returns the match. If the name is ambiguous, all matches are returned — IDs never duplicate, so the reference resolves safely.
- **Who creates objects:** nobody (prose default) · Scene Engine (materialize-on-touch — the normal path) · GM (Proposal pipeline, authored items) · Narrator/World Agent: **never directly** (write authority preserved; the Narrator's `transfer_object` moves holders for user possession changes, the engine writes the row).
- **Empty-payload read:** if a public object is examined and has no payload, the Narrator improvises consistent content and the engine persists it as the payload (write-on-first-read). Backpack items are only ever read by their owner, whose memory grounds them.
- **Hygiene:** single shared table, indexed on `holder` (every inventory view is a query — never per-character table splits, which break the moment items change hands); moves/ownership/containment are all one pointer update; GC sweep per [§7](#7-character-system--c-module); `version` for optimistic concurrency per Principle 4.
### Backpack & objects (character-side)

A **backpack** is simply the set of objects whose `holder` is that character — no separate container entity. Two rules, both engine-enforced and binary:

- **Backpack = secret.** Only the holder's own C-Module (and its reflection) can ever read a backpack object's payload; no other agent can query it. A character's important assets live here — which is why the "hidden letter in a safe" case is a **false requirement for V1**: characters naturally keep 100% of critical items in their private backpacks. Planted clues (a letter deliberately left in a desk/safe) arrive in V2 with the Director ([§18](#18-v1-scope-vs-deferred-v2v3)).
- **Sublocation = public.** Dropping an object at a sublocation makes it visible to everyone there: it appears in `explore` results, is observable-now (wiki-eligible existence), and anyone present may take it.

**Scarcity by skill, deliberately vague:** the character's skill says *"your backpack space is limited — but you do not know how much space you actually have; store items wisely."* Combined with the important-object definition — *directly impacts goals, alters relationships, has utility, shifts the narrative trajectory, or holds high intrinsic value* — this makes characters conservative about materializing rows (coffee beans while making coffee have zero narrative weight → prose, never a row). The engine's durable-consequence gate is the wall; the skill scarcity is the nudge on top. A periodic **GC sweep** (ledger job) deletes payload-less, sublocation-held objects never touched again after their creating scene — dropped sticks vanish, the letter (payload rule) is exempt.

**The user's backpack** works identically: `holder = user_actor_id`, populated via the Narrator's `transfer_object` tool when narration includes a possession change ("you pocket the letter"). The **backpack UI is a live projection**: every object commit is an event, the frontend consumes the event stream, so the backpack updates in the same frame as the narration that caused it — no polling, no extra mechanism.

### Skills carry product self-knowledge

No inter-agent communication exists in V1, so each character's skill encodes what the product can and cannot do, letting the character **refuse impossible requests in-character with a natural reason** ("could you DM someone for me?" → plausible in-fiction decline, possibly suggesting `startscene()`).

### Configuring a character

From Weltari Chat: per-character LLM params + endpoint and other C-Module settings ([§15](#15-config)).

---

## 8. Messaging System (Chat)

Weltari Chat is a **whatsapp-like** surface, parallel and independent to the Scene system — which is exactly why CACHE and scene-query exist.

**Layout.** Desktop: character list left, conversation right. Mobile: list → conversation. You can access weltari chat inside a world or from the world page.
From World Page: all characters across all worlds; inside a world: that world's visible characters. Conversation header: **configure** (C-Module settings) + **"go to *World_Name*"** from world page.

> [!important] Chat never changes the world
> No durable world change from a DM. A character may reflect and update **its own memory** from chat; the world changes only in scenes. Characters indicate this plausibly in-fiction, typically via `startscene()`.

> [!warning] No inter-agent comms in V1
> Characters cannot **message** or act on behalf of each other, nor perform world actions from chat. Only in group chat, but only user can start message there, character can not fire group chat by themselves in v1 (also not available for CRON). If asked → refuse in-character (self-knowledge lives in skills).

**Privacy & identity (Rev 2):** DMs are **private per user** (keyed by `actor_id`; a singleton in V1, load-bearing in V2). Every chat conversation has a stable `conversation_id`; chat CACHE entries carry it, so (in V2) two users DMing the same character never cross-contaminate its catch-up context.

### Modes of chat

**DM — direct message to a character.** Character runtime loads chat-skills + memory core, answers instant catch-up from **latest-per-origin CACHE** (scene + chat lines), escalates to scene-query for specifics. Ends on user `exit()` or inactivity timeout → **enqueues `reflect_chat(character, conversation, range)`** on the ledger (the chat analogue of session reflection; no scene-style summary is produced — `sessionsummarist = FALSE`). Characters cannot `exit()`; they can `startscene()`.

**Game Master — shown as a normal character, direct message to the GM agent.** Runs GM skills + tools + the user's profile; applies changes only via the Proposal pipeline ([§9](#9-gm-agent)).

**Groups — group chat.** Orchestrated by the Group-chat Narrator.

### Group-chat Narrator — module contract

**Inputs:** router skills · in-session chat recap · user/character input.
**Tools:** `character_call(msg → group)` · `determine_who_next` · `query_wiki` · `ENDSUBSESSION`.
**Hard rule:** **NO NARRATION** — routes turns only. **Turn budget enforced by the engine**: max N character turns per user turn, then yield (prevents infinite character ping-pong). Ends on sub-session end / user-input wait.
**No CRON fires into group chats** — proactive messaging is DM-only in V1.

### Shared messaging tools (character runtimes in Chat)

1. `memoryquery(...)` — own memory tiers.
2. `wikiquery(...)`.
3. `sessionquery(...)` — **scene-query**: find a past scene via its World-Agent recap, then read that session's history directly. **Participation-gated:** a character can only read sessions it participated in (knowledge tier 3, [§10](#10-world-agent)).
4. `startscene() / gotosublocation` — **the bridge**: ends the chat, opens a Scene (hands scene goals to the Narrator). Multiple character can be present at once. **A sublocation is required:** an existing pick or a free-text place string ("park") — the Narrator resolves or creates it via the standard workflow at scene open ([§6](#6-scene-system)); registers **no map event marker in V1** ([§7](#7-character-system--c-module)).

### Proactive (CRON) messaging

CRON drops proactive DMs on a schedule (random pick in V1; FEL-driven in V2). **Rev 2 mechanics:**

- **eager generation:** the CRON fire itself and runs generation (ledger job): content is committed to log + CACHE at that moment, pushed to the messenger AND the gateway ( if user have one configured) , and appears identically in Weltari Chat. *(You cannot push "click to generate" to Telegram — the push must be the message.)* Everyone else stays lazy.
- **Outreach caps (token saver + realism):** each dispatched proactive DM is recorded in the character's episodic memory as an **unanswered outreach** (CACHE-like, stamped with the game-day; cleared when reflection processes it). If unanswered, CRON retries at natural human re-ask intervals; after **3 unanswered messages** from **max 5 different characters** (realistically ~2 days) the whole chat thread **freezes** — no further proactive sends until the user replies, which resets the counter. Mirrors real texting behavior; hard ceiling of 3 per thread.

---

## 9. GM Agent

A separate meta-agent — not the in-scene Narrator. Frontend persona "GM"; different backend prompt. Two ongoing jobs, plus a one-time cold-boot duty.

### Job 0 — Cold boot: GM-guided world creation

First launch is an in-fiction onboarding run by the GM as a fictional guide character:

1. **Language** — the GM asks the user to choose a language.
2. **API keys** — configure model endpoints/keys for every role first ([§15](#15-config)); from here the GM is "alive" (running on the configured model).
3. **World interview** — the GM asks what the world should look like, which characters the user wants; it fills structured world-creation forms from the conversation.
4. **Cold-boot fill** — triggers generation of all initial data: Open Wiki, characters, chapter seed, the starting map, and the seed sublocations.

**Seeding requirements (binding):**
- **Every deliberately named place gets a row** — whatever world generation names (town square, tavern, port) is registered as a **materialized** sublocation at boot; only unnamed painted "noise" stays lazy (Flow B territory, [§14](#14-map-system-and-cron)).
- **Minimum viable set: at least one public space AND one private space**, consistent with the Open Wiki (e.g., a park and the character's home) — so characters always have somewhere concrete to pass to `startscene()` and CRON movement always has somewhere to land. This is where those spaces must be documented and created.
- **Small initial painted area, deliberately.** Fog proximity is what makes mid-story discoveries plausible ("a park two streets over you never noticed"); a massive pre-painted city would force every new sublocation to the distant outskirts. Seed density and initial map size are world-gen config knobs.

### Job 1 — World authoring (consent-gated)

Every authoring tool exposed — create characters, events, edit truth — **all via the Proposal pipeline** ([§16](#16-cross-cutting-concerns)): the GM proposes with a diff + rationale; hard code gates the apply on user approval; approval and application are logged events. The GM is the only LLM agent besides the World Agent that can write truth — and only this way. 
User can also manually edit wiki and character memory inside the "wiki" page or the chat's setting icon and edit character config.

**Product self-naming (decided).** The GM may rename product-facing surfaces — agent names (e.g. *World Agent* → *Weltari Archi*), UI labels, and greeting copy — to fit the roleplay vibe, provided it does not materially complicate the stack. Correspondingly, the GM and Narrator must know how to create stories and characters *for this engine* on user demand.

### Job 2 — User profiling + the feedback loop

The GM's analysis skill runs as **ledger jobs** over ended scenes/sessions and ended chats, building a per-user **User Profile** (hypotheses about behavior/preferences — like character memory+personality, but for the user).

```
GM analyzes ended scenes/chats (ledger job)
   → updates User Profile (hypotheses, keyed by actor_id)
   → ships hypotheses to the NARRATOR for that user's next scene (never to characters)
       → Narrator TESTS hypotheses (does not obey blindly)
           → on scene end, World Agent emits a STRUCTURED ENGAGEMENT signal → GM
               → GM updates profile (GM memory + GM skills)
   ↺
```

**Guardrails (binding):** the profile is fully **viewable, exportable, deletable** by the user (also a GDPR obligation for a German GmbH — profiling data is personal data); the analysis skill optimizes for *story-quality signals*, not raw time-spent; the whole loop has an off-toggle ([§15](#15-config)).

**GM contract.** Inputs: GM skills (authoring + analysis) · user profile · ended scenes & chats · engagement reports · user msg. Tools: authoring (Proposal-gated) · ask user · profile user. Outputs: `<expose>` consent prompts + msg; hypotheses → Narrator; approved changes applied via engine.

---

## 10. World Agent

Runs as a ledger job on **scene end**. The sole normal-path writer of durable world knowledge — **both wiki and world-truth deltas**.

### The knowledge-tier model (Rev 2)

Four tiers, one axis — *who can know it*:

| Tier                 | Audience                          | Mechanism                                                                                   |
| -------------------- | --------------------------------- | ------------------------------------------------------------------------------------------- |
| 1 · Open wiki        | Everyone                          | World Agent writes                                                                          |
| 2 · Sublocation wiki | Anyone contextually there         | World Agent writes; injected only when the scene is there                                   |
| 3 · Session log      | Participants of that session only | scene-query, participation-gated                                                            |
| 4 · Character memory | One character                     | Reflection commits via mailbox. Please note that reflection is run by character themselves. |



> [!note] The sublocation wiki is a *relevance* scope, not a secrecy mechanism
> Its job is token economy — "only worth injecting when you're there" — not access control. Secrecy lives in tiers 3–4, which are participation-gated *by construction*. (This resolves the earlier ambiguity where one mechanism tried to do both jobs.) So characters can use query tool to search for other sublocation wiki when they feel they need to.

### Source-typing: what may enter the wiki (deterministic, no AI classifier)

The World Agent reads **whole scenes across all sessions** — but sessions contain only narration + verbatim speech ([§7](#7-character-system--c-module)), and every turn carries a labeled source type with fixed epistemic status:

| Turn source | Epistemic status | Wiki-eligible? |
| --- | --- | --- |
| Narrator narration (incl. narrated attempt surfaces) | The world as anyone present perceives it | **Yes** — observable by construction |
| Character `message` (speech) | A *claim*, made by someone with motives | **No — never a wiki source.** Speech is hearsay |

The rule is code-checkable: turns arrive type-labeled in the World Agent's input; its skill sources only from narration; and because wiki writes carry provenance, code can verify a candidate entry cites no `message` turns. No AI judgment sits between a spoken secret and the wiki — speech is categorically excluded. A character who *says* "I poisoned the mayor" makes memory (tier 4) and session history (tier 3), never world fact; a character who visibly *does* something made it observable, and it should be documentable; a true public fact spoken aloud becomes wiki-able the moment the Narrator narrates it as real — which is what makes it observed.

### The observable-now rule

**The wiki stores observable-*now* state snapshots; the session log stores event history. The World Agent writes the former and never transcribes the latter.** The test is: *what does this place/thing look like to fresh eyes right now?* A character deposits a letter in a safe (even in a private or solo session): afterward the safe is externally identical — no observable-now state changed — so the World Agent has **nothing to write**; "A placed a letter" is an *event*, and events are not wiki material. Had A smashed the safe open, "the safe's door hangs broken" *is* correct wiki content. This kills context infection at the root: future Narrator prompts at that café contain "a heavy safe sits in the corner" — producing exactly the curiosity a safe should produce in fiction — while "A put something in it" exists nowhere injectable except A's own memory and a participation-gated session log. The rule is presence-independent: it holds unchanged for solo scenes and V2 FEL-triggered scenes.

**Backstops (structural):** wiki writes are events with provenance (which scene produced them) — auditable and revertible. Optional Config toggle **"review wiki writes"** routes all World Agent wiki commits through the Proposal pipeline. *(Rev 2's secrets[]-comparison backstop is dropped: with speech categorically excluded and attempts filtered to narrated surfaces, it protected nothing — and it would have required semantic matching we don't want.)*

### World Agent — module contract

**Inputs:** 
1. skill (incl. the source-typing + observable-now rules above) 
2. full scene context (all sessions — narration + verbatim speech only, source-labeled) 
3. current sublocation wiki 
4. existing wiki entries (search-before-write, via the Search Index).

**Lifecycle / outputs:**
1. **Summarize** → summary file + smaller **recap** (the scene-query index).
2. **Reconcile facts ↔ context** → create/update **Open** and/or **Sublocation** wiki entries (through the secret backstop). **Sublocations created during the scene get their first wiki entry here**, and the *parent's* wiki gains a natural-language mention of any new child ("This café has a beautiful kitchen…"). Zero-activity fallback: if a scene at a new sublocation ends with no usable narration (joined, abandoned, never returned), the World Agent still writes a brief name-derived entry ("A park in the city center") — it **cannot create new world facts, only observe**, so with no narration nothing further can be synthesized. It never creates sublocation *rows* — identity is Scene-Engine territory ([§6](#6-scene-system)).
3. **Commit world-truth deltas** — reality changed by the scene (door broken, shrine discovered) is written to W-DB truth, so truth never fossilizes while the wiki drifts ahead of it.
4. **Report structured engagement signal → GM.**

**Concurrency rule:** World Agent jobs **serialize per world** (ledger concurrency = 1 per world), so concurrent scene-ends (V2) can never interleave wiki/truth writes.

> [!note] What is a "fact"?
> A description of observable-**now** state — something fresh eyes at the spot could note right now. Not "already known," but *knowable by observation*: a café's cozy interior and its visible staff are wiki-correct even though a stranger hasn't seen them *yet*. Wiki facts and character memories coexist by design: a public fact and a private recollection of the same event are different tiers, and that difference *is* gameplay.

---

## 11. Memory & CACHE Model

Three artifacts at three timescales. Keeping them distinct is the whole design.

| Artifact | Timescale | Job | Lossy? |
| --- | --- | --- | --- |
| **Session history** | permanent (append-only log) | ground truth of what happened | no |
| **CACHE** | per trigger, append-only entries | instant "just happened to me" **pointer** | yes (by design) |
| **Character memory** | permanent (deltas + compaction) | curated subjective recall | curated |

### CACHE (Rev 2)

- **Per-character, private, mandatory every trigger.** Each character reads only its own.
- **One append-only store; no overwriting, no flags.** Entry shape: `{origin: scene|chat|social|gateway, session_or_conversation_id, sublocation_id, timestamp, one_line}`. All structured fields are **engine-written** (the character produces only the one-liner) — no LLM compresses meaning into keys.
- **"Latest" is a view, not a slot.** Default read: latest overall. Cross-context catch-up reads **latest-per-origin** (e.g., a DM injects the latest *scene* line + latest *chat* line — so a social-media comment can never shadow a scene experience).
- **Retention:** a compaction ledger job prunes old entries (e.g., keep last 50 per character). Safe by construction: reflection reads session history, never CACHE history, so pruning has zero correctness impact.

### Memory — tiered, append-only (Rev 2)

A monolithic memory file does not survive 50 sessions of play (token cost, latency, context limits). Structure:

1. **Memory core** — small, always injected: identity-defining facts, active relationships, secrets pointers. Curated by Reflection.
2. **Memory archive** — everything else as **append-only deltas** `memory_delta(character, session_id, content)`, retrieved by relevance via `query` / pre-retrieval through the **Search Index** (V1: SQLite FTS5; embedding retrieval is a fenced drop-in upgrade — [§4.2](#42-engine-modules-deterministic-code--new-in-rev-2)). The social-media memory file is one such pointered sub-store.
3. **Compaction** — periodic ledger jobs summarize old deltas; because deltas are never overwritten, any bad reflection or compaction can be re-run (repair for free).

Characters can explicitly *rewind* a sub-memory (fetch the deltas behind a summarized topic) or fetch wiki/session content — all as bounded tools.

### Reflection — the recall policy

> [!important] Sessions are the source of truth; CACHE is a pointer, never the recall input.
> Reflecting from CACHE alone = summary-of-summaries drift.
> 1. **Reflection runs at session end** (join/leave-bounded — the leaver has a complete experience), as a ledger job.
> 2. **Reads session history**; CACHE only as a hint.
> 3. **Chat catch-up:** latest-per-origin CACHE instantly; escalate to scene-query → session read for specifics. Cheap hot path, accurate deep path.
> 4. Note that reflection should also write the event planned inside that session or scene. and if the event expired, the character will react to it next time it got triggered ( in scene, in chat.. like CACHE). (no message will sent in v1 yet)

**The reflection gap (resolved without tail heuristics):** sessions are readable ground truth **the instant they are logged** — they are not a cold-path product; reflection curates *long-term* memory and was never the immediate-recall mechanism. So during the gap, chat catch-up works exactly as always: latest scene-origin CACHE (written *during* the scene, so it exists before any reflection runs) for the instant answer, scene-query into the not-yet-reflected session for specifics. New-scene opens **block briefly on scoped pending jobs** instead ([§6](#6-scene-system)) — no arbitrary "inject N tail turns" guessing anywhere.

### Character Reflection — module contract

**Inputs:** session (or chat-range) history · **the character's own log-only trail** (raw attempts, payloads it authored, CACHE sequence — so self-created hidden content is never lost) · diff of memory ↔ stored reality · subgoal state.
**Outputs (via the character's mailbox):** memory deltas + core updates; may evolve personality/goals *unless locked*.

---

## 12. Social Media System (Camera)

A feed where characters share experiences. **CRON-driven; user is viewer-only in V1.**

- Daily CRON picks 3–4 random characters to post about something they experienced. **Hard ceiling: 10 posts per time skip** — the freshest window survives, older skipped posts are simply never generated (no player scrolls endless backlog; V1 builds texture and triggers, not an emergent-feed sandbox).
- **Delivery — acquaintance rule (V1):** delivered to characters who already know the poster; acquaintance = "was present in the same session."
- **Reactions:** recipients may like/comment (skill-triggered decision). No threads in V1.
- **Memory writes are two-sided** — poster's and each reactor's social-media memory file — **all through mailboxes** (a social write can never race a scene turn or DM). Social CACHE entries carry `origin: social`, so they never shadow scene context in chat catch-up.

---

## 13. Gateway (Telegram / WeChat)

Bot gateway pushing Weltari activity to the user's messenger, with a return path.

- User connects a Telegram/WeChat bot and subscribes to the GM or specific characters (DM pushes only; **no group-chat pushes**). Note that user can subscribe to GM, which will redirect other characters message with "Elias has sent you a message on Weltari! -- Elias:" note that user should be able to custom GM response. Also note when character submit event, the message "character is waiting you at `sublocation`" got pushed. and that event also has a TTL expiry time — with **no map anchor in V1** (the invitation lives in chat/gateway only; on send the character is reserved via presence, released by a hardcoded routine on expiry, [§7](#7-character-system--c-module)). Character still run reflection after they send a scene request.
- **Only CRON DMs are pushed** — and for subscribed characters these are **eagerly generated** at CRON fire ([§8](#8-messaging-system-chat)): the push carries real content, identical to what appears in Weltari Chat. 
- **Full bidirectional sync:** every message crossing the gateway, in both directions, persists into the same `conversation_id` and renders natively in Weltari Chat — the messenger is a *view* of the conversation, not a separate channel. Webhook ingestion is **deduplicated** (messengers redeliver; the bridge keys on message IDs).
- **Hard cap:** at most **3 unanswered proactive messages per thread**, then the thread freezes until the user replies ([§8](#8-messaging-system-chat)).
- Gateway messages trigger the character runtime through the same mailbox as everything else — no race with CRON or scenes.

> [!todo] Gateway plumbing
> Bot auth/registration, per-character channel mapping, push rate limits — implementation phase.

---

## 14. Map System and CRON

> [!note] Core principle
> **The database is the source of truth, not the image.** Code owns all geometry — placement, masks, coordinates, sizes; the AI fills pixels and invents narrative *inside* those constraints. Generated content is persisted, not recomputed.

**Storage (Rev 2):** the Map DB is **merged into W-DB** — every map location *is* a sublocation (coordinate, footprint, type, persistence flag, wiki ref). One database, but **write authorities stay separate** ([§4.3](#43-data-stores-all-projections-of-the-event-log-unless-noted)). **Pixels live as files on disk** (rows hold path + content hash) — map imagery grows unboundedly with outpainting and does not belong in database rows.

### Layers

- **Imagery layer** — diffusion-painted top-down map; grows by outpainting, locally rewritten by inpainting; pixels persist.
- **Overlay layer** — event bubbles anchored to world coordinates (bubble = mask centroid), decoupled from imagery so repainting never moves a pin. Dense clusters collapse into a toggle list. **Rev 2 additions:** lazy **event markers** ("!" bubbles, character-text bubbles) and CRON-moved **character position bubbles** (profile pictures at their current sublocation).
- **Data layer** — sublocations in W-DB. Authoritative.

### Sublocation creation & materialization

**Creation is hot, materialization is cold.** Any agent-side creation ([§6](#6-scene-system)) commits an **identity stub** instantly; giving an exterior-atomic stub its map presence is the **`materialize_sublocation` ledger job** — **eagerly enqueued the moment a parentless stub is created**. It reuses the Flow A contract wholesale: crop → paint → composite-back, **region locks** included. Interiors never touch the map (their parent's point is their anchor); their only asset is the backdrop image, fired immediately at creation for fluid in-scene switching (the scene UI plays a slide-style transition between backdrops).

**Placement is code-owned — no LLM ever picks a coordinate.** The solver takes the stub's `narrative_anchor` (prose hint from the creating Narrator, e.g. "near the riverside"; default anchor = the sublocation the creating scene was in) and deterministically scores **fog frontier squares**: proximity to the anchor · adjacency to the explored area (the map grows contiguously) · footprint packing. Best square wins; the painter renders it. A wrong placement is just data — the user repairs it with the lasso (God's pen; the Narrator never manipulates the map).

**Grid & fog UI.** The map is a grid of small squares. Unexplored squares render with **very faint white borders** and a **semi-transparent white overlay on hover**; clicking one shows a centered **"Unexplored Area"** label with an explicit **"Explore"** button (Cities: Skylines tile-purchase feel). While a materialization job runs, its target square shows a **spinning loading icon over a transparent grey overlay**. Explore-button reveals and materialization reveals are the same render path — one square at a time.

**Materialized-only anchoring.** CRON movement, chance-encounter markers, and Hang Around's random landing target **materialized** sublocations only. Stubs are reachable through scenes (the backdrop is enough) but invisible to the map's mechanical loops until the painter lands.

### Chance-encounter markers — the living-world loop

The map holds **at least 1 and at most 5** live chance-encounter markers at all times — designed to let the user explore anywhere with zero pressure, yet the world always offers something. Sources: **scene end** (the ending scene proposes a follow-up marker; if it has no follow-up content, the engine/CRON generates one), and CRON drops. The engine tops up below the minimum and refuses drops above the maximum.

**Engine top-up premises (decided):** an engine-generated marker behaves like any other random event — nothing is calculated until the user arrives at it. On click, the Narrator generates the encounter grounded in *current* state; frontend animation covers that generation time, so there is no pre-baked "generic ambush" pool sitting in the DB.

CRON drops events on the map as markers. Same rules as chat drops ([§8](#8-messaging-system-chat)):

- Marker = intent: `{sublocation_id, involved_characters[], premise_seed, dropped_at, ttl}`. **Nothing generates, nothing enters any log or memory, until clicked.**
- **On click:** the Scene Engine **re-validates preconditions** — are the involved characters still plausibly available/nearby? If yes, the Narrator starts writing, grounded in *current* state (late generation is narratively better than stale content); character memories are selected by hard code. If not: adapt ("A has moved on; work with who's here") or expire.
- **TTL in game time** (e.g., "3 in-game hours, stamped 12:00") — a user time-skip to 15:00 expires it naturally. Sweep runs as a periodic ledger job and inside every clock advance — no eternal pile of stale "!" bubbles. **Born-expired suppression:** during time-skip replay, a marker whose `scheduled_time + ttl < clock` is never dropped at all.
- **Click concurrency (V2-relevant, cheap now):** marker instantiation is versioned — first click instantiates the scene, a concurrent click resolves to "join scene in progress," never a duplicate parallel scene.

### CRON world movement & governance (V1's "living world")

A scheduled ledger job moves a few characters between sublocations and drops events. **Constraints:** movements route through each character's mailbox as location events; the mover **skips characters currently in an active scene** (presence check); **V1 movements land only on materialized sublocations** (stubs are skipped — nothing CRON-driven anchors to an unmaterialized sublocation, and the same rule holds for marker drops) — if a character lands somewhere storyline-odd, the fallback is character intelligence plus one skill line ("Nothing special, just passing by. What brings *you* here?"); V2's FEL replaces random placement with planned placement (with a "!" or long TTL showing this is a seed event) and the fallback simply stops firing. The world advances **only via CRON events — there is no continuous simulation tick** in V1. (V2/V3: FEL + DES, [§18](#18-v1-scope-vs-deferred-v2v3).)

**Governance — budgets by type, replay by timestamp:** each CRON type has a game-time period (+ jitter) and a cost class:


| Type                    | Meaning                                                                                                                                                                                                                    | Default period (game time)                         | Cost class                  | On time-skip                                                                                                |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Chance-encounter marker | Move existing character around at existing sublocation. No given scene and storytelling, just random interaction with the character doing something at that position. (Exact interaction is not loaded until user clicks.) | every 2–4 h in game hours, few random  characters. | Code only (pointer updates) | **Always executes**, in scheduled-timestamp order — positions must be correct on landing                    |
| Major scene             | comes with special UI (! red marker). This is submited by a character or a scene-end.                                                                                                                                      | depending on the scene itself                      | Zero until clicked (lazy)   | Born-expired markers never dropped. Still can expire but the exact time depends on what the character says. |
| Social post + reactions | Social media.                                                                                                                                                                                                              | 3–4 posts / game day                               | LLM                         | Background jobs after landing; counts against skip budget; feed ceiling 10/skip                             |
| Eager gateway DM        | DM message.                                                                                                                                                                                                                | subset of the above                                | LLM                         | Background; **highest budget priority** — the user subscribed                                               |

Global rules: all due instances execute in **scheduled-game-timestamp order, stamped with scheduled time** (the 15:30 social post runs after the 12:00–15:00 movement resolves and is stamped 15:30 — feed timelines read true); per-skip **LLM budget** (default ~10, [§15](#15-config)), over budget drop oldest-first. A skipped/expired event **never happened**: it never entered the Event Log, never wrote CACHE, never touched memory — so subsequent writer LLMs are blind to it *by construction* (event sourcing is the hard code), no filtering needed. Movement is never skipped; only the encounter *opportunities* riding on it expire — the character genuinely was at the café at 13:00, the user merely missed them.

### Models in the loop

| Role | Type | Backend |
| --- | --- | --- |
| **GM (Interview LLM)** | Text chat | OpenRouter (plug-and-play) |
| **Painter** | Image inpaint/outpaint | Capability-routed image backend |
| **VLM** | Vision-language | Multimodal; classifies map locations on jump-in |

### Flow A — Edit / add content (writing *into* the map)

1. User draws a region (pencil/lasso) + speaks intent. The drawn shape supplies the region — no segmentation model.
2. GM (interview LLM) clarifies if needed based on the skill, and fills a structured generation form.
3. Code crops a **square ~1024×1024 window** with context margin around the mask.
4. Code sends crop + prompt to the Painter **as a ledger job** (long-running, must survive interruption; retry = regenerate from persisted crop+mask; the only retry cost is one duplicate API call).
5. Code **composites back only the masked interior**, feathered — *this*, not the model, guarantees preservation. Resize first if the model returned another size.
6. Code writes the sublocation (coordinate, footprint, image refs) and places the bubble at the mask centroid. **The target region is locked while a painter job is in flight** — two overlapping edits cannot composite over each other.

Outpainting uses the same `crop + margin → paint → composite back` contract with the mask at the border. **The unknown area will be covered in fog.**

### Flow B — Jump in anywhere (reading *out of* the map)

1. **Radius check** — every sublocation marker on the map has a defined **radius**; a click landing inside any radius (or a known footprint) enters that existing sublocation — the UI indicates it, and both VLM classification and new-sublocation generation are bypassed.
2. **VLM classify** — only outside all radii: crop and ask for structured JSON (`terrain_type or building_type, is_enterable, suggested_setting, style_tags`), with nearby DB labels as anchors.
3. **Story LLM invents** within that classification (forest → forest encounter, never a throne room).
4. **Render interiors** — own coordinate space; the map coordinate is only the seed.
5. **Persist or discard** by creation flag.

### Image backend — capability routing

Per endpoint, code detects one thing: **does this model accept a real mask file?**

| Branch | Models | Code sends | Preservation guaranteed by |
| --- | --- | --- | --- |
| Mask-capable | FLUX Fill (white=edit), gpt-image-2 (transparent=edit) | crop + mask + prompt | Composite-back (model assists) |
| No mask | OpenRouter catalog, Nano Banana 2 / Gemini | crop + region-in-words prompt | Composite-back (sole guarantee) |

The compositing-layer mask always exists; a model-side mask only improves fill quality. Any community model works. User-configurable.

**Size rules:** inpaint models output at crop size (control via crop); pixel-exact models get exact dimensions; tier/ratio models (Gemini 0.5K–4K) get resized before compositing. Standardize on **square ~1024×1024 crops**.

### Persistence rules

- **`persistent`** spawns get a footprint and obey the safe-distance packing rule (with a visual margin absorbing render spill).
- **`transient`** spawns resolve and vanish — never enter the DB.

---

## 15. Config

> [!note] The one load-bearing requirement is per-character model config.

Proposed V1 sections:

- **Models / API** — global defaults + **per-character LLM params/endpoints** + **per-function routing** (see [§16](#16-cross-cutting-concerns): narrator-class vs. router-class models). Painter + VLM endpoints. User can edit this in Weltari Chat Character Settings, like in real life. or in config panel -> Engine & System -> Character Config and it actually redirects it to that character setting inside chat.
- **Storytelling** — storytelling-goals toggle; GM profiling loop on/off. This is in the config panel -> Engine & System.
- **Display** — default Scene mode (VN/Stream), animation toggles, **Auto-Advance delay**. This is inside the scene but can configure a default in config panel -> UI.
- **Gateway** — Telegram/WeChat connection; which GM/characters push. In config panel.
- **CRON / Social** — frequency of proactive DMs, social posts, world movement; **time-skip LLM budget** (default 10); marker min/max (default 1–5); gateway outreach cap (default 3/thread); feed ceiling per skip (default 10). In config panel.
- **Safety / Review** — **"review wiki writes"** toggle (routes World Agent wiki commits through the Proposal pipeline, [§10](#10-world-agent)). In config panel -> Engine & System.
- **Plugins** — installed community plugins/skills, with source + hash shown (provenance, [§2](#2-architectural-principles)). In config panel -> Plugins.
- **Data** — export / regenerate / prune (memories, wiki, map tiles, CACHE retention); **view/export/delete User Profile** (GDPR). In Config panel -> Engine & System.

Note GM can change everything here with user consent. it is exposed to GM as a tool to call. community plugin can also support GM entry point.

---

## 16. Cross-cutting Concerns

### Interruption & recovery — crash-only design

**Principle:** the recovery path *is* the startup path. Self-hosters close laptops and `docker stop` containers; the app is always safe to kill because intent is durable before work happens (Event Log + Job Ledger) and SQLite runs in WAL mode (its write-ahead journaling — last committed write survives a power cut).

| Killed during… | On disk | On next startup |
| --- | --- | --- |
| Mid-turn (LLM call in flight) | User-input event + completed events; turn envelope not closed | Engine **voids the unclosed turn**; user's input preserved for one-tap resend. Partial narration never becomes history |
| Between scene end and commits | `scene.ended` + pending jobs (written atomically together) | Workers resume pending jobs — the old "detect reflections after accidental shutdown" worry, now just normal operation |
| Mid-reflection / mid-World-Agent | Job `running`, partial output under its idempotency key | Lease expires → retried; retry overwrites its own partial, never duplicates |
| Mid-painter | Job running; canvas untouched (composite only on success) | Retry from persisted crop+mask; cost = one duplicate API call |
| Mid-CRON | Marker/job row committed or not (single write) | Nothing to repair |
| Browser closed, server alive | Everything (server authoritative) | Client reconnects to the event stream, re-renders. The world genuinely kept living |

Graceful shutdown (SIGTERM) is an optimization — finish the current turn if quick, park otherwise — never a correctness requirement. **Corollary:** Narrator subgoal state is engine-persisted per scene ([§6](#6-scene-system)); resume restores *where the story was*, re-grounding supplies *what the world is now*.

### Latency playbook (hot path)

Worst case per turn: Narrator → character → character `query` → Narrator narration = 3–5 sequential LLM calls. In order of impact:

0. **VN pacing is the primary mask** ([§5.3](#53-scene-page)): sentence-by-sentence advance + Auto-Advance decouple reading pace from generation pace, and long Narrator outputs with a per-call subgoal mean *fewer, bigger* calls instead of trigger-spam.
1. **Prompt-prefix ordering everywhere** (Principle 9) → prompt caching cuts cost and time-to-first-token.
2. **Stream and interleave:** Narrator streams scene-setting prose while the character call is in flight; VN animations mask the rest. Latency you can't remove, you hide.
3. **Right-size models per function:** `determine_who_next`, Group-chat routing, VLM classification, CACHE writing are router-class tasks — small fast models (or heuristics), configured per-function ([§15](#15-config)). Narrator-class models only where prose quality matters.
4. **Pre-retrieval over agentic lookup:** the Context Assembler pre-fetches likely wiki/memory snippets (the caller knows sublocation + participants beforehand), making the character's `query` loop (bounded at 1–2 iterations) the exception, not the rule.
5. **Sequential character calls are a design decision, not a bottleneck to fix** ([§6](#6-scene-system)) — parallel fan-out waits for V2 group scenes.

### LOG / "thinking" → natural language

The runtime is notified when a model thinks or calls a tool; events are translated for display:
- **Scene:** character thinking during `charactercall` is never registered or surfaced (private-channel contract, [§7](#7-character-system--c-module)).
- **Chat:** a character's tool call is surfaced in-character ("I forgot — that was long ago. Let me think…"); plain thinking = typing indicator.
The LOG records, in order: user input, narrator think/msg, all engine-validated tool outcomes.

### World clock & time skips

- **Authority & shape:** engine-owned fictional `{date, time}` in W-DB. **Monotonic** — forward only, ever; every TTL, expiry, and "how long since" comparison is safe by construction (nothing un-expires).
- **User skips:** sidebar UI, max **+48h** per edit, no backwards; **disabled while any scene is active** (control greys out — no mid-turn paradoxes). Chat tolerates skips freely (the character just reads the new clock time injected: "wait, two days already?").
- **Passive advance (decided):** while CRON is active the clock advances with real time. Each pushed social post or message nudges it forward; once the configured posts-per-game-day count is reached, a full game day passes. Any user activity — in-app or over the gateway — counts as present and keeps the world pushing. If the user disables social posts, the clock falls back to a user-configured maximum world-time march (default **15 game days**).
- **Injection:** clock + weather at the head of the scene-context block (Narrator) and in character prompts. **Characters always answer — availability is the product**; the clock makes replies time-aware, never unavailable ("…it's 3am. What is it?" — one skill line: *never refuse or delay due to the hour; respond as someone woken at this time would*). Time-awareness also powers expired-invitation callbacks and unanswered-outreach realism for free.
- **Weather** is deterministically generated (seeded by clock + season + world config), stored in W-DB, *read* by the Narrator — the LLM never invents weather, so narration can't contradict the UI's rain overlay. Day/night theming and seasonal palettes read the same state.
- **Skip replay ("advance the world to T"):** all due CRON instances fire in scheduled-game-timestamp order under the governance rules ([§14](#14-map-system)). The clock-spin animation blocks only on the **code class** (expiries, movement pointer updates, lazy drops — instant); **LLM-class** jobs (posts, eager gateway DMs) run in the background under the skip budget over the following minute — the user lands with world *positions* correct immediately and the feed populating shortly after, which reads as "catching up," not "broken."
- **The V2 seam:** "advance to T, firing everything due" is exactly the external contract of the future FEL/DES engine. V1 implements it as replay-due-CRONs; V2 swaps the internals for "pop the Future Event List until T" — UI, event contract, and clock rules unchanged.

### Proposal pipeline (consent)

One uniform object: `Proposal{action, diff, rationale, proposer, approvers[]}`. Any agent emits it → frontend renders the diff → approval applies through the engine → both are logged events (audit trail). V1 approver: the single user. V2: routing by scope — world mutations → world owner; personal scope → the requesting user ([§18](#18-v1-scope-vs-deferred-v2v3)). Used by: GM authoring, GM truth edits, optional wiki-write review.

### Security posture (V1)

Open-source, self-hosted: prompt injection is at the operator's own risk, **but** structural containment holds regardless: LLMs have **no system-level tools** — only engine tools, each validated; skills can never grant tools; community skill text is provenance-tagged (source + hash) in the assembler. This labeling makes a future plugin-review story (manifests, permissions) possible without retrofit, and lets users debug "why did my character act weird."

### Model routing

Distinct roles never collapse onto one provider/prompt: GM (interview), Narrator (prose), Characters (RP, per-character config), router-class functions, Painter (image), VLM (vision) — all independently configured.

### CRON

One scheduler, one ledger: social posts (daily 3–4 characters), proactive DM drops (lazy; eager for gateway subscribers), world movement (mailbox-routed, presence-checked), marker TTL sweeps, compactions, profile analysis.

---

## 17. Data Model (V1, indicative)

> [!todo] Field-level schema finalized at implementation. Shapes capture required entities + relationships. Every mutable row carries `version` (optimistic concurrency); every event carries `actor_id`.

```
Event                (Event Log — append-only)
  id, world_id, actor_id, type, payload, ts
  scene_id?, session_id?, turn_id?          // hot-path events
  provenance { source: core|user|community, hash? }

Job                  (Job Ledger)
  id, type, key,                            // key = idempotency key, e.g. (reflect, char, session)
  state(pending|running|committed|failed|parked),
  attempts, lease_until, world_id           // per-world concurrency rules (World Agent = 1)

World
  id, name, owner_actor_id
  chapter { seed, style_investments, story_goals }
  storytelling_goals_enabled, profiling_enabled, wiki_review_enabled

Character            (C-DB)
  id, world_id, name, art_set[]
  personality { text, mutable }
  goals { main[], sub[] }
  memory_core                                // small, always injected
  memory_deltas[] { session_or_conv_id, content, ts }   // append-only
  memory_compactions[]                       // summaries over delta ranges
  social_memory_ref                          // pointered sub-store
  secrets[]
  skills[] { ref, provenance }
  model_config { endpoint, params }
  presence { state: available|in_scene, scene_id? }      // engine-owned
  location_sublocation_id                    // mailbox-committed events project here

Object               (W-DB — materialize-on-touch)
  id, world_id, name,
  holder(sublocation_id | character_id | user_actor_id),   // V2 adds object_id
  payload?,                                  // prose: what it is / contains
  version

WorldClock           (W-DB, engine-owned, monotonic)
  world_id, game_date, game_time, weather_seed

Sublocation          (W-DB — merged world+map)
  id, world_id, parent_sublocation_id?,      // interiors parent to their exterior-atomic location (flat, one level)
  class(exterior_atomic|interior), type,     // atomic point units only — never region/district/town
  status(stub|materialized),                 // stub = identity only; materialize_sublocation fills geometry+pixels
  coordinate?, footprint?, radius?,          // materialized exteriors only; radius = Flow B jump-in capture zone
  narrative_anchor?,                         // prose placement hint from the creating Narrator
  persistence(persistent|transient),
  backdrop_ref?,                             // scene background image — generated eagerly at creation
  image_refs[] { path, content_hash },       // map pixels are files, not rows
  wiki_ref?                                  // may be empty until the first World Agent pass

WikiEntry
  id, kind(open|sublocation), sublocation_id?, topic, body,
  provenance { scene_id }                    // auditable, revertible

WorldTruthDelta
  id, world_id, body, provenance { scene_id | proposal_id }

Scene
  id, world_id, sublocation_id, status(active|ended),
  subgoal_state,                             // engine-persisted story position
  next_scene_registration? {                 // written by end_scene(new_scene_available)
    sublocation: existing_id | new_stub_id,
    time_offset, expected_participants[],
    premise_seed, brief_history, carried_goals[]
  },
  summary_ref, recap                         // World Agent output

Session
  id, scene_id, participants[] { actor_id | character_id }   // join/leave-bounded
  turns[]   // narration + verbatim speech only — no thinking, no raw attempts

CacheEntry           (per character, append-only)
  character_id, origin(scene|chat|social|gateway),
  session_or_conversation_id, sublocation_id, ts, one_line
  // "latest" and "latest-per-origin" are views

Conversation         (Chat)
  id, world_id?, character_id, user_actor_id, gateway_binding?
  outreach { unanswered_count, frozen: bool }   // cap 3, resets on user reply

Marker               (lazy event drop)
  id, kind(map_event|chat_dm), world_id, sublocation_id?,
  involved_characters[], premise_seed,
  dropped_at_game_time, ttl_game_time,          // expiry vs the world clock
  state(dropped|instantiated|expired), version   // first click wins; second joins

Proposal
  id, proposer_actor_id, action, diff, rationale,
  approvers[], state(pending|approved|rejected|applied)

UserProfile          (per user)
  actor_id, hypotheses[], engagement_history[]   // structured; view/export/delete

SocialPost
  id, author_character_id, body, created_at
  reactions[] { character_id, type(like|comment), body? }
```

---

## 18. V1 Scope vs. Deferred (V2/V3)

**In V1**
- Two top-level modes (Scene, Chat) + Map, Camera (viewer-only), Gateway, Config.
- Scene Engine + Narrator split; sessions; turn envelopes + budgets; `attempt → narrate`; storytelling goals/subgoals (engine-persisted).
- Characters as subagents (message/attempt/CACHE; private-channel reasoning); tiered memory (core + deltas + compaction); secrets via deliberation.
- Event Log + Job Ledger + mailboxes; crash-only recovery; SQLite (WAL) in a single container; repository layer; `actor_id`; event-stream frontend.
- GM: Proposal-gated authoring + profiling loop (with GDPR guardrails).
- World Agent: summaries + wiki + **truth deltas**; knowledge tiers; three-layer secret protection; per-world serialization.
- CRON: proactive DM drops (lazy; **eager for gateway**), daily social posts, **world movement** (mailbox-routed, presence-checked), TTL sweeps.
- Lazy map/chat event markers with precondition re-validation + TTL.
- Sublocation creation & materialization: Narrator identity stubs (children free; parentless query-first), eager backdrops, `materialize_sublocation` grid reveals, cold-boot seeding (every named place gets a row; ≥1 public + ≥1 private space).
- Gateway push (DMs only) + deduplicated return path.
- Map pipeline (Flows A/B, capability routing, region locks, painter-as-ledger-job, persistence rules), merged W-DB.

**Deferred**
- **Multiplayer (V2, over even V3):** co-present users in shared worlds *and* shared scenes. Already-shaped by V1: `actor_id`, event stream, sessions bounded by *participant* join/leave, Proposal `approvers[]`, presence/reservation, marker click-versioning, per-conversation CACHE identity. Future version adds:
  - **Roles:** world **owner** (approves world mutations) · **editor** (GM access) · **participant** (standard play: scene commits + reflections) · **passerby** (read-only; triggers no commits, no CRON).
  - **Co-presence UX:** other players appear on the map at their sublocation; a user is notified **once** when another player is around, then it's ambient.
  - **Scene LOCK:** the Narrator may lock a scene (engine-enforced) against new users/characters joining — for high-tension, no-interruption story beats.
  - **Narrative scoping:** shared truth/wiki/map/characters; per-scene narrative direction — the Narrator receives the profiles of **all users present in that scene**; chapter goals become shared background flavor until the Director exists.
  - **Open design questions:** human turn-taking policy (the engine's input loop is already "collect inputs per turn window under a pluggable policy," never "wait for THE user"); cross-scene arc coherence (→ Director).
- **Resolve loop (V2):** `attempt → resolve(event) → outcome` adjudication.
- **FEL + DES engine (V2/V3):** characters get a `submit_event` tool (model-decided or CRON-forced); submitted events enter a **Future Event List** and a **Discrete Event Simulation** engine renders them **hot (LLM) and cold (code)** — replacing random CRON with planned long-term storytelling; a **Director** follows the thesis and writes storylines.
- **Inter-agent communication (V2):** characters acting/messaging on each other's behalf, FEL-triggered (V1: refuse in-character). Note: once characters speak secrets *to each other* in sessions, the [§10](#10-world-agent) source-typing protections already cover the World Agent path; gossip *spreading* becomes FEL-driven gameplay.
- **Object system V2:** object-in-object containment (`holder = object_id` + cycle check) — required when the **Director seeds clues** (a letter deliberately planted in a desk or safe), which is when visibility gating beyond the V1 backpack/sublocation binary becomes real; access adjudication upgrades from Narrator judgment to the resolve loop.
- **Per-observer session views:** within one session, narrated = seen by all present (V1 rule; the Narrator must not narrate "secretly, unnoticed by C…" into shared session content — concealment happens via payloads or session boundaries). True per-participant visibility inside a session is a V2 complexity jump.
- **Acquaintance graph (V2):** V1 uses "same session = acquainted"; decay and extension rules are deferred.
- **Social media:** user posting, replies/threads.
- **start_scene map event markers** (V1: invitations live in chat/gateway with TTL only — no map anchor).
- **Mail** surface.
- **API-level extensibility**; plugin permission **enforcement** (V1 ships provenance labeling only).

---

## 19. Open

> [!question] Genuinely open — flagged per Rev 3 review. Needs a decision, a config number, or playtesting — not structure. Resolved questions have moved into their relevant sections; V2 questions moved to [§18](#18-v1-scope-vs-deferred-v2v3). Remaining items are sorted by the section each touches.
> - **Narrator output length control.** How long should a Narrator output be? Needs a skill-level heuristic plus playtesting ([§6](#6-scene-system)).
> - 
> - ~~**Sublocation creation authority.**~~ **Resolved:** the Narrator creates identity stubs (children freely; parentless only after a strict all-parentless query); characters query + pass free-text places via `startscene()`, never create; users create via lasso / fog-Explore / Flow B; GM via Proposal; `materialize_sublocation` owns map presence with code-owned frontier placement ([§6](#6-scene-system), [§14](#14-map-system-and-cron)).
> - **Character context caching.** How do we design the C-Module so most calls — especially context — hit the prompt cache to save tokens and costs? ([§7](#7-character-system--c-module))
> - **Backpack scarcity in practice.** Does the "limited but unknown space" skill trick actually keep object creation conservative across models, and does the engine ever enforce a *real* per-character cap as a backstop, or stay purely psychological in V1? (To research once the app is built.) ([§7](#7-character-system--c-module))
> - **Outreach retry curve.** The "natural human re-ask interval" numbers (first retry after X game-hours, second after Y) are configurable in settings, but the defaults still need tuning ([§8](#8-messaging-system-chat), [§15](#15-config)).
> - **Engagement-signal schema.** The exact structured fields for the World Agent → GM signal. (To determine when we build the app.) ([§10](#10-world-agent))
> - **FTS5 → embedding upgrade criterion.** What observed failure (characters missing memories they "should" recall at rate > N%?) triggers adopting BGE-M3 behind the SearchIndex interface. (To research after the app is built.) ([§11](#11-memory--cache-model))
> - **Gateway plumbing.** Bot auth, channel mapping, rate limits. (WeChat bot auth is a QR-code scan; Instagram bots use tokens; WeChat has a send rate limit. Details researched when we build the gateway module.) ([§13](#13-gateway-telegramwechat))
> - **Map scale / picture generation.** How do we determine the map scale (1:500?) for picture generation? ([§14](#14-map-system-and-cron))
> - **Plugin packaging format.** What a plugin *is* on disk, how it registers, and its provenance metadata (source + hash, required by Rev 3). (To discuss when we discuss the stack.) ([§15](#15-config))
> - **Config surface.** Confirm the [§15](#15-config) sections.
> - **Name→ID resolution:** agents reference characters and sublocations by *name*, not ID; a resolver layer (environment) translates names to canonical IDs before validation, and an unmatched name fails validation with a reason. *(Now load-bearing: this resolver is also `create_sublocation`'s did-you-mean dedup gate — [§6](#6-scene-system).)*

