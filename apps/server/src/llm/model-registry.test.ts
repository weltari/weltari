import { describe, expect, it } from 'vitest';
import { createModelRegistry } from './model-registry.js';

describe('ModelRegistry', () => {
  it('routes to the default model with no pinning', () => {
    const registry = createModelRegistry({
      defaultModel: 'google/gemini-2.5-flash',
    });
    const route = registry.routeFor('char:elias', 'character');
    expect(route.model).toBe('google/gemini-2.5-flash');
    expect(route.providerOrder).toBeUndefined();
  });

  it('per-character override wins (owner decision #3: pin by default, switch freely)', () => {
    const registry = createModelRegistry({
      defaultModel: 'google/gemini-2.5-flash',
      perCharacter: { 'char:elias': 'anthropic/claude-sonnet-4.5' },
    });
    expect(registry.routeFor('char:elias', 'character').model).toBe(
      'anthropic/claude-sonnet-4.5',
    );
    expect(registry.routeFor('char:narrator', 'narrator').model).toBe(
      'google/gemini-2.5-flash',
    );
  });

  it('passes the provider order through for cache pinning', () => {
    const registry = createModelRegistry({
      defaultModel: 'openai/gpt-4.1-mini',
      providerOrder: ['openai'],
    });
    expect(registry.routeFor('char:elias', 'narration').providerOrder).toEqual([
      'openai',
    ]);
  });
});
