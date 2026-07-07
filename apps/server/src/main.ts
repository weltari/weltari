// Composition root. Startup IS recovery (Brief §2.4): open storage (runs
// migrations; the runner's first tick sweeps expired leases), seed the fixture
// world if the log is empty, start HTTP + runner loops.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { StartTurnCommand } from '@weltari/protocol';
import { readEnvOrExplain } from './boundary/config/env.js';
import { OperationalError, type Result } from './errors.js';
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
import { createPainterHandler } from './ledger/handlers/painter.js';
import { createReflectionHandler } from './ledger/handlers/reflection.js';
import { createWorldAgentHandler } from './ledger/handlers/world-agent.js';
import {
  createWorldCronCodeHandler,
  createWorldCronLlmHandler,
} from './ledger/handlers/world-cron.js';
import { createRunner } from './ledger/runner.js';
import { createPaintRegionCommand } from './painter/commands.js';
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

const gatewayHost = createGatewayHost({
  storage,
  logger,
  connectors:
    env.telegramBotToken === undefined
      ? []
      : [
          {
            connector: createTelegramConnector({
              token: env.telegramBotToken,
              logger,
            }),
            boundary: 'telegram',
          },
        ],
  runTurn: runGatewayTurn,
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
  },
  nowIso: (): string => new Date().toISOString(),
  workerId: `worker-${String(process.pid)}`,
  leaseSeconds: env.leaseSeconds,
  onFatal: (error): void => {
    fatal(logger, error);
  },
});

const runnerInterval = setInterval(() => {
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
