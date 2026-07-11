// The Config page (wireframe 15 + UI Spec §2.7): connection/version info,
// the update surface (update.available badge → Apply → update.staged, with
// 409 refusals shown honestly), and loaded plugins with provenance — the
// dev-overlay data presented calmly. Render-only: every fact here is a
// stream projection or the validated /v1/plugins list; the full §15 config
// panels arrive with their backend systems.
import { useState } from 'react';
import type { PluginInfo, UserProfileView } from '@weltari/protocol';
import {
  fetchProfile,
  postApplyUpdate,
  postDeleteProfile,
  postSetConfigFlag,
  profileExportUrl,
} from '../commands.js';
import { t } from '../i18n.js';
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

/** Engine & System (M7 part 2, Rev 4 §15/§9 Job 2): the profiling toggle +
 * the GDPR trio — view (fetched on demand, never the stream), export (a
 * plain download), delete (two-tap confirm, physically erased server-side). */
function EngineSection(): React.JSX.Element {
  const profilingEnabled = useSceneStore((s) => s.profilingEnabled);
  const [view, setView] = useState<UserProfileView | null>(null);
  const [viewOpen, setViewOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  function refreshView(): void {
    fetchProfile()
      .then((profile) => {
        setView(profile);
      })
      .catch(() => {
        // CATCH-OK: a failed fetch leaves the panel closed; retry by reopening.
        setView(null);
      });
  }

  return (
    <section className="wl-config-section" aria-label="engine">
      <h2>{t('config.engine.title')}</h2>
      <h3>{t('config.profiling.title')}</h3>
      <p className="wl-config-note">{t('config.profiling.hint')}</p>
      <p>
        <span
          className="wl-config-badge"
          data-tone={profilingEnabled ? 'ok' : 'accent'}
        >
          {profilingEnabled
            ? t('config.profiling.on')
            : t('config.profiling.off')}
        </span>{' '}
        <button
          className="wl-button"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            // Truth is the stream: config.flag_set flips the badge.
            postSetConfigFlag('profiling_enabled', !profilingEnabled)
              .catch(() => false)
              .finally(() => {
                setBusy(false);
              });
          }}
        >
          {profilingEnabled
            ? t('config.profiling.disable')
            : t('config.profiling.enable')}
        </button>
      </p>
      <p className="wl-config-profile-actions">
        <button
          className="wl-button"
          onClick={() => {
            if (viewOpen) {
              setViewOpen(false);
              return;
            }
            refreshView();
            setViewOpen(true);
          }}
        >
          {viewOpen ? t('config.profile.hide') : t('config.profile.view')}
        </button>{' '}
        <a className="wl-button" href={profileExportUrl()} download>
          {t('config.profile.export')}
        </a>{' '}
        {confirmDelete ? (
          <>
            <span className="wl-config-note" data-tone="danger">
              {t('config.profile.deleteConfirm')}
            </span>{' '}
            <button
              className="wl-button"
              data-tone="danger"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                postDeleteProfile()
                  .then(() => {
                    setConfirmDelete(false);
                    refreshView();
                  })
                  .catch(() => null)
                  .finally(() => {
                    setBusy(false);
                  });
              }}
            >
              {t('config.profile.deleteYes')}
            </button>{' '}
            <button
              className="wl-button"
              onClick={() => {
                setConfirmDelete(false);
              }}
            >
              {t('config.profile.deleteNo')}
            </button>
          </>
        ) : (
          <button
            className="wl-button"
            onClick={() => {
              setConfirmDelete(true);
            }}
          >
            {t('config.profile.delete')}
          </button>
        )}
      </p>
      {viewOpen ? (
        view === null || view.entries.length === 0 ? (
          <p className="wl-config-note">{t('config.profile.empty')}</p>
        ) : (
          <ul className="wl-config-profile">
            {view.entries.map((entry) => (
              <li key={entry.id}>
                {entry.body}
                <span className="wl-config-hash"> · {entry.context_id}</span>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </section>
  );
}

export function ConfigPage(props: {
  plugins: readonly PluginInfo[];
}): React.JSX.Element {
  const connected = useSceneStore((s) => s.connected);
  const protocolVersion = useSceneStore((s) => s.protocolVersion);
  const appVersion = useSceneStore((s) => s.appVersion);
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
          <dd>{appVersion ?? available?.current_version ?? '…'}</dd>
        </dl>
      </section>

      <UpdateSection />

      <EngineSection />

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
