# web — apps/web (React 19 + Vite 8 client)

Purpose: the real VN Scene page (M3, replacing the Week-1 stream dump).
Render-only by constitution (Brief §2.5) — zero game logic, no polling; state
is a projection of the SSE stream, rebuilt from the event replay on every
(re)connect. On reconnect `EventSource` resumes with `Last-Event-ID` natively.

## Contract

- Inputs: SSE frames (`hello`/`stream`/`event`/`dev`), all safeParse-checked against `@weltari/protocol` before touching state.
- Outputs: `POST /v1/commands/…` (start-turn, interrupt-turn, open-scene). Commands go up; the client never mutates state on a 202 — truth comes back down as events.
- Never: import anything from `apps/server` (fence A13); trust an unvalidated frame; write the store from anywhere but the SSE reducer; invent state the stream didn't push.

## File table

| File | What it does / talks to |
| --- | --- |
| `index.html` / `src/main.tsx` | Vite entry; StrictMode root; imports `theme.css`. |
| `src/store.ts` | The zustand store — scene/turns/sublocation/art/dev-trail projections. Reducer actions (`applyEvent`, `applyStream`, `applyDev`) are called ONLY by stream.ts (structure.md contract). |
| `src/stream.ts` | The SSE reducer: one `EventSource` (`?dev=1` opts into the dev channel), safeParse per frame, dispatch to store actions. The only store writer. |
| `src/commands.ts` | POST helpers (start-turn, interrupt-turn, open-scene) with validated responses; fixture identity constants. |
| `src/usePacing.ts` | Sentence pacing (UI Spec §1.4): view-owned read cursor over the store's live-sentence buffer; click / Auto-Advance (localStorage pref); exposes the interrupt cut (`seen`). |
| `src/App.tsx` | The Scene page shell: header (title, world clock, connection), stage column + transcript, dev overlay; decides when the live turn "graduates" into the transcript (caught up + committed; interrupted turns graduate immediately). |
| `src/components/SceneStage.tsx` | Backdrop layers (slide transition on sublocation.changed, UI Spec §1.6), sublocation chip, character line-up with speaker rise + art switches (data-art attribute → theme rules). |
| `src/components/NarrationBox.tsx` | Paced narration: revealed sentences (narrator italic / character voiced), speaker plate, thinking indicator, ▼ buffered hint, Auto toggle. Display-only text (B6). |
| `src/components/Transcript.tsx` | The committed transcript — the authoritative reading pane; `— interrupted —` marks truncated turns; slide-over panel on mobile. |
| `src/components/InputRow.tsx` | The chatbox. Submitting while a turn streams = interrupt path: interrupt-turn at the last displayed sentence, then start-turn. |
| `src/components/SoftClose.tsx` | Soft close (UI Spec §1.7): divider + button set by end_type (rest → Stay/Map; continuation → Stay/Jump/Map; travel → Map). Map button enables when the wl-map plugin lands. |
| `src/components/MapModal.tsx` | The pluggable map slot: renders `<wl-map>` (a plugin custom element) in a modal; the Map buttons light up via `customElements.whenDefined('wl-map')`. |
| `src/components/DevOverlay.tsx` | Dev mode (?dev=1): tool calls, B6-gate rejections, gauges, loaded-plugin provenance — deliberately alien styling (never reads as play). |
| `src/theme.css` | ALL colors/fonts/motion as CSS custom properties — the reskin surface (see below). |
| `vite.config.mjs` | Dev proxy `/v1` → `127.0.0.1:7777`; the built app is later served by Fastify itself (FINAL item 2). |
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

- zustand landed (the recorded M3 deferral) — dep ledger entry, exact pin 5.0.14.
- The line-up cast is a hardcoded fixture constant (`SceneStage.CAST`) until a
  character-roster projection event exists.
- Frontend is excluded from coverage gates (Guide E3); verified by driving the
  real stack in a browser (fake LLM + fault-pause interrupt window).
