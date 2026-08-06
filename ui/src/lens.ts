import type { NarrationStatus } from "../../shared/src/types";

/**
 * What the lens at the tail of the feed is doing.
 *
 *  - `composing` — HAL is narrating right now; the next observation lands
 *    exactly where the lens sits (R1).
 *  - `backlog` — HAL is catching up on events that piled up while he was
 *    away. Distinct from composing so a reader can tell "thinking about what
 *    just happened" from "working through a queue" (R4).
 *  - `absent` — nothing is rendered at all. Idle means the feed is finished
 *    speaking (R2); paused and unavailable mean HAL is *not* working, and a
 *    lens there would be the interface lying about what he is doing (R3).
 */
export type LensState = "composing" | "backlog" | "absent";

/**
 * Derive the lens state from narration status — the whole of the lens's
 * logic, kept pure so it can be asserted without a DOM (the repo has no
 * component-testing stack; the animation itself is checked by screenshot).
 *
 * Written as an exhaustive switch over the `NarrationStatus` union rather
 * than a `status === "narrating"` test: a future status added to the shared
 * contract then fails the typecheck at the `never` assignment instead of
 * silently falling into "absent" — or worse, into "composing" — and
 * misreporting what HAL is doing.
 */
export function lensState(status: NarrationStatus): LensState {
  switch (status) {
    case "narrating":
      return "composing";
    case "catching-up":
      return "backlog";
    case "idle":
    case "paused-missing-model":
    case "provider-unavailable":
      return "absent";
    default: {
      const exhaustive: never = status;
      void exhaustive;
      return "absent";
    }
  }
}
