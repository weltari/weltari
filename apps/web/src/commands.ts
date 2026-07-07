// POST command helpers. Commands go up, events come down — the client never
// mutates local state on a 202; it waits for the stream to push the truth
// (render-only, Brief §2.5). Responses are validated like any boundary data.
import {
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

export async function postOpenScene(title: string): Promise<boolean> {
  const raw = await post('/v1/commands/open-scene', {
    world_id: WORLD_ID,
    actor_id: ACTOR_ID,
    scene_id: `s-${crypto.randomUUID().slice(0, 8)}`,
    title,
    participants: ['char:elias'],
  });
  return OpenSceneAcceptedSchema.safeParse(raw).success;
}
