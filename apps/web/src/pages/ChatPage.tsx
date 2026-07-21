// Weltari Chat (UI Spec §2.4, M6 part 2): desktop list-left /
// conversation-right. The transcript is the store's chatThreads projection —
// written only by the SSE reducer, rebuilt exactly on replay (the durable
// transcript IS the restart-survival demo, criterion a). Presence: a
// character in the open scene's cast shows offline (in_scene) and the send
// row says so instead of pretending a reply is coming.
import { useEffect, useRef, useState } from 'react';
import {
  CHAT_CHARACTERS,
  GM_CHARACTER_ID,
  postExitChat,
  postExitGroupChat,
  postSendChatMessage,
  postSendGroupMessage,
  postSetCharacterLock,
  postStartGroupChat,
  postStartSceneFromChat,
} from '../commands.js';
import { ProposalCard } from '../components/ProposalCard.js';
import { t } from '../i18n.js';
import { useSceneStore, type ChatThread, type GroupThread } from '../store.js';

/** V1 groups everyone DM-able EXCEPT the GM — it is the meta-guide, not a
 * group member (Rev 4 §9). */
const GROUPABLE = CHAT_CHARACTERS.filter(
  (c) => c.character_id !== GM_CHARACTER_ID,
);

interface ChatPageProps {
  /** Hand a startscene() 202 to the shell: navigate to the Scene route (the
   * scene.started + first turn arrive over the stream like any open). */
  onSceneOpened: () => void;
  /** Meeting is character-led since M6 part 3 (owner ruling 2026-07-09): the
   * character negotiates in chat and fires startscene itself. The button
   * survives only as a dev-mode testing shortcut (?dev=1). */
  devMode: boolean;
}

/** in_scene = the character sits in the currently open scene's cast
 * (projection of character.joined/scene.ended — same events the server's
 * presence gate reads). */
function useIsInScene(characterId: string): boolean {
  const cast = useSceneStore((s) => s.cast);
  const sceneId = useSceneStore((s) => s.sceneId);
  const sceneEnd = useSceneStore((s) => s.sceneEnd);
  return (
    sceneId !== null &&
    sceneEnd === null &&
    cast.some((m) => m.character_id === characterId)
  );
}

function ThreadPreview({
  thread,
}: {
  thread: ChatThread | undefined;
}): React.JSX.Element | null {
  const last = thread?.messages.at(-1);
  if (last === undefined) {
    return <span className="wl-chat-preview">No messages yet</span>;
  }
  return (
    <span className="wl-chat-preview">
      {last.sender === 'user' ? 'You: ' : ''}
      {last.text}
    </span>
  );
}

export function ChatPage({
  onSceneOpened,
  devMode,
}: ChatPageProps): React.JSX.Element {
  const threads = useSceneStore((s) => s.chatThreads);
  const groups = useSceneStore((s) => s.groupThreads);
  const [selectedId, setSelectedId] = useState(
    CHAT_CHARACTERS[0]?.character_id ?? '',
  );
  // A selected group swaps the right pane (UI Spec §2.4 group view, 0.14.0).
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const selectedGroup =
    selectedGroupId === null ? undefined : groups[selectedGroupId];
  const selected =
    CHAT_CHARACTERS.find((c) => c.character_id === selectedId) ??
    CHAT_CHARACTERS[0];
  const thread =
    selected === undefined ? undefined : threads[selected.character_id];
  const isGm = selected?.character_id === GM_CHARACTER_ID;
  const inScene = useIsInScene(selected?.character_id ?? '') && !isGm;
  // The consent cards (0.17.0, Rev 4 §16) live in the GM conversation.
  const pendingProposals = useSceneStore((s) => s.pendingProposals);
  // The GM reply streaming right now (0.20.0): display-only sentences; the
  // committed message replaces them the moment it lands (B6).
  const gmLiveSentences = useSceneStore((s) => s.gmLiveSentences);
  const gmLiveText = isGm
    ? gmLiveSentences.map((frame) => frame.text).join(' ')
    : '';
  const characterLocks = useSceneStore((s) => s.characterLocks);
  const locked =
    selected === undefined
      ? false
      : (characterLocks[selected.character_id] ?? false);

  const [draft, setDraft] = useState('');
  const [typing, setTyping] = useState(false);
  const [meetOpen, setMeetOpen] = useState(false);
  const [meetPlace, setMeetPlace] = useState('');
  const [busy, setBusy] = useState(false);

  // The typing indicator is view state: set by our own 202 (replying: true),
  // cleared when the character's committed reply lands in the projection —
  // adjust-during-render (the ScenePage endedLive pattern), no effect needed.
  const messageCount = thread?.messages.length ?? 0;
  const characterCount =
    thread?.messages.filter((m) => m.sender === 'character').length ?? 0;
  const [seenCharacterCount, setSeenCharacterCount] = useState(characterCount);
  if (characterCount > seenCharacterCount) {
    setSeenCharacterCount(characterCount);
    if (typing) setTyping(false);
  }

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const typingTimerRef = useRef<number | null>(null);
  const proposalCount = isGm ? pendingProposals.length : 0;
  const gmLiveCount = gmLiveSentences.length;
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messageCount, typing, proposalCount, gmLiveCount]);

  if (selected === undefined) {
    return <div className="wl-chat-page">No characters to chat with yet.</div>;
  }

  async function send(): Promise<void> {
    const text = draft.trim();
    if (text === '' || busy || selected === undefined) return;
    const characterId = selected.character_id;
    const before = characterCount;
    setBusy(true);
    setDraft('');
    const accepted = await postSendChatMessage(characterId, text);
    setBusy(false);
    // A fast reply can land on the stream BEFORE this 202 resolves — only
    // show "typing" while the reply is still genuinely outstanding, and
    // never let it stick if the reply is lost (crash-only: resend heals).
    const after = (
      useSceneStore.getState().chatThreads[characterId]?.messages ?? []
    ).filter((m) => m.sender === 'character').length;
    if (accepted?.replying === true && after === before) {
      setTyping(true);
      if (typingTimerRef.current !== null) {
        window.clearTimeout(typingTimerRef.current);
      }
      typingTimerRef.current = window.setTimeout(() => {
        setTyping(false);
      }, 60000);
    }
  }

  async function meet(): Promise<void> {
    const place = meetPlace.trim();
    if (place === '' || busy || selected === undefined) return;
    setBusy(true);
    const opened = await postStartSceneFromChat(
      selected.character_id,
      selected.name,
      place,
    );
    setBusy(false);
    if (opened !== null) {
      setMeetOpen(false);
      setMeetPlace('');
      onSceneOpened();
    }
  }

  function fireSend(): void {
    send().catch(() => {
      // CATCH-OK: a failed send leaves the row usable; truth is the stream.
      setBusy(false);
    });
  }

  function fireMeet(): void {
    meet().catch(() => {
      // CATCH-OK: a failed handoff leaves the chat as it was.
      setBusy(false);
    });
  }

  return (
    <div className="wl-chat-page">
      <aside className="wl-chat-list">
        <h2 className="wl-chat-list-title">Chats</h2>
        {CHAT_CHARACTERS.map((character) => (
          <CharacterRow
            key={character.character_id}
            characterId={character.character_id}
            name={character.name}
            selected={
              selectedGroup === undefined &&
              character.character_id === selected.character_id
            }
            thread={threads[character.character_id]}
            onSelect={() => {
              setSelectedId(character.character_id);
              setSelectedGroupId(null);
              setTyping(false);
            }}
          />
        ))}
        <h2 className="wl-chat-list-title">{t('chat.groups')}</h2>
        {Object.values(groups).map((group) => (
          <button
            key={group.conversation_id}
            type="button"
            className="wl-chat-row"
            data-selected={group.conversation_id === selectedGroupId}
            onClick={() => {
              setSelectedGroupId(group.conversation_id);
            }}
          >
            <span className="wl-chat-avatar" data-state="available">
              #
            </span>
            <span className="wl-chat-row-main">
              <span className="wl-chat-row-name">{group.title}</span>
              <span className="wl-chat-preview">
                {group.messages.at(-1)?.text ?? 'No messages yet'}
              </span>
            </span>
          </button>
        ))}
        <button
          type="button"
          className="wl-chat-action"
          disabled={busy || GROUPABLE.length < 2}
          onClick={() => {
            // User-started only (Rev 4 §8) — V1 groups everyone DM-able
            // except the GM.
            postStartGroupChat(
              GROUPABLE.map((c) => c.character_id),
              GROUPABLE.map((c) => c.name).join(' & '),
            )
              .then((started) => {
                if (started !== null)
                  setSelectedGroupId(started.conversationId);
              })
              .catch(() => {
                // CATCH-OK: a failed start changes nothing; truth is the stream.
              });
          }}
        >
          {t('chat.newGroup')}
        </button>
      </aside>

      {selectedGroup !== undefined ? (
        <GroupConversation group={selectedGroup} />
      ) : (
        <section className="wl-chat-conversation">
          <header className="wl-chat-head">
            <div>
              <strong>{selected.name}</strong>
              <span
                className="wl-chat-presence"
                data-state={inScene ? 'in_scene' : 'available'}
              >
                {isGm
                  ? t('chat.gmAlways')
                  : inScene
                    ? 'offline — in a scene'
                    : 'online'}
              </span>
            </div>
            <div className="wl-chat-head-actions">
              {devMode && !isGm ? (
                <button
                  type="button"
                  className="wl-chat-action"
                  disabled={busy}
                  onClick={() => {
                    setMeetOpen((open) => !open);
                  }}
                >
                  Meet in a scene (dev)
                </button>
              ) : null}
              {isGm ? null : (
                <button
                  type="button"
                  className="wl-chat-action"
                  disabled={busy}
                  title={locked ? t('chat.locked.hint') : undefined}
                  data-locked={locked}
                  onClick={() => {
                    // The evolution lock (0.17.0, Rev 4 §7): the truth is
                    // the stream — character.lock_set flips the fold.
                    postSetCharacterLock(selected.character_id, !locked).catch(
                      () => {
                        // CATCH-OK: a failed toggle changes nothing.
                      },
                    );
                  }}
                >
                  {locked ? t('chat.unlock') : t('chat.lock')}
                </button>
              )}
              {isGm ? null : (
                <button
                  type="button"
                  className="wl-chat-action"
                  disabled={busy}
                  onClick={() => {
                    postExitChat(selected.character_id).catch(() => {
                      // CATCH-OK: a failed exit changes nothing; truth is the stream.
                    });
                  }}
                >
                  End chat
                </button>
              )}
            </div>
          </header>

          {meetOpen ? (
            <div className="wl-chat-meet">
              <input
                value={meetPlace}
                placeholder='Where? A known place or e.g. "the park"'
                onChange={(e) => {
                  setMeetPlace(e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') fireMeet();
                }}
              />
              <button type="button" disabled={busy} onClick={fireMeet}>
                Start the scene
              </button>
            </div>
          ) : null}

          <div className="wl-chat-messages" ref={scrollRef}>
            {(thread?.messages ?? []).map((message) => (
              <div
                key={message.message_id}
                className="wl-chat-bubble"
                data-sender={message.sender}
              >
                {message.text}
              </div>
            ))}
            {isGm
              ? pendingProposals.map((proposal) => (
                  <ProposalCard
                    key={proposal.payload.proposal_id}
                    proposal={proposal}
                    onDiscuss={(discussDraft) => {
                      // The card stays PENDING while you talk it over —
                      // only Consent/Reject settle it (owner UX ruling).
                      setDraft(discussDraft);
                    }}
                  />
                ))
              : null}
            {thread !== undefined && thread.lastEnded !== null ? (
              <div className="wl-chat-divider">
                — chat ended ({thread.lastEnded.reason}) —
              </div>
            ) : null}
            {gmLiveText !== '' ? (
              <div
                className="wl-chat-bubble wl-chat-streaming"
                data-sender="character"
              >
                {gmLiveText}
              </div>
            ) : null}
            {typing && gmLiveText === '' ? (
              <div
                className="wl-chat-bubble wl-chat-typing"
                data-sender="character"
              >
                <span />
                <span />
                <span />
              </div>
            ) : null}
          </div>

          <div className="wl-chat-inputrow">
            <input
              value={draft}
              placeholder={
                inScene
                  ? `${selected.name} is in a scene — messages wait until it ends`
                  : `Message ${selected.name}…`
              }
              onChange={(e) => {
                setDraft(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') fireSend();
              }}
            />
            <button
              type="button"
              disabled={busy || draft.trim() === ''}
              onClick={fireSend}
            >
              Send
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

/** The group pane (0.14.0): member replies arrive routed by the Group-chat
 * Narrator — up to the engine's turn budget per user line; speaker names
 * label every character bubble. */
function GroupConversation(props: { group: GroupThread }): React.JSX.Element {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const count = props.group.messages.length;
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [count]);

  function nameOf(id: string | undefined): string {
    return (
      CHAT_CHARACTERS.find((c) => c.character_id === id)?.name ?? 'Someone'
    );
  }
  function fireSend(): void {
    const text = draft.trim();
    if (text === '' || busy) return;
    setBusy(true);
    setDraft('');
    postSendGroupMessage(props.group.conversation_id, text)
      .catch(() => null)
      .finally(() => {
        setBusy(false);
      });
  }

  return (
    <section className="wl-chat-conversation">
      <header className="wl-chat-head">
        <div>
          <strong>{props.group.title}</strong>
          <span className="wl-chat-presence" data-state="available">
            {props.group.member_ids.map((id) => nameOf(id)).join(', ')}
          </span>
        </div>
        <div className="wl-chat-head-actions">
          <button
            type="button"
            className="wl-chat-action"
            disabled={busy}
            onClick={() => {
              postExitGroupChat(props.group.conversation_id).catch(() => {
                // CATCH-OK: a failed exit changes nothing; truth is the stream.
              });
            }}
          >
            {t('chat.endGroup')}
          </button>
        </div>
      </header>
      <div className="wl-chat-messages" ref={scrollRef}>
        {props.group.messages.map((message) => (
          <div
            key={message.message_id}
            className="wl-chat-bubble"
            data-sender={message.sender}
          >
            {message.sender === 'character' ? (
              <span className="wl-chat-speaker">
                {nameOf(message.speaker_id)}: {''}
              </span>
            ) : null}
            {message.text}
          </div>
        ))}
        {props.group.lastEnded !== null ? (
          <div className="wl-chat-divider">
            — group chat ended ({props.group.lastEnded.reason}) —
          </div>
        ) : null}
      </div>
      <div className="wl-chat-inputrow">
        <input
          value={draft}
          placeholder={t('chat.groupPlaceholder')}
          onChange={(e) => {
            setDraft(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') fireSend();
          }}
        />
        <button
          type="button"
          disabled={busy || draft.trim() === ''}
          onClick={fireSend}
        >
          Send
        </button>
      </div>
    </section>
  );
}

function CharacterRow(props: {
  characterId: string;
  name: string;
  selected: boolean;
  thread: ChatThread | undefined;
  onSelect: () => void;
}): React.JSX.Element {
  const inScene = useIsInScene(props.characterId);
  return (
    <button
      type="button"
      className="wl-chat-row"
      data-selected={props.selected}
      onClick={props.onSelect}
    >
      <span
        className="wl-chat-avatar"
        data-state={inScene ? 'in_scene' : 'available'}
      >
        {props.name.slice(0, 1)}
      </span>
      <span className="wl-chat-row-main">
        <span className="wl-chat-row-name">{props.name}</span>
        <ThreadPreview thread={props.thread} />
      </span>
    </button>
  );
}
