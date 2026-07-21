# Code tour — web (the browser app)

*Updated for the V1 close-out (week 19, 2026-07-21).*

`apps/web` is the browser app the player actually looks at: a React 19 +
Vite 8 website that draws the visual-novel-style scenes, the world map, the
social Feed, DM and group chats (including the standing Game Master
conversation), the world Wiki, a "Gameday" clock, and a config screen. It is
a **render-only client**: everything you see is a picture of what the server
has already decided. The browser never invents game outcomes, never rolls
dice, never decides what a character says — it just listens to a live stream
of events pushed from the server and paints them on screen, and when the
player does something (types a line, clicks "open scene", advances the
clock) the browser sends that request to the server and then waits for the
server's answer to come back down the same stream before changing anything
on screen. Pages are organized around a handful of "routes" (think: separate
screens you can navigate between — Scene, Map, Feed, Chats, Wiki, Gameday,
Config), all of which read from one shared pool of app state that only one
piece of code is allowed to update.

Throughout this tour: a **component** is a self-contained piece of UI (like
a button bar or a text box) written as a function that returns what should
appear on screen. A **hook** is a reusable bit of logic a component can plug
into (React's naming convention: hook names start with `use`). A **route**
is one of the app's named screens/URLs. **Theming/tokens** means colors,
fonts and animation timings are all stored as named CSS variables (`--wl-*`)
instead of being hard-coded in components, so the whole look can be swapped
by editing one file.

## Entry point

### `apps/web/index.html`
The bare skeleton HTML page: an empty `<div id="root">` that React will
fill, and a `<script>` tag that loads the app's real starting file.

### `apps/web/src/main.tsx`
The actual startup code. It finds that empty `<div id="root">`, loads the
theme's CSS file, and tells React to draw the `App` component into it,
wrapped in React's "StrictMode" (a development-time safety net that catches
some common mistakes).

### `apps/web/vite.config.mjs`
Configuration for Vite, the tool that runs the app during development and
builds it for production. Its only real job here: while developing, forward
any request to `/v1` or `/plugins` to the real server running on port 7777,
so the browser app and the server can be developed side by side. In
production there's no Vite at all — the server itself serves the built app.

### `apps/web/src/App.tsx`
The app's shell — the outermost component that ties everything together. It
decides which route/page is currently showing, opens the one live connection
to the server's event stream, and owns the cross-cutting features:
- **The masking "cover" animation** (`openSceneCovered`): whenever the
  player opens a new scene or jumps somewhere on the map, generating that
  content takes the server several seconds. Instead of a frozen or blank
  screen, `App` shows a continuously animated overlay (a spinning clock
  face and pulsing dots) until the first sentence of the new scene actually
  arrives, then fades it out. A 30-second safety timer means the cover can
  never get stuck forever.
- **Listening for map jumps**: when a map plugin wants to send the player
  somewhere, it fires a browser event called `wl-map-jump`; `App` validates
  that event's contents against the shared protocol rules, closes the map,
  navigates to the Scene screen, and starts the masked-cover transition.
  There's a second flavor (`enterSceneCovered`) for map *marker* clicks:
  there the server has already opened the scene (first click wins), so the
  app skips the "please open a scene" step and just enters the one that
  exists.

It also renders the Left Nav Rail (the sidebar), the current page depending
on the route, the map's popup modal, and — only when the URL has `?dev=1` —
a developer diagnostics overlay.

### `apps/web/src/router.ts`
A tiny hand-written router (the project deliberately avoids adding a router
library). It reads the browser's current URL path and turns it into one of
the known routes (`/`, `/map`, `/feed`, `/chats`, `/wiki`, `/gameday`,
`/config`); anything else falls back to the Scene route. `navigate()`
changes the URL without a full page reload, and `useRoute()` is the hook
components use to find out which route is active. Crucially, the route is
just "which screen is showing" — it never stores any game data, so
switching screens can never lose or corrupt anything.

## The store + the SSE reducer (the single source of truth)

Two files work together as the heart of the render-only design. Picture a
single inbox where every message the server ever sends about the world
lands, and a single clerk whose only job is to read that inbox and update
one big notebook (the app's state) accordingly. Every component in the app
just reads pages out of that notebook — nothing else is allowed to write in
it.

### `apps/web/src/store.ts`
The notebook itself — a "zustand store" (zustand is a small state-management
library; think of it as a shared box of data that any component can read
from, and that re-draws components automatically when it changes). It holds
things like: is the app connected, which scene is open and who's on stage,
the map locations discovered so far, every scene ever played (for the
History screen), the world's in-game clock, DM and group-chat threads, the
social feed's posts and notifications, each place's wiki entry, the GM's
proposal cards, the profiling on/off flag, and per-character evolution
locks. The notebook also defines the rules for how each kind of incoming
server event updates it — a few examples of the newer ones:
- `character.left` removes that character's portrait from the current
  scene's line-up (a character can now genuinely walk out of a scene),
  while the History record keeps them listed — they were there.
- `scene.goals_updated` is deliberately a no-op on screen: the storyteller's
  private planning notes are never shown to the player.
- `scene.ended` remembers the end style — including the newer
  "context limit reached" ending, which the UI shows like a natural rest —
  and any registered follow-up scene ("next time, at the harbor…").
- `proposal.resolved` settles a GM consent card *in place* rather than
  deleting it, so the conversation history reads honestly forever.
Events are deduplicated by id, so replaying the same history twice (which
happens on every reconnect) never double-counts anything. The file is
explicit that these update functions may ONLY ever be called from
`stream.ts` — no component is allowed to call them directly.

### `apps/web/src/stream.ts`
The clerk. It opens one persistent connection to the server (`EventSource`,
a browser feature for one-way live server-to-browser streaming that
automatically reconnects itself if the connection drops). Every message that
arrives is treated as untrusted input: it gets parsed as JSON and then
checked against the shared protocol's validation rules (`safeParse`) before
it's allowed to touch the notebook — anything malformed is silently dropped
instead of crashing the app or displaying garbage. There are four kinds of
messages: a one-time `hello` (protocol/app version plus where the stream
left off last time), ordinary `event` frames (the real state changes),
`stream` frames (word-by-word narration text as it's generated, before it's
finalized — GM chat replies stream this way too, into their own buffer),
and `dev` frames (developer-only diagnostics). Because the server replays
its whole history of events on every fresh connection, the notebook rebuilds
itself completely from scratch every time the page loads or reconnects —
nothing is ever "remembered" only in the browser.

### `apps/web/src/commands.ts`
The outbound half: helper functions that send the player's requests to the
server as POST requests — starting a turn, interrupting one, ending or
opening a scene, advancing the clock, chat and group-chat messages,
feed replies, wiki edits, resolving or discussing a GM proposal, toggling
config flags and character locks, and so on. A crucial rule enforced
throughout: a successful POST response never changes anything on screen by
itself — it's only an acknowledgement ("got it, working on it"). The real
change only happens when the corresponding event comes back down through
`stream.ts`. One clever bit lives in `postOpenScene`: opening a new scene
first formally ends any scene still open (an abandoned scene would trap its
characters "busy" forever) and patiently retries while the old scene's
cleanup finishes — the cover animation masks that wait. The file also still
defines placeholder identity constants (a fixed world and player id) until
real multi-player accounts exist.

### `apps/web/src/usePacing.ts`
A hook that controls the "typewriter" reading experience for live narration.
The server can generate several sentences faster than a human reads them,
so this hook holds them back and reveals them one at a time — either when
the player clicks to advance, or automatically after a delay sized to each
sentence's length (if "Auto-Advance" is on, a preference saved in the
browser's local storage). It also tracks exactly which sentence the player
has actually seen, which matters if the player interrupts mid-narration
(the server needs the true "seen" cut-off point). This state deliberately
lives in the view layer, not the shared notebook, because it's about how
the player is reading, not what the world actually did.

### `apps/web/src/seen.ts`
A tiny "read receipts for yourself" helper: it remembers, in the browser's
local storage, the last event number you'd seen for the Feed, the Wiki, and
the Feed's notification bell. The Nav Rail's little activity dots compare
these marks against the store — so a dot you've already acknowledged never
reappears after a reload. Kept out of the shared store on purpose: it's
about this browser's viewing habits, not the world.

### `apps/web/src/i18n.ts`
The app's message catalog: every user-facing string lives here under a
typed key, and components call `t('some.key')` instead of hard-coding
English text. Today there's a single English catalog, but the structure
means a future language pack is just another list of translations merged
over it — no library, no rework.

### `apps/web/src/tokens.ts`
One small helper, `readTokenMs`, that reads a CSS timing value (like
`--wl-cover-min-duration`) out of the page's stylesheet and converts it to
a plain number of milliseconds for use in JavaScript timers. This keeps
every animation duration defined in one place (the CSS theme file) instead
of being hard-coded inside components.

### `apps/web/src/plugins.ts`
Loads the list of installed plugins from the server (`/v1/plugins`) once at
startup, injects any plugin theme stylesheets into the page, and dynamically
imports any plugin component code (so a plugin can define its own custom
HTML tags, like the map renderer, without the core app knowing about it
ahead of time). Each plugin asset URL includes a hash of its contents so the
browser never serves a stale cached copy after a plugin update. If loading
plugins fails entirely, the core app still works — plugins are strictly
optional.

## `pages/`

Each file in this folder is one full-screen route.

### `apps/web/src/pages/ScenePage.tsx`
The Scene route — the main visual-novel screen, and the most complex page.
It has three display modes: VN (character portraits + one paced sentence
box), VN-with-log (same, plus a docked transcript panel), and Reader
(flowing prose instead of the VN staging). What the user sees depends on
state: on a brand-new, never-seeded world it shows the **onboarding
splash** (meet the GM); on a normal world with no scene open it shows the
"Adventure Awaits" splash; with a scene running, the stage, narration box,
and input row; and when a scene ends while being watched, a "soft close" —
a subtle divider with follow-up buttons — layered right into the same
stage. The file is careful to distinguish "I watched this scene end just
now" (soft close) from "I'm arriving at an already-ended scene" after a
reload (splash).

### `apps/web/src/pages/MapPage.tsx`
The full-page Map route. The actual map-drawing logic isn't part of the
core app at all — it's a "pluggable" custom HTML element (`<wl-map>`)
supplied by a plugin; this page just hosts that tag plus some chrome around
it. The plugin's map is where exploring fog squares, drawing map edits,
clicking unknown ground, and tapping the living-world event markers all
happen — each of those raises a command the server answers, and a marker
tap or pin jump bubbles up to `App` to run the masked transition into the
resulting scene. If no map plugin is installed, the user sees a plain
message explaining that instead of a broken or blank map.

### `apps/web/src/pages/FeedPage.tsx`
The social Feed route — the characters' own posts about their lives,
newest first, each with an author, an in-world day stamp, likes, and
comments. The one interaction, by design, is replying to a comment: click
a comment, type a reply, and the comment's author writes back a little
later (the answer is generated in the background and arrives over the
stream as a threaded response). A bell in the corner collects those
answers to *your* replies; opening it marks them read. After a big time
skip a "catching up…" chip shows while the skipped days' posts finish
generating. Just visiting the page clears the Nav Rail's red dot.

### `apps/web/src/pages/WikiPage.tsx`
The Wiki route — the world's encyclopedia of places, written mostly by the
world itself: after scenes end, a background "world agent" pass updates
the entry for the place involved, with a provenance line like "written
after <scene title>". The page is a list of places on the left and the
selected entry on the right, updating live as new entries arrive. A pencil
button turns the entry into an editable text box — the player's changes
save automatically as they type and the provenance honestly flips to
"edited by you". Visiting the page clears the Nav Rail's blue dot.

### `apps/web/src/pages/GamedayPage.tsx`
The Gameday clock route — lets the player fast-forward the world's in-game
time. The user sees a "— GAMEDAY N —" heading, a round dial with sun/moon
glyphs and a bead that moves around it, a digital clock readout, and three
preset buttons (+1 hour, +6 hours, "To morning"). Clicking a preset sends
an advance-time request and then shows an animated "catching up" state
until the world has finished playing out everything the skip triggered —
expiring invitations, character DMs, feed posts, fresh map markers — or a
30-second safety timeout passes. The buttons grey out while a scene is
open, since time can't advance mid-scene.

### `apps/web/src/pages/ChatPage.tsx`
Weltari Chat — a text-message-style route, like a messaging app. The left
column lists the DM-able characters with presence dots (a character
currently inside a scene shows as "offline — in a scene" and messages
wait), plus a Groups section where "+ New group" starts a group chat with
the whole roster — group replies come back as speaker-labeled bubbles,
routed by a narrator up to a per-exchange budget. Pinned at the very top
sits the **Game Master** — a standing conversation with no "end chat" and
no offline state. The GM's replies stream in live (a caret-animated bubble
that the final message replaces), and when the GM proposes changing the
world — a new place, a new character, a wiki rewrite, even seeding a whole
blank world — the proposal appears *inline in the conversation* as a
consent card (see `ProposalCard` below), exactly where it happened, forever.
Every ordinary character's conversation header also carries the evolution
lock toggle ("stop this character from changing"). Characters can invite
the player to meet somewhere — negotiated in chat, with the character
itself opening the scene; a dev-mode button keeps the old manual "meet in a
scene" shortcut for testing.

### `apps/web/src/pages/ConfigPage.tsx`
The Config/settings route. The user sees: connection status and version
info; an "Updates" section with an "update available" badge, an Apply
button that downloads and verifies the update, and honest error messages
when it's refused; an "Engine & System" section with the profiling toggle
and the GDPR trio — View (fetched on demand, since profiling data never
rides the public stream), Export (a download link), and Delete (two-tap
confirm); and the list of installed plugins with version and content-hash
fingerprints, plus any plugin refused at load time and why. Nothing here
invents information — every fact shown was pushed by the server or fetched
from it.

## `components/`

Smaller building blocks used by the pages above.

### `apps/web/src/components/NavRail.tsx`
The sidebar. The user sees a logo, then destination buttons — **Play**
(the game itself, deliberately not called "Scene"), Map, Feed, Chats,
Wiki, Config — each with its own icon, a blinking digital clock at the
bottom that opens the Gameday route, and a small avatar circle showing
connection status. Every destination is now live: Feed carries a red
activity dot for new posts and interactions, Wiki a blue dot for unseen
world-agent writes — just dots, never numbers, and once acknowledged they
stay gone (see `seen.ts`). On narrow (mobile-width) screens this same
component turns into a bottom bar, purely through CSS.

### `apps/web/src/components/OnboardingSplash.tsx`
The cold-boot welcome screen for a truly blank world: the GM's greeting and
a single "begin" button that hands the player straight into the GM
conversation, where the world-building interview happens. Today it's a
deliberate skeleton — named placeholder slots wait for the designed
version (GM character art beside live chat bubbles) that's specced for a
later session; until then it simply makes an empty world usable.

### `apps/web/src/components/SceneSplash.tsx`
The "Adventure Awaits" landing screen shown when no scene is open. The
user sees a title, three buttons — "History scene" (open the History
list), "Go Somewhere…" (the map — worded as a tool the player uses, not
an entrance), and "Hang around" (jump into a scene at a random place the
player has already discovered) — and a footer showing the world's name
and the app's version number.

### `apps/web/src/components/HistoryModal.tsx`
A pop-up listing every scene ever played, rebuilt purely by replaying past
events. The user sees a list of rows, each with the scene's title,
in-world time (if known), the characters who were present, and a
"Continue" button that opens a brand new scene reusing the same title and
cast (past scenes themselves are final — never reopened, only continued).
Clicking a row expands it to show that scene's full read-only transcript.

### `apps/web/src/components/SceneStage.tsx`
The visual heart of VN mode. The user sees a full-bleed background image
or color (the "backdrop") for the current location, which slides/fades to
a new one when the location changes; a small chip naming the current
location; and a row of character portraits ("line-up") that visually
"rise" when that character is speaking. The line-up is fully dynamic now:
characters can join mid-scene and — since the agentic-scene work — walk
out mid-scene, their card dropping from the row when they go. Portraits
are initial-letter cards (placeholder art) unless a generated image
exists.

### `apps/web/src/components/SceneControls.tsx`
The small button cluster in the top-right of the Scene screen. The user
sees a book icon to switch between VN and Reader mode, a log icon to
show/hide the transcript panel, a "»" icon to toggle Auto-Advance, and an
exit button that requires two taps to confirm ("End scene?" / "Stay")
before it actually ends the scene, so it can't be triggered by accident.

### `apps/web/src/components/NarrationBox.tsx`
The box that shows the currently streaming narration, one sentence at a
time. The user sees a speaker name plate when a character is talking, the
sentences revealed so far (the most recent at full brightness, earlier
ones slightly dimmed), a "the world stirs" placeholder while generation is
starting, and a "▼" hint when more sentences are buffered but not yet
revealed. Clicking anywhere in the box advances to the next sentence.

### `apps/web/src/components/Transcript.tsx`
The scrollable, authoritative record of everything that's actually
happened in the scene — unlike the temporary streaming text above, this
only ever shows finalized ("committed") lines. The user sees each past
turn as a block of paragraphs, with an "— interrupted —" marker on turns
the player cut short, auto-scrolling as new lines arrive. This file also
exports a small shared piece, `TurnBlock`, that the transcript, the Reader
page, and the History modal all reuse to draw one turn consistently.

### `apps/web/src/components/ReaderPane.tsx`
The prose-style alternative to the VN stage. The user sees committed turns
as flowing paragraphs with the currently streaming turn appended live at
the bottom (same sentence-by-sentence reveal as the narration box).
Switching between VN and Reader mode never loses any progress because both
views read from the exact same underlying data.

### `apps/web/src/components/InputRow.tsx`
The chatbox at the bottom of the Scene screen where the player types their
action or line. The user sees a text field and a button that reads "Play
turn" normally, or "✋ Interrupt" (styled as a warning) while narration is
still streaming — submitting mid-stream first tells the server exactly
what the player had actually read (the "seen" cut-off), then starts the
new turn.

### `apps/web/src/components/SoftClose.tsx`
The subtle "this scene is over" strip at the bottom of the stage. The user
sees a divider line with the scene's closing text and, depending on how
the scene ended, some combination of "Stay longer", "Jump to the next
scene", and "Open map" buttons. When the scene registered a follow-up
("next time, at the harbor"), "Jump to the next scene" opens the new scene
at exactly that place — even a place first mentioned mid-scene. A scene
that ended because the conversation grew too long for the AI's memory
window ("context limit reached") is presented like a natural rest, never
an error.

### `apps/web/src/components/SceneCover.tsx`
The full-screen masking overlay used during scene opens and map jumps
(described under `App.tsx` above). The user sees a spinning clock-hand
graphic, the destination's name, and three pulsing dots — a continuous
animation meant to signal "working on it" rather than "frozen", for
however many seconds the world takes to generate the new scene's opening.

### `apps/web/src/components/ProposalCard.tsx`
The GM's consent card, rendered inline in the GM conversation — the same
idea as a coding assistant asking permission before changing a file. The
user sees what the GM wants to do (a new place, a new character or object,
a before/after wiki diff, or the whole seed of a blank world), the GM's
reasoning, and three choices: **Consent**, **Reject**, or **"Chat about
this"** (the card stays open while you talk it over, marked "Talking it
over"). Once resolved, the card doesn't vanish — it dims in place with a
verdict chip where the buttons were, staying at its exact spot in the
conversation history, and a reload rebuilds that interleaving identically.

### `apps/web/src/components/MapModal.tsx`
A pop-up version of the map, usable from inside a scene (via the "Open
map" button) without leaving the Scene route. Like the Map page, the
actual map drawing is the plugin-supplied `<wl-map>` element; this
component is just the modal frame and a close button around it.

### `apps/web/src/components/DevOverlay.tsx`
Only visible when the URL has `?dev=1`. The user sees a deliberately
technical-looking panel listing recent tool calls the AI made, calls that
were rejected by a safety check, memory/performance gauges, and the loaded
plugins with their content-hash fingerprints. It's styled to look
distinctly different from the rest of the app so it's never mistaken for
part of the story.

## `theme.css` and `structure.md`

`apps/web/src/theme.css` (not TypeScript, so not read line-by-line here but
referenced throughout) holds every color, font, and animation-duration
value as a named `--wl-*` custom property. Components never hard-code a
color or a timing value — they reference a token, so the whole app's look
(or an individual world's look, via a plugin override) can be changed by
editing this one file. `apps/web/structure.md` is the in-repo rulebook for
this package: it spells out that the store may only be written by the SSE
reducer, that every incoming frame must be validated before use, that this
package must never import server code, and that new event types must be
handled in the store's reducer.

## How this connects to the rest of the app

- **SSE stream in**: `stream.ts` opens one `EventSource` connection to
  `/v1/events` and receives everything as validated, typed frames —
  `hello` (connection/version info), `event` (durable state changes,
  replayed in full on every fresh connection), `stream` (live,
  not-yet-final narration and GM-reply text), and `dev` (diagnostics).
  This is the only path by which the app's state (`store.ts`) is ever
  updated.
- **Command POSTs out**: `commands.ts` sends the player's actions to the
  server as HTTP POST requests to endpoints under `/v1/commands/…` (turns,
  scenes, time, chat and groups, feed replies, wiki edits, proposals,
  settings). A successful response is only an acknowledgement — the actual
  effect always arrives afterward as an event on the stream. The one
  exception to "everything rides the stream" is the profiling data on the
  Config page, which is deliberately fetched on demand from
  `/v1/profile` so it never travels the public event feed.
- **Shared shapes from `@weltari/protocol`**: every message going in
  either direction — stream frames, commands, command responses — is
  checked against schemas defined in the separate `@weltari/protocol`
  package, which both the server and this browser app import so they
  always agree on the exact shape of the data. This package deliberately
  never imports anything from the server itself, so the browser code can't
  accidentally depend on server internals.
