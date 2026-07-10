import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { err, ok, OperationalError, type Result } from '../errors.js';
import { createRootLogger } from '../observability/logger.js';
import { openStorage, type Storage } from '../storage/db.js';
import { Bus, type DevBus, type EventBus, type StreamBus } from './bus.js';
import { createHttpServer } from './server.js';
import { createStaticResolver, type StaticResolver } from './static.js';

function quietLogger(): ReturnType<typeof createRootLogger> {
  const sink = new Writable({
    write(_chunk, _enc, cb): void {
      cb();
    },
  });
  return createRootLogger({ level: 'debug', stream: sink });
}

/** A fake Vite dist: entry page + one content-hashed asset, with a file
 * planted OUTSIDE the dist so traversal has something real to reach for. */
function makeWebDist(): { root: string; webDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'weltari-static-'));
  const webDir = join(root, 'dist');
  mkdirSync(join(webDir, 'assets'), { recursive: true });
  writeFileSync(join(webDir, 'index.html'), '<html>WELTARI-INDEX</html>');
  writeFileSync(join(webDir, 'assets', 'app-abc123.js'), 'console.log(1);');
  writeFileSync(join(root, 'secret.txt'), 'outside the dist');
  return { root, webDir };
}

describe('createStaticResolver (containment + SPA fallback)', () => {
  it('serves real files with their content type', () => {
    const { webDir } = makeWebDist();
    const resolveStatic = createStaticResolver(webDir);
    const asset = resolveStatic('assets/app-abc123.js');
    expect(asset?.contentType).toBe('text/javascript; charset=utf-8');
    expect(asset?.cacheControl).toBe('public, max-age=31536000, immutable');
  });

  it('empty path and contained misses fall back to index.html (no-cache)', () => {
    const { webDir } = makeWebDist();
    const resolveStatic = createStaticResolver(webDir);
    for (const urlPath of ['', 'scene/somewhere', 'missing.png']) {
      const asset = resolveStatic(urlPath);
      expect(asset?.file.endsWith('index.html')).toBe(true);
      expect(asset?.contentType).toBe('text/html; charset=utf-8');
      expect(asset?.cacheControl).toBe('no-cache');
    }
  });

  it('a traversal attempt gets null — never the fallback', () => {
    const { webDir } = makeWebDist();
    const resolveStatic = createStaticResolver(webDir);
    expect(resolveStatic('../secret.txt')).toBeNull();
    expect(resolveStatic('assets/../../secret.txt')).toBeNull();
    // Backslash is a separator only on Windows; elsewhere it is a plain
    // filename character and containment is not in question.
    if (process.platform === 'win32') {
      expect(resolveStatic('..\\secret.txt')).toBeNull();
    }
  });

  it('a missing dist resolves nothing at all', () => {
    const { root } = makeWebDist();
    const resolveStatic = createStaticResolver(join(root, 'nope'));
    expect(resolveStatic('')).toBeNull();
    expect(resolveStatic('index.html')).toBeNull();
  });
});

describe('GET /* (the SPA wildcard route)', () => {
  let app: FastifyInstance | null = null;
  let storage: Storage | null = null;

  afterEach(async () => {
    if (app !== null) await app.close();
    storage?.close();
    app = null;
    storage = null;
  });

  function buildApp(resolveStatic?: StaticResolver): FastifyInstance {
    const dir = mkdtempSync(join(tmpdir(), 'weltari-static-http-'));
    const logger = quietLogger();
    storage = openStorage({ dbPath: join(dir, 'w.sqlite') });
    const eventBus: EventBus = new Bus(logger);
    const streamBus: StreamBus = new Bus(logger);
    const devBus: DevBus = new Bus(logger);
    async function startTurn(): Promise<Result<{ turnId: string }>> {
      return Promise.resolve(ok({ turnId: 't1' }));
    }
    app = createHttpServer({
      eventLog: storage.eventLog,
      eventBus,
      streamBus,
      devBus,
      logger,
      startTurn,
      interruptTurn: () => ok({ committed: true }),
      endScene: () => ok({ jobsEnqueued: 0 }),
      openScene: () => ok({ opened: true }),
      advanceTime: () =>
        err(new OperationalError('skip_too_large', 'test stub')),
      paintRegion: () => ok({ jobKey: 'painter:x:y' }),
      explore: () => ok({ jobKey: 'materialize:w1:0:0' }),
      mapEdit: () => ok({ jobKey: 'map_edit:w1:e1', editId: 'e1' }),
      mapClick: () =>
        ok({
          outcome: 'classify',
          clickId: 'c1',
          jobKey: 'map_click:w1:c1',
        }),
      applyUpdate: () =>
        err(new OperationalError('updates_disabled', 'test stub')),
      sendChatMessage: () =>
        err(new OperationalError('unknown_character', 'test stub')),
      exitChat: () =>
        err(new OperationalError('unknown_character', 'test stub')),
      startSceneFromChat: async () =>
        Promise.resolve(
          err(new OperationalError('unknown_character', 'test stub')),
        ),
      ...(resolveStatic === undefined ? {} : { resolveStatic }),
    });
    return app;
  }

  it('serves index.html at /, hashed assets immutable, SPA routes fall back', async () => {
    const { webDir } = makeWebDist();
    const server = buildApp(createStaticResolver(webDir));

    const index = await server.inject({ method: 'GET', url: '/' });
    expect(index.statusCode).toBe(200);
    expect(index.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(index.headers['cache-control']).toBe('no-cache');
    expect(index.body).toContain('WELTARI-INDEX');

    const asset = await server.inject({
      method: 'GET',
      url: '/assets/app-abc123.js',
    });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['content-type']).toBe(
      'text/javascript; charset=utf-8',
    );
    expect(asset.headers['cache-control']).toBe(
      'public, max-age=31536000, immutable',
    );

    const spa = await server.inject({ method: 'GET', url: '/scene/current' });
    expect(spa.statusCode).toBe(200);
    expect(spa.body).toContain('WELTARI-INDEX');

    const traversal = await server.inject({
      method: 'GET',
      url: '/..%2Fsecret.txt',
    });
    expect(traversal.statusCode).toBe(404);
  });

  it('API namespaces never fall through to HTML — JSON 404 instead', async () => {
    const { webDir } = makeWebDist();
    const server = buildApp(createStaticResolver(webDir));
    for (const url of ['/v1/nope', '/v1', '/plugins', '/plugins/ghost']) {
      const response = await server.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(404);
      expect(response.headers['content-type']).toContain('application/json');
      expect(response.json()).toEqual({ accepted: false, error: 'not_found' });
    }
  });

  it('without a resolver the wildcard is a plain 404 (API-only mode)', async () => {
    const server = buildApp();
    const response = await server.inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(404);
  });
});
