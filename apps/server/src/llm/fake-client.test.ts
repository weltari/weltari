import { describe, expect, it } from 'vitest';
import { createFakeLlmClient } from './fake-client.js';

describe('FakeLLM first-token delay (§1.14 latency injection)', () => {
  it('delayed and undelayed calls stream the identical scripted text', async () => {
    const collect = (deltas: string[]) => (delta: string) => {
      deltas.push(delta);
    };
    const plainDeltas: string[] = [];
    const plain = await createFakeLlmClient().streamCall({
      kind: 'narrator',
      characterId: 'char:narrator',
      system: 's',
      prompt: 'p',
      onTextDelta: collect(plainDeltas),
    });
    const delayedDeltas: string[] = [];
    const delayed = await createFakeLlmClient({
      firstTokenDelayMs: 5,
    }).streamCall({
      kind: 'narrator',
      characterId: 'char:narrator',
      system: 's',
      prompt: 'p',
      onTextDelta: collect(delayedDeltas),
    });
    expect(plain.ok).toBe(true);
    expect(delayed.ok).toBe(true);
    if (plain.ok && delayed.ok) {
      expect(delayed.value.text).toBe(plain.value.text);
    }
    expect(delayedDeltas).toEqual(plainDeltas);
  });
});
