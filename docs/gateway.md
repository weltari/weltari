# gateway — apps/server/src/gateway

Purpose: messenger connectors behind the MIT `GatewayConnector` contract ([plugin-sdk.md](plugin-sdk.md)). NAT-first (Brief §7c): outbound long-polling only, no webhooks, no public endpoint. B7 is enforced by the HOST, never delegated to a connector.

## Contract

- Inputs: connector inbound callbacks (boundary data, B10); `TELEGRAM_BOT_TOKEN` (env-only secret; absent = connector stays stopped).
- Outputs: deduplicated inbound rows (`gateway_inbound`); per first-delivery message ONE Weltari Chat send into the SAME conversation_id (M6 part 4 — the messenger is a VIEW of the chat, Rev 4 §13) with the reply echoed back via `connector.send`; live pushes of eager CRON DMs + the hardcoded frozen-thread notice.
- Never: trust a connector's payload shape (host re-validates with its own strict Zod via `validateAt('telegram', …)`); let text over 8 KB reach a prompt; run a turn for a redelivered message.

## File table

| File | What it does / talks to |
| --- | --- |
| `host.ts` | The connector host: validate (B4 reject) → cap at 8 KB → `gateway_inbound` UNIQUE insert (duplicate = silent drop, survives restart) → route via the injected seam → echo the reply via `connector.send`. M6 part 4: the external message id rides into the route seam (the bridge reuses it as the chat idempotency token — belt and braces on top of the UNIQUE row). Send/route failures are logged, never thrown (C2). |
| `telegram/connector.ts` | grammY fence (A11). Long-polling `bot.start()`; raw updates validated with our own loose schema (`mapUpdate` — pure, unit-tested; B5 third-party: unknown keys stripped); `external_msg_id` = `<chat>:<message_id>` (message ids are only chat-unique). `health()`: ok / degraded (middleware or poll errors) / stopped. `send` returns `{ok:false}` instead of throwing. |
| `chat-bridge.ts` | The chat↔messenger bridge (M6 part 4, Rev 4 §13): `route` — inbound text becomes a normal Weltari Chat send to the reply target (the character of the newest outreach — you answer the text you received — else the first roster character), request_id = `tg:<external_msg_id>`; the resolved reply text goes back to the messenger; an in_scene target answers with the hardcoded presence note. `onDurableEvent` — subscribed to the LIVE bus only (a restart never re-pushes): `chat.outreach_recorded` → push `<Name>: <the SAME committed text>` (only CRON DMs are pushed, Rev 4 §13); `chat.thread_frozen` → push the hardcoded "<Name> is waiting for you to reply." (owner ruling 2026-07-10: Weltari Chat shows nothing). Subscription V1: messaging the bot once IS subscribing — pushes go to the connector chat that last talked to us. The M3 scene echo is retired: the gateway is a chat surface now. M7 part 2 (Rev 4 §13, criterion e): the FIRST-ever inbound from a (connector, messenger conversation) pair establishes the binding — `gateway.binding_established` + the hardcoded `GM_GATEWAY_WELCOME` line (a durable GM message in Weltari Chat, message_id keyed on the pair) commit in ONE transaction BEFORE the welcome pushes to the messenger, so a crashed push never re-fires the once-per-binding onboarding; the fold over the durable event makes it once-ever across restarts and redeliveries. Week 19 (audit item 2): the bridge roster folds LIVE per lookup (characterProfilesOf) — minted characters name and route without a restart. |
| `../storage/repositories/gateway.ts` | Sole SQL site for `gateway_inbound` (migration `0003_gateway.sql`): `recordInbound` — `ON CONFLICT DO NOTHING`, false = duplicate; `latestConversationId(connector)` — the V1 subscriber binding. |

## Events consumed/emitted

Consumed (live bus): `chat.outreach_recorded`, `chat.thread_frozen` (the push hooks). Emitted: `gateway.binding_established` + the GM welcome `chat.message_committed` (M7 part 2, once per binding); inbound lines flow through the normal chat engine (`chat.message_committed`, the same conversation_id as the thread).

## Tests

- Invariants (I10): `tests/invariants/gateway-inbound.test.ts` — duplicate exactly-once (incl. across restart), oversized capped at 8 KB, malformed rejected with zero side effects.
- Unit: `telegram/connector.test.ts` (mapUpdate: text/non-text/malformed/new-field fixtures), `storage/repositories/gateway.test.ts` (UNIQUE pair semantics), `chat-bridge.test.ts` (M6 part 4, criterion c: push text === thread text, hardcoded freeze notice, no-subscriber no-push, redelivery never twins the return line and the reply echoes exactly once).
- Conformance: the plugin-sdk suite runs against reference connectors; the Telegram connector's network-dependent lifecycle is exercised in the live spot check (owner token, env-only).
