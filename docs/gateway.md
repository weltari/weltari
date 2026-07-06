# gateway — apps/server/src/gateway

Purpose: messenger connectors behind the MIT `GatewayConnector` contract ([plugin-sdk.md](plugin-sdk.md)). NAT-first (Brief §7c): outbound long-polling only, no webhooks, no public endpoint. B7 is enforced by the HOST, never delegated to a connector.

## Contract

- Inputs: connector inbound callbacks (boundary data, B10); `TELEGRAM_BOT_TOKEN` (env-only secret; absent = connector stays stopped).
- Outputs: deduplicated inbound rows (`gateway_inbound`), one engine turn per first-delivery message, the committed transcript echoed back via `connector.send`.
- Never: trust a connector's payload shape (host re-validates with its own strict Zod via `validateAt('telegram', …)`); let text over 8 KB reach a prompt; run a turn for a redelivered message.

## File table

| File | What it does / talks to |
| --- | --- |
| `host.ts` | The connector host: validate (B4 reject) → cap at 8 KB → `gateway_inbound` UNIQUE insert (duplicate = silent drop, survives restart) → run one turn → echo transcript via `connector.send`. Send/turn failures are logged, never thrown (C2). |
| `telegram/connector.ts` | grammY fence (A11). Long-polling `bot.start()`; raw updates validated with our own loose schema (`mapUpdate` — pure, unit-tested; B5 third-party: unknown keys stripped); `external_msg_id` = `<chat>:<message_id>` (message ids are only chat-unique). `health()`: ok / degraded (middleware or poll errors) / stopped. `send` returns `{ok:false}` instead of throwing. |
| `../storage/repositories/gateway.ts` | Sole SQL site for `gateway_inbound` (migration `0003_gateway.sql`): `recordInbound` — `ON CONFLICT DO NOTHING`, false = duplicate. |

## Events consumed/emitted

None directly — inbound turns flow through the normal scene engine (`turn.started` / `turn.committed`, actor `gateway:telegram`).

## Tests

- Invariants (I10): `tests/invariants/gateway-inbound.test.ts` — duplicate exactly-once (incl. across restart), oversized capped at 8 KB, malformed rejected with zero side effects.
- Unit: `telegram/connector.test.ts` (mapUpdate: text/non-text/malformed/new-field fixtures), `storage/repositories/gateway.test.ts` (UNIQUE pair semantics).
- Conformance: the plugin-sdk suite runs against reference connectors; the Telegram connector's network-dependent lifecycle is exercised in the live spot check (owner token, env-only).
