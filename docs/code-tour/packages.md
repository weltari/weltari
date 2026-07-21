# Code tour — packages/ (protocol & plugin-sdk)

Weltari's main program (the "server") is licensed AGPL-3.0 — a "copyleft"
license that says: if someone builds on this code and ships it, they must
share their changes back. That's a strong protection for the project, but
it's poison for two things that need to be shared as freely as possible: the
"rulebook" that describes what messages look like on the wire, and the
toolkit that plugin/connector authors build against. So those two pieces
live in `packages/protocol` and `packages/plugin-sdk` — separate npm
packages, licensed MIT (a much more permissive license: "take it, use it, no
strings"), and they are contractually forbidden from importing any code from
the main `apps/*` folders. Think of them as the two doorframes of the house:
anyone is free to copy the doorframe design, but that doesn't hand them the
house. `protocol` is the shared language between the engine and every screen
that talks to it (the built-in web app, a future command-line client, future
external games). `plugin-sdk` is the rulebook for anyone writing an add-on —
a messaging bridge (like a Telegram connector) or a visual/theme plugin.

## `packages/protocol/src/index.ts`

This is the package's front door — the one file other code actually imports
from. It does two things: it declares `PROTOCOL_VERSION` (now `0.21.0`), a
version number stamped on every connection handshake so a client can refuse
to talk to an engine that's too different (a bit like a phone charger
checking the voltage before it draws power), and it re-exports everything
defined in the other files below so consumers only need one import line. The
version-history comment at the top is effectively a changelog of every
wire-format feature ever added, from the first scenes (0.1) all the way to
the agentic scene (0.21) — useful background reading, but not something you
need to memorize.

## `packages/protocol/src/events.ts`

This file lists every kind of permanent record the engine is allowed to
write to its history log — the "events" that make up the story's official
record. Think of the event log as a bank statement: once a line is printed,
it is never edited or deleted, only added to. Each event is defined with a
**schema** — a schema is like a customs form: it precisely states which
fields a message must have, what type each one is, and (because these use
`strictObject`) that no extra, unexpected fields are allowed to sneak
through. Validating something against a schema means checking the incoming
data against that form and rejecting anything that doesn't match.

Every event shares a common "envelope": an id (its position in the log),
which world it belongs to, who caused it (`actor_id` — nothing happens
anonymously), and a timestamp.

By V1 there are around seventy event kinds, so this tour describes them as
**families** rather than one by one — the file itself has a doc-comment on
every schema if you want the field-level detail.

**Scenes and turns** — the visual-novel heart of the app.
`scene.started` opens a scene (it can carry an opening premise, an
unresolved "place request" handed over from a chat, an invitation with a
game-time deadline, or — new in V1's final weeks — a "brief history" and
carried-over goals inherited from the previous scene). `character.joined`
records each cast member, and can now also arrive mid-scene when the
storytelling AI invents someone on the spot; its new twin `character.left`
records a character walking out while the scene keeps going.
`turn.started` and `turn.committed` bracket one round of AI storytelling —
only the committed record is "real"; text you watched stream by doesn't
count until it lands here. `scene.goals_updated` is the agentic-scene
addition: the storytelling AI keeps a short written checklist of what the
scene is trying to accomplish (each goal marked pending, active, or done),
saved with every turn — so even after a crash and restart, the story resumes
knowing exactly where it stood. `scene.ended` closes a scene, records how
it ended (rest, continuation, travel — or "the AI's context filled up",
which the screen treats like a rest), and can register a full follow-up
scene: where it opens, how many in-world hours later, who is expected to
attend, a short recap, and which goals carry over. `scene.expired` closes
an invitation scene the player simply never showed up to.

**Weltari Chat** — the direct-message side. `chat.message_committed` is one
DM line (with a de-duplication id so a retried send can never double-post);
`chat.ended` closes a conversation and marks which lines still need
reflecting on; `reflect_chat.committed` is the character's takeaway from
that conversation. Characters can also reach out first:
`chat.outreach_recorded` is a scheduled, character-initiated DM (the
"they texted me!" feature), and `chat.thread_frozen` records the polite
hard stop after three unanswered messages — a character never spams
forever. Group chats get their own trio (`chat.group_started`,
`chat.group_message_committed`, `chat.group_ended`), and `chat.notice` is a
red-line system notice shown when something in a conversation had to be
rolled back.

**Memory** — how characters remember. `cache.appended` is the short "what
just happened to me" note after any interaction. On top of that sits the
real long-term memory store: `memory.delta_committed` (one curated recall
note, kept forever and searchable), `memory.core_updated` (a full snapshot
of a character's durable core memory), `character.evolved` (a personality or
goals rewrite — refused outright for a character the player has locked),
`memory.compacted` (a rolling summary over old notes so prompts stay
short), and `cache.pruned` (a watermark that hides old short-term notes
from view without ever deleting them — replaying the log rebuilds the exact
same view).

**The Feed** — the in-world social network. `social.post_committed` is a
character's scheduled post; `social.reaction_committed` is another
character's like or one-line comment; `social.reply_posted` and
`social.reply_answered` are the player's reply to a comment and the
author's single answer back. All of it stays on the feed — it never leaks
into the DM system.

**The map and places** — `MapPositionSchema` / `MapSquareSchema` /
`MAP_FOG_GRID` (=8) define the shared coordinate system (positions are
fractions from 0 to 1, so nothing moves if the map image is redrawn).
`sublocation.materialized` reveals a fog-of-war square with a freshly
invented place; `sublocation.stub_created` is a place the storytelling AI
invented mid-scene ("let's go to the tavern" — and now the tavern exists);
`map_edit.requested` and `sublocation.created` are the player drawing a
shape on the map and the approved place that results;
`map_click.resolved` answers a click on already-explored ground (a real new
place, or a one-time discovery); `sublocation.changed` switches the current
scene's backdrop to a different place. The living-world loop adds
**markers** — `marker.dropped` (a story hook pinned to the map, with an
in-game expiry time; nothing is generated until you click it),
`marker.instantiated` (your click won and opened the one scene), and
`marker.expired` (you let it lapse — the encounter simply never happened).
`character.location_changed` records characters moving around the world on
their own between scenes — either by the background clock or by the
storytelling AI moving someone mid-story.

**Objects** — things characters can pick up and pass around (V1 keeps them
attached to places; personal inventories are a V2 idea).
`object.created` (an object becomes real the moment someone actually
touches it — scenery merely mentioned never becomes data),
`object.payload_written` (text written onto it, e.g. a letter — write-once,
so a note can't be quietly rewritten), `object.moved` (place to place), and
`object.swept` (an untouched leftover is tidied away — the record of its
existence stays in the log forever).

**Consent and the GM** — the game-master AI never changes your world
directly; it asks. `proposal.submitted` is a consent card (create a place,
a character, an object, edit a wiki page, or seed a whole new world),
`proposal.resolved` is your approve/reject answer (approve applies the
change atomically; reject leaves zero trace beyond the answer itself), and
`proposal.discussed` records that you clicked "Chat about this" instead —
the GM stops proposing and listens. Around that sit `character.created`
(a consent-approved character's seed profile), `world.seeded` (the moment a
brand-new world finishes its setup interview and becomes playable),
`gateway.binding_established` (the first time a messenger conversation is
tied to this world — triggers the one-time GM welcome),
`config.flag_set` (world settings like "profiling on/off", default off),
`character.lock_set` (your lock against a character's personality
evolving), and `profile.updated` / `profile.deleted` — the GM's notes about
you live in a separate, genuinely deletable store, and the log only ever
records counts, never the notes themselves, so a GDPR delete truly erases.

**The world clock** — `world.time_advanced` (a time skip, noting how many
background happenings it triggered) and `world_cron.completed` (one
scheduled background occurrence finished).

**The wiki** — `subwiki.updated` (the automatic end-of-scene entry about a
visited place) and `subwiki.edited` (your own manual edit, applied
immediately and clearly attributed to you).

**Housekeeping** — `art.switched` (a character's on-screen pose changed),
`painter.completed` (an image finished and was saved with a fingerprint
proving which file is the trusted one), `plugin.rejected` (a plugin failed
a safety check and the app booted without it), `update.available` /
`update.staged` (a new version announced / downloaded, verified, and ready
for next restart), and `job.failed` / `job.parked` (a background task's
retry, or its final give-up that needs a human). `ImageRegionSchema` is a
plain reusable rectangle for image crops.

`WeltariEventSchema` at the bottom is the master list tying all of the
above into one "this is a valid event" check; anything not on the list is
rejected.

## `packages/protocol/src/stream.ts`

Describes the "live, temporary" messages sent over the connection while the
player is watching text appear on screen in real time — these use a
technology called **SSE** (Server-Sent Events), which is just a way for the
server to keep pushing small updates to the browser without the browser
having to keep asking "anything new?" Unlike the events in `events.ts`,
nothing here is saved permanently — if the connection drops, these are
simply lost (the permanent `turn.committed` record is what matters
afterward).
- `StreamHelloSchema` — the very first message sent when a client connects:
  it announces the protocol version (so an old/new mismatch can be caught
  immediately) and how far along the permanent history the client already
  knows.
- `StreamSentenceSchema` — one sentence of AI text as it's being "typed
  out" live to the screen, before it becomes permanent. It's tagged with
  which kind of reply it belongs to — a scene turn, a DM, or (added with
  the GM conversation) a GM reply streaming into the GM chat thread.

## `packages/protocol/src/dev.ts`

Defines a separate, optional stream of behind-the-scenes diagnostic
messages, only sent to developers/the owner who explicitly ask for "dev
mode." Like `stream.ts`, none of this is saved permanently.
- `DevGaugesSchema` — a periodic health check-in: how fast the server is
  responding and how much memory it's using, with a flag if either crosses
  a concerning threshold.
- `DevToolCallSchema` — a record that the storytelling AI successfully used
  one of its tools (like "change the location" or "create a place") and it
  passed all safety checks.
- `DevToolRejectedSchema` — a record that the AI tried to use a tool but
  got refused, and why — either its request was malformed, or it didn't
  make sense given the current story state. This is the only place such a
  rejection is ever recorded (nothing about a rejected attempt is saved
  permanently).
- `DevEventSchema` — the combined list of the three dev-message kinds
  above.

## `packages/protocol/src/commands.ts`

Defines every request a client (the web app, eventually a CLI) is allowed
to send to the engine — the "buttons and forms" side of the contract, as
opposed to `events.ts`'s "history log" side. Every command here is
validated the moment it arrives, and any free text a player types is capped
in length before it can ever reach an AI prompt (protecting against abuse
and runaway costs). Each command has a matching "accepted" response
confirming it was received — the real result usually arrives later as an
event on the stream. Grouped by what they drive:

- **Turns and scenes** — `start-turn` ("take my turn", optionally with
  typed input), `interrupt-turn` ("stop generating", naming the last
  sentence actually seen), `end-scene`, `open-scene` (title, cast,
  optionally which place).
- **The map** — `explore` (reveal a fog square), `map-edit` (I drew a shape
  and want a place like X there), `map-click` (what's at this point? —
  answered instantly if it's a known place, otherwise queued for the AI),
  `marker-click` (open the story hook pinned here; if someone else's click
  already opened it, you join; if it quietly expired, you're told so).
- **Time, images, updates** — `advance-time` (skip the world clock
  forward), `paint-region` (generate/composite an image), `apply-update`
  (install the announced new version).
- **Chat** — `send-chat-message` (DM a character; the answer says whether
  they're free to reply or "in a scene", i.e. offline), `exit-chat`,
  `start-scene-from-chat` (turn this DM into a real scene at a place),
  plus the group-chat trio `start-group-chat` / `send-group-message` /
  `exit-group-chat`.
- **The feed and the wiki** — `feed-reply` (reply to a character's feed
  comment) and `subwiki-edit` (edit a place's wiki page yourself, applied
  immediately under your name).
- **Consent** — `resolve-proposal` (approve or reject a GM consent card;
  approving applies the change atomically, and a card can only ever be
  resolved once) and `discuss-proposal` (the "Chat about this" button —
  the card stays open while you talk it over).
- **Settings and rights** — `set-config-flag` (world flags like profiling
  on/off), `set-character-lock` (lock a character against personality
  evolution), and `delete-profile` (the GDPR right: permanently erase the
  GM's notes about you).
- `CommandRejectedSchema` — the generic "your request was well-formed but
  the engine says no right now" response (e.g., a scene is busy).

## `packages/protocol/src/profile.ts`

The wire shapes for the "what does the GM think of me?" page
(`GET /v1/profile` and its export twin): `ProfileEntrySchema` is one
hypothesis the GM has noted about the player, and `UserProfileViewSchema`
is the full view — the entries plus whether profiling is even switched on.
This is deliberately its own little file and its own private URL: the GM's
notes travel only over this surface, straight to the player who owns them,
and never appear on the shared event stream.

## `packages/protocol/src/plugins.ts`

Describes how a client learns which plugins are currently active — think of
it as the response to "what add-ons do you have installed?"
- `PluginInfoSchema` — one plugin's public profile: its name, version,
  where it came from and a hash proving its content hasn't been tampered
  with, plus lists of the visual/theme files and connector names it
  provides.
- `PluginListSchema` — the full list of currently active plugins, as
  returned by the `GET /v1/plugins` endpoint (a URL a client can ask for
  this information).
- `MapJumpDetailSchema` — describes the message a map plugin sends when the
  player picks a destination pin on the map ("please take me here") —
  validated the same strict way as everything else, so a replacement or
  third-party map plugin can't sneak in unexpected data.

## `packages/protocol/src/*.test.ts` (commands, dev, events, index, plugins)

These files are automated tests, not app functionality — they don't ship
any behavior a client uses directly. Each one feeds a schema both valid and
deliberately broken example data (missing fields, extra unexpected fields,
oversized text, values outside allowed ranges) and checks that the schema
accepts the good data and rejects the bad data. This is what actually
enforces the "customs form" promise: if someone tries to smuggle an extra
field or oversized text through, these tests prove the schema catches it.
`index.test.ts` just checks that `PROTOCOL_VERSION` is a normal-looking
version number.

## `packages/protocol/schemas/*.json` (generated, not hand-written)

Not a source file, but worth knowing about: for every schema above, the
build produces a matching `.json` file in `packages/protocol/schemas/`.
These are the same "customs form" rules, but written in **JSON Schema**, a
generic, language-neutral format that non-JavaScript programs (a future CLI
written in another language, or any external tool) can read to validate
messages without needing to understand TypeScript or Zod at all. They are
produced automatically by `packages/protocol/scripts/emit.mjs` (via
`npm run protocol:emit`) and are never edited by hand — the project's
automated checks compare them against a freshly generated copy to make sure
nobody edited them directly or forgot to regenerate them after a schema
change.

## `packages/plugin-sdk/src/gateway-connector.ts`

Defines the contract that every messaging bridge (a "connector") must
follow — whether it's the built-in Telegram bridge, an experimental WeChat
one, or something a community member writes later. The idea: if a specific
bridge library breaks or its maintainer disappears, anyone can write a
replacement as long as it honors this same shape.
- `ConnectorHealth` — the four states a connector can report: `ok`,
  `degraded`, `paused` (a normal, expected state — e.g., WeChat enforces a
  24-hour pause after some messages, and that's not treated as an error),
  or `stopped`.
- `InboundMessage` — the shape of one incoming message after a connector
  has translated it from whatever the messaging platform originally sent;
  it still gets independently double-checked by the main engine before
  being trusted with anything (a plugin author can't "lie" their way past
  the engine's own checks).
- `SendResult` — what a connector reports back after trying to send a
  message: success, or a machine-readable reason for failure — connectors
  are required to report failure this way rather than crashing.
- `GatewayConnector` — the actual interface (a contract listing which
  functions/properties something must have, without saying how they're
  implemented) every connector must provide: a stable id, `start`/`stop`
  methods that are safe to call more than once, a `send` method that never
  throws even when something goes wrong, a way to register a listener for
  incoming messages, and a `health` check.

## `packages/plugin-sdk/src/conformance.ts`

A ready-made test suite that any connector author can run against their own
connector to check it actually obeys the contract above — without needing
Weltari's own test tooling installed, so it works as a plain standalone
script in any project.
- `ConformanceResult` — the shape of one check's outcome: which check it
  was, whether it passed, and an optional detail message.
- `runGatewayConnectorConformance(factory)` — takes a function that
  produces a fresh connector and runs it through a battery of behavioral
  checks: is its id non-empty, does `health()` always report one of the
  four known states, are `start()`/`stop()` safe to call twice in a row,
  does `stop()` correctly leave it in the `stopped` state, and —
  critically — does `send()` return a failure result instead of throwing
  an error when something goes wrong. It returns the full list of pass/fail
  results rather than stopping at the first failure, so an author sees
  everything wrong at once.

## `packages/plugin-sdk/src/manifest.ts`

Defines the format of `plugin.json`, the small description file every
plugin must include, plus the rule for proving a plugin's files haven't
been altered since it was published.
- `PluginManifestSchema` — the customs form for a plugin's manifest: its
  name (must match its own folder name, lowercase-with-dashes only),
  version number, which major version of the engine it's built for, which
  capabilities it offers (skills, themes, visual components, connectors —
  all optional), and provenance info (where it came from plus a content
  hash). Like the wire schemas, unknown extra fields are rejected outright.
- `computePluginContentHash(pluginDir)` — computes a fingerprint (a
  SHA-256 hash — a scrambled code that changes completely if even one byte
  of the input changes) over every file in a plugin's folder except the
  manifest itself. This is the rule the engine uses to check, every single
  time it loads a plugin, that nothing has been secretly modified, renamed,
  added, or removed since the plugin was published — if even one byte
  changes, the fingerprint no longer matches and the plugin is refused.

## `packages/plugin-sdk/src/index.ts`

Trivial re-export file — its only job is to gather everything from
`gateway-connector.ts`, `conformance.ts`, and `manifest.ts` into one place
so other code can import the whole SDK from a single path.

## `packages/plugin-sdk/src/conformance.test.ts`

An automated test proving the conformance suite (from `conformance.ts`)
actually works: it builds a well-behaved "reference" fake connector and
confirms it passes every check, then builds a deliberately broken one (that
throws an error instead of reporting failure) and confirms the suite
correctly catches and reports that specific failure with a useful detail
message.

## `packages/plugin-sdk/src/manifest.test.ts`

An automated test for the manifest rules: confirms a well-formed
`plugin.json` is accepted, and that a manifest with an extra unexpected
field, an invalid name (e.g. one trying a directory-escape trick like
`../escape`), or a malformed engine-version string is correctly rejected.
It also proves the content-hash function works as promised: the hash stays
the same no matter how many times you compute it or even if you edit
`plugin.json` itself (which is deliberately excluded), but changes the
instant a single byte in any other file is edited.

## How this connects to the rest of the app

`packages/protocol` is imported by both halves of the running app: the
server (`apps/server`) uses it to validate every incoming command and to
shape every event it writes to the permanent log and streams to clients;
the web app (`apps/web`) uses the very same schemas to know what a valid
server response looks like and to build the requests it sends — this is
what guarantees the two sides can never quietly drift out of sync, since
they're reading from one shared rulebook instead of two
separately-maintained copies. The generated `schemas/*.json` files exist
for anyone building a client in a different language who can't import
TypeScript code directly.

`packages/plugin-sdk` is imported by plugin and connector authors —
including Weltari's own built-in messaging bridges — as the toolkit they
build against. A connector author implements the `GatewayConnector`
interface, runs `runGatewayConnectorConformance()` against it to prove it
behaves correctly, and the main engine loads it, re-validating everything
it delivers (a plugin is never trusted blindly). The `manifest.ts` rules
are what the engine's plugin loader checks at every single startup — a
plugin whose files don't match its published hash, or whose manifest
doesn't parse, is refused and the app boots without it rather than risk
running tampered or broken code.

Both packages are the two places in the whole codebase explicitly allowed
to be copied wholesale into someone else's project, commercial or not,
without triggering the AGPL's share-back requirement — that boundary is
enforced by a rule (checked by the project's automated tooling) that
neither package may ever import code from the main `apps/*` folders.
