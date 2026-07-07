// Client-side routing over the History API (owner decision: no router
// dependency — the rail has four destinations). The route is pure view
// state: it never touches the store, and every page renders from the same
// SSE projections, so navigation can never lose scene state.
import { useSyncExternalStore } from 'react';

export type Route = '/' | '/map' | '/gameday' | '/config';

const listeners = new Set<() => void>();

/** Unknown paths render the Scene route (SPA fallback serves index.html). */
function normalize(pathname: string): Route {
  return pathname === '/map' ||
    pathname === '/gameday' ||
    pathname === '/config'
    ? pathname
    : '/';
}

export function navigate(route: Route): void {
  if (normalize(window.location.pathname) === route) return;
  window.history.pushState(null, '', route);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener('popstate', listener);
  return (): void => {
    listeners.delete(listener);
    window.removeEventListener('popstate', listener);
  };
}

function currentRoute(): Route {
  return normalize(window.location.pathname);
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, currentRoute);
}
