// Pins the scene-jump transition (one active scene): postOpenScene ends the
// still-open scene FIRST and waits out the scene-end fan-out window (Brief §4
// scoped blocking) instead of abandoning the old scene open. Regression: a
// map jump from an active scene left it open forever, pinning its characters
// `in_scene` — the presence rule then silenced their DM replies for good.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { postOpenScene } from './commands.js';

interface RecordedCall {
  path: string;
  body: string;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Stubs global fetch; `answer` decides per call, `calls` records the order. */
function stubFetch(
  answer: (call: RecordedCall, index: number) => Response,
): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const call: RecordedCall = {
        path:
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url,
        body: typeof init?.body === 'string' ? init.body : '',
      };
      calls.push(call);
      return Promise.resolve(answer(call, calls.length - 1));
    },
  );
  return calls;
}

const OPEN_OK = { accepted: true };
const END_OK = { accepted: true, jobs_enqueued: 2 };
const BLOCKED = { accepted: false, error: 'blocked_on_pending_jobs' };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('postOpenScene ends the active scene before opening (one active scene)', () => {
  it('POSTs end-scene for the still-open scene first, then opens', async () => {
    const calls = stubFetch((call) =>
      call.path === '/v1/commands/end-scene'
        ? jsonResponse(202, END_OK)
        : jsonResponse(202, OPEN_OK),
    );
    const sceneId = await postOpenScene(
      'Next stop',
      {},
      { endSceneId: 's-old', retryDelayMs: 0 },
    );
    expect(sceneId).not.toBeNull();
    expect(calls.map((c) => c.path)).toEqual([
      '/v1/commands/end-scene',
      '/v1/commands/open-scene',
    ]);
    expect(calls[0]?.body).toContain('"scene_id":"s-old"');
  });

  it('skips end-scene when no scene is open', async () => {
    const calls = stubFetch(() => jsonResponse(202, OPEN_OK));
    const sceneId = await postOpenScene('Fresh start', {}, { retryDelayMs: 0 });
    expect(sceneId).not.toBeNull();
    expect(calls.map((c) => c.path)).toEqual(['/v1/commands/open-scene']);
  });

  it('retries while the end fan-out blocks the open, then succeeds', async () => {
    const calls = stubFetch((call, index) => {
      if (call.path === '/v1/commands/end-scene')
        return jsonResponse(202, END_OK);
      // Two blocked rounds (reflections still running), then the 202.
      return index < 3
        ? jsonResponse(409, BLOCKED)
        : jsonResponse(202, OPEN_OK);
    });
    const sceneId = await postOpenScene(
      'Next stop',
      {},
      { endSceneId: 's-old', retryDelayMs: 0 },
    );
    expect(sceneId).not.toBeNull();
    expect(
      calls.filter((c) => c.path === '/v1/commands/open-scene'),
    ).toHaveLength(3);
  });

  it('gives up after the retry cap while still blocked', async () => {
    const calls = stubFetch(() => jsonResponse(409, BLOCKED));
    const sceneId = await postOpenScene('Never opens', {}, { retryDelayMs: 0 });
    expect(sceneId).toBeNull();
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.length).toBeLessThanOrEqual(20);
  });

  it('does NOT retry a genuine refusal (e.g. unknown_sublocation)', async () => {
    const calls = stubFetch(() =>
      jsonResponse(409, { accepted: false, error: 'unknown_sublocation' }),
    );
    const sceneId = await postOpenScene('Nowhere', {}, { retryDelayMs: 0 });
    expect(sceneId).toBeNull();
    expect(calls).toHaveLength(1);
  });
});
