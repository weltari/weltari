// Locally persisted "seen up to event id" marks (0.15.0) — a VIEW concern
// (structure.md rule 1: read cursors never live in the store). localStorage
// keeps the NavRail dots honest across reloads: an already-acknowledged post
// must not re-dot after a refresh, even though the whole log replays.
import { useSyncExternalStore } from 'react';

export type SeenKey = 'feed' | 'wiki' | 'feed-bell';

const listeners = new Set<() => void>();

function storageKey(key: SeenKey): string {
  return `wl-seen-${key}`;
}

export function seenUpTo(key: SeenKey): number {
  const raw = window.localStorage.getItem(storageKey(key));
  const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** Monotonic: marking backwards is a no-op (event ids only grow). */
export function markSeen(key: SeenKey, eventId: number): void {
  if (eventId <= seenUpTo(key)) return;
  window.localStorage.setItem(storageKey(key), String(eventId));
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener('storage', listener);
  return (): void => {
    listeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
}

export function useSeen(key: SeenKey): number {
  return useSyncExternalStore(subscribe, () => seenUpTo(key));
}
