import { describe, expect, it } from 'vitest';
import { readEnv } from './env.js';

describe('readEnv (B-env boundary)', () => {
  it('applies defaults with a fake-LLM environment', () => {
    const result = readEnv({ WELTARI_FAKE_LLM: '1' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.env.port).toBe(7777);
      expect(result.env.dbPath).toBe('data/weltari.sqlite');
      expect(result.env.fakeLlm).toBe(true);
      expect(result.env.openrouterApiKey).toBeUndefined();
    }
  });

  it('reports the offending key NAME on malformed values — never the value', () => {
    const result = readEnv({
      WELTARI_FAKE_LLM: '1',
      PORT: 'not-a-port-secret-value',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.badKeys).toContain('PORT');
      expect(JSON.stringify(result.badKeys)).not.toContain(
        'not-a-port-secret-value',
      );
    }
  });

  it('requires OPENROUTER_API_KEY when the fake LLM is off', () => {
    const result = readEnv({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.badKeys.join(',')).toContain('OPENROUTER_API_KEY');
    }
    const withKey = readEnv({ OPENROUTER_API_KEY: 'x' });
    expect(withKey.ok).toBe(true);
  });
});
