// Sole SQL site for gateway_inbound (Brief §2.7). One method on purpose:
// exactly-once ingestion is a database fact (UNIQUE pair), not connector
// cooperation — recordInbound() returning false IS the B7 silent drop.
import type Database from 'better-sqlite3';

export interface NewInboundMessage {
  connector_id: string;
  external_msg_id: string;
  conversation_id: string;
  /** Already capped at 8 KB by the gateway host (B7). */
  text: string;
}

export interface GatewayRepository {
  /** True = first delivery; false = duplicate (silent drop, B7). */
  recordInbound(message: NewInboundMessage): boolean;
}

export function createGatewayRepository(
  db: Database.Database,
  nowIso: () => string,
): GatewayRepository {
  const insert = db.prepare(
    `INSERT INTO gateway_inbound
       (connector_id, external_msg_id, conversation_id, text, received_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(connector_id, external_msg_id) DO NOTHING`,
  );
  return {
    recordInbound(message: NewInboundMessage): boolean {
      const info = insert.run(
        message.connector_id,
        message.external_msg_id,
        message.conversation_id,
        message.text,
        nowIso(),
      );
      return info.changes === 1;
    },
  };
}
