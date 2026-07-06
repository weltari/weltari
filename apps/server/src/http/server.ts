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
  AdvanceTimeAcceptedSchema,
  AdvanceTimeCommandSchema,
  CommandRejectedSchema,
  EndSceneAcceptedSchema,
  EndSceneCommandSchema,
  OpenSceneAcceptedSchema,
  OpenSceneCommandSchema,
  PaintRegionAcceptedSchema,
  PaintRegionCommandSchema,
  PROTOCOL_VERSION,
  StartTurnAcceptedSchema,
  StartTurnCommandSchema,
  type AdvanceTimeAccepted,
  type AdvanceTimeCommand,
  type CommandRejected,
  type EndSceneAccepted,
  type EndSceneCommand,
  type OpenSceneAccepted,
  type OpenSceneCommand,
  type PaintRegionAccepted,
  type PaintRegionCommand,
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
  /** Scene lifecycle seams (Milestone 2): atomic fan-out + scoped open blocking. */
  endScene: (command: EndSceneCommand) => Result<{ jobsEnqueued: number }>;
  openScene: (command: OpenSceneCommand) => Result<{ opened: true }>;
  /** WorldClock seam: fictional time skip + world-cron replay (Brief §4). */
  advanceTime: (command: AdvanceTimeCommand) => Result<{
    worldTime: string;
    codeEnqueued: number;
    llmEnqueued: number;
    llmSkipped: number;
  }>;
  /** Painter seam: enqueue one region composite job (FINAL item 10). */
  paintRegion: (command: PaintRegionCommand) => Result<{ jobKey: string }>;
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

  app.post(
    '/v1/commands/end-scene',
    {
      schema: {
        body: EndSceneCommandSchema,
        response: { 202: EndSceneAcceptedSchema, 409: CommandRejectedSchema },
      },
    },
    (request, reply) => {
      const result = deps.endScene(request.body);
      if (!result.ok) {
        deps.logger.warn({ code: result.error.code }, 'end-scene rejected');
        reply.code(409);
        const rejected: CommandRejected = {
          accepted: false,
          error: result.error.code,
        };
        return rejected;
      }
      reply.code(202);
      const accepted: EndSceneAccepted = {
        accepted: true,
        jobs_enqueued: result.value.jobsEnqueued,
      };
      return accepted;
    },
  );

  app.post(
    '/v1/commands/open-scene',
    {
      schema: {
        body: OpenSceneCommandSchema,
        response: { 202: OpenSceneAcceptedSchema, 409: CommandRejectedSchema },
      },
    },
    (request, reply) => {
      const result = deps.openScene(request.body);
      if (!result.ok) {
        deps.logger.warn({ code: result.error.code }, 'open-scene rejected');
        reply.code(409);
        const rejected: CommandRejected = {
          accepted: false,
          error: result.error.code,
        };
        return rejected;
      }
      reply.code(202);
      const accepted: OpenSceneAccepted = { accepted: true };
      return accepted;
    },
  );

  app.post(
    '/v1/commands/advance-time',
    {
      schema: {
        body: AdvanceTimeCommandSchema,
        response: {
          202: AdvanceTimeAcceptedSchema,
          409: CommandRejectedSchema,
        },
      },
    },
    (request, reply) => {
      const result = deps.advanceTime(request.body);
      if (!result.ok) {
        deps.logger.warn({ code: result.error.code }, 'advance-time rejected');
        reply.code(409);
        const rejected: CommandRejected = {
          accepted: false,
          error: result.error.code,
        };
        return rejected;
      }
      reply.code(202);
      const accepted: AdvanceTimeAccepted = {
        accepted: true,
        world_time: result.value.worldTime,
        code_enqueued: result.value.codeEnqueued,
        llm_enqueued: result.value.llmEnqueued,
        llm_skipped: result.value.llmSkipped,
      };
      return accepted;
    },
  );

  app.post(
    '/v1/commands/paint-region',
    {
      schema: {
        body: PaintRegionCommandSchema,
        response: {
          202: PaintRegionAcceptedSchema,
          409: CommandRejectedSchema,
        },
      },
    },
    (request, reply) => {
      const result = deps.paintRegion(request.body);
      if (!result.ok) {
        deps.logger.warn({ code: result.error.code }, 'paint-region rejected');
        reply.code(409);
        const rejected: CommandRejected = {
          accepted: false,
          error: result.error.code,
        };
        return rejected;
      }
      reply.code(202);
      const accepted: PaintRegionAccepted = {
        accepted: true,
        job_key: result.value.jobKey,
      };
      return accepted;
    },
  );

  return app;
}
