import { useEffect, useRef, useState, type RefObject } from "react";
import { POSITIONS, cleanSlot, isImageSlot, resolveSlot, slotsOf } from "../../../shared/src/overlays";
import type { OverlaySlot } from "../../../shared/src/overlays";
import type { ParameterValue } from "../../../shared/src/worlds";
import { readoutsFrom } from "../../../shared/src/audio";
import { clausesHold, conditionValues } from "../../../shared/src/world-graph";
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
 * The `speech` source is the reason `state.speech` is threaded in. It resolves
 * from live state exactly as `playlist-header` and `track-description` do, so a
 * spoken line never reaches the manifest — and a World carrying no `speech` slot
 * draws no spoken word at all, which is what turns subtitles on and off and what
 * keeps the broadcast surface's allowlist honest without widening it.
 *
 * An image whose file will not load is removed rather than blanked. `alt=""`
 * alone is not enough: a broken `<img>` paints a platform glyph, and with any
 * alt at all it paints the words. On a projector that is the leak the whole
 * no-text rule exists to stop.
 *
 * `pointer-events: none`, so a double-click still reaches the stage.
 *
 * A slot that is not drawn right now — its States do not match, or a clause
 * does not hold — keeps its element and wears `hidden`. See `isDrawn` and
 * `useFades` below.
 */

/**
 * Whether a slot is drawn right now.
 *
 * The two halves a transition has, in the order a transition asks them: where
 * the machine is, then whether the clauses hold. Naming no States means every
 * State — `fromAny` by another name — and carrying no clauses means always, so
 * a slot that says neither is drawn exactly as it was before any of this
 * existed.
 *
 * A client that has not been told where the machine is holds no `stateId`, and
 * a slot naming States is then not drawn. That is the safe direction and the
 * one `clauseHolds` already takes on an absent value: better a caption that
 * arrives a moment late than one that is on the projector under conditions
 * nobody asked for.
 */
function isDrawn(
  slot: OverlaySlot,
  stateId: string | null,
  values: Record<string, ParameterValue>,
): boolean {
  const states = slot.states;
  if (states !== undefined && states.length > 0) {
    if (stateId === null || !states.includes(stateId)) return false;
  }
  return clausesHold(slot.conditions, values);
}

/**
 * The two-step that makes a fade a fade, per slot.
 *
 * A slot that stops being drawn cannot go straight to `hidden`: `display: none`
 * paints no frames, so the opacity would never animate. Going out, the paint is
 * dropped first and `hidden` follows when the fade has run; coming in, `hidden`
 * comes off first and the paint follows on the next frame. With no fade both
 * halves happen in one update, which is why an unfaded slot is the control case
 * rather than a branch of its own.
 *
 * `shown` is "not `hidden`" and `painted` is "opacity 1". They are separate
 * because they are separate facts: an element mid-fade-out is shown and not
 * painted, and asserting on either alone would call that state the wrong thing.
 */
function useFades(targets: ReadonlyMap<number, { drawn: boolean; fadeMs: number }>) {
  const [shown, setShown] = useState<ReadonlySet<number>>(() => new Set());
  const [painted, setPainted] = useState<ReadonlySet<number>>(() => new Set());
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  // Serialised rather than passed as a dependency: the map is rebuilt every
  // render, so an identity dependency would re-run this on every frame.
  const key = JSON.stringify([...targets].map(([i, t]) => [i, t.drawn, t.fadeMs]));

  useEffect(() => {
    const held = timers.current;
    const nextShown = new Set(shown);
    const nextPainted = new Set(painted);
    for (const [index, target] of targets) {
      const clear = held.get(index);
      if (target.drawn) {
        const wasShown = nextShown.has(index);
        if (clear !== undefined) {
          clearTimeout(clear);
          held.delete(index);
        }
        nextShown.add(index);
        if (target.fadeMs > 0 && !wasShown) {
          // Painted on a later turn, never in the same commit as the un-hiding:
          // an element going from `display: none` to opacity 1 in one paint
          // animates nothing, so a fade written that way is a cut wearing a
          // duration.
          held.set(
            index,
            setTimeout(() => {
              held.delete(index);
              setPainted((was) => new Set(was).add(index));
            }, 0),
          );
        } else {
          nextPainted.add(index);
        }
      } else if (nextPainted.has(index) || nextShown.has(index)) {
        nextPainted.delete(index);
        if (target.fadeMs > 0) {
          if (clear === undefined) {
            held.set(
              index,
              setTimeout(() => {
                held.delete(index);
                setShown((was) => {
                  const now = new Set(was);
                  now.delete(index);
                  return now;
                });
              }, target.fadeMs),
            );
          }
        } else {
          nextShown.delete(index);
        }
      }
    }
    // A slot that has gone from the list takes its timer and its state with it.
    for (const index of [...nextShown]) if (!targets.has(index)) nextShown.delete(index);
    for (const index of [...nextPainted]) if (!targets.has(index)) nextPainted.delete(index);
    for (const [index, timer] of held) {
      if (!targets.has(index)) {
        clearTimeout(timer);
        held.delete(index);
      }
    }
    if (!sameSet(nextShown, shown)) setShown(nextShown);
    if (!sameSet(nextPainted, painted)) setPainted(nextPainted);
    // `shown` and `painted` are read above and deliberately not dependencies:
    // this effect is the only writer, and listing them would re-enter on every
    // write it makes. The target key is the whole of what it reacts to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    const held = timers.current;
    return () => {
      for (const timer of held.values()) clearTimeout(timer);
      held.clear();
    };
  }, []);

  return { shown, painted };
}

function sameSet(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

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
    text: resolveSlot(slot, world, transport, state.speech),
  }));
  // A refused slot is skipped, never the list, so both partitions read the
  // *cleaned* slot and drop anything the guard would not draw.
  const images = resolved.filter((entry) => cleanSlot(entry.slot) !== null && isImageSlot(entry.slot));
  const words = resolved.filter((entry) => !isImageSlot(entry.slot) && entry.text !== null);

  // What the machine says right now, composed the way the runtime composes it
  // so a slot and a transition reading the same clause read the same value. The
  // readouts come from the transport rather than from `live.parameters`, which
  // never carries them — see `shared/src/audio.ts` and origin R27.
  const live = state.worldLive;
  const values = conditionValues(readoutsFrom(transport), live?.parameters ?? {});
  const stateId = live?.stateId ?? null;
  const targets = new Map<number, { drawn: boolean; fadeMs: number }>();
  for (const entry of [...images, ...words]) {
    targets.set(entry.index, {
      drawn: isDrawn(entry.slot, stateId, values),
      fadeMs: entry.slot.fadeMs ?? 0,
    });
  }
  const { shown, painted } = useFades(targets);
  /**
   * The opacity a slot is painted at, and the transition that takes it there.
   *
   * A slot with no fade is left exactly as it was drawn before this feature
   * existed — no opacity property on a caption, the stored one on a picture —
   * so an unchanged World produces an unchanged DOM.
   */
  /**
   * Whether the element is in the layout at all.
   *
   * Drawn *or* still fading out. Asked as a question about the target rather
   * than only about the hook's state, so the very first render of a World that
   * conditions nothing puts every slot on the screen immediately — reading the
   * hook alone would hide every caption for the frame before its first effect.
   */
  const visible = (index: number) => targets.get(index)?.drawn === true || shown.has(index);
  const fade = (index: number, fadeMs: number, base: number) => {
    if (fadeMs <= 0) return base === 1 ? {} : { opacity: base };
    return { opacity: painted.has(index) ? base : 0, transition: `opacity ${fadeMs}ms linear` };
  };

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
                      // Hidden, never unmounted: an unmounted `<img>` re-fetches
                      // on the way back, and a clause that flaps would re-fetch
                      // on every evaluation. See
                      // docs/solutions/hiding-a-media-element-keeps-what-unmounting-throws-away.md.
                      hidden={!visible(entry.index)}
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
                        ...fade(entry.index, slot.fadeMs ?? 0, (slot.opacity ?? 100) / 100),
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
                      className={`overlay-slot${slot.backing ? ` backing-${slot.backing}` : ""}`}
                      data-overlay-slot={entry.index}
                      hidden={!visible(entry.index)}
                      style={{
                        fontFamily: slot.font,
                        fontSize: `${slot.size}cqh`,
                        color: slot.color,
                        ...fade(entry.index, slot.fadeMs ?? 0, 1),
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
