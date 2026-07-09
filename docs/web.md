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
| `src/store.ts` | The zustand store — scene/turns/sublocation/art/world-clock (time + cron replay progress + day-1 anchor)/dev-trail projections; M4 part 2: `knownSublocations` (sublocation.materialized — Hang around + fog), `history` (every played scene from replayed scene.started/ended + roster + committed turns) and `appVersion` (hello frame). M6 part 2: `chatThreads` (character_id → DM thread from chat.message_committed/chat.ended — message_id-deduped, replay-rebuilt; reflect_chat/cache events are trail-only, no projection). Reducer actions (`applyEvent`, `applyStream`, `applyDev`) are called ONLY by stream.ts (structure.md contract). |
| `src/stream.ts` | The SSE reducer: one `EventSource` (`?dev=1` opts into the dev channel), safeParse per frame, dispatch to store actions. The only store writer. |
| `src/commands.ts` | POST helpers (start-turn, interrupt-turn, end-scene, open-scene — returns the client-generated scene id so the §1.14 cover flow can start the opening-narration turn; 0.8.0 options: `participants` for History's Continue, `sublocationId` to open AT a known place) with validated responses; fixture identity constants (incl. `WORLD_NAME` for the splash footer). |
| `src/usePacing.ts` | Sentence pacing (UI Spec §1.4): view-owned read cursor over the store's live-sentence buffer; click / Auto-Advance (localStorage pref); exposes the interrupt cut (`seen`). |
| `src/App.tsx` | The app shell (M4): Nav Rail + route switch over one SSE connection; owns pacing (so the read cursor survives navigation), the §1.14 masked transition (`openSceneCovered`: cover → open-scene → opening-narration turn → dismiss on first sentence) and the `wl-map-jump` listener (detail validated with `MapJumpDetailSchema` — jumps navigate to the Scene route first, so the cover masks them from any page). |
| `src/router.ts` | History-API routing (owner decision: no router dep — four destinations). `useRoute`/`navigate`; unknown paths render the Scene route. Route = pure view state, never store state. |
| `src/components/NavRail.tsx` | The Left Nav Rail (wireframes §0.1): logo, Scene ▶, Map, Feed, Chats, Wiki, Config; blinking clock (→ Gameday flow) + profile avatar bottom-anchored. M5 destinations (Chats/Feed/Wiki) are disabled with a "later" tooltip — never fake surfaces. Mobile: becomes a bottom bar (recorded deviation below). |
| `src/pages/ScenePage.tsx` | The Scene route in its three display modes (wireframes 05/06/07): VN, VN-with-log (docked transcript), Reader. Mode + log-panel are view state; live-turn "graduation" into the transcript (caught up + committed; interrupted turns graduate immediately). M4 part 2: shows the splash when no scene is active — a scene that ends while WATCHED keeps its soft close (§1.7 scroll-back); arriving at an already-ended scene (mount/reload/route return) shows the splash instead (`endedLive`, adjust-during-render). Hosts the History modal. |
| `src/components/SceneControls.tsx` | The top-right control cluster: VN ↔ Reader switch (book), transcript/log toggle, auto-advance, exit-scene with inline two-tap confirm (§1.7) → POST end-scene. |
| `src/components/ReaderPane.tsx` | Reader mode's prose pane: committed turns as flowing text + the live turn paced at the tail (same store + pacing as VN — switching loses nothing). |
| `src/plugins.ts` | Fetches `/v1/plugins`, injects theme stylesheets, imports component modules zero-build. Asset URLs carry the provenance hash as a cache-buster (`?v=<sha256…>`): plugin assets have no cache headers, and a stale browser-cached module would silently undo a plugin update. |
| `src/components/SceneSplash.tsx` | The scene landing splash (wireframe 03): "Adventure Awaits" + History scene / Open Map / Hang around (random KNOWN sublocation — materialized-only anchoring, Rev 4 §14 — opened AT that sublocation through the §1.14 cover); footer = world name + app version; decorative shapes are tokens (`--wl-splash-*`). |
| `src/components/HistoryModal.tsx` | The History surface (wireframe 04): modal over the Scene route listing every played scene from the store's `history` projection (title, fictional time when known, participants, expandable read-only transcript). Continue opens a NEW scene with the same title/participants through the cover — scene.ended is final, closed envelopes are never resurrected. |
| `src/components/SceneStage.tsx` | Backdrop layers (slide transition on sublocation.changed, UI Spec §1.6), sublocation chip, character line-up with speaker rise + art switches (data-art attribute → theme rules). |
| `src/components/NarrationBox.tsx` | Paced narration: revealed sentences (narrator italic / character voiced), speaker plate, thinking indicator, ▼ buffered hint, Auto toggle. Display-only text (B6). |
| `src/components/Transcript.tsx` | The committed transcript — the authoritative reading pane; `— interrupted —` marks truncated turns. Docked when the log toggle is on; full-screen overlay on mobile. Exports `TurnBlock` (shared with Reader mode). |
| `src/components/InputRow.tsx` | The chatbox. Submitting while a turn streams = interrupt path: interrupt-turn at the last displayed sentence, then start-turn. |
| `src/components/SoftClose.tsx` | Soft close (UI Spec §1.7): divider + button set by end_type (rest → Stay/Map; continuation → Stay/Jump/Map; travel → Map). Opens go through App's masked transition (§1.14); buttons disable while the cover runs. |
| `src/components/SceneCover.tsx` | The §1.14 masking cover: full-stage overlay shown from a scene-open/map-jump click until the destination's opening narration streams — continuously animated (clock-spin hands, pulsing dots, drifting veil; map jumps slide in as travel), so a 5–10 s generation window never reads as frozen. Dismissal = first streamed sentence of the masked turn, with `--wl-cover-min-duration` anti-flicker and a 30 s backstop. All durations are `--wl-cover-*` tokens. |
| `src/components/MapModal.tsx` | The pluggable map slot: renders `<wl-map>` (a plugin custom element) in a modal — kept for in-scene use (SoftClose's Open map). |
| `src/pages/MapPage.tsx` | The Map route (wireframe 08): `<wl-map>` full-page, zoom/search placeholder chrome (wired with map part 2), empty state when no plugin defines the tag. Pin jumps bubble `wl-map-jump` to the shell (§1.14 masked). |
| `src/pages/GamedayPage.tsx` | The Gameday clock flow (wireframes 11–13): "— GAMEDAY N —", sun/moon dial, digital time — all READ from `world.time_advanced` (§1.11; placeholders before the first skip). Presets +1h/+6h/To-morning (≤ +48h, forward only, greyed while a scene is active) POST advance-time; the dial's advancing animation masks the cron replay until `world_cron.completed` catches up to the skip's enqueued count (§1.14 vocabulary, `--wl-gameday-*` tokens, 30 s backstop). |
| `src/tokens.ts` | `readTokenMs` — JS reads `--wl-*` duration tokens, never owns them (structure.md rule 6). |
| `src/pages/ConfigPage.tsx` | The Config page (wireframe 15 + UI Spec §2.7 subset today's backend serves): connection/protocol/app-version facts, the update surface (update.available badge → Apply → update.staged; 409 refusal codes shown with plain-language help; update_apply job failures surfaced), loaded plugins with provenance hashes + plugin.rejected refusals. |
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
