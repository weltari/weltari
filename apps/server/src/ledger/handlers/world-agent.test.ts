import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { ok, type Result } from '../../errors.js';
import { buildNarratorProfile } from '../../engine/fixture/rainy-inn.js';
import { createEventSink } from '../../engine/event-sink.js';
import { Bus } from '../../http/bus.js';
import { createFakeLlmClient } from '../../llm/fake-client.js';
import type { LlmCallResult, LlmClient } from '../../llm/types.js';
import { createRootLogger } from '../../observability/logger.js';
import { openStorage, type Storage } from '../../storage/db.js';
import type { LedgerJob } from '../../storage/repositories/ledger.js';
import { createWorldAgentHandler } from './world-agent.js';

function quietLogger(): ReturnType<typeof createRootLogger> {
  const sink = new Writable({
    write(_chunk, _enc, cb): void {
      cb();
    },
  });
  return createRootLogger({ level: 'debug', stream: sink });
}

function jobWith(payload: unknown): LedgerJob {
  return {
    id: 2,
    idempotency_key: 'world_agent:s1',
    world_id: 'w1',
    type: 'world_agent',
    payload,
    state: 'running',
    attempts: 1,
    max_attempts: 5,
    run_at: '2026-07-06T12:00:00.000Z',
    lease_until: '2026-07-06T12:01:00.000Z',
    worker_id: 'w',
    serial_group: 'world_agent:w1',
    last_error: null,
  };
}

describe('world agent job handler', () => {
  let storage: Storage | null = null;

  afterEach(() => {
    storage?.close();
    storage = null;
  });

  function setup(llm?: LlmClient): {
    storage: Storage;
    handler: ReturnType<typeof createWorldAgentHandler>;
  } {
    const dir = mkdtempSync(join(tmpdir(), 'weltari-worldagent-'));
    const logger = quietLogger();
    storage = openStorage({ dbPath: join(dir, 'w.sqlite') });
    const sink = createEventSink(storage, new Bus(logger));
    const handler = createWorldAgentHandler({
      storage,
      sink,
      llm: llm ?? createFakeLlmClient(),
      narrator: buildNarratorProfile(100),
      logger,
    });
    return { storage, handler };
  }

  it('commits exactly one world_agent.committed, even when re-run', async () => {
    const ctx = setup();
    const job = jobWith({ scene_id: 's1' });

    await ctx.handler(job);
    await ctx.handler(job);

    const notes = ctx.storage.eventLog
      .readSince(0)
      .filter((e) => e.type === 'world_agent.committed');
    expect(notes).toHaveLength(1);
    expect(notes[0]?.actor_id).toBe('system:world_agent');
  });

  it('overlapping executions of ONE job commit exactly one event (lease-expiry overlap, week-7 painter class)', async () => {
    const release: (() => void)[] = [];
    const slow: LlmClient = {
      streamCall: async (): Promise<Result<LlmCallResult>> => {
        await new Promise<void>((r) => release.push(r));
        return ok({
          text: 'The world moves on.',
          usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
          model: 'fake/slow',
          durationMs: 0,
          toolCalls: [],
        });
      },
    };
    const ctx = setup(slow);
    const job = jobWith({ scene_id: 's1' });
    const first = ctx.handler(job);
    const second = ctx.handler({ ...job }); // the reclaimed re-execution
    while (release.length < 2) await new Promise((r) => setTimeout(r, 5));
    for (const r of release) r();
    await Promise.all([first, second]);

    const notes = ctx.storage.eventLog
      .readSince(0)
      .filter((e) => e.type === 'world_agent.committed');
    expect(notes).toHaveLength(1); // the loser no-oped at the fused re-check
  });

  it('garbage payload is corrupt state (Guide C2)', async () => {
    const ctx = setup();
    await expect(ctx.handler(jobWith(42))).rejects.toMatchObject({
      kind: 'corrupt_state',
    });
  });

  it('the subwiki pass (Rev 4 §10): one entry per participating Narrator stub, exactly once', async () => {
    const ctx = setup();
    // A stub created IN the scene, one visited by the scene (created
    // earlier), one unrelated stub, and a transient Flow-B discovery —
    // owner rule: only the first two get wiki entries.
    ctx.storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'char:narrator',
      type: 'sublocation.stub_created',
      payload: {
        scene_id: 's0',
        sublocation_id: 'subloc:stub-the-drying-loft',
        name: 'the drying loft',
        description: 'Hooks and hams under the rafters.',
      },
    });
    ctx.storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'char:narrator',
      type: 'sublocation.stub_created',
      payload: {
        scene_id: 's0',
        sublocation_id: 'subloc:stub-the-mill-yard',
        name: 'the mill yard',
        description: 'Wet cobbles behind the mill.',
      },
    });
    ctx.storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'char:narrator',
      type: 'sublocation.stub_created',
      payload: {
        scene_id: 's1',
        sublocation_id: 'subloc:stub-the-smokehouse',
        name: 'the smokehouse',
        description: 'Fish and hams in the smoke.',
      },
    });
    ctx.storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'char:narrator',
      type: 'sublocation.changed',
      payload: {
        scene_id: 's1',
        sublocation_id: 'subloc:stub-the-drying-loft',
        name: 'the drying loft',
      },
    });
    ctx.storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'system:engine',
      type: 'map_click.resolved',
      payload: {
        click_id: 'c1',
        point: { x: 0.2, y: 0.2 },
        outcome: 'transient',
        name: 'a heron in the reeds',
        description: 'It resolves and vanishes.',
      },
    });

    const job = jobWith({ scene_id: 's1' });
    await ctx.handler(job);
    await ctx.handler(job); // kill-retry: nothing may twin

    const entries = ctx.storage.eventLog
      .readSince(0)
      .filter((e) => e.type === 'subwiki.updated');
    expect(entries.map((e) => e.payload.sublocation_id).sort()).toEqual([
      'subloc:stub-the-drying-loft',
      'subloc:stub-the-smokehouse',
    ]);
    for (const entry of entries) {
      expect(entry.payload.scene_id).toBe('s1');
      expect(entry.payload.entry.length).toBeGreaterThan(0);
      expect(entry.actor_id).toBe('system:world_agent');
    }
    // The mill-yard stub never participated; the transient never could.
    expect(
      entries.some(
        (e) => e.payload.sublocation_id === 'subloc:stub-the-mill-yard',
      ),
    ).toBe(false);
    // The pass is one transaction with world_agent.committed.
    expect(
      ctx.storage.eventLog
        .readSince(0)
        .filter((e) => e.type === 'world_agent.committed'),
    ).toHaveLength(1);
  });

  it('the wiki calls read a NARRATION-ONLY transcript — speech never enters the prompt (week 19, Rev 4 §10 source-typing)', async () => {
    const prompts: { kind: string; prompt: string }[] = [];
    const capturingLlm: LlmClient = {
      streamCall: async (call): Promise<Result<LlmCallResult>> => {
        prompts.push({ kind: call.kind, prompt: call.prompt });
        return Promise.resolve(
          ok({
            text: 'The loft hangs quiet under its hooks.',
            usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
            model: 'fake/capture',
            durationMs: 0,
            toolCalls: [],
          }),
        );
      },
    };
    const ctx = setup(capturingLlm);
    ctx.storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'char:narrator',
      type: 'sublocation.stub_created',
      payload: {
        scene_id: 's1',
        sublocation_id: 'subloc:stub-the-drying-loft',
        name: 'the drying loft',
        description: 'Hooks and hams under the rafters.',
      },
    });
    ctx.storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'system:engine',
      type: 'turn.committed',
      payload: {
        scene_id: 's1',
        turn_id: 't1',
        steps: [
          {
            call: 'narrator',
            speaker: 'Narrator',
            text: 'The loft smells of smoke and old rope.',
          },
          {
            call: 'character',
            speaker: 'Elias',
            text: 'I poisoned the mayor, and the ledger proves it.',
          },
          {
            call: 'narration',
            speaker: 'Narrator',
            text: 'Elias tucks something out of sight.',
          },
        ],
      },
    });

    await ctx.handler(jobWith({ scene_id: 's1' }));

    // Call 1 = the summary note (whole scene — a summary may mention claims);
    // call 2 = the wiki entry (narration-only, by construction).
    expect(prompts).toHaveLength(2);
    const summary = prompts[0];
    const wiki = prompts[1];
    expect(summary?.prompt).toContain('poisoned the mayor');
    expect(wiki?.prompt).not.toContain('poisoned');
    expect(wiki?.prompt).toContain('smells of smoke');
    expect(wiki?.prompt).toContain('tucks something out of sight');
  });

  it('an empty generation writes the name-derived fallback, never nothing (week 19, Rev 4 §10 zero-activity)', async () => {
    const emptyWikiLlm: LlmClient = {
      streamCall: async (call): Promise<Result<LlmCallResult>> => {
        const isWiki = call.prompt.includes('Write the sublocation wiki entry');
        return Promise.resolve(
          ok({
            text: isWiki ? '   ' : 'The world moves on.',
            usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
            model: 'fake/empty-wiki',
            durationMs: 0,
            toolCalls: [],
          }),
        );
      },
    };
    const ctx = setup(emptyWikiLlm);
    ctx.storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'char:narrator',
      type: 'sublocation.stub_created',
      payload: {
        scene_id: 's1',
        sublocation_id: 'subloc:stub-the-park',
        name: 'the park',
        description: 'A park in the city center.',
      },
    });

    await ctx.handler(jobWith({ scene_id: 's1' }));

    const entries = ctx.storage.eventLog
      .readSince(0)
      .filter((e) => e.type === 'subwiki.updated');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.payload.entry).toBe('A park in the city center.');
  });

  it("the parent's wiki gains a mention of a new interior child, exactly once (week 19, Rev 4 §10 lifecycle)", async () => {
    const ctx = setup();
    // The parent already has a wiki entry from an earlier scene.
    ctx.storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'system:world_agent',
      type: 'subwiki.updated',
      payload: {
        sublocation_id: 'subloc:inn',
        scene_id: 's0',
        entry: 'A rain-lashed inn with a low common room.',
      },
    });
    ctx.storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'char:narrator',
      type: 'sublocation.stub_created',
      payload: {
        scene_id: 's1',
        sublocation_id: 'subloc:stub-the-kitchen',
        name: 'the kitchen',
        description: 'Copper pots over a smoke-blacked hearth.',
        parent_id: 'subloc:inn',
      },
    });

    const job = jobWith({ scene_id: 's1' });
    await ctx.handler(job);
    await ctx.handler(job); // kill-retry: nothing may twin

    const parentEntries = ctx.storage.eventLog
      .readSince(0)
      .filter((e) => e.type === 'subwiki.updated')
      .filter((e) => e.payload.sublocation_id === 'subloc:inn');
    // The seeded s0 entry + exactly ONE mention append.
    expect(parentEntries).toHaveLength(2);
    const latest = parentEntries[parentEntries.length - 1];
    expect(latest?.payload.entry).toContain('rain-lashed inn');
    expect(latest?.payload.entry).toContain('the kitchen');
    expect(latest?.payload.entry).toContain('Copper pots');
    // The child got its own entry too.
    expect(
      ctx.storage.eventLog
        .readSince(0)
        .filter((e) => e.type === 'subwiki.updated')
        .filter((e) => e.payload.sublocation_id === 'subloc:stub-the-kitchen'),
    ).toHaveLength(1);
  });

  it('a scene with no participating stubs writes no subwiki entries', async () => {
    const ctx = setup();
    await ctx.handler(jobWith({ scene_id: 's1' }));
    expect(
      ctx.storage.eventLog
        .readSince(0)
        .some((e) => e.type === 'subwiki.updated'),
    ).toBe(false);
  });
});
