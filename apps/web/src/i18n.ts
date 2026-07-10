// The UI message catalog (M6 part 4, owner ruling 2026-07-11): the frontend
// must be multilingual-READY — every new user-facing string lives here under
// a typed key, existing strings migrate opportunistically. No language packs
// ship yet: `en` is the single complete catalog and the fallback; a future
// pack is another Partial<typeof EN> keyed by locale, merged in `t` — no
// dependency, no build step, no component changes.
const EN = {
  'nav.play': 'Play',
  'nav.map': 'Map',
  'nav.feed': 'Feed',
  'nav.chats': 'Chats',
  'nav.wiki': 'Wiki',
  'nav.config': 'Config',
  'nav.feed.later': 'Feed arrives with the social systems milestone.',
  'splash.title': 'Adventure Awaits',
  'splash.history': 'History scene',
  'splash.goSomewhere': 'Go Somewhere…',
  'splash.hangAround': 'Hang around',
  'splash.hangAround.empty':
    'No known sublocations yet — explore the map first.',
  'splash.hangAround.hint': 'Open a scene at a random known place',
  'chat.notice.meetingExpired': 'the meeting expired',
} as const;

export type MessageKey = keyof typeof EN;

/** Future language packs override per key; `en` stays the fallback. The
 * locale setter arrives WITH the first pack (knip keeps us honest — no
 * speculative exports). */
const PACKS: Record<string, Partial<Record<MessageKey, string>>> = {};

const activeLocale = 'en';

export function t(key: MessageKey): string {
  return PACKS[activeLocale]?.[key] ?? EN[key];
}
