import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SpeechPane } from "../../src/components/SpeechPane";
import type { Readiness, VoicePreset } from "../../../shared/src/types";
import { harness, testState } from "./harness";
import { cleanPreset } from "../../../shared/src/voices";

const preset = (over: Partial<VoicePreset> = {}): VoicePreset => ({
  id: "hal",
  label: "HAL",
  mix: [{ voice: "am_michael", weight: 1 }],
  speed: 1,
  ...over,
});

const voices = (over: Partial<AppVoices> = {}) => ({
  presets: [preset()],
  stock: ["am_michael", "bm_george", "bm_lewis"],
  available: true,
  ...over,
});
type AppVoices = { presets: VoicePreset[]; stock: string[]; available: boolean };

const ready = (voice: Readiness["voice"]): Readiness =>
  ({
    observationBackend: "ok",
    chatBackend: "ok",
    models: "ok",
    claudeLogs: "ok",
    captioner: "disabled",
    recogniser: "disabled",
    voice,
  }) as Readiness;

const pane = (over: Parameters<typeof testState>[0] = {}) => {
  const h = harness();
  const view = render(
    <SpeechPane state={testState({ voices: voices(), readiness: ready("ok"), ...over })} send={h.send} />,
  );
  return { h, view };
};

describe("the speech control", () => {
  it("will not speak an empty line", () => {
    const { view } = pane();
    expect(view.getByTestId("speak")).toBeDisabled();
  });

  it("speaks the typed line in the chosen voice", () => {
    const { h, view } = pane();
    fireEvent.change(view.getByTestId("speech-line"), { target: { value: "Open the doors." } });
    fireEvent.click(view.getByTestId("speak"));
    expect(h.sent).toContainEqual({
      type: "speak",
      text: "Open the doors.",
      voice: { id: "hal" },
    });
  });

  it("tells a first run apart from a broken install", () => {
    // The two call for opposite responses — wait, or go and read a log — and a
    // single greyed-out button would leave the operator guessing which.
    const fetching = pane({ readiness: ready("fetching") });
    expect(fetching.view.getByTestId("speech-blocked-reason")).toHaveTextContent(/still downloading/i);
    expect(fetching.view.getByTestId("speak")).toBeDisabled();
    // Torn down before the next: both render into the same document, so a
    // second pane would make every query ambiguous.
    fetching.view.unmount();

    const missing = pane({ readiness: ready("unavailable") });
    expect(missing.view.getByTestId("speech-blocked-reason")).toHaveTextContent(/not available/i);
  });

  it("says so when there is no voice to speak in", () => {
    const { view } = pane({ voices: voices({ presets: [] }) });
    expect(view.getByTestId("speech-blocked-reason")).toHaveTextContent(/no voice/i);
    expect(view.getByTestId("speak")).toBeDisabled();
  });

  it("shows an in-flight state while a line is being said", () => {
    // A synthesis costs roughly the length of the line. Without this the control
    // looks dead for the whole render and a slow one is indistinguishable from a
    // stuck one.
    const { view } = pane({
      speech: {
        generation: 1,
        text: "Hello.",
        voiceId: "hal",
        sentences: [{ text: "Hello.", durationMs: 900 }],
        current: 0,
      },
    });
    expect(view.getByTestId("speak")).toHaveTextContent(/speaking/i);
    expect(view.getByTestId("speak")).toBeDisabled();
    expect(view.getByTestId("stop-speaking")).toBeEnabled();
  });
});

describe("the voice editor", () => {
  const open = (over: Parameters<typeof testState>[0] = {}) => {
    const made = pane(over);
    fireEvent.click(made.view.getByTestId("open-voice-editor"));
    return made;
  };

  it("is collapsed until asked for, and mounts nothing while closed", () => {
    // The column already holds the Parameters and Node panels and a conditional
    // problems group; StateGraph records nine stacked sections as what made it
    // unreadable.
    const { view } = pane();
    expect(view.queryByTestId("voice-editor")).toBeNull();
    fireEvent.click(view.getByTestId("open-voice-editor"));
    expect(view.getByTestId("voice-editor")).toBeTruthy();
  });

  it("shows each voice's effective share, not just its raw weight", () => {
    // Two voices at 1 and 1 read as "1 and 1" while sounding 50/50, and a third
    // moves both to a third with no slider appearing to move.
    const { view } = open();
    fireEvent.click(view.getByTestId("mix-add"));
    expect(view.getByTestId("mix-share-0")).toHaveTextContent("50%");
    expect(view.getByTestId("mix-share-1")).toHaveTextContent("50%");

    fireEvent.click(view.getByTestId("mix-add"));
    expect(view.getByTestId("mix-share-0")).toHaveTextContent("33%");
    expect(view.getByTestId("mix-share-2")).toHaveTextContent("33%");
  });

  it("reweights a voice and moves every share with it", () => {
    const { view } = open();
    fireEvent.click(view.getByTestId("mix-add"));
    fireEvent.change(view.getByTestId("mix-weight-1"), { target: { value: "0.5" } });
    expect(view.getByTestId("mix-share-0")).toHaveTextContent("67%");
    expect(view.getByTestId("mix-share-1")).toHaveTextContent("33%");
  });

  it("auditions a mix that has not been saved, and the server accepts it", () => {
    // The whole design loop. A Speak that could only name a stored voice would
    // force a save before every listen and fill the picker with drafts.
    //
    // The second assertion is the one that matters and was missing: an earlier
    // version checked only that *a message was sent*, so an audition the server
    // refused for every unnamed voice shipped green. A voice has no name until
    // it sounds right — naming it is the last step — so the payload must survive
    // `cleanPreset` with the name box empty.
    const { h, view } = open();
    fireEvent.click(view.getByTestId("voice-audition"));
    const sent = h.sent.find((m) => m.type === "speak");
    expect(sent).toBeTruthy();
    const voice = sent && "voice" in sent ? sent.voice : null;
    expect(voice).toHaveProperty("preset");
    expect(cleanPreset((voice as { preset: unknown }).preset)).not.toBeNull();
  });

  it("still auditions once a name has been typed", () => {
    const { h, view } = open();
    fireEvent.change(view.getByTestId("voice-label"), { target: { value: "Mission Control" } });
    fireEvent.click(view.getByTestId("voice-audition"));
    const sent = h.sent.find((m) => m.type === "speak");
    const voice = sent && "voice" in sent ? sent.voice : null;
    expect(cleanPreset((voice as { preset: unknown }).preset)).not.toBeNull();
  });

  it("does not offer a voice another row is already using", () => {
    // `cleanMix` refuses a duplicate, and the refusal arrives long after the
    // pick as "that is not a voice". Unpickable beats unexplained.
    const { view } = open();
    fireEvent.click(view.getByTestId("mix-add"));
    const first = view.getByTestId("mix-voice-0") as HTMLSelectElement;
    const second = view.getByTestId("mix-voice-1") as HTMLSelectElement;
    const firstOptions = [...first.options].map((o) => o.value);
    const secondOptions = [...second.options].map((o) => o.value);
    expect(firstOptions).toContain(first.value);
    expect(secondOptions).not.toContain(first.value);
    expect(firstOptions).not.toContain(second.value);
  });

  it("cannot save without a name", () => {
    const { view } = open();
    expect(view.getByTestId("voice-save")).toBeDisabled();
    fireEvent.change(view.getByTestId("voice-label"), { target: { value: "Mission Control" } });
    expect(view.getByTestId("voice-save")).toBeEnabled();
  });

  it("cannot save a mix that is silent", () => {
    const { view } = open();
    fireEvent.change(view.getByTestId("voice-label"), { target: { value: "Quiet" } });
    fireEvent.change(view.getByTestId("mix-weight-0"), { target: { value: "0" } });
    expect(view.getByTestId("voice-save")).toBeDisabled();
  });

  it("cannot save or audition while the voice pack is unreadable", () => {
    // A preset that cannot be checked is one that fails at the moment it is
    // spoken, which is the worst time to find out.
    const { view } = open({ voices: voices({ available: false }) });
    expect(view.getByTestId("voice-pack-missing")).toBeTruthy();
    expect(view.getByTestId("voice-audition")).toBeDisabled();
    fireEvent.change(view.getByTestId("voice-label"), { target: { value: "Nope" } });
    expect(view.getByTestId("voice-save")).toBeDisabled();
  });

  it("saves the mix the sliders show", () => {
    const { h, view } = open();
    fireEvent.change(view.getByTestId("voice-label"), { target: { value: "Mission Control" } });
    fireEvent.change(view.getByTestId("voice-speed"), { target: { value: "1.1" } });
    fireEvent.click(view.getByTestId("voice-save"));
    expect(h.sent).toContainEqual({
      type: "save-voice-preset",
      preset: {
        id: "mission-control",
        label: "Mission Control",
        mix: [{ voice: "am_michael", weight: 1 }],
        speed: 1.1,
      },
    });
  });

  it("asks for the phonemes once per change, not once per render", async () => {
    // A component must survive an unstable `send`: depending on it in an effect
    // once produced an unbounded request loop, which is the defect this harness
    // exists to catch.
    const { h, view } = open();
    await new Promise((done) => setTimeout(done, 400));
    const first = h.countOf("phonemes-for");
    expect(first).toBe(1);

    view.rerender(
      <SpeechPane
        state={testState({ voices: voices(), readiness: ready("ok") })}
        send={(msg) => h.send(msg)}
      />,
    );
    await new Promise((done) => setTimeout(done, 400));
    expect(h.countOf("phonemes-for")).toBe(first);
  });

  it("shows the phonemes only for the text they answer for", () => {
    // A reply landing after the operator has typed on must not be shown against
    // the wrong line.
    const stale = open({ phonemes: { text: "something else", ipa: "ɡˈoʊst" } });
    expect(stale.view.getByTestId("voice-phonemes")).not.toHaveTextContent("ɡˈoʊst");
  });

  it("deletes a saved voice by name", () => {
    const { h, view } = open();
    fireEvent.click(view.getByTestId("voice-delete-hal"));
    expect(h.sent).toContainEqual({ type: "delete-voice-preset", id: "hal" });
  });
});
