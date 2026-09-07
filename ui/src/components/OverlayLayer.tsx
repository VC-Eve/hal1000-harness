import { useEffect, useRef, useState, type RefObject } from "react";
import { POSITIONS, cleanSlot, isImageSlot, resolveSlot, slotsOf } from "../../../shared/src/overlays";
import type { OverlaySlot } from "../../../shared/src/overlays";
import { readoutsFrom } from "../../../shared/src/audio";
import { conditionValues, slotDrawn } from "../../../shared/src/world-graph";
import type { AppState } from "../store";
import { fittedRect, type Rect, type Size } from "../overlay";
import { imageUrl } from "../imageUrl";
import { treatmentStyle } from "../textTreatment";

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
 * What names a slot across an edit to the list it lives in.
 *
 * **Not its index.** `failed` two fields above is keyed by image *name* for
 * exactly this reason, in a comment that says an index means a different slot
 * after a reorder — and the first version of this hook was keyed by index
 * anyway, so a reorder mid-fade handed one slot's pending timer to whatever now
 * sat at that position: a caption fading out on a slot that was never asked to
 * go, and a stale `shown` entry holding a line of layout for a slot that is not
 * there.
 *
 * **And not a summary of it either.** The version after that keyed on position
 * and words alone, which collided for two slots saying the same thing in
 * different States — and `targets` is a map, so the second answered for both: a
 * caption drawn while its own States excluded the State the machine was in,
 * which is the failure the tagged timers in the same change exist to prevent.
 * Everything the operator stored goes in, so any difference at all is a
 * different key. Editing a slot mid-fade restarts its fade, which is the honest
 * answer to "this is a different slot now".
 *
 * Built from what the operator *stored*, never from what a slot currently
 * resolves to, so a `speech` caption keeps one key while its words change
 * sentence by sentence.
 *
 * The World goes in too. Two Worlds carry the same three default slots, so a
 * switch would otherwise hand the new World a fade the old one was running —
 * and, worse, leave a drawn slot unpainted for good when the two Worlds'
 * targets serialise the same, because the recompute is keyed on the targets and
 * would not re-enter.
 *
 * The ordinal is the last resort: two slots stored *identically* in one World
 * are indistinguishable on the picture, but they are still two elements, and one
 * answer for both is what went wrong the first time.
 */
function slotKeys(slots: readonly OverlaySlot[], worldId: string | null): string[] {
  const seen = new Map<string, number>();
  return slots.map((slot) => {
    const stored = JSON.stringify(slot);
    const nth = seen.get(stored) ?? 0;
    seen.set(stored, nth + 1);
    return `${worldId ?? "-"}|${nth}|${stored}`;
  });
}

/**
 * Which half of a fade a pending wake-up belongs to, and how to call it off.
 *
 * A closure rather than a handle: the two halves are scheduled by different
 * clocks — a hide by `setTimeout`, a paint by nested animation frames — and one
 * `clearTimeout` over both would silently cancel neither.
 */
type Pending = { kind: "paint" | "hide"; cancel: () => void };

/**
 * Two nested frames, or a macrotask where there are no frames.
 *
 * A macrotask is not a rendering opportunity: a busy main thread can coalesce
 * the un-hiding and the opacity change into one recalculation and skip the
 * transition entirely, and a backgrounded tab throttles the timeout to a floor
 * of a second or more. Two frames is the idiom that actually guarantees a style
 * flush in between. jsdom defines no `requestAnimationFrame` in every
 * configuration, so the timeout stays as the fallback — the `silenceTextTracks`
 * rule for an API a DOM may not have.
 */
function afterAFrame(run: () => void): () => void {
  if (typeof requestAnimationFrame !== "function") {
    const timer = setTimeout(run, 0);
    return () => clearTimeout(timer);
  }
  let inner: number | null = null;
  const outer = requestAnimationFrame(() => {
    inner = requestAnimationFrame(run);
  });
  return () => {
    cancelAnimationFrame(outer);
    if (inner !== null) cancelAnimationFrame(inner);
  };
}

/**
 * The two-step that makes a fade a fade, per slot.
 *
 * A slot that stops being drawn cannot go straight to `hidden`: `display: none`
 * paints no frames, so the opacity would never animate. Going out, the paint is
 * dropped first and `hidden` follows when the fade has run; coming in, `hidden`
 * comes off first and the paint follows on a later frame. With no fade both
 * halves happen in one update, which is why an unfaded slot is the control case
 * rather than a branch of its own.
 *
 * `shown` is "not `hidden`" and `painted` is "opacity 1". They are separate
 * because they are separate facts: an element mid-fade-out is shown and not
 * painted, and asserting on either alone would call that state the wrong thing.
 *
 * A pending timer carries **which half it is for**. Holding one untagged timer
 * per slot left a caption stuck on the projector: a slot that became drawn armed
 * a paint, and if the clause went false before that paint ran, the fade-out
 * branch saw *a* timer pending, so it neither cancelled the paint nor armed the
 * hide — and because neither set changed, the effect never ran again. The paint
 * then fired and the element stayed fully drawn with its clause false, which is
 * the exact outcome this whole feature exists to prevent.
 */
function useFades(targets: ReadonlyMap<string, { drawn: boolean; fadeMs: number }>) {
  const [shown, setShown] = useState<ReadonlySet<string>>(() => new Set());
  const [painted, setPainted] = useState<ReadonlySet<string>>(() => new Set());
  const timers = useRef(new Map<string, Pending>());
  // Serialised rather than passed as a dependency: the map is rebuilt every
  // render, so an identity dependency would re-run this on every frame.
  const key = JSON.stringify([...targets].map(([k, t]) => [k, t.drawn, t.fadeMs]));

  // A new World needs no reset of its own: every key carries the World, so a
  // switch makes every slot a key nothing holds, and the sweep at the end of
  // this effect retires what is left. The version that *did* reset — a layout
  // effect clearing both sets — was worse than nothing: the only writer that
  // refills them is keyed on the targets, so two Worlds whose targets
  // serialised alike never re-entered it, and a drawn faded caption held its
  // line of layout at opacity 0 for good.
  useEffect(() => {
    const held = timers.current;
    const nextShown = new Set(shown);
    const nextPainted = new Set(painted);
    const cancel = (id: string) => {
      const pending = held.get(id);
      if (pending === undefined) return;
      pending.cancel();
      held.delete(id);
    };
    for (const [id, target] of targets) {
      if (target.drawn) {
        const wasShown = nextShown.has(id);
        cancel(id);
        nextShown.add(id);
        if (target.fadeMs > 0 && !wasShown) {
          // Painted on a later frame, never in the same commit as the
          // un-hiding: an element going from `display: none` to opacity 1 in one
          // paint animates nothing, so a fade written that way is a cut wearing
          // a duration. Two nested frames rather than a zero timeout — a
          // macrotask is not a rendering opportunity, and a busy main thread or
          // a backgrounded tab can coalesce both style changes into one recalc.
          const cancel = afterAFrame(() => {
            held.delete(id);
            setPainted((was) => new Set(was).add(id));
          });
          held.set(id, { kind: "paint", cancel });
        } else {
          nextPainted.add(id);
        }
      } else if (nextPainted.has(id) || nextShown.has(id)) {
        nextPainted.delete(id);
        if (target.fadeMs > 0) {
          // A pending *paint* is cancelled here: it belongs to an arrival this
          // departure has overtaken, and leaving it armed is what stuck a
          // caption on the screen. A pending *hide* is left alone — it is
          // already doing this job, and re-arming it would restart the fade.
          if (held.get(id)?.kind !== "hide") {
            cancel(id);
            const timer = setTimeout(() => {
              held.delete(id);
              setShown((was) => {
                const now = new Set(was);
                now.delete(id);
                return now;
              });
            }, target.fadeMs);
            held.set(id, { kind: "hide", cancel: () => clearTimeout(timer) });
          }
        } else {
          cancel(id);
          nextShown.delete(id);
        }
      }
    }
    // A slot that has gone from the list takes its timer and its state with it.
    for (const id of [...nextShown]) if (!targets.has(id)) nextShown.delete(id);
    for (const id of [...nextPainted]) if (!targets.has(id)) nextPainted.delete(id);
    for (const id of [...held.keys()]) if (!targets.has(id)) cancel(id);
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
      for (const pending of held.values()) pending.cancel();
      held.clear();
    };
  }, []);

  return { shown, painted };
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
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
  const cleanedSlots = slots.map((slot) => cleanSlot(slot) ?? slot);
  const keys = slotKeys(cleanedSlots, worldId);
  const resolved = cleanedSlots.map((slot, index) => ({
    slot,
    index,
    id: keys[index]!,
    text: resolveSlot(slots[index]!, world, transport, state.speech),
  }));
  // A refused slot is skipped, never the list, so both partitions read the
  // *cleaned* slot and drop anything the guard would not draw.
  const images = resolved.filter((entry) => cleanSlot(entry.slot) !== null && isImageSlot(entry.slot));
  const captions = resolved.filter((entry) => !isImageSlot(entry.slot));

  // What the machine says right now, composed the way the runtime composes it
  // so a slot and a transition reading the same clause read the same value. The
  // readouts come from the transport rather than from `live.parameters`, which
  // never carries them — see `shared/src/audio.ts` and origin R27.
  // Only the live state of the World actually on screen. `OverlayEditor` asks
  // the same question and the store's `world` reducer asks it too; the layer
  // asking it as well is what stops a client mid-World-switch from drawing this
  // World's slots against the next World's State and Parameters.
  const live = state.worldLive?.worldId === worldId ? state.worldLive : null;
  const values = conditionValues(readoutsFrom(transport), live?.parameters ?? {});
  const stateId = live?.stateId ?? null;
  const targets = new Map<string, { drawn: boolean; fadeMs: number }>();
  for (const entry of [...images, ...captions]) {
    targets.set(entry.id, {
      // A caption whose words have gone is not drawn, rather than not present:
      // a `speech` slot resolves to null the moment its sentence ends, and
      // dropping it from the list here would unmount it in the same commit and
      // cut a faded subtitle instead of fading it.
      drawn: (isImageSlot(entry.slot) || entry.text !== null) && slotDrawn(entry.slot, stateId, values).drawn,
      fadeMs: entry.slot.fadeMs ?? 0,
    });
  }
  const { shown, painted } = useFades(targets);
  /**
   * The last words a caption had, held for the length of its fade.
   *
   * A slot with nothing to say still renders no element — the rule that keeps
   * the broadcast allowlist exact — but a slot that *had* words a moment ago and
   * is fading out has to go on saying them until the fade ends, or the fade has
   * nothing to fade.
   */
  const lastText = useRef(new Map<string, string>());
  for (const entry of captions) {
    if (entry.text !== null) lastText.current.set(entry.id, entry.text);
  }
  // Pruned to what is on the page. Without this it grows one entry per distinct
  // slot ever rendered, and a key that has gone belongs to a slot whose last
  // words nobody is waiting to watch fade.
  for (const id of [...lastText.current.keys()]) if (!targets.has(id)) lastText.current.delete(id);
  const words = captions
    .map((entry) => ({ ...entry, said: entry.text, text: entry.text ?? lastText.current.get(entry.id) ?? null }))
    // Two different reasons to be here, and they are not the same rule. A slot
    // with words renders whether or not it is drawn — not drawn means `hidden`,
    // which is what lets an operator's caption come back without re-fetching.
    // A slot whose words have *gone* renders only while it is still on its way
    // out, holding the last thing it said for the length of the fade.
    .filter((entry) => entry.text !== null && (entry.said !== null || shown.has(entry.id)));
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
  const visible = (id: string) => targets.get(id)?.drawn === true || shown.has(id);
  const fade = (id: string, fadeMs: number, base: number) => {
    if (fadeMs <= 0) return base === 1 ? {} : { opacity: base };
    return { opacity: painted.has(id) ? base : 0, transition: `opacity ${fadeMs}ms linear` };
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
                      hidden={!visible(entry.id)}
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
                        ...fade(entry.id, slot.fadeMs ?? 0, (slot.opacity ?? 100) / 100),
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
                      className={`overlay-slot${slot.band ? " overlay-band" : ""}`}
                      data-overlay-slot={entry.index}
                      hidden={!visible(entry.id)}
                      style={{
                        fontFamily: slot.font,
                        fontSize: `${slot.size}cqh`,
                        color: slot.color,
                        // Inline, never a class per treatment: the values are
                        // authored per slot and there is no finite set of them,
                        // and an inline style cannot lose a cascade contest on
                        // one surface and win it on the other. Nothing in
                        // `styles.css` sets these properties, so there is one
                        // place they come from.
                        ...treatmentStyle(slot),
                        ...fade(entry.id, slot.fadeMs ?? 0, 1),
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
