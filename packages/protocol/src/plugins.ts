import { z } from 'zod';

// The loaded-plugins surface (GET /v1/plugins) — how clients learn which
// plugins are active, which frontend assets to import (zero-build custom
// elements + theme.css token overrides, FINAL item 13) and each plugin's
// provenance (source URL + content hash, shown in Config and dev mode —
// UI Spec §2.8, Week-3 criterion a).

export const PluginInfoSchema = z.strictObject({
  /** Folder name under plugins/ — also the URL segment for its assets. */
  name: z.string().min(1),
  version: z.string().min(1),
  provenance: z.strictObject({
    source_url: z.string().min(1),
    /** sha256 over the plugin's content files, verified at every load (B10). */
    sha256: z.string().length(64),
  }),
  /**
   * Web-importable assets, as absolute URL paths served by the engine:
   * themes are stylesheets of --wl-* token overrides; components are ES
   * modules that self-define <wl-*> custom elements on import.
   */
  themes: z.array(z.string().min(1)),
  components: z.array(z.string().min(1)),
  /** Connector names the plugin's backend half registered. */
  connectors: z.array(z.string().min(1)),
});
export type PluginInfo = z.infer<typeof PluginInfoSchema>;

/** GET /v1/plugins response. */
export const PluginListSchema = z.strictObject({
  plugins: z.array(PluginInfoSchema),
});
export type PluginList = z.infer<typeof PluginListSchema>;
