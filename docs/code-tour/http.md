# Code tour — http (the server's front door) + main.ts

This is the part of Weltari that talks to the outside world. Everything the browser (or any other client — a command-line tool, a future external game) sees comes through this folder: a live one-way feed of "things that happened" called **SSE**, and a set of POST endpoints for "please do this thing" commands. Nothing in here decides game logic — it just accepts requests, hands them to the engine, and reports back what happened. `main.ts` is the file that starts the whole application and connects all these pieces together at boot time.

**What is SSE?** SSE stands for Server-Sent Events. Think of it as a news ticker: the browser opens one long-lived connection to the server, and the server keeps pushing new items down that same connection whenever something happens — the browser never has to ask "anything new?" repeatedly. It only flows one way (server to browser); if the browser wants to *do* something, it uses a separate, ordinary POST request instead.

**What is Last-Event-ID replay?** Every important item on the ticker gets a number (its position in the log). If the browser's connection drops (wifi hiccup, laptop sleep) and it reconnects, it tells the server "the last item I saw was #421" using a special `Last-Event-ID` marker, and the server immediately resends everything numbered 422 and up before resuming the live feed. Nothing is missed and nothing is repeated.

**What is a composition root?** `main.ts` is the one place in the whole codebase where every part of the app — the database, the logger, the game engine, the web server, background job runners — gets created and wired together. Nowhere else does the app "assemble itself"; every other file just receives the pieces it needs as arguments. This makes it possible to see, in one file, everything the running program actually consists of.

## `apps/server/src/http/bus.ts`

This file is the plumbing that gets a "thing that happened" from wherever it was created to every browser currently listening. It's for fanning one event out to many listeners inside the same running process (nothing here talks to the network directly).

- `Bus<T>` — a small class that keeps a list of listener functions and, when `publish` is called, calls every one of them with the new item; if one listener throws an error (e.g. a browser connection that just died), it's caught and logged so it doesn't take down the other listeners.
- `EventBus` — a `Bus` that carries durable, numbered events (the kind that get replayed via Last-Event-ID).
- `StreamBus` — a `Bus` that carries display-only sentences (e.g. the story text streaming in word by word); these have no number and are simply lost if a client isn't currently connected — by design, since they're not the source of truth.
- `DevBus` — a `Bus` for internal diagnostic frames only visible to clients that opted into "dev mode."

## `apps/server/src/http/sse.ts`

This is the file that actually implements the news-ticker connection described above: `attachSseClient` takes a raw HTTP response and turns it into a live SSE stream for one browser tab.

- `attachSseClient(raw, lastEventId, deps)` — the one exported function. It writes the initial "hello" frame (protocol version, current highest event number, and the app's version if known), then replays every durable event newer than `lastEventId` from the database, then keeps the connection open and forwards any new durable events, story-text sentences, and (if requested) dev-mode frames as they arrive live. It also sends a small heartbeat comment every 15 seconds by default to keep the connection alive through proxies, and cleans up all its subscriptions when the browser disconnects. The replay is done in a way that guarantees no event can be missed or duplicated between "catching up" and "going live."

## `apps/server/src/http/static.ts`

This file serves the built frontend (the actual web app the browser loads) as plain files, straight from the same server process — there's no separate web server needed.

- `createStaticResolver(webDir)` — given the folder where the built frontend lives, returns a function that, given a requested path, finds the matching file. If the exact file doesn't exist, it falls back to `index.html` so the frontend's own in-browser routing can take over (this is standard for single-page apps). If a request tries to escape the folder (e.g. `../../secrets.txt`), it's refused outright — never silently served, never falling back to the app either. Built assets that have a content hash in their filename get cached "forever" by the browser (they'll never change); `index.html` itself is never cached, so a fresh page load always sees the newest version.

## `apps/server/src/http/server.ts`

This is the biggest file in the folder: it builds the actual Fastify (a Node.js web framework) server and registers every route the outside world can hit. Every command it accepts is checked against a strict schema before anything happens — a request that doesn't match the expected shape is rejected with an error, never guessed at.

- `createHttpServer(deps)` — the one exported function; it builds and returns the whole server. It's handed a bag of "seams" (functions) from `main.ts` for actually doing the work — the HTTP layer itself never contains game logic, it only validates the request, calls the matching function, and translates the result into an HTTP response.
- `GET /v1/events` — opens the SSE connection described above (hands off to `attachSseClient`).
- `GET /v1/plugins` — lists any drop-in plugins that were loaded at boot.
- `GET /plugins/:name/*` — serves a plugin's own static files (images, scripts), also traversal-contained.
- `GET /v1/images/*` — serves generated map/scene images, contained to the images folder.
- `GET /*` — the catch-all that serves the frontend (via `static.ts`'s resolver) for anything that isn't an API path; requests that look like a mistyped `/v1/...` or `/plugins/...` call are deliberately given a JSON 404 instead of silently returning the web app's `index.html` — so a broken API call fails loudly rather than looking like a working page.
- `POST /v1/commands/start-turn`, `/interrupt-turn`, `/end-scene`, `/open-scene`, `/advance-time`, `/paint-region`, `/explore`, `/map-edit`, `/map-click`, `/send-chat-message`, `/exit-chat`, `/start-scene-from-chat`, `/apply-update` — one route per player/game action. Each one validates the request body against its schema, calls the matching engine function passed in from `main.ts`, and responds either `202 Accepted` (the action was accepted and is proceeding) with action-specific details, or `409` with a short error code (e.g. `unknown_character`, `updates_disabled`) explaining why it was refused. None of these routes hold any game state themselves — they're a thin, validated doorway to the engine.

## `apps/server/src/http/static.test.ts`

Automated tests for `static.ts`: they build a fake "dist" folder with a real HTML file and a hashed asset file, plus a decoy file sitting just outside the folder, then check that real files are served with the right content type, that a miss falls back to `index.html`, and that an attempt to reach the decoy file outside the folder is refused rather than served.

## `apps/server/src/http/server.test.ts`

Automated tests for `server.ts`: they spin up a real server on a random port and drive it with real HTTP requests, checking things like: the SSE `hello` frame arrives correctly, reconnecting with `Last-Event-ID` replays exactly the missed events with no gaps or repeats, live pushes arrive while connected, a malformed command body is rejected with `400` and nothing is written to the database, and that accepted commands and their resulting stream of events arrive in the correct order.

## `apps/server/src/engine/event-sink.ts`

Although this file lives in the `engine` folder rather than `http`, it's the direct link between the two: it's how anything happening in the game becomes a durable event and only afterwards a live push. This ordering is a deliberate safety rule — a fact is written to the database first, and only then is it broadcast to listeners, never the other way around. If the process crashes in between, the fact is still safely saved, and a reconnecting browser will simply pick it up on replay.

- `createEventSink(storage, eventBus)` — builds the `EventSink` used everywhere else in the engine.
- `.append(event)` — saves one event to the database, then publishes it on the `EventBus` (in that order), and returns the saved, numbered event.
- `.appendMany(events)` — same idea for a batch of events: they're all saved together in a single all-or-nothing database transaction, and only after that succeeds are they published, in the same order they were saved.

## `apps/server/src/main.ts`

The composition root — described above — and the file that actually starts Weltari. Reading it top to bottom tells the story of what happens when the server boots.

1. It reads and validates all the environment configuration; if that's invalid, it logs the problem and exits immediately (nothing can safely run without valid config).
2. It installs the app's only two "something went catastrophically wrong" handlers (`uncaughtException`, `unhandledRejection`) — both just log the error and shut the process down cleanly rather than limping along in an unknown state.
3. It opens the SQLite database (which also runs any pending migrations) and builds the `EventBus`, `StreamBus`, and `DevBus` described above.
4. It starts the self-watch "gauges" (see the observability tour) so the process reports its own health from the very first moment it's running.
5. If the database is completely empty, it seeds a small fixture world (three starter locations) so a fresh install has somewhere for the player to start.
6. It builds the LLM client (a real one if an API key is configured, otherwise a safe, free, deterministic fake), the image-generation backend, and the various engine pieces: the turn engine (runs a scene turn), the scene lifecycle (opening/closing scenes), the chat engine (DMs outside of any scene), the world clock (time skips), and the background job runner (the "ledger" that processes queued work like image generation).
7. It loads any drop-in plugins and wires up outbound connectors (e.g. Telegram) through the gateway host.
8. It builds the actual HTTP server by calling `createHttpServer` from `server.ts`, passing in every one of the functions built in the previous steps as the "seams" the routes will call.
9. It starts a recurring 1-second timer that ticks the background job runner and update scheduler, and a 15-second timer that closes out idle chat conversations.
10. Finally, it starts the HTTP server listening on the configured port and host, and starts any outbound gateway connectors — only after the server is already listening, so a bad connector token can never block the app from serving its main API.
11. It also registers a graceful-shutdown routine for `SIGTERM`/`SIGINT` (stopping timers and closing connections cleanly) — but this is explicitly just a nicety; because everything is written durably before being reported, a hard kill (`kill -9`) at any point is always safe and never corrupts state.

## How this connects to the rest of the app

This module is the seam between the outside world and everything else. Every command route in `server.ts` calls straight into functions built by the engine, ledger, painter, and chat systems in `main.ts` — the HTTP layer itself has no game rules, it only validates and forwards. Every fact the game produces flows through `event-sink.ts`'s durable-then-broadcast pattern into the `EventBus`, which `sse.ts` turns into the live ticker the browser (and any future client) subscribes to via `GET /v1/events`. Because the whole frontend is also served from this same process (`static.ts`), a single Weltari server process is a fully self-contained app: no separate web server, no separate API gateway, one process that owns its own front door.
