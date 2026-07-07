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

export interface CommittedTurn {
  turn_id: string;
  steps: TurnStep[];
  interrupted: boolean;
}

export interface SceneEnd {
  end_type: 'rest' | 'continuation' | 'travel';
  divider_text: string;
}

export interface SceneStore {
  connected: boolean;
  protocolVersion: string | null;
  sceneId: string | null;
  sceneTitle: string;
  /** Set on scene.ended — drives the soft-close button set (UI Spec §1.7). */
  sceneEnd: SceneEnd | null;
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

  // ---- reducer actions: called ONLY from stream.ts ----
  setConnected(connected: boolean): void;
  applyHello(protocolVersion: string): void;
  applyEvent(event: WeltariEvent): void;
  applyStream(frame: StreamSentence): void;
  applyDev(frame: DevEvent): void;
}

const DEV_RING = 100;

export const useSceneStore = create<SceneStore>((set) => ({
  connected: false,
  protocolVersion: null,
  sceneId: null,
  sceneTitle: 'Weltari',
  sceneEnd: null,
  worldTime: null,
  timeAdvance: null,
  cronCompleted: 0,
  worldEpoch: null,
  sublocationId: '',
  sublocationName: '',
  previousSublocationId: null,
  artByCharacter: {},
  turns: [],
  openTurnId: null,
  liveTurnId: null,
  liveSentences: [],
  devFrames: [],

  setConnected(connected: boolean): void {
    set({ connected });
  },

  applyHello(protocolVersion: string): void {
    set({ protocolVersion });
  },

  applyEvent(event: WeltariEvent): void {
    switch (event.type) {
      case 'scene.started':
        set({
          sceneId: event.payload.scene_id,
          sceneTitle: event.payload.title,
          sceneEnd: null,
        });
        return;
      case 'scene.ended':
        set({
          sceneEnd: {
            end_type: event.payload.end_type ?? 'rest',
            divider_text: event.payload.divider_text ?? '— the scene rests —',
          },
          openTurnId: null,
        });
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
          return {
            turns: [
              ...state.turns,
              {
                turn_id: event.payload.turn_id,
                steps: event.payload.steps,
                interrupted: event.payload.interrupted ?? false,
              },
            ],
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
      // No projection (yet): these surfaces arrive in later milestones
      // (map refresh, feed, job status UI).
      case 'reflection.committed':
      case 'world_agent.committed':
      case 'painter.completed':
      case 'plugin.rejected':
      case 'update.available':
      case 'update.staged':
      case 'job.failed':
      case 'job.parked':
        return;
    }
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
