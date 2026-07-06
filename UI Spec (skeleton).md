<h1 align="center"><code>Weltari — UI Spec <span style="color:#0080ff;">●</span></code></h1>

> [!info] Document status
> **DRAFT skeleton.** Section 1 is binding and complete (imported from the [Rev 4 architecture spec](<Weltari V1 - Architecture & Structure (Rev 4).md>)). Section 2 is a stubbed per-surface inventory — purpose, key states, and event-stream bindings only. No visual design yet; visuals, prototypes and Figma exports will be added by the author.

---

## 1. Binding constraints (from Rev 4 — not negotiable in this document)

Everything below is decided in the architecture spec. UI design may elaborate them; it may not contradict them.

1. **Render only.** The frontend renders the server-pushed event stream and captures input. It contains **no game logic** — no bookkeeping, no state transitions, no adjudication. ([§2 Principle 11](<Weltari V1 - Architecture & Structure (Rev 4).md#2-architectural-principles>), [§5](<Weltari V1 - Architecture & Structure (Rev 4).md#5-frontend-surfaces>))
2. **One persistent event stream, never polling.** Streaming narration, typing indicators, CRON arrivals, gateway echoes, backpack updates and proposals all ride the same server-pushed connection, and CRON/gateway events must surface **on any page**. On reconnect the client re-renders from the stream — the server is authoritative. ([§1](<Weltari V1 - Architecture & Structure (Rev 4).md#1-overview--vision>), [§16](<Weltari V1 - Architecture & Structure (Rev 4).md#16-cross-cutting-concerns>))
3. **`actor_id` everywhere.** No UI state may assume "the user" is a singleton. ([§1](<Weltari V1 - Architecture & Structure (Rev 4).md#1-overview--vision>))
4. **Scene pacing is the primary latency mask.** Narration advances **sentence-by-sentence per click**, with a configurable **Auto-Advance** mode. Reading pace is decoupled from generation pace. The user can **interrupt the stream at any point**; interrupting guides them into the chatbox and the engine closes the turn envelope at that point. ([§5.3](<Weltari V1 - Architecture & Structure (Rev 4).md#53-scene-page>), [§6](<Weltari V1 - Architecture & Structure (Rev 4).md#6-scene-system>))
5. **Two scene display modes.** **VN mode**: 1 character centered; 2–5 in an animated line-up with speaker rise; **>5 present forces Stream mode**. Art switches come from the Narrator's engine-validated `switch_art` tool. **Stream mode**: Narrator in *italic* without avatar; characters with avatar + name; backdrop behind a semi-transparent panel. ([§5.3](<Weltari V1 - Architecture & Structure (Rev 4).md#53-scene-page>))
6. **Backdrop slide transitions.** `change_sublocation` swaps the scene backdrop with a slide-style, PowerPoint-like transition; eagerly generated backdrops make mid-scene switching fluid even for brand-new stubs. ([§6](<Weltari V1 - Architecture & Structure (Rev 4).md#6-scene-system>), [§14](<Weltari V1 - Architecture & Structure (Rev 4).md#14-map-system-and-cron>))
7. **Scene end is a soft close.** A subtle divider ("— evening falls —"), never a "scene over" screen; scroll-back stays readable. The button set depends on the `end_scene` type: **Stay longer / Jump to the next scene / Open map** (Jump absent when no continuation exists). Exit shows a confirm popup and renders an in-character leave reason. Time-advance on these buttons is instant. ([§6](<Weltari V1 - Architecture & Structure (Rev 4).md#6-scene-system>))
8. **Map UI contract.** Grid fog: unexplored squares have very faint white borders, a semi-transparent white overlay on hover, and a centered "Unexplored Area" label with an **Explore** button on click. A running materialization shows a **spinning loader over a transparent grey overlay on its target square** — Explore reveals and materialization reveals share one render path, one square at a time. Overlay pins anchor to world coordinates (never to pixels; repaint never moves a pin); dense clusters collapse to a toggle list. User drawing = pencil/lasso (Flow A); clicks inside a sublocation's radius enter it directly (Flow B). ([§14](<Weltari V1 - Architecture & Structure (Rev 4).md#14-map-system-and-cron>)) **Owner decision (2026-07-06): the map renderer is a pluggable frontend component** — geometry, fog state, markers and pixels are backend truth delivered over documented map connectors/events; a plugin may replace the default map UI wholesale, so the default renderer must not depend on private backend access.
9. **Backpack is a live projection.** Every object commit is an event; the backpack updates in the same frame as the narration that caused it. No polling, no refresh button. ([§7](<Weltari V1 - Architecture & Structure (Rev 4).md#7-character-system--c-module>))
10. **Proposals render uniformly.** Any consent-gated mutation arrives as `Proposal{action, diff, rationale}`; the frontend renders the diff and captures approve/reject. One component, all agents. ([§16](<Weltari V1 - Architecture & Structure (Rev 4).md#16-cross-cutting-concerns>))
11. **Clock & weather are read, never invented.** Day/night theming, seasonal palettes and the rain overlay read engine-owned W-DB state. The time-skip control lives in the sidebar, max +48h, forward-only, **greyed out while any scene is active**. Skip replay: world positions correct immediately, feed populates in the background ("catching up", not "broken"). ([§16](<Weltari V1 - Architecture & Structure (Rev 4).md#16-cross-cutting-concerns>))
12. **Chat presence rule.** A character with presence `in_scene` shows as **offline in chat**. Outreach threads freeze at 3 unanswered proactive messages until the user replies. ([§6](<Weltari V1 - Architecture & Structure (Rev 4).md#6-scene-system>), [§8](<Weltari V1 - Architecture & Structure (Rev 4).md#8-messaging-system-chat>))
13. **Plugin-editable, per-world reskinnable frontend.** Recolor, re-font, retheme per world must be easy — plugin-level ease is a **V1 requirement**, ideally with `structure.md`/`skill.md` so third-party AI agents can edit the frontend directly. The GM may rename product-facing surfaces (agent names, UI labels, greeting copy) to fit the world. ([§2 Principle 7](<Weltari V1 - Architecture & Structure (Rev 4).md#2-architectural-principles>), [§9](<Weltari V1 - Architecture & Structure (Rev 4).md#9-gm-agent>))
14. **Animations cover generation.** Marker clicks, map jumps, scene transitions and time-skips all lean on frontend animation to absorb LLM/painter latency (5–10 s budget before content streams — Phase-2 decision). ([§14](<Weltari V1 - Architecture & Structure (Rev 4).md#14-map-system-and-cron>), [§16](<Weltari V1 - Architecture & Structure (Rev 4).md#16-cross-cutting-concerns>))
15. **Mobile browser support is required** with a dedicated mobile UI (Phase-2 decision, not in Rev 4). Rev 4 already specifies the chat layout split: desktop = list left / conversation right; mobile = list → conversation. ([§8](<Weltari V1 - Architecture & Structure (Rev 4).md#8-messaging-system-chat>))
16. **Dev mode (owner decision, 2026-07-06 — V1 requirement for debugging).** A toggleable mode that makes the normally `<log-only>` trail visible in Scene, Chat and group chats: Narrator raw output and tool calls, character **thinking**, raw `attempt` text, tool calls and CACHE writes. Display-only: it changes what the *user* sees, never what any *agent* receives — the private-channel contract ([§7](<Weltari V1 - Architecture & Structure (Rev 4).md#7-character-system--c-module>)) stays intact because dev mode reads the LOG ([§16](<Weltari V1 - Architecture & Structure (Rev 4).md#16-cross-cutting-concerns>)), it does not inject. Backend implication: the event stream needs a dev channel (log-only events pushed when dev mode is on, or streamed LOG access). By design it spoils secrets — it is a debugging surface, clearly visually distinct from play. Visual design by the owner, to be added here.

---

## 2. Per-surface inventory (stubs — to be expanded with visual design)

> [!todo] Each stub lists only: **Purpose · Key states · Event-stream bindings.** Layout, componentry, and art direction come later (Figma / prototypes).

### 2.1 World Page

- **Purpose:** entry point — pick or continue a world; reach global Weltari Chat, Config, Github.
- **Key states:** last-played world centered with "Continue"; world list; empty state (no worlds → cold-boot onboarding).
- **Event-stream bindings:** CRON/gateway arrivals may surface here (global chat badge); world list updates.

### 2.2 Scene Page (VN / Stream)

- **Purpose:** the immersive RP surface; renders Narrator narration + character speech, captures user input.
- **Key states:** landing (blue sky, History Scene / Open Map / Hang Around); active scene in VN mode (1 / 2–5 / >5→Stream); active scene in Stream mode; streaming vs waiting-for-input; interrupted; soft-closed with continuation buttons; exit-confirm popup; resume/revisit; idle-paused.
- **Event-stream bindings:** narration sentence stream; character turns; `switch_art`; backdrop change (slide transition); backpack object events; subgoal-invisible turn envelopes (interrupt closes them); scene-ended + button-set event.

### 2.3 Map

- **Purpose:** the living world view — explore, jump in, repair via lasso, see characters and event markers.
- **Key states:** explored vs fog squares; hover / clicked-unexplored ("Explore"); materialization-in-progress (spinner square); marker states (live "!", character bubble, cluster list, expired-removed); lasso/pencil draw mode; Flow B click (inside radius vs VLM-classify).
- **Event-stream bindings:** sublocation materialized (square reveal); marker dropped/expired; character position bubbles (CRON moves); painter job progress; clock/weather overlay changes.

### 2.4 Chat (Weltari Chat)

- **Purpose:** whatsapp-like DMs with characters, the GM persona, and user-started group chats; global (all worlds) or world-filtered.
- **Key states:** conversation list (with presence: offline while `in_scene`); DM view; group view; frozen thread (3 unanswered); typing indicator / in-character tool-call surfacing; `startscene()` invitation (with TTL) → scene handoff; gateway-mirrored messages rendering natively.
- **Event-stream bindings:** incoming CRON DMs (eager, identical to gateway push); typing/thinking indicators; presence changes; invitation expiry; conversation updates from gateway return path.

### 2.5 Field (Social feed, "Camera")

- **Purpose:** viewer-only feed of character posts + like/comment reactions; world texture and scene triggers.
- **Key states:** feed (ceiling 10 posts per skip); post with reactions; empty state; "catching up" state after a time skip.
- **Event-stream bindings:** post created; reaction added; skip-replay background population.

### 2.6 Wiki

- **Purpose:** browse Open Wiki + sublocation wikis; manual user edits to wiki and character memory.
- **Key states:** open-wiki list/entry; sublocation-wiki entry (with provenance: which scene wrote it); edit mode; optional "review wiki writes" queue (Proposal-gated).
- **Event-stream bindings:** wiki entry created/updated (World Agent commits); proposal events when review toggle is on.

### 2.7 Config

- **Purpose:** Models/API (global + per-character + per-function routing, painter, VLM), Storytelling toggles, Display defaults, Gateway, CRON/Social budgets, Safety/Review, Plugins (with provenance), Data (export/prune/GDPR profile view-export-delete).
- **Key states:** section panels per [§15](<Weltari V1 - Architecture & Structure (Rev 4).md#15-config>); character-config redirect into that character's chat settings; GM-proposed config changes (Proposal diff).
- **Event-stream bindings:** proposal events (GM config changes); gateway connection status; job/budget status readouts.

### 2.8 Dev mode (Scene / Chat / Group overlay)

- **Purpose:** V1 debugging — reveal the full log-only trail (thinking, tool calls, raw attempts, CACHE writes) inline in Scene, Chat and group chats; understand "why did my character act weird."
- **Key states:** off (default) / on; per-message expanded trace vs collapsed play view; visual distinction from normal play (spoiler-safe styling); provenance display for injected skills (source + hash, per [§2 P8](<Weltari V1 - Architecture & Structure (Rev 4).md#2-architectural-principles>)).
- **Event-stream bindings:** dev channel — log-only events (thinking, tool call + validation outcome, CACHE entries, turn envelope open/close) interleaved with the exposed stream when enabled.

### 2.9 Cold-boot onboarding (GM-guided world creation)

- **Purpose:** first-launch in-fiction setup: language → API keys → world interview → cold-boot generation.
- **Key states:** language pick; key/endpoint entry (pre-GM, static UI); GM interview chat (GM "comes alive"); structured world-form review; generation progress (wiki, characters, chapter seed, starting map, seed sublocations); failure/retry per generation step (ledger-backed).
- **Event-stream bindings:** generation job progress events; GM interview messages; proposal-style confirmation of the filled world form.

---

> [!todo] Next: per-surface visual design, component inventory, motion spec (line-up animation, speaker rise, slide transitions, clock-spin), theming tokens for per-world reskins, and the dedicated mobile layouts. Prototype screenshots / Figma exports land here.
