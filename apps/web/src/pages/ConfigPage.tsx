// The Config page (wireframe 15 + UI Spec §2.7): connection/version info,
// the update surface (update.available badge → Apply → update.staged, with
// 409 refusals shown honestly), and loaded plugins with provenance — the
// dev-overlay data presented calmly. Render-only: every fact here is a
// stream projection or the validated /v1/plugins list; the full §15 config
// panels arrive with their backend systems.
import { useState } from 'react';
import type { PluginInfo } from '@weltari/protocol';
import { postApplyUpdate } from '../commands.js';
import { useSceneStore } from '../store.js';

/** Plain-language help per refusal code — the honest 409 surface. */
function refusalHelp(error: string): string {
  switch (error) {
    case 'updates_disabled':
      return 'Self-update is off: no WELTARI_UPDATE_PUBKEY is configured, or this is a notify-only install (Docker). Native installs: set the minisign public key and restart. Docker: pull the new image instead.';
    case 'version_invalid':
      return 'The announced version tag is not plain semver — refused before any download.';
    default:
      return 'The engine refused the command — see the server log.';
  }
}

function UpdateSection(): React.JSX.Element {
  const available = useSceneStore((s) => s.updateAvailable);
  const staged = useSceneStore((s) => s.updateStaged);
  const jobError = useSceneStore((s) => s.updateJobError);
  const [applyState, setApplyState] = useState<
    | { kind: 'idle' }
    | { kind: 'requested' }
    | { kind: 'refused'; error: string }
  >({ kind: 'idle' });

  const stagedCurrent =
    staged !== null &&
    (available === null || staged.version === available.version);

  function fireApply(version: string): void {
    setApplyState({ kind: 'requested' });
    postApplyUpdate(version)
      .then((result) => {
        if (!result.ok) setApplyState({ kind: 'refused', error: result.error });
        // Accepted: stay in 'requested' until update.staged (or a job
        // failure) arrives on the stream — a 202 is not a result (B6 ethos).
      })
      .catch(() => {
        setApplyState({ kind: 'refused', error: 'request_failed' });
      });
  }

  return (
    <section className="wl-config-section" aria-label="updates">
      <h2>Updates</h2>
      {stagedCurrent ? (
        <p>
          <span className="wl-config-badge" data-tone="ok">
            staged
          </span>{' '}
          Version {staged.version} is verified and staged — it starts on the
          next restart (was {staged.previous_version}).
          <span className="wl-config-hash" title={staged.sha256}>
            {' '}
            sha256:{staged.sha256.slice(0, 16)}…
          </span>
        </p>
      ) : available !== null ? (
        <>
          <p>
            <span className="wl-config-badge" data-tone="accent">
              update available
            </span>{' '}
            Version {available.version} (running {available.current_version}).{' '}
            {available.release_url !== undefined ? (
              <a href={available.release_url} target="_blank" rel="noreferrer">
                release notes ↗
              </a>
            ) : null}
          </p>
          {applyState.kind === 'refused' ? (
            <p className="wl-config-note" data-tone="danger">
              Refused: {applyState.error} — {refusalHelp(applyState.error)}
            </p>
          ) : null}
          {jobError !== null ? (
            <p className="wl-config-note" data-tone="danger">
              The staging job {jobError.parked ? 'was parked' : 'failed'} (
              {jobError.code}): {jobError.message}
              {jobError.parked
                ? ' — parked jobs are never retried automatically; check the server log.'
                : ' — it retries with backoff.'}
            </p>
          ) : null}
          <button
            className="wl-button wl-button-accent"
            disabled={applyState.kind === 'requested' && jobError === null}
            onClick={() => {
              fireApply(available.version);
            }}
          >
            {applyState.kind === 'requested' && jobError === null
              ? 'Verifying & staging…'
              : `Apply ${available.version}`}
          </button>
        </>
      ) : (
        <p className="wl-config-note">
          No newer release announced. The engine checks the release channel at
          startup and on its daily schedule; a find lands here as a badge.
        </p>
      )}
    </section>
  );
}

export function ConfigPage(props: {
  plugins: readonly PluginInfo[];
}): React.JSX.Element {
  const connected = useSceneStore((s) => s.connected);
  const protocolVersion = useSceneStore((s) => s.protocolVersion);
  const available = useSceneStore((s) => s.updateAvailable);
  const rejections = useSceneStore((s) => s.pluginRejections);

  return (
    <main className="wl-config" aria-label="config page">
      <h1>Config</h1>

      <section className="wl-config-section" aria-label="connection">
        <h2>Connection</h2>
        <dl className="wl-config-facts">
          <dt>Stream</dt>
          <dd data-tone={connected ? 'ok' : 'danger'}>
            {connected ? 'connected' : 'reconnecting…'}
          </dd>
          <dt>Protocol</dt>
          <dd>{protocolVersion ?? '…'}</dd>
          <dt>App version</dt>
          <dd>
            {available?.current_version ?? 'unknown until a release check runs'}
          </dd>
        </dl>
      </section>

      <UpdateSection />

      <section className="wl-config-section" aria-label="plugins">
        <h2>Plugins</h2>
        {props.plugins.length === 0 ? (
          <p className="wl-config-note">
            No plugins loaded. Drop a plugin folder into plugins/ — it is
            hash-verified at every load.
          </p>
        ) : (
          <ul className="wl-config-plugins">
            {props.plugins.map((plugin) => (
              <li key={plugin.name}>
                <strong>{plugin.name}</strong> @{plugin.version}
                <span
                  className="wl-config-hash"
                  title={`sha256:${plugin.provenance.sha256} · ${plugin.provenance.source_url}`}
                >
                  {' '}
                  sha256:{plugin.provenance.sha256.slice(0, 16)}…
                </span>
              </li>
            ))}
          </ul>
        )}
        {rejections.map((rejection, i) => (
          <p key={i} className="wl-config-note" data-tone="danger">
            Refused at load: {rejection.plugin} ({rejection.reason}) —{' '}
            {rejection.detail}
          </p>
        ))}
      </section>
    </main>
  );
}
