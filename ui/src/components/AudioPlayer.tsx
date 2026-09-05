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
 * transport read-only, sounds nothing and drives nothing — every handler here
 * asks first, not just the obvious one, because a tab that has just lost the
 * election still has an element running and events in flight. That is the
 * superseded-owner trap in
 * `docs/solutions/exclusive-device-one-owner-many-consumers.md`. The one message
 * a read-only tab does send is `take-audio-authority`, which is not driving the
 * transport but asking to become the client that may: without it a forgotten tab
 * in another window holds the loudspeaker and this pane is a dead control with
 * no recourse.
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
  /** Which start it is holding, so a re-start of the same file is not mistaken for the same play. */
  const heldGeneration = useRef<number | null>(null);
  /** Where to resume once the file reports its length. Null when it is a fresh track. */
  const seekTo = useRef<number | null>(null);
  /** Lengths already reported, so a rerender does not report the same measurement twice. */
  const measured = useRef(new Set<string>());
  /** Ends already reported, so one finished track is reported once. */
  const ended = useRef(new Set<string>());
  const [blocked, setBlocked] = useState(false);
  /**
   * The latest `send`, for the one place that fires outside a render: the
   * unmount below. A cleanup runs with the closure its effect was created in, so
   * an effect that listed `send` in its deps to keep it fresh would tear down
   * and re-announce on every render — which is the request loop this file
   * already carries two disables for.
   */
  const sender = useRef(send);
  useEffect(() => {
    sender.current = send;
  });
  /** Whether this element ever told the server it was here. */
  const announced = useRef(false);

  const path = authority ? (transport?.path ?? null) : null;
  const source = path ? trackUrl(path) : null;
  // Which start this is. A playlist of one wraps onto its own track, so the
  // source is unchanged and only this says the server began it again.
  const generation = transport?.generation ?? 0;
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
    announced.current = true;
    send({ type: "audio-transport", command: "attend" });
    // A tab that inherits the authority mid-session has usually been clicked
    // long ago. Its activation is still good, so it does not have to ask again.
    if (enabled.current) send({ type: "audio-transport", command: "enable-sound" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authority]);

  /**
   * The loudspeaker is going away (origin R6, R8).
   *
   * A socket closing is the *other* way a client stops sounding and `leave`
   * covers that one. This is the case it cannot see: the element unmounts while
   * the socket stays open — a route change, a panel closing — so from the
   * server's side nothing happened at all. `audible` went on saying a room could
   * hear the track and the transport went on holding its end-of-track grace
   * period open for an `ended` that no element would ever send, which put the
   * clock a whole grace period behind on every track from then on.
   *
   * Sent only if this element ever announced itself, so a read-only tab closing
   * does not go and take an authority nobody was holding just to give it back.
   * Empty deps and the ref above: this must run on unmount and on nothing else.
   */
  useEffect(() => {
    return () => {
      if (!announced.current) return;
      sender.current({ type: "audio-transport", command: "unattend" });
    };
  }, []);

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
      heldGeneration.current = generation;
      // Joining mid-track is the ordinary case — a page opened while a World has
      // been running unattended — so the server's position is where this starts,
      // applied once the file says how long it is.
      seekTo.current = transport?.positionMs ?? 0;
      audio.src = source;
      audio.load?.();
    }
    else if (heldGeneration.current !== generation) {
      // The same file, started again — a one-track playlist coming round, or a
      // `previous` onto the track already playing. The element is finished and
      // holds the right bytes, so it is rewound rather than reassigned: setting
      // `src` again would refetch a file the browser already has and put a gap
      // where the loop should be seamless.
      heldGeneration.current = generation;
      seekTo.current = null;
      try {
        audio.currentTime = 0;
      } catch {
        /* An element that will not seek still plays from wherever it is. */
      }
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
  }, [source, shouldSound, generation]);

  /**
   * Carry the transport's volume onto the element (origin R2, R7).
   *
   * The number lives on the server-owned transport and nowhere here, which is
   * the whole of R7: the transport outlives a World switch, so a volume set
   * under World A is still the transport's volume under World B without this
   * client remembering anything. A local copy would be a second source of truth
   * that disagrees the moment another tab moves the slider.
   */
  useEffect(() => {
    const audio = element.current;
    if (!audio) return;
    const level = transport?.volume;
    if (typeof level !== "number" || !Number.isFinite(level)) return;
    // Guarded: jsdom implements `volume` but throws for a value outside 0–1,
    // and the server clamps rather than refuses, so a stale client is the only
    // way an out-of-range number arrives here at all.
    try {
      audio.volume = Math.min(1, Math.max(0, level));
    } catch {
      /* An element that will not take a volume still plays. */
    }
  }, [transport?.volume]);

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

  /**
   * The gesture, and the start it is nearly always asking for.
   *
   * The browser's activation requirement is unavoidable and one deliberate
   * click is the right price for it. A *second* control, somewhere else on the
   * pane, is not: this button used to only lift the gate, so a person arriving
   * at a silent transport had to find it, click it, and then find "this World"
   * and click that as well before anything happened — which is most of what
   * "having to click multiple buttons just to get it to start" was.
   *
   * So it starts the open World's playlist too, and only when there is nothing
   * to interrupt: a transport already holding a track is one somebody armed or
   * paused on purpose, and restarting it from a click that was about enabling
   * sound would be the same overreach in the other direction. The individual
   * transport controls are untouched for anyone who wants them.
   */
  const enable = () => {
    enabled.current = true;
    setGestured(true);
    setBlocked(false);
    send({ type: "audio-transport", command: "enable-sound" });
    // Nothing held, and this World names a set to play: the gesture is the whole
    // request. Sent after the gesture, so the transport is already cleared to
    // sound when the first track begins rather than arming and waiting again.
    // `index` of -1 is the empty transport, which is the same gate the server
    // arms against. A World naming no playlist is asked for nothing, because
    // the command would come back as a refusal on everyone's pane.
    const holding = (transport?.index ?? -1) >= 0;
    const world = state.world;
    if (holding || !world?.id || !world.playlistId) return;
    send({ type: "audio-transport", command: "start-world-playlist", worldId: world.id });
  };

  /**
   * Take the grant, and count the press as the gesture (origin R5, R6).
   *
   * The second half is the whole reason this is not two clicks. A browser gates
   * `play()` on a user activation, and this press *is* one — it is a real click
   * on this page — so demanding a separate "start the sound" afterwards would
   * ask for a gesture the click already was, and leave a person who has just
   * taken the loudspeaker sitting in silence wondering what else to press.
   *
   * Nothing is sent about sound here. The announcement effect above is keyed on
   * the grant, so when the server answers `audio-authority: true` it sends
   * `attend` and then `enable-sound` on the strength of `enabled`, in that
   * order — the same path a tab that inherits the grant mid-session takes. If
   * the activation has gone stale by then the element's `play()` is refused,
   * which is reported as a sound failure and puts the explicit control back on
   * screen; a browser that will not sound is not something a claim can fix.
   */
  const take = () => {
    enabled.current = true;
    setGestured(true);
    setBlocked(false);
    send({ type: "take-audio-authority" });
  };

  /**
   * The file has said how long it is: resume where the server is, and report the
   * length if the store does not know it.
   *
   * The import reads a length out of the file's own header where it can, so this
   * is no longer the only source of one — but it is still the source for
   * anything whose header did not parse, and it is the decoder's own number
   * rather than an arithmetic on bytes, so it also corrects a stored one.
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
   * The element has finished the track.
   *
   * The half of the resync that was missing: the server anchors a track when it
   * starts it and this element only then fetches, decodes and — first time —
   * waits for the click, so it runs behind the clock and the transport was
   * advancing while there was still music. While this client is sounding, its
   * element is what knows the track is over.
   *
   * Read from the ref rather than from the render, which is `ClipPlayer`'s
   * discipline and its recorded cost: a media handler fires against the closure
   * it was created in, and this component rerenders on every transport tick.
   * Guarded exactly as the position report is — this client holds the authority,
   * has been clicked, and the transport says it is playing — and de-duped, so
   * one finished track is reported once however many times the element fires.
   */
  const onEnded = () => {
    const current = holds.current.transport;
    if (!holds.current.authority || !enabled.current) return;
    if (!current?.playing || !current.path || !current.playlistId) return;
    const token = `${current.playlistId}#${current.path}`;
    if (ended.current.has(token)) return;
    ended.current.add(token);
    send({ type: "report-track-end", playlistId: current.playlistId, path: current.path });
  };

  /**
   * Playback has begun, so nothing has ended yet.
   *
   * Which is what re-arms the report: a track the transport comes back to later
   * is a second playing of it, and a de-duplication that never cleared would
   * hold the whole playlist's ends forever and leave every repeat to the clock.
   */
  const onPlay = () => {
    ended.current.clear();
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

  const command = (cmd: "play" | "pause" | "next" | "previous" | "stop") => () => {
    // Belt and braces against the render that has not caught up with a grant
    // that just moved. The server refuses it too — this is the display half.
    if (!holds.current.authority) return;
    send({ type: "audio-transport", command: cmd });
  };

  /**
   * Seek and volume, which carry a number rather than only an intent.
   *
   * Same authority check as every other handler, and for the reason the four
   * traps name: a tab that has just lost the election still has a slider under
   * a finger, and a drag finishing after the grant moved would drive a
   * transport somebody else is sounding.
   */
  const seek = (positionMs: number) => {
    if (!holds.current.authority) return;
    send({ type: "audio-transport", command: "seek", positionMs });
  };
  const setVolume = (volume: number) => {
    if (!holds.current.authority) return;
    send({ type: "audio-transport", command: "volume", volume });
  };
  /**
   * Start this World's playlist over whatever is playing (origin R2, AE6).
   *
   * The one command that names a World, and the one exception to the arming
   * rule — a World arms only into an empty transport, and this is the operator
   * saying they want the swap anyway.
   */
  const startWorld = () => {
    const worldId = state.world?.id;
    if (!holds.current.authority || !worldId) return;
    send({ type: "audio-transport", command: "start-world-playlist", worldId });
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
        onEnded={onEnded}
        onPlay={onPlay}
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
            {/* From the transport, never from the playlist the editor happens to
                have open: this line is about what is sounding. The position it
                sits beside is still the track's place in the playlist as
                written, which is what makes the number jump around here and is
                the honest reading of a drawn order. */}
            {transport.shuffle ? " · shuffled" : ""}
          </span>
        )}
      </div>
      {/* Playing and audible are two facts, and the gap between them is the
          one thing a person watching a silent room needs told. The clock is the
          server's, so a World runs unattended and `playing` stays true with
          every page closed — while nothing anywhere is making a sound. Saying
          only "playing" there is a stale reading served confidently, which
          `docs/solutions/exclusive-device-one-owner-many-consumers.md` records
          costing a system that captioned a frozen frame as live. */}
      {playing &&
        (transport?.audible ? (
          <p className="muted" data-testid="audio-audible">
            Sounding here.
          </p>
        ) : (
          <p className="warn" data-testid="audio-unattended">
            Running unattended: the clock is moving and nothing is making a sound.
          </p>
        ))}
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
        <button type="button" data-testid="audio-stop" disabled={!authority} onClick={command("stop")}>
          ⏹
        </button>
        <button
          type="button"
          className="ghost"
          data-testid="audio-start-world"
          disabled={!authority || !state.world}
          onClick={startWorld}
          title="Start this World's playlist over whatever is playing"
        >
          this World
        </button>
      </div>
      <div className="audio-sliders">
        {/* Seek is offered only against a length the store actually knows: a
            `durationMs` of 0 means unmeasured, and a scrubber over an unknown
            length would let a drag ask for a position the track does not have. */}
        <input
          type="range"
          data-testid="audio-seek"
          aria-label="seek"
          min={0}
          max={Math.max(1, transport?.durationMs ?? 0)}
          step={1000}
          value={Math.min(transport?.positionMs ?? 0, transport?.durationMs ?? 0)}
          disabled={!authority || !transport?.durationMs}
          onChange={(e) => seek(Number(e.target.value))}
        />
        <input
          type="range"
          data-testid="audio-volume"
          aria-label="volume"
          min={0}
          max={1}
          step={0.01}
          value={transport?.volume ?? 1}
          disabled={!authority}
          onChange={(e) => setVolume(Number(e.target.value))}
        />
      </div>
      {authority && (!gestured || blocked) && (
        <button
          type="button"
          className="audio-enable"
          data-testid="audio-enable"
          onClick={enable}
          // Named for what it does rather than for the browser rule behind it:
          // "enable sound" describes a technicality, and the person clicking it
          // wants music.
          title="Let this browser make a sound, and start this World's playlist if nothing is playing"
        >
          ▶ start the sound
        </button>
      )}
      {!authority && (
        <div className="audio-readonly">
          <p className="muted" data-testid="audio-readonly">
            Another tab is playing this. Here it is read-only.
          </p>
          {/* The recourse. Without it a tab left open in another window holds
              the loudspeaker until it is found and closed, and every other tab
              shows a dead transport with no explanation — which is the report
              this whole round started from.

              Worded for what happens to the other tab rather than for the
              grant, because "take the audio authority" describes a mechanism
              and the person clicking it wants the music here. */}
          <button
            type="button"
            className="ghost"
            data-testid="audio-take"
            onClick={take}
            title="Sound this transport here. The tab that is playing goes silent."
          >
            play it here instead
          </button>
        </div>
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
