// Gate 1 for the GM toolset (M7 part 2, Rev 4 §9/§16, Guide B6): every
// authoring wish is data-only — a malformed or unknown call is rejected as a
// value with ZERO rows; the schemas mirror the wire diffs so nothing that
// passes here is refused by the proposal engine's payload gate for shape
// reasons.
import { describe, expect, it } from 'vitest';
import { parseGmToolCall } from '../../apps/server/src/llm/tools.js';
import { captureLogger } from '../helpers/capture-logger.js';

const { logger } = captureLogger();

describe('I8 — GM tool gate 1 rejects as a value', () => {
  it('accepts every well-formed GM tool', () => {
    const calls = [
      {
        tool: 'propose_place',
        input: {
          name: 'The Mossy Court',
          description: 'A walled yard.',
          space: 'public',
          rationale: 'The town needs one.',
        },
      },
      {
        tool: 'propose_character',
        input: {
          name: 'Odo',
          personality: 'Careful.',
          goals: ['Sell candles.'],
          rationale: 'A keeper for the chandlery.',
        },
      },
      {
        tool: 'propose_wiki_edit',
        input: {
          sublocation_id: 'subloc:shrine',
          entry: 'The bell hangs silent.',
          rationale: 'The record is stale.',
        },
      },
      {
        tool: 'propose_world_seed',
        input: {
          world_name: 'Saltmarsh',
          language: 'en',
          places: [
            {
              name: 'The Square',
              description: 'Open ground.',
              space: 'public',
            },
            {
              name: 'The Low House',
              description: 'A private house.',
              space: 'private',
            },
          ],
          characters: [
            {
              name: 'Senna',
              personality: 'Sharp-eyed.',
              goals: ['Keep the loom house.'],
            },
          ],
          rationale: 'The interview is complete.',
        },
      },
    ];
    for (const raw of calls) {
      const parsed = parseGmToolCall(raw, logger);
      expect(parsed.ok, `${raw.tool} should pass gate 1`).toBe(true);
    }
  });

  it('rejects malformed inputs, extra keys and unknown tools', () => {
    const rejects = [
      { tool: 'propose_place', input: { name: 42 } },
      {
        tool: 'propose_place',
        input: {
          name: 'X',
          description: 'Y',
          space: 'cosmic', // not a space class
          rationale: 'Z',
        },
      },
      {
        tool: 'propose_wiki_edit',
        input: {
          sublocation_id: 's1',
          entry: 'e',
          rationale: 'r',
          force: true, // extra key (B5)
        },
      },
      { tool: 'summon_dragon', input: { size: 'large' } },
    ];
    for (const raw of rejects) {
      const parsed = parseGmToolCall(raw, logger);
      expect(parsed.ok, `${raw.tool} should be rejected`).toBe(false);
    }
  });
});
