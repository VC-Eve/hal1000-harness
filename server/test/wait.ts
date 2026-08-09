// Wait for a condition, not for a duration.
//
// `await new Promise((r) => setTimeout(r, 50))` followed by an assertion says
// "fifty milliseconds is definitely enough", which is true on an idle machine
// and false in a suite running seventy-six files in parallel. It is the whole
// remaining flake class: the assertion is right, the deadline is a guess, and
// when the guess loses the failure names the assertion rather than the wait.
//
// Polling costs nothing when the condition is already true — the common case —
// and the timeout only matters when something is genuinely broken, so it can be
// generous without slowing anything down. A test that used to sleep 50ms and
// assert now returns as soon as the work lands, which is usually sooner.
//
// This does NOT replace a sleep before a *negative* assertion. "Wait, then
// check nothing happened" cannot be polled — there is no condition to wait for,
// and the duration is the point. Those stay as they are.

const POLL_MS = 5;
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Resolve once `predicate` returns true, or throw naming what never happened.
 *
 * The label is not decoration. A bare "timed out" in a suite of 1,356 tests
 * costs a bisect to locate; a label costs nothing to write and says which
 * condition was still false.
 */
export async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
