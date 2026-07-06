# plugin-sdk — @weltari/plugin-sdk (MIT edge package)

Purpose: the contract surface for plugin and connector authors (Brief §7e). MIT so no copyleft ever touches third-party code; never imports from `apps/*` (license fence A12). Created at the gateway milestone as the home for the `GatewayConnector` conformance suite (FINAL risk register #2: when a bridge library dies, the community rebuilds against this).

## Contract

- Inputs: none (leaf package).
- Outputs: `GatewayConnector` + message/health types; `runGatewayConnectorConformance()` (framework-free checks).
- Never: import from `apps/*` or depend on non-MIT-compatible packages; contain vendored third-party source.

## File table

| File | What it does / talks to |
| --- | --- |
| `src/gateway-connector.ts` | The connector contract: `start/stop/send/onInbound/health`, `InboundMessage`, `SendResult`; `paused` is an expected health state (Guide B8). The host re-validates, caps and dedups everything a connector delivers (B7/B10). |
| `src/conformance.ts` | `runGatewayConnectorConformance(factory)` — pure behavioral checks (lifecycle idempotence, health states, send-never-throws), runnable under any test runner. |
| `src/index.ts` | Public surface re-exports. |

## Tests

- `src/conformance.test.ts` — a reference in-memory connector passes every check; a throwing connector fails with the captured detail.
