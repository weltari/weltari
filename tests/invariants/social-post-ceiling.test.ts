// The Feed's per-skip ceiling (M6 part 5, Rev 4 §12): a multi-day skip
// enqueues AT MOST 10 posts, the FRESHEST cadence boundaries surviving, in
// scheduled-game-timestamp order — the exact composition main.ts's
// advance-time wrapper uses (intervalOccurrencesBetween → newest-N slice).
// Older skipped posts are simply never generated: no player scrolls an
// endless backlog.
import { describe, expect, it } from 'vitest';
import { intervalOccurrencesBetween } from '../../apps/server/src/ledger/scheduler.js';
import { SOCIAL_POST_SKIP_CAP } from '../../apps/server/src/engine/social.js';

/** The default cadence: 2 posts per game day (owner ruling 2026-07-11). */
const CADENCE_MINUTES = 1440 / 2;

describe('invariant: the 10-post skip ceiling (Rev 4 §12)', () => {
  it('a 7-day skip crosses 14 boundaries but only the freshest 10 survive, ascending', () => {
    const from = '2000-01-01T06:00:00.000Z';
    const to = '2000-01-08T06:00:00.000Z';
    const all = intervalOccurrencesBetween(from, to, CADENCE_MINUTES);
    expect(all).toHaveLength(14);
    const window = all.slice(-SOCIAL_POST_SKIP_CAP);
    expect(window).toHaveLength(SOCIAL_POST_SKIP_CAP);
    // The freshest window: the LAST boundary is the skip's end-adjacent one,
    // the dropped ones are the OLDEST four.
    expect(window.at(-1)).toBe(all.at(-1));
    expect(window[0]).toBe(all[4]);
    // Scheduled-game-timestamp order (Zulu ISO sorts lexicographically).
    const sorted = [...window].sort();
    expect(window).toEqual(sorted);
  });

  it('a 12-hour skip crosses exactly one boundary; a paused world enqueues nothing', () => {
    const from = '2000-01-01T06:00:00.000Z';
    expect(
      intervalOccurrencesBetween(
        from,
        '2000-01-01T18:00:00.000Z',
        CADENCE_MINUTES,
      ),
    ).toHaveLength(1);
    expect(intervalOccurrencesBetween(from, from, CADENCE_MINUTES)).toEqual([]);
  });

  it('idempotency keys derive from the boundary alone — a replayed skip mints no twins', () => {
    const from = '2000-01-01T06:00:00.000Z';
    const to = '2000-01-03T06:00:00.000Z';
    const first = intervalOccurrencesBetween(from, to, CADENCE_MINUTES).map(
      (occurrence) => `social_post:w1:${occurrence}`,
    );
    const second = intervalOccurrencesBetween(from, to, CADENCE_MINUTES).map(
      (occurrence) => `social_post:w1:${occurrence}`,
    );
    expect(first).toEqual(second);
    expect(new Set(first).size).toBe(first.length);
  });
});
