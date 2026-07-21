// Sentence-by-sentence pacing (UI Spec §1.4): reading pace is decoupled from
// generation pace. The store buffers streamed sentences; this hook owns the
// read cursor — pure view state, so it lives in React, not in the store
// (the store stays writable only by the SSE reducer).
import { useCallback, useEffect, useState } from 'react';
import type { SeenCut } from './commands.js';
import { useSceneStore, type SceneStreamSentence } from './store.js';

const AUTO_KEY = 'weltari.autoAdvance';

/** Reading time scaled by sentence length, clamped to a comfortable band. */
function autoDelayMs(sentence: SceneStreamSentence | undefined): number {
  const length = sentence?.text.length ?? 60;
  return Math.min(4200, Math.max(1100, 650 + length * 32));
}

export interface Pacing {
  /** The live turn's sentences the reader has revealed so far. */
  displayed: SceneStreamSentence[];
  /** More sentences are buffered beyond the cursor. */
  hasMore: boolean;
  /** Reveal the next sentence (click / Auto-Advance). */
  advance: () => void;
  auto: boolean;
  setAuto: (value: boolean) => void;
  /** The interrupt cut point: the last sentence actually displayed. */
  seen: SeenCut | undefined;
  /** Everything buffered has been read (turn may still be generating). */
  caughtUp: boolean;
}

export function usePacing(): Pacing {
  const liveTurnId = useSceneStore((s) => s.liveTurnId);
  const liveSentences = useSceneStore((s) => s.liveSentences);
  const [cursor, setCursor] = useState(0);
  const [pacedTurnId, setPacedTurnId] = useState<string | null>(null);
  const [auto, setAutoState] = useState<boolean>(
    () => localStorage.getItem(AUTO_KEY) === '1',
  );

  // A new turn resets the reader to its first sentence.
  if (pacedTurnId !== liveTurnId) {
    setPacedTurnId(liveTurnId);
    setCursor(0);
  }

  // The first sentence of a turn reveals itself (no state write needed —
  // the effective cursor never sits below 1 while sentences exist).
  const effectiveCursor =
    liveSentences.length === 0
      ? 0
      : Math.min(Math.max(cursor, 1), liveSentences.length);

  const advance = useCallback((): void => {
    setCursor((current) => Math.max(current, 1) + 1);
  }, []);

  const setAuto = useCallback((value: boolean): void => {
    localStorage.setItem(AUTO_KEY, value ? '1' : '0');
    setAutoState(value);
  }, []);

  // Auto-Advance: a timer per revealed sentence, sized to its length.
  useEffect(() => {
    if (!auto || effectiveCursor === 0) return;
    if (effectiveCursor >= liveSentences.length) return;
    const timer = setTimeout(
      advance,
      autoDelayMs(liveSentences[effectiveCursor - 1]),
    );
    return (): void => {
      clearTimeout(timer);
    };
  }, [auto, effectiveCursor, liveSentences, advance]);

  const displayed = liveSentences.slice(0, effectiveCursor);
  const last = displayed[displayed.length - 1];
  return {
    displayed,
    hasMore: effectiveCursor < liveSentences.length,
    advance,
    auto,
    setAuto,
    seen:
      last === undefined
        ? undefined
        : { call: last.call, sentence_index: last.index },
    caughtUp: effectiveCursor >= liveSentences.length,
  };
}
