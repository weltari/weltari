# apps/web — module contract (for human and AI editors)

This package is the built-in web client. It is **render-only** (Brief §2.5):
it renders the server-pushed event stream and captures input. If an edit adds
game logic, bookkeeping, or state the stream didn't push, the edit is wrong.

## What this module owns

- The app shell: the Left Nav Rail (wireframes §0.1) + History-API routing
  (`src/router.ts` — no router dependency). Routes are pure view state; every
  page renders from the same store projections.
- The Scene page (VN stage, paced narration, transcript, chatbox, soft close).
- The default theme (`src/theme.css`) — every color/font/motion value is a
  `--wl-*` CSS custom property; per-world reskins override tokens, never
  components (UI Spec §1.13).

## Binding rules

1. **One writer.** The zustand store (`src/store.ts`) is written ONLY by the
   SSE reducer (`src/stream.ts`). Components read via `useSceneStore`
   selectors. View concerns (read cursor, toggles) live in React state, never
   in the store.
2. **Everything is boundary data.** Every SSE frame and every command
   response is `safeParse`d against `@weltari/protocol` before use. No `any`,
   no type assertions (repo-wide rule).
3. **No server imports.** This package imports `@weltari/protocol` (and later
   `@weltari/plugin-sdk`) — never `apps/server/**` (lint-fenced, A13).
4. **Commands up, events down.** A 202 never mutates local state; the store
   changes when the resulting event arrives on the stream.
5. **Display-only text stays display-only.** Streamed sentences render dimmed
   /live; only `turn.committed` text enters the transcript (Guide B6).
6. **Generation is always masked (UI Spec §1.14).** Scene opens and map jumps
   go through `App`'s `openSceneCovered` — the `SceneCover` overlay animates
   continuously (clock-spin/dots/drift) from the click until the destination's
   opening narration streams. Plugin map surfaces request jumps by dispatching
   a bubbling `wl-map-jump` CustomEvent whose detail is validated against
   `MapJumpDetailSchema` — plugins never open scenes themselves. Animation
   durations are `--wl-cover-*` tokens; JS reads them via `readTokenMs`, never
   owns them.

## How to customize

- **Colors/fonts/backdrops/motion:** edit tokens in `src/theme.css`. Backdrop
  per sublocation: `--wl-backdrop-<id>`; art accent per pose: `--wl-art-<id>`.
  Gradients can become `url(...)` images without any component change.
  Painter-GENERATED backdrops (0.10.0, `painter.completed` for
  `backdrop:<sublocation_id>` images) override the token layer at runtime:
  the store's `backdropBySublocation` feeds `SceneStage`, which cover-crops
  the real image and replays the §1.6 slide the moment one lands live; ids
  without a generated backdrop keep the themed placeholder.
- **Layout/composition:** `src/App.tsx` composes the surfaces; each component
  in `src/components/` owns one surface and reads the store directly.
- **New event types:** extend the reducer switch in `src/store.ts` (it is
  exhaustive over `WeltariEvent` — the compiler lists every place to touch).

## Never

- Poll an endpoint (the stream pushes everything, UI Spec §1.2).
- Parse or display pino/log output (dev mode reads the typed dev channel).
- Assume "the user" is a singleton — `actor_id` flows through every command.
