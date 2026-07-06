// B-env: the ONLY file that reads process.env (Guide B15, enforced by
// n/no-process-env everywhere else). Invalid env aborts boot printing the
// offending NAMES, never values. console is allowed here: the logger does not
// exist yet (Guide A15 exception).
import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(7777),
  WELTARI_DB_PATH: z.string().min(1).default('data/weltari.sqlite'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
  /** Secret. Required only when the real provider is used (WELTARI_FAKE_LLM unset). */
  OPENROUTER_API_KEY: z.string().min(1).optional(),
  /** '1' routes all LLM calls to the deterministic fake (kill harness, CI). */
  WELTARI_FAKE_LLM: z.string().optional(),
  /** '1' prints FAULT_POINT:<name> lines the kill harness targets. */
  WELTARI_EMIT_FAULT_POINTS: z.string().optional(),
  /** OpenRouter model id for all Week-1 calls (256K-class recommended). */
  WELTARI_MODEL: z.string().min(1).default('google/gemini-2.5-flash'),
  /** Comma-separated OpenRouter provider.order pin (cache stability, FINAL risk #1). */
  WELTARI_PROVIDER_ORDER: z.string().optional(),
  /** Stable-prefix size for the fixture profile (success criterion a: ~50000). */
  WELTARI_PREFIX_TOKENS: z.coerce.number().int().positive().default(800),
});

export interface Env {
  port: number;
  dbPath: string;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  openrouterApiKey: string | undefined;
  fakeLlm: boolean;
  emitFaultPoints: boolean;
  model: string;
  providerOrder: readonly string[] | undefined;
  prefixTokens: number;
}

export type EnvResult =
  { ok: true; env: Env } | { ok: false; badKeys: string[] };

export function readEnv(
  raw: Record<string, string | undefined> = process.env,
): EnvResult {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const badKeys = [
      ...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? '?'))),
    ];
    return { ok: false, badKeys };
  }
  const fakeLlm = parsed.data.WELTARI_FAKE_LLM === '1';
  if (!fakeLlm && parsed.data.OPENROUTER_API_KEY === undefined) {
    return {
      ok: false,
      badKeys: ['OPENROUTER_API_KEY (required unless WELTARI_FAKE_LLM=1)'],
    };
  }
  return {
    ok: true,
    env: {
      port: parsed.data.PORT,
      dbPath: parsed.data.WELTARI_DB_PATH,
      logLevel: parsed.data.LOG_LEVEL,
      openrouterApiKey: parsed.data.OPENROUTER_API_KEY,
      fakeLlm,
      emitFaultPoints: parsed.data.WELTARI_EMIT_FAULT_POINTS === '1',
      model: parsed.data.WELTARI_MODEL,
      providerOrder:
        parsed.data.WELTARI_PROVIDER_ORDER === undefined
          ? undefined
          : parsed.data.WELTARI_PROVIDER_ORDER.split(',')
              .map((p) => p.trim())
              .filter((p) => p.length > 0),
      prefixTokens: parsed.data.WELTARI_PREFIX_TOKENS,
    },
  };
}

/** Boot-time wrapper: prints names (never values) and reports failure. */
export function readEnvOrExplain(): Env | null {
  const result = readEnv();
  if (!result.ok) {
    console.error(
      `invalid environment: ${result.badKeys.join(', ')} — see .env.example`,
    );
    return null;
  }
  return result.env;
}
