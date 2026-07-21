// Render-only state (Brief §2.5): every field here is a projection of
// server-pushed frames, rebuilt from the event replay on every (re)connect.
// The ONLY writer is the SSE reducer in stream.ts — components read via
// useSceneStore and never call the apply* actions (structure.md contract).
import { create } from 'zustand';
import type {
  DevEvent,
  StreamSentence,
  TurnStep,
  WeltariEvent,
} from '@weltari/protocol';

export interface UpdateAvailable {
  version: string;
  current_version: string;
  release_url?: string | undefined;
}

export interface UpdateStaged {
  version: string;
  previous_version: string;
  sha256: string;
}

export interface PluginRejection {
  plugin: string;
  reason: string;
  detail: string;
}

export interface UpdateJobError {
  code: string;
  message: string;
  parked: boolean;
}

export interface CommittedTurn {
  turn_id: string;
  steps: TurnStep[];
  interrupted: boolean;
}

export interface SceneEnd {
  /** 0.21.0: `context_limit_reached` renders like `rest` (Stay + Map) —
   * SoftClose keys on `travel`/`continuation` only, by design. */
  end_type: 'rest' | 'continuation' | 'travel' | 'context_limit_reached';
  divider_text: string;
  /** The continuation registration (0.10.0) — where "Jump to the next
   * scene" opens; may name a stub created mid-scene. */
  next_scene?: { sublocation_id: string; premise_seed?: string | undefined };
}

export interface CastMember {
  character_id: string;
  name: string;
}

export interface KnownSublocation {
  sublocation_id: string;
  name: string;
  description: string;
  map_position: { x: number; y: number };
}

/**
 * One played scene, rebuilt purely from replayed scene.started/scene.ended +
 * character.joined + turn.committed (the History surface, wireframe 04). A
 * restart loses nothing: the projection re-derives from the log.
 */
export interface HistoryScene {
  scene_id: string;
  title: string;
  /** Fictional time when the scene opened, if the clock had ever advanced. */
  world_time: string | null;
  participants: CastMember[];
  turns: CommittedTurn[];
  ended: boolean;
  end_type: 'rest' | 'continuation' | 'travel' | 'context_limit_reached' | null;
  divider_text: string | null;
}

export interface ChatMessage {
  message_id: string;
  /** `notice` = a hardcoded engine line (chat.notice, 0.13.0) — rendered as
   * a small red system line, never as a character bubble. */
  sender: 'user' | 'character' | 'notice';
  text: string;
  /** Wall-clock append time from the event envelope (ISO). */
  ts: string;
  /** Log id of the carrying event (0.20.0) — the GM thread interleaves
   * messages and proposal cards by this order. */
  event_id: number;
}

/**
 * One DM thread with a character (UI Spec §2.4) — a pure projection of
 * chat.message_committed / chat.ended events; a restart rebuilds it exactly
 * (the transcript survives because the events do, 0.11.0).
 */
export interface ChatThread {
  conversation_id: string;
  character_id: string;
  messages: ChatMessage[];
  /** How the latest range closed, if it did after the newest message —
   * absent while the conversation is running. */
  lastEnded: { reason: 'exit' | 'idle' | 'startscene' } | null;
}

/**
 * One group chat (0.14.0, UI Spec §2.4 group view) — a pure projection of
 * chat.group_started/group_message_committed/group_ended; replay-rebuilt.
 * Character lines carry the speaker id so the view can label them.
 */
export interface GroupThread {
  conversation_id: string;
  title: string;
  member_ids: string[];
  messages: (ChatMessage & { speaker_id?: string })[];
  lastEnded: { reason: 'exit' | 'endsubsession' } | null;
}

export interface FeedReplyLine {
  reply_id: string;
  author: 'user' | 'character';
  body: string;
  ts: string;
}

/** One reaction on a feed post (0.15.0): a like, or a comment carrying its
 * feed-local reply thread (owner ruling 2026-07-11: the user may reply to a
 * comment; the author answers — never routed into Weltari Chat). */
export interface FeedReaction {
  reaction_id: string;
  character_id: string;
  kind: 'like' | 'comment';
  body: string | null;
  replies: FeedReplyLine[];
  ts: string;
}

/** One feed post (0.15.0, Rev 4 §12) — a pure projection of
 * social.post_committed / reaction / reply events; replay-rebuilt. */
export interface FeedPost {
  post_id: string;
  character_id: string;
  body: string;
  /** The fictional clock at fire time. */
  game_time: string;
  ts: string;
  reactions: FeedReaction[];
}

/** One bell item (0.15.0): a character answered MY reply on a comment —
 * the only thing directed at the user in V1 (they cannot post yet). */
export interface FeedNotification {
  reply_id: string;
  post_id: string;
  reaction_id: string;
  character_id: string;
  body: string;
  event_id: number;
  ts: string;
}

/** The §16 uniform consent object as it rides proposal.submitted (0.17.0) —
 * the card renders straight from the wire payload. */
export type ProposalPayload = Extract<
  WeltariEvent,
  { type: 'proposal.submitted' }
>['payload'];

/** One GM consent card (0.17.0 → 0.20.0): kept in the fold forever — a
 * resolution settles the card in place instead of removing it, so the GM
 * thread's interleaved transcript replays exactly. */
export interface GmProposal {
  /** Log id of proposal.submitted — the card's exact position between the
   * thread's messages (the transcript interleaves by event order). */
  event_id: number;
  ts: string;
  payload: ProposalPayload;
  status: 'pending' | 'approved' | 'rejected';
  /** The user clicked "Chat about this" while the card was pending. */
  discussed: boolean;
}

/** A scene-side stream frame: `call: 'gm'` frames ride the GM thread's own
 * buffer (0.20.0), so the scene pacing surfaces never see one — typed out
 * here instead of guarded in every consumer. */
export type SceneStreamSentence = Omit<StreamSentence, 'call'> & {
  call: 'narrator' | 'character' | 'narration';
};

export interface SceneStore {
  connected: boolean;
  protocolVersion: string | null;
  /** From the hello frame (0.8.0) — the splash footer + Config facts. */
  appVersion: string | null;
  sceneId: string | null;
  sceneTitle: string;
  /** Set on scene.ended — drives the soft-close button set (UI Spec §1.7). */
  sceneEnd: SceneEnd | null;
  /** True when the current sceneEnd arrived LIVE (after the replay caught
   * up) — a live end keeps its soft close; a replayed one means the splash
   * (wireframe 03 vs UI Spec §1.7). */
  sceneEndedLive: boolean;
  /** hello's last_event_id — everything at or below it is replay, not live. */
  replayTarget: number;
  replayCaughtUp: boolean;
  /** The scene's roster — character.joined since scene.started (VN line-up). */
  cast: CastMember[];
  /** Every materialized sublocation (fog projection, 0.8.0) — the splash's
   * Hang around picks a random one; explored = materialized. */
  knownSublocations: KnownSublocation[];
  /** Every scene ever played, in open order (the History modal's projection). */
  history: HistoryScene[];
  /** Group chats by conversation id (0.14.0, the /chats group view). */
  groupThreads: Record<string, GroupThread>;
  /** Latest world.time_advanced `to` — engine-owned fictional time, read never invented. */
  worldTime: string | null;
  /** The latest skip + how many cron occurrences it enqueued (Gameday flow). */
  timeAdvance: { from: string; to: string; enqueued: number } | null;
  /** world_cron.completed count since the latest skip — the replay progress
   * the Gameday dial animation masks ("catching up", UI Spec §1.11). */
  cronCompleted: number;
  /** `from` of the FIRST world.time_advanced — the day-1 anchor "GAMEDAY N"
   * counts from. Still a pure projection: the full log replays on connect. */
  worldEpoch: string | null;
  /** '' until the first sublocation.changed (the default backdrop token). */
  sublocationId: string;
  sublocationName: string;
  /** The backdrop we are sliding away from (previous layer of the transition). */
  previousSublocationId: string | null;
  /** sublocation_id → painter-generated backdrop path (0.10.0): fed by
   * painter.completed for `backdrop:<id>` images and by
   * sublocation.changed's backdrop_path. Absent id = themed placeholder;
   * a live arrival replays the slide transition (UI Spec §1.6). */
  backdropBySublocation: Record<string, string>;
  /** character_id → current art_id (art.switched projection). */
  artByCharacter: Record<string, string>;
  turns: CommittedTurn[];
  /** turn.started seen, no turn.committed yet ("thinking" indicator). */
  openTurnId: string | null;
  /** The latest turn that streamed display-only sentences (B6: never durable). */
  liveTurnId: string | null;
  liveSentences: SceneStreamSentence[];
  /** The GM reply currently streaming (0.20.0): `call: 'gm'` frames for one
   * conversation — display-only, replaced on index 0 (a correction-loop
   * retry restarts the stream), cleared when the committed message lands. */
  gmLiveConversationId: string | null;
  gmLiveSentences: StreamSentence[];
  /** Dev channel ring buffer (?dev=1 only) — the log-only trail (UI Spec §2.8). */
  devFrames: DevEvent[];
  /** Latest update.available — the Config badge (untrusted metadata, B12). */
  updateAvailable: UpdateAvailable | null;
  /** Latest update.staged — "restart to apply" (Config surface). */
  updateStaged: UpdateStaged | null;
  /** update_apply job failures — surfaced honestly on Config, cleared by a stage. */
  updateJobError: UpdateJobError | null;
  /** Plugins refused at load (B10) — Config shows them calmly, never hides them. */
  pluginRejections: PluginRejection[];
  /** character_id → DM thread (Weltari Chat, 0.11.0) — replay-rebuilt. */
  chatThreads: Record<string, ChatThread>;
  /** sublocation_id → its wiki entry (subwiki.updated + subwiki.edited
   * projection, M6 parts 3+5): latest per sublocation WINS — the Wiki
   * page's source. Provenance: sceneId for a World-Agent pass,
   * editedByUser for a manual edit (UI Spec §2.6). */
  subwikiBySublocation: Record<
    string,
    { entry: string; sceneId: string | null; editedByUser: boolean }
  >;
  /** Narrator-stub names (sublocation.stub_created) — interiors never
   * materialize, so the Wiki page resolves their names here. */
  stubNames: Record<string, string>;
  /** The Feed (0.15.0, Rev 4 §12): posts in append order; the page renders
   * newest-first. Viewer-only for top-level posts. */
  feedPosts: FeedPost[];
  /** Bell items, oldest first (0.15.0): character answers to MY replies. */
  feedNotifications: FeedNotification[];
  /** Highest event id among social.* events — the NavRail red dot compares
   * it against the locally persisted seen mark (a view concern; the dot
   * itself never lives in the store). */
  feedLastEventId: number;
  /** Highest subwiki.updated event id (World Agent writes only — the blue
   * dot announces the world writing, not the user's own edits). */
  wikiLastEventId: number;
  /** Every proposal in submit order (0.17.0 → 0.20.0, Rev 4 §16) — the
   * consent cards inline in the GM conversation; proposal.resolved settles
   * a card in place (status), proposal.discussed marks the talk. */
  gmProposals: GmProposal[];
  /** The profiling_enabled fold (0.17.0, Rev 4 §15) — latest config.flag_set
   * wins; false until one arrives (consent-first default). */
  profilingEnabled: boolean;
  /** character_id → evolution lock (0.17.0, Rev 4 §7) — latest
   * character.lock_set wins; absent = the seed default (unlocked). */
  characterLocks: Record<string, boolean>;
  /** True once world.seeded arrived (0.17.0, Rev 4 §9) — cold boot's
   * terminal state; the onboarding surface keys off it. */
  worldSeeded: boolean;

  // ---- reducer actions: called ONLY from stream.ts ----
  setConnected(connected: boolean): void;
  applyHello(
    protocolVersion: string,
    appVersion: string | undefined,
    lastEventId: number,
  ): void;
  applyEvent(event: WeltariEvent): void;
  applyStream(frame: StreamSentence): void;
  applyDev(frame: DevEvent): void;
}

const DEV_RING = 100;

function applyOne(
  set: (
    partial: Partial<SceneStore> | ((state: SceneStore) => Partial<SceneStore>),
  ) => void,
  event: WeltariEvent,
): void {
  switch (event.type) {
    case 'scene.started':
      set((state) => ({
        sceneId: event.payload.scene_id,
        sceneTitle: event.payload.title,
        sceneEnd: null,
        sceneEndedLive: false,
        cast: [],
        // A fresh scene starts every character at the default pose — the
        // previous scene's switches must not leak across (they'd survive
        // both live navigation and a full replay).
        artByCharacter: {},
        history: state.history.some(
          (h) => h.scene_id === event.payload.scene_id,
        )
          ? state.history
          : [
              ...state.history,
              {
                scene_id: event.payload.scene_id,
                title: event.payload.title,
                world_time: state.worldTime,
                participants: [],
                turns: [],
                ended: false,
                end_type: null,
                divider_text: null,
              },
            ],
      }));
      return;
    case 'character.joined':
      set((state) => {
        const member: CastMember = {
          character_id: event.payload.character_id,
          name: event.payload.name,
        };
        const history = state.history.map((h) =>
          h.scene_id === event.payload.scene_id &&
          !h.participants.some((m) => m.character_id === member.character_id)
            ? { ...h, participants: [...h.participants, member] }
            : h,
        );
        if (
          event.payload.scene_id !== state.sceneId ||
          state.cast.some((m) => m.character_id === event.payload.character_id)
        ) {
          return { history };
        }
        return { history, cast: [...state.cast, member] };
      });
      return;
    case 'character.left':
      // The agentic scene (0.21.0, Rev 4 §6): the VN line-up drops the
      // character; the scene-history participants keep them (they were part
      // of the scene and their reflection will still run at scene end).
      set((state) =>
        event.payload.scene_id === state.sceneId
          ? {
              cast: state.cast.filter(
                (m) => m.character_id !== event.payload.character_id,
              ),
            }
          : {},
      );
      return;
    case 'scene.goals_updated':
      // Engine-internal story state (the Narrator's subgoal snapshot) — the
      // scene surface renders nothing for it by design (Rev 4 §6: goals are
      // Narrator-only, never shown to characters or the player).
      return;
    case 'scene.ended':
      set((state) => ({
        sceneEnd: {
          end_type: event.payload.end_type ?? 'rest',
          divider_text: event.payload.divider_text ?? '— the scene rests —',
          ...(event.payload.next_scene === undefined
            ? {}
            : { next_scene: event.payload.next_scene }),
        },
        // replayCaughtUp still holds the PRE-event value here (the flip
        // happens after applyOne) — a replayed end is not a live end.
        sceneEndedLive: state.replayCaughtUp,
        openTurnId: null,
        history: state.history.map((h) =>
          h.scene_id === event.payload.scene_id
            ? {
                ...h,
                ended: true,
                end_type: event.payload.end_type ?? 'rest',
                divider_text: event.payload.divider_text ?? null,
              }
            : h,
        ),
      }));
      return;
    case 'turn.started':
      set((state) => ({
        openTurnId: event.payload.turn_id,
        // A new envelope obsoletes the previous turn's display buffer.
        ...(state.liveTurnId !== event.payload.turn_id
          ? { liveTurnId: event.payload.turn_id, liveSentences: [] }
          : {}),
      }));
      return;
    case 'turn.committed':
      set((state) => {
        if (state.turns.some((t) => t.turn_id === event.payload.turn_id)) {
          return {};
        }
        const turn: CommittedTurn = {
          turn_id: event.payload.turn_id,
          steps: event.payload.steps,
          interrupted: event.payload.interrupted ?? false,
        };
        return {
          turns: [...state.turns, turn],
          history: state.history.map((h) =>
            h.scene_id === event.payload.scene_id &&
            !h.turns.some((t) => t.turn_id === turn.turn_id)
              ? { ...h, turns: [...h.turns, turn] }
              : h,
          ),
          openTurnId:
            state.openTurnId === event.payload.turn_id
              ? null
              : state.openTurnId,
        };
      });
      return;
    case 'sublocation.changed':
      set((state) => ({
        previousSublocationId: state.sublocationId,
        sublocationId: event.payload.sublocation_id,
        sublocationName: event.payload.name,
        ...(event.payload.backdrop_path === undefined
          ? {}
          : {
              backdropBySublocation: {
                ...state.backdropBySublocation,
                [event.payload.sublocation_id]: event.payload.backdrop_path,
              },
            }),
      }));
      return;
    case 'art.switched':
      // Poses are scene-scoped (the switch_art gate runs against the scene's
      // roster): only the current scene's switches project — a replayed
      // switch from an earlier scene must not restyle the line-up.
      set((state) =>
        event.payload.scene_id === state.sceneId
          ? {
              artByCharacter: {
                ...state.artByCharacter,
                [event.payload.character_id]: event.payload.art_id,
              },
            }
          : {},
      );
      return;
    case 'world.time_advanced':
      set((state) => ({
        worldTime: event.payload.to,
        timeAdvance: {
          from: event.payload.from,
          to: event.payload.to,
          enqueued: event.payload.code_enqueued + event.payload.llm_enqueued,
        },
        cronCompleted: 0,
        worldEpoch: state.worldEpoch ?? event.payload.from,
      }));
      return;
    case 'world_cron.completed':
      set((state) => ({ cronCompleted: state.cronCompleted + 1 }));
      return;
    case 'update.available':
      set({ updateAvailable: event.payload });
      return;
    case 'update.staged':
      set({ updateStaged: event.payload, updateJobError: null });
      return;
    case 'plugin.rejected':
      set((state) => ({
        pluginRejections: [...state.pluginRejections, event.payload],
      }));
      return;
    case 'job.failed':
    case 'job.parked':
      // Only the update path surfaces job errors today (Config page);
      // a general job-status UI is a later milestone.
      if (event.payload.job_type === 'update_apply') {
        set({
          updateJobError: {
            code: event.payload.error.code,
            message: event.payload.error.message,
            parked: event.type === 'job.parked',
          },
        });
      }
      return;
    case 'sublocation.materialized':
      set((state) => {
        if (
          state.knownSublocations.some(
            (s) => s.sublocation_id === event.payload.sublocation_id,
          )
        ) {
          return {};
        }
        return {
          knownSublocations: [
            ...state.knownSublocations,
            {
              sublocation_id: event.payload.sublocation_id,
              name: event.payload.name,
              description: event.payload.description,
              map_position: event.payload.map_position,
            },
          ],
        };
      });
      return;
    case 'sublocation.created':
      // Flow-A sublocations are enterable like materialized ones (Hang
      // around, open-scene AT) — same known-sublocations projection.
      set((state) => {
        if (
          state.knownSublocations.some(
            (s) => s.sublocation_id === event.payload.sublocation_id,
          )
        ) {
          return {};
        }
        return {
          knownSublocations: [
            ...state.knownSublocations,
            {
              sublocation_id: event.payload.sublocation_id,
              name: event.payload.name,
              description: event.payload.description,
              map_position: event.payload.map_position,
            },
          ],
        };
      });
      return;
    case 'map_click.resolved':
      // Only a persistent Flow-B spawn becomes an enterable place; transient
      // discoveries never enter the projection (Rev 4 §14 persistence).
      if (
        event.payload.outcome !== 'created' ||
        event.payload.sublocation_id === undefined
      ) {
        return;
      }
      set((state) => {
        const id = event.payload.sublocation_id;
        if (
          id === undefined ||
          state.knownSublocations.some((s) => s.sublocation_id === id)
        ) {
          return {};
        }
        return {
          knownSublocations: [
            ...state.knownSublocations,
            {
              sublocation_id: id,
              name: event.payload.name,
              description: event.payload.description,
              map_position: event.payload.point,
            },
          ],
        };
      });
      return;
    case 'painter.completed': {
      // The backdrop image class (0.10.0): `backdrop:<sublocation_id>`. A
      // live arrival for the CURRENT sublocation re-keys the stage layer —
      // the slide transition plays the moment the real backdrop lands
      // (UI Spec §1.6). Map paints stay the wl-map plugin's business.
      const prefix = 'backdrop:';
      if (!event.payload.image_id.startsWith(prefix)) return;
      const sublocationId = event.payload.image_id.slice(prefix.length);
      const path = event.payload.path;
      set((state) => ({
        backdropBySublocation: {
          ...state.backdropBySublocation,
          [sublocationId]: path,
        },
      }));
      return;
    }
    case 'sublocation.stub_created':
      // Stubs are enterable through scenes only (Rev 4 §14) — the map
      // ignores them and Hang around never lands on one. Their NAME still
      // projects (M6 part 3): the Wiki page must never show a raw stub id
      // for an interior that will never materialize.
      set((state) => ({
        stubNames: {
          ...state.stubNames,
          [event.payload.sublocation_id]: event.payload.name,
        },
      }));
      return;
    case 'chat.message_committed':
      set((state) => {
        const characterId = event.payload.character_id;
        const existing = state.chatThreads[characterId];
        if (
          existing?.messages.some(
            (m) => m.message_id === event.payload.message_id,
          ) === true
        ) {
          return {};
        }
        const message: ChatMessage = {
          message_id: event.payload.message_id,
          sender: event.payload.sender,
          text: event.payload.text,
          ts: event.ts,
          event_id: event.id,
        };
        const thread: ChatThread = {
          conversation_id: event.payload.conversation_id,
          character_id: characterId,
          messages: [...(existing?.messages ?? []), message],
          // A new message reopens the thread (the conversation_id is stable;
          // an ended range just means the NEXT message starts a new one).
          lastEnded: null,
        };
        return {
          chatThreads: { ...state.chatThreads, [characterId]: thread },
          // The committed reply supersedes its live stream (B6): the GM
          // buffer for this conversation is done the moment the durable
          // message lands.
          ...(event.payload.sender === 'character' &&
          state.gmLiveConversationId === event.payload.conversation_id
            ? { gmLiveConversationId: null, gmLiveSentences: [] }
            : {}),
        };
      });
      return;
    case 'chat.ended':
      set((state) => {
        const existing = state.chatThreads[event.payload.character_id];
        if (existing === undefined) return {};
        return {
          chatThreads: {
            ...state.chatThreads,
            [event.payload.character_id]: {
              ...existing,
              lastEnded: { reason: event.payload.reason },
            },
          },
        };
      });
      return;
    case 'chat.group_started':
      set((state) => ({
        groupThreads: {
          ...state.groupThreads,
          [event.payload.conversation_id]: state.groupThreads[
            event.payload.conversation_id
          ] ?? {
            conversation_id: event.payload.conversation_id,
            title: event.payload.title,
            member_ids: event.payload.member_ids,
            messages: [],
            lastEnded: null,
          },
        },
      }));
      return;
    case 'chat.group_message_committed':
      set((state) => {
        const existing = state.groupThreads[event.payload.conversation_id];
        if (existing === undefined) return {};
        if (
          existing.messages.some(
            (m) => m.message_id === event.payload.message_id,
          )
        ) {
          return {};
        }
        return {
          groupThreads: {
            ...state.groupThreads,
            [event.payload.conversation_id]: {
              ...existing,
              messages: [
                ...existing.messages,
                {
                  message_id: event.payload.message_id,
                  sender: event.payload.sender,
                  text: event.payload.text,
                  ts: event.ts,
                  event_id: event.id,
                  ...(event.payload.character_id === undefined
                    ? {}
                    : { speaker_id: event.payload.character_id }),
                },
              ],
              lastEnded: null,
            },
          },
        };
      });
      return;
    case 'chat.group_ended':
      set((state) => {
        const existing = state.groupThreads[event.payload.conversation_id];
        if (existing === undefined) return {};
        return {
          groupThreads: {
            ...state.groupThreads,
            [event.payload.conversation_id]: {
              ...existing,
              lastEnded: { reason: event.payload.reason },
            },
          },
        };
      });
      return;
    case 'chat.notice':
      // The red line (0.13.0, owner ruling 2026-07-11): a hardcoded engine
      // notice — e.g. a startscene fire that exhausted its retry ceiling and
      // rolled back — rides the thread like a transcript line.
      set((state) => {
        const characterId = event.payload.character_id;
        const existing = state.chatThreads[characterId];
        const noticeId = `notice-${String(event.id)}`;
        if (
          existing?.messages.some((m) => m.message_id === noticeId) === true
        ) {
          return {};
        }
        const message: ChatMessage = {
          message_id: noticeId,
          sender: 'notice',
          text: event.payload.text,
          ts: event.ts,
          event_id: event.id,
        };
        return {
          chatThreads: {
            ...state.chatThreads,
            [characterId]: {
              conversation_id: event.payload.conversation_id,
              character_id: characterId,
              messages: [...(existing?.messages ?? []), message],
              lastEnded: existing?.lastEnded ?? null,
            },
          },
        };
      });
      return;
    case 'scene.expired':
      // Invitation expiry (0.13.0, Rev 4 §7): the never-entered meeting
      // closed — clear it if it is somehow the viewed scene (back to the
      // splash), and close its History entry with the expiry divider. The
      // character's complaint arrives later, in character, via chat.
      set((state) => ({
        ...(state.sceneId === event.payload.scene_id
          ? {
              sceneId: null,
              sceneEnd: null,
              sceneEndedLive: false,
              cast: [],
              openTurnId: null,
            }
          : {}),
        history: state.history.map((h) =>
          h.scene_id === event.payload.scene_id
            ? {
                ...h,
                ended: true,
                end_type: 'rest' as const,
                divider_text: '— the meeting expired —',
              }
            : h,
        ),
      }));
      return;
    // No projection (yet): these surfaces arrive in later milestones
    // (map refresh, feed, job status UI). map_edit.requested is the map
    // plugin's lock overlay — it reads the stream directly. reflect_chat
    // and CACHE entries are log-only trail surfaces (dev mode, §2.8).
    case 'subwiki.updated':
      // The Wiki projection (M6 part 3, UI Spec §2.6): latest entry per
      // sublocation wins; full history stays in the log (auditable).
      set((state) => ({
        subwikiBySublocation: {
          ...state.subwikiBySublocation,
          [event.payload.sublocation_id]: {
            entry: event.payload.entry,
            sceneId: event.payload.scene_id,
            editedByUser: false,
          },
        },
        wikiLastEventId: Math.max(state.wikiLastEventId, event.id),
      }));
      return;
    case 'subwiki.edited':
      // A manual user edit (0.15.0, owner ruling 2026-07-11): applied
      // immediately, same latest-wins projection; provenance = the user.
      // No blue dot — the dot announces the WORLD writing, not the user.
      // 0.17.0: an approved GM proposal applies through the same event with
      // the GM as actor — the "edited by you" label follows the actor.
      set((state) => ({
        subwikiBySublocation: {
          ...state.subwikiBySublocation,
          [event.payload.sublocation_id]: {
            entry: event.payload.entry,
            sceneId: null,
            editedByUser: event.actor_id.startsWith('user:'),
          },
        },
      }));
      return;
    case 'social.post_committed':
      // The Feed (0.15.0, Rev 4 §12): one post per cadence boundary.
      set((state) => {
        if (state.feedPosts.some((p) => p.post_id === event.payload.post_id)) {
          return { feedLastEventId: Math.max(state.feedLastEventId, event.id) };
        }
        return {
          feedPosts: [
            ...state.feedPosts,
            {
              post_id: event.payload.post_id,
              character_id: event.payload.character_id,
              body: event.payload.body,
              game_time: event.payload.game_time,
              ts: event.ts,
              reactions: [],
            },
          ],
          feedLastEventId: Math.max(state.feedLastEventId, event.id),
        };
      });
      return;
    case 'social.reaction_committed':
      set((state) => ({
        feedPosts: state.feedPosts.map((post) => {
          if (post.post_id !== event.payload.post_id) return post;
          if (
            post.reactions.some(
              (r) => r.reaction_id === event.payload.reaction_id,
            )
          ) {
            return post;
          }
          return {
            ...post,
            reactions: [
              ...post.reactions,
              {
                reaction_id: event.payload.reaction_id,
                character_id: event.payload.character_id,
                kind: event.payload.kind,
                body: event.payload.body ?? null,
                replies: [],
                ts: event.ts,
              },
            ],
          };
        }),
        feedLastEventId: Math.max(state.feedLastEventId, event.id),
      }));
      return;
    case 'social.reply_posted':
    case 'social.reply_answered': {
      // The feed-local comment thread (0.15.0): user replies and character
      // answers hang under the comment they belong to, in event order.
      const line: FeedReplyLine = {
        reply_id: event.payload.reply_id,
        author: event.type === 'social.reply_posted' ? 'user' : 'character',
        body: event.payload.body,
        ts: event.ts,
      };
      set((state) => ({
        feedPosts: state.feedPosts.map((post) => {
          if (post.post_id !== event.payload.post_id) return post;
          return {
            ...post,
            reactions: post.reactions.map((reaction) => {
              if (reaction.reaction_id !== event.payload.reaction_id) {
                return reaction;
              }
              if (reaction.replies.some((r) => r.reply_id === line.reply_id)) {
                return reaction;
              }
              return { ...reaction, replies: [...reaction.replies, line] };
            }),
          };
        }),
        feedLastEventId: Math.max(state.feedLastEventId, event.id),
        // An answer to MY reply is the one thing directed at me — the bell.
        ...(event.type === 'social.reply_answered' &&
        !state.feedNotifications.some(
          (n) => n.reply_id === event.payload.reply_id,
        )
          ? {
              feedNotifications: [
                ...state.feedNotifications,
                {
                  reply_id: event.payload.reply_id,
                  post_id: event.payload.post_id,
                  reaction_id: event.payload.reaction_id,
                  character_id: event.payload.character_id,
                  body: event.payload.body,
                  event_id: event.id,
                  ts: event.ts,
                },
              ],
            }
          : {}),
      }));
      return;
    }
    // The proactive DM itself arrives as chat.message_committed above; the
    // outreach record is bookkeeping, and a frozen thread shows NOTHING in
    // Weltari Chat (owner ruling 2026-07-10: the unread bubble suffices —
    // the "waiting for you" notice is the part-4 gateway push).
    // The memory store (0.16.0, M7 part 1) is engine-side state too: deltas,
    // core snapshots, evolution, compaction records and CACHE watermarks
    // feed prompts and memoryquery — no client surface in V1 (a memory
    // viewer arrives with the GM/config work).
    case 'reflection.committed':
    case 'world_agent.committed':
    case 'map_edit.requested':
    case 'reflect_chat.committed':
    case 'cache.appended':
    case 'chat.outreach_recorded':
    case 'chat.thread_frozen':
    case 'memory.delta_committed':
    case 'memory.core_updated':
    case 'memory.compacted':
    case 'character.evolved':
    case 'cache.pruned':
      return;
    // Objects (0.18.0, M7 part 3): engine-side state only in V1 — the
    // backpack UI defers to V2 with character/user holders (owner ruling
    // 2026-07-16); public objects reach the user through narration and
    // explore results, not a client projection.
    case 'object.created':
    case 'object.payload_written':
    case 'object.moved':
    case 'object.swept':
      return;
    // The living-world loop (0.19.0, M7 part 4): markers and character
    // positions are the map plugin's business — <wl-map> reads the stream
    // directly (structure.md: pins and fog never live in this store).
    case 'marker.dropped':
    case 'marker.instantiated':
    case 'marker.expired':
    case 'character.location_changed':
      return;
    // The GM consent cards (0.17.0 → 0.20.0, Rev 4 §16, the UX contract):
    // every card stays in the fold forever — a resolution SETTLES it in
    // place (status flips, the verdict renders under the diff) instead of
    // removing it, so replay rebuilds the interleaved transcript exactly.
    case 'proposal.submitted': {
      set((state) => ({
        gmProposals: [
          ...state.gmProposals,
          {
            event_id: event.id,
            ts: event.ts,
            payload: event.payload,
            status: 'pending' as const,
            discussed: false,
          },
        ],
      }));
      return;
    }
    case 'proposal.resolved': {
      set((state) => ({
        gmProposals: state.gmProposals.map((p) =>
          p.payload.proposal_id === event.payload.proposal_id
            ? { ...p, status: event.payload.resolution }
            : p,
        ),
      }));
      return;
    }
    // The "Chat about this" signal (0.20.0): the card shows the talk is on;
    // the GM's durable follow-up turn consumes it server-side.
    case 'proposal.discussed': {
      set((state) => ({
        gmProposals: state.gmProposals.map((p) =>
          p.payload.proposal_id === event.payload.proposal_id
            ? { ...p, discussed: true }
            : p,
        ),
      }));
      return;
    }
    case 'config.flag_set': {
      // flag → store field; a new wire flag fails to compile until mapped.
      const field = { profiling_enabled: 'profilingEnabled' } as const;
      set({ [field[event.payload.flag]]: event.payload.value });
      return;
    }
    case 'character.lock_set': {
      set((state) => ({
        characterLocks: {
          ...state.characterLocks,
          [event.payload.character_id]: event.payload.locked,
        },
      }));
      return;
    }
    case 'world.seeded': {
      set({ worldSeeded: true });
      return;
    }
    // Engine-side state (0.17.0): created characters enter the roster fold
    // server-side; binding pushes and profile references carry no client
    // surface (the hypotheses never ride the log: GDPR — the Config page
    // fetches them from GET /v1/profile instead).
    case 'character.created':
    case 'gateway.binding_established':
    case 'profile.updated':
    case 'profile.deleted':
      return;
  }
}

export const useSceneStore = create<SceneStore>((set) => ({
  connected: false,
  protocolVersion: null,
  appVersion: null,
  sceneId: null,
  sceneTitle: 'Weltari',
  sceneEnd: null,
  sceneEndedLive: false,
  replayTarget: 0,
  replayCaughtUp: false,
  cast: [],
  knownSublocations: [],
  history: [],
  worldTime: null,
  timeAdvance: null,
  cronCompleted: 0,
  worldEpoch: null,
  sublocationId: '',
  sublocationName: '',
  previousSublocationId: null,
  backdropBySublocation: {},
  artByCharacter: {},
  turns: [],
  openTurnId: null,
  liveTurnId: null,
  liveSentences: [],
  gmLiveConversationId: null,
  gmLiveSentences: [],
  devFrames: [],
  updateAvailable: null,
  updateStaged: null,
  updateJobError: null,
  pluginRejections: [],
  chatThreads: {},
  groupThreads: {},
  subwikiBySublocation: {},
  stubNames: {},
  feedPosts: [],
  feedNotifications: [],
  feedLastEventId: 0,
  wikiLastEventId: 0,
  gmProposals: [],
  profilingEnabled: false,
  characterLocks: {},
  worldSeeded: false,

  setConnected(connected: boolean): void {
    set({ connected });
  },

  applyHello(
    protocolVersion: string,
    appVersion: string | undefined,
    lastEventId: number,
  ): void {
    set({
      protocolVersion,
      appVersion: appVersion ?? null,
      replayTarget: lastEventId,
      replayCaughtUp: lastEventId === 0,
    });
  },

  applyEvent(event: WeltariEvent): void {
    applyOne(set, event);
    // Flipped AFTER the event applied: the event at the replay head is still
    // replay — only what comes later counts as live (scene.ended relies on
    // reading the pre-event value inside its own case).
    set((state) =>
      !state.replayCaughtUp && event.id >= state.replayTarget
        ? { replayCaughtUp: true }
        : {},
    );
  },

  applyStream(frame: StreamSentence): void {
    // GM frames (0.20.0) ride the GM thread's own buffer, never the scene
    // pacing one. Index 0 replaces: a correction-loop retry restarted the
    // stream and the earlier attempt's sentences are stale.
    if (frame.call === 'gm') {
      set((state) => ({
        gmLiveConversationId: frame.turn_id,
        gmLiveSentences:
          frame.index === 0 || state.gmLiveConversationId !== frame.turn_id
            ? [frame]
            : [...state.gmLiveSentences, frame],
      }));
      return;
    }
    const sceneFrame: SceneStreamSentence = { ...frame, call: frame.call };
    set((state) => {
      // Sentences for a stale turn (reconnect races) are dropped — the
      // committed event is the authoritative transcript anyway (B6).
      if (state.liveTurnId !== null && state.liveTurnId !== frame.turn_id) {
        return {};
      }
      return {
        liveTurnId: frame.turn_id,
        liveSentences: [...state.liveSentences, sceneFrame],
      };
    });
  },

  applyDev(frame: DevEvent): void {
    set((state) => ({
      devFrames: [...state.devFrames.slice(-(DEV_RING - 1)), frame],
    }));
  },
}));
