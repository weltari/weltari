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
  /**
   * The newest inbound conversation id for a connector — the V1 subscriber
   * binding (M6 part 4, Rev 4 §13): messaging the bot once IS subscribing;
   * pushes go to the chat that last talked to us. Null = nobody connected.
   */
  latestConversationId(connectorId: string): string | null;
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
  const latest = db.prepare(
    `SELECT conversation_id FROM gateway_inbound
     WHERE connector_id = ? ORDER BY id DESC LIMIT 1`,
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
    latestConversationId(connectorId: string): string | null {
      const row: unknown = latest.get(connectorId);
      return row !== null &&
        typeof row === 'object' &&
        'conversation_id' in row &&
        typeof row.conversation_id === 'string'
        ? row.conversation_id
        : null;
    },
  };
}
