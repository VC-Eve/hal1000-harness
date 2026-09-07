import { useEffect, useRef, useState } from "react";
import type { ClientMessage, World } from "../../../shared/src/types";
import {
  FONTS,
  MAX_OVERLAYS,
  OPACITY_MAX,
  OPACITY_MIN,
  POSITIONS,
  SIZE_MAX,
  MAX_OVERLAY_FADE_MS,
  MAX_SLOT_CONDITIONS,
  SIZE_MIN,
  SOURCES,
  TEXT_MAX,
  DEFAULT_FONT,
  DEFAULT_OUTLINE,
  DEFAULT_SHADOW,
  OUTLINE_WIDTH_MAX,
  OUTLINE_WIDTH_MIN,
  SHADOW_ANGLE_MAX,
  SHADOW_ANGLE_MIN,
  SHADOW_BLUR_MAX,
  SHADOW_BLUR_MIN,
  SHADOW_DISTANCE_MAX,
  SHADOW_DISTANCE_MIN,
  cleanOutline,
  cleanShadow,
  cleanSlot,
  isImageSlot,
  slotsOf,
  usableOpacity,
  usableSize,
  type ImageSlot,
  type OverlayPosition,
  type OverlaySlot,
  type OverlaySource,
  type SlotWhen,
  type TextOutline,
  type TextShadow,
  type TextSlot,
} from "../../../shared/src/overlays";
import type { AppState } from "../store";
import { ColorField } from "./ColorField";
import { ImagePicker } from "./ImagePicker";

import { ConditionRows } from "./ConditionRows";
import { conditionValues, slotDrawn } from "../../../shared/src/world-graph";
import { readoutsFrom } from "../../../shared/src/audio";

interface Props {
  world: World;
  editable: boolean;
  send: (msg: ClientMessage) => void;
  /** The whole state, for the image picker's folder listing. */
  state: AppState;
  /** Why the last title, slot or import write was refused, by action, or null. */
  refusal: (action: "set-world-title" | "set-world-overlays" | "import-overlay-image") => string | null;
}

/** What each source is called where an author picks it. */
const SOURCE_LABELS: Record<OverlaySource, string> = {
  title: "stream title",
  "playlist-header": "playlist header",
  "track-description": "track description",
  text: "fixed text",
  speech: "what HAL is saying",
};

/**
 * The title and the overlay slots, on the World.
 *
 * `EffectEditor`'s shape: the whole list from the last broadcast, one row per
 * slot, and every change sends the whole next list — slots have no ids, and an
 * agent needs no add, remove and reorder vocabulary to do the same. The list
 * shown is `slotsOf(world)`, so a World that has never been edited shows its
 * three defaults, and the first edit writes them out explicitly.
 *
 * The words themselves are elsewhere: the playlist's header and each track's
 * description are edited in the playlist editor, because they are facts about
 * the tracks. What is here is what labels the show and how any of it looks.
 */
export function OverlayEditor({ world, editable, send, state, refusal }: Props) {
  const slots = slotsOf(world);
  /**
   * The last list this editor *sent*, until the World it was sent for lands.
   *
   * Two edits made before the first comes back — a blur that commits a text
   * and the click that caused the blur — are both computed from the last
   * broadcast otherwise, and the second silently drops the first. The clip-set
   * editor has the same shape and the same ref. Cleared whenever the World's
   * list changes identity, which is the broadcast arriving.
   */
  const latest = useRef<readonly OverlaySlot[] | null>(null);
  useEffect(() => {
    latest.current = null;
  }, [world.overlays]);
  const current = () => latest.current ?? slots;
  /**
   * Which rows have their "when" open.
   *
   * Collapsed for a slot that says nothing about when, which is every slot on
   * disk today — a row already carries two control lines, a colour, a font, a
   * size and sometimes a picker, times up to `MAX_OVERLAYS` of them, and
   * growing every one of those for a feature most of them do not use is how a
   * panel stops being readable.
   */
  const [openWhen, setOpenWhen] = useState<ReadonlySet<number>>(() => new Set());
  /**
   * Which rows have their treatment open. `openWhen`'s shape and for its
   * reason: the common case is a slot that asks for no treatment at all, and
   * nine controls on every row is how a panel stops being readable.
   */
  const [openTreatment, setOpenTreatment] = useState<ReadonlySet<number>>(() => new Set());
  /**
   * What the machine says right now, composed the way the runtime composes it.
   *
   * The same two maps `OverlayLayer` reads, so the mark on a row and the
   * picture cannot disagree about whether a slot is showing. Null while the
   * live state names another World: the answer is then not "no" but "not
   * known", and saying "not showing" would be a claim about a projector this
   * panel is not watching.
   */
  const watching = state.worldLive?.worldId === world.id;
  const liveValues = conditionValues(readoutsFrom(state.audioTransport), state.worldLive?.parameters ?? {});
  const liveStateId = watching ? (state.worldLive?.stateId ?? null) : null;
  // Drafts for the fields that commit on blur or Enter, keyed by slot index —
  // the playlist editor's idiom for a name. Absent means nothing has been
  // typed, and the field shows what the World holds.
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [textDrafts, setTextDrafts] = useState<Record<number, string>>({});
  /** Why the last size or opacity edit was refused. One at a time: only one is being typed. */
  const [sizeError, setSizeError] = useState<string | null>(null);
  /** Which row's image picker is open, if any. One at a time. */
  const [picking, setPicking] = useState<number | null>(null);

  /**
   * Send the whole next list.
   *
   * A stored slot the strict guard refuses — a hand-edited `size: 30` — is
   * dropped here rather than sent: the server refuses a list whole, so one bad
   * neighbour would otherwise make every edit to a good slot fail. It is
   * already skipped where it is drawn, so dropping it on the next authored
   * edit loses nothing the output showed. See
   * docs/solutions/a-lenient-load-and-a-strict-write-need-a-filter-between-them.md.
   */
  const write = (next: readonly OverlaySlot[]) => {
    // Remembered unfiltered, so the indices the rows on screen still carry —
    // the broadcast has not landed — keep meaning the same slots.
    latest.current = next;
    const usable = next.filter((slot) => cleanSlot(slot) !== null);
    send({ type: "set-world-overlays", worldId: world.id, overlays: [...usable] });
  };

  /**
   * Change one field of one slot, without letting a kind's fields reach the
   * other kind.
   *
   * Typed per kind rather than `Partial<OverlaySlot>`, which over a union
   * permits a colour on a picture and a font on a plate. The spread is the same
   * spread it always was; what changed is that the compiler now checks what
   * goes into it. Nothing here ever writes `font` on its own — see the note on
   * the font control.
   */
  const replaceText = (index: number, over: Partial<TextSlot>) =>
    write(current().map((slot, i) => (i === index && !isImageSlot(slot) ? { ...slot, ...over } : slot)));

  const replaceImage = (index: number, over: Partial<ImageSlot>) =>
    write(current().map((slot, i) => (i === index && isImageSlot(slot) ? { ...slot, ...over } : slot)));

  /**
   * Change one of the three fields that say *when* a slot is drawn.
   *
   * Not through `replaceText` / `replaceImage`: those are typed per kind on
   * purpose, so a colour cannot reach a picture, and these three belong to both
   * kinds equally.
   *
   * An empty value removes the key rather than writing `[]` or `0`. `write`
   * sends the list unfiltered — it filters which *slots* go, not what is inside
   * them — so leaving an empty array for the server's guard to drop would put
   * one on the wire, and the canonical form of "always drawn" is the one every
   * existing manifest already has.
   */
  const setSlotFields = (index: number, over: Partial<SlotWhen>) =>
    write(current().map((slot, i) => (i === index ? withWhen(slot, over) : slot)));

  /**
   * Change how one slot's words are treated.
   *
   * Text only — `replaceText`'s reason one level down: a picture has no
   * letterform to border. Switching a treatment off removes the key rather
   * than writing a disabled object, `withWhen`'s rule and for its reason:
   * `write` filters which *slots* go, not what is inside them, so an empty
   * object would reach the wire, and the canonical form of "no outline" is the
   * one every existing manifest already has.
   */
  const setTreatment = (index: number, over: TreatmentEdit) =>
    write(
      current().map((slot, i) => {
        if (i !== index || isImageSlot(slot)) return slot;
        // Merged onto the *cleaned* slot, never onto the props the panel was
        // drawn from. Between an edit and its broadcast the props are the stale
        // list, so a whole replacement object built there would undo the edit
        // before it — `commitText`'s hazard, one field down. Cleaned rather
        // than stored so a hand-edited `backing` is the base the operator can
        // see, and not a value the panel never showed.
        const cleaned = cleanSlot(slot);
        const held = cleaned !== null && !isImageSlot(cleaned) ? cleaned : slot;
        return withTreatment(slot, held, over);
      }),
    );

  const move = (index: number, delta: number) => {
    const list = current();
    const to = index + delta;
    if (to < 0 || to >= list.length) return;
    // Every panel addressing a row by index has to let go, not only the picker:
    // an open `when` kept editing index 3 after index 3 became a different slot,
    // and the next checkbox rewrote a slot the operator was not looking at.
    setOpenWhen(new Set());
    setOpenTreatment(new Set());
    // An open picker addresses its row by index, and this changes what that
    // index means. Closing it is the honest answer — silently re-pointing it
    // would attach the next chosen image to a row the operator is no longer
    // looking at.
    setPicking(null);
    const next = [...list];
    const [held] = next.splice(index, 1);
    next.splice(to, 0, held!);
    write(next);
  };

  /**
   * Commit the title. Unchanged sends nothing — `rename-playlist`'s rule — and
   * empty clears, which the store answers by removing the key.
   */
  const commitTitle = () => {
    if (titleDraft === null) return;
    const asked = titleDraft.trim();
    setTitleDraft(null);
    if (asked === (world.title ?? "")) return;
    send({ type: "set-world-title", worldId: world.id, title: asked.length === 0 ? null : asked });
  };

  const commitText = (index: number) => {
    const draft = textDrafts[index];
    if (draft === undefined) return;
    setTextDrafts((held) => {
      const { [index]: _done, ...rest } = held;
      return rest;
    });
    // `current()`, not `slots`: after a reorder the editor has not had its
    // broadcast back yet, so `slots` is the stale list while the write below
    // uses the fresh one. Deciding on one and writing to the other lands the
    // edit on a different slot, or drops it silently at the kind check.
    const held = current()[index];
    const asked = draft.trim();
    if (held === undefined || isImageSlot(held)) return;
    if (asked === (held.text ?? "")) return;
    replaceText(index, asked.length === 0 ? { text: undefined } : { text: asked });
  };

  /**
   * Commit an opacity. `commitSize`'s shape: refused here with its reason
   * rather than sent and refused there, because the person is looking at the
   * field.
   */
  const commitOpacity = (index: number, raw: string) => {
    if (raw.trim().length === 0) return;
    const asked = Number(raw);
    if (usableOpacity(asked) === null) {
      setSizeError(`An opacity is between ${OPACITY_MIN} and ${OPACITY_MAX} percent. ${raw} is not.`);
      return;
    }
    setSizeError(null);
    const held = current()[index];
    if (held === undefined || !isImageSlot(held) || asked === held.opacity) return;
    replaceImage(index, { opacity: asked });
  };

  /**
   * Commit a size. Refused here with its reason rather than sent and refused
   * there, `commitBpm`'s rule: the person is looking at the field. The server
   * refuses it as well — this is the half that explains.
   */
  const commitSize = (index: number, raw: string) => {
    const asked = Number(raw);
    if (raw.trim().length === 0) return;
    if (usableSize(asked) === null) {
      setSizeError(`A size is between ${SIZE_MIN} and ${SIZE_MAX} percent of the picture's height. ${raw} is not.`);
      return;
    }
    setSizeError(null);
    const held = current()[index];
    if (held === undefined || asked === held.size) return;
    if (isImageSlot(held)) replaceImage(index, { size: asked });
    else replaceText(index, { size: asked });
  };

  return (
    <div className="overlay-editor" data-testid="overlay-editor">
      <h4>overlays</h4>
      <div className="playlist-name">
        <input
          aria-label="stream title"
          maxLength={TEXT_MAX}
          disabled={!editable}
          value={titleDraft ?? world.title ?? ""}
          placeholder="stream title"
          onChange={(e) => setTitleDraft(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitTitle();
          }}
        />
      </div>
      <p className="muted">
        What labels the show. Drawn by a slot whose source is the stream title; empty draws nothing.
      </p>
      {refusal("set-world-title") && (
        <p className="warn" data-testid="overlay-title-error">
          {refusal("set-world-title")}
        </p>
      )}

      <ul className="clip-set overlay-slots" data-testid="overlay-slots">
        {slots.length === 0 && <li className="muted">No slots. Nothing is drawn over the picture.</li>}
        {slots.map((slot, index) => {
          // The *cleaned* slot, not the raw one. A manifest is hand-editable, so
          // `slot.image` can be a number, and `(slot.image ?? "").trim()` on one
          // throws — taking /live's whole main view down to the error boundary
          // because one row of one editor read a field it had not checked. Every
          // read below goes through `cleaned`, which is the shape the guard
          // vouched for, or through a check that tolerates anything.
          const cleaned = cleanSlot(slot);
          const broken = cleaned === null;
          // A row with no picture yet is not damaged — the guard accepts it and
          // it simply draws nothing, the rule a caption with no words keeps. It
          // still needs saying apart from a row that names something, because
          // "no image chosen" invites a click and a filename does not. A row the
          // guard *does* refuse gets the damage warning below.
          // Unfilled means *only* that a picture has not been chosen yet, on a
          // slot that is otherwise sound. One also broken for another reason —
          // a hand-edited size — is still broken and must still say so, or the
          // next edit drops the row with no explanation.
          const unfilled = cleaned !== null && isImageSlot(cleaned) && cleaned.image === undefined;
          return (
            <li
              key={index}
              data-testid={`overlay-slot-${index}`}
              className={broken ? "overlay-slot-row overlay-slot-unusable" : "overlay-slot-row"}
            >
              {broken && (
                <p className="warn" data-testid={`overlay-slot-${index}-unusable`}>
                  This slot cannot be drawn as stored and will be dropped by the next edit.
                </p>
              )}
              <div className="overlay-slot-line">
                <select
                  aria-label={`position for slot ${index + 1}`}
                  value={slot.position}
                  disabled={!editable}
                  onChange={(e) => {
                    const position = e.target.value as OverlayPosition;
                    if (isImageSlot(slot)) replaceImage(index, { position });
                    else replaceText(index, { position });
                  }}
                >
                  {POSITIONS.map((position) => (
                    <option key={position} value={position}>
                      {position.replace("-", " ")}
                    </option>
                  ))}
                </select>
                {isImageSlot(slot) ? (
                  <>
                    <span className="overlay-image-name" data-testid={`overlay-slot-${index}-image`}>
                      {cleaned !== null && isImageSlot(cleaned) && cleaned.image !== undefined ? cleaned.image : "no image chosen"}
                    </span>
                    <button
                      className="ghost"
                      aria-label={`choose image for slot ${index + 1}`}
                      disabled={!editable}
                      onClick={() => setPicking(picking === index ? null : index)}
                    >
                      browse
                    </button>
                  </>
                ) : (
                  <>
                    <select
                      aria-label={`source for slot ${index + 1}`}
                      value={slot.source}
                      disabled={!editable}
                      onChange={(e) => {
                        const source = e.target.value as OverlaySource;
                        replaceText(index, source === "text" ? { source } : { source, text: undefined });
                      }}
                    >
                      {SOURCES.map((source) => (
                        <option key={source} value={source}>
                          {SOURCE_LABELS[source]}
                        </option>
                      ))}
                    </select>
                    {slot.source === "text" && (
                      <input
                        aria-label={`text for slot ${index + 1}`}
                        maxLength={TEXT_MAX}
                        disabled={!editable}
                        value={textDrafts[index] ?? slot.text ?? ""}
                        placeholder="fixed text"
                        onChange={(e) => setTextDrafts((held) => ({ ...held, [index]: e.target.value }))}
                        onBlur={() => commitText(index)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitText(index);
                        }}
                      />
                    )}
                  </>
                )}
              </div>
              <div className="overlay-slot-line">
                {!isImageSlot(slot) && (
                  <FontField
                    label={`font for slot ${index + 1}`}
                    value={slot.font}
                    disabled={!editable}
                    onChange={(font) => replaceText(index, { font })}
                  />
                )}
                <SizeField
                  label={`size for slot ${index + 1}`}
                  value={slot.size}
                  disabled={!editable}
                  onCommit={(raw) => commitSize(index, raw)}
                />
                <span className="muted">% of height</span>
                {isImageSlot(slot) && (
                  <>
                    <SizeField
                      label={`opacity for slot ${index + 1}`}
                      value={slot.opacity ?? OPACITY_MAX}
                      min={OPACITY_MIN}
                      max={OPACITY_MAX}
                      step={5}
                      disabled={!editable}
                      onCommit={(raw) => commitOpacity(index, raw)}
                    />
                    <span className="muted">% opaque</span>
                  </>
                )}
                <button
                  className="ghost"
                  aria-label={`move slot ${index + 1} up`}
                  disabled={!editable || index === 0}
                  onClick={() => move(index, -1)}
                >
                  ↑
                </button>
                <button
                  className="ghost"
                  aria-label={`move slot ${index + 1} down`}
                  disabled={!editable || index === slots.length - 1}
                  onClick={() => move(index, 1)}
                >
                  ↓
                </button>
                <button
                  className="ghost"
                  aria-label={`remove slot ${index + 1}`}
                  disabled={!editable}
                  onClick={() => {
                    // Same reason as `move`: every later row's index shifts, so
                    // an open picker or `when` panel would be editing a
                    // different slot than the one it is drawn against.
                    setPicking(null);
                    setOpenWhen(new Set());
                    setOpenTreatment(new Set());
                    write(current().filter((_, i) => i !== index));
                  }}
                >
                  remove
                </button>
              </div>
              {editable && !isImageSlot(slot) && (
                <ColorField
                  label={`colour for slot ${index + 1}`}
                  value={slot.color}
                  onChange={(color) => replaceText(index, { color })}
                />
              )}
              {picking === index && (
                <ImagePicker
                  state={state}
                  send={send}
                  worldId={world.id}
                  slot={index}
                  onClose={() => setPicking(null)}
                />
              )}
              {!isImageSlot(slot) && (
                <TreatmentField
                  index={index}
                  slot={cleaned !== null && !isImageSlot(cleaned) ? cleaned : slot}
                  editable={editable}
                  open={openTreatment.has(index)}
                  onToggle={() =>
                    setOpenTreatment((held) => {
                      const now = new Set(held);
                      if (now.has(index)) now.delete(index);
                      else now.add(index);
                      return now;
                    })
                  }
                  onChange={(over) => setTreatment(index, over)}
                  onError={setSizeError}
                />
              )}
              <WhenField
                index={index}
                slot={cleaned}
                raw={slot}
                world={world}
                editable={editable}
                open={openWhen.has(index)}
                onToggle={() =>
                  setOpenWhen((held) => {
                    const now = new Set(held);
                    if (now.has(index)) now.delete(index);
                    else now.add(index);
                    return now;
                  })
                }
                showing={cleaned === null || !watching ? null : slotDrawn(cleaned, liveStateId, liveValues)}
                onChange={(over) => setSlotFields(index, over)}
              />
            </li>
          );
        })}
      </ul>
      {sizeError && (
        <p className="warn" data-testid="overlay-size-error">
          {sizeError}
        </p>
      )}
      {refusal("set-world-overlays") && (
        <p className="warn" data-testid="overlay-slots-error">
          {refusal("set-world-overlays")}
        </p>
      )}
      {slots.length >= MAX_OVERLAYS && (
        <p className="muted" data-testid="overlay-slots-full">
          A World holds at most {MAX_OVERLAYS} slots.
        </p>
      )}
      {refusal("import-overlay-image") && (
        <p className="warn" data-testid="overlay-image-error">
          {refusal("import-overlay-image")}
        </p>
      )}
      <button
        data-testid="add-overlay-slot"
        disabled={!editable || slots.length >= MAX_OVERLAYS}
        onClick={() =>
          write([
            ...current(),
            {
              position: "bottom-center",
              source: "text",
              text: "",
              font: firstFont(slots),
              size: 4,
              color: "#ffffff",
            },
          ])
        }
      >
        add text slot
      </button>
      {/* A second button rather than a kind dropdown on a row: switching a
          slot's kind would have to decide what becomes of the fields of the
          kind being left, and neither answer is one an operator asked for. The
          row lands empty and says so — see the note on `unfilled`. */}
      <button
        data-testid="add-overlay-image-slot"
        disabled={!editable || slots.length >= MAX_OVERLAYS}
        onClick={() =>
          write([...current(), { kind: "image", position: "top-right", size: 6 }])
        }
      >
        add image slot
      </button>
      <p className="muted">
        Where a line goes, what it says, and how it looks. Size is a share of the picture's height,
        so the small player and the output draw the same proportions. The words a playlist and its
        tracks carry are set in the playlist editor. Images always draw beneath text, whatever the
        order here — moving a slot orders it among others of its own kind.
      </p>
    </div>
  );
}

/**
 * What one edit to a treatment says.
 *
 * A *patch* rather than a replacement: the panel sends the one number that
 * changed, and it is merged where the merge can see the current slot. A whole
 * object built in the panel would be built from props, which are the last list
 * *received* — so two quick edits would land the second on top of a slot that
 * had never seen the first.
 *
 * `null` rather than `undefined` for "off", because `undefined` is what a
 * `Partial` means by "not mentioned", and the two must differ here: one removes
 * the key, the other leaves it alone.
 */
interface TreatmentEdit {
  outline?: Partial<TextOutline> | null;
  shadow?: Partial<TextShadow> | null;
  band?: boolean;
}

/**
 * One slot with its treatment changed, keeping the slot's own kind.
 *
 * `held` is what the patch merges onto — the cleaned slot, so the values are
 * the ones the panel is showing. `slot` is what the result is built from, so
 * nothing else about it moves.
 *
 * `withWhen`'s shape otherwise: an off value deletes the key rather than
 * storing a disabled object, so the canonical form of an untreated slot stays
 * the one every existing manifest already has.
 */
function withTreatment<T extends TextSlot>(slot: T, held: TextSlot, over: TreatmentEdit): T {
  // Every treatment `held` carries is materialised first, and only then is the
  // patch applied. The two fields the operator did not touch have to be written
  // out here or they leave with the key that produced them: a translated
  // `backing` exists only in `held`, and the `delete` at the end of this
  // function removes the thing it was translated from. Ticking outline on a
  // slot storing `backing: "band"` sent an outline and no band.
  const next: T = {
    ...slot,
    ...(held.outline === undefined ? {} : { outline: held.outline }),
    ...(held.shadow === undefined ? {} : { shadow: held.shadow }),
    ...(held.band === undefined ? {} : { band: held.band }),
  };
  if (over.outline !== undefined) {
    if (over.outline === null) delete next.outline;
    else next.outline = { ...(held.outline ?? DEFAULT_OUTLINE), ...over.outline };
  }
  if (over.shadow !== undefined) {
    if (over.shadow === null) delete next.shadow;
    else next.shadow = { ...(held.shadow ?? DEFAULT_SHADOW), ...over.shadow };
  }
  if (over.band !== undefined) {
    if (over.band) next.band = true;
    else delete next.band;
  }
  // Any authored edit retires the legacy key, which is off the type and can
  // only be here by a hand edit or an agent. Without this, clearing the band on
  // a slot storing `backing: "band"` would delete a key the guard puts straight
  // back, and the checkbox would do nothing at all.
  delete (next as Record<string, unknown>).backing;
  return next;
}

/**
 * How one slot's words are treated: a border, a cast shadow, a plate.
 *
 * Behind a disclosure and collapsed always, `WhenField`'s reason: a row already
 * carries two control lines, a colour, a font and a size, times up to
 * `MAX_OVERLAYS` of them, and a feature most slots will never use may not grow
 * every one of those.
 *
 * Switching a treatment on writes `DEFAULT_OUTLINE` or `DEFAULT_SHADOW` rather
 * than an empty object, because a control that writes nothing visible reads as
 * broken.
 *
 * The two colour pickers sit at the bottom. Each renders a swatch palette and a
 * custom picker, so putting them above the numbers would push the fields an
 * operator adjusts repeatedly below two palettes.
 *
 * Every number commits on blur or Enter and is refused here with its reason
 * rather than sent and refused there — `commitSize`'s rule, because the person
 * is looking at the field.
 */
function TreatmentField({
  index,
  slot,
  editable,
  open,
  onToggle,
  onChange,
  onError,
}: {
  index: number;
  slot: TextSlot;
  editable: boolean;
  open: boolean;
  onToggle: () => void;
  onChange: (over: TreatmentEdit) => void;
  onError: (message: string | null) => void;
}) {
  const owner = `slot ${index + 1}`;
  // Read through the guard rather than off the slot. This panel is handed the
  // *stored* slot when the guard refuses the row — that is what lets a refused
  // row still be repaired — so `slot.shadow` can be any shape a hand edit or an
  // agent put there, and `shadow !== undefined` was true for a stored `null`,
  // which then threw on `shadow.angle` and took the whole editor down. A value
  // the guard would refuse is drawn as absent, and ticking the box replaces it.
  const outline = cleanOutline(slot.outline) ?? undefined;
  const shadow = cleanShadow(slot.shadow) ?? undefined;
  const says = outline !== undefined || shadow !== undefined || slot.band === true;

  /** A number inside its band, or a refusal naming the band it is outside. */
  const commit = (raw: string, min: number, max: number, noun: string, apply: (value: number) => void) => {
    if (raw.trim().length === 0) return;
    const asked = Number(raw);
    if (!(Number.isFinite(asked) && asked >= min && asked <= max)) {
      onError(`${noun} is between ${min} and ${max}. ${raw} is not.`);
      return;
    }
    onError(null);
    apply(asked);
  };

  return (
    <div className="overlay-treatment">
      <button
        className="ghost"
        aria-expanded={open}
        aria-label={`treatment for ${owner}`}
        data-testid={`overlay-treatment-${index}`}
        onClick={onToggle}
      >
        treatment{says ? "" : " — none"}
      </button>
      {open && (
        <div className="overlay-treatment-body">
          <label className="overlay-treatment-toggle">
            <input
              type="checkbox"
              aria-label={`band for ${owner}`}
              disabled={!editable}
              checked={slot.band === true}
              onChange={(e) => onChange({ band: e.target.checked })}
            />
            band — a plate behind the words
          </label>

          <div className="overlay-treatment-group">
            <label className="overlay-treatment-toggle">
              <input
                type="checkbox"
                aria-label={`outline for ${owner}`}
                disabled={!editable}
                checked={outline !== undefined}
                onChange={(e) => onChange({ outline: e.target.checked ? DEFAULT_OUTLINE : null })}
              />
              outline — a border around the letters
            </label>
            {outline !== undefined && (
              <div className="overlay-treatment-fields">
              <label className="overlay-treatment-number">
                <span className="overlay-treatment-name">width</span>
                <SizeField
                  label={`outline width for ${owner}`}
                  value={outline.width}
                  disabled={!editable}
                  min={OUTLINE_WIDTH_MIN}
                  max={OUTLINE_WIDTH_MAX}
                  step={1}
                  onCommit={(raw) =>
                    commit(raw, OUTLINE_WIDTH_MIN, OUTLINE_WIDTH_MAX, "An outline width", (width) =>
                      onChange({ outline: { width } }),
                    )
                  }
                />
                <span className="muted">% of type size</span>
              </label>
                <ColorField
                  label={`outline colour for ${owner}`}
                  value={outline.color}
                  onChange={(color) => onChange({ outline: { color } })}
                />
              </div>
            )}
          </div>

          <div className="overlay-treatment-group">
            <label className="overlay-treatment-toggle">
              <input
                type="checkbox"
                aria-label={`shadow for ${owner}`}
                disabled={!editable}
                checked={shadow !== undefined}
                onChange={(e) => onChange({ shadow: e.target.checked ? DEFAULT_SHADOW : null })}
              />
              shadow — a mark cast by the letters
            </label>
            {shadow !== undefined && (
              <div className="overlay-treatment-fields">
              <label className="overlay-treatment-number">
                <span className="overlay-treatment-name">angle</span>
                <SizeField
                  label={`shadow angle for ${owner}`}
                  value={shadow.angle}
                  disabled={!editable}
                  min={SHADOW_ANGLE_MIN}
                  max={SHADOW_ANGLE_MAX}
                  step={5}
                  onCommit={(raw) =>
                    commit(raw, SHADOW_ANGLE_MIN, SHADOW_ANGLE_MAX, "An angle", (angle) =>
                      onChange({ shadow: { angle } }),
                    )
                  }
                />
                <span className="muted">° clockwise from up</span>
              </label>
              <label className="overlay-treatment-number">
                <span className="overlay-treatment-name">distance</span>
                <SizeField
                  label={`shadow distance for ${owner}`}
                  value={shadow.distance}
                  disabled={!editable}
                  min={SHADOW_DISTANCE_MIN}
                  max={SHADOW_DISTANCE_MAX}
                  step={1}
                  onCommit={(raw) =>
                    commit(raw, SHADOW_DISTANCE_MIN, SHADOW_DISTANCE_MAX, "A distance", (distance) =>
                      onChange({ shadow: { distance } }),
                    )
                  }
                />
                <span className="muted">% of type size — how far it is thrown; 0 casts evenly</span>
              </label>
              <label className="overlay-treatment-number">
                <span className="overlay-treatment-name">blur</span>
                <SizeField
                  label={`shadow blur for ${owner}`}
                  value={shadow.blur}
                  disabled={!editable}
                  min={SHADOW_BLUR_MIN}
                  max={SHADOW_BLUR_MAX}
                  step={1}
                  onCommit={(raw) =>
                    commit(raw, SHADOW_BLUR_MIN, SHADOW_BLUR_MAX, "A blur", (blur) =>
                      onChange({ shadow: { blur } }),
                    )
                  }
                />
                {/* The one an operator hunts for and does not find. A text
                    shadow has offset and blur and no third dimension — CSS
                    gives `box-shadow` a spread radius and `text-shadow` none —
                    so this *is* the size dial, and saying only "blur" sent the
                    first person to use it to the distance field instead. */}
                <span className="muted">% of type size — how large the shadow reads</span>
              </label>
              <label className="overlay-treatment-number">
                <span className="overlay-treatment-name">opacity</span>
                <SizeField
                  label={`shadow opacity for ${owner}`}
                  value={shadow.opacity ?? OPACITY_MAX}
                  disabled={!editable}
                  min={OPACITY_MIN}
                  max={OPACITY_MAX}
                  step={5}
                  onCommit={(raw) =>
                    commit(raw, OPACITY_MIN, OPACITY_MAX, "An opacity", (opacity) =>
                      onChange({ shadow: { opacity } }),
                    )
                  }
                />
                <span className="muted">% opaque</span>
              </label>
                <ColorField
                  label={`shadow colour for ${owner}`}
                  value={shadow.color}
                  onChange={(color) => onChange({ shadow: { color } })}
                />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The first slot's family, for a newly added slot to match.
 *
 * Reads only text slots: a picture has no font, and `slots[0]?.font` stopped
 * compiling the moment a list could begin with one.
 */
function firstFont(slots: readonly OverlaySlot[]): string {
  for (const slot of slots) if (!isImageSlot(slot)) return slot.font;
  return DEFAULT_FONT;
}

/**
 * A family chosen from a list, that never loses one chosen elsewhere.
 *
 * The list is what is offered. What is *kept* is whatever the slot already
 * holds — so a family a hand edit, an agent, or an older build put there is
 * injected as an option for this row alone, and the control's value equals the
 * stored value. Without that the browser reports the first option instead, and
 * the next `{ ...slot, color }` spread writes that family to disk: editing a
 * colour would silently change a font. That is the exact failure recorded in
 * docs/solutions/a-fix-to-what-a-picker-offers-is-not-a-fix-to-what-it-keeps.md,
 * one feature earlier, and the reason this control is a component with a note
 * rather than four lines inline.
 */
function FontField({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  disabled?: boolean;
  onChange: (font: string) => void;
}) {
  const offered = FONTS.includes(value) ? FONTS : [value, ...FONTS];
  return (
    <select
      aria-label={label}
      className="overlay-font"
      value={value}
      disabled={disabled}
      onChange={(e) => {
        if (e.target.value !== value) onChange(e.target.value);
      }}
    >
      {offered.map((font) => (
        <option key={font} value={font}>
          {font}
        </option>
      ))}
    </select>
  );
}

/**
 * A size field that commits on blur or Enter rather than per keystroke.
 *
 * `LiveNumberField` commits as it is typed, which is right for a Parameter and
 * wrong here: typing "12" would send 1 and then 12, and the first is a slot
 * one-twelfth the size for a frame.
 */
function SizeField({
  label,
  value,
  disabled,
  onCommit,
  min = SIZE_MIN,
  max = SIZE_MAX,
  step = 0.5,
}: {
  label: string;
  value: number;
  disabled?: boolean;
  onCommit: (raw: string) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  const [typing, setTyping] = useState<string | null>(null);
  const commit = () => {
    if (typing === null) return;
    const raw = typing;
    setTyping(null);
    onCommit(raw);
  };
  return (
    <input
      type="number"
      className="overlay-size"
      aria-label={label}
      value={typing ?? value}
      step={step}
      min={min}
      max={max}
      disabled={disabled}
      onChange={(e) => setTyping(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
      }}
    />
  );
}

/**
 * One slot with its "when" changed, keeping the slot's own kind.
 *
 * Generic over the slot rather than routed through `Record<string, unknown>` and
 * cast back: both kinds extend `SlotWhen`, so this compiles with no cast at all
 * and the compiler still catches a typo in one of the three field names — which
 * a double cast at exactly the point the kind matters would have swallowed.
 *
 * An empty value removes the key rather than writing `[]` or `0`. `write` sends
 * the list unfiltered — it filters which *slots* go, not what is inside them —
 * so leaving an empty array for the server's guard to drop would put one on the
 * wire, and the canonical form of "always drawn" is the one every existing
 * manifest already has.
 */
function withWhen<T extends OverlaySlot>(slot: T, over: Partial<SlotWhen>): T {
  const next: T = { ...slot, ...over };
  if (over.states !== undefined && over.states.length === 0) delete next.states;
  if (over.conditions !== undefined && over.conditions.length === 0) delete next.conditions;
  if (over.fadeMs !== undefined && over.fadeMs <= 0) delete next.fadeMs;
  return next;
}

/**
 * The "when" of one slot: the States it is drawn in, the clauses that must
 * hold, how long it takes to arrive, and whether it is on screen right now.
 *
 * Behind a disclosure, and collapsed unless the slot already says something,
 * because the common case is a slot that is always drawn and a row that grew
 * four controls for it would cost every World that never uses this.
 *
 * The mark is the part that is not obvious. A slot that is not showing looks
 * exactly like one that is unfilled, one the guard refused, and one on a page
 * that has not been told where the machine is — the picture cannot tell them
 * apart, and before this the operator's only recourse was to open the projector
 * and guess. It says which half said no, because "not in this State" and "a
 * clause does not hold" send you to different controls.
 *
 * The clear controls exist for a slot the guard refuses. `write` drops a
 * refused slot rather than sending it, so a manifest hand-written with one bad
 * clause would lose that slot's words, font, position and picture on the next
 * edit to any *other* slot. Clearing the offending key keeps the rest of the
 * operator's work — see
 * docs/solutions/a-lenient-load-and-a-strict-write-need-a-filter-between-them.md.
 */
function WhenField({
  index,
  slot,
  raw,
  world,
  editable,
  open,
  onToggle,
  showing,
  onChange,
}: {
  index: number;
  /** The cleaned slot, or null when the guard refuses this row. */
  slot: OverlaySlot | null;
  /** The slot as stored, so a refused row can be asked what clearing would fix. */
  raw: OverlaySlot;
  world: World;
  editable: boolean;
  open: boolean;
  onToggle: () => void;
  showing: { drawn: true } | { drawn: false; because: "state" | "clause" } | null;
  onChange: (over: Partial<SlotWhen>) => void;
}) {
  const states = slot?.states ?? [];
  const conditions = slot?.conditions ?? [];
  const fadeMs = slot?.fadeMs ?? 0;
  const says = states.length > 0 || conditions.length > 0 || fadeMs > 0;
  const owner = `slot ${index + 1}`;

  const mark =
    showing === null
      ? null
      : showing.drawn
        ? "showing"
        : showing.because === "state"
          ? "not showing — another State"
          : "not showing — a clause does not hold";

  return (
    <div className="overlay-when">
      <button
        className="ghost"
        aria-expanded={open}
        aria-label={`when for ${owner}`}
        data-testid={`overlay-when-${index}`}
        onClick={onToggle}
      >
        when{says ? "" : " — always"}
      </button>
      {mark && (
        <span className="muted" data-testid={`overlay-showing-${index}`}>
          {mark}
        </span>
      )}
      {open && (
        <div className="overlay-when-body">
          {slot === null ? (
            (() => {
              // Whether clearing *this* key is what would make the row readable
              // again — asked rather than assumed. `write` drops any slot the
              // strict guard still refuses, so offering a clear that does not
              // fix the refusal is offering to delete the slot's words, font,
              // position and picture, which is the opposite of what the line
              // below promises.
              const fixes = (over: Partial<SlotWhen>) => cleanSlot(withWhen(raw, over)) !== null;
              const byConditions = fixes({ conditions: [] });
              const byStates = fixes({ states: [] });
              return (
                <>
                  <p className="muted">
                    {byConditions || byStates
                      ? "This slot cannot be read as stored. Clearing what broke it keeps the rest of the slot."
                      : "This slot cannot be read as stored, and not because of its states or conditions — clearing either would not bring it back, so neither is offered. Fix it in the manifest."}
                  </p>
                  {byConditions && (
                    <button className="ghost" disabled={!editable} onClick={() => onChange({ conditions: [] })}>
                      clear conditions
                    </button>
                  )}
                  {byStates && (
                    <button className="ghost" disabled={!editable} onClick={() => onChange({ states: [] })}>
                      clear states
                    </button>
                  )}
                </>
              );
            })()
          ) : (
            <>
              <h4>states</h4>
              <p className="muted">
                {states.length === 0
                  ? "None — drawn in every State."
                  : "Drawn only while the machine is in one of these."}
              </p>
              <div className="overlay-when-states">
                {world.states.map((held) => (
                  <label key={held.id}>
                    <input
                      type="checkbox"
                      aria-label={`state ${held.name} for ${owner}`}
                      disabled={!editable}
                      checked={states.includes(held.id)}
                      onChange={(e) =>
                        onChange({
                          states: e.target.checked
                            ? [...states, held.id]
                            : states.filter((id) => id !== held.id),
                        })
                      }
                    />
                    {held.name}
                  </label>
                ))}
                {/* A State this World no longer holds is still the operator's
                    work: shown, checked, and removable, rather than dropped on
                    the next edit with nothing said. `danglingSlotStates` is
                    what says so in the reports. */}
                {states
                  .filter((id) => !world.states.some((held) => held.id === id))
                  .map((id) => (
                    <label key={id} className="warn">
                      <input
                        type="checkbox"
                        aria-label={`missing state ${id} for ${owner}`}
                        disabled={!editable}
                        checked
                        onChange={() => onChange({ states: states.filter((held) => held !== id) })}
                      />
                      {id} (gone)
                    </label>
                  ))}
              </div>
              <h4>conditions</h4>
              <ConditionRows
                conditions={conditions}
                world={world}
                editable={editable}
                owner={owner}
                emptyLabel="None — drawn whenever its States allow."
                max={MAX_SLOT_CONDITIONS}
                onChange={(next) => onChange({ conditions: next })}
              />
              <label className="overlay-when-fade">
                fade (ms)
                <SizeField
                  label={`fade for ${owner}`}
                  value={fadeMs}
                  disabled={!editable}
                  min={0}
                  max={MAX_OVERLAY_FADE_MS}
                  step={50}
                  onCommit={(raw) => {
                    const asked = Number(raw);
                    // Refused rather than clamped, the rule every other number
                    // on this row keeps. Zero is a cut and removes the key.
                    if (!Number.isFinite(asked) || asked < 0 || asked > MAX_OVERLAY_FADE_MS) return;
                    onChange({ fadeMs: asked });
                  }}
                />
              </label>
            </>
          )}
        </div>
      )}
    </div>
  );
}
