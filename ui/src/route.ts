/**
 * Which surface the URL asks for.
 *
 * The app's first router, and deliberately the smallest one that answers R1:
 * two routes, a `popstate` listener, and a push. Kept as a pure module beside
 * `layout.ts` and `lens.ts` because the part worth asserting — what a path maps
 * to — has nothing to do with the DOM, and the component suite is the only one
 * with a `window` to push onto.
 *
 * This deliberately does not travel over the WS contract. Which page a browser
 * is showing is not behaviour: no observation starts or stops, HAL says nothing
 * different, and the World runs whether or not anything is looking at it.
 */

export type Route = "home" | "live";

export const LIVE_PATH = "/live";

/**
 * Map a pathname to a route.
 *
 * Anything unrecognised is home rather than a not-found page: the server's SPA
 * fallback already answers every unmatched path with the document, so a typo
 * lands on the app either way and a second not-found surface would only
 * disagree with it.
 */
export function parseRoute(pathname: string): Route {
  // A trailing slash is the same place.
  const normalized = pathname.replace(/\/+$/, "") || "/";
  return normalized === LIVE_PATH ? "live" : "home";
}

/** The route the browser is on right now. */
export function currentRoute(): Route {
  return parseRoute(window.location.pathname);
}

/** Go somewhere, adding a history entry so Back works. */
export function navigate(route: Route): void {
  const target = route === "live" ? LIVE_PATH : "/";
  if (window.location.pathname === target) return;
  window.history.pushState({}, "", target);
  // `pushState` does not fire `popstate`, so the listeners that watch for Back
  // would otherwise never hear about a forward navigation.
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/** Subscribe to route changes; returns the unsubscribe. */
export function onRouteChange(listener: (route: Route) => void): () => void {
  const handler = () => listener(currentRoute());
  window.addEventListener("popstate", handler);
  return () => window.removeEventListener("popstate", handler);
}
