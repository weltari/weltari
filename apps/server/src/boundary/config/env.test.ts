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

  it('image backend defaults to the free stub; openrouter is opt-in; junk is rejected', () => {
    const defaulted = readEnv({});
    expect(defaulted.ok).toBe(true);
    if (defaulted.ok) {
      expect(defaulted.env.imageBackend).toBe('stub');
      expect(defaulted.env.imageModel).toBe('google/gemini-3.1-flash-image');
    }
    const real = readEnv({ WELTARI_IMAGE_BACKEND: 'openrouter' });
    expect(real.ok).toBe(true);
    if (real.ok) expect(real.env.imageBackend).toBe('openrouter');
    const junk = readEnv({ WELTARI_IMAGE_BACKEND: 'dall-e' });
    expect(junk.ok).toBe(false);
    if (!junk.ok) expect(junk.badKeys).toContain('WELTARI_IMAGE_BACKEND');
  });
});
