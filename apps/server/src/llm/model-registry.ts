// ModelRegistry: character/function -> provider+model+params (FINAL item 9).
// Pinning a character to one model/provider keeps its prompt cache warm
// (owner decision #3): switching is free but re-warms the cache.
import type { CallKind } from './types.js';

export interface ModelRoute {
  model: string;
  /** OpenRouter provider.order pinning; undefined = let OpenRouter route. */
  providerOrder: readonly string[] | undefined;
  temperature: number;
  maxOutputTokens: number;
}

export interface ModelRegistryConfig {
  defaultModel: string;
  /** character_id -> model override. */
  perCharacter?: Readonly<Record<string, string>>;
  providerOrder?: readonly string[];
}

export interface ModelRegistry {
  routeFor(characterId: string, kind: CallKind): ModelRoute;
}

export function createModelRegistry(
  config: ModelRegistryConfig,
): ModelRegistry {
  return {
    routeFor(characterId: string, kind: CallKind): ModelRoute {
      const model = config.perCharacter?.[characterId] ?? config.defaultModel;
      return {
        model,
        providerOrder: config.providerOrder,
        // narrator/narration write prose; character replies are shorter.
        temperature: kind === 'character' ? 0.9 : 0.8,
        maxOutputTokens: 600,
      };
    },
  };
}
