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

  it('boots without OPENROUTER_API_KEY — fresh installs run the FakeLLM', () => {
    // Changed at the packaging milestone: the old assertion (missing key
    // aborts boot) made a clean zip/Docker boot impossible. A missing
    // OPTIONAL secret is a legal fresh-install state (B11 bans malformed
    // present values); main.ts falls back to the FakeLLM and warns loudly.
    const result = readEnv({});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.env.openrouterApiKey).toBeUndefined();
      expect(result.env.fakeLlm).toBe(false);
    }
    const withKey = readEnv({ OPENROUTER_API_KEY: 'x' });
    expect(withKey.ok).toBe(true);
  });
});
