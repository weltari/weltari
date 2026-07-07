// POST command helpers. Commands go up, events come down — the client never
// mutates local state on a 202; it waits for the stream to push the truth
// (render-only, Brief §2.5). Responses are validated like any boundary data.
import {
  AdvanceTimeAcceptedSchema,
  ApplyUpdateAcceptedSchema,
  CommandRejectedSchema,
  EndSceneAcceptedSchema,
  InterruptTurnAcceptedSchema,
  OpenSceneAcceptedSchema,
  StartTurnAcceptedSchema,
} from '@weltari/protocol';

/** Fixture identity until multi-actor auth exists (actor_id everywhere, §1.3). */
export const WORLD_ID = 'w1';
export const ACTOR_ID = 'user:owner';

async function post(path: string, body: unknown): Promise<unknown> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) return null;
  return response.json();
}

export async function postStartTurn(
  sceneId: string,
  text: string,
): Promise<{ turnId: string } | null> {
  const raw = await post('/v1/commands/start-turn', {
    world_id: WORLD_ID,
    actor_id: ACTOR_ID,
    scene_id: sceneId,
    ...(text === '' ? {} : { text }),
  });
  const parsed = StartTurnAcceptedSchema.safeParse(raw);
  return parsed.success ? { turnId: parsed.data.turn_id } : null;
}

export interface SeenCut {
  call: 'narrator' | 'character' | 'narration';
  sentence_index: number;
}

export async function postInterruptTurn(
  turnId: string,
  seen: SeenCut | undefined,
): Promise<{ committed: boolean } | null> {
  const raw = await post('/v1/commands/interrupt-turn', {
    world_id: WORLD_ID,
    actor_id: ACTOR_ID,
    turn_id: turnId,
    ...(seen === undefined ? {} : { seen }),
  });
  const parsed = InterruptTurnAcceptedSchema.safeParse(raw);
  return parsed.success ? { committed: parsed.data.committed } : null;
}

export type ApplyUpdateResult =
  { ok: true; jobKey: string } | { ok: false; error: string };

/** The update surface (Config, FINAL item 12): enqueue the verify-and-stage
 * job. A 409 carries the refusal code (e.g. updates_disabled) — the Config
 * page shows it honestly instead of pretending the button worked. */
export async function postApplyUpdate(
  version: string,
): Promise<ApplyUpdateResult> {
  const response = await fetch('/v1/commands/apply-update', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      world_id: WORLD_ID,
      actor_id: ACTOR_ID,
      version,
    }),
  });
  const raw: unknown = await response.json();
  if (response.ok) {
    const accepted = ApplyUpdateAcceptedSchema.safeParse(raw);
    return accepted.success
      ? { ok: true, jobKey: accepted.data.job_key }
      : { ok: false, error: 'malformed_response' };
  }
  const rejected = CommandRejectedSchema.safeParse(raw);
  return {
    ok: false,
    error: rejected.success ? rejected.data.error : 'request_failed',
  };
}

/** The Gameday flow (UI Spec §1.11): skip the fictional clock forward.
 * A 202 never mutates state — the truth arrives as world.time_advanced
 * plus the cron replay's world_cron.completed events. */
export async function postAdvanceTime(
  minutes: number,
): Promise<{ worldTime: string } | null> {
  const raw = await post('/v1/commands/advance-time', {
    world_id: WORLD_ID,
    actor_id: ACTOR_ID,
    minutes,
  });
  const parsed = AdvanceTimeAcceptedSchema.safeParse(raw);
  return parsed.success ? { worldTime: parsed.data.world_time } : null;
}

/** The exit-scene path (control cluster): close the scene and fan out
 * reflections; scene.ended arrives on the stream (soft close, §1.7). */
export async function postEndScene(
  sceneId: string,
): Promise<{ jobsEnqueued: number } | null> {
  const raw = await post('/v1/commands/end-scene', {
    world_id: WORLD_ID,
    actor_id: ACTOR_ID,
    scene_id: sceneId,
  });
  const parsed = EndSceneAcceptedSchema.safeParse(raw);
  return parsed.success ? { jobsEnqueued: parsed.data.jobs_enqueued } : null;
}

/** Returns the client-generated scene id on 202 (the §1.14 cover flow
 * starts the opening-narration turn against it), null on refusal. */
export async function postOpenScene(title: string): Promise<string | null> {
  const sceneId = `s-${crypto.randomUUID().slice(0, 8)}`;
  const raw = await post('/v1/commands/open-scene', {
    world_id: WORLD_ID,
    actor_id: ACTOR_ID,
    scene_id: sceneId,
    title,
    participants: ['char:elias'],
  });
  return OpenSceneAcceptedSchema.safeParse(raw).success ? sceneId : null;
}
