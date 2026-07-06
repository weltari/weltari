// The plugin SDK is the MIT edge package for plugin and connector authors
// (Brief §7e): it must never import from apps/* (license fence, Guide A12).

export {
  runGatewayConnectorConformance,
  type ConformanceResult,
} from './conformance.js';
export type {
  ConnectorHealth,
  GatewayConnector,
  InboundMessage,
  SendResult,
} from './gateway-connector.js';
