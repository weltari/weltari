# Code tour — gateway (doors to the outside world)

*Current as of the V1 close-out (week 19, 2026-07-21).*

The gateway is the small set of files that let outside chat apps — right now,
Telegram — talk to a Weltari world. Think of it as a reception desk: a
messenger app (a "connector") knocks on the door with a message, the
reception desk checks the message is well-formed, checks it isn't a second
copy of something already delivered, hands it inward, and posts the reply
back out. The connector itself is kept dumb on purpose — all the trust
decisions happen in one place, the "host," so a buggy or malicious connector
can at worst fail to deliver a message; it can never corrupt the world.

Since this tour was first written, the gateway grew a second big idea: the
messenger is now a **window into Weltari Chat**, not a separate channel.
When a character texts you inside Weltari, that message can be pushed out to
your Telegram; when you reply on Telegram, your words land in the very same
in-app conversation, and the character's answer comes back to your phone.
Both sides always show the same thread. The file that makes this true is
the chat bridge, described below.

Three protections recur across every file here, so it's worth naming them
plainly up front:

- **Validate** — every message coming in from outside is checked against a
  strict template (a "schema") that says exactly which fields must be
  present and what shape they must be. Anything that doesn't match is
  thrown out before it can reach the world.
- **Cap** — even a message that passes validation gets its text trimmed to a
  hard maximum (8,000 characters, "8 KB"). This stops an enormous wall of
  text from ever reaching the AI prompt.
- **Dedup** ("deduplicate") — messaging apps sometimes redeliver the same
  message (e.g. after a restart or a flaky connection). Each incoming
  message gets a unique fingerprint, and the database itself refuses to
  store the same fingerprint twice — so a repeat delivery is silently
  dropped instead of triggering a second reply.

## host.ts

`apps/server/src/gateway/host.ts` is the reception desk — the one piece of
code every connector's traffic must pass through, no matter which messaging
app it came from.

- `createGatewayHost(options)` — builds the host object. It wires together
  storage (the database), a logger, the list of connectors to manage, and a
  routing function (the seam into the chat bridge that actually produces a
  reply). For every inbound message it runs the validate → cap → dedup →
  route → send-the-reply pipeline, and it logs (rather than crashes) if
  routing or a reply fails — a delivery hiccup is an ordinary event, not a
  bug. The message's external ID rides along into the route, where the
  bridge reuses it as a second duplicate guard on the chat side — belt and
  braces on top of the database fence.
- The returned `GatewayHost` exposes three plain-English actions:
  `start()` turns on every registered connector, `stop()` turns them off,
  and `health()` reports each connector's status ("ok", "degraded", or
  "stopped").

The 8 KB text cap is exported as `INBOUND_TEXT_CAP` so the same limit is
referenced everywhere it matters, not hard-coded in more than one place.

## chat-bridge.ts

`apps/server/src/gateway/chat-bridge.ts` is the bridge between the
messenger world and Weltari Chat — the file that makes "the messenger is a
window" real. It has two directions:

- **Inbound** (`route`) — your Telegram text becomes a normal Weltari Chat
  message in the same conversation you were answering. The bridge picks the
  reply target sensibly: the character whose message most recently reached
  you (you answer the text you received), or the first character on the
  roster if no one has written yet. The character's reply comes back as the
  text to echo to your phone. If that character is currently busy inside a
  live scene, you get a short "they're occupied" presence note instead of
  silence. The messenger message's own ID doubles as the chat system's
  duplicate token, so even an unlikely slip past the database fence cannot
  produce the same line twice.
- **Outbound** (`onDurableEvent`) — the bridge listens to the app's *live*
  event stream (never the startup replay, so a restart can never re-send
  old messages) for exactly two things. When a scheduled character
  message fires (a "CRON DM"), its text was already written and committed
  at fire time, so the push to Telegram carries the exact same words the
  in-app thread shows — never a regenerated variant. And when a chat
  thread freezes waiting on you, it pushes a fixed
  "<Name> is waiting for you to reply." nudge (the in-app chat itself
  deliberately shows nothing).

Two more behaviors live here:

- **Subscribing is just saying hi** — V1 has no settings screen for this:
  messaging the bot once is subscribing, and pushes go to whichever
  external chat spoke to us most recently on that connector.
- **The first hello triggers a one-time welcome** — the very first message
  ever received from a given (connector, chat) pair establishes a durable
  "binding" record plus a hardcoded GM welcome line, written to the
  database in one transaction *before* the welcome is pushed to your
  phone. That ordering means a crash mid-push can never re-fire the
  onboarding — it happens once per pairing, ever, across restarts and
  redeliveries alike.

A week-19 refinement: the bridge re-reads the character roster fresh on
every lookup rather than caching it at startup, so a character minted
mid-session can be named and reached over the messenger without a restart.

`chat-bridge.test.ts`, alongside it, checks the promises above: the pushed
text exactly equals the thread text, the freeze notice is the fixed string,
nothing is pushed when no one has subscribed, and a redelivered message
never doubles a line or a reply.

## telegram/

### telegram/connector.ts

`apps/server/src/gateway/telegram/connector.ts` is the Telegram-specific
connector — the actual code that talks to Telegram's servers. It is
deliberately thin: its only real job is translating Telegram's message
format into Weltari's plain internal shape; every trust decision (validate,
cap, dedup) is left to `host.ts`.

It uses a third-party library called grammY to do the talking, but that
library is only ever imported in this one file — a deliberate quarantine so
a problem with a third-party dependency can't leak into the rest of the
codebase.

Telegram is contacted by **long-polling**: instead of Telegram pushing
messages to a public web address Weltari would have to expose (a
"webhook"), Weltari repeatedly asks Telegram "anything new for me?" over an
outbound connection. This means a home server sitting behind a router (no
public internet address) can still receive Telegram messages without
opening any door inward.

- `mapUpdate(raw)` — a small, pure translation function: given a raw update
  from Telegram, it returns a clean internal message (or `null` if the
  update isn't a plain text message, e.g. a sticker or an edit). It runs
  the raw data through its own local template first — Telegram's advertised
  data shapes are never simply trusted, because a library's compile-time
  promises don't protect against what actually arrives over the wire.
  Because Telegram's message IDs are only unique *within one chat*, the
  dedup fingerprint is built as `<chat id>:<message id>`.
- `createTelegramConnector(options)` — builds the connector object the host
  manages: `start()` begins long-polling, `stop()` shuts down cleanly,
  `send(conversationId, text)` posts a reply and reports success or failure
  as a plain value rather than throwing, `onInbound(next)` lets the host
  register its callback, and `health()` reports "ok", "degraded", or
  "stopped".

### telegram/connector.test.ts

The automated test file for `mapUpdate`. It feeds the function a normal
text message, a sticker, an edited message, several malformed/garbage
inputs, and a message with an unrecognized extra field Telegram might add
in the future — and checks that only genuine plain-text messages pass
through, with unknown extras simply ignored rather than causing a crash.

## ../storage/repositories/gateway.ts

`apps/server/src/storage/repositories/gateway.ts` lives outside the gateway
folder proper (it's part of the storage layer) but it's where the dedup
guarantee actually lives, so it's worth including here. It is the only
place in the codebase allowed to run SQL for the `gateway_inbound` table.

- `recordInbound(message)` — inserts the incoming message's fingerprint
  with a database-level rule that says "do nothing if this exact
  fingerprint is already there." It returns `true` for a genuinely new
  message, `false` for a duplicate — that `false` *is* the silent-drop
  mechanism `host.ts` relies on. Because the check lives in the database
  itself, it survives a server restart: a message recorded before a crash
  still cannot be replied-to a second time afterward.
- `latestConversationId(connectorId)` — the flip side: which external chat
  most recently talked to us, i.e. where the bridge's outbound pushes
  should go. This is the whole of V1's "subscription" storage.

## How this connects to the rest of the app

The gateway is the *only* way a message from an external chat app can enter
a Weltari world, and it never touches the game engine directly with raw
text. In the earliest version, a Telegram message became a scene turn;
that's retired — today the gateway is a **chat surface**: `host.ts` hands
each deduplicated message to `chat-bridge.ts`, which sends it through the
same Weltari Chat machinery a message typed in the web app would use, into
the same conversation, and durable chat events flow back out as pushes.
Nothing downstream needs to know or care that the words came from a phone.
Adding a new messaging app later (e.g. WeChat) means writing one more thin
connector file like `telegram/connector.ts` and registering it with the
same host — the validate/cap/dedup protections and the whole bridge apply
automatically, because they live in `host.ts` and `chat-bridge.ts`, not in
each connector.
