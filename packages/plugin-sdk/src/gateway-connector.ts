// The GatewayConnector contract (FINAL item 11): every messenger bridge —
// bundled Telegram, experimental WeChat, community plugins — implements this
// and nothing else. MIT-licensed on purpose (Brief §7e): connector authors
// must never fear copyleft, and when a bridge library dies the community can
// replace it against this interface plus the conformance suite.

/**
 * `paused` is an EXPECTED state, not an error (Guide B8): e.g. WeChat's 24h
 * pause. A paused connector must not retry-storm and must recover on fresh
 * inbound traffic.
 */
export type ConnectorHealth = 'ok' | 'degraded' | 'paused' | 'stopped';

/**
 * One inbound message, already mapped from the platform's raw update by the
 * connector. The HOST still treats this as boundary data: it re-validates,
 * length-caps and deduplicates before anything touches a mailbox (Guide B7) —
 * a connector cannot corrupt the engine by lying here.
 */
export interface InboundMessage {
  /** Platform-unique id used for exactly-once ingestion (messengers redeliver). */
  external_msg_id: string;
  /** Chat/channel id — becomes the engine-side conversation_id. */
  conversation_id: string;
  text: string;
}

export interface SendResult {
  ok: boolean;
  /** Machine-readable reason when ok is false (e.g. 'paused', 'network'). */
  error?: string;
}

export interface GatewayConnector {
  /** Stable id, e.g. 'telegram' — part of the dedup key on the host side. */
  readonly id: string;
  /** Idempotent; resolves once inbound delivery can begin (long-polling started). */
  start(): Promise<void>;
  /** Idempotent; after resolve, no further inbound callbacks may fire. */
  stop(): Promise<void>;
  /** Never throws for delivery failures — returns { ok: false, error } (paused, network…). */
  send(conversationId: string, text: string): Promise<SendResult>;
  /** Registers the single inbound listener; call before start(). */
  onInbound(listener: (message: InboundMessage) => void): void;
  health(): ConnectorHealth;
}
