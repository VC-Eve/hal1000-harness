import type { LensState } from "../lens";

/**
 * The lens that sits at the tail of the observation feed while HAL composes.
 *
 * Deliberately dumb: it renders the state `lens.ts` derived and nothing else,
 * and it is a separate component from `HalEye` because the eye carries
 * app-level states (disconnected, error) that mean nothing at the feed tail.
 * The two share their gradients and keyframes through the `--eye-*` tokens in
 * `styles.css` so they read as the same object at two sizes.
 */
export function NarrationLens({ state }: { state: LensState }) {
  if (state === "absent") return null;
  return (
    <div className="lens-row" data-testid="narration-lens" data-lens={state}>
      <span className="lens-time" aria-hidden="true">
        {state === "backlog" ? "···" : "··"}
      </span>
      <span className={`narration-lens ${state}`} title={`HAL is ${state === "backlog" ? "catching up" : "composing"}`}>
        <span className="narration-lens-glow" />
        <span className="narration-lens-core" />
      </span>
    </div>
  );
}
