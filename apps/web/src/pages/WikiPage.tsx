// The Wiki page (UI Spec §2.6, M6 part 3 — the read-only slice): browse
// sublocation wikis from the store's subwikiBySublocation projection
// (subwiki.updated events; latest per sublocation wins), provenance shown —
// "written after <scene>". Live by construction: a new scene-end entry
// arrives over the stream and re-renders. Manual edits and the
// review-writes queue stay M6 part 4 / config.
import { useState } from 'react';
import { useSceneStore } from '../store.js';

export function WikiPage(): React.JSX.Element {
  const subwiki = useSceneStore((s) => s.subwikiBySublocation);
  const knownSublocations = useSceneStore((s) => s.knownSublocations);
  const stubNames = useSceneStore((s) => s.stubNames);
  const history = useSceneStore((s) => s.history);
  const [selectedId, setSelectedId] = useState<string | null>(null);

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

  if (entries.length === 0) {
    return (
      <div className="wl-wiki-page">
        <div className="wl-wiki-empty">
          <h2>World Wiki</h2>
          <p>
            No entries yet. The World Agent writes a place&rsquo;s wiki when a
            scene ends there — play a scene at a newly created place and come
            back.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="wl-wiki-page">
      <aside className="wl-wiki-list">
        <h2 className="wl-wiki-list-title">World Wiki</h2>
        {entries.map((entry) => (
          <button
            key={entry.sublocationId}
            type="button"
            className="wl-wiki-row"
            data-selected={entry.sublocationId === selected?.sublocationId}
            onClick={() => {
              setSelectedId(entry.sublocationId);
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
                written after &ldquo;{sceneTitleOf(selected.sceneId)}&rdquo;
              </span>
            </header>
            <p className="wl-wiki-entry-text">{selected.entry}</p>
          </>
        )}
      </section>
    </div>
  );
}
