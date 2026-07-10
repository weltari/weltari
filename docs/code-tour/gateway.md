# Code tour — gateway (doors to the outside world)

The gateway is the small set of files that let outside chat apps — right now,
Telegram — talk to a Weltari world. Think of it as a reception desk: a
messenger app (a "connector") knocks on the door with a message, the
reception desk checks the message is well-formed, checks it isn't a second
copy of something already delivered, hands it to the world engine to produce
a reply, and posts the reply back out. The connector itself is kept dumb on
purpose — all the trust decisions happen in one place, the "host," so a
buggy or malicious connector can at worst fail to deliver a message; it can
never corrupt the world.

Three ideas recur across every file here, so it's worth naming them plainly
up front:

- **Validate** — every message coming in from outside is checked against a
  strict template (a "schema") that says exactly which fields must be
  present and what shape they must be. Anything that doesn't match — extra
  fields, wrong types, missing pieces — is thrown out before it can reach
  the world.
- **Cap** — even a message that passes validation gets its text trimmed to a
  hard maximum (8,000 characters, "8 KB"). This stops an enormous wall of
  text from ever reaching the AI prompt.
- **Dedup** ("deduplicate") — messaging apps sometimes redeliver the same
  message (e.g. after a restart or a flaky connection). Each incoming
  message gets a unique fingerprint, and the database itself refuses to
  store the same fingerprint twice — so a repeat delivery is silently
  dropped instead of triggering a second reply.

## host.ts

`apps/server/src/gateway/host.ts` is the reception desk described above —
the one piece of code every connector's traffic must pass through, no
matter which messaging app it came from.

- `createGatewayHost(options)` — builds the host object. It wires together
  storage (the database), a logger (for diagnostics), the list of connectors
  to manage, and a `runTurn` function (the bridge into the world engine that
  actually produces a reply). Internally it does the validate → cap →
  dedup → run-a-turn → send-the-reply pipeline described above for every
  inbound message, and it logs (rather than crashes) if a reply fails to
  send — a delivery failure is treated as an ordinary hiccup, not a bug.
- The returned `GatewayHost` object exposes three plain-English actions:
  `start()` turns on every registered connector and starts listening for
  their messages; `stop()` turns them all off; `health()` reports each
  connector's current status (for example "ok", "degraded", or "stopped").

The 8 KB text cap is exported as `INBOUND_TEXT_CAP` so the same limit is
referenced everywhere it matters, not hard-coded in more than one place.

## telegram/

### telegram/connector.ts

`apps/server/src/gateway/telegram/connector.ts` is the Telegram-specific
connector — the actual code that talks to Telegram's servers. It is
deliberately thin: its only real job is translating Telegram's own message
format into Weltari's plain internal shape; every trust decision (validate,
cap, dedup) is left to `host.ts`.

It uses a third-party library called grammY to do the actual talking to
Telegram, but that library is only ever imported in this one file — a
deliberate quarantine so a problem with a third-party dependency can't leak
into the rest of the codebase.

Telegram is contacted by **long-polling**: instead of Telegram pushing
messages to a public web address Weltari would have to expose (a
"webhook"), Weltari repeatedly asks Telegram "anything new for me?" over an
outbound connection. This means a home server sitting behind a router (no
public internet address, i.e. "NAT-first") can still receive Telegram
messages without opening any door inward.

- `mapUpdate(raw)` — a small, pure translation function: given a raw update
  from Telegram, it returns a clean internal message (or `null` if the
  update isn't a plain text message, e.g. a sticker or an edited message).
  It runs the raw data through its own local template first — Telegram's
  advertised data shapes are never simply trusted, because a library's
  compile-time promises don't protect against what actually arrives over
  the wire. Because Telegram's own message IDs are only unique *within one
  chat*, the fingerprint used for dedup is built as `<chat id>:<message
  id>`.
- `createTelegramConnector(options)` — builds the connector object that the
  host manages. Its `start()` begins long-polling; `stop()` cleanly shuts
  the connection down; `send(conversationId, text)` posts a reply back to
  the right Telegram chat and reports success or failure as a plain value
  rather than throwing an error; `onInbound(next)` lets the host register
  its callback for new messages; `health()` reports whether the connector is
  currently "ok", "degraded" (something went wrong but polling is still
  running), or "stopped".

### telegram/connector.test.ts

`apps/server/src/gateway/telegram/connector.test.ts` is the automated test
file for `mapUpdate`. It feeds the function a normal text message, a
sticker, an edited message, several malformed/garbage inputs, and a message
with an unrecognized extra field Telegram might add in the future — and
checks that only genuine plain-text messages are ever passed through, with
unknown extra fields simply ignored rather than causing a crash.

## ../storage/repositories/gateway.ts

`apps/server/src/storage/repositories/gateway.ts` lives outside the gateway
folder proper (it's part of the storage layer) but it's where the dedup
guarantee actually lives, so it's worth including here. It is the only place
in the whole codebase allowed to run SQL for the `gateway_inbound` table.

- `createGatewayRepository(db, nowIso)` — builds a small repository object
  with one method, `recordInbound(message)`. It inserts the incoming
  message's fingerprint into the database with a rule that says "do nothing
  if this exact fingerprint is already there" (a database-level uniqueness
  rule, not something the connector code has to remember to check itself).
  It returns `true` if this was a genuinely new message, or `false` if it
  was a duplicate — that `false` return value *is* the silent-drop
  mechanism `host.ts` relies on. Because the uniqueness check lives in the
  database itself, this protection survives a server restart: even if the
  server crashed and re-processed old Telegram updates, a message already
  recorded before the crash still cannot be recorded (and therefore
  replied-to) a second time.

## How this connects to the rest of the app

The gateway is the *only* way a message from an external chat app can enter
a Weltari world, and it never talks to the game engine directly with raw
text — `host.ts` calls a `runTurn` function that hands off to the normal
scene engine, the same machinery that handles a turn taken through the web
app. From the engine's point of view, a Telegram message becomes an
ordinary "turn" event, tagged with the actor `gateway:telegram`, so nothing
downstream needs to know or care that the message came from outside the
app at all. Adding a new messaging app later (e.g. WeChat) means writing one
more thin connector file like `telegram/connector.ts` and registering it
with the same host — the validate/cap/dedup protections apply automatically
because they live in `host.ts`, not in each connector.
