// The World Agent job handler — one per world at a time (serial_group on the
// row; the claim query enforces it, Brief §2.2). Same idempotent-projection
// shape as reflection: retry after a kill -9 re-runs the LLM but can only
// commit the world_agent.committed event once.
//
// M6 part 2 (Rev 4 §10): the scene-end pass also writes the SUBWIKI — one
// entry per Narrator-created sublocation that participated in the scene
// (owner rule, week 9: created = gets a wiki; transient/mentioned-only
// places never do). All entries + world_agent.committed land in ONE
// transaction, so the natural key (the committed event) keeps the whole
// pass exactly-once under kill-retry.
import { z } from 'zod';
import type { NewEvent } from '../../storage/repositories/event-log.js';
import { CorruptStateError } from '../../errors.js';
import type { CharacterProfile } from '../../engine/context-assembler.js';
import { assembleContext } from '../../engine/context-assembler.js';
import type { EventSink } from '../../engine/event-sink.js';
import type { Logger } from '../../observability/logger.js';
import type { LlmClient } from '../../llm/types.js';
import type { Storage } from '../../storage/db.js';
import type { JobHandler } from '../runner.js';
import { sceneNarrationTranscript, sceneTranscript } from './reflection.js';

const SUBWIKI_ENTRY_MAX = 4000;

interface ParticipatingStub {
  sublocation_id: string;
  name: string;
  description: string;
  /** The exterior-atomic parent (Rev 4 §6 flat hierarchy), when interior. */
  parent_id?: string;
}

/**
 * The sublocations this scene owes wiki entries (Rev 4 §10 + the week-9
 * owner rule): Narrator-created stubs that were created IN the scene or that
 * the scene moved into. Flow-B transients and prose-only mentions are never
 * rows, so they can never appear here — texture stays texture.
 */
function participatingStubs(
  storage: Storage,
  sceneId: string,
): ParticipatingStub[] {
  const stubsById = new Map<string, ParticipatingStub>();
  const participating = new Set<string>();
  for (const event of storage.eventLog.readSince(0, 100000)) {
    if (event.type === 'sublocation.stub_created') {
      stubsById.set(event.payload.sublocation_id, {
        sublocation_id: event.payload.sublocation_id,
        name: event.payload.name,
        description: event.payload.description,
        ...(event.payload.parent_id === undefined
          ? {}
          : { parent_id: event.payload.parent_id }),
      });
      if (event.payload.scene_id === sceneId) {
        participating.add(event.payload.sublocation_id);
      }
    } else if (
      event.type === 'sublocation.changed' &&
      event.payload.scene_id === sceneId &&
      stubsById.has(event.payload.sublocation_id)
    ) {
      participating.add(event.payload.sublocation_id);
    }
  }
  return [...participating].flatMap((id) => {
    const stub = stubsById.get(id);
    return stub === undefined ? [] : [stub];
  });
}

const payloadSchema = z.strictObject({
  scene_id: z.string().min(1),
});

export interface WorldAgentHandlerOptions {
  storage: Storage;
  sink: EventSink;
  llm: LlmClient;
  /** The narrator-class profile the World Agent speaks with. */
  narrator: CharacterProfile;
  logger: Logger;
}

export function createWorldAgentHandler(
  options: WorldAgentHandlerOptions,
): JobHandler {
  const { storage, sink, llm, narrator, logger } = options;

  return async (job): Promise<void> => {
    const payload = payloadSchema.safeParse(job.payload);
    if (!payload.success) {
      throw new CorruptStateError(
        'world_agent_payload',
        `job ${String(job.id)} payload does not match {scene_id}`,
      );
    }
    const { scene_id } = payload.data;

    const already = storage.eventLog
      .readSince(0, 100000)
      .some(
        (e) =>
          e.type === 'world_agent.committed' && e.payload.scene_id === scene_id,
      );
    if (already) {
      logger.debug(
        { job_id: job.id, scene_id },
        'world agent already committed — idempotent no-op',
      );
      return;
    }

    const context = assembleContext(narrator, {
      scene_id,
      world_clock_text: 'The scene has just ended.',
      latest_turns: sceneTranscript(storage, scene_id),
      wiki: [],
    });
    const result = await llm.streamCall({
      kind: 'world_agent',
      characterId: narrator.character_id,
      system: context.stablePrefix,
      prompt: `${context.dynamicTail}\n\n## Instruction\nAs the world agent, note in 1-3 sentences how the world moves on after this scene (weather, schedules, off-screen consequences). Third person, factual.`,
      onTextDelta: (): void => undefined,
    });
    if (!result.ok) throw result.error; // operational -> runner retries (C7)

    // The subwiki pass (Rev 4 §10): one entry per participating
    // Narrator-created sublocation, observable-now snapshots only. Each
    // generation is its own call; a failure retries the whole job (nothing
    // committed yet — the pass is one transaction below).
    //
    // Week 19 (§10 source-typing, hardened): the wiki calls read a
    // NARRATION-ONLY transcript — `character` steps never enter the prompt,
    // so speech is excluded by construction, not by instruction. The summary
    // note above reads the whole scene (a summary may mention claims).
    const wikiContext = assembleContext(narrator, {
      scene_id,
      world_clock_text: 'The scene has just ended.',
      latest_turns: sceneNarrationTranscript(storage, scene_id),
      wiki: [],
    });
    // The latest-wins wiki view (the chat-queries fold): the base the
    // zero-activity fallback and the parent-mention dedup both read; staged
    // entries from THIS pass overlay it as they are built.
    const latestEntries = new Map<string, string>();
    for (const event of storage.eventLog.readSince(0, 100000)) {
      if (
        (event.type === 'subwiki.updated' || event.type === 'subwiki.edited') &&
        event.world_id === job.world_id
      ) {
        latestEntries.set(event.payload.sublocation_id, event.payload.entry);
      }
    }

    const subwikiEvents: NewEvent[] = [];
    const stubs = participatingStubs(storage, scene_id);
    for (const stub of stubs) {
      const entryResult = await llm.streamCall({
        kind: 'world_agent',
        characterId: narrator.character_id,
        system: wikiContext.stablePrefix,
        prompt: `${wikiContext.dynamicTail}\n\n## Instruction\nWrite the sublocation wiki entry for "${stub.name}" (${stub.sublocation_id}) in 2-4 sentences: what fresh eyes would observe at this place RIGHT NOW, grounded only in the scene's narration and the place's brief ("${stub.description}"). Observable-now state only — never events that happened, never things characters merely said. Third person, present tense.`,
        onTextDelta: (): void => undefined,
      });
      if (!entryResult.ok) throw entryResult.error; // operational -> retry (C7)
      const generated = entryResult.value.text
        .trim()
        .slice(0, SUBWIKI_ENTRY_MAX);
      // Week 19 (Rev 4 §10 zero-activity fallback): a scene that ended with
      // no usable narration still leaves the place its name-derived brief —
      // the World Agent cannot invent facts, only observe, and the
      // Narrator's own brief is the one observation that always exists.
      const entry =
        generated === ''
          ? stub.description.slice(0, SUBWIKI_ENTRY_MAX)
          : generated;
      if (generated === '') {
        logger.debug(
          { scene_id, sublocation_id: stub.sublocation_id },
          'subwiki entry came back empty — name-derived fallback written',
        );
      }
      subwikiEvents.push({
        world_id: job.world_id,
        actor_id: 'system:world_agent',
        type: 'subwiki.updated',
        payload: {
          sublocation_id: stub.sublocation_id,
          scene_id,
          entry,
        },
      });
      latestEntries.set(stub.sublocation_id, entry);
    }

    // Week 19 (Rev 4 §10 lifecycle): the PARENT's wiki gains a natural
    // mention of any new interior child — fresh eyes at the café can tell it
    // has a kitchen. Deterministic (no LLM call: the mention only restates
    // the stub's own brief); the contains-check keeps re-runs and later
    // scenes from stacking duplicates.
    for (const stub of stubs) {
      if (stub.parent_id === undefined) continue;
      const current = latestEntries.get(stub.parent_id) ?? '';
      if (current.includes(stub.name)) continue;
      const mention = `Inside lies ${stub.name} — ${stub.description}`;
      const entry = (current === '' ? mention : `${current}\n${mention}`).slice(
        0,
        SUBWIKI_ENTRY_MAX,
      );
      subwikiEvents.push({
        world_id: job.world_id,
        actor_id: 'system:world_agent',
        type: 'subwiki.updated',
        payload: {
          sublocation_id: stub.parent_id,
          scene_id,
          entry,
        },
      });
      latestEntries.set(stub.parent_id, entry);
    }

    // Last-instant idempotency re-check, NO await between it and the append
    // (the week-7 painter lease-expiry overlap class, docs/painter.md): the
    // loser of an overlapped retry lands here, sees the winner's event, no-ops.
    // The subwiki entries ride the same transaction, so the ONE natural key
    // (world_agent.committed per scene) covers the entire pass.
    const committedMeanwhile = storage.eventLog
      .readSince(0, 100000)
      .some(
        (e) =>
          e.type === 'world_agent.committed' && e.payload.scene_id === scene_id,
      );
    if (committedMeanwhile) {
      logger.warn(
        { job_id: job.id, scene_id },
        'world agent overlapped its own lease-expiry retry — one duplicate generation, zero duplicate events',
      );
      return;
    }
    sink.appendMany([
      ...subwikiEvents,
      {
        world_id: job.world_id,
        actor_id: 'system:world_agent',
        type: 'world_agent.committed',
        payload: { scene_id, note: result.value.text },
      },
    ]);
  };
}
