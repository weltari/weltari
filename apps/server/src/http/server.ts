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
  ApplyUpdateAcceptedSchema,
  ApplyUpdateCommandSchema,
  CommandRejectedSchema,
  EndSceneAcceptedSchema,
  EndSceneCommandSchema,
  ExitChatAcceptedSchema,
  ExitChatCommandSchema,
  ExploreAcceptedSchema,
  ExploreCommandSchema,
  FeedReplyAcceptedSchema,
  FeedReplyCommandSchema,
  InterruptTurnAcceptedSchema,
  InterruptTurnCommandSchema,
  MapClickAcceptedSchema,
  MapClickCommandSchema,
  MapEditAcceptedSchema,
  MapEditCommandSchema,
  MarkerClickAcceptedSchema,
  MarkerClickCommandSchema,
  OpenSceneAcceptedSchema,
  OpenSceneCommandSchema,
  PaintRegionAcceptedSchema,
  PaintRegionCommandSchema,
  PluginListSchema,
  PROTOCOL_VERSION,
  SendChatMessageAcceptedSchema,
  SendGroupMessageAcceptedSchema,
  SendGroupMessageCommandSchema,
  StartGroupChatAcceptedSchema,
  StartGroupChatCommandSchema,
  ExitGroupChatAcceptedSchema,
  ExitGroupChatCommandSchema,
  SendChatMessageCommandSchema,
  StartSceneFromChatAcceptedSchema,
  StartSceneFromChatCommandSchema,
  StartTurnAcceptedSchema,
  StartTurnCommandSchema,
  DeleteProfileAcceptedSchema,
  DeleteProfileCommandSchema,
  DiscussProposalAcceptedSchema,
  DiscussProposalCommandSchema,
  ResolveProposalAcceptedSchema,
  ResolveProposalCommandSchema,
  SetCharacterLockAcceptedSchema,
  SetCharacterLockCommandSchema,
  SetConfigFlagAcceptedSchema,
  SetConfigFlagCommandSchema,
  SubwikiEditAcceptedSchema,
  SubwikiEditCommandSchema,
  UserProfileViewSchema,
  type AdvanceTimeAccepted,
  type AdvanceTimeCommand,
  type ApplyUpdateAccepted,
  type ApplyUpdateCommand,
  type CommandRejected,
  type EndSceneAccepted,
  type EndSceneCommand,
  type ExitChatAccepted,
  type ExitChatCommand,
  type ExploreAccepted,
  type ExploreCommand,
  type FeedReplyAccepted,
  type FeedReplyCommand,
  type InterruptTurnAccepted,
  type InterruptTurnCommand,
  type MapClickAccepted,
  type MapClickCommand,
  type MapEditAccepted,
  type MapEditCommand,
  type MarkerClickAccepted,
  type MarkerClickCommand,
  type OpenSceneAccepted,
  type OpenSceneCommand,
  type PaintRegionAccepted,
  type PaintRegionCommand,
  type PluginInfo,
  type PluginList,
  type SendChatMessageAccepted,
  type SendGroupMessageAccepted,
  type SendGroupMessageCommand,
  type StartGroupChatAccepted,
  type StartGroupChatCommand,
  type ExitGroupChatAccepted,
  type ExitGroupChatCommand,
  type SendChatMessageCommand,
  type StartSceneFromChatAccepted,
  type StartSceneFromChatCommand,
  type StartTurnCommand,
  type DeleteProfileAccepted,
  type DeleteProfileCommand,
  type DiscussProposalAccepted,
  type DiscussProposalCommand,
  type ResolveProposalAccepted,
  type ResolveProposalCommand,
  type SetCharacterLockAccepted,
  type SetCharacterLockCommand,
  type SetConfigFlagAccepted,
  type SetConfigFlagCommand,
  type SubwikiEditAccepted,
  type SubwikiEditCommand,
  type UserProfileView,
} from '@weltari/protocol';
import { createReadStream } from 'node:fs';
import { z } from 'zod';
import type { Result } from '../errors.js';
import type { Logger } from '../observability/logger.js';
import type { EventLogRepository } from '../storage/repositories/event-log.js';
import type { DevBus, EventBus, StreamBus } from './bus.js';
import { attachSseClient } from './sse.js';
import type { StaticResolver } from './static.js';

export interface HttpDeps {
  eventLog: EventLogRepository;
  eventBus: EventBus;
  streamBus: StreamBus;
  devBus: DevBus;
  logger: Logger;
  /** The scene engine seam: opens the turn envelope durably before returning. */
  startTurn: (command: StartTurnCommand) => Promise<Result<{ turnId: string }>>;
  /** Interrupt-anywhere: closes the envelope at the user's last-seen sentence. */
  interruptTurn: (
    command: InterruptTurnCommand,
  ) => Result<{ committed: boolean }>;
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
  /** Explore seam (UI Spec §1.8): enqueue one materialize job per fog square —
   * idempotent; 409 when the square is occupied or the world unknown. */
  explore: (command: ExploreCommand) => Result<{ jobKey: string }>;
  /** Flow-A seam (Rev 4 §14, M5 part 2): durable map_edit.requested + one
   * map_edit job — idempotent per request_id; 409 when the world is unknown
   * or the drawn centroid lies on unexplored fog. */
  mapEdit: (
    command: MapEditCommand,
  ) => Result<{ jobKey: string; editId: string }>;
  /** Flow-B seam (Rev 4 §14, M5 part 2): radius check answers `enter`
   * directly (zero model calls); outside all radii one map_click job —
   * idempotent per request_id; 409 on unknown world / unexplored fog. */
  mapClick: (
    command: MapClickCommand,
  ) => Result<
    | { outcome: 'enter'; clickId: string; sublocationId: string; name: string }
    | { outcome: 'classify'; clickId: string; jobKey: string }
  >;
  /** The marker-click seam (M7 part 4, Rev 4 §14/§17): first click wins into
   * exactly one scene, a racing second click joins it; an expired-but-
   * unswept marker's click 409s `marker_expired` and settles the marker. */
  markerClick: (command: MarkerClickCommand) => Promise<
    Result<{
      outcome: 'instantiated' | 'join';
      marker_id: string;
      scene_id: string;
      sublocation_id: string;
    }>
  >;
  /** Updater seam (FINAL item 12): enqueue the update_apply job — 409 when
   * updates are disabled (no verification key / Docker notify-only mode). */
  applyUpdate: (command: ApplyUpdateCommand) => Result<{ jobKey: string }>;
  /** Weltari Chat seams (M6 part 2, Rev 4 §8): the user line commits at the
   * seam; the reply generates detached and arrives as an event. exit-chat
   * closes the range + enqueues its ONE reflect_chat job atomically. */
  sendChatMessage: (command: SendChatMessageCommand) => Result<{
    conversationId: string;
    messageId: string;
    replying: boolean;
    presence: 'available' | 'in_scene';
  }>;
  exitChat: (
    command: ExitChatCommand,
  ) => Result<{ conversationId: string; ended: boolean; jobKey?: string }>;
  /** The feed-reply seam (M6 part 5, Rev 4 §12): the user's reply to a feed
   * comment commits at the seam; the comment author's answer generates
   * detached and arrives as social.reply_answered. */
  feedReply: (command: FeedReplyCommand) => Result<{ replyId: string }>;
  /** The manual wiki edit seam (M6 part 5, owner ruling 2026-07-11): applies
   * immediately — subwiki.edited with USER actor provenance. */
  subwikiEdit: (
    command: SubwikiEditCommand,
  ) => Result<{ sublocationId: string }>;
  /** The Proposal pipeline (M7 part 2, Rev 4 §16): the approver's decision —
   * approve applies the diff atomically with proposal.resolved; reject
   * writes the resolved event alone (zero domain rows, I8). */
  resolveProposal: (
    command: ResolveProposalCommand,
  ) => Promise<Result<{ applied: number }>>;
  /** The chat-about-this signal (0.20.0, the UX contract): durable
   * proposal.discussed + the GM's acknowledgement turn; the card stays
   * pending and resolvable. */
  discussProposal: (
    command: DiscussProposalCommand,
  ) => Result<{ proposalId: string }>;
  /** World flags as latest-wins folds (M7 part 2, Rev 4 §15). */
  setConfigFlag: (
    command: SetConfigFlagCommand,
  ) => Result<{ flag: string; value: boolean }>;
  /** The GDPR erasure right (M7 part 2, Rev 4 §9 guardrails). */
  deleteProfile: (command: DeleteProfileCommand) => Result<{ removed: number }>;
  /** The user-facing evolution lock (M7 part 2, Rev 4 §7). */
  setCharacterLock: (
    command: SetCharacterLockCommand,
  ) => Result<{ characterId: string; locked: boolean }>;
  /** The user's own view of the profiling store (view + export). */
  profileView: (worldId: string, actorId: string) => UserProfileView;
  /** The startscene() bridge (Rev 4 §8): ends the chat range, opens a real
   * scene with the character; unresolved places ride scene.started. Async
   * since M6 part 3 — the bridge ends a still-open scene first and may wait
   * out its fan-out (the one-active-scene transition). */
  startSceneFromChat: (
    command: StartSceneFromChatCommand,
  ) => Promise<Result<{ sceneId: string; sublocationId?: string }>>;
  /** Group-chat seams (M6 part 4, Rev 4 §8): user-started only; the router
   * round runs detached under the engine-enforced turn budget; exit closes
   * the range + enqueues one reflect_chat per member atomically. */
  startGroupChat: (
    command: StartGroupChatCommand,
  ) => Result<{ conversationId: string }>;
  sendGroupMessage: (command: SendGroupMessageCommand) => Result<{
    conversationId: string;
    messageId: string;
    routing: boolean;
  }>;
  exitGroupChat: (
    command: ExitGroupChatCommand,
  ) => Result<{ conversationId: string; ended: boolean; jobsEnqueued: number }>;
  /**
   * Read-only painter-output serving (GET /v1/images/*): resolves a path
   * RELATIVE to the images dir, contained to it; null = 404. The event
   * (painter.completed), not the file, is the truth about which image is
   * current — this route only hands out pixels the events already named.
   */
  resolveImage?: (
    relativePath: string,
  ) => { file: string; contentType: string } | null;
  /** Loaded plugins (GET /v1/plugins) — provenance shown in dev mode (B10). */
  plugins?: PluginInfo[];
  /** Serves zero-build plugin assets; null = 404 (refused plugins are invisible). */
  resolvePluginAsset?: (
    pluginName: string,
    relativePath: string,
  ) => { file: string; contentType: string } | null;
  /** The built frontend (FINAL item 2): SPA files with index.html fallback;
   * null = 404 (no dist built — dev runs the Vite server instead). */
  resolveStatic?: StaticResolver;
  heartbeatMs?: number;
  /** Running app version, echoed in the SSE hello (0.8.0 — splash footer). */
  appVersion?: string;
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
        ...(deps.appVersion === undefined
          ? {}
          : { appVersion: deps.appVersion }),
      });
    },
  );

  app.get(
    '/v1/plugins',
    { schema: { response: { 200: PluginListSchema } } },
    (_request, reply) => {
      reply.code(200);
      const list: PluginList = { plugins: deps.plugins ?? [] };
      return list;
    },
  );

  // Zero-build plugin assets (FINAL item 13): /plugins/<name>/<path…>.
  // Refused plugins never resolve; the resolver contains paths to the folder.
  const assetParamsSchema = z.object({
    name: z.string().min(1),
    '*': z.string().min(1),
  });
  app.get(
    '/plugins/:name/*',
    { schema: { params: assetParamsSchema } },
    (request, reply) => {
      const resolver = deps.resolvePluginAsset;
      const asset =
        resolver?.(request.params.name, request.params['*']) ?? null;
      if (asset === null) {
        return reply.code(404).send({ accepted: false, error: 'not_found' });
      }
      reply.header('content-type', asset.contentType);
      return reply.send(createReadStream(asset.file));
    },
  );

  // Tile/backdrop pixels for clients and the <wl-map> plugin (FINAL item 6).
  const imageParamsSchema = z.object({ '*': z.string().min(1) });
  app.get(
    '/v1/images/*',
    { schema: { params: imageParamsSchema } },
    (request, reply) => {
      const asset = deps.resolveImage?.(request.params['*']) ?? null;
      if (asset === null) {
        return reply.code(404).send({ accepted: false, error: 'not_found' });
      }
      reply.header('content-type', asset.contentType);
      return reply.send(createReadStream(asset.file));
    },
  );

  // The built frontend (FINAL item 2), registered as the lowest-priority
  // wildcard: every explicit route above wins first. API namespaces never
  // fall through to the SPA — a typo'd command path must fail loudly as
  // JSON, not ship index.html.
  const staticParamsSchema = z.object({ '*': z.string() });
  app.get(
    '/*',
    { schema: { params: staticParamsSchema } },
    (request, reply) => {
      const urlPath = request.params['*'];
      if (urlPath === 'v1' || urlPath.startsWith('v1/')) {
        return reply.code(404).send({ accepted: false, error: 'not_found' });
      }
      if (urlPath === 'plugins' || urlPath.startsWith('plugins/')) {
        return reply.code(404).send({ accepted: false, error: 'not_found' });
      }
      const asset = deps.resolveStatic?.(urlPath) ?? null;
      if (asset === null) {
        return reply.code(404).send({ accepted: false, error: 'not_found' });
      }
      reply.header('content-type', asset.contentType);
      if (asset.cacheControl !== undefined) {
        reply.header('cache-control', asset.cacheControl);
      }
      return reply.send(createReadStream(asset.file));
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
    '/v1/commands/interrupt-turn',
    {
      schema: {
        body: InterruptTurnCommandSchema,
        response: {
          202: InterruptTurnAcceptedSchema,
          409: CommandRejectedSchema,
        },
      },
    },
    (request, reply) => {
      const result = deps.interruptTurn(request.body);
      if (!result.ok) {
        deps.logger.warn(
          { code: result.error.code },
          'interrupt-turn rejected',
        );
        reply.code(409);
        const rejected: CommandRejected = {
          accepted: false,
          error: result.error.code,
        };
        return rejected;
      }
      reply.code(202);
      const accepted: InterruptTurnAccepted = {
        accepted: true,
        committed: result.value.committed,
      };
      return accepted;
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

  app.post(
    '/v1/commands/explore',
    {
      schema: {
        body: ExploreCommandSchema,
        response: {
          202: ExploreAcceptedSchema,
          409: CommandRejectedSchema,
        },
      },
    },
    (request, reply) => {
      const result = deps.explore(request.body);
      if (!result.ok) {
        deps.logger.warn({ code: result.error.code }, 'explore rejected');
        reply.code(409);
        const rejected: CommandRejected = {
          accepted: false,
          error: result.error.code,
        };
        return rejected;
      }
      reply.code(202);
      const accepted: ExploreAccepted = {
        accepted: true,
        job_key: result.value.jobKey,
      };
      return accepted;
    },
  );

  app.post(
    '/v1/commands/map-edit',
    {
      schema: {
        body: MapEditCommandSchema,
        response: {
          202: MapEditAcceptedSchema,
          409: CommandRejectedSchema,
        },
      },
    },
    (request, reply) => {
      const result = deps.mapEdit(request.body);
      if (!result.ok) {
        deps.logger.warn({ code: result.error.code }, 'map-edit rejected');
        reply.code(409);
        const rejected: CommandRejected = {
          accepted: false,
          error: result.error.code,
        };
        return rejected;
      }
      reply.code(202);
      const accepted: MapEditAccepted = {
        accepted: true,
        job_key: result.value.jobKey,
        edit_id: result.value.editId,
      };
      return accepted;
    },
  );

  app.post(
    '/v1/commands/map-click',
    {
      schema: {
        body: MapClickCommandSchema,
        response: {
          202: MapClickAcceptedSchema,
          409: CommandRejectedSchema,
        },
      },
    },
    (request, reply) => {
      const result = deps.mapClick(request.body);
      if (!result.ok) {
        deps.logger.warn({ code: result.error.code }, 'map-click rejected');
        reply.code(409);
        const rejected: CommandRejected = {
          accepted: false,
          error: result.error.code,
        };
        return rejected;
      }
      reply.code(202);
      const accepted: MapClickAccepted =
        result.value.outcome === 'enter'
          ? {
              accepted: true,
              outcome: 'enter',
              click_id: result.value.clickId,
              sublocation_id: result.value.sublocationId,
              name: result.value.name,
            }
          : {
              accepted: true,
              outcome: 'classify',
              click_id: result.value.clickId,
              job_key: result.value.jobKey,
            };
      return accepted;
    },
  );

  app.post(
    '/v1/commands/marker-click',
    {
      schema: {
        body: MarkerClickCommandSchema,
        response: {
          202: MarkerClickAcceptedSchema,
          409: CommandRejectedSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await deps.markerClick(request.body);
      if (!result.ok) {
        deps.logger.warn({ code: result.error.code }, 'marker-click rejected');
        reply.code(409);
        const rejected: CommandRejected = {
          accepted: false,
          error: result.error.code,
        };
        return rejected;
      }
      reply.code(202);
      const accepted: MarkerClickAccepted = {
        accepted: true,
        outcome: result.value.outcome,
        marker_id: result.value.marker_id,
        scene_id: result.value.scene_id,
        sublocation_id: result.value.sublocation_id,
      };
      return accepted;
    },
  );

  app.post(
    '/v1/commands/send-chat-message',
    {
      schema: {
        body: SendChatMessageCommandSchema,
        response: {
          202: SendChatMessageAcceptedSchema,
          409: CommandRejectedSchema,
        },
      },
    },
    (request, reply) => {
      const result = deps.sendChatMessage(request.body);
      if (!result.ok) {
        deps.logger.warn(
          { code: result.error.code },
          'send-chat-message rejected',
        );
        reply.code(409);
        const rejected: CommandRejected = {
          accepted: false,
          error: result.error.code,
        };
        return rejected;
      }
      reply.code(202);
      const accepted: SendChatMessageAccepted = {
        accepted: true,
        conversation_id: result.value.conversationId,
        message_id: result.value.messageId,
        replying: result.value.replying,
        presence: result.value.presence,
      };
      return accepted;
    },
  );

  app.post(
    '/v1/commands/feed-reply',
    {
      schema: {
        body: FeedReplyCommandSchema,
        response: {
          202: FeedReplyAcceptedSchema,
          409: CommandRejectedSchema,
        },
      },
    },
    (request, reply) => {
      const result = deps.feedReply(request.body);
      if (!result.ok) {
        deps.logger.warn({ code: result.error.code }, 'feed-reply rejected');
        reply.code(409);
        const rejected: CommandRejected = {
          accepted: false,
          error: result.error.code,
        };
        return rejected;
      }
      reply.code(202);
      const accepted: FeedReplyAccepted = {
        accepted: true,
        reply_id: result.value.replyId,
      };
      return accepted;
    },
  );

  app.post(
    '/v1/commands/subwiki-edit',
    {
      schema: {
        body: SubwikiEditCommandSchema,
        response: {
          202: SubwikiEditAcceptedSchema,
          409: CommandRejectedSchema,
        },
      },
    },
    (request, reply) => {
      const result = deps.subwikiEdit(request.body);
      if (!result.ok) {
        deps.logger.warn({ code: result.error.code }, 'subwiki-edit rejected');
        reply.code(409);
        const rejected: CommandRejected = {
          accepted: false,
          error: result.error.code,
        };
        return rejected;
      }
      reply.code(202);
      const accepted: SubwikiEditAccepted = {
        accepted: true,
        sublocation_id: result.value.sublocationId,
      };
      return accepted;
    },
  );

  app.post(
    '/v1/commands/resolve-proposal',
    {
      schema: {
        body: ResolveProposalCommandSchema,
        response: {
          202: ResolveProposalAcceptedSchema,
          409: CommandRejectedSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await deps.resolveProposal(request.body);
      if (!result.ok) {
        deps.logger.warn(
          { code: result.error.code },
          'resolve-proposal rejected',
        );
        reply.code(409);
        const rejected: CommandRejected = {
          accepted: false,
          error: result.error.code,
        };
        return rejected;
      }
      reply.code(202);
      const accepted: ResolveProposalAccepted = {
        accepted: true,
        proposal_id: request.body.proposal_id,
        resolution: request.body.resolution,
        applied: result.value.applied,
      };
      return accepted;
    },
  );

  app.post(
    '/v1/commands/discuss-proposal',
    {
      schema: {
        body: DiscussProposalCommandSchema,
        response: {
          202: DiscussProposalAcceptedSchema,
          409: CommandRejectedSchema,
        },
      },
    },
    (request, reply) => {
      const result = deps.discussProposal(request.body);
      if (!result.ok) {
        deps.logger.warn(
          { code: result.error.code },
          'discuss-proposal rejected',
        );
        reply.code(409);
        const rejected: CommandRejected = {
          accepted: false,
          error: result.error.code,
        };
        return rejected;
      }
      reply.code(202);
      const accepted: DiscussProposalAccepted = {
        accepted: true,
        proposal_id: result.value.proposalId,
      };
      return accepted;
    },
  );

  app.post(
    '/v1/commands/set-config-flag',
    {
      schema: {
        body: SetConfigFlagCommandSchema,
        response: {
          202: SetConfigFlagAcceptedSchema,
          409: CommandRejectedSchema,
        },
      },
    },
    (request, reply) => {
      const result = deps.setConfigFlag(request.body);
      if (!result.ok) {
        deps.logger.warn(
          { code: result.error.code },
          'set-config-flag rejected',
        );
        reply.code(409);
        const rejected: CommandRejected = {
          accepted: false,
          error: result.error.code,
        };
        return rejected;
      }
      reply.code(202);
      const accepted: SetConfigFlagAccepted = {
        accepted: true,
        flag: request.body.flag,
        value: request.body.value,
      };
      return accepted;
    },
  );

  app.post(
    '/v1/commands/set-character-lock',
    {
      schema: {
        body: SetCharacterLockCommandSchema,
        response: {
          202: SetCharacterLockAcceptedSchema,
          409: CommandRejectedSchema,
        },
      },
    },
    (request, reply) => {
      const result = deps.setCharacterLock(request.body);
      if (!result.ok) {
        deps.logger.warn(
          { code: result.error.code },
          'set-character-lock rejected',
        );
        reply.code(409);
        const rejected: CommandRejected = {
          accepted: false,
          error: result.error.code,
        };
        return rejected;
      }
      reply.code(202);
      const accepted: SetCharacterLockAccepted = {
        accepted: true,
        character_id: result.value.characterId,
        locked: result.value.locked,
      };
      return accepted;
    },
  );

  app.post(
    '/v1/commands/delete-profile',
    {
      schema: {
        body: DeleteProfileCommandSchema,
        response: {
          202: DeleteProfileAcceptedSchema,
          409: CommandRejectedSchema,
        },
      },
    },
    (request, reply) => {
      const result = deps.deleteProfile(request.body);
      if (!result.ok) {
        deps.logger.warn(
          { code: result.error.code },
          'delete-profile rejected',
        );
        reply.code(409);
        const rejected: CommandRejected = {
          accepted: false,
          error: result.error.code,
        };
        return rejected;
      }
      reply.code(202);
      const accepted: DeleteProfileAccepted = {
        accepted: true,
        removed: result.value.removed,
      };
      return accepted;
    },
  );

  // The profiling store's view + export (M7 part 2, Rev 4 §9 guardrails):
  // the hypotheses travel ONLY over this surface — never the event stream.
  const profileQuerySchema = z.object({
    world_id: z.string().min(1),
    actor_id: z.string().min(1),
  });
  app.get(
    '/v1/profile',
    {
      schema: {
        querystring: profileQuerySchema,
        response: { 200: UserProfileViewSchema },
      },
    },
    (request, reply) => {
      reply.code(200);
      const view: UserProfileView = deps.profileView(
        request.query.world_id,
        request.query.actor_id,
      );
      return view;
    },
  );
  app.get(
    '/v1/profile/export',
    {
      schema: {
        querystring: profileQuerySchema,
        response: { 200: UserProfileViewSchema },
      },
    },
    (request, reply) => {
      reply.code(200);
      reply.header(
        'content-disposition',
        'attachment; filename="weltari-profile.json"',
      );
      const view: UserProfileView = deps.profileView(
        request.query.world_id,
        request.query.actor_id,
      );
      return view;
    },
  );

  app.post(
    '/v1/commands/exit-chat',
    {
      schema: {
        body: ExitChatCommandSchema,
        response: {
          202: ExitChatAcceptedSchema,
          409: CommandRejectedSchema,
        },
      },
    },
    (request, reply) => {
      const result = deps.exitChat(request.body);
      if (!result.ok) {
        deps.logger.warn({ code: result.error.code }, 'exit-chat rejected');
        reply.code(409);
        const rejected: CommandRejected = {
          accepted: false,
          error: result.error.code,
        };
        return rejected;
      }
      reply.code(202);
      const accepted: ExitChatAccepted = {
        accepted: true,
        conversation_id: result.value.conversationId,
        ended: result.value.ended,
        ...(result.value.jobKey === undefined
          ? {}
          : { job_key: result.value.jobKey }),
      };
      return accepted;
    },
  );

  app.post(
    '/v1/commands/start-scene-from-chat',
    {
      schema: {
        body: StartSceneFromChatCommandSchema,
        response: {
          202: StartSceneFromChatAcceptedSchema,
          409: CommandRejectedSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await deps.startSceneFromChat(request.body);
      if (!result.ok) {
        deps.logger.warn(
          { code: result.error.code },
          'start-scene-from-chat rejected',
        );
        reply.code(409);
        const rejected: CommandRejected = {
          accepted: false,
          error: result.error.code,
        };
        return rejected;
      }
      reply.code(202);
      const accepted: StartSceneFromChatAccepted = {
        accepted: true,
        scene_id: result.value.sceneId,
        ...(result.value.sublocationId === undefined
          ? {}
          : { sublocation_id: result.value.sublocationId }),
      };
      return accepted;
    },
  );

  app.post(
    '/v1/commands/start-group-chat',
    {
      schema: {
        body: StartGroupChatCommandSchema,
        response: {
          202: StartGroupChatAcceptedSchema,
          409: CommandRejectedSchema,
        },
      },
    },
    (request, reply) => {
      const result = deps.startGroupChat(request.body);
      if (!result.ok) {
        deps.logger.warn(
          { code: result.error.code },
          'start-group-chat rejected',
        );
        reply.code(409);
        const rejected: CommandRejected = {
          accepted: false,
          error: result.error.code,
        };
        return rejected;
      }
      reply.code(202);
      const accepted: StartGroupChatAccepted = {
        accepted: true,
        conversation_id: result.value.conversationId,
      };
      return accepted;
    },
  );

  app.post(
    '/v1/commands/send-group-message',
    {
      schema: {
        body: SendGroupMessageCommandSchema,
        response: {
          202: SendGroupMessageAcceptedSchema,
          409: CommandRejectedSchema,
        },
      },
    },
    (request, reply) => {
      const result = deps.sendGroupMessage(request.body);
      if (!result.ok) {
        deps.logger.warn(
          { code: result.error.code },
          'send-group-message rejected',
        );
        reply.code(409);
        const rejected: CommandRejected = {
          accepted: false,
          error: result.error.code,
        };
        return rejected;
      }
      reply.code(202);
      const accepted: SendGroupMessageAccepted = {
        accepted: true,
        conversation_id: result.value.conversationId,
        message_id: result.value.messageId,
        routing: result.value.routing,
      };
      return accepted;
    },
  );

  app.post(
    '/v1/commands/exit-group-chat',
    {
      schema: {
        body: ExitGroupChatCommandSchema,
        response: {
          202: ExitGroupChatAcceptedSchema,
          409: CommandRejectedSchema,
        },
      },
    },
    (request, reply) => {
      const result = deps.exitGroupChat(request.body);
      if (!result.ok) {
        deps.logger.warn(
          { code: result.error.code },
          'exit-group-chat rejected',
        );
        reply.code(409);
        const rejected: CommandRejected = {
          accepted: false,
          error: result.error.code,
        };
        return rejected;
      }
      reply.code(202);
      const accepted: ExitGroupChatAccepted = {
        accepted: true,
        conversation_id: result.value.conversationId,
        ended: result.value.ended,
        jobs_enqueued: result.value.jobsEnqueued,
      };
      return accepted;
    },
  );

  app.post(
    '/v1/commands/apply-update',
    {
      schema: {
        body: ApplyUpdateCommandSchema,
        response: {
          202: ApplyUpdateAcceptedSchema,
          409: CommandRejectedSchema,
        },
      },
    },
    (request, reply) => {
      const result = deps.applyUpdate(request.body);
      if (!result.ok) {
        deps.logger.warn({ code: result.error.code }, 'apply-update rejected');
        reply.code(409);
        const rejected: CommandRejected = {
          accepted: false,
          error: result.error.code,
        };
        return rejected;
      }
      reply.code(202);
      const accepted: ApplyUpdateAccepted = {
        accepted: true,
        job_key: result.value.jobKey,
      };
      return accepted;
    },
  );

  return app;
}
