-- gateway_inbound: exactly-once ingestion ledger for messenger updates (B7).
-- Messengers redeliver and attackers replay: the UNIQUE pair makes the second
-- insert a silent no-op, so one update can never open two turns.
CREATE TABLE gateway_inbound (
  id              INTEGER PRIMARY KEY,
  connector_id    TEXT NOT NULL,     -- e.g. 'telegram' (GatewayConnector.id)
  external_msg_id TEXT NOT NULL,     -- platform message id (chat-scoped ids get the chat prefix)
  conversation_id TEXT NOT NULL,     -- same id in-app chat will use (Brief §3)
  text            TEXT NOT NULL,     -- already capped at 8 KB by the host (B7)
  received_at     TEXT NOT NULL,     -- wall-clock ISO
  UNIQUE (connector_id, external_msg_id)
);
