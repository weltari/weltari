// Composition root. Startup IS recovery (Brief §2.4): open storage (runs
// migrations + implicitly the lease sweep on the first runner tick), seed the
// fixture world if the log is empty, start HTTP + runner loops.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { StartTurnCommand } from '@weltari/protocol';
import { readEnvOrExplain } from './boundary/config/env.js';
import { ok, OperationalError, type Result } from './errors.js';
import { createEventSink, type EventSink } from './engine/event-sink.js';
import { Bus, type EventBus, type StreamBus } from './http/bus.js';
import { createHttpServer } from './http/server.js';
import { createRunner } from './ledger/runner.js';
import { catchAndLog } from './observability/catch-and-log.js';
import { fatal } from './observability/fatal.js';
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
const sink: EventSink = createEventSink(storage, eventBus);

// Fixture world seed (builder.md §4.3): an empty log gets one scene to play in.
if (storage.eventLog.lastId() === 0) {
  sink.append({
    world_id: 'w1',
    actor_id: 'system:engine',
    type: 'scene.started',
    payload: { scene_id: 's1', title: 'The Rainy Inn' },
  });
  logger.info({ world_id: 'w1' }, 'seeded fixture world');
}

// Placeholder turn engine: opens the envelope durably, streams three canned
// sentences, commits. Replaced by the real Narrator→character→narration
// scripted turn when the LLM layer lands (Week-1 task 7) — the HTTP seam
// (startTurn) is already final.
async function startTurn(
  command: StartTurnCommand,
): Promise<Result<{ turnId: string }>> {
  const turnId = randomUUID();
  sink.append({
    world_id: command.world_id,
    actor_id: command.actor_id,
    type: 'turn.started',
    payload: { scene_id: command.scene_id, turn_id: turnId },
  });
  const steps = [
    { call: 'narrator', speaker: 'Narrator', text: 'Rain taps the window.' },
    { call: 'character', speaker: 'Elias', text: '"Late again," he mutters.' },
    {
      call: 'narration',
      speaker: 'Narrator',
      text: 'He turns back to the fire.',
    },
  ] as const;
  steps.forEach((step, index) => {
    streamBus.publish({
      turn_id: turnId,
      call: step.call,
      speaker: step.speaker,
      text: step.text,
      index,
    });
  });
  sink.append({
    world_id: command.world_id,
    actor_id: command.actor_id,
    type: 'turn.committed',
    payload: { scene_id: command.scene_id, turn_id: turnId, steps: [...steps] },
  });
  return Promise.resolve(ok({ turnId }));
}

const runner = createRunner({
  storage,
  handlers: {},
  nowIso: (): string => new Date().toISOString(),
  workerId: `worker-${String(process.pid)}`,
  onFatal: (error): void => {
    fatal(logger, error);
  },
});

const runnerInterval = setInterval(() => {
  catchAndLog(runner.tick(), logger, 'runner.tick');
}, 1000);

const app = createHttpServer({
  eventLog: storage.eventLog,
  eventBus,
  streamBus,
  logger,
  startTurn,
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
