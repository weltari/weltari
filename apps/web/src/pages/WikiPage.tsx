// The Wiki page (UI Spec §2.6, M6 parts 3+5): browse sublocation wikis from
// the store's subwikiBySublocation projection (subwiki.updated AND
// subwiki.edited; latest per sublocation wins), provenance shown — "written
// after <scene>" or "edited by you". M6 part 5 (owner ruling 2026-07-11):
// the pencil (top right) toggles edit-in-place — everything typed applies
// immediately (debounced flush to the subwiki-edit command; the durable
// subwiki.edited echoes back over the stream); the pencil becomes a book,
// which toggles back to read-only. No Proposal round-trip in V1. Visiting
// the page marks wiki activity seen (the NavRail blue dot clears).
import { useCallback, useEffect, useRef, useState } from 'react';
import { postSubwikiEdit } from '../commands.js';
import { t } from '../i18n.js';
import { markSeen } from '../seen.js';
import { useSceneStore } from '../store.js';

function IconPencil(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" className="wl-wiki-tool-icon" aria-hidden="true">
      <path
        d="M4 13.5 12.8 4.7a1.6 1.6 0 0 1 2.3 0l.2.2a1.6 1.6 0 0 1 0 2.3L6.5 16 3.5 16.5z"
        fill="none"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconBookOpen(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" className="wl-wiki-tool-icon" aria-hidden="true">
      <path
        d="M10 4.5c-1.5-1-4-1.2-6-.6v11.4c2-.6 4.5-.4 6 .6 1.5-1 4-1.2 6-.6V3.9c-2-.6-4.5-.4-6 .6z"
        fill="none"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path d="M10 4.5v11.4" fill="none" strokeWidth="1.2" />
    </svg>
  );
}

/** Typing pause before an edit flushes to the server ("applies immediately"
 * without one event per keystroke — the log is append-only). */
const EDIT_FLUSH_MS = 800;

export function WikiPage(): React.JSX.Element {
  const subwiki = useSceneStore((s) => s.subwikiBySublocation);
  const knownSublocations = useSceneStore((s) => s.knownSublocations);
  const stubNames = useSceneStore((s) => s.stubNames);
  const history = useSceneStore((s) => s.history);
  const wikiLastEventId = useSceneStore((s) => s.wikiLastEventId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const flushTimerRef = useRef<number | null>(null);
  const pendingRef = useRef<{ sublocationId: string; entry: string } | null>(
    null,
  );

  // Being on the page IS seeing the wiki activity — the blue dot clears.
  useEffect(() => {
    markSeen('wiki', wikiLastEventId);
  }, [wikiLastEventId]);

  const nameOf = (sublocationId: string): string =>
    knownSublocations.find((s) => s.sublocation_id === sublocationId)?.name ??
    stubNames[sublocationId] ??
    sublocationId;
  const sceneTitleOf = (sceneId: string): string =>
    history.find((h) => h.scene_id === sceneId)?.title ?? sceneId;

  const entries = Object.entries(subwiki)
    .map(([sublocationId, record]) => ({
      sublocationId,
      name: nameOf(sublocationId),
      ...record,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const selected =
    entries.find((e) => e.sublocationId === selectedId) ?? entries[0];

  // Flush whatever is pending NOW (toggle-off, selection change, unmount).
  const flush = useCallback((): void => {
    if (flushTimerRef.current !== null) {
      window.clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (pending !== null && pending.entry.trim() !== '') {
      postSubwikiEdit(pending.sublocationId, pending.entry.trim()).catch(
        () => undefined, // CATCH-OK: the durable echo is the truth anyway
      );
    }
  }, []);
  useEffect(() => flush, [flush]); // unmount flush

  const scheduleFlush = (sublocationId: string, entry: string): void => {
    pendingRef.current = { sublocationId, entry };
    if (flushTimerRef.current !== null) {
      window.clearTimeout(flushTimerRef.current);
    }
    flushTimerRef.current = window.setTimeout(() => {
      flushTimerRef.current = null;
      flush();
    }, EDIT_FLUSH_MS);
  };

  const selectEntry = (sublocationId: string): void => {
    if (sublocationId === selected?.sublocationId) return;
    flush();
    setEditing(false);
    setSelectedId(sublocationId);
  };

  const toggleEditing = (): void => {
    if (selected === undefined) return;
    if (editing) {
      flush();
      setEditing(false);
      return;
    }
    setDraft(selected.entry);
    setEditing(true);
  };

  if (entries.length === 0) {
    return (
      <div className="wl-wiki-page">
        <div className="wl-wiki-empty">
          <h2>{t('wiki.title')}</h2>
          <p>{t('wiki.empty')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="wl-wiki-page">
      <aside className="wl-wiki-list">
        <h2 className="wl-wiki-list-title">{t('wiki.title')}</h2>
        {entries.map((entry) => (
          <button
            key={entry.sublocationId}
            type="button"
            className="wl-wiki-row"
            data-selected={entry.sublocationId === selected?.sublocationId}
            onClick={() => {
              selectEntry(entry.sublocationId);
            }}
          >
            <span className="wl-wiki-row-name">{entry.name}</span>
            <span className="wl-wiki-row-preview">{entry.entry}</span>
          </button>
        ))}
      </aside>
      <section className="wl-wiki-entry">
        {selected === undefined ? null : (
          <>
            <header className="wl-wiki-entry-head">
              <h3>{selected.name}</h3>
              <span className="wl-wiki-provenance">
                {selected.editedByUser || selected.sceneId === null
                  ? t('wiki.editedByYou')
                  : `${t('wiki.writtenAfter')} “${sceneTitleOf(selected.sceneId)}”`}
              </span>
              <button
                type="button"
                className="wl-wiki-tool"
                aria-label={editing ? t('wiki.read') : t('wiki.edit')}
                title={editing ? t('wiki.read') : t('wiki.edit')}
                onClick={toggleEditing}
              >
                {editing ? <IconBookOpen /> : <IconPencil />}
              </button>
            </header>
            {editing ? (
              <textarea
                className="wl-wiki-editor"
                value={draft}
                maxLength={4000}
                onChange={(e) => {
                  setDraft(e.target.value);
                  scheduleFlush(selected.sublocationId, e.target.value);
                }}
              />
            ) : (
              <p className="wl-wiki-entry-text">{selected.entry}</p>
            )}
          </>
        )}
      </section>
    </div>
  );
}
