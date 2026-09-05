import { useEffect, useRef, useState, type RefObject } from "react";
import { POSITIONS, cleanSlot, isImageSlot, resolveSlot, slotsOf } from "../../../shared/src/overlays";
import type { AppState } from "../store";
import { fittedRect, type Rect, type Size } from "../overlay";
import { imageUrl } from "../imageUrl";

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
 * Two grids, not one. Picture slots draw in the first and words in the second,
 * so "images behind text" is true by document order rather than by a rule this
 * component has to keep — and list order goes on meaning what it meant for
 * words, which stack in a column. The three-by-three definition lives on the
 * two grids rather than on `.overlay-picture`, which stays the size container
 * the `cqh` units resolve against.
 *
 * An image whose file will not load is removed rather than blanked. `alt=""`
 * alone is not enough: a broken `<img>` paints a platform glyph, and with any
 * alt at all it paints the words. On a projector that is the leak the whole
 * no-text rule exists to stop.
 *
 * `pointer-events: none`, so a double-click still reaches the stage.
 */
export function OverlayLayer({ state, videos, front, blank }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [container, setContainer] = useState<Size>({ width: 0, height: 0 });
  const [intrinsic, setIntrinsic] = useState<Size | null>(null);
  /**
   * Image *names* that would not load.
   *
   * Held rather than re-tried, so a missing file does not become a request per
   * render. Keyed by name and not by slot index for two reasons the first
   * version of this got wrong: an index means a different slot after a reorder,
   * so a failure would suppress the wrong picture; and the store replaces
   * `state.world` wholesale on every `world` message, which the server
   * broadcasts on *any* successful mutation — so a reset keyed on the list's
   * identity fired on an unrelated parameter tweak, and the "not re-requested"
   * claim was false. Keyed by name, a re-import under a new suffixed name is
   * retried because it is a different name, and the same missing name is not.
   */
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());

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

  const world = state.world;
  const worldId = world?.id ?? null;
  // Only a different World starts over. Within one World a name that failed
  // stays failed until the page is reloaded or the slot names something else,
  // which is what keying by name already gives us.
  useEffect(() => {
    setFailed(new Set());
  }, [worldId]);

  const picture: Rect = fittedRect(container, intrinsic);
  const transport = state.audioTransport;
  const slots = slotsOf(world);
  // Drawn from the *cleaned* slot: a stored list is hand-editable, and a colour
  // written as `ff0000` passes the guard but is not a CSS colour as written.
  // `resolveSlot` is null for a slot the guard refuses, so `cleaned` is never
  // null where it is read.
  const resolved = slots.map((slot, index) => ({
    slot: cleanSlot(slot) ?? slot,
    index,
    text: resolveSlot(slot, world, transport),
  }));
  // A refused slot is skipped, never the list, so both partitions read the
  // *cleaned* slot and drop anything the guard would not draw.
  const images = resolved.filter((entry) => cleanSlot(entry.slot) !== null && isImageSlot(entry.slot));
  const words = resolved.filter((entry) => !isImageSlot(entry.slot) && entry.text !== null);

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
        <div className="overlay-images" data-testid="overlay-images">
          {POSITIONS.map((position) => (
            <div
              key={position}
              className={`overlay-image-cell ${position}`}
              data-testid={`overlay-image-cell-${position}`}
            >
              {images
                .filter(
                  (entry) =>
                    entry.slot.position === position &&
                    (!isImageSlot(entry.slot) || entry.slot.image === undefined || !failed.has(entry.slot.image)),
                )
                .map((entry) => {
                  const slot = entry.slot;
                  // A slot with no picture draws nothing and takes no space, the rule a
                  // caption with no words already keeps.
                  if (!isImageSlot(slot) || slot.image === undefined || worldId === null) return null;
                  return (
                    <img
                      key={entry.index}
                      className="overlay-image"
                      data-overlay-image={entry.index}
                      src={imageUrl(worldId, slot.image)}
                      // Empty, and never a filename: an alt is prose on a
                      // projector. The element goes away entirely on error, so
                      // this is belt as well as braces.
                      alt=""
                      onError={() => setFailed((held) => new Set(held).add(slot.image!))}
                      style={{
                        height: `${slot.size}cqh`,
                        // Stored as a percentage, and the CSS property takes
                        // 0–1: passing 50 through would clamp to fully opaque
                        // while every assertion on the rendered value passed.
                        ...(slot.opacity === undefined ? {} : { opacity: slot.opacity / 100 }),
                      }}
                    />
                  );
                })}
            </div>
          ))}
        </div>
        <div className="overlay-text" data-testid="overlay-text">
          {POSITIONS.map((position) => (
            <div key={position} className={`overlay-cell ${position}`} data-testid={`overlay-cell-${position}`}>
              {words
                .filter((entry) => entry.slot.position === position)
                .map((entry) => {
                  const slot = entry.slot;
                  if (isImageSlot(slot)) return null;
                  return (
                    <div
                      key={entry.index}
                      className="overlay-slot"
                      data-overlay-slot={entry.index}
                      style={{
                        fontFamily: slot.font,
                        fontSize: `${slot.size}cqh`,
                        color: slot.color,
                      }}
                    >
                      {entry.text}
                    </div>
                  );
                })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
