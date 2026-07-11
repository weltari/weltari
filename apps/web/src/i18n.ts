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
  'chat.groups': 'Groups',
  'chat.newGroup': '+ New group',
  'chat.endGroup': 'End group chat',
  'chat.groupPlaceholder': 'Message the group…',
  'feed.title': 'The Feed',
  'feed.empty':
    'No posts yet — characters post as world time passes. Skip time on the Gameday clock and check back.',
  'feed.catchingUp': 'Catching up after the skip…',
  'feed.likes': 'likes this',
  'feed.replyPlaceholder': 'Reply to this comment…',
  'feed.replySend': 'Send',
  'feed.replying': 'Sending…',
  'feed.notifications': 'Notifications',
  'feed.notifications.empty':
    'Nothing yet — answers to your replies land here.',
  'feed.notification.answered': 'answered your reply:',
  'nav.feed.activity': 'new feed activity',
  'nav.wiki.activity': 'new wiki entry',
  'onboarding.greeting':
    'This world is a blank page. The GM is waiting to dream it up with you.',
  'onboarding.begin': 'Begin with the GM',
  'proposal.title': 'The GM proposes',
  'proposal.action.create_place': 'a new place',
  'proposal.action.create_character': 'a new character',
  'proposal.action.edit_wiki': 'a wiki change',
  'proposal.action.seed_world': 'your starting world',
  'proposal.approve': 'Consent',
  'proposal.reject': 'Reject',
  'proposal.discuss': 'Chat about this',
  'proposal.discussDraft': 'About your proposal — ',
  'proposal.space.public': 'public space',
  'proposal.space.private': 'private space',
  'proposal.wiki.was': 'Currently',
  'proposal.wiki.becomes': 'Becomes',
  'proposal.seed.places': 'Places',
  'proposal.seed.characters': 'Characters',
  'chat.gmAlways': 'always here',
  'chat.lock': 'Lock evolution',
  'chat.unlock': 'Unlock evolution',
  'chat.locked.hint':
    'Locked: reflections keep memories but never rewrite personality or goals.',
  'config.engine.title': 'Engine & System',
  'config.profiling.title': 'User profiling',
  'config.profiling.hint':
    'When on, the GM studies ended scenes and chats for story-quality signals and tailors what the Narrator tries next. Everything it writes about you is viewable, exportable and deletable here.',
  'config.profiling.on': 'Profiling is ON',
  'config.profiling.off': 'Profiling is OFF',
  'config.profiling.enable': 'Turn on',
  'config.profiling.disable': 'Turn off',
  'config.profile.view': 'View my profile',
  'config.profile.hide': 'Hide',
  'config.profile.export': 'Export (JSON)',
  'config.profile.delete': 'Delete my profile',
  'config.profile.deleteConfirm': 'Really delete? This cannot be undone.',
  'config.profile.deleteYes': 'Delete forever',
  'config.profile.deleteNo': 'Keep it',
  'config.profile.empty': 'Nothing recorded about you yet.',
  'wiki.title': 'World Wiki',
  'wiki.empty':
    'No entries yet. The World Agent writes a place’s wiki when a scene ends there — play a scene at a newly created place and come back.',
  'wiki.edit': 'Edit this entry (changes apply immediately)',
  'wiki.read': 'Back to reading',
  'wiki.editedByYou': 'edited by you',
  'wiki.writtenAfter': 'written after',
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
