// Dev mode (?dev=1, UI Spec §2.8): renders the log-only trail — tool calls,
// B6-gate rejections, self-watch gauges — pushed on the SSE dev channel,
// plus loaded-plugin provenance (source + content hash, Guide B10).
// Display-only and deliberately alien-looking: it must never read as play.
import type { PluginInfo } from '@weltari/protocol';
import { useSceneStore } from '../store.js';

export function DevOverlay(props: {
  plugins: readonly PluginInfo[];
}): React.JSX.Element {
  const devFrames = useSceneStore((s) => s.devFrames);

  let gaugesLine = '';
  for (const frame of devFrames) {
    if (frame.type === 'dev.gauges') {
      gaugesLine = ` · rss ${String(Math.round(frame.rss_mb))}mb · loop ${String(
        Math.round(frame.loop_p99_ms),
      )}ms${frame.degraded ? ' · DEGRADED' : ''}`;
    }
  }

  return (
    <div className="wl-dev" aria-label="dev trail">
      <h3>
        dev trail
        {gaugesLine}
      </h3>
      {props.plugins.map((plugin) => (
        <p key={plugin.name} className="wl-dev-line" data-kind="plugin">
          ⬡ {plugin.name}@{plugin.version} sha256:{plugin.provenance.sha256} (
          {plugin.provenance.source_url})
        </p>
      ))}
      {[...devFrames].reverse().map((frame, i) => {
        switch (frame.type) {
          case 'dev.tool_call':
            return (
              <p key={i} className="wl-dev-line" data-kind="tool_call">
                ✓ {frame.tool} {frame.input_json}
              </p>
            );
          case 'dev.tool_rejected':
            return (
              <p key={i} className="wl-dev-line" data-kind="tool_rejected">
                ✕ {frame.tool} [{frame.gate} gate] {frame.reason}
              </p>
            );
          case 'dev.gauges':
            return null; // summarized in the header line
        }
      })}
    </div>
  );
}
