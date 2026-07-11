// I5 for the GM (M7 part 2, Rev 4 §9): the GM's stable prefix is
// byte-identical across calls — its seed profile is a constant by design
// (the GM's knowledge of the user arrives via the profiling loop, never by
// mutating the profile), so prompt caching holds for the interview's many
// short turns.
import { describe, expect, it } from 'vitest';
import { assembleContext } from '../../../apps/server/src/engine/context-assembler.js';
import {
  buildGmProfile,
  GM_CHARACTER_ID,
} from '../../../apps/server/src/engine/gm.js';

describe('I5 — the GM stable prefix is byte-stable', () => {
  it('two assemblies with different tails share identical prefix bytes', () => {
    const scene = {
      scene_id: 'gm:user:owner',
      heading: 'Conversation',
      world_clock_text: 'You are the GM, outside any scene.',
      wiki: [],
    };
    const first = assembleContext(buildGmProfile(), {
      ...scene,
      latest_turns: [{ speaker: 'User', text: 'Hello!' }],
    });
    const second = assembleContext(buildGmProfile(), {
      ...scene,
      latest_turns: [
        { speaker: 'User', text: 'A completely different message.' },
      ],
    });
    expect(first.stablePrefix).toBe(second.stablePrefix);
    expect(first.dynamicTail).not.toBe(second.dynamicTail);
  });

  it('the GM profile is the fixed persona', () => {
    const profile = buildGmProfile();
    expect(profile.character_id).toBe(GM_CHARACTER_ID);
    expect(profile.name).toBe('GM');
  });
});
