// The Feed page (UI Spec §2.5, M6 part 5, Rev 4 §12): a viewer-only feed of
// character posts with like/comment reactions, rendered newest-first from
// the store's feed projection. The ONE user interaction (owner ruling
// 2026-07-11): clicking a character COMMENT opens a reply box — the reply
// lands in a feed-local thread and the comment's author answers over the
// stream. The bell (top right) collects everything directed at the user
// (V1: answers to their replies); the popup lists them. Visiting the page
// marks feed activity seen (the NavRail red dot clears).
import { useEffect, useRef, useState } from 'react';
import { CHAT_CHARACTERS, postFeedReply } from '../commands.js';
import { t } from '../i18n.js';
import { markSeen, useSeen } from '../seen.js';
import { useSceneStore, type FeedReaction } from '../store.js';

function nameOf(characterId: string): string {
  return (
    CHAT_CHARACTERS.find((c) => c.character_id === characterId)?.name ??
    characterId.replace('char:', '')
  );
}

/** "2000-01-02 · 08:00" from the engine-owned fictional stamp. */
function gameStamp(gameTime: string): string {
  return `${gameTime.slice(0, 10)} · ${gameTime.slice(11, 16)}`;
}

function IconBell(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" className="wl-feed-bell-icon" aria-hidden="true">
      <path
        d="M10 3a4.4 4.4 0 0 0-4.4 4.4c0 3.2-1.1 4.6-2 5.4h12.8c-.9-.8-2-2.2-2-5.4A4.4 4.4 0 0 0 10 3z"
        fill="none"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path d="M8.4 15.3a1.7 1.7 0 0 0 3.2 0" fill="none" strokeWidth="1.4" />
    </svg>
  );
}

function CommentThread(props: {
  postId: string;
  reaction: FeedReaction;
}): React.JSX.Element {
  const { postId, reaction } = props;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);

  const send = (): void => {
    const text = draft.trim();
    if (text === '' || sending) return;
    setSending(true);
    postFeedReply(postId, reaction.reaction_id, text)
      .then(() => {
        // The truth arrives on the stream (render-only, structure.md §4);
        // the box just resets.
        setDraft('');
        setOpen(false);
      })
      .catch(() => undefined) // CATCH-OK: a failed reply leaves the draft
      .finally(() => {
        setSending(false);
      });
  };

  return (
    <div className="wl-feed-comment-block">
      <button
        type="button"
        className="wl-feed-comment"
        data-open={open}
        onClick={() => {
          setOpen((was) => !was);
        }}
      >
        <span className="wl-feed-comment-author">
          {nameOf(reaction.character_id)}
        </span>
        <span className="wl-feed-comment-body">{reaction.body}</span>
      </button>
      {reaction.replies.length === 0 ? null : (
        <div className="wl-feed-replies">
          {reaction.replies.map((reply) => (
            <div
              key={reply.reply_id}
              className="wl-feed-reply"
              data-author={reply.author}
            >
              <span className="wl-feed-reply-author">
                {reply.author === 'user'
                  ? 'You'
                  : nameOf(reaction.character_id)}
              </span>
              <span className="wl-feed-reply-body">{reply.body}</span>
            </div>
          ))}
        </div>
      )}
      {open ? (
        <div className="wl-feed-replybox">
          <input
            className="wl-feed-replybox-input"
            value={draft}
            placeholder={t('feed.replyPlaceholder')}
            maxLength={2000}
            onChange={(e) => {
              setDraft(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') send();
            }}
          />
          <button
            type="button"
            className="wl-feed-replybox-send"
            disabled={sending || draft.trim() === ''}
            onClick={send}
          >
            {sending ? t('feed.replying') : t('feed.replySend')}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** How long the "catching up" chip stays after a live skip — feed posts are
 * LLM-class background work and land over the following seconds (§16). */
const CATCHUP_CHIP_MS = 8000;

export function FeedPage(): React.JSX.Element {
  const feedPosts = useSceneStore((s) => s.feedPosts);
  const feedNotifications = useSceneStore((s) => s.feedNotifications);
  const feedLastEventId = useSceneStore((s) => s.feedLastEventId);
  const timeAdvance = useSceneStore((s) => s.timeAdvance);
  const replayCaughtUp = useSceneStore((s) => s.replayCaughtUp);
  const bellSeen = useSeen('feed-bell');
  const [bellOpen, setBellOpen] = useState(false);
  const [catchingUp, setCatchingUp] = useState(false);
  const seenAdvanceRef = useRef(timeAdvance);

  // Being on the page IS seeing the activity — the rail dot clears live.
  useEffect(() => {
    markSeen('feed', feedLastEventId);
  }, [feedLastEventId]);

  // A LIVE skip populates the feed over the next seconds ("catching up",
  // UI Spec §2.5) — a replayed one is history, not pending work.
  useEffect(() => {
    if (!replayCaughtUp || timeAdvance === seenAdvanceRef.current) return;
    seenAdvanceRef.current = timeAdvance;
    setCatchingUp(true);
    const timer = window.setTimeout(() => {
      setCatchingUp(false);
    }, CATCHUP_CHIP_MS);
    return (): void => {
      window.clearTimeout(timer);
    };
  }, [timeAdvance, replayCaughtUp]);

  const unreadBell = feedNotifications.some((n) => n.event_id > bellSeen);
  const posts = [...feedPosts].reverse();

  return (
    <div className="wl-feed-page">
      <header className="wl-feed-head">
        <h2 className="wl-feed-title">{t('feed.title')}</h2>
        {catchingUp ? (
          <span className="wl-feed-catchup">{t('feed.catchingUp')}</span>
        ) : null}
        <div className="wl-feed-bell-wrap">
          <button
            type="button"
            className="wl-feed-bell"
            aria-label={t('feed.notifications')}
            title={t('feed.notifications')}
            onClick={() => {
              setBellOpen((was) => {
                const open = !was;
                if (open) markSeen('feed-bell', feedLastEventId);
                return open;
              });
            }}
          >
            <IconBell />
            {unreadBell ? (
              <span className="wl-rail-dot" data-kind="feed" />
            ) : null}
          </button>
          {bellOpen ? (
            <div className="wl-feed-bell-popup">
              <h3 className="wl-feed-bell-title">{t('feed.notifications')}</h3>
              {feedNotifications.length === 0 ? (
                <p className="wl-feed-bell-empty">
                  {t('feed.notifications.empty')}
                </p>
              ) : (
                [...feedNotifications].reverse().map((notification) => (
                  <div
                    key={notification.reply_id}
                    className="wl-feed-bell-item"
                  >
                    <span className="wl-feed-bell-item-head">
                      {nameOf(notification.character_id)}{' '}
                      {t('feed.notification.answered')}
                    </span>
                    <span className="wl-feed-bell-item-body">
                      {notification.body}
                    </span>
                  </div>
                ))
              )}
            </div>
          ) : null}
        </div>
      </header>

      {posts.length === 0 ? (
        <div className="wl-feed-empty">
          <p>{t('feed.empty')}</p>
        </div>
      ) : (
        <div className="wl-feed-scroll">
          {posts.map((post) => {
            const likes = post.reactions.filter((r) => r.kind === 'like');
            const comments = post.reactions.filter((r) => r.kind === 'comment');
            return (
              <article key={post.post_id} className="wl-feed-post">
                <header className="wl-feed-post-head">
                  <span className="wl-feed-post-author">
                    {nameOf(post.character_id)}
                  </span>
                  <span className="wl-feed-post-stamp">
                    {gameStamp(post.game_time)}
                  </span>
                </header>
                <p className="wl-feed-post-body">{post.body}</p>
                {likes.length > 0 ? (
                  <div className="wl-feed-likes">
                    ♥ {likes.map((r) => nameOf(r.character_id)).join(', ')}{' '}
                    {t('feed.likes')}
                  </div>
                ) : null}
                {comments.map((reaction) => (
                  <CommentThread
                    key={reaction.reaction_id}
                    postId={post.post_id}
                    reaction={reaction}
                  />
                ))}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
