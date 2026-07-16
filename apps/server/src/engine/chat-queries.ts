// The chat query escalation executors (M6 part 3, Rev 4 §11: "latest-per-
// origin instantly; escalate to scene-query → session read for specifics").
// Both are READ-ONLY mid-call executors offered through the proven
// LlmCall.queries seam (weeks 9/10) — they route context back to the model
// and can never mutate anything. Inputs arrive as unvalidated provider JSON;
// each executor safeParses and answers malformed input with an error string
// the model can react to (the query_sublocations contract).
import {
  ExploreToolSchema,
  MemoryqueryToolSchema,
  SessionqueryToolSchema,
  WikiqueryToolSchema,
} from '../llm/tools.js';
import { validateAt } from '../boundary/validate.js';
import type { Logger } from '../observability/logger.js';
import type { Storage } from '../storage/db.js';
import { knownSublocations } from './sublocations.js';

/** Case-insensitive token match: EVERY meaningful query token must appear in
 * the haystack (names, descriptions, entries) — "the moon palace" must not
 * hit everything just because "the" does. Deterministic, no scoring. */
function matches(query: string, haystack: string): boolean {
  const target = haystack.toLowerCase();
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 3);
  const meaningful = tokens.length > 0 ? tokens : [query.toLowerCase().trim()];
  return meaningful.every((t) => target.includes(t));
}

const RESULT_CAP = 3;

/**
 * wikiquery: what is publicly known about a place — the sublocation registry
 * (names + stub descriptions) merged with the SUBWIKI projection (latest of
 * subwiki.updated AND subwiki.edited per sublocation wins — M6 part 5: a
 * manual user edit is wiki truth for every read from the moment it lands;
 * Rev 4 §10 tier 2 is a relevance scope, not secrecy, so chat may read it
 * freely).
 */
export function runWikiquery(
  storage: Storage,
  worldId: string,
  logger: Logger,
  input: unknown,
): string {
  const parsed = validateAt(
    'llm',
    'tool:wikiquery',
    WikiqueryToolSchema,
    input,
    logger,
  );
  if (!parsed.ok) {
    return 'ERROR: wikiquery needs { query: string } — one line of place keywords.';
  }
  const query = parsed.value.query;
  const latestEntry = new Map<string, string>();
  for (const event of storage.eventLog.readSince(0, 100000)) {
    if (
      (event.type === 'subwiki.updated' || event.type === 'subwiki.edited') &&
      event.world_id === worldId
    ) {
      latestEntry.set(event.payload.sublocation_id, event.payload.entry);
    }
  }
  const hits: string[] = [];
  for (const sub of knownSublocations(storage, worldId)) {
    const entry = latestEntry.get(sub.sublocation_id);
    const text = `${sub.name} ${sub.description} ${entry ?? ''}`;
    if (!matches(query, text)) continue;
    hits.push(
      `- ${sub.name} (${sub.sublocation_id}): ${entry ?? sub.description}`,
    );
    if (hits.length >= RESULT_CAP) break;
  }
  return hits.length === 0
    ? `No wiki entry matches "${query}".`
    : `Wiki results for "${query}":\n${hits.join('\n')}`;
}

/**
 * explore (M7 part 3, Rev 4 §14): pure retrieval, no LLM call — the
 * sublocation's wiki (latest entry, else its description) + the objects
 * publicly held there (V1 objects are sublocation-held only, hence public —
 * owner ruling 2026-07-16) + the sublocations one level deeper. Exploring is
 * the character's choice; the information is open to anyone present. Reads
 * committed state only — this turn's staged effects are not yet world truth.
 */
export function runExploreQuery(
  storage: Storage,
  worldId: string,
  currentSublocationId: string,
  logger: Logger,
  input: unknown,
): string {
  const parsed = validateAt(
    'llm',
    'tool:explore',
    ExploreToolSchema,
    input,
    logger,
  );
  if (!parsed.ok) {
    return 'ERROR: explore takes { sublocation_id?: string } — omit it for the place you are in.';
  }
  const targetId = parsed.value.sublocation_id ?? currentSublocationId;
  const known = knownSublocations(storage, worldId);
  const target = known.find((s) => s.sublocation_id === targetId);
  if (target === undefined) {
    return `No sublocation ${targetId} exists in this world.`;
  }
  let entry: string | undefined;
  for (const event of storage.eventLog.readSince(0, 100000)) {
    if (
      (event.type === 'subwiki.updated' || event.type === 'subwiki.edited') &&
      event.world_id === worldId &&
      event.payload.sublocation_id === targetId
    ) {
      entry = event.payload.entry;
    }
  }
  const objects = storage.objects.heldAt(worldId, targetId);
  const objectLines = objects.map((o) => {
    const detail =
      o.payload === undefined
        ? 'nothing written about it yet'
        : o.payload.length > 200
          ? `${o.payload.slice(0, 200)}…`
          : o.payload;
    return `- ${o.name} (${o.object_id}): ${detail}`;
  });
  const children = known.filter((s) => s.parent_id === targetId);
  return [
    `${target.name} (${target.sublocation_id}): ${entry ?? target.description}`,
    objectLines.length === 0
      ? 'Objects here: none recorded.'
      : `Objects here:\n${objectLines.join('\n')}`,
    children.length === 0
      ? 'No deeper places recorded here.'
      : `One level deeper:\n${children
          .map((c) => `- ${c.name} (${c.sublocation_id}): ${c.description}`)
          .join('\n')}`,
  ].join('\n');
}

/**
 * sessionquery — scene-query (Rev 4 §11 knowledge tier 3): find a past scene
 * via its World-Agent recap, then read that session's history directly.
 * PARTICIPATION-GATED: only scenes whose scene.ended participants include
 * this character are searchable — the gate is structural, not prompt-level.
 */
export function runSessionquery(
  storage: Storage,
  worldId: string,
  characterId: string,
  logger: Logger,
  input: unknown,
): string {
  const parsed = validateAt(
    'llm',
    'tool:sessionquery',
    SessionqueryToolSchema,
    input,
    logger,
  );
  if (!parsed.ok) {
    return 'ERROR: sessionquery needs { query: string } — one line of keywords about a past scene.';
  }
  const query = parsed.value.query;
  const participated = new Set<string>();
  const titles = new Map<string, string>();
  const recaps = new Map<string, string>();
  const lines = new Map<string, string[]>();
  for (const event of storage.eventLog.readSince(0, 100000)) {
    if (event.world_id !== worldId) continue;
    if (event.type === 'scene.started') {
      titles.set(event.payload.scene_id, event.payload.title);
    } else if (
      event.type === 'scene.ended' &&
      event.payload.participants.includes(characterId)
    ) {
      participated.add(event.payload.scene_id);
    } else if (event.type === 'world_agent.committed') {
      recaps.set(event.payload.scene_id, event.payload.note);
    } else if (event.type === 'turn.committed') {
      const sceneLines = lines.get(event.payload.scene_id) ?? [];
      for (const step of event.payload.steps) {
        sceneLines.push(`${step.speaker}: ${step.text}`);
      }
      lines.set(event.payload.scene_id, sceneLines);
    }
  }
  for (const sceneId of participated) {
    const recap = recaps.get(sceneId);
    if (recap === undefined) continue; // no recap yet — not searchable
    const title = titles.get(sceneId) ?? sceneId;
    if (!matches(query, `${title} ${recap}`)) continue;
    const tail = (lines.get(sceneId) ?? []).slice(-8);
    return [
      `You remember the scene "${title}": ${recap}`,
      ...(tail.length === 0 ? [] : ['Its final lines:', ...tail]),
    ].join('\n');
  }
  return `No past scene of yours matches "${query}" (you can only recall scenes you were part of).`;
}

/**
 * memoryquery (M7 part 1, Rev 4 §11): the deep dive into the character's OWN
 * memory archive — BM25 over its deltas via the FTS5 Search Index (Rev 4
 * §4.2). Participation-gated by construction twice over: the executor is
 * bound to one character id at the call site, and the index itself filters
 * on the character column. Latest-per-origin CACHE stays the instant answer;
 * this is the escalation when the past is buried deeper.
 */
export function runMemoryquery(
  storage: Storage,
  characterId: string,
  logger: Logger,
  input: unknown,
): string {
  const parsed = validateAt(
    'llm',
    'tool:memoryquery',
    MemoryqueryToolSchema,
    input,
    logger,
  );
  if (!parsed.ok) {
    return 'ERROR: memoryquery needs { query: string } — one line of keywords about your own past.';
  }
  const query = parsed.value.query;
  const hits = storage.memoryIndex.search(characterId, query, RESULT_CAP);
  if (hits.length === 0) {
    return `No memory of yours matches "${query}" (only your own memories are searchable).`;
  }
  return [
    'You remember (most relevant first):',
    ...hits.map((h) => `- ${h.content}`),
  ].join('\n');
}
