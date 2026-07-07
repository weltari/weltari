// The VN stage: backdrop (slide transition on sublocation.changed), the
// character line-up with speaker rise + art switches, and the sublocation
// chip. Pure projection of store state — no game logic (Brief §2.5).
import { useSceneStore } from '../store.js';

/**
 * Placeholder cast until a character-roster projection event exists: the
 * fixture's one on-stage character. The Narrator never appears in the
 * line-up (UI Spec §1.5). Art switches arrive per character_id.
 */
const CAST = [{ character_id: 'char:elias', name: 'Elias' }] as const;

export function SceneStage(props: {
  /** The call kind of the sentence currently displayed (speaker rise). */
  speakingCall: 'narrator' | 'character' | 'narration' | null;
  children: React.ReactNode;
}): React.JSX.Element {
  const sublocationId = useSceneStore((s) => s.sublocationId);
  const previousSublocationId = useSceneStore((s) => s.previousSublocationId);
  const sublocationName = useSceneStore((s) => s.sublocationName);
  const artByCharacter = useSceneStore((s) => s.artByCharacter);

  return (
    <section className="wl-stage" aria-label="scene stage">
      {previousSublocationId !== null ? (
        <div className="wl-backdrop" data-sublocation={previousSublocationId} />
      ) : null}
      <div
        key={sublocationId === '' ? 'default' : sublocationId}
        className={
          previousSublocationId !== null
            ? 'wl-backdrop wl-backdrop-enter'
            : 'wl-backdrop'
        }
        data-sublocation={sublocationId}
      />
      {sublocationName !== '' ? (
        <span className="wl-sublocation-chip">{sublocationName}</span>
      ) : null}

      <div className="wl-lineup">
        {CAST.map((member) => {
          const artId = artByCharacter[member.character_id] ?? 'neutral';
          return (
            <figure
              key={member.character_id}
              className="wl-portrait"
              data-speaking={props.speakingCall === 'character'}
              data-art={artId}
            >
              <div className="wl-portrait-figure">{member.name.charAt(0)}</div>
              <figcaption className="wl-portrait-pose">
                {member.name} · {artId}
              </figcaption>
            </figure>
          );
        })}
      </div>

      {props.children}
    </section>
  );
}
