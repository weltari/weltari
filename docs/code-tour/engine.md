# Code tour — engine (the world brain)

The engine is the part of Weltari that runs the story. It decides what is allowed to happen in the game world (can this character walk into that room? does this place exist yet?), it builds the exact wall of text ("the prompt" — the instructions and background a language model reads before it writes a reply) that gets sent to the AI, and it turns the AI's answers into permanent history. Nothing in this folder is allowed to check the real-world clock on your computer (no "what time is it right now") — every notion of time, including the story's own fictional calendar, is handed to the engine from outside as a plain value. That rule exists so the exact same input always produces the exact same output, which is what makes the automated tests trustworthy and what lets a crash mid-turn be recovered cleanly instead of leaving the story half-written.

Two ideas come up in almost every file here, so it's worth defining them once:

- **Event / event log**: every fact about the story ("this scene started," "this line was said," "the clock ticked forward") is written once to an append-only log — new rows are added, old ones are never changed or deleted. Anything the engine needs to know "right now" (who's in a scene, what places exist, what a character last said) is worked out by re-reading that log — this is called a **projection**, like replaying a recording to see the current frame.
- **`{ stablePrefix, dynamicTail }`**: when the engine builds a prompt for the AI, it splits it into two pieces. The `stablePrefix` is the part that must come out byte-for-byte identical every single time for the same character (their personality, memory, skills) — because AI providers can cache an identical prefix and charge much less for it, the same way you'd only need to re-read the first page of a briefing once. The `dynamicTail` is everything that changes turn to turn (what just happened, what the player typed) and always goes at the end, after the cached part. The engine is strict that nothing changeable — and nothing that came from a player or from world text like a wiki page — is ever allowed to sneak into the stable part; that's treated as a security boundary; e.g. player text could otherwise try to sneak in fake instructions.

## context-assembler.ts

`apps/server/src/engine/context-assembler.ts` is the one place in the whole codebase that builds prompts. Every other file that talks to the AI goes through it.

- `assembleContext(profile, scene)` — takes a character's fixed profile (skills, personality, memory, goals) and the scene's live details (world clock text, recent lines said, the player's latest message, any wiki excerpts) and produces the `{ stablePrefix, dynamicTail }` pair described above. The stable part is always ordered skills → personality → memory → goals, exactly the same shape every time. Anything that came from outside the engine — a wiki excerpt, the recent conversation, the player's own words — is wrapped in an `<external source="...">` tag in the dynamic tail, and any `<`/`>` characters inside that text are swapped for look-alike characters so a hostile player message can't fake its own closing tag and "escape" into instruction territory.

## scene-turn.ts

`apps/server/src/engine/scene-turn.ts` runs one "turn" of a scene: the scripted sequence of Narrator speaks → character replies → Narrator closes the beat, each as a separate call to the AI, streamed to the player sentence by sentence as it's generated.

- `createTurnEngine(options)` builds the `TurnEngine`, whose two operations are:
  - `startTurn(command)` — first writes a durable "turn started" marker (so if the process dies mid-turn, recovery knows this turn never finished and treats it as if it never happened), then runs the three AI calls one after another. While each call streams, the text is shown live to the player but isn't permanent yet — only when everything finishes does the engine write ONE final "turn committed" event containing the whole turn's text, and if any tool the Narrator called (like moving to a new room) was valid, that change is written in the very same all-or-nothing database transaction. This is why a mid-turn crash can never leave a half-written scene: either the whole turn (text + any world changes) lands together, or none of it does.
  - `interruptTurn(command)` — handles a player cutting the Narrator off mid-sentence. It closes the turn immediately at the last sentence the player actually saw, throws away anything staged (a room move that was about to happen, say), and lets any still-running AI call finish talking into the void, unrecorded.
- Along the way it runs the Narrator's tool calls through two checks (the file calls them "gates"): gate 1 checks the shape of the tool call is sensible (handled in `apps/server/src/llm/tools.ts`, outside this folder), and gate 2 checks it against the actual state of the world — that's `scene-tools.ts`, described next. A rejected tool call never touches the database; it's only recorded on an internal debug trail so developers can see what got refused and why.
- It also supports a "read-only query" the Narrator can run mid-call (e.g. "what places already exist?") without that counting as a world change, and it folds in the handoff notes that arrive when a scene is opened from a chat conversation (see `chat.ts`) — a premise or a requested meeting place that the Narrator is nudged to resolve on its very first turn.

## scene-tools.ts

`apps/server/src/engine/scene-tools.ts` is "gate 2": the check that a tool call the AI wants to make is actually true given the current state of the story (a schema alone can't know whether a character is really in the room). Valid calls are only **staged** — held in memory — never written to the database directly; `scene-turn.ts` is what actually commits them, atomically with the rest of the turn.

- `createToolStage(options, sceneId)` builds a `ToolStage` object with:
  - `apply(call)` — runs one of the four tools (`end_scene`, `change_sublocation` — move to a different place, `switch_art` — change a character's pose/expression, `create_sublocation` — invent a brand-new place on the fly) against the current game state and either stages the effect or rejects it with a specific reason.
  - `staged()` / `endScene()` — read back everything staged so far this turn.
  - `querySublocations(input)` — a read-only lookup the AI can call mid-turn to see what places already exist (by parent-less top level, by children of a place, or by keyword search); this is the only tool that never changes anything.
  - `discard()` — wipes everything staged, used when a player interrupts the turn.
- `currentSublocationId(storage, sceneId, startSublocationId)` — works out where a scene currently is by replaying its "place changed" events.
- `slugifyName(name)` and `sublocationIdForStub(name)` — turn a free-text place name into a predictable, lowercase-and-hyphens id, so retried or duplicate creation attempts can never accidentally spawn two different rows for "the same" place.
- The file enforces some specific story rules: a newly invented interior place must be inside a "flat," non-interior parent place (no nesting interiors inside interiors); and before the AI is allowed to invent a brand-new top-level place with no parent, it must first have queried what already exists this turn (the "query-first" rule) — otherwise the AI gets a fixed refusal message telling it to search first, so it can correct itself.

## scene-lifecycle.ts

`apps/server/src/engine/scene-lifecycle.ts` handles opening and closing scenes.

- `appendSceneEndWithFanOut(storage, knownCharacters, request)` — the core "end a scene" logic: writes the scene-ended event, and in the very same database transaction enqueues one background "reflection" job (see the ledger module) per character who actually spoke, plus one "world agent" job for the world overall — so a crash can never leave a closed scene without its follow-up work scheduled.
- `createSceneLifecycle(options)` returns:
  - `endScene(command)` — the outward-facing version of the above, used when a scene is closed via a plain command (rather than mid-turn by the Narrator's own tool). Publishes the event to live listeners only after the database write has safely landed.
  - `openScene(command)` — opens a new scene. It refuses to start if this world still has pending background work (a running reflection for one of these participants, or a running world-agent job) — that's the rule that keeps a new scene from starting mid-repair of the last one. It also writes one "character joined" event per known participant (unknown ids are quietly skipped with a warning, never silently invented), and — new in a later milestone — it can open the scene directly at a known place, carrying that place's already-painted backdrop image along if one exists.
- It also accepts an optional `premise` and `place_request` on the open-scene request — these are the fields that let a chat conversation hand a player off into a brand-new scene (see `chat.ts`); the plain HTTP "open scene" command never sets them itself.

## sublocations.ts

`apps/server/src/engine/sublocations.ts` is the registry of every "sublocation" (a place within the world — a room, a square of the map, an invented interior) that currently exists, worked out by replaying the event log rather than being stored as its own table.

- `knownSublocations(storage, worldId)` — the single source of truth read by the movement gate, the open-scene gate and the map's fog-of-war gate: starts from a small fixed starter set of places and layers on top every place that's since been revealed on the map, drawn by hand, clicked into existence, or invented by the Narrator.
- `squareOf(position)` / `squareCenter(square)` / `sublocationIdForSquare(square)` — convert between a free-floating map coordinate and the map's fixed 8×8 grid of "fog" squares, and generate a predictable id per grid square so the same square can never be discovered twice under two different ids.
- `SUBLOCATION_RADIUS` and `sublocationNear(storage, worldId, point)` — the "did my click land inside an existing place?" test: a click inside a hand-drawn place's outline wins outright, otherwise the nearest place within half a grid-square's radius.
- `sublocationAt(storage, worldId, square)` — which place (if any) occupies a given fog square; used to stop the same square being explored twice.
- `worldExists(storage, worldId)` — true once anything at all has happened in a world.
- `solveFrontierSquare(storage, worldId, anchor)` — when the AI invents a brand-new place with no parent, this is the plain (non-AI) math that decides where on the map it should appear: the nearest still-empty grid square that touches ground already explored, so the map only ever grows outward from what's already been seen, never in an isolated island.
- `latestBackdropPath(storage, sublocationId)` — the most recent generated background image for a place, if the image-painting system has produced one yet.

## explore.ts

`apps/server/src/engine/explore.ts` is the entry point for the player clicking "explore" on an unrevealed square of fog. It checks the world exists and the square is actually still empty, then enqueues exactly one background job to generate that square's content — clicking the same square twice just quietly reuses the same job instead of starting a second one.

## map-edit.ts

`apps/server/src/engine/map-edit.ts` handles a player hand-drawing a new place directly onto the map. It checks the drawn shape's center sits on ground that's already been explored (you can't draw a new place on top of fog), records the request itself as a durable event (so a client's on-screen "locked" overlay survives a refresh), and enqueues one background job to actually generate the place. Repeated submissions of the same request are silently reused rather than duplicated.

## map-click.ts

`apps/server/src/engine/map-click.ts` handles a player clicking somewhere on the already-explored map that isn't obviously inside a known place. If the click is close enough to an existing place, it resolves instantly with zero AI calls and zero new database rows — you just walk in. Only a click that's genuinely ambiguous (not inside or near anything known) triggers a background job that asks an image-reading AI model to classify what's there.

## chat.ts

`apps/server/src/engine/chat.ts` is the direct-message (DM) system — private one-on-one text conversations with a character outside of any scene, like texting them on a phone.

- `presenceOf(storage, characterId)` — works out whether a character is currently "in a scene" (and therefore not available to chat) purely by replaying "joined a scene"/"scene ended" events.
- `conversationIdFor(actorId, characterId)` — the fixed, predictable id for a given player+character conversation.
- `createChatEngine(options)` returns:
  - `sendMessage(command)` — records the player's message, and if the character is free (not in a scene, not already mid-reply), kicks off a single AI call to generate their reply, which is committed only once fully finished — a crash mid-reply just loses that one reply, nothing else. If a second message arrives while a reply is already generating, it doesn't start a race; it just queues one combined follow-up reply.
  - `exitChat(command)` / `sweepIdle()` — close out a conversation (the player leaving, or the conversation simply going quiet for a configurable amount of idle time), which schedules one background "reflect on this chat" job.
  - `startSceneFromChat(command)` — this is the **startscene() bridge**: the mechanism that lets a chat conversation hand the player back into a live scene. It tries to match the requested place against the sublocation registry (`sublocations.ts`); if it matches an existing place, the scene opens right there, otherwise the free-text request rides along so the Narrator resolves it on the first turn. Opening the scene and closing the chat happen as two separate steps on purpose — if the process dies between them, the conversation is simply left open and the idle-timeout logic (`sweepIdle`) will clean it up later, rather than risking a closed conversation with no scene to show for it.
- Chat never changes the world by itself — its only lasting output is the conversation history and a short private "recap" line the character writes about the exchange (handled by `cache.ts`).

## cache.ts

`apps/server/src/engine/cache.ts` is a small per-character memory aid: after every scene or chat exchange, the character writes itself one short note about what just happened, so the *next* time it's spoken to (in a scene or a chat, whichever comes first) it has some continuity even though full context isn't reloaded.

- `capCacheLine(text)` — cleans up and length-limits a character's self-written note.
- `latestPerOrigin(storage, characterId)` — reads back the character's single latest note from a scene and single latest note from a chat, kept separate on purpose so a private chat note can never accidentally overwrite or hide something that happened in a "real" scene.
- `cacheRecapText(view)` — turns those notes into the short text block that gets inserted into the next prompt's dynamic tail; it's rebuilt fresh every single time rather than reused, so it's always showing the truly latest note.

## fault-points.ts

`apps/server/src/engine/fault-points.ts` defines the fixed list of moments (`FaultPoint`) where an internal testing tool is allowed to intentionally kill the whole process, to prove the system recovers cleanly no matter when a crash happens — for example mid-way through streaming AI text, between two AI calls in the same turn, or right before a database commit. This file doesn't do the killing itself; it just names the checkpoints other files call out to.

## world-clock.ts

`apps/server/src/engine/world-clock.ts` is the story's own fictional in-world clock — separate and unrelated to the real wall-clock time on the server. Per the module-wide rule, the engine is never allowed to ask the real computer what time it is; instead the *current fictional time* is simply whatever the log's latest "time advanced" event says it is.

- `currentTime(worldId)` — replays the log to find the latest recorded fictional time for a world (starting from a fixed story epoch if nothing has happened yet).
- `advanceTime(command)` — the "skip time forward" operation (e.g. a player choosing to skip to the next morning). It works out which scheduled recurring events ("world cron" — things like a lamplighter making their rounds every fictional dawn) fall due in the skipped span, using pure date-math helpers from the ledger module (never the real clock), and enqueues a background job for each one — simple "code" ones instantly, and AI-written ones only up to a budget (default 10) so skipping a whole fictional month doesn't flood the system with hundreds of AI calls at once; only the most recent ones within budget are kept. All of this — the new time and every job it schedules — commits together in one all-or-nothing write.

## event-sink.ts

`apps/server/src/engine/event-sink.ts` implements the small "append, then tell everyone" pattern used throughout the engine: a fact is written to the durable log first, and only once that write has safely landed does the engine notify any live listeners (like a browser tab showing the scene). If the process dies in between those two steps, nothing is lost — a reconnecting client just replays the missed row from the log. `appendMany` does the same thing for a batch of events that must all land together or not at all (used, for example, for a reflection and its cache note, or a chat reply and its cache note). (Full write-up of the surrounding publish/subscribe system lives in the http module's own doc page.)

## sentences.ts

`apps/server/src/engine/sentences.ts` is a small utility that turns a raw stream of AI-generated text fragments into whole sentences for display. As text trickles in piece by piece, `createSentenceSplitter` buffers it and fires a callback each time a full sentence is detected (looking for `.`, `!`, `?`, or `…` followed by a space), then flushes any leftover partial sentence at the end of the call. This is purely about pacing what's shown to the player live on screen — it has no bearing on what eventually gets saved; the full, complete text is what gets written to the permanent record.

## fixture/

### rainy-inn.ts

`apps/server/src/engine/fixture/rainy-inn.ts` is the built-in demo/test world ("The Rainy Inn") used for development and automated testing — a small, entirely deterministic starter setting so the same test always produces exactly the same result.

- `FIXTURE_SUBLOCATIONS` — the three starting places (the Common Room, the Flooded Cellar, the Old Shrine), each with a fixed map position and description.
- `FIXTURE_ART_SETS` — the fixed set of poses/expressions available to the demo character.
- `FIXTURE_WORLD_CRON` — the two example recurring fictional-time events: a lamplighter's rounds every fictional dawn (a plain, non-AI event) and an "evening rumor" every fictional dusk (AI-written).
- `generateLore(sentenceCount)` — produces a requested number of filler background-memory sentences with no randomness at all, so the exact same count always produces the exact same text byte-for-byte.
- `buildEliasProfile(targetPrefixTokens)` / `buildNarratorProfile(targetPrefixTokens)` — build the demo character's and the Narrator's full profiles (skills, personality, memory, goals), sized up to roughly a target "token" count (a token is roughly a word-ish chunk of text — the unit AI providers charge by) so tests can exercise a prompt of a realistic, large size.

## How this connects to the rest of the app

The engine sits in the middle of the system, between four other modules:

- **storage** — the engine never touches the database directly except through the repositories storage exposes; every fact the engine "knows" (what places exist, who's in a scene, what a character last said) comes from replaying the append-only event log storage keeps, and every fact the engine produces is written back through it in all-or-nothing transactions.
- **llm** — the engine builds the `{ stablePrefix, dynamicTail }` prompt and hands it to the llm module's client, which is the only part of the codebase that actually talks to an AI provider; the engine only ever sees the AI's answer back as plain text and tool calls, which it then validates and gates before anything becomes permanent.
- **ledger** — background work the engine schedules (a character's post-scene reflection, the "world agent" catching up after a scene, generating a newly-explored map square, painting a backdrop image, skipping fictional time forward) is handed off as `ledger_job` rows via `storage.ledger.enqueue`, not run directly — the ledger module's own runner picks those jobs up and executes them later, calling back into engine code (like the reflection/materialize handlers) to do the actual work.
- **http** — player actions (send a chat message, click explore, open or interrupt a scene) arrive as commands from the http layer and are handled by the functions this tour describes; the engine, in turn, publishes durable events back out through the same event-bus mechanism so live browser tabs can update in real time.
