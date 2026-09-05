/**
 * Where an overlay image's bytes come from.
 *
 * `clipUrl`'s shape and for its reason: query parameters, never a path segment,
 * because a World-relative name carries slashes and a segment would have half
 * of one read as part of the route.
 *
 * Its own module rather than a second export from the clip stage: the overlay
 * layer draws on both surfaces and has no other reason to import the engine.
 */
export function imageUrl(worldId: string, image: string): string {
  return `/api/live/image?world=${encodeURIComponent(worldId)}&image=${encodeURIComponent(image)}`;
}
