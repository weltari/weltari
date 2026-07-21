# Code tour — http (the server's front door) + main.ts

*Updated for the V1 close-out (week 19, 2026-07-21).*

This is the part of Weltari that talks to the outside world. Everything the
browser (or any other client — a command-line tool, a Telegram bot, a future
external game) sees comes through this folder: a live one-way feed of "things
that happened" called **SSE**, and a set of POST endpoints for "please do this
thing" commands. Nothing in here decides game logic — it just accepts
requests, hands them to the engine, and reports back what happened. `main.ts`
is the file that starts the whole application and connects all these pieces
together at boot time.

**What is SSE?** SSE stands for Server-Sent Events. Think of it as a news
ticker: the browser opens one long-lived connection to the server, and the
server keeps pushing new items down that same connection whenever something
happens — the browser never has to ask "anything new?" repeatedly. It only
flows one way (server to browser); if the browser wants to *do* something, it
uses a separate, ordinary POST request instead.

**What is Last-Event-ID replay?** Every important item on the ticker gets a
number (its position in the log). If the browser's connection drops (wifi
hiccup, laptop sleep) and it reconnects, it tells the server "the last item I
saw was #421" using a special `Last-Event-ID` marker, and the server
immediately resends everything numbered 422 and up before resuming the live
feed. Nothing is missed and nothing is repeated.

**What is a composition root?** `main.ts` is the one place in the whole
codebase where every part of the app — the database, the logger, the game
engine, the web server, background job runners — gets created and wired
together. Nowhere else does the app "assemble itself"; every other file just
receives the pieces it needs as arguments. This makes it possible to see, in
one file, everything the running program actually consists of.

## `apps/server/src/http/bus.ts`

This file is the plumbing that gets a "thing that happened" from wherever it
was created to every browser currently listening. It's for fanning one event
out to many listeners inside the same running process (nothing here talks to
the network directly).

- `Bus<T>` — a small class that keeps a list of listener functions and, when
  `publish` is called, calls every one of them with the new item; if one
  listener throws an error (e.g. a browser connection that just died), it's
  caught and logged so it doesn't take down the other listeners.
- `EventBus` — a `Bus` that carries durable, numbered events (the kind that
  get replayed via Last-Event-ID).
- `StreamBus` — a `Bus` that carries display-only sentences (e.g. the story
  text streaming in word by word); these have no number and are simply lost
  if a client isn't currently connected — by design, since they're not the
  source of truth.
- `DevBus` — a `Bus` for internal diagnostic frames only visible to clients
  that opted into "dev mode."

## `apps/server/src/http/sse.ts`

This is the file that actually implements the news-ticker connection
described above: `attachSseClient` takes a raw HTTP response and turns it
into a live SSE stream for one browser tab.

- `attachSseClient(raw, lastEventId, deps)` — the one exported function. It
  writes the initial "hello" frame (protocol version, current highest event
  number, and the app's version if known), then replays every durable event
  newer than `lastEventId` from the database, then keeps the connection open
  and forwards any new durable events, story-text sentences, and (if
  requested) dev-mode frames as they arrive live. It also sends a small
  heartbeat comment every 15 seconds by default to keep the connection alive
  through proxies, and cleans up all its subscriptions when the browser
  disconnects. The replay is done in a way that guarantees no event can be
  missed or duplicated between "catching up" and "going live."

## `apps/server/src/http/static.ts`

This file serves the built frontend (the actual web app the browser loads)
as plain files, straight from the same server process — there's no separate
web server needed.

- `createStaticResolver(webDir)` — given the folder where the built frontend
  lives, returns a function that, given a requested path, finds the matching
  file. If the exact file doesn't exist, it falls back to `index.html` so the
  frontend's own in-browser routing can take over (this is standard for
  single-page apps). If a request tries to escape the folder (e.g.
  `../../secrets.txt`), it's refused outright — never silently served, never
  falling back to the app either. Built assets that have a content hash in
  their filename get cached "forever" by the browser (they'll never change);
  `index.html` itself is never cached, so a fresh page load always sees the
  newest version.

## `apps/server/src/http/server.ts`

This is by far the biggest file in the folder (about 1,200 lines): it builds
the actual Fastify (a Node.js web framework) server and registers every route
the outside world can hit. Every command it accepts is checked against a
strict schema before anything happens — a request that doesn't match the
expected shape is rejected with an error, never guessed at. And every route
follows the same pattern: validate the request, call the matching function
handed in from `main.ts`, and answer either `202 Accepted` ("got it, working
on it", with action-specific details) or `409` with a short refusal code
(e.g. `unknown_character`, `updates_disabled`) saying why it couldn't.

**The read side (GET routes):**

- `GET /v1/events` — opens the SSE connection described above.
- `GET /v1/plugins` — lists any drop-in plugins loaded at boot.
- `GET /plugins/:name/*` — serves a plugin's own static files, traversal-
  contained just like the frontend.
- `GET /v1/images/*` — serves generated map/scene images.
- `GET /v1/profile` and `GET /v1/profile/export` — the player's own
  profiling data (what the app has hypothesized about the player's tastes),
  plus a downloadable export. This is deliberately the ONLY way that data
  travels — it never rides the public event stream.
- `GET /*` — the catch-all that serves the frontend; a mistyped `/v1/...`
  or `/plugins/...` path gets a JSON 404 instead of the web app's
  `index.html`, so a broken API call fails loudly rather than looking like
  a working page.

**The command side (`POST /v1/commands/...`) — one route per player action,
grouped by what they're about:**

- *Scenes and turns*: `start-turn` (the player speaks, the world answers),
  `interrupt-turn` (cut a turn short — the request carries exactly how much
  the player had actually read, so the record ends at the true "seen"
  point), `end-scene`, and `open-scene` (start a new scene, optionally at a
  chosen place; scenes a character invited the player to carry an expiry
  time, and an unanswered invitation eventually lapses).
- *Time*: `advance-time` — the Gameday clock's fast-forward. The wrapper
  built in `main.ts` does extra housekeeping after each skip: it expires
  lapsed invitations and map markers, and queues up the character DMs and
  social-feed posts that the skipped hours should have produced (nothing
  fires while the clock stands still).
- *The map*: `paint-region` (ask the painter for imagery), `explore`
  (reveal a fogged map square), `map-edit` (draw a shape and say what it
  should become), `map-click` (either "enter this known place" or "figure
  out what's here"), and `marker-click` (tap one of the living-world event
  markers — first click wins and opens the scene; a second client joins
  the same scene; an expired marker refuses politely).
- *Chat*: `send-chat-message`, `exit-chat`, and `start-scene-from-chat`
  (the bridge that turns a DM conversation into a real scene), plus the
  group-chat trio `start-group-chat`, `send-group-message`, and
  `exit-group-chat`.
- *Feed and wiki*: `feed-reply` (reply to a comment on the social feed —
  the character's answer generates in the background) and `subwiki-edit`
  (the player's manual edit to a place's wiki entry, applied immediately
  and marked as written by the user).
- *The GM's proposals*: `resolve-proposal` (approve or reject one of the
  Game Master's consent cards — approving applies the change atomically,
  rejecting leaves no trace) and `discuss-proposal` ("let's talk about
  this first" — the card stays open while the GM acknowledges).
- *Settings and privacy*: `set-config-flag` (world-level switches like the
  profiling toggle), `set-character-lock` (freeze a character so they stop
  evolving), `delete-profile` (the GDPR erase button), and `apply-update`
  (download and verify a self-update, when updates are enabled).

## `apps/server/src/http/static.test.ts`

Automated tests for `static.ts`: they build a fake "dist" folder with a real
HTML file and a hashed asset file, plus a decoy file sitting just outside the
folder, then check that real files are served with the right content type,
that a miss falls back to `index.html`, and that an attempt to reach the
decoy file outside the folder is refused rather than served.

## `apps/server/src/http/server.test.ts`

Automated tests for `server.ts`: they spin up a real server on a random port
and drive it with real HTTP requests, checking things like: the SSE `hello`
frame arrives correctly, reconnecting with `Last-Event-ID` replays exactly
the missed events with no gaps or repeats, live pushes arrive while
connected, a malformed command body is rejected with `400` and nothing is
written to the database, and that accepted commands and their resulting
stream of events arrive in the correct order.

## `apps/server/src/engine/event-sink.ts`

Although this file lives in the `engine` folder rather than `http`, it's the
direct link between the two: it's how anything happening in the game becomes
a durable event and only afterwards a live push. This ordering is a
deliberate safety rule — a fact is written to the database first, and only
then is it broadcast to listeners, never the other way around. If the
process crashes in between, the fact is still safely saved, and a
reconnecting browser will simply pick it up on replay.

- `createEventSink(storage, eventBus)` — builds the `EventSink` used
  everywhere else in the engine.
- `.append(event)` — saves one event to the database, then publishes it on
  the `EventBus` (in that order), and returns the saved, numbered event.
- `.appendMany(events)` — same idea for a batch: all saved together in a
  single all-or-nothing database transaction, then published in order.
- `.appendManyWithJobs(events, jobs)` — the same shape one step further:
  events AND queued background jobs land in one transaction, so (say) a
  feed post and the follow-up work it triggers can never come apart.

## `apps/server/src/main.ts`

The composition root — described above — and the file that actually starts
Weltari. Reading it top to bottom tells the story of what happens when the
server boots. A guiding idea throughout: **startup IS recovery** — every
"boot pass" below is the same code path that heals the world after a crash,
so a hard kill at any moment is always safe.

1. It reads and validates all the environment configuration; if that's
   invalid, it logs the problem and exits immediately.
2. It installs the app's only two "something went catastrophically wrong"
   handlers — both just log the error and shut the process down cleanly
   rather than limping along in an unknown state.
3. It opens the SQLite database (which also runs any pending migrations),
   builds the `EventBus`, `StreamBus`, and `DevBus`, and starts the
   self-watch "gauges" (see the observability tour).
4. It builds the character roster: the seed pair (Elias and Mara) plus every
   character that has ever been minted in play — so a character the GM
   created last week is a first-class citizen this boot, DM-able and named
   correctly everywhere. (A truly blank world can skip the seeds entirely
   and be built from scratch through the GM's interview.) If the database is
   empty, it seeds a small fixture world of three starter locations.
5. It builds the LLM client (a real one if an API key is configured,
   otherwise a safe, free, deterministic fake — the same double-opt-in
   caution applies to the image backend, so a fresh install can never spend
   money by accident) and then the engine pieces: the turn engine, the scene
   lifecycle, the chat engine (DMs), the group-chat engine, the marker
   engine (the living-world event pins on the map), the proposal engine and
   the GM's own conversation engine, and the world clock.
6. It loads any drop-in plugins, wires the gateway host and the Telegram
   connector, and connects the chat↔messenger bridge so a Telegram message
   lands in the very same conversation the in-app Chat page shows.
7. It sets up self-update machinery (disabled entirely unless a signing key
   exists — updates are always signature-verified).
8. It builds the background-job runner (the "ledger") with one handler per
   job type: painting images, character reflections, chat replies, feed
   posts, profile analysis, and more.
9. It runs the boot sweeps: expire any lapsed invitations, sweep and top up
   the map markers, finish any GM follow-up message a crash interrupted,
   and catch up on any overdue memory maintenance.
10. It builds the actual HTTP server by calling `createHttpServer`, passing
    in every function built above as the "seams" the routes call — including
    the advance-time wrapper that runs the post-skip housekeeping described
    under `server.ts`.
11. It starts a recurring 1-second timer that ticks the job runner and a
    15-second timer that closes out idle chat conversations, plus a
    scheduled periodic check for new releases.
12. Finally, it starts listening on the configured port, and only *then*
    starts any outbound gateway connectors — so a bad Telegram token can
    never block the app from serving its main API. A graceful-shutdown
    routine for `SIGTERM`/`SIGINT` is registered too, but it's explicitly
    just a nicety: because everything is written durably before being
    reported, a hard kill (`kill -9`) never corrupts state.

## How this connects to the rest of the app

This module is the seam between the outside world and everything else. Every
command route in `server.ts` calls straight into functions built by the
engine, ledger, painter, chat, and GM systems in `main.ts` — the HTTP layer
itself has no game rules, it only validates and forwards. Every fact the
game produces flows through `event-sink.ts`'s durable-then-broadcast pattern
into the `EventBus`, which `sse.ts` turns into the live ticker the browser
(and any other client) subscribes to via `GET /v1/events`. Because the whole
frontend is also served from this same process (`static.ts`), a single
Weltari server process is a fully self-contained app: no separate web
server, no separate API gateway, one process that owns its own front door.
