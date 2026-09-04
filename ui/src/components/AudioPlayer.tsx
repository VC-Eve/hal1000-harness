import { useEffect, useRef, useState } from "react";
import type { ClientMessage, TransportState } from "../../../shared/src/types";
import type { AppState } from "../store";

interface Props {
  state: AppState;
  send: (msg: ClientMessage) => void;
}

/** Where the bytes come from. A query parameter, so a store path is never a URL segment. */
export function trackUrl(path: string): string {
  return `/api/live/audio?track=${encodeURIComponent(path)}`;
}

/** How far off a stored length has to be before it is worth correcting. `ClipPlayer`'s number. */
const DURATION_TOLERANCE_MS = 150;

/** How often the sounding client tells the server where it actually is. */
const REPORT_INTERVAL_MS = 1_000;

const BLOCKED = "This browser will not start the sound until you ask it to.";
const UNREADABLE = "This browser could not play that track's bytes.";

/**
 * The loudspeaker.
 *
 * One `<audio>` element, and a great deal of care about who is allowed to own
 * it. Three things make this different from `ClipPlayer`, which is otherwise its
 * model:
 *
 * **It is not muted.** `ClipPlayer` mutes both `<video>` elements, which is why
 * clips autoplay at all — a browser blocks `play()` on an unmuted element until
 * the page has a user activation. Muting is not available here, so the gesture
 * is a real gate rather than a formality (origin R5): a World that starts before
 * one arms its playlist without advancing it, this pane offers a control to
 * enable sound, and the armed playlist begins on the click.
 *
 * **Exactly one client owns it** (origin R6). The server elects, and says so per
 * socket in `audio-authority`. A client that is not the authority renders the
 * transport read-only, sounds nothing and sends nothing — every handler here
 * asks first, not just the obvious one, because a tab that has just lost the
 * election still has an element running and events in flight. That is the
 * superseded-owner trap in
 * `docs/solutions/exclusive-device-one-owner-many-consumers.md`.
 *
 * **The server owns the clock.** Position reports are corrections, and a
 * measured length is news the server cannot get any other way — the same
 * division of labour `ClipPlayer` has with `report-clip-duration`.
 */
export function AudioPlayer({ state, send }: Props) {
  const transport = state.audioTransport;
  const authority = state.audioAuthority;

  const element = useRef<HTMLAudioElement>(null);
  /**
   * Whether this page has had a gesture.
   *
   * Both a ref and a state: the render needs it to decide what to offer, and the
   * media handlers need it without the stale closure they would otherwise read —
   * the discipline `ClipPlayer` records paying for once.
   */
  const enabled = useRef(false);
  const [gestured, setGestured] = useState(false);
  // What the handlers read instead of the render they were created in.
  const holds = useRef<{ authority: boolean; transport: TransportState | null }>({
    authority,
    transport,
  });
  useEffect(() => {
    holds.current = { authority, transport };
  });
  /** Which source the element currently holds, so a rerender does not restart it. */
  const held = useRef<string | null>(null);
  /** Where to resume once the file reports its length. Null when it is a fresh track. */
  const seekTo = useRef<number | null>(null);
  /** Lengths already reported, so a rerender does not report the same measurement twice. */
  const measured = useRef(new Set<string>());
  const [blocked, setBlocked] = useState(false);

  const path = authority ? (transport?.path ?? null) : null;
  const source = path ? trackUrl(path) : null;
  // Three conditions, and all three are the requirement rather than caution:
  // the server says the transport is sounding, this client is the one allowed to
  // sound it, and the page has been clicked.
  const shouldSound = Boolean(authority && gestured && transport?.playing);

  /**
   * Announce the loudspeaker (origin R5).
   *
   * Keyed on the grant alone. Depending on `send` here is what turned a mount
   * effect into an unbounded request loop once already — `LivePane` carries the
   * same disable for the same reason — and this one would announce on every
   * render of a component that rerenders on every transport tick.
   */
  useEffect(() => {
    if (!authority) return;
    send({ type: "audio-transport", command: "attend" });
    // A tab that inherits the authority mid-session has usually been clicked
    // long ago. Its activation is still good, so it does not have to ask again.
    if (enabled.current) send({ type: "audio-transport", command: "enable-sound" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authority]);

  /**
   * Hold the right file, and sound it only when all three conditions hold.
   *
   * Keyed on the composed source and the decision, never on the whole transport:
   * `positionMs` moves every second, and an effect that woke for it would
   * reassign a source and restart the track once a second.
   */
  useEffect(() => {
    const audio = element.current;
    if (!audio) return;
    if (!source) {
      // Includes losing the authority: the superseded owner stops sounding
      // before it does anything else.
      audio.pause?.();
      held.current = null;
      return;
    }
    if (held.current !== source) {
      held.current = source;
      // Joining mid-track is the ordinary case — a page opened while a World has
      // been running unattended — so the server's position is where this starts,
      // applied once the file says how long it is.
      seekTo.current = transport?.positionMs ?? 0;
      audio.src = source;
      audio.load?.();
    }
    if (!shouldSound) {
      audio.pause?.();
      return;
    }
    // Wrapped rather than chained: `play` is absent in a DOM with no media
    // pipeline, and a blocked autoplay is a rejection either way. A refusal is
    // reported rather than swallowed — origin R8 asks for it to be visible
    // wherever the transport is, which means at the server.
    void Promise.resolve(audio.play?.()).catch(() => {
      if (!holds.current.authority) return;
      setBlocked(true);
      send({ type: "report-audio-failure", error: BLOCKED });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, shouldSound]);

  /**
   * Tell the server where this element actually is.
   *
   * A bounded correction rather than a command — the server refuses one that
   * disagrees by more than its tolerance — and it stops the moment this client
   * stops sounding, because a report from a tab that lost the election would be
   * driving a clock it no longer plays against.
   */
  useEffect(() => {
    const playlistId = transport?.playlistId ?? null;
    if (!shouldSound || !path || !playlistId) return;
    const timer = setInterval(() => {
      const audio = element.current;
      if (!audio || !holds.current.authority) return;
      const positionMs = Math.round(audio.currentTime * 1_000);
      if (!Number.isFinite(positionMs) || positionMs < 0) return;
      send({ type: "report-audio-position", playlistId, path, positionMs });
    }, REPORT_INTERVAL_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldSound, path, transport?.playlistId]);

  /** The gesture. Everything audible in this component is downstream of it. */
  const enable = () => {
    enabled.current = true;
    setGestured(true);
    setBlocked(false);
    send({ type: "audio-transport", command: "enable-sound" });
  };

  /**
   * The file has said how long it is: resume where the server is, and report the
   * length if the store does not know it.
   *
   * U4 leaves an MP3's length at zero on purpose — it cannot be read without
   * decoding — so first play is the only place that number ever comes from.
   */
  const onMetadata = () => {
    const audio = element.current;
    const current = holds.current.transport;
    if (!audio || !holds.current.authority || !current?.path || !current.playlistId) return;
    const resume = seekTo.current;
    seekTo.current = null;
    if (resume !== null && resume > 0) audio.currentTime = resume / 1_000;

    const seconds = audio.duration;
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    const durationMs = Math.round(seconds * 1_000);
    if (Math.abs(durationMs - current.durationMs) <= DURATION_TOLERANCE_MS) return;
    const token = `${current.path}#${durationMs}`;
    if (measured.current.has(token)) return;
    measured.current.add(token);
    send({
      type: "report-track-duration",
      playlistId: current.playlistId,
      path: current.path,
      durationMs,
    });
  };

  /**
   * The element could not play the bytes.
   *
   * Reported as a failure of this client, not of the track: the server already
   * marks a track unplayable when the *store* cannot resolve it, and a decoder
   * this browser lacks is a different fault with a different fix (origin R8).
   */
  const onError = () => {
    if (!holds.current.authority) return;
    send({ type: "report-audio-failure", error: UNREADABLE });
  };

  const command = (cmd: "play" | "pause" | "next" | "previous") => () => {
    // Belt and braces against the render that has not caught up with a grant
    // that just moved. The server refuses it too — this is the display half.
    if (!holds.current.authority) return;
    send({ type: "audio-transport", command: cmd });
  };

  const playing = transport?.playing === true;
  const seconds = (ms: number) => {
    const whole = Math.max(0, Math.round(ms / 1_000));
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
  };

  return (
    <div className="audio-player" data-testid="audio-player">
      {/* Not muted, deliberately: muting is what lets the clip player autoplay,
          and a muted soundtrack is not a soundtrack. */}
      <audio
        ref={element}
        data-testid="audio-element"
        preload="auto"
        onLoadedMetadata={onMetadata}
        onError={onError}
      />
      <div className="audio-now">
        <span data-testid="audio-track">
          {transport?.name ?? "Nothing is loaded."}
        </span>
        {transport && transport.tracks > 0 && (
          <span className="muted" data-testid="audio-position">
            {transport.index + 1}/{transport.tracks} · {seconds(transport.positionMs)}
            {transport.durationMs > 0 ? ` / ${seconds(transport.durationMs)}` : ""}
          </span>
        )}
      </div>
      <div className="audio-controls">
        <button
          type="button"
          data-testid="audio-previous"
          disabled={!authority}
          onClick={command("previous")}
        >
          ⏮
        </button>
        <button
          type="button"
          data-testid="audio-play"
          disabled={!authority}
          onClick={command(playing ? "pause" : "play")}
        >
          {playing ? "⏸" : "▶"}
        </button>
        <button type="button" data-testid="audio-next" disabled={!authority} onClick={command("next")}>
          ⏭
        </button>
      </div>
      {authority && (!gestured || blocked) && (
        <button type="button" className="audio-enable" data-testid="audio-enable" onClick={enable}>
          enable sound
        </button>
      )}
      {!authority && (
        <p className="muted" data-testid="audio-readonly">
          Another tab is playing this. Here it is read-only.
        </p>
      )}
      {/* Two faults, side by side and never merged: this browser cannot sound
          the transport, and the transport itself has nothing to sound. */}
      {transport?.soundError && (
        <p className="warn" data-testid="audio-sound-fault">
          {transport.soundError}
        </p>
      )}
      {transport?.error && (
        <p className="warn" data-testid="audio-track-fault">
          {transport.error}
        </p>
      )}
    </div>
  );
}
