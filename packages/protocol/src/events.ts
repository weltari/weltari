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
     * Emitted by: the Narrator's end_scene tool (engine-validated, Guide B6).
     */
    end_type: z.enum(['rest', 'continuation', 'travel']).optional(),
    /** Soft-close divider line, e.g. "— evening falls —" (UI Spec §1.7). */
    divider_text: z.string().min(1).max(200).optional(),
    /**
     * The Narrator's next-scene registration (Rev 4 §6, 0.10.0): where the
     * "Jump to the next scene" button opens the follow-up scene. Present
     * exactly when end_type is `continuation` (the engine-state gate refuses
     * a continuation without it). May name a stub created this very turn —
     * that is the in-scene creation loop's payoff.
     */
    next_scene: z
      .strictObject({
        sublocation_id: z.string().min(1),
        /** Optional premise line the follow-up scene opens on. */
        premise_seed: z.string().min(1).max(500).optional(),
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
 * reply) and the reflection handler (origin `scene`, this slice's stand-in
 * until the C-Module writes in-scene). Consumed by: chat context assembly
 * (latest-per-origin catch-up), dev mode.
 */
export const CacheAppendedEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('cache.appended'),
  payload: z.strictObject({
    character_id: z.string().min(1),
    origin: z.enum(['scene', 'chat']),
    /** The scene id or conversation id the entry points back into. */
    context_id: z.string().min(1),
    /** Where it happened, when known (scene-origin entries). */
    sublocation_id: z.string().min(1).optional(),
    /** The character-authored one-liner (engine-capped). */
    line: z.string().min(1).max(300),
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
  SubwikiUpdatedEventSchema,
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
