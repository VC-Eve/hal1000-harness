/**
 * Give a piece of work a deadline, and an answer for when it misses it.
 *
 * For questions rather than operations. `fs.realpath` has no timeout, so a
 * stalled drive — a disconnected share, a sleeping external disk — blocks the
 * caller with no bound; and the callers here are asking *whether a clip can be
 * played*, on paths that run every time the machine enters a State. Waiting
 * forever is the worst answer available.
 *
 * The fallback is returned for a rejection too, deliberately. "I could not find
 * out" and "it failed" are the same answer to the question being asked, and
 * making every caller write the same catch would be the thing that gets missed.
 */
export async function withDeadline<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
    // Never a reason on its own to keep HAL alive.
    timer.unref?.();
  });

  // Mapped rather than caught alongside: attaching a handler to a *copy* leaves
  // the original still rejecting into the race, and a rejection arriving after
  // the deadline has no handler left at all — which takes the process down.
  const answered = work.then(
    (value) => value,
    () => fallback,
  );

  try {
    return await Promise.race([answered, expiry]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
