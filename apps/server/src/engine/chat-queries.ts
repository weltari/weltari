// The chat query escalation executors (M6 part 3, Rev 4 §11: "latest-per-
// origin instantly; escalate to scene-query → session read for specifics").
// Both are READ-ONLY mid-call executors offered through the proven
// LlmCall.queries seam (weeks 9/10) — they route context back to the model
// and can never mutate anything. Inputs arrive as unvalidated provider JSON;
// each executor safeParses and answers malformed input with an error string
// the model can react to (the query_sublocations contract).
// memoryquery is DEFERRED to M7 (the real memory store) — not stubbed.
import { SessionqueryToolSchema, WikiqueryToolSchema } from '../llm/tools.js';
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
 * (names + stub descriptions) merged with the SUBWIKI projection (latest
 * subwiki.updated per sublocation wins; Rev 4 §10 tier 2 is a relevance
 * scope, not secrecy, so chat may read it freely).
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
    if (event.type === 'subwiki.updated' && event.world_id === worldId) {
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
