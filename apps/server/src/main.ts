// Composition root. Startup IS recovery (Brief §2.4): open storage (runs
// migrations; the runner's first tick sweeps expired leases), seed the fixture
// world if the log is empty, start HTTP + runner loops.
import { existsSync, mkdirSync } from 'node:fs';
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
  buildNarratorProfile,
  FIXTURE_SCENE_ID,
  FIXTURE_SCENE_TITLE,
  FIXTURE_WORLD_CRON,
  FIXTURE_WORLD_ID,
} from './engine/fixture/rainy-inn.js';
import { createSceneLifecycle } from './engine/scene-lifecycle.js';
import { createTurnEngine } from './engine/scene-turn.js';
import { createWorldClock } from './engine/world-clock.js';
import { createGatewayHost } from './gateway/host.js';
import { createTelegramConnector } from './gateway/telegram/connector.js';
import { Bus, type DevBus, type EventBus, type StreamBus } from './http/bus.js';
import { createHttpServer } from './http/server.js';
import { createStaticResolver } from './http/static.js';
import { createPainterHandler } from './ledger/handlers/painter.js';
import { createReflectionHandler } from './ledger/handlers/reflection.js';
import { createUpdateApplyHandler } from './ledger/handlers/update-apply.js';
import { createUpdateCheckHandler } from './ledger/handlers/update-check.js';
import { createWorldAgentHandler } from './ledger/handlers/world-agent.js';
import {
  createWorldCronCodeHandler,
  createWorldCronLlmHandler,
} from './ledger/handlers/world-cron.js';
import { createRunner } from './ledger/runner.js';
import { createScheduler } from './ledger/scheduler.js';
import { createPaintRegionCommand } from './painter/commands.js';
import { createImageResolver } from './painter/images.js';
import { createFakeLlmClient } from './llm/fake-client.js';
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

// Fixture world seed (builder.md §4.3): an empty log gets one scene to play in.
if (storage.eventLog.lastId() === 0) {
  sink.append({
    world_id: FIXTURE_WORLD_ID,
    actor_id: 'system:engine',
    type: 'scene.started',
    payload: { scene_id: FIXTURE_SCENE_ID, title: FIXTURE_SCENE_TITLE },
  });
  logger.info({ world_id: FIXTURE_WORLD_ID }, 'seeded fixture world');
}

const registry = createModelRegistry({
  defaultModel: env.model,
  ...(env.providerOrder === undefined
    ? {}
    : { providerOrder: env.providerOrder }),
});
const llm =
  env.fakeLlm || env.openrouterApiKey === undefined
    ? createFakeLlmClient()
    : createOpenRouterClient({
        apiKey: env.openrouterApiKey,
        registry,
        logger,
      });

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

const elias = buildEliasProfile(env.prefixTokens);
const narrator = buildNarratorProfile(env.prefixTokens);
const knownCharacters = [
  { character_id: elias.character_id, name: elias.name },
];

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
  ...(faultPoint === undefined ? {} : { faultPoint }),
});

const lifecycle = createSceneLifecycle({
  storage,
  eventBus,
  logger,
  knownCharacters,
});

async function startTurn(
  command: StartTurnCommand,
): Promise<Result<{ turnId: string }>> {
  const started = await engine.startTurn(command);
  if (!started.ok) return started;
  catchAndLog(started.value.completion, logger, 'scene-turn');
  return { ok: true, value: { turnId: started.value.turnId } };
}

/** Gateway seam: run one fixture-scene turn for inbound messenger text and
 * resolve with the committed transcript (the echo body). */
async function runGatewayTurn(
  _conversationId: string,
  text: string,
): Promise<Result<string>> {
  const started = await engine.startTurn({
    world_id: FIXTURE_WORLD_ID,
    actor_id: 'gateway:telegram',
    scene_id: FIXTURE_SCENE_ID,
    text,
  });
  if (!started.ok) return started;
  const turnId = started.value.turnId;
  await started.value.completion;
  for (const event of storage.eventLog.readSince(0, 100000)) {
    if (event.type === 'turn.committed' && event.payload.turn_id === turnId) {
      return {
        ok: true,
        value: event.payload.steps
          .map((step) => `${step.speaker}: ${step.text}`)
          .join('\n\n'),
      };
    }
  }
  return {
    ok: false,
    error: new OperationalError('turn_voided', 'turn did not commit'),
  };
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

const gatewayHost = createGatewayHost({
  storage,
  logger,
  connectors: [
    ...(env.telegramBotToken === undefined
      ? []
      : [
          {
            connector: createTelegramConnector({
              token: env.telegramBotToken,
              logger,
            }),
            boundary: 'telegram' as const,
          },
        ]),
    ...plugins.flatMap((plugin) =>
      plugin.connectors.map((entry) => ({
        connector: entry.connector,
        boundary: 'plugin' as const,
      })),
    ),
  ],
  runTurn: runGatewayTurn,
});

// Self-update (FINAL item 12, Guide B12). No public key = disabled entirely —
// the safe default until the owner mints a minisign keypair. Startup IS
// recovery: a stale vNext (kill mid-download) is deleted before anything runs.
const appVersion =
  env.appVersion ??
  readAppVersion(resolve(import.meta.dirname, '../package.json'), logger);
// Notify vs apply (FINAL item 12): checking needs no key (it never
// downloads); applying needs the key AND a native install — Docker images
// run notify-and-let-host-pull (WELTARI_UPDATE_NOTIFY_ONLY=1).
const updateNotifyEnabled =
  env.updatePubkey !== undefined || env.updateNotifyOnly;
const updateApplyEnabled =
  env.updatePubkey !== undefined && !env.updateNotifyOnly;
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
      ...(faultPoint === undefined ? {} : { faultPoint }),
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
    painter: createPainterHandler({
      storage,
      sink,
      imagesDir: env.imagesDir,
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
    ...(updateApplyEnabled && env.updatePubkey !== undefined
      ? {
          update_apply: createUpdateApplyHandler({
            storage,
            sink,
            logger,
            currentVersion: appVersion,
            releasesUrl: env.updateReleasesUrl,
            fetchFn: updateFetch,
            versionsDir: env.versionsDir,
            publicKeyBase64: env.updatePubkey,
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
  advanceTime: (command) => worldClock.advanceTime(command),
  paintRegion: createPaintRegionCommand(storage),
  applyUpdate,
  plugins: plugins.map((plugin) => plugin.info),
  resolvePluginAsset: createPluginAssetResolver(plugins),
  resolveImage: createImageResolver(env.imagesDir),
  resolveStatic: createStaticResolver(webDir),
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
  await app.listen({ port: env.port, host: '127.0.0.1' });
  logger.info({ port: env.port }, 'weltari listening');
} catch (thrown) {
  fatal(logger, thrown);
}

// Outbound-only long-polling (Brief §7c) — after listen so a bad token can
// never block the HTTP surface. No token = zero connectors = instant no-op.
catchAndLog(gatewayHost.start(), logger, 'gateway.start');
