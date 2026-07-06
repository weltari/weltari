// The Week-1 fixture world (builder.md §4.3). Deterministic by construction —
// the lore generator is a pure function of its arguments, so the stable prefix
// built from it is byte-identical across process restarts (Invariant I5 and
// the real-provider cache-hit check both depend on this).
import type { CharacterProfile } from '../context-assembler.js';

export const FIXTURE_WORLD_ID = 'w1';
export const FIXTURE_SCENE_ID = 's1';
export const FIXTURE_SCENE_TITLE = 'The Rainy Inn';

const TOPICS = [
  'the flooded cellar of the Rainy Inn and the casks that float there',
  'the northern trade road and its broken milestone',
  'the innkeeper Marta and her ledger of unpaid tabs',
  'the storm season and how travelers read the clouds',
  'the old shrine behind the stables and its cracked bell',
  'the card game "Wet Boots" and its house rules',
  'the lamplighter rounds and which lamps always die first',
  'the river ferry schedule and the ferryman’s superstitions',
] as const;

/**
 * Deterministic filler lore: no randomness, no clock — the same (count) always
 * yields the same bytes. Roughly 18 tokens per sentence.
 */
export function generateLore(sentenceCount: number): string[] {
  const sentences: string[] = [];
  for (let i = 0; i < sentenceCount; i++) {
    const topic = TOPICS[i % TOPICS.length] ?? TOPICS[0];
    sentences.push(
      `Recorded note ${String(i + 1)}: Elias remembers ${topic}, and files the detail away with the patient care of a man who repairs clocks for a living.`,
    );
  }
  return sentences;
}

/**
 * The fixture character. targetPrefixTokens sizes the memory core so the
 * stable prefix approximates the Week-1 success-criteria fixture (~50K tokens
 * on turn one). ~40 provider tokens per generated sentence — calibrated
 * against gpt-4.1-mini usage accounting on 2026-07-06 (the earlier /29
 * estimate produced 68K real tokens for a 50K target).
 */
export function buildEliasProfile(targetPrefixTokens = 800): CharacterProfile {
  const sentenceCount = Math.max(4, Math.round(targetPrefixTokens / 40));
  return {
    character_id: 'char:elias',
    name: 'Elias the Clockmender',
    skills: [
      'Clock repair: can date any mechanism by its escapement sound.',
      'Weather sense: reads incoming storms from lamp flicker.',
      'Card play: never loses twice at Wet Boots in one evening.',
    ],
    personality:
      'Dry, precise, quietly kind. Speaks in short sentences. Distrusts hurry. Counts things when nervous.',
    memory_core: generateLore(sentenceCount),
    goals: [
      'Reopen the workshop above the inn before storm season ends.',
      'Learn who keeps stopping the shrine bell at midnight.',
    ],
  };
}

/**
 * The narrator makes the FIRST call of every turn, so its prefix carries the
 * ~50K-token load in the success-criteria run (criterion a measures a real
 * big-prefix prefill, not a small warm-up call).
 */
export function buildNarratorProfile(
  targetPrefixTokens = 800,
): CharacterProfile {
  const sentenceCount = Math.max(2, Math.round(targetPrefixTokens / 40));
  return {
    character_id: 'char:narrator',
    name: 'Narrator',
    skills: [
      'Scene-setting: establishes place, weather and mood in two sentences.',
      'Pacing: ends every beat on a hook that invites a reply.',
    ],
    personality:
      'Third-person, present tense, concrete sensory detail. Never speaks for player characters.',
    memory_core: [
      'The Rainy Inn sits where the north road meets the river ferry.',
      'Storm season has just begun; the common room smells of wet wool.',
      ...generateLore(sentenceCount),
    ],
    goals: [
      'Keep the scene moving; hand the spotlight to a character each turn.',
    ],
  };
}
