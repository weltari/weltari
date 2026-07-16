// The consent card (M7 part 2, Rev 4 §16, owner UX ruling 2026-07-11):
// a pending proposal renders inside the GM conversation with three buttons —
// Consent / Reject / Chat about this — like a permission prompt. The card is
// a pure projection of proposal.submitted (the diff arrives complete on the
// wire); resolving posts the command and the card settles when
// proposal.resolved comes back on the stream — the store, never local
// state, decides when it disappears.
import { useState } from 'react';
import { postResolveProposal } from '../commands.js';
import { t } from '../i18n.js';
import type { PendingProposal, ProposalPayload } from '../store.js';

function Diff({ payload }: { payload: ProposalPayload }): React.JSX.Element {
  switch (payload.action) {
    case 'create_place':
      return (
        <div className="wl-proposal-diff">
          <strong>{payload.diff.name}</strong>{' '}
          <em>({t(`proposal.space.${payload.diff.space}`)})</em>
          <p>{payload.diff.description}</p>
          {payload.diff.wiki_entry === undefined ? null : (
            <p className="wl-proposal-wiki">{payload.diff.wiki_entry}</p>
          )}
        </div>
      );
    case 'create_character':
      return (
        <div className="wl-proposal-diff">
          <strong>{payload.diff.name}</strong>
          <p>{payload.diff.personality}</p>
          <ul>
            {payload.diff.goals.map((goal) => (
              <li key={goal}>{goal}</li>
            ))}
          </ul>
        </div>
      );
    case 'create_object':
      return (
        <div className="wl-proposal-diff">
          <strong>{payload.diff.name}</strong>{' '}
          <em>({payload.diff.holder_sublocation_id})</em>
          {payload.diff.object_payload === undefined ? null : (
            <p>{payload.diff.object_payload}</p>
          )}
        </div>
      );
    case 'edit_wiki':
      return (
        <div className="wl-proposal-diff">
          <strong>{payload.diff.sublocation_id}</strong>
          {payload.diff.previous_entry === undefined ? null : (
            <p className="wl-proposal-before">
              {t('proposal.wiki.was')}: {payload.diff.previous_entry}
            </p>
          )}
          <p className="wl-proposal-after">
            {t('proposal.wiki.becomes')}: {payload.diff.entry}
          </p>
        </div>
      );
    case 'seed_world':
      return (
        <div className="wl-proposal-diff">
          <strong>{payload.diff.world_name}</strong>{' '}
          <em>({payload.diff.language})</em>
          {payload.diff.chapter_seed === undefined ? null : (
            <p>{payload.diff.chapter_seed}</p>
          )}
          <p className="wl-proposal-group">{t('proposal.seed.places')}</p>
          <ul>
            {payload.diff.places.map((place) => (
              <li key={place.name}>
                <strong>{place.name}</strong>{' '}
                <em>({t(`proposal.space.${place.space}`)})</em> —{' '}
                {place.description}
              </li>
            ))}
          </ul>
          <p className="wl-proposal-group">{t('proposal.seed.characters')}</p>
          <ul>
            {payload.diff.characters.map((character) => (
              <li key={character.name}>
                <strong>{character.name}</strong> — {character.personality}
              </li>
            ))}
          </ul>
        </div>
      );
  }
}

export function ProposalCard(props: {
  proposal: PendingProposal;
  /** "Chat about this": prefill the GM input — the card stays pending. */
  onDiscuss: (draft: string) => void;
}): React.JSX.Element {
  const { payload } = props.proposal;
  // Busy only guards double-clicks; the truth (card removal) is the stream.
  const [busy, setBusy] = useState(false);

  function resolve(resolution: 'approved' | 'rejected'): void {
    setBusy(true);
    postResolveProposal(payload.proposal_id, resolution)
      .catch(() => null)
      .finally(() => {
        setBusy(false);
      });
  }

  return (
    <div className="wl-proposal-card" data-action={payload.action}>
      <div className="wl-proposal-head">
        {t('proposal.title')} {t(`proposal.action.${payload.action}`)}
      </div>
      <Diff payload={payload} />
      <p className="wl-proposal-rationale">{payload.rationale}</p>
      <div className="wl-proposal-actions">
        <button
          type="button"
          className="wl-proposal-approve"
          disabled={busy}
          onClick={() => {
            resolve('approved');
          }}
        >
          {t('proposal.approve')}
        </button>
        <button
          type="button"
          className="wl-proposal-reject"
          disabled={busy}
          onClick={() => {
            resolve('rejected');
          }}
        >
          {t('proposal.reject')}
        </button>
        <button
          type="button"
          className="wl-proposal-discuss"
          disabled={busy}
          onClick={() => {
            props.onDiscuss(
              `${t('proposal.discussDraft')}${t(`proposal.action.${payload.action}`)}: `,
            );
          }}
        >
          {t('proposal.discuss')}
        </button>
      </div>
    </div>
  );
}
