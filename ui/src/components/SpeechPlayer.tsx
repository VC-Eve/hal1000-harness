import { useEffect, useRef, useState } from "react";
import type { ClientMessage } from "../../../shared/src/types";
import type { AppState } from "../store";

interface Props {
  state: AppState;
  send: (msg: ClientMessage) => void;
  /**
   * Whether this page has had a user gesture.
   *
   * Owned by `LivePane` and shared with `AudioPlayer` rather than kept here: a
   * browser will not play an unmuted element without an activation, the
   * transport's control is what supplies one, and two elements on one page share
   * the same activation. Keeping a second copy would let this one believe it was
   * unlocked when it was not, and produce subtitles under silence.
   */
  gestured: boolean;
}

/**
 * The character's voice, on the client holding the audio grant.
 *
 * A second element beside `AudioPlayer`'s, playing one sentence at a time. One
 * element rather than one per sentence: sentences arrive as they are rendered,
 * and swapping `src` on a single element is what lets the first words begin
 * while the rest is still being synthesised.
 *
 * **It reports what it is actually playing.** The subtitle on every surface
 * follows that report (KTD5), because a server timer started when the utterance
 * was broadcast is already ahead by the fetch, decode and start latency — a
 * larger error than the leading silence the trim exists to remove. So the
 * picture and the sound agree by construction rather than by both being roughly
 * on time.
 *
 * A `play()` the browser refuses is reported rather than swallowed. Without
 * that, a speak on a never-clicked tab draws subtitles under silence and nothing
 * says why — the failure `AudioPlayer` already handles for the transport, which
 * this needs its own copy of because the two elements are unlocked separately.
 */
export function SpeechPlayer({ state, send, gestured }: Props) {
  const element = useRef<HTMLAudioElement>(null);
  const [blocked, setBlocked] = useState(false);
  const speech = state.speech;
  const authority = state.audioAuthority;

  // Which sentence this client has started. Local rather than read back from
  // `speech.current`: the server sets that *from* this report, so reading it
  // here would be a loop through the network.
  const playing = useRef<{ generation: number; index: number } | null>(null);

  const shouldSound = Boolean(authority && gestured && speech && speech.sentences.length > 0);

  useEffect(() => {
    const audio = element.current;
    if (!audio) return;

    if (!shouldSound || !speech) {
      // Silence, a supersede, or a lost grant. Stopping is unconditional: an
      // element left playing under a cleared utterance is a voice with no
      // subtitle and no way to stop it.
      audio.pause();
      audio.removeAttribute("src");
      playing.current = null;
      return;
    }

    const started = playing.current;
    const next =
      started && started.generation === speech.generation ? started.index : 0;
    if (started && started.generation === speech.generation && started.index === next && audio.src) {
      return; // already playing this sentence
    }
    if (next >= speech.sentences.length) return; // rendered so far, not yet arrived

    playing.current = { generation: speech.generation, index: next };
    audio.src = `/api/live/speech?generation=${speech.generation}&sentence=${next}`;
    void audio
      .play()
      .then(() => {
        setBlocked(false);
        send({ type: "report-speech-sentence", generation: speech.generation, index: next });
      })
      .catch(() => {
        // Reported, not swallowed. The duck lifts with it, because the duck is a
        // function of speech state on this client and this client is not
        // sounding.
        setBlocked(true);
        playing.current = null;
      });
  }, [shouldSound, speech?.generation, speech?.sentences.length, send]);

  const onEnded = () => {
    const started = playing.current;
    if (!started || !speech || started.generation !== speech.generation) return;
    const next = started.index + 1;
    playing.current = null;
    if (next >= speech.sentences.length) {
      // Past the last rendered sentence. If more are still being synthesised the
      // next state broadcast starts them; if not, this tells the server the line
      // is finished so the subtitle comes down rather than resting on the last
      // words.
      send({ type: "report-speech-sentence", generation: started.generation, index: next });
      return;
    }
    playing.current = { generation: started.generation, index: next };
    const audio = element.current;
    if (!audio) return;
    audio.src = `/api/live/speech?generation=${started.generation}&sentence=${next}`;
    void audio
      .play()
      .then(() =>
        send({ type: "report-speech-sentence", generation: started.generation, index: next }),
      )
      .catch(() => setBlocked(true));
  };

  // Nothing is drawn on `/live` for this: the speech control says what is being
  // said, and the subtitle is an overlay slot on the picture. The element is
  // rendered rather than mounted conditionally so a `src` set during a render
  // has somewhere to land.
  return (
    <>
      <audio ref={element} onEnded={onEnded} data-testid="speech-player" />
      {blocked && authority ? (
        <p className="speech-blocked" role="status">
          This page has not been allowed to make a sound yet. Press the transport&apos;s sound
          control and speak again.
        </p>
      ) : null}
    </>
  );
}
