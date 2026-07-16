// Gate 1 of the B6 double gate (I8): shape validation of raw tool calls.
// Fixtures that need wrong-shaped data are declared unknown (Guide §0.12).
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createRootLogger } from '../observability/logger.js';
import {
  parseCharacterSceneToolCall,
  parseToolCall,
  type RawToolCall,
} from './tools.js';

function quietLogger(): ReturnType<typeof createRootLogger> {
  const sink = new Writable({
    write(_c, _e, cb): void {
      cb();
    },
  });
  return createRootLogger({ level: 'debug', stream: sink });
}

const logger = quietLogger();

function raw(tool: string, input: unknown): RawToolCall {
  return { tool, input };
}

describe('parseToolCall (B6 gate 1)', () => {
  it('accepts well-formed calls for all three narrator tools', () => {
    expect(parseToolCall(raw('end_scene', { type: 'rest' }), logger).ok).toBe(
      true,
    );
    expect(
      parseToolCall(
        raw('end_scene', { type: 'continuation', divider_text: '— dusk —' }),
        logger,
      ).ok,
    ).toBe(true);
    expect(
      parseToolCall(
        raw('change_sublocation', { sublocation_id: 'subloc:cellar' }),
        logger,
      ).ok,
    ).toBe(true);
    expect(
      parseToolCall(
        raw('switch_art', { character_id: 'char:elias', art_id: 'smile' }),
        logger,
      ).ok,
    ).toBe(true);
  });

  it('rejects malformed inputs (wrong type, missing key, unknown enum)', () => {
    expect(
      parseToolCall(raw('switch_art', { character_id: 42 }), logger).ok,
    ).toBe(false);
    expect(parseToolCall(raw('change_sublocation', {}), logger).ok).toBe(false);
    expect(
      parseToolCall(raw('end_scene', { type: 'hard_cut' }), logger).ok,
    ).toBe(false);
  });

  it('rejects extra keys — our own tool formats are strict (B5)', () => {
    expect(
      parseToolCall(raw('end_scene', { type: 'rest', force: true }), logger).ok,
    ).toBe(false);
  });

  it('rejects unknown tool names', () => {
    const result = parseToolCall(raw('summon_dragon', {}), logger);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('unknown_tool');
  });

  it('accepts create_sublocation for interiors and parentless places (M6 part 1)', () => {
    expect(
      parseToolCall(
        raw('create_sublocation', {
          name: 'The Inn Kitchen',
          brief: 'Steam and copper pots behind the common room.',
          parent_id: 'subloc:common_room',
        }),
        logger,
      ).ok,
    ).toBe(true);
    expect(
      parseToolCall(
        raw('create_sublocation', {
          name: 'The River Park',
          brief: 'Willows over slow water.',
          narrative_anchor: 'near the riverside',
        }),
        logger,
      ).ok,
    ).toBe(true);
  });

  it('rejects create_sublocation with a missing brief or extra key (B5)', () => {
    expect(
      parseToolCall(raw('create_sublocation', { name: 'X' }), logger).ok,
    ).toBe(false);
    expect(
      parseToolCall(
        raw('create_sublocation', {
          name: 'X',
          brief: 'y',
          map_position: { x: 0.5, y: 0.5 },
        }),
        logger,
      ).ok,
    ).toBe(false);
  });

  it('accepts end_scene with a next_scene registration; rejects a malformed one', () => {
    expect(
      parseToolCall(
        raw('end_scene', {
          type: 'continuation',
          next_scene: { sublocation_id: 'subloc:stub-the-river-park' },
        }),
        logger,
      ).ok,
    ).toBe(true);
    expect(
      parseToolCall(
        raw('end_scene', {
          type: 'continuation',
          next_scene: { sublocation_id: '' },
        }),
        logger,
      ).ok,
    ).toBe(false);
  });

  it('rejects a query_sublocations arriving as a staged call (it executes mid-call)', () => {
    const result = parseToolCall(
      raw('query_sublocations', { mode: 'parentless' }),
      logger,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('query_not_stageable');
  });

  it('rejects interact_object — a character tool the Narrator can never stage (M7 part 3)', () => {
    const result = parseToolCall(
      raw('interact_object', { object: 'a brass key' }),
      logger,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('unknown_tool');
  });
});

describe('parseCharacterSceneToolCall (B6 gate 1, M7 part 3)', () => {
  it('accepts a well-formed interact_object in each field mix', () => {
    for (const input of [
      { object: 'a brass key' },
      { object: 'a brass key', payload: 'Its teeth are filed flat.' },
      { object: 'obj:brass-key-1234', move_to: 'subloc:cellar' },
    ]) {
      expect(
        parseCharacterSceneToolCall(raw('interact_object', input), logger).ok,
      ).toBe(true);
    }
  });

  it('rejects malformed inputs and the narrator toolset (B5/I8)', () => {
    for (const call of [
      raw('interact_object', { payload: 'no object named' }),
      raw('interact_object', { object: '' }),
      raw('interact_object', { object: 'x', payload: 'y', admin: true }),
      raw('end_scene', { type: 'rest' }),
      raw('summon_dragon', { size: 'large' }),
    ]) {
      expect(parseCharacterSceneToolCall(call, logger).ok).toBe(false);
    }
  });

  it('rejects the mid-call queries arriving as staged calls', () => {
    for (const tool of ['explore', 'memoryquery', 'wikiquery']) {
      const result = parseCharacterSceneToolCall(raw(tool, {}), logger);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('query_not_stageable');
    }
  });
});
