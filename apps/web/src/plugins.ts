// Frontend half of the plugin story (FINAL item 13): loaded plugins are
// fetched once at startup (config-like, not game state), their theme.css
// token overrides are injected as stylesheets, and their custom-element
// modules are imported zero-build — a <wl-*> tag defined by a plugin can then
// be used anywhere. Provenance (source + hash) surfaces in dev mode (B10).
import { PluginListSchema, type PluginInfo } from '@weltari/protocol';

export async function loadPluginFrontends(): Promise<PluginInfo[]> {
  let raw: unknown;
  try {
    const response = await fetch('/v1/plugins');
    if (!response.ok) return [];
    raw = await response.json();
  } catch {
    // CATCH-OK: no plugin list = the core UI stands alone.
    return [];
  }
  const list = PluginListSchema.safeParse(raw);
  if (!list.success) return [];

  for (const plugin of list.data.plugins) {
    // The provenance hash doubles as a cache-buster: plugin assets carry no
    // cache headers, and a stale browser-cached module would silently undo a
    // plugin update (the hash changes with every content change, B10).
    const bust = `?v=${plugin.provenance.sha256.slice(0, 16)}`;
    for (const theme of plugin.themes) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = `${theme}${bust}`;
      document.head.appendChild(link);
    }
    for (const component of plugin.components) {
      // Zero-build: the module self-defines its custom elements on import.
      import(/* @vite-ignore */ `${component}${bust}`).catch(
        (thrown: unknown) => {
          console.warn('plugin component failed to load', component, thrown);
        },
      );
    }
  }
  return list.data.plugins;
}
