// Weltari Chat (UI Spec §2.4, M6 part 2): desktop list-left /
// conversation-right. The transcript is the store's chatThreads projection —
// written only by the SSE reducer, rebuilt exactly on replay (the durable
// transcript IS the restart-survival demo, criterion a). Presence: a
// character in the open scene's cast shows offline (in_scene) and the send
// row says so instead of pretending a reply is coming.
import { useEffect, useRef, useState } from 'react';
import {
  CHAT_CHARACTERS,
  postExitChat,
  postSendChatMessage,
  postStartSceneFromChat,
} from '../commands.js';
import { useSceneStore, type ChatThread } from '../store.js';

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
  const [selectedId, setSelectedId] = useState(
    CHAT_CHARACTERS[0]?.character_id ?? '',
  );
  const selected =
    CHAT_CHARACTERS.find((c) => c.character_id === selectedId) ??
    CHAT_CHARACTERS[0];
  const thread =
    selected === undefined ? undefined : threads[selected.character_id];
  const inScene = useIsInScene(selected?.character_id ?? '');

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
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messageCount, typing]);

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
            selected={character.character_id === selected.character_id}
            thread={threads[character.character_id]}
            onSelect={() => {
              setSelectedId(character.character_id);
              setTyping(false);
            }}
          />
        ))}
      </aside>

      <section className="wl-chat-conversation">
        <header className="wl-chat-head">
          <div>
            <strong>{selected.name}</strong>
            <span
              className="wl-chat-presence"
              data-state={inScene ? 'in_scene' : 'available'}
            >
              {inScene ? 'offline — in a scene' : 'online'}
            </span>
          </div>
          <div className="wl-chat-head-actions">
            {devMode ? (
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
          {thread !== undefined && thread.lastEnded !== null ? (
            <div className="wl-chat-divider">
              — chat ended ({thread.lastEnded.reason}) —
            </div>
          ) : null}
          {typing ? (
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
    </div>
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
