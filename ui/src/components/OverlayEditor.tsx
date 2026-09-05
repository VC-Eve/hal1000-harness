import { useEffect, useRef, useState } from "react";
import type { ClientMessage, World } from "../../../shared/src/types";
import {
  FONTS,
  MAX_OVERLAYS,
  OPACITY_MAX,
  OPACITY_MIN,
  POSITIONS,
  SIZE_MAX,
  SIZE_MIN,
  SOURCES,
  TEXT_MAX,
  DEFAULT_FONT,
  cleanSlot,
  isImageSlot,
  slotsOf,
  usableOpacity,
  usableSize,
  type ImageSlot,
  type OverlayPosition,
  type OverlaySlot,
  type OverlaySource,
  type TextSlot,
} from "../../../shared/src/overlays";
import type { AppState } from "../store";
import { ColorField } from "./ColorField";
import { ImagePicker } from "./ImagePicker";

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

  const move = (index: number, delta: number) => {
    const list = current();
    const to = index + delta;
    if (to < 0 || to >= list.length) return;
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
    const held = slots[index];
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
    const held = slots[index];
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
    const held = slots[index];
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
          const broken = cleanSlot(slot) === null;
          // A picture row has two states the guard cannot tell apart and this
          // editor must: one just added and not yet filled, and one whose file
          // the World no longer holds. Both are refused. Showing the damage
          // warning on the first makes an operator's first act on this feature
          // look like an error they caused.
          const unfilled = isImageSlot(slot) && slot.image.trim().length === 0;
          return (
            <li
              key={index}
              data-testid={`overlay-slot-${index}`}
              className={broken && !unfilled ? "overlay-slot-row overlay-slot-unusable" : "overlay-slot-row"}
            >
              {broken && !unfilled && (
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
                      {unfilled ? "no image chosen" : slot.image}
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
                  onClick={() => write(current().filter((_, i) => i !== index))}
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
          write([...current(), { kind: "image", position: "top-right", image: "", size: 6 }])
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
