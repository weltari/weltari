// Fastify 5 + fastify-type-provider-zod: route validation and the trust
// boundary are the same mechanism (Guide B9). One Zod schema per route, all
// defined in @weltari/protocol.
import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import {
  CommandRejectedSchema,
  PROTOCOL_VERSION,
  StartTurnAcceptedSchema,
  StartTurnCommandSchema,
  type StartTurnCommand,
} from '@weltari/protocol';
import { z } from 'zod';
import type { Result } from '../errors.js';
import type { Logger } from '../observability/logger.js';
import type { EventLogRepository } from '../storage/repositories/event-log.js';
import type { DevBus, EventBus, StreamBus } from './bus.js';
import { attachSseClient } from './sse.js';

export interface HttpDeps {
  eventLog: EventLogRepository;
  eventBus: EventBus;
  streamBus: StreamBus;
  devBus: DevBus;
  logger: Logger;
  /** The scene engine seam: opens the turn envelope durably before returning. */
  startTurn: (command: StartTurnCommand) => Promise<Result<{ turnId: string }>>;
  heartbeatMs?: number;
}

const sseQuerySchema = z.object({
  /** curl-friendly alternative to the Last-Event-ID header. */
  last_event_id: z.coerce.number().int().nonnegative().optional(),
  /** '1' opts this client into the dev channel (log-only trail, UI Spec §2.8). */
  dev: z.string().optional(),
});

export function createHttpServer(deps: HttpDeps): FastifyInstance {
  const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.get(
    '/v1/events',
    { schema: { querystring: sseQuerySchema } },
    (request, reply) => {
      const headerValue = request.headers['last-event-id'];
      const headerId =
        typeof headerValue === 'string' && /^\d+$/.test(headerValue)
          ? Number(headerValue)
          : undefined;
      const lastEventId = headerId ?? request.query.last_event_id ?? 0;
      reply.hijack();
      attachSseClient(reply.raw, lastEventId, {
        eventLog: deps.eventLog,
        eventBus: deps.eventBus,
        streamBus: deps.streamBus,
        devBus: deps.devBus,
        devChannel: request.query.dev === '1',
        protocolVersion: PROTOCOL_VERSION,
        ...(deps.heartbeatMs === undefined
          ? {}
          : { heartbeatMs: deps.heartbeatMs }),
      });
    },
  );

  app.post(
    '/v1/commands/start-turn',
    {
      schema: {
        body: StartTurnCommandSchema,
        response: { 202: StartTurnAcceptedSchema, 409: CommandRejectedSchema },
      },
    },
    async (request, reply) => {
      const result = await deps.startTurn(request.body);
      if (!result.ok) {
        deps.logger.warn({ code: result.error.code }, 'start-turn rejected');
        return reply
          .code(409)
          .send({ accepted: false, error: result.error.code });
      }
      return reply
        .code(202)
        .send({ accepted: true, turn_id: result.value.turnId });
    },
  );

  return app;
}
