import { useEffect, useRef, useState, type RefObject } from "react";
import { POSITIONS, resolveSlot, slotsOf } from "../../../shared/src/overlays";
import type { AppState } from "../store";
import { fittedRect, type Rect, type Size } from "../overlay";

interface Props {
  state: AppState;
  /** The stage's two elements, so the picture's own size can be read. */
  videos: readonly [RefObject<HTMLVideoElement>, RefObject<HTMLVideoElement>];
  /** Which of them is visible. */
  front: number;
  /** Whether nothing is assigned, in which case the picture is the whole box. */
  blank: boolean;
}

/**
 * The words over the picture, on both surfaces.
 *
 * One component mounted by `ClipPlayer` and `BroadcastStage` alike, so the two
 * cannot drift: what a slot says is `resolveSlot`'s answer, and how big it is
 * is a percentage of the *picture's* height — the layer is a size container
 * placed on the rect `fittedRect` computes, and each slot's font size is that
 * many `cqh`. The small player on `/live` and a fullscreened `/broadcast` then
 * draw the same proportions without a resize listener doing any font maths.
 *
 * A slot that resolves to nothing renders nothing — not an empty element. That
 * is what keeps the broadcast surface's allowlist exact: every text node on
 * that route sits under a `data-overlay-slot`, and there is never a slot
 * element with nothing to say. No `title`, no `aria-label`: on the projector an
 * attribute that reads as prose is text too.
 *
 * `pointer-events: none`, so a double-click still reaches the stage.
 */
export function OverlayLayer({ state, videos, front, blank }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [container, setContainer] = useState<Size>({ width: 0, height: 0 });
  const [intrinsic, setIntrinsic] = useState<Size | null>(null);

  /**
   * The box's own size, watched where the browser offers to watch it.
   *
   * Guarded, because jsdom defines no `ResizeObserver` and an unguarded
   * constructor would throw on mount in every stage test — the
   * `silenceTextTracks` idiom for an API a DOM may not have. Without one the
   * box is measured once on mount, which is also what a browser gets before
   * the observer's first callback.
   */
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      setContainer({ width: rect.width, height: rect.height });
    };
    measure();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setContainer({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  /**
   * The picture's own size, re-read on every swap.
   *
   * `loadedmetadata` fires on the *back* element while it preloads, and the
   * swap on `canplay` raises no metadata event of its own — so a layer that
   * read the front element only when metadata arrived would keep the previous
   * clip's aspect after every swap, and put bottom-left text in the bar. Keyed
   * on `front` so the swap itself is a re-read, and listening on both elements
   * so the first clip is sized before its swap lands.
   */
  useEffect(() => {
    const read = () => {
      const element = videos[front]?.current;
      if (!element || blank) {
        setIntrinsic(null);
        return;
      }
      setIntrinsic({ width: element.videoWidth, height: element.videoHeight });
    };
    read();
    const elements = videos.map((ref) => ref.current).filter((e): e is HTMLVideoElement => e !== null);
    for (const element of elements) element.addEventListener("loadedmetadata", read);
    return () => {
      for (const element of elements) element.removeEventListener("loadedmetadata", read);
    };
  }, [videos, front, blank]);

  const picture: Rect = fittedRect(container, intrinsic);
  const world = state.world;
  const transport = state.audioTransport;
  const slots = slotsOf(world);
  const resolved = slots.map((slot, index) => ({ slot, index, text: resolveSlot(slot, world, transport) }));

  return (
    <div className="overlay-layer" data-testid="overlay-layer" ref={box}>
      <div
        className="overlay-picture"
        data-testid="overlay-picture"
        style={{
          left: `${picture.left}px`,
          top: `${picture.top}px`,
          width: `${picture.width}px`,
          height: `${picture.height}px`,
        }}
      >
        {POSITIONS.map((position) => (
          <div key={position} className={`overlay-cell ${position}`} data-testid={`overlay-cell-${position}`}>
            {resolved
              .filter((entry) => entry.slot.position === position && entry.text !== null)
              .map((entry) => (
                <div
                  key={entry.index}
                  className="overlay-slot"
                  data-overlay-slot={entry.index}
                  style={{
                    fontFamily: entry.slot.font,
                    fontSize: `${entry.slot.size}cqh`,
                    color: entry.slot.color,
                  }}
                >
                  {entry.text}
                </div>
              ))}
          </div>
        ))}
      </div>
    </div>
  );
}
