/**
 * Which surface the URL asks for.
 *
 * The app's first router, and deliberately the smallest one that answers R1:
 * two routes, a `popstate` listener, and a push. Kept as a pure module beside
 * `layout.ts` and `lens.ts` because the part worth asserting — what a path maps
 * to — has nothing to do with the DOM, and the component suite is the only one
 * with a `window` to push onto.
 *
 * The route itself deliberately does not travel over the WS contract, and the
 * server trusts no part of it. What a page is showing is still not behaviour:
 * HAL says nothing different, and the World runs whether or not anything is
 * looking at it.
 *
 * One qualification since `/broadcast` arrived, because the original wording —
 * "no observation starts or stops" — is now false in this codebase's own
 * vocabulary. Reaching the broadcast route *is* what makes the client declare
 * itself an observer (`App.tsx`), which costs that socket the audio grant and
 * the two clip reports. The capability still lives entirely in the message, not
 * the URL: an agent that never touches this module and simply sends `observe`
 * gets the identical effect, which is what keeps the agent-native rule intact.
 */

export type Route = "home" | "live" | "broadcast";

export const LIVE_PATH = "/live";
/**
 * The output surface. A route rather than a mode on `/live`, because the point
 * is that no operator component is mounted — a flag would leave them all
 * mounted and one missed conditional away from reaching a projector.
 */
export const BROADCAST_PATH = "/broadcast";

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
  if (normalized === BROADCAST_PATH) return "broadcast";
  return normalized === LIVE_PATH ? "live" : "home";
}

/** The route the browser is on right now. */
export function currentRoute(): Route {
  return parseRoute(window.location.pathname);
}

/** Go somewhere, adding a history entry so Back works. */
export function navigate(route: Route): void {
  const target = route === "live" ? LIVE_PATH : route === "broadcast" ? BROADCAST_PATH : "/";
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

/**
 * What the window is called.
 *
 * Inverted deliberately. `index.html` ships the neutral title and the operator
 * routes set the identifying one, rather than the other way round — a broadcast
 * window that never runs a line of JS, or whose bundle fails to parse, is then
 * still neutral. Setting a neutral title *from* the route would have left the
 * leak as the default and the fix as the override, which is the fail-open shape
 * this whole surface is built to avoid. The taskbar and OBS's window list read
 * this.
 */
export const HAL_TITLE = "HAL 1000";
export const BROADCAST_TITLE = "Broadcast";

export function titleFor(route: Route): string {
  return route === "broadcast" ? BROADCAST_TITLE : HAL_TITLE;
}
