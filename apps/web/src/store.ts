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
  end_type: 'rest' | 'continuation' | 'travel';
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
  end_type: 'rest' | 'continuation' | 'travel' | null;
  divider_text: string | null;
}

export interface ChatMessage {
  message_id: string;
  sender: 'user' | 'character';
  text: string;
  /** Wall-clock append time from the event envelope (ISO). */
  ts: string;
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
  liveSentences: StreamSentence[];
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
      set((state) => ({
        artByCharacter: {
          ...state.artByCharacter,
          [event.payload.character_id]: event.payload.art_id,
        },
      }));
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
      // Stubs are enterable through scenes only (Rev 4 §14) — no client
      // projection: the map ignores them and Hang around never lands on one.
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
    // No projection (yet): these surfaces arrive in later milestones
    // (map refresh, feed, job status UI). map_edit.requested is the map
    // plugin's lock overlay — it reads the stream directly. reflect_chat
    // and CACHE entries are log-only trail surfaces (dev mode, §2.8).
    case 'reflection.committed':
    case 'world_agent.committed':
    case 'map_edit.requested':
    case 'reflect_chat.committed':
    case 'cache.appended':
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
  devFrames: [],
  updateAvailable: null,
  updateStaged: null,
  updateJobError: null,
  pluginRejections: [],
  chatThreads: {},

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
    set((state) => {
      // Sentences for a stale turn (reconnect races) are dropped — the
      // committed event is the authoritative transcript anyway (B6).
      if (state.liveTurnId !== null && state.liveTurnId !== frame.turn_id) {
        return {};
      }
      return {
        liveTurnId: frame.turn_id,
        liveSentences: [...state.liveSentences, frame],
      };
    });
  },

  applyDev(frame: DevEvent): void {
    set((state) => ({
      devFrames: [...state.devFrames.slice(-(DEV_RING - 1)), frame],
    }));
  },
}));
