// The VN stage: backdrop (slide transition on sublocation.changed), the
// character line-up with speaker rise + art switches, and the sublocation
// chip. Pure projection of store state — no game logic (Brief §2.5).
import { useSceneStore } from '../store.js';

export function SceneStage(props: {
  /** The call kind of the sentence currently displayed (speaker rise). */
  speakingCall: 'narrator' | 'character' | 'narration' | null;
  children: React.ReactNode;
}): React.JSX.Element {
  const sublocationId = useSceneStore((s) => s.sublocationId);
  const previousSublocationId = useSceneStore((s) => s.previousSublocationId);
  const sublocationName = useSceneStore((s) => s.sublocationName);
  const artByCharacter = useSceneStore((s) => s.artByCharacter);
  // Painter-generated backdrops (0.10.0): an id with a landed backdrop
  // renders the real image; without one, the themed placeholder gradient.
  const backdropBySublocation = useSceneStore((s) => s.backdropBySublocation);
  // The roster projection (character.joined events) — the Narrator never
  // appears in the line-up (UI Spec §1.5). Art switches arrive per character_id.
  const cast = useSceneStore((s) => s.cast);

  const backdropPath = backdropBySublocation[sublocationId];
  const previousPath =
    previousSublocationId === null
      ? undefined
      : backdropBySublocation[previousSublocationId];

  return (
    <section className="wl-stage" aria-label="scene stage">
      {previousSublocationId !== null ? (
        <div
          className="wl-backdrop"
          data-sublocation={previousSublocationId}
          style={
            previousPath === undefined
              ? undefined
              : { backgroundImage: `url(/v1/images/${previousPath})` }
          }
        />
      ) : null}
      <div
        // The path is part of the key: a backdrop landing LIVE for the
        // current sublocation re-mounts the layer and replays the slide
        // transition (UI Spec §1.6 — placeholder until then).
        key={`${sublocationId === '' ? 'default' : sublocationId}|${backdropPath ?? ''}`}
        className={
          previousSublocationId !== null || backdropPath !== undefined
            ? 'wl-backdrop wl-backdrop-enter'
            : 'wl-backdrop'
        }
        data-sublocation={sublocationId}
        style={
          backdropPath === undefined
            ? undefined
            : { backgroundImage: `url(/v1/images/${backdropPath})` }
        }
      />
      {sublocationName !== '' ? (
        <span className="wl-sublocation-chip">{sublocationName}</span>
      ) : null}

      <div className="wl-lineup">
        {cast.map((member) => {
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
