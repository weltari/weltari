// Composition root. Startup IS recovery (Brief §2.4): open storage (runs
// migrations; the runner's first tick sweeps expired leases), seed the fixture
// world if the log is empty, start HTTP + runner loops.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { ApplyUpdateCommand, StartTurnCommand } from '@weltari/protocol';
import { readAppVersion } from './boundary/config/app-version.js';
import { readEnvOrExplain } from './boundary/config/env.js';
import { createPluginAssetResolver } from './boundary/plugins/assets.js';
import { loadPlugins } from './boundary/plugins/loader.js';
import { cleanStaleStaging, type FetchLike } from './boundary/update/stage.js';
import { normalizeVersion } from './boundary/update/version.js';
import { err, ok, OperationalError, type Result } from './errors.js';
import { createEventSink, type EventSink } from './engine/event-sink.js';
import type { FaultPointHook } from './engine/fault-points.js';
import {
  buildEliasProfile,
  buildMaraProfile,
  buildNarratorProfile,
  FIXTURE_SUBLOCATIONS,
  FIXTURE_WORLD_CRON,
  FIXTURE_WORLD_ID,
} from './engine/fixture/rainy-inn.js';
import { createChatEngine } from './engine/chat.js';
import { enqueueCachePruneIfDue } from './engine/cache.js';
import { enqueueCompactionIfDue } from './engine/memory.js';
import { createExploreCommand } from './engine/explore.js';
import { createMapClickCommand } from './engine/map-click.js';
import { createMapEditCommand } from './engine/map-edit.js';
import {
  createInvitationExpiry,
  pendingInvitationWorlds,
} from './engine/invitation.js';
import { OUTREACH_FREEZE_CAP } from './engine/outreach.js';
import { SOCIAL_POST_SKIP_CAP } from './engine/social.js';
import { createSceneLifecycle } from './engine/scene-lifecycle.js';
import { squareOf } from './engine/sublocations.js';
import { createTurnEngine } from './engine/scene-turn.js';
import { createWorldClock } from './engine/world-clock.js';
import { createGroupChatEngine } from './engine/group-chat.js';
import { createChatGatewayBridge } from './gateway/chat-bridge.js';
import { createGatewayHost } from './gateway/host.js';
import { createTelegramConnector } from './gateway/telegram/connector.js';
import { Bus, type DevBus, type EventBus, type StreamBus } from './http/bus.js';
import { createHttpServer } from './http/server.js';
import { createStaticResolver } from './http/static.js';
import { createMapClickHandler } from './ledger/handlers/map-click.js';
import { createMapEditHandler } from './ledger/handlers/map-edit.js';
import { createMaterializeHandler } from './ledger/handlers/materialize.js';
import { createPainterHandler } from './ledger/handlers/painter.js';
import { createProactiveDmHandler } from './ledger/handlers/proactive-dm.js';
import { createSocialPostHandler } from './ledger/handlers/social-post.js';
import { createSocialReactionHandler } from './ledger/handlers/social-reaction.js';
import { createSocialReplyHandler } from './ledger/handlers/social-reply.js';
import { createFeedReplyCommand } from './engine/feed.js';
import { createProposalEngine } from './engine/proposals.js';
import { createSubwikiEditCommand } from './engine/wiki-edit.js';
import { createCachePruneHandler } from './ledger/handlers/cache-prune.js';
import { createMemoryCompactionHandler } from './ledger/handlers/memory-compaction.js';
import { createReflectChatHandler } from './ledger/handlers/reflect-chat.js';
import { createReflectionHandler } from './ledger/handlers/reflection.js';
import { createUpdateApplyHandler } from './ledger/handlers/update-apply.js';
import { createUpdateCheckHandler } from './ledger/handlers/update-check.js';
import { createWorldAgentHandler } from './ledger/handlers/world-agent.js';
import {
  createWorldCronCodeHandler,
  createWorldCronLlmHandler,
} from './ledger/handlers/world-cron.js';
import { createRunner } from './ledger/runner.js';
import {
  createScheduler,
  intervalOccurrencesBetween,
} from './ledger/scheduler.js';
import {
  createPaintRegionCommand,
  enqueueSquarePaint,
} from './painter/commands.js';
import { createImageResolver } from './painter/images.js';
import { createStubImageSource } from './painter/image-source.js';
import { createFakeLlmClient, createFakeVlmClient } from './llm/fake-client.js';
import { createOpenRouterImageSource } from './llm/image-source.js';
import { createOpenRouterVlmClient } from './llm/vlm.js';
import { createModelRegistry } from './llm/model-registry.js';
import { createOpenRouterClient } from './llm/openrouter-client.js';
import { catchAndLog } from './observability/catch-and-log.js';
import { fatal } from './observability/fatal.js';
import { startGauges } from './observability/gauges.js';
import { createRootLogger } from './observability/logger.js';
import { openStorage } from './storage/db.js';

const bootLogger = createRootLogger({ level: 'info' });
const env = readEnvOrExplain();
if (env === null) {
  fatal(
    bootLogger,
    new OperationalError('invalid_env', 'environment failed validation (B11)'),
  );
}

const logger = createRootLogger({ level: env.logLevel });

// C6: exactly these two handlers, installed once, first. They log and die —
// never survive (the durable log + ledger are the recovery path).
process.on('uncaughtException', (err) => {
  fatal(logger, err);
});
process.on('unhandledRejection', (reason) => {
  fatal(logger, reason);
});

mkdirSync(dirname(env.dbPath), { recursive: true });
const storage = openStorage({ dbPath: env.dbPath });

const eventBus: EventBus = new Bus(logger);
const streamBus: StreamBus = new Bus(logger);
const devBus: DevBus = new Bus(logger);
const sink: EventSink = createEventSink(storage, eventBus);

// Self-watch, unconditional (the I14 structural guard — Guide C13).
const stopGauges = startGauges({
  logger,
  intervalMs: env.gaugeIntervalMs,
  publish: (frame) => {
    devBus.publish(frame);
  },
});

const elias = buildEliasProfile(env.prefixTokens);
const mara = buildMaraProfile();
const narrator = buildNarratorProfile(env.prefixTokens);
// The DM-able roster (M6 part 4: groups need >= 2 members). Mara is
// chat-side only — the scene cast stays Elias, so prefix-size runs and the
// harness scenes are untouched.
const dmRoster = [elias, mara];
const knownCharacters = [
  { character_id: elias.character_id, name: elias.name },
];

// Fixture world seed (builder.md §4.3, reshaped in M4 part 2): an empty log
// gets the fixture trio as materialized sublocations — the map starts with
// three explored squares and the client's Hang around has somewhere to land.
// No scene auto-opens anymore: a fresh world shows the splash (wireframe 03)
// and every scene opens through the open-scene command.
if (storage.eventLog.lastId() === 0) {
  for (const sublocation of FIXTURE_SUBLOCATIONS) {
    sink.append({
      world_id: FIXTURE_WORLD_ID,
      actor_id: 'system:engine',
      type: 'sublocation.materialized',
      payload: {
        sublocation_id: sublocation.sublocation_id,
        name: sublocation.name,
        description: sublocation.description,
        square: squareOf(sublocation.map_position),
        map_position: sublocation.map_position,
      },
    });
  }
  logger.info({ world_id: FIXTURE_WORLD_ID }, 'seeded fixture world');
}
// The fixture trio paints like any materialized square (M5). Boot-time, not
// seed-time, ON PURPOSE: the enqueue dedupes forever on its square key, so
// this is a no-op every boot after the first — and it heals pre-M5 dev DBs
// whose trio predates eager painting.
for (const sublocation of FIXTURE_SUBLOCATIONS) {
  enqueueSquarePaint(
    storage,
    FIXTURE_WORLD_ID,
    squareOf(sublocation.map_position),
  );
}

const registry = createModelRegistry({
  defaultModel: env.model,
  ...(env.providerOrder === undefined
    ? {}
    : { providerOrder: env.providerOrder }),
});
if (!env.fakeLlm && env.openrouterApiKey === undefined) {
  logger.warn(
    {},
    'no OPENROUTER_API_KEY configured — running on the deterministic FakeLLM until one is set',
  );
}
const llm =
  env.fakeLlm || env.openrouterApiKey === undefined
    ? createFakeLlmClient({ firstTokenDelayMs: env.fakeLlmDelayMs })
    : createOpenRouterClient({
        apiKey: env.openrouterApiKey,
        registry,
        logger,
      });
// The Flow-B click classifier rides the same double opt-out: fakes stay the
// default whenever the text LLM is fake or no key exists — the kill harness
// and a fresh install never touch a provider.
const vlm =
  env.fakeLlm || env.openrouterApiKey === undefined
    ? createFakeVlmClient()
    : createOpenRouterVlmClient({
        apiKey: env.openrouterApiKey,
        model: env.vlmModel,
        logger,
      });

// The painter's tile source (M5 part 1). Stub is the hard default; the real
// backend is a deliberate double opt-in (env flag AND key) — a fresh install
// can never spend money by accident.
if (env.imageBackend === 'openrouter' && env.openrouterApiKey === undefined) {
  logger.warn(
    {},
    'WELTARI_IMAGE_BACKEND=openrouter but no OPENROUTER_API_KEY — painting with the stub source',
  );
}
const imageSource =
  env.imageBackend === 'openrouter' && env.openrouterApiKey !== undefined
    ? createOpenRouterImageSource({
        apiKey: env.openrouterApiKey,
        model: env.imageModel,
        editModel: env.editImageModel,
        logger,
      })
    : createStubImageSource();
if (imageSource.name !== 'stub') {
  logger.info(
    { image_backend: imageSource.name, image_model: env.imageModel },
    'real image backend selected',
  );
}

const faultPoint: FaultPointHook | undefined = env.emitFaultPoints
  ? async (point): Promise<void> => {
      // The kill harness greps stdout for this marker (I4)…
      logger.info({ fault_point: point }, `FAULT_POINT:${point}`);
      // …and this hold gives its SIGKILL time to land inside the window.
      if (env.faultPauseMs > 0 && point !== 'mid_stream') {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, env.faultPauseMs);
        });
      }
    }
  : undefined;

const engine = createTurnEngine({
  storage,
  sink,
  streamBus,
  eventBus,
  devBus,
  llm,
  logger,
  stablePrefixTokens: env.prefixTokens,
  knownCharacters,
  // A committed create's backdrop/materialize jobs start on the spot —
  // drainLedger is hoisted; it only runs after startup completes.
  kickRunner: (): void => {
    catchAndLog(drainLedger(), logger, 'ledger.drain');
  },
  ...(faultPoint === undefined ? {} : { faultPoint }),
});

const lifecycle = createSceneLifecycle({
  storage,
  eventBus,
  logger,
  knownCharacters,
});

// Weltari Chat (M6 part 2, Rev 4 §8): DMs outside any scene. The idle sweep
// runs on its own timer (below); the engine itself never reads the clock.
const chatEngine = createChatEngine({
  storage,
  sink,
  eventBus,
  llm,
  logger,
  profiles: dmRoster,
  idleCutoffIso: (): string =>
    new Date(Date.now() - env.chatIdleMinutes * 60_000).toISOString(),
  openScene: (request) => lifecycle.openScene(request),
  endScene: (command) => lifecycle.endScene(command),
  kickRunner: (): void => {
    catchAndLog(drainLedger(), logger, 'ledger.drain');
  },
  devBus,
});

// The Proposal pipeline (M7 part 2, Rev 4 §16): the GM proposes, the user
// resolves — approve applies through the engine atomically, reject leaves
// zero domain rows (I8).
const proposalEngine = createProposalEngine({
  storage,
  sink,
  logger,
  seedProfiles: dmRoster,
  ...(faultPoint === undefined ? {} : { faultPoint }),
});

// Group chats (M6 part 4, Rev 4 §8): user-started only; the router routes,
// the engine cuts at the turn budget (owner default 3, WELTARI_GROUP_TURN_BUDGET).
const groupChatEngine = createGroupChatEngine({
  storage,
  sink,
  eventBus,
  llm,
  logger,
  profiles: dmRoster,
  turnBudget: env.groupTurnBudget,
  kickRunner: (): void => {
    catchAndLog(drainLedger(), logger, 'ledger.drain');
  },
  devBus,
});

async function startTurn(
  command: StartTurnCommand,
): Promise<Result<{ turnId: string }>> {
  const started = await engine.startTurn(command);
  if (!started.ok) return started;
  catchAndLog(started.value.completion, logger, 'scene-turn');
  return { ok: true, value: { turnId: started.value.turnId } };
}

// Drop-in plugins (B10): validated, hash-verified, refused-on-tamper; the
// app boots without a failing plugin. Connectors a plugin registers join the
// gateway host under the 'plugin' trust boundary (the host validates B7).
const plugins = await loadPlugins({
  pluginsDir: env.pluginsDir,
  sink,
  logger,
  worldId: FIXTURE_WORLD_ID,
});

// The chat↔messenger bridge (M6 part 4, Rev 4 §13): the messenger is a VIEW
// of Weltari Chat — inbound routes into the SAME conversation_id (replacing
// the M3 scene echo); pushes ride the LIVE bus (eager CRON DMs + the
// frozen-thread notice) toward the Telegram connector when one exists.
const telegramConnector =
  env.telegramBotToken === undefined
    ? null
    : createTelegramConnector({ token: env.telegramBotToken, logger });
const gatewayBridge = createChatGatewayBridge({
  storage,
  logger,
  profiles: dmRoster,
  actorId: 'user:owner',
  worldId: FIXTURE_WORLD_ID,
  connectorId: 'telegram',
  sendChat: (command) => chatEngine.sendMessage(command),
  push: async (chatId, text) => {
    if (telegramConnector === null) return { ok: false };
    return telegramConnector.send(chatId, text);
  },
});
eventBus.subscribe((event) => {
  gatewayBridge.onDurableEvent(event);
});

const gatewayHost = createGatewayHost({
  storage,
  logger,
  connectors: [
    ...(telegramConnector === null
      ? []
      : [{ connector: telegramConnector, boundary: 'telegram' as const }]),
    ...plugins.flatMap((plugin) =>
      plugin.connectors.map((entry) => ({
        connector: entry.connector,
        boundary: 'plugin' as const,
      })),
    ),
  ],
  runTurn: async (conversationId, text, externalMsgId) =>
    gatewayBridge.route(conversationId, text, externalMsgId),
});

// Self-update (FINAL item 12, Guide B12). No public key = disabled entirely —
// the safe default until the owner mints a minisign keypair. Startup IS
// recovery: a stale vNext (kill mid-download) is deleted before anything runs.
const appVersion =
  env.appVersion ??
  readAppVersion(resolve(import.meta.dirname, '../package.json'), logger);
// The baked default verification key (owner decision, 2026-07-09): every
// shipped layout carries the project's `minisign.pub` at the app root —
// repo root in dev, versions/<v>/ in the Windows zip, /app in Docker — so
// auto-apply works out of the box (the Sparkle/Tauri model: the maintainer
// bakes the PUBLIC key at build time; the private key never travels).
// WELTARI_UPDATE_PUBKEY stays the override for forks with their own key.
function readBakedPubkey(): string | undefined {
  const file = resolve(import.meta.dirname, '../../../minisign.pub');
  if (!existsSync(file)) return undefined;
  const keyLine = readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('untrusted comment'))
    .at(-1);
  if (keyLine === undefined) {
    logger.warn({ file }, 'minisign.pub present but empty — updates disabled');
  }
  return keyLine;
}
const updatePubkey = env.updatePubkey ?? readBakedPubkey();
// Notify vs apply (FINAL item 12): checking needs no key (it never
// downloads); applying needs the key AND a native install — Docker images
// run notify-and-let-host-pull (WELTARI_UPDATE_NOTIFY_ONLY=1).
const updateNotifyEnabled = updatePubkey !== undefined || env.updateNotifyOnly;
/** The key auto-apply verifies with; undefined = apply disabled. */
const updateApplyKey = env.updateNotifyOnly ? undefined : updatePubkey;
const updateApplyEnabled = updateApplyKey !== undefined;
cleanStaleStaging(env.versionsDir, logger);
const updateFetch: FetchLike = async (url) =>
  fetch(url, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'weltari-updater',
    },
  });

const runner = createRunner({
  storage,
  handlers: {
    reflection: createReflectionHandler({
      storage,
      sink,
      llm,
      profiles: [elias],
      logger,
      cacheKeep: env.cacheKeep,
      ...(faultPoint === undefined ? {} : { faultPoint }),
    }),
    reflect_chat: createReflectChatHandler({
      storage,
      sink,
      llm,
      profiles: dmRoster,
      logger,
      cacheKeep: env.cacheKeep,
      ...(faultPoint === undefined ? {} : { faultPoint }),
    }),
    memory_compaction: createMemoryCompactionHandler({
      storage,
      sink,
      llm,
      profiles: dmRoster,
      logger,
      ...(faultPoint === undefined ? {} : { faultPoint }),
    }),
    cache_prune: createCachePruneHandler({
      storage,
      sink,
      logger,
    }),
    proactive_dm: createProactiveDmHandler({
      storage,
      sink,
      llm,
      profiles: dmRoster,
      actorId: 'user:owner',
      logger,
      ...(faultPoint === undefined ? {} : { faultPoint }),
    }),
    social_post: createSocialPostHandler({
      storage,
      sink,
      llm,
      profiles: dmRoster,
      reactionCap: env.socialReactionCap,
      logger,
      ...(faultPoint === undefined ? {} : { faultPoint }),
    }),
    social_reaction: createSocialReactionHandler({
      storage,
      sink,
      llm,
      profiles: dmRoster,
      logger,
    }),
    social_reply: createSocialReplyHandler({
      storage,
      sink,
      llm,
      profiles: dmRoster,
      logger,
    }),
    world_agent: createWorldAgentHandler({
      storage,
      sink,
      llm,
      narrator,
      logger,
    }),
    'world_cron.code': createWorldCronCodeHandler({
      storage,
      sink,
      logger,
      ...(faultPoint === undefined ? {} : { faultPoint }),
    }),
    'world_cron.llm': createWorldCronLlmHandler({
      storage,
      sink,
      llm,
      narrator,
      logger,
      ...(faultPoint === undefined ? {} : { faultPoint }),
    }),
    materialize: createMaterializeHandler({
      storage,
      sink,
      llm,
      narrator,
      logger,
      ...(faultPoint === undefined ? {} : { faultPoint }),
    }),
    map_edit: createMapEditHandler({
      storage,
      sink,
      llm,
      narrator,
      logger,
      ...(faultPoint === undefined ? {} : { faultPoint }),
    }),
    map_click: createMapClickHandler({
      storage,
      sink,
      llm,
      vlm,
      narrator,
      imagesDir: env.imagesDir,
      logger,
      ...(faultPoint === undefined ? {} : { faultPoint }),
    }),
    painter: createPainterHandler({
      storage,
      sink,
      imagesDir: env.imagesDir,
      imageSource,
      logger,
      ...(faultPoint === undefined ? {} : { faultPoint }),
    }),
    ...(updateNotifyEnabled
      ? {
          update_check: createUpdateCheckHandler({
            storage,
            sink,
            logger,
            currentVersion: appVersion,
            releasesUrl: env.updateReleasesUrl,
            fetchFn: updateFetch,
          }),
        }
      : {}),
    ...(updateApplyKey !== undefined
      ? {
          update_apply: createUpdateApplyHandler({
            storage,
            sink,
            logger,
            currentVersion: appVersion,
            releasesUrl: env.updateReleasesUrl,
            fetchFn: updateFetch,
            versionsDir: env.versionsDir,
            publicKeyBase64: updateApplyKey,
            maxArtifactBytes: env.updateMaxBytes,
            ...(faultPoint === undefined ? {} : { faultPoint }),
          }),
        }
      : {}),
  },
  nowIso: (): string => new Date().toISOString(),
  workerId: `worker-${String(process.pid)}`,
  leaseSeconds: env.leaseSeconds,
  onFatal: (error): void => {
    fatal(logger, error);
  },
});

// Croner-scheduled release check + one check shortly after every boot
// (FINAL item 12: "startup + croner job"). croner only writes ledger rows.
const updateScheduler = updateNotifyEnabled
  ? createScheduler(
      storage,
      [
        {
          pattern: env.updateCheckCron,
          jobType: 'update_check',
          worldId: FIXTURE_WORLD_ID,
        },
      ],
      (): string => new Date().toISOString(),
    )
  : null;
if (updateNotifyEnabled) {
  storage.ledger.enqueue({
    idempotency_key: `update_check:boot:${new Date().toISOString()}`,
    world_id: FIXTURE_WORLD_ID,
    type: 'update_check',
    payload: null,
    run_at: new Date().toISOString(),
  });
}

const runnerInterval = setInterval(() => {
  updateScheduler?.tick();
  catchAndLog(runner.tick(), logger, 'runner.tick');
}, 1000);

// The chat idle sweep (Rev 4 §8): every 15 s is plenty for a minutes-scale
// timeout; demo/harness runs shrink WELTARI_CHAT_IDLE_MINUTES instead.
const chatSweepInterval = setInterval(() => {
  chatEngine.sweepIdle();
}, 15_000);

/** Drain every due job now — time skips use this so code-class occurrences
 * run instantly instead of waiting out the 1 s poll (Brief §4). */
async function drainLedger(): Promise<void> {
  while (await runner.tick()) {
    // keep claiming until the ledger has nothing due
  }
}

const worldClock = createWorldClock({
  storage,
  eventBus,
  logger,
  definitions: FIXTURE_WORLD_CRON,
  kick: (): void => {
    catchAndLog(drainLedger(), logger, 'ledger.drain');
  },
});

// Invitation expiry (M6 part 4, Rev 4 §7): lazy against the world clock —
// the sweep runs after every clock advance (the ONLY way the deadline can
// newly pass) and once at boot (recovery path = startup path: a kill inside
// the mid_invitation_expiry window heals here).
const invitationExpiry = createInvitationExpiry({
  storage,
  eventBus,
  logger,
  ...(faultPoint === undefined ? {} : { faultPoint }),
});
for (const pendingWorld of pendingInvitationWorlds(storage)) {
  catchAndLog(
    invitationExpiry.expireDue(pendingWorld),
    logger,
    'invitation.expire.boot',
  );
}

// Memory maintenance boot sweep (M7 part 1, Rev 4 §11): heal any compaction
// or CACHE-retention pass a kill delayed — the event-driven checks (after
// each reflection / CACHE growth) are the fast path, this is the recovery
// path. World-inert, duplicate keys no-op (I3).
for (const rosterProfile of dmRoster) {
  enqueueCompactionIfDue(storage, FIXTURE_WORLD_ID, rosterProfile.character_id);
  enqueueCachePruneIfDue(
    storage,
    FIXTURE_WORLD_ID,
    rosterProfile.character_id,
    env.cacheKeep,
  );
}

// The built frontend ships from this process (FINAL item 2). The default sits
// next to the compiled server both in-repo and in the packaged layout; a
// missing dist just means API-only (dev uses the Vite server instead).
const webDir = env.webDir ?? resolve(import.meta.dirname, '../../web/dist');
if (!existsSync(webDir)) {
  logger.warn({ webDir }, 'web dist not found — static frontend disabled');
}

/** The apply-update seam: enqueue the (serial, idempotent) update_apply job. */
function applyUpdate(command: ApplyUpdateCommand): Result<{ jobKey: string }> {
  if (!updateApplyEnabled) {
    return err(
      new OperationalError(
        'updates_disabled',
        'apply is off: no WELTARI_UPDATE_PUBKEY, or notify-only mode (Docker)',
      ),
    );
  }
  const version = normalizeVersion(command.version);
  if (version === null) {
    return err(
      new OperationalError('version_invalid', 'version is not plain semver'),
    );
  }
  const jobKey = `update_apply:${version}`;
  storage.ledger.enqueue({
    idempotency_key: jobKey,
    world_id: command.world_id,
    type: 'update_apply',
    payload: { version },
    run_at: new Date().toISOString(),
    serial_group: 'update_apply',
  });
  return ok({ jobKey });
}

const app = createHttpServer({
  eventLog: storage.eventLog,
  eventBus,
  streamBus,
  devBus,
  logger,
  startTurn,
  interruptTurn: (command) => engine.interruptTurn(command),
  endScene: (command) => lifecycle.endScene(command),
  openScene: (command) => lifecycle.openScene(command),
  advanceTime: (command) => {
    const fromGameTime = worldClock.currentTime(command.world_id);
    const advanced = worldClock.advanceTime(command);
    // The lazy expiry judgment (Rev 4 §7): a skip that crossed a pending
    // invitation's game-time deadline expires it now — the character is
    // released and the hardcoded absence entry lands.
    if (advanced.ok) {
      catchAndLog(
        invitationExpiry.expireDue(command.world_id),
        logger,
        'invitation.expire.advance',
      );
      // Proactive CRON DMs ride the SAME advance (M6 part 4, owner ruling
      // 2026-07-10/11: fires only when the world clock moves — a paused
      // world sends nothing). Epoch-aligned game-time boundaries in
      // (from, to], idempotent per occurrence; only the NEWEST few enqueue —
      // the 3-unanswered freeze makes more per skip pure spend.
      if (env.cronDmGameMinutes > 0) {
        const due = intervalOccurrencesBetween(
          fromGameTime,
          advanced.value.worldTime,
          env.cronDmGameMinutes,
        ).slice(-OUTREACH_FREEZE_CAP);
        for (const occurrenceIso of due) {
          storage.ledger.enqueue({
            idempotency_key: `proactive_dm:${command.world_id}:${occurrenceIso}`,
            world_id: command.world_id,
            type: 'proactive_dm',
            payload: {
              occurrence_iso: occurrenceIso,
              cadence_minutes: env.cronDmGameMinutes,
            },
            // Fires serialize per world: two due occurrences must SEE each
            // other's outreach (the backoff re-reads the log), never
            // double-send in a race.
            serial_group: `proactive_dm:${command.world_id}`,
          });
        }
        if (due.length > 0) catchAndLog(drainLedger(), logger, 'ledger.drain');
      }
      // The Feed rides the SAME advance (M6 part 5, Rev 4 §12): posts are
      // game-day cadence boundaries in (from, to], idempotent per
      // occurrence, hard ceiling 10 per skip — the FRESHEST window survives
      // (older skipped posts are simply never generated).
      if (env.socialPostsPerDay > 0) {
        const cadenceMinutes = 1440 / env.socialPostsPerDay;
        const due = intervalOccurrencesBetween(
          fromGameTime,
          advanced.value.worldTime,
          cadenceMinutes,
        ).slice(-SOCIAL_POST_SKIP_CAP);
        for (const occurrenceIso of due) {
          storage.ledger.enqueue({
            idempotency_key: `social_post:${command.world_id}:${occurrenceIso}`,
            world_id: command.world_id,
            type: 'social_post',
            payload: { occurrence_iso: occurrenceIso },
            // Posts serialize per world: scheduled-game-timestamp order
            // holds, and each fire's presence/acquaintance folds see the
            // previous fire's events.
            serial_group: `social_post:${command.world_id}`,
          });
        }
        if (due.length > 0) catchAndLog(drainLedger(), logger, 'ledger.drain');
      }
    }
    return advanced;
  },
  paintRegion: createPaintRegionCommand(storage),
  explore: createExploreCommand({
    storage,
    // Start the materialize job now — the map's spinner window should track
    // generation latency, not the runner's 1 s poll.
    kick: (): void => {
      catchAndLog(drainLedger(), logger, 'ledger.drain');
    },
  }),
  mapEdit: createMapEditCommand({
    storage,
    sink,
    // Same immediacy: the drawn region's lock window tracks generation
    // latency, not the runner's poll.
    kick: (): void => {
      catchAndLog(drainLedger(), logger, 'ledger.drain');
    },
  }),
  mapClick: createMapClickCommand({
    storage,
    kick: (): void => {
      catchAndLog(drainLedger(), logger, 'ledger.drain');
    },
  }),
  applyUpdate,
  sendChatMessage: (command) => {
    const result = chatEngine.sendMessage(command);
    if (result.ok) {
      // The reply generates detached — a failure logs, never crashes (A8).
      catchAndLog(result.value.completion, logger, 'chat-reply');
    }
    return result;
  },
  exitChat: (command) => chatEngine.exitChat(command),
  feedReply: createFeedReplyCommand({
    storage,
    sink,
    kick: (): void => {
      catchAndLog(drainLedger(), logger, 'ledger.drain');
    },
  }),
  subwikiEdit: createSubwikiEditCommand({ storage, sink }),
  resolveProposal: async (command) => {
    const result = await proposalEngine.resolve(command);
    if (result.ok) {
      // An approved apply may have enqueued backdrop jobs — start them now.
      catchAndLog(drainLedger(), logger, 'ledger.drain');
    }
    return result;
  },
  startSceneFromChat: async (command) => chatEngine.startSceneFromChat(command),
  startGroupChat: (command) => groupChatEngine.startGroup(command),
  sendGroupMessage: (command) => {
    const result = groupChatEngine.sendMessage(command);
    if (result.ok) {
      // The router round runs detached — a failure logs, never crashes (A8).
      catchAndLog(result.value.completion, logger, 'group-round');
    }
    return result.ok
      ? {
          ok: true,
          value: {
            conversationId: result.value.conversationId,
            messageId: result.value.messageId,
            routing: result.value.routing,
          },
        }
      : result;
  },
  exitGroupChat: (command) => groupChatEngine.exitGroup(command),
  plugins: plugins.map((plugin) => plugin.info),
  resolvePluginAsset: createPluginAssetResolver(plugins),
  resolveImage: createImageResolver(env.imagesDir),
  resolveStatic: createStaticResolver(webDir),
  appVersion,
});

let draining = false;
function drain(signal: string): void {
  if (draining) return;
  draining = true;
  logger.info(
    { signal },
    'draining (optimization only — kill -9 is always safe)',
  );
  clearInterval(runnerInterval);
  clearInterval(chatSweepInterval);
  stopGauges();
  catchAndLog(gatewayHost.stop(), logger, 'gateway.stop');
  catchAndLog(app.close(), logger, 'app.close');
  process.exitCode = 0;
}
process.on('SIGTERM', () => {
  drain('SIGTERM');
});
process.on('SIGINT', () => {
  drain('SIGINT');
});

try {
  await app.listen({ port: env.port, host: env.host });
  logger.info({ port: env.port, host: env.host }, 'weltari listening');
} catch (thrown) {
  fatal(logger, thrown);
}

// Outbound-only long-polling (Brief §7c) — after listen so a bad token can
// never block the HTTP surface. No token = zero connectors = instant no-op.
catchAndLog(gatewayHost.start(), logger, 'gateway.start');
