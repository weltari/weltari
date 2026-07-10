# Code tour — web (the browser app)

`apps/web` is the browser app the player actually looks at: a React 19 + Vite 8
website that draws the visual-novel-style scenes, the world map, DM-style
chats with characters, a "Gameday" clock, and a config screen. It is a
**render-only client**: everything you see is a picture of what the server has
already decided. The browser never invents game outcomes, never rolls dice,
never decides what a character says — it just listens to a live stream of
events pushed from the server and paints them on screen, and when the player
does something (types a line, clicks "open scene", advances the clock) the
browser sends that request to the server and then waits for the server's
answer to come back down the same stream before changing anything on screen.
Pages are organized around a handful of "routes" (think: separate screens
you can navigate between, like Scene, Map, Chats, Gameday, Config), all of
which read from one shared pool of app state that only one piece of code is
allowed to update.

Throughout this tour: a **component** is a self-contained piece of UI (like a
button bar or a text box) written as a function that returns what should
appear on screen. A **hook** is a reusable bit of logic a component can plug
into (React's naming convention: hook names start with `use`). A **route** is
one of the app's named screens/URLs. **Theming/tokens** means colors, fonts
and animation timings are all stored as named CSS variables (`--wl-*`) instead
of being hard-coded in components, so the whole look can be swapped by
editing one file.

## Entry point

### `apps/web/index.html`
The bare skeleton HTML page: an empty `<div id="root">` that React will fill,
and a `<script>` tag that loads the app's real starting file.

### `apps/web/src/main.tsx`
The actual startup code. It finds that empty `<div id="root">`, loads the
theme's CSS file, and tells React to draw the `App` component into it,
wrapped in React's "StrictMode" (a development-time safety net that catches
some common mistakes).

### `apps/web/vite.config.mjs`
Configuration for Vite, the tool that runs the app during development and
builds it for production. Its only real job here: while developing, forward
any request to `/v1` or `/plugins` to the real server running on port 7777,
so the browser app and the server can be developed side by side.

### `apps/web/src/App.tsx`
The app's shell — the outermost component that ties everything together. It
decides which route/page is currently showing, opens the one live connection
to the server's event stream, and owns two important cross-cutting features:
- **The masking "cover" animation** (`openSceneCovered`): whenever the player
  opens a new scene or jumps somewhere on the map, generating that content
  takes the server several seconds. Instead of showing a frozen or blank
  screen, `App` shows a continuously animated overlay (a spinning clock face
  and pulsing dots) until the first sentence of the new scene actually
  arrives, then fades it out. There's also a 30-second safety timer so the
  cover can never get stuck forever even if something goes wrong.
- **Listening for map jumps**: when a map plugin wants to send the player
  somewhere, it fires a browser event called `wl-map-jump`; `App` validates
  that event's contents against the shared protocol rules, closes the map,
  navigates to the Scene screen, and starts the masked-cover transition into
  the new place.

It also renders the Left Nav Rail (the sidebar), the current page (Scene,
Map, Gameday, Chats, or Config depending on the route), the map's popup
modal, and — only when the URL has `?dev=1` — a developer diagnostics
overlay.

### `apps/web/src/router.ts`
A tiny hand-written router (the project deliberately avoids adding a router
library since there are only five destinations). It reads the browser's
current URL path and turns it into one of five known routes (`/`, `/map`,
`/gameday`, `/chats`, `/config`); anything else falls back to the Scene
route. `navigate()` changes the URL without a full page reload, and
`useRoute()` is the hook components use to find out which route is active.
Crucially, the route is just "which screen is showing" — it never stores any
game data, so switching screens can never lose or corrupt anything.

## The store + the SSE reducer (the single source of truth)

Two files work together as the heart of the render-only design. Picture a
single inbox where every message the server ever sends about the world lands,
and a single clerk whose only job is to read that inbox and update one big
notebook (the app's state) accordingly. Every component in the app just reads
pages out of that notebook — nothing else is allowed to write in it.

### `apps/web/src/store.ts`
The notebook itself — a "zustand store" (zustand is a small state-management
library; think of it as a shared box of data that any component can read
from, and that re-draws components automatically when it changes). It holds
things like: is the app connected, which scene is open, the roster of
characters currently on stage, the map locations discovered so far, every
scene ever played (for the History screen), the world's in-game clock, chat
message threads with each character, and diagnostic info for developers. The
notebook also defines the rules for how each kind of incoming server event
updates it — for example, a `scene.started` event resets the current scene
and appends a new entry to the "history" list; a `turn.committed` event
appends a finished line of dialogue/narration to the transcript; a
`chat.message_committed` event appends one message to that character's DM
thread, skipping it if it's already been recorded (so replaying the same
event twice never double-counts it). The file is explicit that these update
functions may ONLY ever be called from `stream.ts` — no component is allowed
to call them directly.

### `apps/web/src/stream.ts`
The clerk. It opens one persistent connection to the server (`EventSource`,
a browser feature for one-way live server-to-browser streaming that
automatically reconnects itself if the connection drops). Every message
that arrives is treated as untrusted input: it gets parsed as JSON and then
checked against the shared protocol's validation rules (`safeParse`) before
it's allowed to touch the notebook — anything malformed is silently dropped
instead of crashing the app or displaying garbage. There are four kinds of
messages: a one-time `hello` (protocol/app version plus where the stream
left off last time), ordinary `event` frames (the real state changes),
`stream` frames (word-by-word narration text as it's generated, before it's
finalized), and `dev` frames (developer-only diagnostics). Because the server
replays its whole history of events on every fresh connection, the notebook
rebuilds itself completely from scratch every time the page loads or
reconnects — nothing is ever "remembered" only in the browser.

### `apps/web/src/commands.ts`
The outbound half: helper functions that send the player's requests to the
server as POST requests — starting a turn (a "turn" is one exchange:
player says something, the world responds), interrupting a turn in
progress, ending a scene, opening a new scene, advancing the clock, sending
a chat message, and so on. A crucial rule enforced throughout this file: a
successful POST response never changes anything on screen by itself — it's
only an acknowledgement ("got it, working on it"). The real change only
happens when the corresponding event comes back down through `stream.ts`.
This file also defines a couple of temporary placeholder constants used
until the app supports real multi-player accounts: a fixed world id, a
fixed player id, and a fixed one-character chat roster.

### `apps/web/src/usePacing.ts`
A hook that controls the "typewriter" reading experience for live narration.
The server can generate several sentences of narration faster than a human
reads them, so this hook holds them back and reveals them one at a time —
either when the player clicks to advance, or automatically after a delay
sized to each sentence's length (if "Auto-Advance" is on, a preference saved
in the browser's local storage). It also tracks exactly which sentence the
player has actually seen so far, which is needed if the player interrupts
mid-narration (the server needs to know the true "seen" cut-off point). This
state is deliberately kept in the component layer, not in the shared
notebook, because it's about how the player is reading, not what the world
actually did.

### `apps/web/src/tokens.ts`
One small helper, `readTokenMs`, that reads a CSS timing value (like
`--wl-cover-min-duration`) out of the page's stylesheet and converts it to a
plain number of milliseconds for use in JavaScript timers. This keeps every
animation duration defined in one place (the CSS theme file) instead of
being hard-coded inside components.

### `apps/web/src/plugins.ts`
Loads the list of installed plugins from the server (`/v1/plugins`) once at
startup, injects any plugin theme stylesheets into the page, and dynamically
imports any plugin component code (so a plugin can define its own custom
HTML tags, like a map renderer, without the core app needing to know about
it ahead of time). Each plugin asset URL includes a hash of its contents so
the browser never serves a stale cached copy after a plugin is updated. If
loading plugins fails entirely, the core app still works — plugins are
strictly optional.

## `pages/`

Each file in this folder is one full-screen route.

### `apps/web/src/pages/ScenePage.tsx`
The Scene route — the main visual-novel screen, and the most complex page.
It has three display modes: VN (character portraits + one paced sentence
box), VN-with-log (same, plus a docked transcript panel on the side), and
Reader (flowing prose instead of the VN staging). What the user sees depends
on state: if no scene is currently open (a brand-new world, or the last
scene has ended), the player sees the "Adventure Awaits" splash screen
instead of a stage. If a scene is actively running, the player sees the
stage with characters, a narration box, and an input row to type into. If a
scene just ended while being watched, the player sees a "soft close" — a
subtle divider with follow-up buttons — layered right into the same stage,
rather than the whole screen changing. This file is deliberately careful to
distinguish "I watched this scene end just now" from "I'm arriving at an
already-ended scene" (e.g. after reloading the page) — the first case shows
the soft close, the second shows the splash.

### `apps/web/src/pages/MapPage.tsx`
The full-page Map route. The actual map-drawing logic isn't part of the core
app at all — it's a "pluggable" custom HTML element (`<wl-map>`) supplied by
a plugin; this page just hosts that tag plus some chrome around it (zoom
buttons and a search box that are visually present but disabled/placeholder
for now). If no map plugin is installed, the user sees a plain message
explaining that instead of a broken or blank map.

### `apps/web/src/pages/GamedayPage.tsx`
The Gameday clock route — lets the player fast-forward the world's in-game
time. The user sees a "— GAMEDAY N —" heading, a round dial with sun/moon
glyphs and a bead that moves around it to show the time of day, a digital
clock readout, and three preset buttons (+1 hour, +6 hours, "To morning").
Clicking a preset sends an advance-time request and then shows an animated
"catching up" state until the world has finished replaying every scheduled
event that the time-skip triggered (or a 30-second safety timeout passes).
The buttons grey out while any scene is actively open, since time can't
advance mid-scene.

### `apps/web/src/pages/ChatPage.tsx`
Weltari Chat — a text-message-style route for DMing a character outside of
a scene, like a messaging app. The user sees a list of characters on the
left (currently just one, Elias, as a placeholder roster) and the selected
conversation on the right, with message bubbles, a "typing…" indicator, and
a text input. If the selected character is currently inside an active scene,
they show as "offline — in a scene" and the input explains messages will
wait. There's also a "Meet in a scene" button that lets the player type a
place name and hand the conversation off into a full scene (the app calls
this the "startscene() bridge" — it ends the chat and opens a real scene at
that place, with events for it arriving over the normal stream), and an
"End chat" button that formally closes the conversation.

### `apps/web/src/pages/ConfigPage.tsx`
The Config/settings route. The user sees: connection status (connected /
reconnecting) and version info; an "Updates" section that shows an
"update available" badge when the server has one, an "Apply" button that
downloads and verifies it, and honest error messages if the update is
refused (for example, self-update being turned off, or the download job
failing); and a list of installed plugins with their version and a
content-hash fingerprint, plus any plugins that were refused at load time
with the reason why. Nothing here invents information — every fact shown is
either something the server already pushed over the stream or the plugin
list fetched from the server.

## `components/`

Smaller building blocks used by the pages above.

### `apps/web/src/components/NavRail.tsx`
The sidebar. The user sees a logo, then a stack of six destination buttons
(Scene, Map, Feed, Chats, Wiki, Config) each with its own icon, a blinking
digital clock at the bottom that opens the Gameday route, and a small avatar
circle that shows green/dim depending on connection status. "Feed" and
"Wiki" are visibly present but greyed out with a tooltip explaining they
arrive in a later milestone — the app deliberately never links to a page
that doesn't work yet. On narrow (mobile-width) screens this same component
turns into a bottom bar instead of a left sidebar, purely through CSS.

### `apps/web/src/components/SceneSplash.tsx`
The "Adventure Awaits" landing screen shown when no scene is open. The user
sees a title, three buttons — "History scene" (open the History list),
"Open Map", and "Hang around" (jump into a scene at a random location the
player has already discovered) — and a footer showing the world's name and
the app's version number.

### `apps/web/src/components/HistoryModal.tsx`
A pop-up listing every scene ever played, rebuilt purely by replaying past
events. The user sees a list of rows, each with the scene's title, in-world
time (if known), the characters who were present, and a "Continue" button
that opens a brand new scene reusing the same title and cast. Clicking a row
expands it to show the whole read-only transcript of that past scene.

### `apps/web/src/components/SceneStage.tsx`
The visual heart of VN mode. The user sees a full-bleed background image or
color (the "backdrop") for the current location, which slides/fades to a new
one when the location changes; a small chip naming the current location; and
a row of character portraits ("line-up") that visually "rise" when that
character is speaking. Portraits are currently simple initial-letter cards
(placeholder art) unless a real generated image exists.

### `apps/web/src/components/SceneControls.tsx`
The small button cluster in the top-right of the Scene screen. The user sees
a book icon to switch between VN and Reader mode, a log icon to show/hide
the transcript panel, a "»" icon to toggle Auto-Advance, and an exit button
that requires two taps to confirm ("End scene?" / "Stay") before it actually
ends the scene, so it can't be triggered by accident.

### `apps/web/src/components/NarrationBox.tsx`
The box that shows the currently streaming narration, one sentence at a
time. The user sees a speaker name plate when a character is talking, the
sentences revealed so far (with the most recent one full brightness and
earlier ones slightly dimmed), a "the world stirs" placeholder while
generation is starting, and a "▼" hint when more sentences are buffered but
not yet revealed. Clicking anywhere in the box advances to the next
sentence.

### `apps/web/src/components/Transcript.tsx`
The scrollable, authoritative record of everything that's actually happened
in the scene — as opposed to the temporary streaming text above, this only
ever shows finalized ("committed") lines. The user sees each past turn as a
block of paragraphs, with an "— interrupted —" marker on turns the player
cut short, and it auto-scrolls to the bottom as new lines arrive. This file
also exports a small shared piece, `TurnBlock`, that both this transcript
and the Reader page and the History modal reuse to draw one turn's text
consistently.

### `apps/web/src/components/ReaderPane.tsx`
The prose-style alternative to the VN stage. The user sees committed turns
as flowing paragraphs with the currently streaming turn appended live at the
bottom (same sentence-by-sentence reveal as the narration box). Switching
between VN and Reader mode never loses any progress because both views read
from the exact same underlying data.

### `apps/web/src/components/InputRow.tsx`
The chatbox at the bottom of the Scene screen where the player types their
action or line. The user sees a text field and a button that reads "Play
turn" normally, or "✋ Interrupt" (styled as a warning) while narration is
still streaming — submitting mid-stream first tells the server exactly what
the player had actually read (the "seen" cut-off), then starts the new
turn.

### `apps/web/src/components/SoftClose.tsx`
The subtle "this scene is over" strip that appears at the bottom of the
stage instead of a jarring full-screen "Game Over" style interruption. The
user sees a divider line with the scene's closing text, and — depending on
how the scene ended — some combination of "Stay longer", "Jump to the next
scene", and "Open map" buttons.

### `apps/web/src/components/SceneCover.tsx`
The full-screen masking overlay used during scene opens and map jumps
(described under `App.tsx` above). The user sees a spinning clock-hand
graphic, the destination's name, and three pulsing dots — a continuous
animation meant to signal "working on it" rather than "frozen", for however
many seconds the world takes to generate the new scene's opening.

### `apps/web/src/components/MapModal.tsx`
A pop-up version of the map, usable from inside a scene (via the "Open map"
button) without leaving the Scene route. Like the Map page, the actual map
drawing is a plugin-supplied `<wl-map>` element; this component is just the
modal frame and a close button around it.

### `apps/web/src/components/DevOverlay.tsx`
Only visible when the URL has `?dev=1`. The user sees a deliberately
technical-looking panel listing recent tool calls the AI made, calls that
were rejected by a safety check, memory/performance gauges, and the loaded
plugins with their content-hash fingerprints. It's styled to look distinctly
different from the rest of the app so it's never mistaken for part of the
story.

## `theme.css` and `structure.md`

`apps/web/src/theme.css` (not TypeScript, so not read line-by-line here but
referenced throughout) holds every color, font, and animation-duration value
as a named `--wl-*` custom property. Components never hard-code a color or a
timing value — they reference a token, so the whole app's look (or an
individual world's look, via a plugin override) can be changed by editing
this one file. `apps/web/structure.md` is the in-repo rulebook for this
package: it spells out that the store may only be written by the SSE
reducer, that every incoming frame must be validated before use, that this
package must never import server code, and that new event types must be
handled in the store's reducer.

## How this connects to the rest of the app

- **SSE stream in**: `stream.ts` opens one `EventSource` connection to
  `/v1/events` and receives everything as validated, typed frames —
  `hello` (connection/version info), `event` (durable state changes, replayed
  in full on every fresh connection), `stream` (live, not-yet-final narration
  text), and `dev` (diagnostics). This is the only path by which the app's
  state (`store.ts`) is ever updated.
- **Command POSTs out**: `commands.ts` sends the player's actions to the
  server as HTTP POST requests to endpoints under `/v1/commands/…` (start a
  turn, interrupt a turn, open a scene, end a scene, advance time, send a
  chat message, etc.). A successful response is only an acknowledgement —
  the actual effect always arrives afterward as an event on the stream.
- **Shared shapes from `@weltari/protocol`**: every message going in either
  direction — stream frames, commands, command responses — is checked
  against schemas defined in the separate `@weltari/protocol` package,
  which both the server and this browser app import so they always agree on
  the exact shape of the data. This package deliberately never imports
  anything from the server itself, so the browser code can't accidentally
  depend on server internals.
