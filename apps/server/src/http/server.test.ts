import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PROTOCOL_VERSION, type StartTurnCommand } from '@weltari/protocol';
import { err, ok, OperationalError, type Result } from '../errors.js';
import { createRootLogger } from '../observability/logger.js';
import { openStorage, type Storage } from '../storage/db.js';
import { Bus, type DevBus, type EventBus, type StreamBus } from './bus.js';
import { createHttpServer } from './server.js';

interface Frame {
  event: string;
  id: number | undefined;
  data: string;
}

/** Windows flake shield: under ephemeral-port pressure (thousands of
 * TIME_WAIT sockets) a connect draws `EADDRINUSE`. Random port allocation
 * makes every retry an independent draw — persistence rides it out. That is
 * the OS, not the behavior under test; any other failure throws first try. */
async function fetchRetry(url: string, init?: RequestInit): Promise<Response> {
  let lastError: unknown = new Error('fetchRetry: no attempt ran');
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      return await fetch(url, init);
    } catch (thrown) {
      const cause = thrown instanceof Error ? thrown.cause : undefined;
      const transient =
        cause instanceof Error &&
        'code' in cause &&
        cause.code === 'EADDRINUSE';
      if (!transient) throw thrown;
      lastError = thrown;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('fetchRetry exhausted');
}

function quietLogger(): ReturnType<typeof createRootLogger> {
  const sink = new Writable({
    write(_chunk, _enc, cb): void {
      cb();
    },
  });
  return createRootLogger({ level: 'debug', stream: sink });
}

async function readFrames(response: Response, count: number): Promise<Frame[]> {
  const body = response.body;
  if (body === null) throw new Error('response has no body');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const frames: Frame[] = [];
  let buffer = '';
  while (frames.length < count) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let separator = buffer.indexOf('\n\n');
    while (separator !== -1 && frames.length < count) {
      const block = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      if (!block.startsWith(':')) {
        const frame: Frame = { event: '', id: undefined, data: '' };
        for (const line of block.split('\n')) {
          if (line.startsWith('event: ')) frame.event = line.slice(7);
          else if (line.startsWith('id: ')) frame.id = Number(line.slice(4));
          else if (line.startsWith('data: ')) frame.data = line.slice(6);
        }
        frames.push(frame);
      }
      separator = buffer.indexOf('\n\n');
    }
  }
  await reader.cancel().catch(() => undefined);
  return frames;
}

let setupCount = 0;

describe('HTTP layer (SSE + commands)', () => {
  let app: FastifyInstance | null = null;
  let storage: Storage | null = null;

  afterEach(async () => {
    if (app !== null) await app.close();
    storage?.close();
    app = null;
    storage = null;
  });

  interface Setup {
    baseUrl: string;
    storage: Storage;
    eventBus: EventBus;
    streamBus: StreamBus;
    devBus: DevBus;
  }

  async function setup(): Promise<Setup> {
    const dir = mkdtempSync(join(tmpdir(), 'weltari-http-'));
    const logger = quietLogger();
    storage = openStorage({ dbPath: join(dir, 'w.sqlite') });
    const eventBus: EventBus = new Bus(logger);
    const streamBus: StreamBus = new Bus(logger);
    const devBus: DevBus = new Bus(logger);
    const localStorage = storage;

    async function startTurn(
      command: StartTurnCommand,
    ): Promise<Result<{ turnId: string }>> {
      const turnId = randomUUID();
      const started = localStorage.eventLog.append({
        world_id: command.world_id,
        actor_id: command.actor_id,
        type: 'turn.started',
        payload: { scene_id: command.scene_id, turn_id: turnId },
      });
      eventBus.publish(started);
      streamBus.publish({
        turn_id: turnId,
        call: 'narrator',
        speaker: 'Narrator',
        text: 'Rain.',
        index: 0,
      });
      const committed = localStorage.eventLog.append({
        world_id: command.world_id,
        actor_id: command.actor_id,
        type: 'turn.committed',
        payload: {
          scene_id: command.scene_id,
          turn_id: turnId,
          steps: [{ call: 'narrator', speaker: 'Narrator', text: 'Rain.' }],
        },
      });
      eventBus.publish(committed);
      return Promise.resolve(ok({ turnId }));
    }

    app = createHttpServer({
      eventLog: localStorage.eventLog,
      eventBus,
      streamBus,
      devBus,
      logger,
      startTurn,
      interruptTurn: (command) =>
        command.turn_id === 'gone'
          ? err(new OperationalError('turn_not_running', 'no such turn'))
          : ok({ committed: command.seen !== undefined }),
      // Scene lifecycle stubs: 'blocked' scene id exercises the 409 path.
      endScene: (command) =>
        command.scene_id === 'blocked'
          ? err(new OperationalError('scene_not_found', 'no such scene'))
          : ok({ jobsEnqueued: 2 }),
      openScene: (command) =>
        command.scene_id === 'blocked'
          ? err(new OperationalError('blocked_on_pending_jobs', 'busy'))
          : ok({ opened: true }),
      advanceTime: (command) =>
        command.minutes > 500000
          ? err(new OperationalError('skip_too_large', 'too big'))
          : ok({
              worldTime: '2000-01-02T06:00:00.000Z',
              codeEnqueued: 1,
              llmEnqueued: 1,
              llmSkipped: 0,
            }),
      paintRegion: (command) =>
        ok({ jobKey: `painter:${command.image_id}:${command.request_id}` }),
      // Square (0,0) exercises the 409 path (already occupied).
      explore: (command) =>
        command.square.col === 0 && command.square.row === 0
          ? err(new OperationalError('square_occupied', 'already there'))
          : ok({
              jobKey: `materialize:${command.world_id}:${String(command.square.col)}:${String(command.square.row)}`,
            }),
      // request_id 'on-fog' exercises the 409 path (unexplored centroid).
      mapEdit: (command) =>
        command.request_id === 'on-fog'
          ? err(new OperationalError('unexplored_ground', 'fog'))
          : ok({
              jobKey: `map_edit:${command.world_id}:${command.request_id}`,
              editId: command.request_id,
            }),
      // x<0.1 exercises 'enter' (inside a radius); x>0.9 the 409 fog path.
      mapClick: (command) =>
        command.point.x > 0.9
          ? err(new OperationalError('unexplored_ground', 'fog'))
          : command.point.x < 0.1
            ? ok({
                outcome: 'enter',
                clickId: command.request_id,
                sublocationId: 'subloc:common_room',
                name: 'The Common Room',
              })
            : ok({
                outcome: 'classify',
                clickId: command.request_id,
                jobKey: `map_click:${command.world_id}:${command.request_id}`,
              }),
      // marker 'gone' exercises the 409 path; 'seen' the join answer.
      markerClick: async (command) =>
        Promise.resolve(
          command.marker_id === 'gone'
            ? err(new OperationalError('marker_expired', 'expired'))
            : ok({
                outcome:
                  command.marker_id === 'seen'
                    ? ('join' as const)
                    : ('instantiated' as const),
                marker_id: command.marker_id,
                scene_id: `s-marker-${command.marker_id}`,
                sublocation_id: 'subloc:common_room',
              }),
        ),
      // 'disabled' exercises the 409 path (no verification key configured).
      applyUpdate: (command) =>
        command.version === 'disabled'
          ? err(new OperationalError('updates_disabled', 'no key'))
          : ok({ jobKey: `update_apply:${command.version}` }),
      // Weltari Chat stubs (M6 part 2): 'char:ghost' exercises the 409 path;
      // 'char:busy' exercises the offline (in_scene) presence answer.
      sendChatMessage: (command) =>
        command.character_id === 'char:ghost'
          ? err(new OperationalError('unknown_character', 'no such character'))
          : ok({
              conversationId: `chat:${command.actor_id}:${command.character_id}`,
              messageId: command.request_id,
              replying: command.character_id !== 'char:busy',
              presence:
                command.character_id === 'char:busy' ? 'in_scene' : 'available',
            }),
      exitChat: (command) =>
        command.character_id === 'char:ghost'
          ? err(new OperationalError('unknown_character', 'no such character'))
          : ok({
              conversationId: `chat:${command.actor_id}:${command.character_id}`,
              ended: true,
              jobKey: 'reflect_chat:c1:9',
            }),
      feedReply: (command) =>
        command.reaction_id === 'r:ghost'
          ? err(new OperationalError('unknown_comment', 'no such comment'))
          : ok({ replyId: command.request_id }),
      subwikiEdit: (command) =>
        command.sublocation_id === 'subloc:ghost'
          ? err(new OperationalError('unknown_sublocation', 'no such place'))
          : ok({ sublocationId: command.sublocation_id }),
      // 'prop-ghost' exercises the 409 path (unknown proposal).
      resolveProposal: async (command) =>
        Promise.resolve(
          command.proposal_id === 'prop-ghost'
            ? err(new OperationalError('unknown_proposal', 'no such proposal'))
            : ok({ applied: command.resolution === 'approved' ? 3 : 0 }),
        ),
      setConfigFlag: (command) =>
        ok({ flag: command.flag, value: command.value }),
      // 'char:ghost' exercises the 409 path (unknown character).
      setCharacterLock: (command) =>
        command.character_id === 'char:ghost'
          ? err(new OperationalError('unknown_character', 'no such character'))
          : ok({
              characterId: command.character_id,
              locked: command.locked,
            }),
      deleteProfile: () => ok({ removed: 2 }),
      profileView: (worldId, actorId) => ({
        actor_id: actorId,
        profiling_enabled: worldId === 'w1',
        entries: [
          {
            id: 1,
            kind: 'hypothesis',
            body: 'Leans into small mysteries.',
            context_id: 's1',
            created_at: '2026-07-11T12:00:00.000Z',
          },
        ],
      }),
      // place 'the park' exercises the unresolved free-text answer shape.
      startSceneFromChat: async (command) =>
        Promise.resolve(
          command.character_id === 'char:ghost'
            ? err(
                new OperationalError('unknown_character', 'no such character'),
              )
            : ok({
                sceneId: command.scene_id,
                ...(command.place === 'the park'
                  ? {}
                  : { sublocationId: 'subloc:common_room' }),
              }),
        ),
      startGroupChat: (command) =>
        ok({
          conversationId: `group:${command.actor_id}:${command.request_id}`,
        }),
      sendGroupMessage: (command) =>
        command.conversation_id === 'group:ghost'
          ? err(new OperationalError('unknown_group', 'no such group'))
          : ok({
              conversationId: command.conversation_id,
              messageId: command.request_id,
              routing: true,
            }),
      exitGroupChat: (command) =>
        ok({
          conversationId: command.conversation_id,
          ended: true,
          jobsEnqueued: 2,
        }),
      heartbeatMs: 60000,
    });
    // Windows: listen({port: 0}) draws from the ephemeral range (49152+),
    // where outbound sockets roam — connects to such a port intermittently
    // fail with EADDRINUSE. Stay below that range: deterministic PID-based
    // port (parallel vitest workers have distinct pids), retry on bind clash.
    // setupCount keeps every test on a FRESH port so undici's keep-alive pool
    // can never hand back a stale connection to a closed server (ECONNRESET).
    setupCount += 1;
    const basePort = 20000 + (process.pid % 5000) + setupCount * 7;
    for (let attempt = 0; ; attempt++) {
      try {
        await app.listen({ port: basePort + attempt, host: '127.0.0.1' });
        break;
      } catch (thrown) {
        const taken =
          thrown instanceof Error &&
          'code' in thrown &&
          thrown.code === 'EADDRINUSE';
        if (!taken || attempt >= 50) throw thrown;
      }
    }
    const address = app.server.address();
    if (address === null || typeof address === 'string')
      throw new Error('no port');
    return {
      baseUrl: `http://127.0.0.1:${String(address.port)}`,
      storage: localStorage,
      eventBus,
      streamBus,
      devBus,
    };
  }

  function seed(s: Storage, bus: EventBus, n: number): void {
    for (let i = 0; i < n; i++) {
      const event = s.eventLog.append({
        world_id: 'w1',
        actor_id: 'user:owner',
        type: 'turn.started',
        payload: { scene_id: 's1', turn_id: `t${String(i)}` },
      });
      bus.publish(event);
    }
  }

  it('apply-update -> 202 with job_key; disabled updates -> 409', async () => {
    const ctx = await setup();
    const accepted = await fetchRetry(
      `${ctx.baseUrl}/v1/commands/apply-update`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          world_id: 'w1',
          actor_id: 'user:owner',
          version: '0.2.0',
        }),
      },
    );
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({
      accepted: true,
      job_key: 'update_apply:0.2.0',
    });

    const rejected = await fetchRetry(
      `${ctx.baseUrl}/v1/commands/apply-update`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          world_id: 'w1',
          actor_id: 'user:owner',
          version: 'disabled',
        }),
      },
    );
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toEqual({
      accepted: false,
      error: 'updates_disabled',
    });
  });

  it('send-chat-message -> 202 with the presence answer; unknown character -> 409', async () => {
    const ctx = await setup();
    const replying = await fetchRetry(
      `${ctx.baseUrl}/v1/commands/send-chat-message`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          world_id: 'w1',
          actor_id: 'user:owner',
          character_id: 'char:elias',
          text: 'Evening, Elias.',
          request_id: 'm-1',
        }),
      },
    );
    expect(replying.status).toBe(202);
    expect(await replying.json()).toEqual({
      accepted: true,
      conversation_id: 'chat:user:owner:char:elias',
      message_id: 'm-1',
      replying: true,
      presence: 'available',
    });

    // The presence rule (UI Spec §2.4): in_scene = offline, no reply coming.
    const offline = await fetchRetry(
      `${ctx.baseUrl}/v1/commands/send-chat-message`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          world_id: 'w1',
          actor_id: 'user:owner',
          character_id: 'char:busy',
          text: 'You there?',
          request_id: 'm-2',
        }),
      },
    );
    expect(offline.status).toBe(202);
    const offlineBody: unknown = await offline.json();
    expect(offlineBody).toMatchObject({
      replying: false,
      presence: 'in_scene',
    });

    const rejected = await fetchRetry(
      `${ctx.baseUrl}/v1/commands/send-chat-message`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          world_id: 'w1',
          actor_id: 'user:owner',
          character_id: 'char:ghost',
          text: 'Hello?',
          request_id: 'm-3',
        }),
      },
    );
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toEqual({
      accepted: false,
      error: 'unknown_character',
    });
  });

  it('exit-chat -> 202 with the reflect_chat job key', async () => {
    const ctx = await setup();
    const accepted = await fetchRetry(`${ctx.baseUrl}/v1/commands/exit-chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        world_id: 'w1',
        actor_id: 'user:owner',
        character_id: 'char:elias',
      }),
    });
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({
      accepted: true,
      conversation_id: 'chat:user:owner:char:elias',
      ended: true,
      job_key: 'reflect_chat:c1:9',
    });
  });

  it('start-scene-from-chat -> 202 with scene id (+ sublocation when resolved)', async () => {
    const ctx = await setup();
    const resolved = await fetchRetry(
      `${ctx.baseUrl}/v1/commands/start-scene-from-chat`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          world_id: 'w1',
          actor_id: 'user:owner',
          character_id: 'char:elias',
          scene_id: 's-chat-1',
          title: 'Meeting at the inn',
          place: 'The Common Room',
        }),
      },
    );
    expect(resolved.status).toBe(202);
    expect(await resolved.json()).toEqual({
      accepted: true,
      scene_id: 's-chat-1',
      sublocation_id: 'subloc:common_room',
    });

    const freeText = await fetchRetry(
      `${ctx.baseUrl}/v1/commands/start-scene-from-chat`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          world_id: 'w1',
          actor_id: 'user:owner',
          character_id: 'char:elias',
          scene_id: 's-chat-2',
          title: 'Meeting outside',
          place: 'the park',
        }),
      },
    );
    expect(freeText.status).toBe(202);
    expect(await freeText.json()).toEqual({
      accepted: true,
      scene_id: 's-chat-2',
    });
  });

  it('interrupt-turn -> 202 with committed; unknown turn -> 409', async () => {
    const ctx = await setup();
    const accepted = await fetchRetry(
      `${ctx.baseUrl}/v1/commands/interrupt-turn`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          world_id: 'w1',
          actor_id: 'user:owner',
          turn_id: 't-live',
          seen: { call: 'narrator', sentence_index: 1 },
        }),
      },
    );
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({ accepted: true, committed: true });

    const refused = await fetchRetry(
      `${ctx.baseUrl}/v1/commands/interrupt-turn`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          world_id: 'w1',
          actor_id: 'user:owner',
          turn_id: 'gone',
        }),
      },
    );
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      accepted: false,
      error: 'turn_not_running',
    });
  });

  it('hello frame carries protocol_version and the current log head', async () => {
    const ctx = await setup();
    seed(ctx.storage, ctx.eventBus, 2);
    const res = await fetchRetry(`${ctx.baseUrl}/v1/events`);
    const frames = await readFrames(res, 3);
    expect(frames[0]?.event).toBe('hello');
    const hello: unknown = JSON.parse(frames[0]?.data ?? '');
    expect(hello).toMatchObject({
      protocol_version: PROTOCOL_VERSION,
      last_event_id: 2,
    });
    expect(frames.slice(1).map((f) => f.id)).toEqual([1, 2]); // full replay from 0
  });

  it('Last-Event-ID replays only missed events, exactly once', async () => {
    const ctx = await setup();
    seed(ctx.storage, ctx.eventBus, 5);
    const res = await fetchRetry(`${ctx.baseUrl}/v1/events`, {
      headers: { 'Last-Event-ID': '3' },
    });
    const frames = await readFrames(res, 3);
    expect(frames[0]?.event).toBe('hello');
    expect(frames.slice(1).map((f) => f.id)).toEqual([4, 5]);
  });

  it('a live append after connect is pushed with its log id', async () => {
    const ctx = await setup();
    seed(ctx.storage, ctx.eventBus, 1);
    const res = await fetchRetry(`${ctx.baseUrl}/v1/events`);
    const framesPromise = readFrames(res, 3); // hello + replay(1) + live(1)
    seed(ctx.storage, ctx.eventBus, 1);
    const frames = await framesPromise;
    expect(frames.map((f) => f.id)).toEqual([undefined, 1, 2]);
  });

  it('curl-style query fallback ?last_event_id= works without the header', async () => {
    const ctx = await setup();
    seed(ctx.storage, ctx.eventBus, 3);
    const res = await fetchRetry(`${ctx.baseUrl}/v1/events?last_event_id=2`);
    const frames = await readFrames(res, 2);
    expect(frames.slice(1).map((f) => f.id)).toEqual([3]);
  });

  it('dev frames reach only clients that opted in with ?dev=1 (Guide C11)', async () => {
    const ctx = await setup();
    const optedIn = await fetchRetry(`${ctx.baseUrl}/v1/events?dev=1`);
    const optedOut = await fetchRetry(`${ctx.baseUrl}/v1/events`);
    const devFramesPromise = readFrames(optedIn, 2); // hello + dev
    const plainFramesPromise = readFrames(optedOut, 2); // hello + the durable event below

    ctx.devBus.publish({
      type: 'dev.gauges',
      loop_p99_ms: 12.3,
      rss_mb: 104,
      degraded: false,
    });
    seed(ctx.storage, ctx.eventBus, 1); // lets the opted-out reader terminate

    const devFrames = await devFramesPromise;
    expect(devFrames.map((f) => f.event)).toEqual(['hello', 'dev']);
    expect(devFrames[1]?.id).toBeUndefined(); // ephemeral: no SSE id
    const gauge: unknown = JSON.parse(devFrames[1]?.data ?? '');
    expect(gauge).toMatchObject({ type: 'dev.gauges', degraded: false });

    const plainFrames = await plainFramesPromise;
    expect(plainFrames.map((f) => f.event)).toEqual(['hello', 'event']);
  });

  it('end-scene -> 202 with jobs_enqueued; engine refusal -> 409', async () => {
    const ctx = await setup();
    const accepted = await fetchRetry(`${ctx.baseUrl}/v1/commands/end-scene`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        world_id: 'w1',
        actor_id: 'user:owner',
        scene_id: 's1',
      }),
    });
    expect(accepted.status).toBe(202);
    const body: unknown = await accepted.json();
    expect(body).toMatchObject({ accepted: true, jobs_enqueued: 2 });

    const refused = await fetchRetry(`${ctx.baseUrl}/v1/commands/end-scene`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        world_id: 'w1',
        actor_id: 'user:owner',
        scene_id: 'blocked',
      }),
    });
    expect(refused.status).toBe(409);
  });

  it('open-scene -> 202; blocked scene -> 409 with the error code', async () => {
    const ctx = await setup();
    const accepted = await fetchRetry(`${ctx.baseUrl}/v1/commands/open-scene`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        world_id: 'w1',
        actor_id: 'user:owner',
        scene_id: 's2',
        title: 'Morning After',
        participants: ['char:elias'],
      }),
    });
    expect(accepted.status).toBe(202);

    const blocked = await fetchRetry(`${ctx.baseUrl}/v1/commands/open-scene`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        world_id: 'w1',
        actor_id: 'user:owner',
        scene_id: 'blocked',
        title: 'Nope',
        participants: [],
      }),
    });
    expect(blocked.status).toBe(409);
    const body: unknown = await blocked.json();
    expect(body).toMatchObject({
      accepted: false,
      error: 'blocked_on_pending_jobs',
    });
  });

  it('advance-time -> 202 with the new world time and enqueue counts', async () => {
    const ctx = await setup();
    const res = await fetchRetry(`${ctx.baseUrl}/v1/commands/advance-time`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        world_id: 'w1',
        actor_id: 'user:owner',
        minutes: 1440,
      }),
    });
    expect(res.status).toBe(202);
    const body: unknown = await res.json();
    expect(body).toMatchObject({
      accepted: true,
      world_time: '2000-01-02T06:00:00.000Z',
      code_enqueued: 1,
      llm_enqueued: 1,
      llm_skipped: 0,
    });
  });

  it('paint-region -> 202 echoing the job key', async () => {
    const ctx = await setup();
    const res = await fetchRetry(`${ctx.baseUrl}/v1/commands/paint-region`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        world_id: 'w1',
        actor_id: 'user:owner',
        image_id: 'map:w1',
        region: { x: 0, y: 0, width: 64, height: 64 },
        request_id: 'r1',
      }),
    });
    expect(res.status).toBe(202);
    const body: unknown = await res.json();
    expect(body).toMatchObject({
      accepted: true,
      job_key: 'painter:map:w1:r1',
    });
  });

  it('explore -> 202 echoing the job key; occupied square -> 409', async () => {
    const ctx = await setup();
    const accepted = await fetchRetry(`${ctx.baseUrl}/v1/commands/explore`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        world_id: 'w1',
        actor_id: 'user:owner',
        square: { col: 5, row: 1 },
      }),
    });
    expect(accepted.status).toBe(202);
    const body: unknown = await accepted.json();
    expect(body).toMatchObject({
      accepted: true,
      job_key: 'materialize:w1:5:1',
    });

    const refused = await fetchRetry(`${ctx.baseUrl}/v1/commands/explore`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        world_id: 'w1',
        actor_id: 'user:owner',
        square: { col: 0, row: 0 },
      }),
    });
    expect(refused.status).toBe(409);

    const offGrid = await fetchRetry(`${ctx.baseUrl}/v1/commands/explore`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        world_id: 'w1',
        actor_id: 'user:owner',
        square: { col: 99, row: 0 },
      }),
    });
    expect(offGrid.status).toBe(400); // schema gate: outside the fog grid
  });

  it('map-edit -> 202 echoing job key + edit id; fog centroid -> 409; bad polygon -> 400', async () => {
    const ctx = await setup();
    const triangle = [
      { x: 0.2, y: 0.2 },
      { x: 0.3, y: 0.2 },
      { x: 0.25, y: 0.3 },
    ];
    const accepted = await fetchRetry(`${ctx.baseUrl}/v1/commands/map-edit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        world_id: 'w1',
        actor_id: 'user:owner',
        points: triangle,
        intent: 'a mill pond',
        request_id: 'e1',
      }),
    });
    expect(accepted.status).toBe(202);
    const body: unknown = await accepted.json();
    expect(body).toMatchObject({
      accepted: true,
      job_key: 'map_edit:w1:e1',
      edit_id: 'e1',
    });

    const refused = await fetchRetry(`${ctx.baseUrl}/v1/commands/map-edit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        world_id: 'w1',
        actor_id: 'user:owner',
        points: triangle,
        intent: 'a mill pond',
        request_id: 'on-fog',
      }),
    });
    expect(refused.status).toBe(409);

    const twoPoints = await fetchRetry(`${ctx.baseUrl}/v1/commands/map-edit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        world_id: 'w1',
        actor_id: 'user:owner',
        points: triangle.slice(0, 2),
        intent: 'a mill pond',
        request_id: 'e2',
      }),
    });
    expect(twoPoints.status).toBe(400); // schema gate: not a polygon
  });

  it('map-click -> 202 enter inside a radius, 202 classify outside, 409 on fog', async () => {
    const ctx = await setup();
    const post = async (x: number, requestId: string) =>
      fetchRetry(`${ctx.baseUrl}/v1/commands/map-click`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          world_id: 'w1',
          actor_id: 'user:owner',
          point: { x, y: 0.5 },
          request_id: requestId,
        }),
      });
    const entered = await post(0.05, 'c1');
    expect(entered.status).toBe(202);
    expect(await entered.json()).toMatchObject({
      accepted: true,
      outcome: 'enter',
      click_id: 'c1',
      sublocation_id: 'subloc:common_room',
      name: 'The Common Room',
    });

    const classify = await post(0.5, 'c2');
    expect(classify.status).toBe(202);
    expect(await classify.json()).toMatchObject({
      accepted: true,
      outcome: 'classify',
      click_id: 'c2',
      job_key: 'map_click:w1:c2',
    });

    const fog = await post(0.95, 'c3');
    expect(fog.status).toBe(409);
  });

  it('marker-click -> 202 instantiated / join, 409 expired, 400 on extras (M7 part 4)', async () => {
    const ctx = await setup();
    const post = async (markerId: string, extra: object = {}) =>
      fetchRetry(`${ctx.baseUrl}/v1/commands/marker-click`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          world_id: 'w1',
          actor_id: 'user:owner',
          marker_id: markerId,
          ...extra,
        }),
      });
    const won = await post('m1');
    expect(won.status).toBe(202);
    expect(await won.json()).toMatchObject({
      accepted: true,
      outcome: 'instantiated',
      marker_id: 'm1',
      scene_id: 's-marker-m1',
      sublocation_id: 'subloc:common_room',
    });

    const joined = await post('seen');
    expect(joined.status).toBe(202);
    expect(await joined.json()).toMatchObject({
      accepted: true,
      outcome: 'join',
      scene_id: 's-marker-seen',
    });

    const expired = await post('gone');
    expect(expired.status).toBe(409);
    expect(await expired.json()).toMatchObject({
      accepted: false,
      error: 'marker_expired',
    });

    const smuggled = await post('m1', { force: true });
    expect(smuggled.status).toBe(400); // strictObject rejects extras (B5)
  });

  it('malformed command body -> 400 and nothing appended (B-http)', async () => {
    const ctx = await setup();
    const res = await fetchRetry(`${ctx.baseUrl}/v1/commands/start-turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        world_id: 'w1',
        actor_id: 'u',
        scene_id: 's1',
        smuggled: true,
      }),
    });
    expect(res.status).toBe(400);
    expect(ctx.storage.eventLog.lastId()).toBe(0);
  });

  it('valid command -> 202 with turn_id; turn events land on the stream', async () => {
    const ctx = await setup();
    const sse = await fetchRetry(`${ctx.baseUrl}/v1/events`);
    const framesPromise = readFrames(sse, 4); // hello + started + stream sentence + committed

    const res = await fetchRetry(`${ctx.baseUrl}/v1/commands/start-turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        world_id: 'w1',
        actor_id: 'user:owner',
        scene_id: 's1',
      }),
    });
    expect(res.status).toBe(202);
    const body: unknown = await res.json();
    expect(body).toMatchObject({ accepted: true });

    const frames = await framesPromise;
    expect(frames.map((f) => f.event)).toEqual([
      'hello',
      'event',
      'stream',
      'event',
    ]);
    expect(frames[2]?.id).toBeUndefined(); // ephemeral sentence: no SSE id (B6)
  });
});
