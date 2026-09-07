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
  type SlotWhen,
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
    write(
      current().map((slot, i) => {
        if (i !== index) return slot;
        const next: Record<string, unknown> = { ...slot, ...over };
        if (over.states !== undefined && over.states.length === 0) delete next.states;
        if (over.conditions !== undefined && over.conditions.length === 0) delete next.conditions;
        if (over.fadeMs !== undefined && over.fadeMs <= 0) delete next.fadeMs;
        return next as unknown as OverlaySlot;
      }),
    );

  const move = (index: number, delta: number) => {
    const list = current();
    const to = index + delta;
    if (to < 0 || to >= list.length) return;
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
                    setPicking(null);
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
              <WhenField
                index={index}
                slot={cleaned}
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
            <>
              <p className="muted">
                This slot cannot be read as stored, so there is nothing to edit here. Clearing one of these
                keeps the rest of the slot.
              </p>
              <button className="ghost" disabled={!editable} onClick={() => onChange({ conditions: [] })}>
                clear conditions
              </button>
              <button className="ghost" disabled={!editable} onClick={() => onChange({ states: [] })}>
                clear states
              </button>
            </>
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
