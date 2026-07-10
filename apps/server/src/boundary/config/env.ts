// B-env: the ONLY file that reads process.env (Guide B15, enforced by
// n/no-process-env everywhere else). Invalid env aborts boot printing the
// offending NAMES, never values. console is allowed here: the logger does not
// exist yet (Guide A15 exception).
import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(7777),
  /** Listen address. Default loopback-only; the Docker image sets 0.0.0.0
   * (the container boundary is the exposure decision there). */
  WELTARI_HOST: z.string().min(1).default('127.0.0.1'),
  WELTARI_DB_PATH: z.string().min(1).default('data/weltari.sqlite'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
  /** Secret. Required only when the real provider is used (WELTARI_FAKE_LLM unset). */
  OPENROUTER_API_KEY: z.string().min(1).optional(),
  /** Secret. Optional: absent = the Telegram connector stays stopped. */
  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  /** '1' routes all LLM calls to the deterministic fake (kill harness, CI). */
  WELTARI_FAKE_LLM: z.string().optional(),
  /** FakeLLM first-token hold (ms) — simulates the 5–10 s generation window
   * the §1.14 masking animations must cover. */
  WELTARI_FAKE_LLM_DELAY_MS: z.coerce.number().int().nonnegative().default(0),
  /** '1' prints FAULT_POINT:<name> lines the kill harness targets. */
  WELTARI_EMIT_FAULT_POINTS: z.string().optional(),
  /** OpenRouter model id for all Week-1 calls. Default = the configuration that
   * passed all Week-1 criteria (deterministic cache_control, fast prefill). */
  WELTARI_MODEL: z.string().min(1).default('anthropic/claude-sonnet-4.5'),
  /** Comma-separated OpenRouter provider.order pin (cache stability, FINAL risk #1). */
  WELTARI_PROVIDER_ORDER: z.string().optional(),
  /** Stable-prefix size for the fixture profile (success criterion a: ~50000). */
  WELTARI_PREFIX_TOKENS: z.coerce.number().int().positive().default(800),
  /** Harness only: hold at between_calls/pre_commit so SIGKILL lands inside the window. */
  WELTARI_FAULT_PAUSE_MS: z.coerce.number().int().nonnegative().default(0),
  /** Job lease length. The kill harness shortens it so a killed-mid-job lease
   * expires (and the sweep reclaims the job) within one harness cycle. */
  WELTARI_LEASE_SECONDS: z.coerce.number().int().positive().default(60),
  /** Chat idle timeout in minutes (Rev 4 §8; owner default 30, 2026-07-09):
   * an untouched conversation range closes and its reflect_chat enqueues.
   * Demos/harness set fractions (0.05 = 3 s) — the sweep works in ms. */
  WELTARI_CHAT_IDLE_MINUTES: z.coerce.number().positive().default(30),
  /** Proactive CRON DM cadence in GAME minutes (M6 part 4, Rev 4 §8; owner
   * ruling 2026-07-10/11: CRON fires only when the world clock advances —
   * never on wall time; a paused world sends nothing). Default 1440 = once
   * per fictional day (DMs are ON by default — owner ruling 2026-07-11);
   * 0 = disabled. Each fire is one chat-class LLM call on a real backend;
   * fires per advance are additionally capped at the freeze cap. */
  WELTARI_CRON_DM_GAME_MINUTES: z.coerce.number().nonnegative().default(1440),
  /** Image pixels live as files here; rows/events hold path + hash (Brief §1). */
  WELTARI_IMAGES_DIR: z.string().min(1).default('data/images'),
  /** Painter tile source. 'stub' (default) = deterministic, free, offline —
   * tests/harness/CI never touch a provider. 'openrouter' = real generation
   * (needs OPENROUTER_API_KEY; silently stays on stub without one). */
  WELTARI_IMAGE_BACKEND: z.enum(['stub', 'openrouter']).default('stub'),
  /** OpenRouter image model for the real painter backend. */
  WELTARI_IMAGE_MODEL: z
    .string()
    .min(1)
    .default('google/gemini-3.1-flash-image'),
  /** OpenRouter image model for Flow-A EDITS (mode 'modify'). Week-8 visual
   * QA: flash-class reproduces its reference and drawn features never appear;
   * pro-class (~4× cost, but edits are rare and user-triggered) paints them
   * legibly. Reveals stay on WELTARI_IMAGE_MODEL. */
  WELTARI_EDIT_IMAGE_MODEL: z
    .string()
    .min(1)
    .default('google/gemini-3-pro-image'),
  /** OpenRouter multimodal model for the VLM seam (map QA now, Flow B in M5
   * part 2). Cold-path classification — flash-class is plenty (§16 #3). */
  WELTARI_VLM_MODEL: z.string().min(1).default('google/gemini-3.5-flash'),
  /** Drop-in plugin folders live here (FINAL item 13, Guide B10). */
  WELTARI_PLUGINS_DIR: z.string().min(1).default('plugins'),
  /** The built frontend (FINAL item 2). Unset = resolved next to the compiled
   * server (apps/web/dist in-repo and in the packaged layout). */
  WELTARI_WEB_DIR: z.string().min(1).optional(),
  /** Gauge cadence (C13). Default 15 s; the RSS criteria runner shortens it. */
  WELTARI_GAUGE_INTERVAL_MS: z.coerce.number().int().positive().default(15000),
  /** Minisign public key (base64 body line). ABSENT = self-update disabled
   * entirely — the safe default until the owner generates a keypair (B12). */
  WELTARI_UPDATE_PUBKEY: z.string().min(1).optional(),
  /** '1' = notify-and-let-host-pull (Docker, FINAL item 12): the release
   * check runs (no key needed — it never downloads), apply always 409s. */
  WELTARI_UPDATE_NOTIFY_ONLY: z.string().optional(),
  /** Release channel; the kill harness points this at a local fixture server. */
  WELTARI_UPDATE_RELEASES_URL: z
    .string()
    .min(1)
    .default('https://api.github.com/repos/weltari/weltari/releases/latest'),
  /** Version directories + the `current` pointer live here (FINAL item 12). */
  WELTARI_VERSIONS_DIR: z.string().min(1).default('versions'),
  /** Running-version override (harness); default = server package.json version. */
  WELTARI_APP_VERSION: z.string().min(1).optional(),
  /** Cron pattern (UTC) for the periodic release check. */
  WELTARI_UPDATE_CHECK_CRON: z.string().min(1).default('0 8 * * *'),
  /** Download cap for update artifacts (B12: untrusted metadata, capped IO). */
  WELTARI_UPDATE_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(134217728),
});

export interface Env {
  port: number;
  host: string;
  dbPath: string;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  openrouterApiKey: string | undefined;
  telegramBotToken: string | undefined;
  fakeLlm: boolean;
  fakeLlmDelayMs: number;
  emitFaultPoints: boolean;
  model: string;
  providerOrder: readonly string[] | undefined;
  prefixTokens: number;
  faultPauseMs: number;
  leaseSeconds: number;
  chatIdleMinutes: number;
  cronDmGameMinutes: number;
  imagesDir: string;
  imageBackend: 'stub' | 'openrouter';
  imageModel: string;
  editImageModel: string;
  vlmModel: string;
  pluginsDir: string;
  webDir: string | undefined;
  gaugeIntervalMs: number;
  updatePubkey: string | undefined;
  updateNotifyOnly: boolean;
  updateReleasesUrl: string;
  versionsDir: string;
  appVersion: string | undefined;
  updateCheckCron: string;
  updateMaxBytes: number;
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
  // An absent key is a LEGAL fresh-install state (B11 bans malformed present
  // values, not missing optional secrets): the app boots on the FakeLLM and
  // main.ts warns loudly — a packaged install must start before it is configured.
  return {
    ok: true,
    env: {
      port: parsed.data.PORT,
      host: parsed.data.WELTARI_HOST,
      dbPath: parsed.data.WELTARI_DB_PATH,
      logLevel: parsed.data.LOG_LEVEL,
      openrouterApiKey: parsed.data.OPENROUTER_API_KEY,
      telegramBotToken: parsed.data.TELEGRAM_BOT_TOKEN,
      fakeLlm,
      fakeLlmDelayMs: parsed.data.WELTARI_FAKE_LLM_DELAY_MS,
      emitFaultPoints: parsed.data.WELTARI_EMIT_FAULT_POINTS === '1',
      model: parsed.data.WELTARI_MODEL,
      providerOrder:
        parsed.data.WELTARI_PROVIDER_ORDER === undefined
          ? undefined
          : parsed.data.WELTARI_PROVIDER_ORDER.split(',')
              .map((p) => p.trim())
              .filter((p) => p.length > 0),
      prefixTokens: parsed.data.WELTARI_PREFIX_TOKENS,
      faultPauseMs: parsed.data.WELTARI_FAULT_PAUSE_MS,
      leaseSeconds: parsed.data.WELTARI_LEASE_SECONDS,
      chatIdleMinutes: parsed.data.WELTARI_CHAT_IDLE_MINUTES,
      cronDmGameMinutes: parsed.data.WELTARI_CRON_DM_GAME_MINUTES,
      imagesDir: parsed.data.WELTARI_IMAGES_DIR,
      imageBackend: parsed.data.WELTARI_IMAGE_BACKEND,
      imageModel: parsed.data.WELTARI_IMAGE_MODEL,
      editImageModel: parsed.data.WELTARI_EDIT_IMAGE_MODEL,
      vlmModel: parsed.data.WELTARI_VLM_MODEL,
      pluginsDir: parsed.data.WELTARI_PLUGINS_DIR,
      webDir: parsed.data.WELTARI_WEB_DIR,
      gaugeIntervalMs: parsed.data.WELTARI_GAUGE_INTERVAL_MS,
      updatePubkey: parsed.data.WELTARI_UPDATE_PUBKEY,
      updateNotifyOnly: parsed.data.WELTARI_UPDATE_NOTIFY_ONLY === '1',
      updateReleasesUrl: parsed.data.WELTARI_UPDATE_RELEASES_URL,
      versionsDir: parsed.data.WELTARI_VERSIONS_DIR,
      appVersion: parsed.data.WELTARI_APP_VERSION,
      updateCheckCron: parsed.data.WELTARI_UPDATE_CHECK_CRON,
      updateMaxBytes: parsed.data.WELTARI_UPDATE_MAX_BYTES,
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
