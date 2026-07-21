// POST command helpers. Commands go up, events come down — the client never
// mutates local state on a 202; it waits for the stream to push the truth
// (render-only, Brief §2.5). Responses are validated like any boundary data.
import {
  AdvanceTimeAcceptedSchema,
  ApplyUpdateAcceptedSchema,
  CommandRejectedSchema,
  DeleteProfileAcceptedSchema,
  EndSceneAcceptedSchema,
  ExitChatAcceptedSchema,
  ExitGroupChatAcceptedSchema,
  FeedReplyAcceptedSchema,
  InterruptTurnAcceptedSchema,
  OpenSceneAcceptedSchema,
  DiscussProposalAcceptedSchema,
  ResolveProposalAcceptedSchema,
  SendChatMessageAcceptedSchema,
  SendGroupMessageAcceptedSchema,
  SetCharacterLockAcceptedSchema,
  SetConfigFlagAcceptedSchema,
  StartGroupChatAcceptedSchema,
  StartSceneFromChatAcceptedSchema,
  StartTurnAcceptedSchema,
  SubwikiEditAcceptedSchema,
  UserProfileViewSchema,
  type UserProfileView,
} from '@weltari/protocol';

/** Fixture identity until multi-actor auth exists (actor_id everywhere, §1.3). */
export const WORLD_ID = 'w1';
export const WORLD_NAME = 'The Rainy Inn';
export const ACTOR_ID = 'user:owner';

/** The GM persona (M7 part 2, Rev 4 §9): a standing conversation in Weltari
 * Chat — always available, never a character (no lock, no End chat). */
export const GM_CHARACTER_ID = 'char:gm';

/** The DM-able roster (Weltari Chat, §2.4) — the fixture cast until a
 * character-list surface exists (same constant open-scene already uses).
 * The GM tops the list: it is the world's standing guide (M7 part 2). */
export const CHAT_CHARACTERS: readonly {
  character_id: string;
  name: string;
}[] = [
  { character_id: GM_CHARACTER_ID, name: 'GM' },
  { character_id: 'char:elias', name: 'Elias' },
  // M6 part 4: the second DM-able fixture character — groups need >= 2.
  { character_id: 'char:mara', name: 'Mara' },
];

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

export interface OpenSceneOptions {
  /** Character ids for the new scene's roster; defaults to the fixture cast. */
  participants?: string[];
  /** Open the scene AT this known sublocation (0.8.0 — Hang around, pin jumps). */
  sublocationId?: string;
}

/** DM a character (Weltari Chat, 0.11.0). The 202 answers the presence rule
 * — `replying: false` + `in_scene` = offline, no reply coming; the durable
 * message itself arrives back as a chat.message_committed event. */
export async function postSendChatMessage(
  characterId: string,
  text: string,
): Promise<{ replying: boolean; presence: 'available' | 'in_scene' } | null> {
  const raw = await post('/v1/commands/send-chat-message', {
    world_id: WORLD_ID,
    actor_id: ACTOR_ID,
    character_id: characterId,
    text,
    request_id: `m-${crypto.randomUUID().slice(0, 12)}`,
  });
  const parsed = SendChatMessageAcceptedSchema.safeParse(raw);
  return parsed.success
    ? { replying: parsed.data.replying, presence: parsed.data.presence }
    : null;
}

/** Explicit exit() (Rev 4 §8): closes the conversation range; the character
 * reflects on it (reflect_chat). chat.ended arrives on the stream. */
export async function postExitChat(
  characterId: string,
): Promise<{ ended: boolean } | null> {
  const raw = await post('/v1/commands/exit-chat', {
    world_id: WORLD_ID,
    actor_id: ACTOR_ID,
    character_id: characterId,
  });
  const parsed = ExitChatAcceptedSchema.safeParse(raw);
  return parsed.success ? { ended: parsed.data.ended } : null;
}

/** Start a group chat (0.14.0, Rev 4 §8: user-started only). Idempotent per
 * request_id; chat.group_started arrives on the stream. */
export async function postStartGroupChat(
  memberIds: readonly string[],
  title: string,
): Promise<{ conversationId: string } | null> {
  const raw = await post('/v1/commands/start-group-chat', {
    world_id: WORLD_ID,
    actor_id: ACTOR_ID,
    member_ids: memberIds,
    title,
    request_id: `g-${crypto.randomUUID().slice(0, 12)}`,
  });
  const parsed = StartGroupChatAcceptedSchema.safeParse(raw);
  return parsed.success
    ? { conversationId: parsed.data.conversation_id }
    : null;
}

/** One user line into a group (0.14.0): the Group-chat Narrator routes up to
 * the engine-enforced budget of member replies — they arrive as events. */
export async function postSendGroupMessage(
  conversationId: string,
  text: string,
): Promise<{ routing: boolean } | null> {
  const raw = await post('/v1/commands/send-group-message', {
    world_id: WORLD_ID,
    actor_id: ACTOR_ID,
    conversation_id: conversationId,
    text,
    request_id: `m-${crypto.randomUUID().slice(0, 12)}`,
  });
  const parsed = SendGroupMessageAcceptedSchema.safeParse(raw);
  return parsed.success ? { routing: parsed.data.routing } : null;
}

/** Leave the group (0.14.0): closes the range; every member reflects. */
export async function postExitGroupChat(
  conversationId: string,
): Promise<{ ended: boolean } | null> {
  const raw = await post('/v1/commands/exit-group-chat', {
    world_id: WORLD_ID,
    actor_id: ACTOR_ID,
    conversation_id: conversationId,
  });
  const parsed = ExitGroupChatAcceptedSchema.safeParse(raw);
  return parsed.success ? { ended: parsed.data.ended } : null;
}

/** Reply to a feed comment (0.15.0, owner ruling 2026-07-11): the reply is
 * durable at the seam; the comment author's answer arrives on the stream as
 * social.reply_answered. Never routed into Weltari Chat. */
export async function postFeedReply(
  postId: string,
  reactionId: string,
  text: string,
): Promise<{ replyId: string } | null> {
  const raw = await post('/v1/commands/feed-reply', {
    world_id: WORLD_ID,
    actor_id: ACTOR_ID,
    post_id: postId,
    reaction_id: reactionId,
    text,
    request_id: `reply-${crypto.randomUUID().slice(0, 12)}`,
  });
  const parsed = FeedReplyAcceptedSchema.safeParse(raw);
  return parsed.success ? { replyId: parsed.data.reply_id } : null;
}

/** Manual wiki edit (0.15.0, owner ruling 2026-07-11: applies immediately —
 * subwiki.edited comes back on the stream with USER actor provenance). */
export async function postSubwikiEdit(
  sublocationId: string,
  entry: string,
): Promise<boolean> {
  const raw = await post('/v1/commands/subwiki-edit', {
    world_id: WORLD_ID,
    actor_id: ACTOR_ID,
    sublocation_id: sublocationId,
    entry,
  });
  return SubwikiEditAcceptedSchema.safeParse(raw).success;
}

/** Resolve a GM proposal (0.17.0, Rev 4 §16): approve applies the diff
 * atomically server-side; reject leaves zero domain rows. The card settles
 * when proposal.resolved arrives on the stream. */
export async function postResolveProposal(
  proposalId: string,
  resolution: 'approved' | 'rejected',
): Promise<{ applied: number } | null> {
  const raw = await post('/v1/commands/resolve-proposal', {
    world_id: WORLD_ID,
    actor_id: ACTOR_ID,
    proposal_id: proposalId,
    resolution,
  });
  const parsed = ResolveProposalAcceptedSchema.safeParse(raw);
  return parsed.success ? { applied: parsed.data.applied } : null;
}

/** The chat-about-this signal (0.20.0, the UX contract): a REAL command —
 * proposal.discussed comes back on the stream (the card shows the talk is
 * on) and the GM's next turn acknowledges; the card stays pending. */
export async function postDiscussProposal(
  proposalId: string,
): Promise<{ proposalId: string } | null> {
  const raw = await post('/v1/commands/discuss-proposal', {
    world_id: WORLD_ID,
    actor_id: ACTOR_ID,
    proposal_id: proposalId,
  });
  const parsed = DiscussProposalAcceptedSchema.safeParse(raw);
  return parsed.success ? { proposalId: parsed.data.proposal_id } : null;
}

/** Flip a world flag (0.17.0, Rev 4 §15) — config.flag_set comes back on
 * the stream and the store fold updates the toggle. */
export async function postSetConfigFlag(
  flag: 'profiling_enabled',
  value: boolean,
): Promise<boolean> {
  const raw = await post('/v1/commands/set-config-flag', {
    world_id: WORLD_ID,
    actor_id: ACTOR_ID,
    flag,
    value,
  });
  return SetConfigFlagAcceptedSchema.safeParse(raw).success;
}

/** The user-facing evolution lock (0.17.0, Rev 4 §7): character.lock_set
 * comes back on the stream; the very next reflection honors it. */
export async function postSetCharacterLock(
  characterId: string,
  locked: boolean,
): Promise<boolean> {
  const raw = await post('/v1/commands/set-character-lock', {
    world_id: WORLD_ID,
    actor_id: ACTOR_ID,
    character_id: characterId,
    locked,
  });
  return SetCharacterLockAcceptedSchema.safeParse(raw).success;
}

/** The GDPR erasure right (0.17.0, Rev 4 §9 guardrails): physically removes
 * the profile rows server-side. */
export async function postDeleteProfile(): Promise<{
  removed: number;
} | null> {
  const raw = await post('/v1/commands/delete-profile', {
    world_id: WORLD_ID,
    actor_id: ACTOR_ID,
  });
  const parsed = DeleteProfileAcceptedSchema.safeParse(raw);
  return parsed.success ? { removed: parsed.data.removed } : null;
}

/** The profiling store's view (0.17.0): the hypotheses travel only over
 * this fetch — never the event stream. */
export async function fetchProfile(): Promise<UserProfileView | null> {
  const response = await fetch(
    `/v1/profile?world_id=${encodeURIComponent(WORLD_ID)}&actor_id=${encodeURIComponent(ACTOR_ID)}`,
  );
  if (!response.ok) return null;
  const parsed = UserProfileViewSchema.safeParse(await response.json());
  return parsed.success ? parsed.data : null;
}

/** The export download URL (same body as fetchProfile + attachment header). */
export function profileExportUrl(): string {
  return `/v1/profile/export?world_id=${encodeURIComponent(WORLD_ID)}&actor_id=${encodeURIComponent(ACTOR_ID)}`;
}

/** The startscene() bridge, user side (Rev 4 §8): ends the chat and opens a
 * real scene with the character at `place` (existing sublocation or free
 * text — the Narrator resolves free text via the standard create workflow). */
export async function postStartSceneFromChat(
  characterId: string,
  characterName: string,
  place: string,
): Promise<{ sceneId: string } | null> {
  const raw = await post('/v1/commands/start-scene-from-chat', {
    world_id: WORLD_ID,
    actor_id: ACTOR_ID,
    character_id: characterId,
    scene_id: `s-chat-${crypto.randomUUID().slice(0, 8)}`,
    title: `Meeting ${characterName}: ${place}`.slice(0, 200),
    place,
  });
  const parsed = StartSceneFromChatAcceptedSchema.safeParse(raw);
  return parsed.success ? { sceneId: parsed.data.scene_id } : null;
}

interface OpenSceneAttempt {
  sceneId: string | null;
  /** The refusal code on a 4xx (e.g. blocked_on_pending_jobs), else null. */
  refusal: string | null;
}

async function tryOpenScene(
  title: string,
  options: OpenSceneOptions,
): Promise<OpenSceneAttempt> {
  const sceneId = `s-${crypto.randomUUID().slice(0, 8)}`;
  const response = await fetch('/v1/commands/open-scene', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      world_id: WORLD_ID,
      actor_id: ACTOR_ID,
      scene_id: sceneId,
      title,
      participants: options.participants ?? ['char:elias'],
      ...(options.sublocationId === undefined
        ? {}
        : { sublocation_id: options.sublocationId }),
    }),
  });
  const raw: unknown = await response.json();
  if (response.ok) {
    return OpenSceneAcceptedSchema.safeParse(raw).success
      ? { sceneId, refusal: null }
      : { sceneId: null, refusal: null };
  }
  const rejected = CommandRejectedSchema.safeParse(raw);
  return {
    sceneId: null,
    refusal: rejected.success ? rejected.data.error : null,
  };
}

/** How long the cover may wait out the scene-end fan-out (Brief §4 scoped
 * blocking): attempts × delay stays well inside the 30 s cover backstop. */
const OPEN_RETRY_ATTEMPTS = 20;

export interface OpenSceneTransition {
  /** A scene still open when the new one was requested: it is ended FIRST.
   * Abandoning it open would hold its characters `in_scene` forever — the
   * presence rule would never let them answer a DM again (Rev 4 §8). */
  endSceneId?: string;
  /** Test seam for the retry pacing. */
  retryDelayMs?: number;
}

/** Returns the client-generated scene id on 202 (the §1.14 cover flow
 * starts the opening-narration turn against it), null on refusal. Ends the
 * still-open scene first, then retries while that end's reflection /
 * World-Agent fan-out blocks the open — the cover animates the wait. */
export async function postOpenScene(
  title: string,
  options: OpenSceneOptions = {},
  transition: OpenSceneTransition = {},
): Promise<string | null> {
  const delayMs = transition.retryDelayMs ?? 500;
  if (transition.endSceneId !== undefined) {
    // A refused end (already ended, unknown id) changes nothing: the open
    // below is the gate; truth is the stream either way.
    await postEndScene(transition.endSceneId);
  }
  for (let attempt = 0; ; attempt++) {
    const result = await tryOpenScene(title, options);
    if (result.sceneId !== null) return result.sceneId;
    const blocked = result.refusal === 'blocked_on_pending_jobs';
    if (!blocked || attempt >= OPEN_RETRY_ATTEMPTS - 1) return null;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, delayMs);
    });
  }
}
