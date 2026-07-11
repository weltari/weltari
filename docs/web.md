# web — apps/web (React 19 + Vite 8 client)

Purpose: the app shell (M4: Left Nav Rail + History-API routes) hosting the
VN Scene page (M3). Render-only by constitution (Brief §2.5) — zero game
logic, no polling; state is a projection of the SSE stream, rebuilt from the
event replay on every (re)connect. On reconnect `EventSource` resumes with
`Last-Event-ID` natively.

## Contract

- Inputs: SSE frames (`hello`/`stream`/`event`/`dev`), all safeParse-checked against `@weltari/protocol` before touching state.
- Outputs: `POST /v1/commands/…` (start-turn, interrupt-turn, open-scene). Commands go up; the client never mutates state on a 202 — truth comes back down as events.
- Never: import anything from `apps/server` (fence A13); trust an unvalidated frame; write the store from anywhere but the SSE reducer; invent state the stream didn't push.

## File table

| File | What it does / talks to |
| --- | --- |
| `index.html` / `src/main.tsx` | Vite entry; StrictMode root; imports `theme.css`. |
| `src/store.ts` | The zustand store — scene/turns/sublocation/art/world-clock (time + cron replay progress + day-1 anchor)/dev-trail projections; M4 part 2: `knownSublocations` (sublocation.materialized — Hang around + fog), `history` (every played scene from replayed scene.started/ended + roster + committed turns) and `appVersion` (hello frame). M6 part 2: `chatThreads` (character_id → DM thread from chat.message_committed/chat.ended — message_id-deduped, replay-rebuilt; reflect_chat/cache events are trail-only, no projection). M6 part 4 (0.13.0): `chat.notice` lands in the thread as a `sender: 'notice'` line (the hardcoded red system line — e.g. a startscene fire that exhausted its retry ceiling; deduped per event id); `scene.expired` closes the History entry with the "— the meeting expired —" divider and, if the expired invitation is somehow the viewed scene, resets to the splash (never a soft close — nothing happened in it). The art projection is scene-scoped: `scene.started` resets `artByCharacter` and only the current scene's `art.switched` events apply — a pose from an ended scene never leaks into the next line-up, live or replayed (pinned by `store.test.ts`). M6 part 5 (0.15.0): `feedPosts` (post → reactions → feed-local reply threads, all id-deduped), `feedNotifications` (character answers to MY replies — the bell), `feedLastEventId`/`wikiLastEventId` (the NavRail dot counters — compared against locally persisted seen marks, `seen.ts`); `subwikiBySublocation` folds `subwiki.edited` too (provenance: sceneId for a World-Agent pass, `editedByUser` for a manual edit; a manual edit never bumps the blue-dot counter). Reducer actions (`applyEvent`, `applyStream`, `applyDev`) are called ONLY by stream.ts (structure.md contract). |
| `src/stream.ts` | The SSE reducer: one `EventSource` (`?dev=1` opts into the dev channel), safeParse per frame, dispatch to store actions. The only store writer. |
| `src/commands.ts` | POST helpers (start-turn, interrupt-turn, end-scene, open-scene — returns the client-generated scene id so the §1.14 cover flow can start the opening-narration turn; 0.8.0 options: `participants` for History's Continue, `sublocationId` to open AT a known place) with validated responses; fixture identity constants (incl. `WORLD_NAME` for the splash footer). `postOpenScene`'s transition arg enforces one active scene: it ends the still-open scene FIRST (an abandoned open scene pins its characters `in_scene` — the presence rule would silence their DMs forever) and retries the open while that end's fan-out blocks it (Brief §4 scoped blocking; the cover animates the wait; pinned by `commands.test.ts`). |
| `src/usePacing.ts` | Sentence pacing (UI Spec §1.4): view-owned read cursor over the store's live-sentence buffer; click / Auto-Advance (localStorage pref); exposes the interrupt cut (`seen`). |
| `src/App.tsx` | The app shell (M4): Nav Rail + route switch over one SSE connection; owns pacing (so the read cursor survives navigation), the §1.14 masked transition (`openSceneCovered`: cover → end the still-open scene → open-scene (retrying out the fan-out window) → opening-narration turn → dismiss on first sentence) and the `wl-map-jump` listener (detail validated with `MapJumpDetailSchema` — jumps navigate to the Scene route first, so the cover masks them from any page). |
| `src/router.ts` | History-API routing (owner decision: no router dep). `useRoute`/`navigate`; unknown paths render the Scene route. Route = pure view state, never store state. M6 part 3 adds `/wiki`; M6 part 5 adds `/feed`. |
| `src/components/NavRail.tsx` | The Left Nav Rail (wireframes §0.1): logo, **Play** ▶ (renamed from "Scene", owner ruling 2026-07-11: the tab is the game, never a session artifact), Map, Feed, Chats, Wiki, Config; blinking clock (→ Gameday flow) + profile avatar bottom-anchored. Labels come from the i18n catalog. M6 part 5: every destination is live — the Feed entry routes to `/feed` with a RED activity dot (new posts AND new interactions; just a dot, never a number — owner ruling 2026-07-11) and the Wiki entry carries a BLUE dot for unseen World-Agent writes; dots compare the store's last-event-id projections against `seen.ts` marks (localStorage — an acknowledged dot never re-appears on reload). Mobile: becomes a bottom bar (recorded deviation below). |
| `src/i18n.ts` | The UI message catalog (M6 part 4, owner ruling 2026-07-11: multilingual-READY structure, no packs yet): typed keys over a single `en` catalog + `t(key)` + the `setLocale` seam — a future language pack is another partial record merged per key, zero dependencies. New user-facing strings go in as keys; existing strings migrate opportunistically. |
| `src/pages/FeedPage.tsx` | The Feed page (UI Spec §2.5, M6 part 5, Rev 4 §12): viewer-only posts newest-first from `feedPosts` (author, fictional-day stamp, body, ♥ likes row, comments). The ONE interaction (owner ruling 2026-07-11): hovering a comment greys it, clicking opens the reply box (input + Send → feed-reply command); replies and the author's answer render as a thread under the comment — no "replying…" animation by design. The bell (top right) pops the notifications window (answers to my replies, newest first; opening marks them seen). "Catching up…" chip after a LIVE skip (posts are background LLM work); empty state explains posts ride world time. Visiting marks feed activity seen (clears the rail's red dot). |
| `src/seen.ts` | Locally persisted "seen up to event id" marks (M6 part 5) — a VIEW concern (structure.md rule 1): localStorage + `useSeen`, so the rail dots survive reloads without polluting the store. Keys: feed (rail red dot), wiki (rail blue dot), feed-bell (the bell's own dot). Monotonic. |
| `src/pages/WikiPage.tsx` | The Wiki page (UI Spec §2.6, M6 part 3 — the read-only slice): list-left/entry-right over the store's `subwikiBySublocation` projection (`subwiki.updated`; latest per sublocation wins), names resolved from `knownSublocations`, provenance = "written after <scene title>" resolved from the `history` projection. Live: a scene-end's new entry arrives over the stream and re-renders. M6 part 5 (owner ruling 2026-07-11): manual edits in place — the pencil (entry header, top right) enters edit mode (a textarea; typing flushes debounced to the subwiki-edit command — applies immediately, no Proposal round-trip; flush also fires on toggle-off/selection change/unmount) and becomes a book that toggles back to read-only; provenance shows "edited by you" for a user entry. Visiting the page marks wiki activity seen (clears the rail's blue dot). |
| `src/pages/ScenePage.tsx` | The Scene route in its three display modes (wireframes 05/06/07): VN, VN-with-log (docked transcript), Reader. Mode + log-panel are view state; live-turn "graduation" into the transcript (caught up + committed; interrupted turns graduate immediately). M4 part 2: shows the splash when no scene is active — a scene that ends while WATCHED keeps its soft close (§1.7 scroll-back); arriving at an already-ended scene (mount/reload/route return) shows the splash instead (`endedLive`, adjust-during-render). Hosts the History modal. |
| `src/components/SceneControls.tsx` | The top-right control cluster: VN ↔ Reader switch (book), transcript/log toggle, auto-advance, exit-scene with inline two-tap confirm (§1.7) → POST end-scene. |
| `src/components/ReaderPane.tsx` | Reader mode's prose pane: committed turns as flowing text + the live turn paced at the tail (same store + pacing as VN — switching loses nothing). |
| `src/plugins.ts` | Fetches `/v1/plugins`, injects theme stylesheets, imports component modules zero-build. Asset URLs carry the provenance hash as a cache-buster (`?v=<sha256…>`): plugin assets have no cache headers, and a stale browser-cached module would silently undo a plugin update. |
| `src/components/SceneSplash.tsx` | The scene landing splash (wireframe 03): "Adventure Awaits" + History scene / **Go Somewhere…** (renamed from "Open Map", owner ruling 2026-07-11: the map is a tool the player uses, never the entrance) / Hang around (random KNOWN sublocation — materialized-only anchoring, Rev 4 §14 — opened AT that sublocation through the §1.14 cover); footer = world name + app version; decorative shapes are tokens (`--wl-splash-*`). |
| `src/components/HistoryModal.tsx` | The History surface (wireframe 04): modal over the Scene route listing every played scene from the store's `history` projection (title, fictional time when known, participants, expandable read-only transcript). Continue opens a NEW scene with the same title/participants through the cover — scene.ended is final, closed envelopes are never resurrected. |
| `src/components/SceneStage.tsx` | Backdrop layers (slide transition on sublocation.changed, UI Spec §1.6), sublocation chip, character line-up with speaker rise + art switches (data-art attribute → theme rules). |
| `src/components/NarrationBox.tsx` | Paced narration: revealed sentences (narrator italic / character voiced), speaker plate, thinking indicator, ▼ buffered hint, Auto toggle. Display-only text (B6). |
| `src/components/Transcript.tsx` | The committed transcript — the authoritative reading pane; `— interrupted —` marks truncated turns. Docked when the log toggle is on; full-screen overlay on mobile. Exports `TurnBlock` (shared with Reader mode). |
| `src/components/InputRow.tsx` | The chatbox. Submitting while a turn streams = interrupt path: interrupt-turn at the last displayed sentence, then start-turn. |
| `src/components/SoftClose.tsx` | Soft close (UI Spec §1.7): divider + button set by end_type (rest → Stay/Map; continuation → Stay/Jump/Map; travel → Map). Opens go through App's masked transition (§1.14); buttons disable while the cover runs. |
| `src/components/SceneCover.tsx` | The §1.14 masking cover: full-stage overlay shown from a scene-open/map-jump click until the destination's opening narration streams — continuously animated (clock-spin hands, pulsing dots, drifting veil; map jumps slide in as travel), so a 5–10 s generation window never reads as frozen. Dismissal = first streamed sentence of the masked turn, with `--wl-cover-min-duration` anti-flicker and a 30 s backstop. All durations are `--wl-cover-*` tokens. |
| `src/components/MapModal.tsx` | The pluggable map slot: renders `<wl-map>` (a plugin custom element) in a modal — kept for in-scene use (SoftClose's Open map). |
| `src/pages/MapPage.tsx` | The Map route (wireframe 08): `<wl-map>` full-page, zoom/search placeholder chrome (wired with map part 2), empty state when no plugin defines the tag. Pin jumps bubble `wl-map-jump` to the shell (§1.14 masked). |
| `src/pages/ChatPage.tsx` | Weltari Chat (UI Spec §2.4, M6 part 2): desktop list-left/conversation-right over the store's `chatThreads` projection (replay-rebuilt — a reload loses nothing). Conversation list = `CHAT_CHARACTERS` (the fixture roster constant, like open-scene's) with presence dots; presence = the character sits in the open scene's cast (same events the server gate reads) — in_scene shows offline and the input says messages wait. Typing indicator is view state: set by the send 202's `replying` (guarded against the reply landing first), cleared when the committed reply arrives, 60 s backstop. "End chat" = exit-chat. Commands in commands.ts (`postSendChatMessage`/`postExitChat`/`postStartSceneFromChat`); route `/chats` (router + NavRail enabled). M6 part 3 (owner ruling 2026-07-09): meeting is character-led — the character negotiates in chat and fires `startscene` itself; the "Meet in a scene (dev)" button (place input → start-scene-from-chat → navigate to the Scene route) survives only behind dev mode (`devMode` prop from App's `?dev=1`) as a zero-cost testing shortcut. The server bridge owns the one-active-scene transition for both paths. M6 part 4 (0.14.0, UI Spec §2.4 group view): a Groups section under the character list — “+ New group” starts a group with the whole DM roster (user-started only, Rev 4 §8); selecting one swaps the right pane to `GroupConversation` (speaker-labeled member bubbles routed by the Group-chat Narrator up to the engine budget, send → send-group-message, “End group chat” → exit-group-chat, ended divider). Mara joined `CHAT_CHARACTERS` (groups need ≥2). M7 part 2 (0.17.0, Rev 4 §9/§16): the GM tops `CHAT_CHARACTERS` (`char:gm`) as a standing conversation — presence "always here", no End chat, no lock, no meet button, and excluded from groups (`GROUPABLE`); the GM thread renders the pending consent cards (`ProposalCard`) after its messages. Every non-GM conversation header gains the evolution-lock toggle (`postSetCharacterLock` — the `characterLocks` fold flips the label; the very next reflection honors it). |
| `src/components/ProposalCard.tsx` | The consent card (0.17.0, Rev 4 §16, owner UX ruling 2026-07-11): a pending proposal inside the GM conversation — per-action diff rendering (place/character/wiki before-after/whole seed world), the GM's rationale, and three buttons like a permission prompt: Consent / Reject (`postResolveProposal`; the card settles only when `proposal.resolved` arrives on the stream) and "Chat about this" (prefills the GM input; the card STAYS pending while you talk it over). Styling on `--wl-proposal-*` tokens + the existing ok/danger colors. |
| `src/pages/GamedayPage.tsx` | The Gameday clock flow (wireframes 11–13): "— GAMEDAY N —", sun/moon dial, digital time — all READ from `world.time_advanced` (§1.11; placeholders before the first skip). Presets +1h/+6h/To-morning (≤ +48h, forward only, greyed while a scene is active) POST advance-time; the dial's advancing animation masks the cron replay until `world_cron.completed` catches up to the skip's enqueued count (§1.14 vocabulary, `--wl-gameday-*` tokens, 30 s backstop). |
| `src/tokens.ts` | `readTokenMs` — JS reads `--wl-*` duration tokens, never owns them (structure.md rule 6). |
| `src/pages/ConfigPage.tsx` | The Config page (wireframe 15 + UI Spec §2.7 subset today's backend serves): connection/protocol/app-version facts, the update surface (update.available badge → Apply → update.staged; 409 refusal codes shown with plain-language help; update_apply job failures surfaced), loaded plugins with provenance hashes + plugin.rejected refusals. M7 part 2 (0.17.0, Rev 4 §15/§9 Job 2): the Engine & System section — the profiling toggle (badge from the `profilingEnabled` fold; `postSetConfigFlag`, truth is the stream) + the GDPR trio: View (fetched from GET /v1/profile on demand — the hypotheses never ride the stream), Export (a plain download link), Delete (two-tap confirm → `postDeleteProfile`). |
| `src/components/DevOverlay.tsx` | Dev mode (?dev=1): tool calls, B6-gate rejections, gauges, loaded-plugin provenance — deliberately alien styling (never reads as play). |
| `src/theme.css` | ALL colors/fonts/motion as CSS custom properties — the reskin surface (see below). |
| `vite.config.mjs` | Dev proxy `/v1` → `127.0.0.1:7777`; the built app (`npm run build`) is served by Fastify itself from the same process (`http/static.ts`, FINAL item 2) — production needs zero Vite process. |
| `structure.md` | The in-repo module contract + customization guide for (third-party AI) frontend editors (UI Spec §1.13). |

## Customizing the UI (owner guide)

Three layers, cheapest first:

1. **Reskin (no code):** every color, font, gradient and duration lives in
   `src/theme.css` as a `--wl-*` custom property on `:root`. Change a value
   there — or, once the plugin loader serves `theme.css` overrides, drop a
   plugin that redefines the same tokens per world (UI Spec §1.13). Notable
   groups: core palette (`--wl-bg`, `--wl-accent`…), voices
   (`--wl-narrator-text`…), one backdrop token per sublocation id
   (`--wl-backdrop-*` — swap gradients for `url(...)` images any time), art
   accents per pose (`--wl-art-*`), motion (`--wl-slide-duration`…), layout
   (`--wl-stage-min-height`, `--wl-transcript-width`).
2. **Re-arrange (small code):** components are small and single-purpose
   (file table above); `App.tsx` is the only place that composes them. Moving
   the transcript, restyling the line-up, or swapping the narration box means
   editing one file, and any AI agent pointed at `apps/web/structure.md` has
   the binding rules.
3. **Replace a surface (plugin):** custom-element surfaces (`<wl-*>`) arrive
   with the plugin loader — a plugin can replace a whole surface without
   touching this package.

Placeholder art: portraits are initial-letter cards accented per pose
(`data-art` rules in theme.css); backdrops are gradients keyed by
sublocation id. Real images slot in without component changes: backdrops via
the `--wl-backdrop-*` tokens (or `backdrop_path` once the painter generates
scene backdrops), portraits by swapping `.wl-portrait-figure` for an `<img>`.

## Deviations recorded

- Mobile nav (M4): the wireframes assume desktop landscape (§0.1); on ≤760px
  viewports the rail renders as a bottom bar (thumb-reachable, standard mobile
  idiom) instead of a left rail. Same component, CSS-only.
- zustand landed (the recorded M3 deferral) — dep ledger entry, exact pin 5.0.14.
- ~~The line-up cast is a hardcoded fixture constant (`SceneStage.CAST`)~~ —
  resolved in M4: the cast is a store projection of `character.joined` events
  (protocol 0.7.0), emitted at scene open. Dev DBs seeded before 0.7.0 show an
  empty line-up until a new scene opens (delete the dev DB to re-seed).
- Frontend is excluded from coverage gates (Guide E3); verified by driving the
  real stack in a browser (fake LLM + fault-pause interrupt window).
