import { z } from 'zod';

// Durable events — rows of the append-only event log (Brief §2.1), replayed on
// SSE reconnect via Last-Event-ID. Own formats use strictObject: an unexpected
// key in our own wire format is a bug or an attack (Guide B5).
// Every event carries actor_id — no module may assume a singleton user (Brief §2.8).

const eventEnvelope = {
  /** Event-log sequence number; doubles as the SSE `id:` field (FINAL item 4). */
  id: z.int().positive(),
  world_id: z.string().min(1),
  actor_id: z.string().min(1),
  /** Wall-clock append time, ISO 8601. Fictional time is engine-owned and separate. */
  ts: z.iso.datetime(),
};

/**
 * One finished LLM call inside a committed turn. `call` is the scripted
 * three-call scene turn of the Week-1 slice (FINAL §6: Narrator → character →
 * narration); the union grows when the real Scene Engine lands.
 */
export const TurnStepSchema = z.strictObject({
  call: z.enum(['narrator', 'character', 'narration']),
  speaker: z.string().min(1),
  text: z.string(),
});
export type TurnStep = z.infer<typeof TurnStepSchema>;

/** Emitted when a scene opens. Consumed by: web client (scene header), CLI. */
export const SceneStartedEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('scene.started'),
  payload: z.strictObject({
    scene_id: z.string().min(1),
    title: z.string(),
    /**
     * Optional premise line the scene opens on (0.11.0) — from a
     * continuation's next_scene.premise_seed or a chat startscene() handoff.
     * The Narrator's first turn folds it into its dynamic tail.
     */
    premise: z.string().min(1).max(500).optional(),
    /**
     * Free-text place request from a chat startscene() handoff (Rev 4 §8)
     * that matched no known sublocation (0.11.0). The Narrator resolves it
     * on its first turn via the standard workflow: query_sublocations, then
     * change_sublocation or create_sublocation (query-first rule included).
     */
    place_request: z.string().min(1).max(200).optional(),
    /**
     * The character-fired invitation this scene opened on (0.13.0, Rev 4 §7,
     * owner ruling 2026-07-10/11): the character chose how long it will wait
     * in GAME time (`wait_hours` — a required startscene tool parameter, its
     * own model decision, never an env default); the engine stamped the
     * resulting expiry against the world clock at open. A scene carrying
     * this and never entered (no turn.committed) expires lazily the moment
     * the user's own play moves the clock past `expires_at_game` — while the
     * user is away the clock is paused, so the character has fictionally
     * waited no time at all.
     */
    invitation: z
      .strictObject({
        character_id: z.string().min(1),
        /** The place as the character proposed it (display + memory text). */
        place: z.string().min(1).max(200),
        wait_hours: z.number().positive(),
        /** World-clock instant the invitation lapses (engine-computed). */
        expires_at_game: z.string().min(1),
      })
      .optional(),
    /**
     * The consumed continuation registration (0.21.0, Rev 4 §6): when a scene
     * opens at a sublocation the previous scene's `next_scene` registered,
     * the engine folds `brief_history` + `carried_goals` in here — the
     * Narrator's first turn reads them, so the jump is a real continuation
     * (premise_seed rides the existing `premise` field).
     */
    brief_history: z.string().min(1).max(2000).optional(),
    carried_goals: z.array(z.string().min(1).max(300)).max(8).optional(),
  }),
});

/**
 * A character joined a scene's cast — the roster projection (M4). Emitted by:
 * the scene lifecycle at scene open, one per participant, in the same
 * transaction as scene.started (and by the fixture seed). Consumed by:
 * clients (the VN line-up renders the cast from these — no hardcoded cast).
 * The scene's current roster = character.joined events since its
 * scene.started; leave/mid-scene-join events arrive with a later milestone.
 */
export const CharacterJoinedEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('character.joined'),
  payload: z.strictObject({
    scene_id: z.string().min(1),
    character_id: z.string().min(1),
    /** Display name as it appears in turn steps' `speaker`. */
    name: z.string().min(1),
  }),
});

/**
 * A character left a scene mid-play (0.21.0, the agentic scene, Rev 4 §6):
 * the Narrator's `character_leave` tool, committed atomically with its
 * turn.committed. Releases the character's presence reservation for THIS
 * scene only — chat shows them available again and CRON movement may pick
 * them, while the scene stays open. Consumed by: the presence projection,
 * clients (the VN line-up drops them from the cast).
 */
export const CharacterLeftEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('character.left'),
  payload: z.strictObject({
    scene_id: z.string().min(1),
    character_id: z.string().min(1),
    /** Optional in-fiction reason ("headed home before the rain"). */
    reason: z.string().min(1).max(300).optional(),
  }),
});

/**
 * Turn envelope opened — durable intent before any LLM work happens
 * (crash-only design, Brief §2.4). Emitted by: scene engine. Consumed by:
 * clients (show "thinking"), recovery sweep (a started-but-never-committed
 * turn is void after restart).
 */
export const TurnStartedEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('turn.started'),
  payload: z.strictObject({
    scene_id: z.string().min(1),
    turn_id: z.string().min(1),
  }),
});

/**
 * Turn envelope closed — the ONLY durable form of LLM narration (Guide B6:
 * streamed text is display-only until the engine wraps it in this event).
 * Emitted by: scene engine at turn close. Consumed by: clients (authoritative
 * transcript), all future projections.
 */
export const TurnCommittedEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('turn.committed'),
  payload: z.strictObject({
    scene_id: z.string().min(1),
    turn_id: z.string().min(1),
    steps: z.array(TurnStepSchema).min(1),
    /**
     * Present (true) when the user interrupted the stream: steps hold only
     * what was displayed up to the interruption point — nothing generated
     * after it is durable (UI Spec §1.4, Guide B6).
     */
    interrupted: z.literal(true).optional(),
  }),
});

/**
 * One storytelling subgoal in the Narrator's structured snapshot (0.21.0,
 * Rev 4 §6): a full explicit state the model writes out — code just stores it.
 */
export const SceneGoalSchema = z.strictObject({
  id: z.string().min(1).max(60),
  text: z.string().min(1).max(300),
  status: z.enum(['pending', 'active', 'done']),
});
export type SceneGoal = z.infer<typeof SceneGoalSchema>;

/**
 * The Narrator's persisted subgoal snapshot (0.21.0, the agentic scene,
 * Rev 4 §6): the `update_goals` tool's full structured state, committed
 * atomically with its turn.committed. The engine reinjects the LATEST
 * snapshot into every Narrator turn (dynamic tail) — a server restart
 * mid-scene resumes at the exact story position. Event-driven and
 * self-correcting: a turn without a snapshot simply keeps the previous one.
 * Emitted by: scene engine. Consumed by: the turn engine's resume injection.
 */
export const SceneGoalsUpdatedEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('scene.goals_updated'),
  payload: z.strictObject({
    scene_id: z.string().min(1),
    turn_id: z.string().min(1),
    goals: z.array(SceneGoalSchema).min(1).max(12),
  }),
});

/**
 * Scene closed — appended atomically with the reflection fan-out jobs (one per
 * participant + one World Agent job, Brief §2.4: one WriteGate transaction).
 * Emitted by: scene lifecycle. Consumed by: clients (scene header), recovery
 * reasoning (a scene.ended always has its ledger rows — the harness verifies).
 */
export const SceneEndedEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('scene.ended'),
  payload: z.strictObject({
    scene_id: z.string().min(1),
    /** Character ids whose reflections were enqueued at close. */
    participants: z.array(z.string().min(1)),
    /**
     * How the scene closed — drives the soft-close button set (UI Spec §1.7):
     * `rest` → Stay longer + Open map; `continuation` → Stay longer + Jump to
     * the next scene + Open map; `travel` → Open map. Absent on closes from
     * the bare end-scene HTTP command (clients treat absent as `rest`).
     * 0.21.0 (Rev 4 §6): `context_limit_reached` — the Scene Engine warned
     * the Narrator the prompt was nearing its context budget and the
     * Narrator wound the scene down naturally (buttons render like `rest`).
     * Emitted by: the Narrator's end_scene tool (engine-validated, Guide B6).
     */
    end_type: z
      .enum(['rest', 'continuation', 'travel', 'context_limit_reached'])
      .optional(),
    /** Soft-close divider line, e.g. "— evening falls —" (UI Spec §1.7). */
    divider_text: z.string().min(1).max(200).optional(),
    /**
     * The Narrator's next-scene registration (Rev 4 §6, 0.10.0): where the
     * "Jump to the next scene" button opens the follow-up scene. Present
     * exactly when end_type is `continuation` (the engine-state gate refuses
     * a continuation without it). May name a stub created this very turn —
     * that is the in-scene creation loop's payoff.
     *
     * 0.21.0 (the agentic scene, Rev 4 §6): the FULL registration — what
     * makes "Jump to the next scene" a continuation instead of a cold open.
     * The tool gate requires every field; they stay optional ON THE WIRE so
     * pre-0.21 logs still parse (additive change, Guide B9).
     */
    next_scene: z
      .strictObject({
        sublocation_id: z.string().min(1),
        /** Optional premise line the follow-up scene opens on. */
        premise_seed: z.string().min(1).max(500).optional(),
        /** Game-time jump the continuation implies ("see you tomorrow" ≈ 16). */
        time_offset_hours: z.number().nonnegative().max(720).optional(),
        /** Character ids expected in the follow-up scene's cast. */
        expected_participants: z.array(z.string().min(1)).max(8).optional(),
        /** What just happened, carried verbatim into the next scene's context
         * (the World Agent recap cannot substitute — the jump may fire before
         * the cold path finishes). */
        brief_history: z.string().min(1).max(2000).optional(),
        /** Story goals the continuation keeps chasing. */
        carried_goals: z.array(z.string().min(1).max(300)).max(8).optional(),
      })
      .optional(),
  }),
});

/**
 * A character-fired invitation scene lapsed un-entered (0.13.0, Rev 4 §7,
 * owner ruling 2026-07-11): the user's own play moved the world clock past
 * `expires_at_game` while the scene still had no turn.committed. Judged
 * LAZILY — at clock advances and chat triggers, never on wall-clock time.
 * Closes the scene for every projection (presence releases exactly like
 * scene.ended); appended atomically WITH the hardcoded cache.appended
 * absence entry (never an extra LLM call) so the character complains on its
 * next trigger. NO reflection/World-Agent fan-out: nothing happened in the
 * scene. Natural key: scene_id — one expiry per scene ever, kill-retry safe.
 * Emitted by: the invitation expiry routine. Consumed by: clients (scene
 * close + chat header), verify-consistency.
 */
export const SceneExpiredEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('scene.expired'),
  payload: z.strictObject({
    scene_id: z.string().min(1),
    /** The inviting character released back to `available`. */
    character_id: z.string().min(1),
    /** The place as the character proposed it (memory-entry text). */
    place: z.string().min(1).max(200),
    /** The invitation's world-clock deadline that was crossed. */
    expires_at_game: z.string().min(1),
    /** The world clock at the lazy judgment (>= expires_at_game). */
    game_time: z.string().min(1),
  }),
});

/**
 * A character's scene reflection became durable — the only durable output of a
 * reflection job (LLM text passes the B6 double gate first). Emitted by: the
 * reflection job handler. Consumed by: clients, future memory projections.
 */
export const ReflectionCommittedEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('reflection.committed'),
  payload: z.strictObject({
    scene_id: z.string().min(1),
    character_id: z.string().min(1),
    summary: z.string().min(1),
  }),
});

/**
 * The per-world World Agent finished its scene-end pass (serialized: at most
 * one running per world via serial_group). Emitted by: the world_agent job
 * handler. Consumed by: clients, future world projections.
 */
export const WorldAgentCommittedEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('world_agent.committed'),
  payload: z.strictObject({
    scene_id: z.string().min(1),
    note: z.string().min(1),
  }),
});

/**
 * One durable Weltari Chat message (M6 part 2, Rev 4 §8) — a DM line from the
 * user or the character's reply, on the ONE event stream like everything else
 * (owner decision 2026-07-09): the transcript is a projection, replay after a
 * restart rebuilds it exactly. Chat never changes the world — a chat message
 * is durable *conversation* history, never world truth. Emitted by: the chat
 * engine (user lines at the command seam; character lines after the reply
 * commits — streamed text is never durable, Guide B6). Consumed by: clients
 * (the Chat page transcript), reflect_chat (the reflection range).
 */
export const ChatMessageCommittedEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('chat.message_committed'),
  payload: z.strictObject({
    /** Stable per user+character pair (Rev 4 §8: `chat:<actor_id>:<character_id>`). */
    conversation_id: z.string().min(1),
    /** The DM partner (also the actor on character-sent lines). */
    character_id: z.string().min(1),
    sender: z.enum(['user', 'character']),
    text: z.string().min(1).max(8192),
    /** Idempotency token: the command's request_id for user lines, an
     * engine id for character replies — duplicate sends can never twin. */
    message_id: z.string().min(1).max(100),
  }),
});

/**
 * A chat conversation range closed (M6 part 2, Rev 4 §8): explicit user
 * exit(), the idle timeout, or a startscene() handoff. Appended atomically
 * with the ONE reflect_chat ledger job for the range (Brief §2.4). The
 * conversation_id stays stable — a later DM simply starts the next range.
 * Emitted by: the chat engine. Consumed by: clients (thread state),
 * reflect_chat (natural key).
 */
export const ChatEndedEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('chat.ended'),
  payload: z.strictObject({
    conversation_id: z.string().min(1),
    character_id: z.string().min(1),
    reason: z.enum(['exit', 'idle', 'startscene']),
    /** Event id of the last chat.message_committed in the reflected range —
     * the range boundary and the reflect_chat job's natural-key component. */
    range_end_id: z.int().positive(),
  }),
});

/**
 * A character's chat reflection became durable — the chat analogue of
 * reflection.committed (Rev 4 §8: `reflect_chat`; no scene-style summary is
 * produced, the character updates only its own memory). Idempotent per
 * (conversation, range_end_id). Emitted by: the reflect_chat job handler.
 * Consumed by: clients, future memory projections.
 */
export const ReflectChatCommittedEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('reflect_chat.committed'),
  payload: z.strictObject({
    conversation_id: z.string().min(1),
    character_id: z.string().min(1),
    /** The chat.ended range this reflection covered. */
    range_end_id: z.int().positive(),
    summary: z.string().min(1),
  }),
});

/**
 * A proactive (CRON) DM became durable (M6 part 3, Rev 4 §8): eager
 * generation — the push IS the message; the content committed at fire time.
 * Appended atomically WITH the delivered chat.message_committed + its
 * cache.appended (and, on the third unanswered, chat.thread_frozen). Natural
 * key: (world, occurrence_iso) — one fire commits at most one outreach ever,
 * kill-retry safe. Stamped with BOTH clocks. Since 0.13.0 (owner ruling
 * 2026-07-10/11) occurrence_iso is a GAME-time cadence boundary — fires are
 * enqueued only when the world clock advances, never on wall time; game_time
 * records the clock at fire (>= the boundary). Emitted by: the proactive_dm
 * job handler. Consumed by: the freeze projection, verify-consistency, the
 * gateway push.
 */
export const ChatOutreachRecordedEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('chat.outreach_recorded'),
  payload: z.strictObject({
    conversation_id: z.string().min(1),
    character_id: z.string().min(1),
    /** The occurrence that fired this outreach (the natural-key component
     * alongside world_id) — a GAME-time cadence boundary since 0.13.0. */
    occurrence_iso: z.string().min(1),
    /** The fictional world clock at fire time (>= occurrence_iso). */
    game_time: z.string().min(1),
    /** The chat.message_committed this outreach delivered. */
    message_id: z.string().min(1).max(100),
    /** Unanswered outreaches on this thread including this one (1–3). */
    unanswered_count: z.int().positive(),
  }),
});

/**
 * The thread froze (M6 part 3, Rev 4 §8/§13 hard cap): the third unanswered
 * proactive DM — no further proactive sends until the user replies. The
 * counter itself is a projection (outreaches after the last user line), so a
 * user reply resets it by construction; this event exists as the durable
 * hook (owner ruling 2026-07-10): the M6-part-4 gateway pushes its hardcoded
 * "waiting for you to reply" notice off it, while Weltari Chat shows nothing
 * (the unread bubble suffices). Appended atomically WITH the tripping
 * outreach. Natural key: (conversation_id, message_id).
 */
export const ChatThreadFrozenEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('chat.thread_frozen'),
  payload: z.strictObject({
    conversation_id: z.string().min(1),
    character_id: z.string().min(1),
    /** The outreach message that tripped the cap. */
    message_id: z.string().min(1).max(100),
    unanswered_count: z.int().positive(),
  }),
});

/**
 * A group chat opened (0.14.0, Rev 4 §8: user-started ONLY — characters
 * cannot fire group chats and CRON never posts into them). Members are
 * fixed at start in V1. Emitted by: the group-chat engine. Consumed by:
 * clients (the /chats group view).
 */
export const ChatGroupStartedEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('chat.group_started'),
  payload: z.strictObject({
    conversation_id: z.string().min(1),
    title: z.string().min(1).max(120),
    member_ids: z.array(z.string().min(1)).min(2),
  }),
});

/**
 * One group-chat line became durable (0.14.0, Rev 4 §8): the user's, or a
 * member character's routed by the Group-chat Narrator (which itself NEVER
 * narrates — router decisions are log-only trail, not transcript). Unique
 * per (conversation, message_id) — duplicate sends and kill-retries never
 * twin. Emitted by: the group-chat engine. Consumed by: clients.
 */
export const ChatGroupMessageCommittedEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('chat.group_message_committed'),
  payload: z.strictObject({
    conversation_id: z.string().min(1),
    sender: z.enum(['user', 'character']),
    /** The speaking member — present exactly when sender is `character`. */
    character_id: z.string().min(1).optional(),
    text: z.string().min(1).max(8192),
    message_id: z.string().min(1).max(100),
  }),
});

/**
 * A group-chat range closed (0.14.0, Rev 4 §8): the router's ENDSUBSESSION
 * or the user's exit. Appended atomically WITH exactly ONE reflect_chat job
 * per member (keys carry the character id — the group analogue of the DM's
 * single job). Emitted by: the group-chat engine. Consumed by: clients,
 * verify-consistency.
 */
export const ChatGroupEndedEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('chat.group_ended'),
  payload: z.strictObject({
    conversation_id: z.string().min(1),
    reason: z.enum(['exit', 'endsubsession']),
    range_end_id: z.int().positive(),
    member_ids: z.array(z.string().min(1)).min(2),
  }),
});

/**
 * A hardcoded engine notice landed in a conversation (0.13.0, owner ruling
 * 2026-07-11: "a small red line shows what the error is"): a critical
 * character tool chain (startscene) exhausted its retry ceiling and rolled
 * back — the chat continues as if the tool never fired, and this line tells
 * the user why. Durable and replayable like any transcript line; rendered
 * as a red system line, never as a character message. Emitted by: the chat
 * engine. Consumed by: clients (ChatPage).
 */
export const ChatNoticeEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('chat.notice'),
  payload: z.strictObject({
    conversation_id: z.string().min(1),
    character_id: z.string().min(1),
    /** Machine-readable notice class, e.g. `startscene_rejected`. */
    code: z.string().min(1).max(100),
    /** The hardcoded human-readable line (never LLM-authored). */
    text: z.string().min(1).max(300),
  }),
});

/**
 * One CACHE entry became durable (M6 part 2, Rev 4 §11 first slice): the
 * character's mandatory 1–2 line recap of what just happened to it. The CACHE
 * store is a PROJECTION of these events (latest-per-origin is a view, never a
 * slot); all structured fields are engine-written — the character authors
 * only the one-liner. Emitted by: the chat engine (origin `chat`, every
 * reply), the reflection handler (origin `scene`, this slice's stand-in
 * until the C-Module writes in-scene), and the social handlers (origin
 * `social` since 0.15.0, Rev 4 §11: a feed comment must never shadow a
 * scene experience — latest-per-origin keeps the lanes separate). Consumed
 * by: chat context assembly (latest-per-origin catch-up), dev mode.
 */
export const CacheAppendedEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('cache.appended'),
  payload: z.strictObject({
    character_id: z.string().min(1),
    origin: z.enum(['scene', 'chat', 'social']),
    /** The scene id or conversation id the entry points back into. */
    context_id: z.string().min(1),
    /** Where it happened, when known (scene-origin entries). */
    sublocation_id: z.string().min(1).optional(),
    /** The character-authored one-liner (engine-capped). */
    line: z.string().min(1).max(300),
  }),
});

/**
 * One memory delta became durable (0.16.0, M7 part 1, Rev 4 §11): a single
 * curated recall note appended to the character's memory archive by a
 * reflection-class job — the ONLY writers (scene reflection and reflect_chat,
 * both riding the character's serial group; B6 double-gated: the model's
 * structured output passes the schema gate, then the engine gate caps deltas
 * at 3 per reflection). Deltas are append-only forever (Rev 4 §11: any bad
 * pass can be re-run — repair for free); the Search Index (SQLite FTS5) over
 * them is a projection keyed by this event's log id, rebuilt at boot.
 * Participation-gating is by construction: a delta belongs to exactly one
 * character, and memoryquery searches only that character's own rows.
 * Emitted by: reflection / reflect_chat handlers, atomically with their
 * committed events. Consumed by: the Search Index projection, memoryquery,
 * dev mode.
 */
export const MemoryDeltaCommittedEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('memory.delta_committed'),
  payload: z.strictObject({
    character_id: z.string().min(1),
    /** Which trigger class curated it (Rev 4 §17 session_or_conv_id). */
    origin: z.enum(['scene', 'chat']),
    /** The scene id or conversation id the delta was reflected from. */
    context_id: z.string().min(1),
    /** The character's own recall note — first person, self-contained. */
    content: z.string().min(1).max(1000),
  }),
});

/**
 * The character's durable memory core changed (0.16.0, M7 part 1, Rev 4 §11):
 * a FULL SNAPSHOT of the durable core lines — latest event per character wins
 * (a snapshot, unlike deltas, so replay is a trivial fold and a bad update is
 * fully superseded by the next). The fixture/config memory core is the SEED
 * and never changes; every prompt injects seed + this latest snapshot in the
 * stable prefix (byte-stable between calls — the core changes only when a
 * reflection-class job commits this event, never within a call: I5 holds).
 * Emitted by: reflection / reflect_chat handlers (B6 double-gated, capped).
 * Consumed by: context assembly (the always-injected tier), dev mode.
 */
export const MemoryCoreUpdatedEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('memory.core_updated'),
  payload: z.strictObject({
    character_id: z.string().min(1),
    /** The full durable core after this update (engine-capped). */
    core: z.array(z.string().min(1).max(300)).min(1).max(12),
    /** Provenance: which reflection wrote it. */
    origin: z.enum(['scene', 'chat']),
    context_id: z.string().min(1),
  }),
});

/**
 * Reflection evolved the character (0.16.0, M7 part 1, Rev 4 §7/§11, owner
 * ruling 2026-07-11: ships with the memory store, behind the per-character
 * `locked` flag): a personality rewrite and/or a full goals snapshot. The
 * engine gate refuses the whole call for a locked character (locked fields
 * untouched — I8: zero rows) and refuses an empty evolution (at least one
 * field must be present). Latest event per character wins per field.
 * Emitted by: reflection / reflect_chat handlers via the character's serial
 * group. Consumed by: context assembly (live personality/goals), dev mode.
 */
export const CharacterEvolvedEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('character.evolved'),
  payload: z.strictObject({
    character_id: z.string().min(1),
    /** The evolved personality text (full replacement). */
    personality: z.string().min(1).max(1000).optional(),
    /** The evolved goals (full snapshot, like the personality). */
    goals: z.array(z.string().min(1).max(300)).min(1).max(8).optional(),
    /** Provenance: which reflection evolved it. */
    origin: z.enum(['scene', 'chat']),
    context_id: z.string().min(1),
  }),
});

/**
 * A compaction pass summarized the character's old memory deltas (0.16.0,
 * M7 part 1, Rev 4 §11): CUMULATIVE — this record covers every delta whose
 * log id is <= up_to_id; the read path prefers the latest compaction (highest
 * up_to_id) and lays raw deltas newer than it on top. Deltas are NEVER
 * removed (the log is append-only): a bad pass is repaired by re-running the
 * job for the same range, whose new record supersedes the old one in the
 * fold — repair for free, no deletion anywhere. Idempotent per (character,
 * up_to_id) — the job's natural key; kill-retry commits at most one record
 * per range. Emitted by: the memory_compaction ledger job (world-inert —
 * enqueued when the raw-delta count outgrows the window, atomically with the
 * reflection that tipped it). Consumed by: memory reads, memoryquery framing,
 * dev mode.
 */
export const MemoryCompactedEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('memory.compacted'),
  payload: z.strictObject({
    character_id: z.string().min(1),
    /** Log id of the newest memory.delta_committed this record covers. */
    up_to_id: z.int().positive(),
    /** How many deltas the pass folded in (audit). */
    delta_count: z.int().positive(),
    /** The summary standing in for the covered range (B6-gated). */
    summary: z.string().min(1).max(4000),
  }),
});

/**
 * CACHE retention advanced (0.16.0, M7 part 1, Rev 4 §11: "keep the last N
 * entries per character"). The event log is append-only, so pruning is a
 * WATERMARK, not a deletion: every CACHE view ignores cache.appended events
 * with id <= watermark_id for this character — replay rebuilds the identical
 * pruned view. Safe by construction: reflection reads session history, never
 * CACHE history, so retention has zero correctness impact. Idempotent per
 * (character, watermark_id). Emitted by: the cache_prune ledger job.
 * Consumed by: the CACHE views, dev mode.
 */
export const CachePrunedEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('cache.pruned'),
  payload: z.strictObject({
    character_id: z.string().min(1),
    /** cache.appended events at or below this log id leave every view. */
    watermark_id: z.int().positive(),
    /** Entries still visible after this prune (audit). */
    kept: z.int().nonnegative(),
  }),
});

/**
 * A sublocation's wiki entry was written or extended (M6 part 2, Rev 4 §10):
 * the World Agent's scene-end pass covers every NARRATOR-CREATED sublocation
 * that participated in the scene (owner rule, week 9: created = gets a wiki;
 * transient/mentioned-only places never do). Observable-now snapshots only —
 * events and speech are never wiki material (source-typing rule). The wiki
 * VIEW is a projection of these events (latest per sublocation wins; full
 * history stays auditable — wiki writes carry provenance via scene_id).
 * Emitted by: the world_agent job handler, atomically with
 * world_agent.committed. Consumed by: future wiki surfaces (M6 part 3),
 * scene context assembly.
 */
export const SubwikiUpdatedEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('subwiki.updated'),
  payload: z.strictObject({
    sublocation_id: z.string().min(1),
    /** Provenance: the scene whose end-pass wrote this entry. */
    scene_id: z.string().min(1),
    entry: z.string().min(1).max(4000),
  }),
});

/**
 * The user manually edited a sublocation's wiki entry from the Wiki page
 * (0.15.0, M6 part 5, owner ruling 2026-07-11: edits apply immediately —
 * the Proposal pipeline is deferred). Durable with USER actor provenance
 * (`actor_id`), so the audit trail always distinguishes a manual edit from
 * a World Agent pass; the wiki view folds subwiki.updated AND subwiki.edited
 * latest-wins — a later World Agent pass may supersede the text, but never
 * silently (both writes stay in the log). Emitted by: the subwiki-edit
 * command seam. Consumed by: clients (WikiPage), wiki context assembly.
 */
export const SubwikiEditedEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('subwiki.edited'),
  payload: z.strictObject({
    sublocation_id: z.string().min(1),
    entry: z.string().min(1).max(4000),
    /** Present when an approved GM proposal applied this edit (0.17.0, Rev 4
     * §16): the audit trail from the entry back to its consent. Absent on
     * manual user edits from the Wiki page. */
    proposal_id: z.string().min(1).max(100).optional(),
  }),
});

/**
 * A durable object entered the world (0.18.0, M7 part 3, Rev 4 §7):
 * materialize-on-touch — the Narrator narrates scenery freely as prose, and
 * an object becomes this event (and its row) only when an interaction has a
 * durable consequence; ~95% of narrated stuff never becomes data. V1 objects
 * are sublocation-held ONLY (owner ruling 2026-07-16: backpacks — character/
 * user holders, transfer_object, the secrecy rule — are V2), so every object
 * is public: listed by `explore`, observable-now, usable by anyone present.
 * Emitted by: the scene turn engine (a character's gated `interact_object`,
 * atomic with its turn.committed) or the resolve-proposal apply (GM-authored
 * objects, consent-gated). Consumed by: the objects repository (the sole
 * writer folds this into the objects table in the SAME transaction), clients.
 */
export const ObjectCreatedEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('object.created'),
  payload: z.strictObject({
    object_id: z.string().min(1),
    name: z.string().min(1).max(120),
    /** The sublocation holding the object — V1's only holder kind. */
    holder_sublocation_id: z.string().min(1),
    /** What the object is and/or contains (prose). Present when the creating
     * touch authored content in the same op; absent = an empty carrier
     * awaiting write-on-first-read or a later authoring touch. */
    object_payload: z.string().min(1).max(4000).optional(),
    /** Provenance: the scene whose touch materialized the row. Absent on
     * proposal-applied objects. */
    scene_id: z.string().min(1).optional(),
    /** The approved GM proposal that applied this row (audit provenance;
     * absent on touch-materialized objects). */
    proposal_id: z.string().min(1).max(100).optional(),
  }),
});

/**
 * An object's prose payload was written (0.18.0, Rev 4 §7). Two writers,
 * distinguished by the envelope's actor_id: a character authoring content
 * through `interact_object` (engine→truth directly, never through the
 * Narrator), or the Narrator's write-on-first-read — an empty public object
 * examined once gets improvised content persisted EXACTLY once (the engine
 * gate refuses an improv write over an existing payload; the second read
 * returns the same content). Emitted by: the scene turn engine, atomic with
 * its turn.committed. Consumed by: the objects repository (same-transaction
 * fold), clients.
 */
export const ObjectPayloadWrittenEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('object.payload_written'),
  payload: z.strictObject({
    object_id: z.string().min(1),
    object_payload: z.string().min(1).max(4000),
    /** Provenance: the scene whose turn wrote the payload. */
    scene_id: z.string().min(1),
  }),
});

/**
 * An object changed holders (0.18.0, Rev 4 §7): one pointer update — V1
 * moves are sublocation → sublocation within the scene's reach (owner ruling
 * 2026-07-16: character/user holders are V2, so possession never changes,
 * only placement). Emitted by: the scene turn engine (a character's gated
 * `interact_object`, atomic with its turn.committed). Consumed by: the
 * objects repository (same-transaction fold), clients.
 */
export const ObjectMovedEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('object.moved'),
  payload: z.strictObject({
    object_id: z.string().min(1),
    from_sublocation_id: z.string().min(1),
    to_sublocation_id: z.string().min(1),
    /** Provenance: the scene whose turn moved the object. */
    scene_id: z.string().min(1),
  }),
});

/**
 * The GC sweep tombstoned a stray object (0.18.0, Rev 4 §7): payload-less,
 * sublocation-held, and never touched again after its creating scene —
 * dropped sticks vanish; payload carriers are exempt. The object leaves the
 * projection (its row is deleted in the SAME transaction), but the log stays
 * append-only (I1): this event IS the deletion, a tombstone — never an
 * event-log DELETE. Emitted by: the object-gc ledger job. Consumed by: the
 * objects repository, verify block sweeps, clients.
 */
export const ObjectSweptEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('object.swept'),
  payload: z.strictObject({
    object_id: z.string().min(1),
  }),
});

/**
 * A chance-encounter marker was dropped on the map (0.19.0, M7 part 4, Rev 4
 * §14/§17): a LAZY intent — metadata + premise only; nothing generates,
 * nothing enters any log or memory, until clicked. The map holds 1–5 live
 * markers at all times: the engine tops up below the minimum and refuses
 * drops above the maximum (a refused drop appends NOTHING — I8). TTLs are
 * game time against the world clock; a marker already past its TTL at drop
 * time is never dropped at all (born-expired suppression). V1 kind is
 * `map_event` only; `chat_dm` (§17) joins when proactive DMs go marker-lazy
 * (V2). Emitted by: the marker engine (scene-end follow-up, CRON drop,
 * engine top-up). Consumed by: the markers repository (same-transaction
 * fold), map renderers.
 */
export const MarkerDroppedEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('marker.dropped'),
  payload: z.strictObject({
    marker_id: z.string().min(1),
    kind: z.literal('map_event'),
    /** Materialized sublocations only (Rev 4 §14: nothing CRON-driven
     * anchors to a stub). */
    sublocation_id: z.string().min(1),
    involved_characters: z.array(z.string().min(1)).max(8),
    /** The intent seed the Narrator grounds in CURRENT state on click —
     * late generation beats stale content (Rev 4 §14). */
    premise_seed: z.string().min(1).max(500),
    /** Fictional drop timestamp — the occurrence's SCHEDULED time on CRON
     * drops (governance: stamped with scheduled time, Rev 4 §14). */
    dropped_at_game_time: z.iso.datetime(),
    ttl_game_minutes: z.int().positive(),
    /** Engine-computed dropped_at + ttl; the sweep and click re-validation
     * compare this lexicographically against the world clock (the
     * invitation-expiry convention). */
    expires_at_game_time: z.iso.datetime(),
    /** Provenance: which loop dropped it. */
    source: z.enum(['scene_end', 'cron', 'engine_topup']),
    /** `scene_end` only: the ending scene that proposed the follow-up. */
    scene_id: z.string().min(1).optional(),
  }),
});

/**
 * A marker's first click instantiated its scene (0.19.0, Rev 4 §14/§17):
 * first click wins — this event flips state dropped → instantiated and names
 * the ONE scene; a concurrent second click loses the version race through
 * the fused re-check and is answered "join scene in progress" instead of
 * twinning. Emitted by: the marker-click seam, atomic with scene.started in
 * ONE transaction. Consumed by: the markers repository (same-transaction
 * fold), map renderers (the pin settles).
 */
export const MarkerInstantiatedEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('marker.instantiated'),
  payload: z.strictObject({
    marker_id: z.string().min(1),
    /** The scene the click opened (deterministic per marker — a racing
     * duplicate would collide on scene_already_open by construction). */
    scene_id: z.string().min(1),
    /** World-clock time at the click. */
    game_time: z.iso.datetime(),
  }),
});

/**
 * A marker expired against the world clock (0.19.0, Rev 4 §14/§17): expiry
 * is LAZY — judged at every clock advance (the sweep), at boot (recovery
 * path = startup path), and at click time (an expired-but-unswept marker's
 * click is refused and settles it here). The marker leaves the live set but
 * the log stays append-only (I1) — a skipped encounter "never happened":
 * no scene, no memory, no CACHE, by construction. Emitted by: the marker
 * sweep or the click re-validation. Consumed by: the markers repository
 * (same-transaction fold), map renderers (the pin disappears).
 */
export const MarkerExpiredEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('marker.expired'),
  payload: z.strictObject({
    marker_id: z.string().min(1),
    /** World-clock time at expiry judgment. */
    game_time: z.iso.datetime(),
    /** Which lazy path settled it. */
    expired_via: z.enum(['sweep', 'click']),
  }),
});

/**
 * A character moved between sublocations (0.19.0, M7 part 4, Rev 4 §14):
 * CRON world movement — a code-class pointer update, mailbox-routed through
 * the engine (one of §4.5's deliberate hot-path exceptions: map, CRON and
 * chat need locations fresh). Constraints enforced at emit: never a
 * character currently `in_scene` (presence check), targets MATERIALIZED
 * sublocations only, idempotent per CRON occurrence (the world_cron.completed
 * natural key gates the replay). Consumed by: the character-locations fold,
 * map renderers (position bubbles).
 */
export const CharacterLocationChangedEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('character.location_changed'),
  payload: z.strictObject({
    character_id: z.string().min(1),
    /** Absent on the character's first placement. */
    from_sublocation_id: z.string().min(1).optional(),
    to_sublocation_id: z.string().min(1),
    /** The fictional moment the move happened (the occurrence's scheduled
     * time — positions read true on landing after a skip). */
    game_time: z.iso.datetime(),
  }),
});

/**
 * One place inside a proposal diff (0.17.0, M7 part 2, Rev 4 §9/§16): what
 * the GM wants to create — applied as a materialized sublocation row (plus an
 * opening wiki entry when given) only after approval. `space` feeds the
 * cold-boot seeding gate (≥1 public AND ≥1 private space, Rev 4 §9).
 */
export const ProposalPlaceDiffSchema = z.strictObject({
  name: z.string().min(1).max(120),
  description: z.string().min(1).max(2000),
  /** Public spaces host encounters; private ones give characters somewhere
   * to live (Rev 4 §9's minimum viable set). */
  space: z.enum(['public', 'private']),
  /** Optional opening wiki entry, documented at creation (Rev 4 §9: the
   * seeded spaces are documented in the wiki). */
  wiki_entry: z.string().min(1).max(4000).optional(),
});
export type ProposalPlaceDiff = z.infer<typeof ProposalPlaceDiffSchema>;

/**
 * One character inside a proposal diff (0.17.0, Rev 4 §9/§16): the seed
 * profile a character.created applies on approval. Caps mirror the memory
 * events (core ≤ 12 lines like memory.core_updated; goals ≤ 8 like
 * character.evolved) so a GM-authored character is shaped exactly like an
 * evolved one.
 */
export const ProposalCharacterDiffSchema = z.strictObject({
  name: z.string().min(1).max(120),
  personality: z.string().min(1).max(1000),
  goals: z.array(z.string().min(1).max(300)).min(1).max(8),
  /** Seed memory-core lines — the GM authors durable memories directly
   * through consent (week-14 note: models treat update_core as rare). */
  core: z.array(z.string().min(1).max(300)).max(12),
  skills: z.array(z.string().min(1).max(300)).max(8),
});
export type ProposalCharacterDiff = z.infer<typeof ProposalCharacterDiffSchema>;

/**
 * One object inside a proposal diff (0.18.0, M7 part 3, Rev 4 §7): what the
 * GM wants to author — applied as an object.created row (holder = a
 * sublocation; owner ruling 2026-07-16: character/user holders are V2) only
 * after approval. GM-authored objects have no creating scene and are never
 * GC candidates.
 */
export const ProposalObjectDiffSchema = z.strictObject({
  name: z.string().min(1).max(120),
  holder_sublocation_id: z.string().min(1),
  /** Optional authored content — what the object is and/or contains. */
  object_payload: z.string().min(1).max(4000).optional(),
});
export type ProposalObjectDiff = z.infer<typeof ProposalObjectDiffSchema>;

const proposalBase = {
  /** Engine-assigned proposal identity — every later event (resolution,
   * applied rows) points back here. */
  proposal_id: z.string().min(1).max(100),
  /** Why the proposer wants this — rendered on the consent card. */
  rationale: z.string().min(1).max(1000),
  /** Rev 4 §16 uniform shape: who proposes (the GM in V1; the pipeline is
   * generic — any agent may emit one). Repeats the envelope actor_id on
   * purpose so the §16 object is complete in the payload alone. */
  proposer: z.string().min(1),
  /** Who must approve. V1: the single user actor. V2 routes by scope
   * (world mutations → world owner; personal scope → the requesting user). */
  approvers: z.array(z.string().min(1)).min(1).max(10),
};

/**
 * An agent proposed a durable world change (0.17.0, M7 part 2, Rev 4 §16):
 * the uniform consent object `{action, diff, rationale, proposer,
 * approvers[]}`. NOTHING durable beyond this record happens at submit time —
 * the diff is a complete, deterministic description of the change, applied
 * only by an approving resolve-proposal command (engine-validated, atomic
 * with proposal.resolved). The payload is a closed discriminated union per
 * action so the frontend renders every diff it can receive and the engine
 * applies only actions it knows (B5/B6). Emitted by: the GM chat engine
 * (gate-1 schema + gate-2 engine-state checked), atomically with the GM
 * reply that proposed it. Consumed by: clients (the consent card in the GM
 * chat), the pending-proposals projection.
 */
export const ProposalSubmittedEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('proposal.submitted'),
  payload: z.discriminatedUnion('action', [
    z.strictObject({
      ...proposalBase,
      action: z.literal('create_place'),
      diff: ProposalPlaceDiffSchema,
    }),
    z.strictObject({
      ...proposalBase,
      action: z.literal('create_character'),
      diff: ProposalCharacterDiffSchema,
    }),
    z.strictObject({
      ...proposalBase,
      action: z.literal('create_object'),
      diff: ProposalObjectDiffSchema,
    }),
    z.strictObject({
      ...proposalBase,
      action: z.literal('edit_wiki'),
      diff: z.strictObject({
        sublocation_id: z.string().min(1),
        entry: z.string().min(1).max(4000),
        /** The entry being replaced, when one exists — the consent card
         * renders a real before/after diff from it. */
        previous_entry: z.string().min(1).max(4000).optional(),
      }),
    }),
    z.strictObject({
      ...proposalBase,
      action: z.literal('seed_world'),
      diff: z.strictObject({
        world_name: z.string().min(1).max(120),
        /** The language the user chose in the interview (BCP-47-ish tag or
         * plain name — display data, not a lookup key). */
        language: z.string().min(1).max(35),
        chapter_seed: z.string().min(1).max(2000).optional(),
        /** Every deliberately named place gets a materialized row (Rev 4 §9
         * binding). The engine gate additionally requires ≥1 public and ≥1
         * private space — the schema cannot express the mix. */
        places: z.array(ProposalPlaceDiffSchema).min(2).max(8),
        characters: z.array(ProposalCharacterDiffSchema).min(1).max(6),
      }),
    }),
  ]),
});

/**
 * A proposal was resolved (0.17.0, Rev 4 §16): the approver's decision as a
 * durable event — approval and application are logged (audit trail). On
 * `approved` the applied domain events (sublocation.materialized,
 * character.created, subwiki.edited, world.seeded) ride the SAME transaction,
 * each carrying this proposal_id as provenance; on `rejected` this event is
 * the ONLY durable trace — zero domain rows (I8). Idempotent per proposal:
 * the engine refuses to resolve twice. Emitted by: the resolve-proposal
 * command seam. Consumed by: clients (the consent card settles), the
 * pending-proposals projection.
 */
export const ProposalResolvedEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('proposal.resolved'),
  payload: z.strictObject({
    proposal_id: z.string().min(1).max(100),
    resolution: z.enum(['approved', 'rejected']),
  }),
});

/**
 * The user asked to talk a pending proposal over (0.20.0, Rev 4 §16, the GM
 * proposal UX contract): the "Chat about this" click as a DURABLE signal —
 * the GM's next turn sees it as the tool call's interim result (stop
 * proposing, listen), instead of a client-side input prefill that reaches
 * nobody. The proposal itself stays PENDING: this is not a resolution, the
 * card remains resolvable later, and zero domain rows ride it (I8).
 * Idempotent per proposal: the engine refuses a second discuss while the
 * first stands unresolved. Emitted by: the discuss-proposal command seam.
 * Consumed by: the GM follow-up turn (the durable tool-result machinery),
 * clients (the card shows it is being discussed).
 */
export const ProposalDiscussedEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('proposal.discussed'),
  payload: z.strictObject({
    proposal_id: z.string().min(1).max(100),
  }),
});

/**
 * A durable character entered the world (0.17.0, M7 part 2, Rev 4 §9): the
 * seed profile of a GM-authored (or cold-boot-seeded) character — the exact
 * counterpart of a fixture profile, as an event. The live-profile fold treats
 * it as the seed layer: memory deltas, core updates and evolution accrue on
 * top from the character's first reflection (week-14 owner note:
 * multi-character by construction — nothing revisits). Emitted by: the
 * resolve-proposal apply (consent-gated — the GM can never mint a character
 * directly, B6/Rev 4 §9). Consumed by: character registries (chat roster,
 * profile lookups), clients.
 */
export const CharacterCreatedEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('character.created'),
  payload: z.strictObject({
    character_id: z.string().min(1),
    name: z.string().min(1).max(120),
    personality: z.string().min(1).max(1000),
    goals: z.array(z.string().min(1).max(300)).min(1).max(8),
    /** Seed memory-core lines (may be empty — memory accrues from the first
     * reflection either way). */
    core: z.array(z.string().min(1).max(300)).max(12),
    skills: z.array(z.string().min(1).max(300)).max(8),
    /** The approved proposal that applied this character (audit). */
    proposal_id: z.string().min(1).max(100).optional(),
  }),
});

/**
 * Cold boot completed (0.17.0, M7 part 2, Rev 4 §9 Job 0): the world is
 * seeded — every named place materialized, characters created, all in the
 * approving transaction of the seed_world proposal. Its EXISTENCE is the
 * onboarding fold's terminal state: a world with no world.seeded event is a
 * fresh world still interviewing. Counts are audit data; the rows themselves
 * are the sibling events in the same transaction. Emitted by: the
 * resolve-proposal apply. Consumed by: clients (onboarding vs play surfaces),
 * the onboarding fold.
 */
export const WorldSeededEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('world.seeded'),
  payload: z.strictObject({
    world_name: z.string().min(1).max(120),
    language: z.string().min(1).max(35),
    chapter_seed: z.string().min(1).max(2000).optional(),
    place_count: z.int().positive(),
    character_count: z.int().positive(),
    /** Absent only on fixture-seeded dev worlds (env-flagged), which skip
     * the interview. */
    proposal_id: z.string().min(1).max(100).optional(),
  }),
});

/**
 * A gateway conversation bound for the first time (0.17.0, M7 part 2, Rev 4
 * §13): messaging the bot once IS subscribing — this event records the first
 * time a (connector, messenger conversation) pair was ever seen, and gates
 * the one-time GM onboarding push (criterion: fires once per binding, ever).
 * Idempotent by fold: the gateway host emits it only when no prior
 * binding_established exists for the pair. Emitted by: the gateway host.
 * Consumed by: the GM onboarding push, dev mode.
 */
export const GatewayBindingEstablishedEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('gateway.binding_established'),
  payload: z.strictObject({
    connector_id: z.string().min(1),
    /** The messenger-side chat id (Telegram chat id in V1). */
    conversation_id: z.string().min(1),
  }),
});

/**
 * A world flag flipped (0.17.0, M7 part 2, Rev 4 §15): durable config as an
 * event fold — latest event per flag wins; no mutable settings table exists
 * (everything here is a projection of the log). The closed enum grows as
 * config surfaces ship. `profiling_enabled` defaults OFF until the first
 * config.flag_set: profiling is consent-first (Rev 4 §9 GDPR guardrails).
 * Emitted by: the set-config-flag command seam (user) or an approved GM
 * proposal path in later weeks. Consumed by: the profiling enqueue sites,
 * clients (Config page).
 */
export const ConfigFlagSetEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('config.flag_set'),
  payload: z.strictObject({
    flag: z.enum(['profiling_enabled']),
    value: z.boolean(),
  }),
});

/**
 * The user toggled a character's evolution lock (0.17.0, M7 part 2, Rev 4
 * §7/§11): the user-facing face of the per-character `locked` flag that has
 * gated character.evolved since 0.16.0 (until now data-settable only).
 * Latest event per character wins, folded over the seed profile's own flag.
 * Emitted by: the set-character-lock command seam (USER actor provenance).
 * Consumed by: the reflection engine gate, clients (character settings).
 */
export const CharacterLockSetEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('character.lock_set'),
  payload: z.strictObject({
    character_id: z.string().min(1),
    locked: z.boolean(),
  }),
});

/**
 * A profile-analysis pass updated the user's profile (0.17.0, M7 part 2,
 * Rev 4 §9 Job 2 / §4.3). REFERENCES ONLY — the hypotheses themselves live
 * in a mutable side store OUTSIDE the event log (like image pixels live as
 * files), because profiling text is personal data that must be truly
 * erasable (GDPR) while the log is append-only forever. This event says THAT
 * the store changed, never what it says. Emitted by: the profile_analysis
 * ledger job (the store's sole writer, Rev 4 §4.3). Consumed by: clients
 * (Config page freshness), dev mode.
 */
export const ProfileUpdatedEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('profile.updated'),
  payload: z.strictObject({
    user_actor_id: z.string().min(1),
    /** Hypotheses in the store after this pass (audit; never the text). */
    hypothesis_count: z.int().nonnegative(),
    /** The ended scene or chat range the analysis covered. */
    context_id: z.string().min(1),
  }),
});

/**
 * The user deleted their profile (0.17.0, Rev 4 §9 GDPR guardrails): the
 * side-store rows are physically gone in the same transaction — and because
 * the store is NOT a projection of the log, replay never resurrects them.
 * The event records only the fact of deletion (an auditable user right, not
 * personal data). Emitted by: the delete-profile command seam. Consumed by:
 * clients (Config page).
 */
export const ProfileDeletedEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('profile.deleted'),
  payload: z.strictObject({
    user_actor_id: z.string().min(1),
    /** Rows physically removed (audit). */
    removed: z.int().nonnegative(),
  }),
});

/**
 * A character's feed post became durable (0.15.0, M6 part 5, Rev 4 §12): the
 * social CRON's eager generation — the post IS the content committed at fire
 * time, grounded in the poster's CACHE/goals like a proactive DM. Natural
 * key: (world, occurrence_iso) — one cadence boundary commits at most one
 * post ever, kill-retry safe; occurrence_iso is a GAME-time boundary (posts
 * fire only when the world clock advances; hard ceiling 10 per skip with
 * the freshest window surviving). Delivery rides the acquaintance rule
 * (owner ruling 2026-07-11: shared scene session OR shared group chat);
 * `recipient_ids` records it for audit — the user always sees every post
 * (viewer-only feed). Appended atomically WITH the poster's cache.appended
 * (origin `social`). Emitted by: the social_post job handler. Consumed by:
 * clients (FeedPage), verify-consistency.
 */
export const SocialPostCommittedEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('social.post_committed'),
  payload: z.strictObject({
    post_id: z.string().min(1).max(100),
    /** The cadence boundary that fired this post (natural-key component
     * alongside world_id) — a GAME-time boundary. */
    occurrence_iso: z.string().min(1),
    /** The fictional world clock at fire time (>= occurrence_iso). */
    game_time: z.string().min(1),
    character_id: z.string().min(1),
    body: z.string().min(1).max(1000),
    /** Acquaintances the post was delivered to (may be empty). */
    recipient_ids: z.array(z.string().min(1)),
  }),
});

/**
 * A recipient reacted to a feed post (0.15.0, Rev 4 §12): the outcome of ONE
 * skill-triggered decision — like, or a one-line comment; an explicit
 * stay_silent decline commits nothing. At most `reaction cap` recipients per
 * post get the decision (env default 4, deterministic salted pick — no
 * relationship system in V1). Comments are isolated: characters never react
 * to each other's comments. Natural key: (post_id, character_id) — one
 * decision per recipient per post. Appended atomically WITH the reactor's
 * cache.appended (origin `social` — two-sided memory, Rev 4 §12). Emitted
 * by: the social_reaction job handler. Consumed by: clients (FeedPage).
 */
export const SocialReactionCommittedEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('social.reaction_committed'),
  payload: z.strictObject({
    post_id: z.string().min(1).max(100),
    reaction_id: z.string().min(1).max(200),
    character_id: z.string().min(1),
    kind: z.enum(['like', 'comment']),
    /** The one-line comment text — present iff kind is `comment`
     * (engine-enforced). */
    body: z.string().min(1).max(300).optional(),
  }),
});

/**
 * The user replied to a comment on a feed post (0.15.0, owner ruling
 * 2026-07-11): clicking a comment opens the reply box; the reply lives in a
 * feed-local thread under that comment — never routed into Weltari Chat.
 * Uncapped (user-triggered spend). The comment's author answers with
 * social.reply_answered. Emitted by: the feed-reply command seam (actor =
 * the user). Consumed by: clients (FeedPage threads).
 */
export const SocialReplyPostedEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('social.reply_posted'),
  payload: z.strictObject({
    post_id: z.string().min(1).max(100),
    /** The comment (social.reaction_committed reaction_id) replied to. */
    reaction_id: z.string().min(1).max(200),
    reply_id: z.string().min(1).max(100),
    body: z.string().min(1).max(2000),
  }),
});

/**
 * The comment's author answered the user's reply (0.15.0): an answer-only
 * chat-class call — the skill forbids promises the toolset cannot keep (no
 * startscene here; answering is all the comment thread can do), and the
 * character writes its CACHE (origin `social`) in the same call. Appended
 * atomically WITH that cache.appended. Natural key: (in_reply_to) — one
 * answer per user reply, kill-retry safe. Emitted by: the social_reply job
 * handler. Consumed by: clients (FeedPage threads, the notification bell).
 */
export const SocialReplyAnsweredEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('social.reply_answered'),
  payload: z.strictObject({
    post_id: z.string().min(1).max(100),
    reaction_id: z.string().min(1).max(200),
    /** This answer's own id. */
    reply_id: z.string().min(1).max(100),
    /** The user social.reply_posted reply_id this answers (natural key). */
    in_reply_to: z.string().min(1).max(100),
    character_id: z.string().min(1),
    body: z.string().min(1).max(1000),
  }),
});

/**
 * The engine-owned fictional clock moved forward (a time skip). Appended
 * atomically with every world-cron occurrence row the skip made due (code-class
 * all enqueued; LLM-class capped by the per-skip budget — Brief §4). The
 * current world clock is a projection: the latest event's `to`.
 */
export const WorldTimeAdvancedEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('world.time_advanced'),
  payload: z.strictObject({
    /** Fictional ISO datetimes — never wall time. */
    from: z.iso.datetime(),
    to: z.iso.datetime(),
    code_enqueued: z.int().nonnegative(),
    llm_enqueued: z.int().nonnegative(),
    /** LLM-class occurrences dropped by the per-skip budget. */
    llm_skipped: z.int().nonnegative(),
  }),
});

/**
 * One world-cron occurrence finished (idempotent per cron_type +
 * scheduled_for). Emitted by: the world-cron job handlers. Consumed by:
 * clients (world activity feed), future projections.
 */
export const WorldCronCompletedEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('world_cron.completed'),
  payload: z.strictObject({
    cron_type: z.string().min(1),
    /** The fictional occurrence timestamp this row replayed. */
    scheduled_for: z.iso.datetime(),
    job_class: z.enum(['code', 'llm']),
    /** LLM-class only: the generated note (B6-gated before it lands here). */
    note: z.string().min(1).optional(),
  }),
});

/**
 * The scene's backdrop moved to another sublocation — clients play the
 * slide-style backdrop transition (UI Spec §1.6). Emitted by: the Narrator's
 * change_sublocation tool after both B6 gates (the sublocation must exist in
 * this world). Consumed by: clients (backdrop swap + scene header).
 */
/**
 * World-coordinate anchor for map pins (UI Spec §1.8: pins anchor to world
 * coordinates, never pixels — a repaint never moves a pin). Unit square:
 * x/y ∈ [0, 1] of the world map extent.
 */
export const MapPositionSchema = z.strictObject({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
});
export type MapPosition = z.infer<typeof MapPositionSchema>;

/**
 * The world's fog grid is MAP_FOG_GRID × MAP_FOG_GRID squares over the unit
 * map extent (UI Spec §1.8). Fixed in V1 — the default <wl-map> plugin and the
 * engine's explore gate share this constant by contract (the plugin cannot
 * import, so it carries the documented literal 8).
 */
export const MAP_FOG_GRID = 8;

/** One fog-grid square, addressed by column/row (0-based, top-left origin). */
export const MapSquareSchema = z.strictObject({
  col: z
    .int()
    .min(0)
    .max(MAP_FOG_GRID - 1),
  row: z
    .int()
    .min(0)
    .max(MAP_FOG_GRID - 1),
});
export type MapSquare = z.infer<typeof MapSquareSchema>;

/**
 * A sublocation gained its map presence (Rev 4 §14: materialization). Emitted
 * by: the `materialize` ledger job after both B6 gates (schema gate on the
 * LLM stub, then engine-state gate: square empty, world exists) — and by the
 * fresh-world seed for the fixture trio. Consumed by: map renderers (the fog
 * grid is a projection of these — explored = materialized, one reveal path
 * for Explore and background materialization alike), the client's
 * known-sublocations projection (Hang around), and the change_sublocation
 * engine-state gate (materialized ids are enterable).
 */
export const SublocationMaterializedEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('sublocation.materialized'),
  payload: z.strictObject({
    sublocation_id: z.string().min(1),
    name: z.string().min(1).max(120),
    /** The LLM-generated stub description (B6-gated before it lands here). */
    description: z.string().min(1).max(2000),
    /** The fog-grid square this materialization revealed. Placement is
     * code-owned (Rev 4 §14): the user's Explore click picks the square,
     * never the LLM. */
    square: MapSquareSchema,
    /** World-coordinate anchor for the pin (center of the square). */
    map_position: MapPositionSchema,
    /** Rev 4 §9 cold-boot seeding (0.17.0): whether the place is a public or
     * private space — the seeding gate's ≥1-of-each rule reads it. Absent on
     * Explore/map materializations (neither class). */
    space: z.enum(['public', 'private']).optional(),
    /** The approved proposal that applied this row (0.17.0 audit provenance;
     * absent on Explore reveals and Narrator-stub placements). */
    proposal_id: z.string().min(1).max(100).optional(),
  }),
});

/**
 * A Flow-A map edit was accepted (Rev 4 §14 Flow A): durable intent for the
 * lasso/pencil edit before any LLM or painter work happens. Clients render
 * the locked-region overlay from this until the edit's painter.completed
 * (job_key `painter:map:<world>:edit-<edit_id>`) or a job.parked carrying the
 * edit's job_key arrives. Emitted by: the map-edit command seam. Consumed by:
 * map renderers (lock overlay).
 */
export const MapEditRequestedEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('map_edit.requested'),
  payload: z.strictObject({
    /** The command's request_id — every artifact of this edit derives its
     * key from it (job keys, sublocation id), so retries converge. */
    edit_id: z.string().min(1).max(100),
    /** The drawn region: a closed polygon in world coordinates. The shape is
     * the user's own pencil/lasso — no segmentation model (Rev 4 §14). */
    points: z.array(MapPositionSchema).min(3).max(128),
    /** The user's spoken intent, length-capped before it nears a prompt (B7). */
    intent: z.string().min(1).max(500),
  }),
});

/**
 * A user-drawn sublocation entered the world (Rev 4 §14 Flow A step 6): the
 * GM form passed both B6 gates and code placed the row — pin at the mask
 * centroid, footprint = the drawn polygon. Distinct from
 * sublocation.materialized (square-grain fog reveals): Flow-A sublocations
 * are sub-square features and may share a fog square with its reveal
 * sublocation. Emitted by: the map_edit job handler. Consumed by: map
 * renderers (pin), the known-sublocations projection (enterable ids),
 * Flow-B footprint hit tests.
 */
export const SublocationCreatedEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('sublocation.created'),
  payload: z.strictObject({
    sublocation_id: z.string().min(1),
    name: z.string().min(1).max(120),
    /** The GM-form description (B6-gated before it lands here). */
    description: z.string().min(1).max(2000),
    /** World-coordinate anchor for the pin: the drawn mask's centroid. */
    map_position: MapPositionSchema,
    /** The drawn polygon, world coordinates — the Flow-B footprint. */
    footprint: z.array(MapPositionSchema).min(3).max(128),
    /** The originating edit (map_edit.requested payload's edit_id). */
    edit_id: z.string().min(1).max(100),
  }),
});

/**
 * The Narrator invented a place mid-scene (Rev 4 §6, 0.10.0): the
 * create_sublocation tool passed both B6 gates and committed this identity
 * stub atomically with its turn. Creation is hot, map presence is cold
 * (Rev 4 §14): a stub with a `parent_id` is an interior of that
 * exterior-atomic parent — it NEVER touches the map; its only asset is the
 * backdrop image (`backdrop:<sublocation_id>`), whose painter job fires in
 * the same transaction. A parentless stub additionally gets an eager
 * materialize job (code-owned frontier placement) — its map presence arrives
 * as a later sublocation.materialized carrying THIS sublocation_id.
 * Emitted by: the scene turn engine (actor = the Narrator). Consumed by:
 * the known-sublocations projection (stubs are enterable immediately),
 * the materialize handler (stub lookup), the backdrop prompt derivation.
 */
export const SublocationStubCreatedEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('sublocation.stub_created'),
  payload: z.strictObject({
    scene_id: z.string().min(1),
    sublocation_id: z.string().min(1),
    name: z.string().min(1).max(120),
    /** The Narrator's brief (tool input, gate-1 length-capped). */
    description: z.string().min(1).max(2000),
    /** The exterior-atomic parent (always flat, Rev 4 §6). Absent =
     * parentless: an exterior-atomic place awaiting materialization. */
    parent_id: z.string().min(1).optional(),
    /** Prose placement hint, recorded for the audit trail — placement
     * itself is code-owned (Rev 4 §14: no LLM ever picks a coordinate). */
    narrative_anchor: z.string().min(1).max(200).optional(),
  }),
});

/**
 * A Flow-B click classification resolved (Rev 4 §14 Flow B steps 2–5): the
 * VLM classification and the story LLM's invention both passed their B6
 * gates. `created` = a persistent spawn — this event IS the sublocation row
 * (the known-sublocations projection folds it in; pin at the click point).
 * `transient` = the discovery resolves and vanishes: no sublocation is ever
 * created, CRON/markers can never anchor to it — the name/description here
 * are the display-once discovery card, kept for the audit trail only.
 * Emitted by: the map_click job handler. Consumed by: map renderers,
 * the known-sublocations projection (`created` only).
 */
export const MapClickResolvedEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('map_click.resolved'),
  payload: z.strictObject({
    /** The command's request_id. */
    click_id: z.string().min(1).max(100),
    /** The clicked point — a `created` spawn's pin anchor. */
    point: MapPositionSchema,
    outcome: z.enum(['created', 'transient']),
    /** `created` only: the new sublocation's id (`subloc:click-<click_id>`). */
    sublocation_id: z.string().min(1).optional(),
    name: z.string().min(1).max(120),
    /** The story LLM's invention, inside the VLM classification (B6-gated). */
    description: z.string().min(1).max(2000),
  }),
});

export const SublocationChangedEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('sublocation.changed'),
  payload: z.strictObject({
    scene_id: z.string().min(1),
    sublocation_id: z.string().min(1),
    /** Display name for the scene header ("The Flooded Cellar"). */
    name: z.string().min(1),
    /**
     * Path (relative to the images dir) of a painter-generated backdrop, when
     * one exists. Absent = the client renders its themed placeholder backdrop.
     */
    backdrop_path: z.string().min(1).optional(),
    /** Where this sublocation sits on the world map — the map connector
     * surface the default <wl-map> plugin anchors its pins to. */
    map_position: MapPositionSchema.optional(),
  }),
});

/**
 * A character's displayed art changed — the VN line-up re-renders that
 * character's pose (UI Spec §1.5). Emitted by: the Narrator's switch_art tool
 * after both B6 gates (character present in the scene, art id in their art
 * set). Consumed by: clients (VN stage).
 */
export const ArtSwitchedEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('art.switched'),
  payload: z.strictObject({
    scene_id: z.string().min(1),
    character_id: z.string().min(1),
    /** A named pose from the character's fixture art set, e.g. "smile". */
    art_id: z.string().min(1),
  }),
});

/** A rectangular image region in pixels (painter jobs, map crops). */
export const ImageRegionSchema = z.strictObject({
  x: z.int().nonnegative(),
  y: z.int().nonnegative(),
  width: z.int().positive(),
  height: z.int().positive(),
});
export type ImageRegion = z.infer<typeof ImageRegionSchema>;

/**
 * A painter composite became durable. The EVENT is the truth about which file
 * is current (rendered artifacts are never truth, Brief §2.1): `path` +
 * `sha256` name the composited output written via temp-file + atomic rename —
 * composite-on-success, so a kill mid-job leaves the previous image intact.
 * Emitted by: the painter job handler. Consumed by: clients (map refresh),
 * the consistency verifier (hash check).
 */
export const PainterCompletedEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('painter.completed'),
  payload: z.strictObject({
    image_id: z.string().min(1),
    region: ImageRegionSchema,
    /** Path relative to the images directory. */
    path: z.string().min(1),
    sha256: z.string().length(64),
    /** The ledger idempotency key — ties the event to its job row. */
    job_key: z.string().min(1),
  }),
});

/**
 * A plugin failed validation or hash verification at load and was refused —
 * the app boots without it (Guide B10). Emitted by: the plugin loader.
 * Consumed by: clients (Config surface, dev mode).
 */
export const PluginRejectedEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('plugin.rejected'),
  payload: z.strictObject({
    /** The plugin folder name under plugins/. */
    plugin: z.string().min(1),
    reason: z.enum([
      'manifest_missing',
      'manifest_invalid',
      'engine_mismatch',
      'hash_mismatch',
      'backend_failed',
    ]),
    detail: z.string(),
  }),
});

/**
 * A newer release exists on the update channel (FINAL item 12). The release
 * metadata was safeParse'd but is still UNTRUSTED (Guide B12) — nothing is
 * downloaded or trusted until the apply path verifies SHA-256 + minisign.
 * Emitted by: the update_check job (startup + croner). Consumed by: clients
 * (Config badge / "update available" notice).
 */
export const UpdateAvailableEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('update.available'),
  payload: z.strictObject({
    /** The release version tag, e.g. "0.2.0". */
    version: z.string().min(1),
    current_version: z.string().min(1),
    /** Human release page — untrusted metadata, display only. */
    release_url: z.string().min(1).optional(),
  }),
});

/**
 * A verified update was staged and the `current` pointer flipped — the new
 * version starts on the next restart (FINAL item 12). Emitted by: the
 * update_apply job strictly AFTER SHA-256 + minisign verification passed
 * (Guide B12: the pointer-flip path takes a VerifiedArtifact only the
 * verifier constructs). Consumed by: clients ("restart to apply").
 */
export const UpdateStagedEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('update.staged'),
  payload: z.strictObject({
    version: z.string().min(1),
    previous_version: z.string().min(1),
    /** Hex SHA-256 of the verified artifact. */
    sha256: z.string().length(64),
  }),
});

/** Truncated error surface for the UI — never prompt content (Guide C7/C12). */
export const JobErrorSchema = z.strictObject({
  kind: z.enum(['operational', 'bug', 'corrupt_state']),
  code: z.string(),
  message: z.string(),
});

/**
 * A job failed an attempt and awaits its backoff retry. Emitted by: job runner
 * (the one catch site, Guide C7). Consumed by: clients (job status UI).
 */
export const JobFailedEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('job.failed'),
  payload: z.strictObject({
    job_id: z.int().positive(),
    job_type: z.string().min(1),
    attempts: z.int().positive(),
    error: JobErrorSchema,
    /** The ledger idempotency key — lets clients tie the failure back to the
     * command that enqueued it (e.g. release a map-edit region lock).
     * Optional: rows appended before 0.2.0 lack it. */
    job_key: z.string().min(1).optional(),
  }),
});

/**
 * A job entered the dead-letter lane — never auto-retried (Brief §2.2).
 * Emitted by: job runner. Consumed by: clients (owner should look, Guide C9).
 */
export const JobParkedEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('job.parked'),
  payload: z.strictObject({
    job_id: z.int().positive(),
    job_type: z.string().min(1),
    attempts: z.int().positive(),
    error: JobErrorSchema,
    /** The ledger idempotency key (see job.failed). Optional: rows appended
     * before 0.2.0 lack it. */
    job_key: z.string().min(1).optional(),
  }),
});

/** The closed union of durable event shapes on the wire. */
export const WeltariEventSchema = z.discriminatedUnion('type', [
  SceneStartedEventSchema,
  SceneEndedEventSchema,
  SceneExpiredEventSchema,
  CharacterJoinedEventSchema,
  CharacterLeftEventSchema,
  SceneGoalsUpdatedEventSchema,
  TurnStartedEventSchema,
  TurnCommittedEventSchema,
  ChatMessageCommittedEventSchema,
  ChatEndedEventSchema,
  ReflectChatCommittedEventSchema,
  ChatOutreachRecordedEventSchema,
  ChatThreadFrozenEventSchema,
  ChatNoticeEventSchema,
  ChatGroupStartedEventSchema,
  ChatGroupMessageCommittedEventSchema,
  ChatGroupEndedEventSchema,
  CacheAppendedEventSchema,
  CachePrunedEventSchema,
  MemoryDeltaCommittedEventSchema,
  MemoryCoreUpdatedEventSchema,
  MemoryCompactedEventSchema,
  CharacterEvolvedEventSchema,
  SubwikiUpdatedEventSchema,
  SubwikiEditedEventSchema,
  ObjectCreatedEventSchema,
  ObjectPayloadWrittenEventSchema,
  ObjectMovedEventSchema,
  ObjectSweptEventSchema,
  MarkerDroppedEventSchema,
  MarkerInstantiatedEventSchema,
  MarkerExpiredEventSchema,
  CharacterLocationChangedEventSchema,
  ProposalSubmittedEventSchema,
  ProposalResolvedEventSchema,
  ProposalDiscussedEventSchema,
  CharacterCreatedEventSchema,
  WorldSeededEventSchema,
  GatewayBindingEstablishedEventSchema,
  ConfigFlagSetEventSchema,
  CharacterLockSetEventSchema,
  ProfileUpdatedEventSchema,
  ProfileDeletedEventSchema,
  SocialPostCommittedEventSchema,
  SocialReactionCommittedEventSchema,
  SocialReplyPostedEventSchema,
  SocialReplyAnsweredEventSchema,
  SublocationChangedEventSchema,
  SublocationMaterializedEventSchema,
  SublocationCreatedEventSchema,
  SublocationStubCreatedEventSchema,
  MapEditRequestedEventSchema,
  MapClickResolvedEventSchema,
  ArtSwitchedEventSchema,
  ReflectionCommittedEventSchema,
  WorldAgentCommittedEventSchema,
  WorldTimeAdvancedEventSchema,
  WorldCronCompletedEventSchema,
  PainterCompletedEventSchema,
  PluginRejectedEventSchema,
  UpdateAvailableEventSchema,
  UpdateStagedEventSchema,
  JobFailedEventSchema,
  JobParkedEventSchema,
]);
export type WeltariEvent = z.infer<typeof WeltariEventSchema>;
export type WeltariEventType = WeltariEvent['type'];
