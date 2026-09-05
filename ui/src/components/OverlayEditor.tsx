import { useEffect, useRef, useState } from "react";
import type { ClientMessage, World } from "../../../shared/src/types";
import {
  MAX_OVERLAYS,
  POSITIONS,
  SIZE_MAX,
  SIZE_MIN,
  SOURCES,
  TEXT_MAX,
  FONT_MAX,
  cleanSlot,
  slotsOf,
  usableSize,
  type OverlayPosition,
  type OverlaySlot,
  type OverlaySource,
} from "../../../shared/src/overlays";
import { ColorField } from "./ColorField";

interface Props {
  world: World;
  editable: boolean;
  send: (msg: ClientMessage) => void;
  /** Why the last title or slot write was refused, by action, or null. */
  refusal: (action: "set-world-title" | "set-world-overlays") => string | null;
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
export function OverlayEditor({ world, editable, send, refusal }: Props) {
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
  const [fontDrafts, setFontDrafts] = useState<Record<number, string>>({});
  /** Why the last size edit was refused. One at a time: only one is being typed. */
  const [sizeError, setSizeError] = useState<string | null>(null);

  /**
   * Send the whole next list.
   *
   * A stored slot the strict guard refuses — a hand-edited `size: 30` — is
   * dropped here rather than sent: the server refuses a list whole, so one bad
   * neighbour would otherwise make every edit to a good slot fail. It is
   * already skipped where it is drawn, so dropping it on the next authored
   * edit loses nothing the output showed.
   */
  const write = (next: readonly OverlaySlot[]) => {
    // Remembered unfiltered, so the indices the rows on screen still carry —
    // the broadcast has not landed — keep meaning the same slots.
    latest.current = next;
    const usable = next.filter((slot) => cleanSlot(slot) !== null);
    send({ type: "set-world-overlays", worldId: world.id, overlays: [...usable] });
  };

  const replace = (index: number, over: Partial<OverlaySlot>) =>
    write(current().map((slot, i) => (i === index ? { ...slot, ...over } : slot)));

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
    const asked = draft.trim();
    if (asked === (slots[index]?.text ?? "")) return;
    replace(index, asked.length === 0 ? { text: undefined } : { text: asked });
  };

  const commitFont = (index: number) => {
    const draft = fontDrafts[index];
    if (draft === undefined) return;
    setFontDrafts((held) => {
      const { [index]: _done, ...rest } = held;
      return rest;
    });
    const asked = draft.trim();
    if (asked.length === 0 || asked === slots[index]?.font) return;
    replace(index, { font: asked });
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
    if (asked === slots[index]?.size) return;
    replace(index, { size: asked });
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
        {slots.map((slot, index) => (
          <li
            key={index}
            data-testid={`overlay-slot-${index}`}
            className={cleanSlot(slot) === null ? "overlay-slot-row overlay-slot-unusable" : "overlay-slot-row"}
          >
            {cleanSlot(slot) === null && (
              <p className="warn" data-testid={`overlay-slot-${index}-unusable`}>
                This slot cannot be drawn as stored and will be dropped by the next edit.
              </p>
            )}
            <div className="overlay-slot-line">
              <select
                aria-label={`position for slot ${index + 1}`}
                value={slot.position}
                disabled={!editable}
                onChange={(e) => replace(index, { position: e.target.value as OverlayPosition })}
              >
                {POSITIONS.map((position) => (
                  <option key={position} value={position}>
                    {position.replace("-", " ")}
                  </option>
                ))}
              </select>
              <select
                aria-label={`source for slot ${index + 1}`}
                value={slot.source}
                disabled={!editable}
                onChange={(e) => {
                  const source = e.target.value as OverlaySource;
                  replace(index, source === "text" ? { source } : { source, text: undefined });
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
            </div>
            <div className="overlay-slot-line">
              <input
                aria-label={`font for slot ${index + 1}`}
                className="overlay-font"
                maxLength={FONT_MAX}
                disabled={!editable}
                value={fontDrafts[index] ?? slot.font}
                onChange={(e) => setFontDrafts((held) => ({ ...held, [index]: e.target.value }))}
                onBlur={() => commitFont(index)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitFont(index);
                }}
              />
              <SizeField
                label={`size for slot ${index + 1}`}
                value={slot.size}
                disabled={!editable}
                onCommit={(raw) => commitSize(index, raw)}
              />
              <span className="muted">% of height</span>
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
            {editable && (
              <ColorField
                label={`colour for slot ${index + 1}`}
                value={slot.color}
                onChange={(color) => replace(index, { color })}
              />
            )}
          </li>
        ))}
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
      <button
        data-testid="add-overlay-slot"
        disabled={!editable || slots.length >= MAX_OVERLAYS}
        onClick={() =>
          write([
            ...current(),
            { position: "bottom-center", source: "text", text: "", font: slots[0]?.font ?? "Segoe UI", size: 4, color: "#ffffff" },
          ])
        }
      >
        add slot
      </button>
      <p className="muted">
        Where a line goes, what it says, and how it looks. Size is a share of the picture's height,
        so the small player and the output draw the same proportions. The words a playlist and its
        tracks carry are set in the playlist editor.
      </p>
    </div>
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
}: {
  label: string;
  value: number;
  disabled?: boolean;
  onCommit: (raw: string) => void;
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
      step={0.5}
      min={SIZE_MIN}
      max={SIZE_MAX}
      disabled={disabled}
      onChange={(e) => setTyping(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
      }}
    />
  );
}
