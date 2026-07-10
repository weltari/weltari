# Code tour — packages/ (protocol & plugin-sdk)

Weltari's main program (the "server") is licensed AGPL-3.0 — a "copyleft" license that says: if someone builds on this code and ships it, they must share their changes back. That's a strong protection for the project, but it's poison for two things that need to be shared as freely as possible: the "rulebook" that describes what messages look like on the wire, and the toolkit that plugin/connector authors build against. So those two pieces live in `packages/protocol` and `packages/plugin-sdk` — separate npm packages, licensed MIT (a much more permissive license: "take it, use it, no strings"), and they are contractually forbidden from importing any code from the main `apps/*` folders. Think of them as the two doorframes of the house: anyone is free to copy the doorframe design, but that doesn't hand them the house. `protocol` is the shared language between the engine and every screen that talks to it (the built-in web app, a future command-line client, future external games). `plugin-sdk` is the rulebook for anyone writing an add-on — a messaging bridge (like a Telegram connector) or a visual/theme plugin.

## `packages/protocol/src/index.ts`

This is the package's front door — the one file other code actually imports from. It does two things: it declares `PROTOCOL_VERSION`, a version number stamped on every connection handshake so a client can refuse to talk to an engine that's too different (a bit like a phone charger checking the voltage before it draws power), and it re-exports everything defined in the other files below so consumers only need one import line. The version-history comment at the top is effectively a changelog of every wire-format feature ever added — useful background reading, but not something you need to memorize.

## `packages/protocol/src/events.ts`

This file lists every kind of permanent record the engine is allowed to write to its history log — the "events" that make up the story's official record. Think of the event log as a bank statement: once a line is printed, it is never edited or deleted, only added to. Each event is defined with a **schema** — a schema is like a customs form: it precisely states which fields a message must have, what type each one is, and (because these use `strictObject`) that no extra, unexpected fields are allowed to sneak through. Validating something against a schema means checking the incoming data against that form and rejecting anything that doesn't match.

Every event shares a common "envelope": an id (its position in the log), which world it belongs to, who caused it (`actor_id` — nothing happens anonymously), and a timestamp.

The exported schemas, each describing one kind of thing that can happen:
- `TurnStepSchema` — one line of dialogue/narration inside a turn (who spoke — narrator, character, or narration — and what they said).
- `SceneStartedEventSchema` — a new scene opened; can carry an optional opening premise line or an unresolved "place request" text when a chat conversation hands off into a scene.
- `CharacterJoinedEventSchema` — records that a specific character is part of a scene's cast, so the visual novel screen knows who to draw without a hardcoded list.
- `TurnStartedEventSchema` — marks that a turn (one round of story generation) has begun, before any AI text exists yet — this lets the system recover cleanly if the app crashes mid-turn.
- `TurnCommittedEventSchema` — the only permanent record of what the AI actually said; text streamed live to the screen doesn't count as "real" until it lands here, and it notes if the player interrupted mid-generation.
- `SceneEndedEventSchema` — a scene closed, records who was in it, how it ended (rest/continuation/travel — this decides which buttons the player sees next), and optionally where a follow-up scene should open.
- `ReflectionCommittedEventSchema` — a character's private "what I remember from that scene" summary became permanent.
- `WorldAgentCommittedEventSchema` — the background "world agent" (a behind-the-scenes AI that tends the world state) finished its end-of-scene housekeeping pass.
- `ChatMessageCommittedEventSchema` — one direct-message line in Weltari Chat (the DM feature), from either the player or a character; carries a de-duplication id so a retried send can never create a double message.
- `ChatEndedEventSchema` — a DM conversation closed (player left, went idle, or jumped into a scene), marking exactly which messages need to be "reflected on."
- `ReflectChatCommittedEventSchema` — the chat equivalent of a reflection: the character's takeaway from a DM conversation.
- `CacheAppendedEventSchema` — a short 1-2 line "what just happened to me" note a character writes after any interaction (scene or chat), used to keep their memory fresh.
- `SubwikiUpdatedEventSchema` — an entry written into a place's "wiki page" — but only for places the story itself invented and that were actually visited, never places just mentioned in passing.
- `WorldTimeAdvancedEventSchema` — the story's in-world clock jumped forward (a time skip), noting how many background events were triggered by the jump.
- `WorldCronCompletedEventSchema` — one scheduled background occurrence (like a recurring event in the world) finished running.
- `MapPositionSchema` / `MapSquareSchema` / `MAP_FOG_GRID` — the shared coordinate system for the world map: `MapPositionSchema` is an x/y position anywhere on the map (as a fraction from 0 to 1, so it never moves if the map image is redrawn at a different size); `MapSquareSchema` addresses one square in the map's "fog of war" grid; `MAP_FOG_GRID` (=8) is the fixed size of that grid, shared between the engine and the map plugin.
- `SublocationMaterializedEventSchema` — a fog-of-war square was revealed and got a real place (name + description) generated for it.
- `MapEditRequestedEventSchema` — the player drew a shape on the map and typed what they want there; this is recorded immediately, before any AI work happens, so the drawn region visibly "locks" right away.
- `SublocationCreatedEventSchema` — a place the player hand-drew on the map was approved and actually added to the world, with a pin at its center.
- `SublocationStubCreatedEventSchema` — the storytelling AI invented a brand-new place mid-scene (e.g., a character says "let's go to the tavern" and the tavern didn't exist yet); this is the identity record created instantly, separate from giving it a spot on the map later.
- `MapClickResolvedEventSchema` — the result of the player clicking somewhere on the already-explored map: either a real permanent place got created there, or a one-time "you notice something" discovery is shown and then forgotten.
- `SublocationChangedEventSchema` — the current scene's setting changed to a different named place, with its backdrop image (if one exists) and its map position.
- `ArtSwitchedEventSchema` — a character's on-screen pose/art changed (e.g., switching from "neutral" to "smile").
- `ImageRegionSchema` — a plain rectangle (x, y, width, height in pixels), reused wherever an image crop or region needs describing.
- `PainterCompletedEventSchema` — a generated/composited image finished and was safely saved to disk, together with a hash to prove which file is the current, trusted one.
- `PluginRejectedEventSchema` — a plugin failed a safety check at load time and the app started without it, along with the reason (corrupt file, wrong version, tampered content, etc.).
- `UpdateAvailableEventSchema` — a newer version of Weltari exists; this is just a notice, nothing is downloaded yet.
- `UpdateStagedEventSchema` — a new version was downloaded, verified as genuine, and is ready — the app will run it after the next restart.
- `JobErrorSchema` — a short, safe-to-display description of why a background task failed (never leaks raw AI prompt content).
- `JobFailedEventSchema` — a background task's attempt failed and it will retry later.
- `JobParkedEventSchema` — a background task failed enough times that it's given up and needs a human to look at it.
- `WeltariEventSchema` — the master list that ties all the above together into one "this is a valid event" check; anything not on this list is rejected.

## `packages/protocol/src/stream.ts`

Describes the "live, temporary" messages sent over the connection while the player is watching text appear on screen in real time — these use a technology called **SSE** (Server-Sent Events), which is just a way for the server to keep pushing small updates to the browser without the browser having to keep asking "anything new?" Unlike the events in `events.ts`, nothing here is saved permanently — if the connection drops, these are simply lost (the permanent `turn.committed` record is what matters afterward).
- `StreamHelloSchema` — the very first message sent when a client connects: it announces the protocol version (so an old/new mismatch can be caught immediately) and how far along the permanent history the client already knows.
- `StreamSentenceSchema` — one sentence of AI text as it's being "typed out" live to the screen, before it becomes permanent.

## `packages/protocol/src/dev.ts`

Defines a separate, optional stream of behind-the-scenes diagnostic messages, only sent to developers/the owner who explicitly ask for "dev mode." Like `stream.ts`, none of this is saved permanently.
- `DevGaugesSchema` — a periodic health check-in: how fast the server is responding and how much memory it's using, with a flag if either crosses a concerning threshold.
- `DevToolCallSchema` — a record that the storytelling AI successfully used one of its tools (like "change the location" or "create a place") and it passed all safety checks.
- `DevToolRejectedSchema` — a record that the AI tried to use a tool but got refused, and why — either its request was malformed, or it didn't make sense given the current story state. This is the only place such a rejection is ever recorded (nothing about a rejected attempt is saved permanently).
- `DevEventSchema` — the combined list of the three dev-message kinds above.

## `packages/protocol/src/commands.ts`

Defines every request a client (the web app, eventually a CLI) is allowed to send to the engine — the "buttons and forms" side of the contract, as opposed to `events.ts`'s "history log" side. Every command here is validated the moment it arrives, and any free text a player types is capped in length before it can ever reach an AI prompt (protecting against abuse and runaway costs). Each command has a matching "accepted" response confirming it was received — the real result usually arrives later as an event on the stream.
- `StartTurnCommandSchema` / `StartTurnAcceptedSchema` — "take my turn" (optionally with something the player typed) / "got it, your turn id is X."
- `InterruptTurnCommandSchema` / `InterruptTurnAcceptedSchema` — "stop generating right now" (naming the last sentence the player actually saw) / confirms whether anything was saved from the interrupted turn.
- `EndSceneCommandSchema` / `EndSceneAcceptedSchema` — "close this scene" / confirms the scene closed and lists how many background clean-up tasks were queued.
- `OpenSceneCommandSchema` / `OpenSceneAcceptedSchema` — "start a new scene" (with a title, the characters in it, and optionally which place it opens at) / confirms it's starting.
- `ExploreCommandSchema` / `ExploreAcceptedSchema` — "reveal this fog-of-war square" / confirms the reveal is queued; the actual new place appears later as a `sublocation.materialized` event.
- `MapEditCommandSchema` / `MapEditAcceptedSchema` — "I drew this shape on the map and want a place like X there" / confirms it's queued for review.
- `MapClickCommandSchema` / `MapClickAcceptedSchema` — "I clicked this point on the map" / answers immediately if it's inside a known place, otherwise queues an AI classification of what's there.
- `AdvanceTimeCommandSchema` / `AdvanceTimeAcceptedSchema` — "skip the world's clock forward by this many minutes" / confirms the new time and how many background events that triggered.
- `PaintRegionCommandSchema` / `PaintRegionAcceptedSchema` — "generate/composite an image for this region" / confirms it's queued.
- `ApplyUpdateCommandSchema` / `ApplyUpdateAcceptedSchema` — "install this announced update now" / confirms it's queued.
- `SendChatMessageCommandSchema` / `SendChatMessageAcceptedSchema` — "DM this character" / confirms the message was saved and whether the character is actually free to reply right now (versus busy "in a scene," meaning offline).
- `ExitChatCommandSchema` / `ExitChatAcceptedSchema` — "I'm leaving this DM conversation" / confirms whether there was anything to wrap up.
- `StartSceneFromChatCommandSchema` / `StartSceneFromChatAcceptedSchema` — "turn this DM conversation into a real scene at this place" / confirms the scene opened, and whether the named place was recognized or needs the storytelling AI to figure it out.
- `CommandRejectedSchema` — the generic "your request was well-formed but the engine says no right now" response (e.g., a scene is busy).

## `packages/protocol/src/plugins.ts`

Describes how a client learns which plugins are currently active — think of it as the response to "what add-ons do you have installed?"
- `PluginInfoSchema` — one plugin's public profile: its name, version, where it came from and a hash proving its content hasn't been tampered with, plus lists of the visual/theme files and connector names it provides.
- `PluginListSchema` — the full list of currently active plugins, as returned by the `GET /v1/plugins` endpoint (a URL a client can ask for this information).
- `MapJumpDetailSchema` — describes the message a map plugin sends when the player picks a destination pin on the map ("please take me here") — validated the same strict way as everything else, so a replacement/third-party map plugin can't sneak in unexpected data.

## `packages/protocol/src/*.test.ts` (commands, dev, events, index, plugins)

These five files are automated tests, not app functionality — they don't ship any behavior a client uses directly. Each one feeds a schema both valid and deliberately broken example data (missing fields, extra unexpected fields, oversized text, values outside allowed ranges) and checks that the schema accepts the good data and rejects the bad data. This is what actually enforces the "customs form" promise: if someone tries to smuggle an extra field or oversized text through, these tests prove the schema catches it. `index.test.ts` just checks that `PROTOCOL_VERSION` is a normal-looking version number.

## `packages/protocol/schemas/*.json` (generated, not hand-written)

Not a source file, but worth knowing about: for every schema above, the build produces a matching `.json` file in `packages/protocol/schemas/`. These are the same "customs form" rules, but written in **JSON Schema**, a generic, language-neutral format that non-JavaScript programs (a future CLI written in another language, or any external tool) can read to validate messages without needing to understand TypeScript or Zod at all. They are produced automatically by `packages/protocol/scripts/emit.mjs` (via `npm run protocol:emit`) and are never edited by hand — the project's automated checks compare them against a freshly generated copy to make sure nobody edited them directly or forgot to regenerate them after a schema change.

## `packages/plugin-sdk/src/gateway-connector.ts`

Defines the contract that every messaging bridge (a "connector") must follow — whether it's the built-in Telegram bridge, an experimental WeChat one, or something a community member writes later. The idea: if a specific bridge library breaks or its maintainer disappears, anyone can write a replacement as long as it honors this same shape.
- `ConnectorHealth` — the four states a connector can report: `ok`, `degraded`, `paused` (a normal, expected state — e.g., WeChat enforces a 24-hour pause after some messages, and that's not treated as an error), or `stopped`.
- `InboundMessage` — the shape of one incoming message after a connector has translated it from whatever the messaging platform originally sent; it still gets independently double-checked by the main engine before being trusted with anything (a plugin author can't "lie" their way past the engine's own checks).
- `SendResult` — what a connector reports back after trying to send a message: success, or a machine-readable reason for failure — connectors are required to report failure this way rather than crashing.
- `GatewayConnector` — the actual interface (a contract listing which functions/properties something must have, without saying how they're implemented) every connector must provide: a stable id, `start`/`stop` methods that are safe to call more than once, a `send` method that never throws even when something goes wrong, a way to register a listener for incoming messages, and a `health` check.

## `packages/plugin-sdk/src/conformance.ts`

A ready-made test suite that any connector author can run against their own connector to check it actually obeys the contract above — without needing Weltari's own test tooling installed, so it works as a plain standalone script in any project.
- `ConformanceResult` — the shape of one check's outcome: which check it was, whether it passed, and an optional detail message.
- `runGatewayConnectorConformance(factory)` — takes a function that produces a fresh connector and runs it through a battery of behavioral checks: is its id non-empty, does `health()` always report one of the four known states, are `start()`/`stop()` safe to call twice in a row, does `stop()` correctly leave it in the `stopped` state, and — critically — does `send()` return a failure result instead of throwing an error when something goes wrong. It returns the full list of pass/fail results rather than stopping at the first failure, so an author sees everything wrong at once.

## `packages/plugin-sdk/src/manifest.ts`

Defines the format of `plugin.json`, the small description file every plugin must include, plus the rule for proving a plugin's files haven't been altered since it was published.
- `PluginManifestSchema` — the customs form for a plugin's manifest: its name (must match its own folder name, lowercase-with-dashes only), version number, which major version of the engine it's built for, which capabilities it offers (skills, themes, visual components, connectors — all optional), and provenance info (where it came from plus a content hash). Like the wire schemas, unknown extra fields are rejected outright.
- `computePluginContentHash(pluginDir)` — computes a fingerprint (a SHA-256 hash — a scrambled code that changes completely if even one byte of the input changes) over every file in a plugin's folder except the manifest itself. This is the rule the engine uses to check, every single time it loads a plugin, that nothing has been secretly modified, renamed, added, or removed since the plugin was published — if even one byte changes, the fingerprint no longer matches and the plugin is refused.

## `packages/plugin-sdk/src/index.ts`

Trivial re-export file — its only job is to gather everything from `gateway-connector.ts`, `conformance.ts`, and `manifest.ts` into one place so other code can import the whole SDK from a single path.

## `packages/plugin-sdk/src/conformance.test.ts`

An automated test proving the conformance suite (from `conformance.ts`) actually works: it builds a well-behaved "reference" fake connector and confirms it passes every check, then builds a deliberately broken one (that throws an error instead of reporting failure) and confirms the suite correctly catches and reports that specific failure with a useful detail message.

## `packages/plugin-sdk/src/manifest.test.ts`

An automated test for the manifest rules: confirms a well-formed `plugin.json` is accepted, and that a manifest with an extra unexpected field, an invalid name (e.g. one trying a directory-escape trick like `../escape`), or a malformed engine-version string is correctly rejected. It also proves the content-hash function works as promised: the hash stays the same no matter how many times you compute it or even if you edit `plugin.json` itself (which is deliberately excluded), but changes the instant a single byte in any other file is edited.

## How this connects to the rest of the app

`packages/protocol` is imported by both halves of the running app: the server (`apps/server`) uses it to validate every incoming command and to shape every event it writes to the permanent log and streams to clients; the web app (`apps/web`) uses the very same schemas to know what a valid server response looks like and to build the requests it sends — this is what guarantees the two sides can never quietly drift out of sync, since they're reading from one shared rulebook instead of two separately-maintained copies. The generated `schemas/*.json` files exist for anyone building a client in a different language who can't import TypeScript code directly.

`packages/plugin-sdk` is imported by plugin and connector authors — including Weltari's own built-in messaging bridges — as the toolkit they build against. A connector author implements the `GatewayConnector` interface, runs `runGatewayConnectorConformance()` against it to prove it behaves correctly, and the main engine loads it, re-validating everything it delivers (a plugin is never trusted blindly). The `manifest.ts` rules are what the engine's plugin loader checks at every single startup — a plugin whose files don't match its published hash, or whose manifest doesn't parse, is refused and the app boots without it rather than risk running tampered or broken code.

Both packages are the two places in the whole codebase explicitly allowed to be copied wholesale into someone else's project, commercial or not, without triggering the AGPL's share-back requirement — that boundary is enforced by a rule (checked by the project's automated tooling) that neither package may ever import code from the main `apps/*` folders.
