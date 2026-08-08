import { describe, it, expect } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { WebcamPane } from "../../src/components/WebcamPane";
import { harness, mount, testSettings, testState } from "./harness";
import type { VisionCheckFace, VisionEvent, VisionObservation, VisionState } from "../../../shared/src/types";

const watching = (over: Partial<ReturnType<typeof testSettings>["vision"]> = {}) =>
  testSettings({ vision: { ...testSettings().vision, enabled: true, ...over } });

const observation = (over: Partial<VisionObservation> = {}): VisionObservation => ({
  at: "2026-08-06T21:00:00.000Z",
  caption: "A person sits at a desk.",
  identity: null,
  ...over,
});

const caption = (at: string, text = "A person sits at a desk."): VisionEvent => ({ kind: "caption", at, caption: text });

const check = (at: string, faces: VisionCheckFace[] = []): VisionEvent => ({ kind: "check", at, faces });

const matched = (over: Partial<VisionCheckFace> = {}): VisionCheckFace => ({
  embedded: true,
  personId: "p1",
  name: "Creator",
  confidence: 0.71,
  band: "stated",
  weight: 0.42,
  ...over,
});

const props = (h: ReturnType<typeof harness>, state = testState()) => ({
  state,
  send: h.send,
  collapseDisabled: false,
  onCollapse: () => {},
});

describe("WebcamPane — mount", () => {
  it("sends nothing on mount", () => {
    // The pane is a view, not a requester. An effect firing here would run on
    // every store broadcast, which is how a request loop starts.
    const h = harness();
    mount(<WebcamPane {...props(h)} />);

    expect(h.sent).toEqual([]);
  });

  it("still sends nothing when handed a fresh send on every render", () => {
    // The shape of the bug this suite exists for: a component that depends on
    // `send` in an effect re-runs forever when its caller re-creates `send`.
    const h = harness();
    const unstable = () => (msg: Parameters<typeof h.send>[0]) => h.send(msg);
    const state = testState({ settings: watching() });

    const { rerender } = mount(<WebcamPane {...props(h, state)} send={unstable()} />);
    for (let i = 0; i < 5; i += 1) {
      rerender(
        <WebcamPane
          {...props(h, testState({ settings: watching(), visionObservations: [observation()] }))}
          send={unstable()}
        />,
      );
    }

    expect(h.sent).toEqual([]);
  });
});

describe("WebcamPane — controls", () => {
  it("starts Vision through a settings patch", () => {
    const h = harness();
    mount(<WebcamPane {...props(h)} />);

    fireEvent.click(screen.getByRole("button", { name: "start" }));

    expect(h.sent).toEqual([{ type: "update-settings", patch: { vision: { enabled: true } } }]);
  });

  it("stops Vision when it is already watching", () => {
    const h = harness();
    mount(<WebcamPane {...props(h, testState({ settings: watching() }))} />);

    fireEvent.click(screen.getByRole("button", { name: "stop" }));

    expect(h.sent).toEqual([{ type: "update-settings", patch: { vision: { enabled: false } } }]);
  });

  it("refuses to offer an on-demand look while Vision is off", () => {
    // The server rejects the message in this state, so an enabled button would
    // be an affordance that does nothing.
    const h = harness();
    mount(<WebcamPane {...props(h)} />);

    expect(screen.getByRole("button", { name: "look now" })).toBeDisabled();
  });

  it("asks for a look while Vision is watching", () => {
    const h = harness();
    mount(<WebcamPane {...props(h, testState({ settings: watching() }))} />);

    fireEvent.click(screen.getByRole("button", { name: "look now" }));

    expect(h.sent).toEqual([{ type: "vision-capture-now" }]);
  });

  it("disables the look button while a capture is already running", () => {
    const h = harness();
    const state = testState({ settings: watching(), visionState: "captioning" });
    mount(<WebcamPane {...props(h, state)} />);

    expect(screen.getByRole("button", { name: "look now" })).toBeDisabled();
  });
});

describe("WebcamPane — what it shows", () => {
  it("shows no live feed until Vision is enabled", () => {
    // R15: the preview is camera access, so nothing may request the stream
    // before the user switches Vision on.
    const h = harness();
    mount(<WebcamPane {...props(h)} />);

    expect(screen.queryByAltText("the live camera")).toBeNull();
    expect(screen.getByText("not watching")).toBeInTheDocument();
  });

  it("requests the live stream once watching", () => {
    const h = harness();
    mount(<WebcamPane {...props(h, testState({ settings: watching() }))} />);

    expect(screen.getByAltText("the live camera")).toHaveAttribute("src", "/api/vision/stream");
  });

  it("renders each caption in the timeline", () => {
    const h = harness();
    const state = testState({
      settings: watching(),
      visionTimeline: [
        caption("2026-08-06T21:00:00.000Z", "Nobody is here."),
        caption("2026-08-06T21:01:00.000Z"),
      ],
    });
    mount(<WebcamPane {...props(h, state)} />);

    expect(screen.getByText(/Nobody is here\./)).toBeInTheDocument();
    expect(screen.getByText(/A person sits at a desk\./)).toBeInTheDocument();
  });

  it("marks a fault state and shows its detail", () => {
    const h = harness();
    const state = testState({
      settings: watching(),
      visionState: "no-camera" as VisionState,
      visionDetail: "The camera is in use by another application.",
    });
    mount(<WebcamPane {...props(h, state)} />);

    expect(screen.getByTestId("vision-state")).toHaveClass("fail");
    expect(screen.getByTestId("vision-fault")).toHaveTextContent("in use by another application");
  });

  it("tells the user how to get a captioner when it cannot reach one", () => {
    // The one fault a user cannot act on unaided: HAL points at the captioner
    // rather than installing it, so the moment it says it cannot reach one is
    // the moment to say what to install.
    const h = harness();
    const state = testState({ settings: watching(), visionState: "no-captioner" as VisionState });
    mount(<WebcamPane {...props(h, state)} />);

    expect(screen.getByTestId("captioner-setup")).toHaveTextContent("llama-server");
  });

  it("does not offer setup instructions for faults that explain themselves", () => {
    const h = harness();
    const state = testState({ settings: watching(), visionState: "no-camera" as VisionState });
    mount(<WebcamPane {...props(h, state)} />);

    expect(screen.queryByTestId("captioner-setup")).toBeNull();
  });

  it("does not mark an ordinary working state as a fault", () => {
    const h = harness();
    const state = testState({ settings: watching(), visionState: "capturing" as VisionState });
    mount(<WebcamPane {...props(h, state)} />);

    expect(screen.getByTestId("vision-state")).not.toHaveClass("fail");
    expect(screen.queryByTestId("vision-fault")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Recognition
//
// These assert behaviour a reader cannot check by eye — what is disabled, what
// is sent, and when the strip appears at all. Appearance stays a screenshot
// concern, per the project's rule.
// ---------------------------------------------------------------------------

const recognising = (over: Partial<ReturnType<typeof testSettings>["vision"]> = {}) =>
  testSettings({
    vision: { ...testSettings().vision, enabled: true, recognitionEnabled: true, ...over },
  });

const seen = (over: Partial<{ id: string; match: { personId: string; name: string; confidence: number } | null; embedded: boolean }> = {}) => ({
  id: "a1",
  match: null,
  embedded: true,
  ...over,
});

describe("WebcamPane — recognition", () => {
  it("hides the strip entirely when recognition is off", () => {
    const h = harness();
    mount(<WebcamPane {...props(h, testState({ settings: watching() }))} />);
    expect(screen.queryByTestId("vision-recognition")).toBeNull();
  });

  it("hides the strip when recognition is on but Vision is off", () => {
    // Subordination: recognition never opens the camera on its own, so
    // advertising it while Vision is off would offer something that cannot run.
    const h = harness();
    const settings = testSettings({
      vision: { ...testSettings().vision, enabled: false, recognitionEnabled: true },
    });
    mount(<WebcamPane {...props(h, testState({ settings }))} />);
    expect(screen.queryByTestId("vision-recognition")).toBeNull();
  });

  it("states the name and its confidence above the statement threshold", () => {
    const h = harness();
    const state = testState({
      settings: recognising(),
      visionAppearances: [seen({ match: { personId: "p1", name: "Dave", confidence: 0.92 } })],
    });
    mount(<WebcamPane {...props(h, state)} />);

    const identity = screen.getByTestId("vision-identity");
    expect(identity.dataset.band).toBe("stated");
    expect(identity.textContent).toContain("Dave");
    // R24: the number behind the name is visible, so a wrong match is
    // questionable rather than invisible.
    expect(identity.textContent).toContain("92%");
    expect(identity.textContent).not.toContain("someone who looks like");
  });

  it("hedges between the two thresholds, and never falls through to the bare name", () => {
    // The negative that matters in the pane. Presenting a marginal match as a
    // flat assertion is the dangerous direction to be wrong in, and a producer
    // -side test would never see it — this is the rendering.
    const h = harness();
    const state = testState({
      settings: recognising(),
      // 0.55 sits between the shipped 0.5 and 0.6.
      visionAppearances: [seen({ match: { personId: "p1", name: "Dave", confidence: 0.55 } })],
    });
    mount(<WebcamPane {...props(h, state)} />);

    const identity = screen.getByTestId("vision-identity");
    expect(identity.dataset.band).toBe("hedged");
    expect(identity.textContent).toContain("someone who looks like");
    expect(identity.textContent).toContain("55%");
  });

  it("follows the thresholds the user set rather than the shipped ones", () => {
    // Both are settings. A pane using its own numbers would draw a band the
    // server does not agree with, which is the drift this shares a helper to
    // avoid.
    const h = harness();
    const base = recognising();
    const state = testState({
      settings: { ...base, vision: { ...base.vision, confidenceThreshold: 0.4, statementThreshold: 0.9 } },
      visionAppearances: [seen({ match: { personId: "p1", name: "Dave", confidence: 0.7 } })],
    });
    mount(<WebcamPane {...props(h, state)} />);

    // 0.7 clears the shipped 0.6 but not the configured 0.9.
    expect(screen.getByTestId("vision-identity").dataset.band).toBe("hedged");
  });

  it("says nobody is in view when there are no appearances", () => {
    const h = harness();
    mount(<WebcamPane {...props(h, testState({ settings: recognising() }))} />);
    expect(screen.getByTestId("vision-nobody")).toBeTruthy();
    expect(screen.queryByTestId("vision-enrol")).toBeNull();
  });

  it("offers enrolment for a single unrecognised face", () => {
    const h = harness();
    const state = testState({ settings: recognising(), visionAppearances: [seen()] });
    mount(<WebcamPane {...props(h, state)} />);

    fireEvent.change(screen.getByTestId("vision-enrol-name"), { target: { value: "Dave" } });
    fireEvent.click(screen.getByTestId("vision-enrol"));

    expect(h.sent).toEqual([{ type: "enrol-person", name: "Dave" }]);
  });

  it("sends nothing for a blank or whitespace-only name", () => {
    const h = harness();
    const state = testState({ settings: recognising(), visionAppearances: [seen()] });
    mount(<WebcamPane {...props(h, state)} />);

    fireEvent.change(screen.getByTestId("vision-enrol-name"), { target: { value: "   " } });
    fireEvent.click(screen.getByTestId("vision-enrol"));

    expect(h.sent).toEqual([]);
  });

  it("disables enrolment when two people are in frame", () => {
    // Enrolling from a crowded frame would attach the wrong face to a name, and
    // this slice has no queue to correct it with.
    const h = harness();
    const state = testState({
      settings: recognising(),
      visionAppearances: [seen({ id: "a1" }), seen({ id: "a2" })],
    });
    mount(<WebcamPane {...props(h, state)} />);

    expect((screen.getByTestId("vision-enrol") as HTMLButtonElement).disabled).toBe(true);
  });

  it("disables enrolment for a face the recogniser could not describe", () => {
    // A person stored with no embedding would look enrolled and never match.
    const h = harness();
    const state = testState({
      settings: recognising(),
      visionAppearances: [seen({ embedded: false })],
    });
    mount(<WebcamPane {...props(h, state)} />);

    expect((screen.getByTestId("vision-enrol-name") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId("vision-enrol") as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows why an enrolment was refused", () => {
    const h = harness();
    const state = testState({
      settings: recognising(),
      visionAppearances: [seen()],
      visionEnrolError: "2 faces are in view.",
    });
    mount(<WebcamPane {...props(h, state)} />);
    expect(screen.getByTestId("vision-enrol-error").textContent).toContain("2 faces");
  });

  it("reports an unreachable recogniser without claiming Vision is broken", () => {
    const h = harness();
    const state = testState({
      settings: recognising(),
      visionState: "no-recogniser" as VisionState,
      visionDetail: "The recogniser is not reachable.",
    });
    mount(<WebcamPane {...props(h, state)} />);

    expect(screen.getByTestId("vision-state").textContent).toContain("recogniser");
    expect(screen.getByTestId("vision-fault").textContent).toContain("not reachable");
  });

  it("distinguishes a slow recogniser from an absent one", () => {
    const h = harness();
    const state = testState({ settings: recognising(), visionState: "recogniser-slow" as VisionState });
    mount(<WebcamPane {...props(h, state)} />);
    expect(screen.getByTestId("vision-state").textContent).toContain("keep up");
  });
});

describe("WebcamPane — triage queue", () => {
  const candidate = (over: Partial<{ id: string; at: string; thumbnail: string }> = {}) => ({
    id: "c1",
    at: "2026-08-07T18:00:00.000Z",
    thumbnail: "data:image/jpeg;base64,AAAA",
    ...over,
  });

  it("stays hidden when nothing is waiting", () => {
    const h = harness();
    mount(<WebcamPane {...props(h, testState({ settings: recognising() }))} />);
    expect(screen.queryByTestId("vision-triage")).toBeNull();
  });

  it("shows a waiting face", () => {
    const h = harness();
    const state = testState({ settings: recognising(), visionCandidates: [candidate()] });
    mount(<WebcamPane {...props(h, state)} />);
    expect(screen.getAllByTestId("triage-face")).toHaveLength(1);
  });

  it("names a specific waiting face rather than whoever is in view", () => {
    // The whole point: the face is chosen. This works with two people in
    // frame, and after the person has walked away.
    const h = harness();
    const state = testState({ settings: recognising(), visionCandidates: [candidate({ id: "c7" })] });
    mount(<WebcamPane {...props(h, state)} />);

    fireEvent.click(screen.getByTestId("triage-name"));
    fireEvent.change(screen.getByTestId("triage-name-input"), { target: { value: "Marvin" } });
    fireEvent.click(screen.getByTestId("triage-save"));

    expect(h.sent).toEqual([{ type: "enrol-person", name: "Marvin", candidateId: "c7" }]);
  });

  it("sends nothing for a blank name", () => {
    const h = harness();
    const state = testState({ settings: recognising(), visionCandidates: [candidate()] });
    mount(<WebcamPane {...props(h, state)} />);

    fireEvent.click(screen.getByTestId("triage-name"));
    fireEvent.change(screen.getByTestId("triage-name-input"), { target: { value: "  " } });
    fireEvent.click(screen.getByTestId("triage-save"));

    expect(h.sent).toEqual([]);
  });

  it("keeps naming and dismissing apart", () => {
    // Neither should be reachable by a misclick meant for the other: one
    // enrols a person, the other destroys the record.
    const h = harness();
    const state = testState({ settings: recognising(), visionCandidates: [candidate({ id: "c9" })] });
    mount(<WebcamPane {...props(h, state)} />);

    fireEvent.click(screen.getByTestId("triage-dismiss"));
    expect(h.sent).toEqual([{ type: "dismiss-candidate", id: "c9" }]);
  });

  it("says how many faces were dropped before they were looked at", () => {
    // A bound that discards silently reports a quiet week that never happened.
    const h = harness();
    const state = testState({
      settings: recognising(),
      visionCandidates: [],
      visionCandidateOverflow: { dropped: 3, since: "2026-08-07T09:00:00.000Z" },
    });
    mount(<WebcamPane {...props(h, state)} />);

    expect(screen.getByTestId("triage-overflow").textContent).toContain("3 faces dropped");
  });

  it("shows the overflow notice even with an empty queue", () => {
    const h = harness();
    const state = testState({
      settings: recognising(),
      visionCandidateOverflow: { dropped: 1, since: "2026-08-07T09:00:00.000Z" },
    });
    mount(<WebcamPane {...props(h, state)} />);
    expect(screen.getByTestId("vision-triage")).toBeTruthy();
    expect(screen.getByTestId("triage-overflow").textContent).toContain("1 face dropped");
  });
});

describe("WebcamPane — naming says where the face will land", () => {
  const candidate = { id: "c1", at: "2026-08-07T18:00:00.000Z", thumbnail: "data:image/jpeg;base64,AAAA" };
  const person = (name: string, faceCount = 2) => ({
    id: `p-${name}`,
    name,
    createdAt: "2026-08-07T12:00:00.000Z",
    faceCount,
    thumbnail: "data:image/jpeg;base64,BBBB",
  });

  function openNaming(people: ReturnType<typeof person>[]) {
    const h = harness();
    const state = testState({ settings: recognising(), visionCandidates: [candidate], visionPeople: people });
    mount(<WebcamPane {...props(h, state)} />);
    fireEvent.click(screen.getByTestId("triage-name"));
    return h;
  }

  it("says a known name will add a face rather than create someone", () => {
    // The confusion this removes: retyping a name and hoping, then finding the
    // roster has two of everyone.
    openNaming([person("Liam", 2)]);
    fireEvent.change(screen.getByTestId("triage-name-input"), { target: { value: "Liam" } });

    const hint = screen.getByTestId("triage-merge-hint");
    expect(hint.textContent).toContain("Liam");
    expect(hint.textContent).toContain("2");
    expect(screen.queryByTestId("triage-new-hint")).toBeNull();
  });

  it("matches the server's case-insensitive, trimmed rule", () => {
    // A hint that disagreed with what actually happens would be worse than no
    // hint at all.
    openNaming([person("Liam")]);
    fireEvent.change(screen.getByTestId("triage-name-input"), { target: { value: "  liam " } });
    expect(screen.getByTestId("triage-merge-hint")).toBeTruthy();
  });

  it("says an unknown name will create someone new", () => {
    openNaming([person("Liam")]);
    fireEvent.change(screen.getByTestId("triage-name-input"), { target: { value: "Marvin" } });
    expect(screen.getByTestId("triage-new-hint")).toBeTruthy();
    expect(screen.queryByTestId("triage-merge-hint")).toBeNull();
  });

  it("says nothing until something is typed", () => {
    openNaming([person("Liam")]);
    expect(screen.queryByTestId("triage-merge-hint")).toBeNull();
    expect(screen.queryByTestId("triage-new-hint")).toBeNull();
  });

  it("offers the known roster for autocomplete", () => {
    openNaming([person("Liam"), person("Steve")]);
    const input = screen.getByTestId("triage-name-input");
    expect(input.getAttribute("list")).toBe("vision-known-people");
    expect(document.querySelectorAll("#vision-known-people option")).toHaveLength(2);
  });
});

describe("WebcamPane — confirming an uncertain match", () => {
  const suspected = (over = {}) => ({
    id: "c1",
    at: "2026-08-08T10:00:00.000Z",
    thumbnail: "data:image/jpeg;base64,AA",
    suspected: { personId: "p1", name: "Dave", confidence: 0.55 },
    ...over,
  });

  const dave = {
    id: "p1",
    name: "Dave",
    createdAt: "2026-08-08T00:00:00.000Z",
    faceCount: 3,
    thumbnail: "data:image/jpeg;base64,BB",
    faces: [],
  };

  it("says who it might be, with the reading behind it", () => {
    const h = harness();
    mount(
      <WebcamPane
        {...props(h, testState({ settings: recognising(), visionCandidates: [suspected()], visionPeople: [dave] }))}
      />,
    );
    expect(screen.getByTestId("triage-suspected").textContent).toContain("might be Dave");
    expect(screen.getByTestId("triage-suspected").textContent).toContain("55%");
  });

  it("shows a face already held for that person, to compare against", () => {
    // Confirming teaches HAL a face. The reviewer needs the two pictures side
    // by side, not a name to agree with.
    const h = harness();
    mount(
      <WebcamPane
        {...props(h, testState({ settings: recognising(), visionCandidates: [suspected()], visionPeople: [dave] }))}
      />,
    );
    expect(screen.getByTestId("triage-known-face")).toHaveAttribute("src", dave.thumbnail);
  });

  it("confirms to the suspected person", () => {
    const h = harness();
    mount(
      <WebcamPane
        {...props(h, testState({ settings: recognising(), visionCandidates: [suspected()], visionPeople: [dave] }))}
      />,
    );
    fireEvent.click(screen.getByTestId("triage-confirm"));
    expect(h.sent).toContainEqual({ type: "confirm-candidate", id: "c1", personId: "p1" });
  });

  it("offers naming someone else rather than only dismissing", () => {
    // Rejecting the suspicion is not dismissing the face — it is saying this is
    // somebody different, which is worth keeping.
    const h = harness();
    mount(
      <WebcamPane
        {...props(h, testState({ settings: recognising(), visionCandidates: [suspected()], visionPeople: [dave] }))}
      />,
    );
    expect(screen.getByTestId("triage-name").textContent).toBe("someone else");
  });

  it("leaves an ordinary unrecognised face exactly as it was", () => {
    // The original queue behaviour is untouched: no suspicion, no confirm
    // button, and the action still reads "name".
    const h = harness();
    const plain = suspected({ suspected: undefined });
    mount(
      <WebcamPane {...props(h, testState({ settings: recognising(), visionCandidates: [plain], visionPeople: [dave] }))} />,
    );
    expect(screen.queryByTestId("triage-suspected")).toBeNull();
    expect(screen.queryByTestId("triage-confirm")).toBeNull();
    expect(screen.getByTestId("triage-name").textContent).toBe("name");
  });
});

describe("WebcamPane — the dropped-faces tally", () => {
  const withOverflow = (dropped: number, candidates: never[] = []) =>
    testState({
      settings: recognising(),
      visionCandidates: candidates,
      visionCandidateOverflow: { dropped, since: "2026-08-08T09:00:00.000Z" },
    });

  it("reports faces dropped before anyone saw them", () => {
    const h = harness();
    mount(<WebcamPane {...props(h, withOverflow(32))} />);
    expect(screen.getByTestId("triage-overflow").textContent).toContain("32 faces dropped");
  });

  it("stays visible with an empty queue, because it is a tally and not a queue state", () => {
    // The count is about faces that are already gone. Emptying the queue does
    // not un-drop them, which is exactly why it needs dismissing rather than
    // disappearing on its own.
    const h = harness();
    mount(<WebcamPane {...props(h, withOverflow(32, []))} />);
    expect(screen.getByTestId("triage-overflow")).toBeInTheDocument();
  });

  it("can be dismissed", () => {
    const h = harness();
    mount(<WebcamPane {...props(h, withOverflow(32))} />);
    fireEvent.click(screen.getByTestId("triage-overflow-dismiss"));
    expect(h.sent).toContainEqual({ type: "acknowledge-overflow" });
  });

  it("is not shown when nothing was dropped", () => {
    const h = harness();
    mount(<WebcamPane {...props(h, withOverflow(0))} />);
    expect(screen.queryByTestId("triage-overflow")).toBeNull();
  });

  it("says face, singular, when one was dropped", () => {
    const h = harness();
    mount(<WebcamPane {...props(h, withOverflow(1))} />);
    const text = screen.getByTestId("triage-overflow").textContent ?? "";
    expect(text).toContain("1 face dropped");
    expect(text).not.toContain("faces");
  });
});

describe("WebcamPane — judging a capture before keeping it", () => {
  const candidate = (over = {}) => ({
    id: "c1",
    at: "2026-08-08T10:00:00.000Z",
    thumbnail: "data:image/jpeg;base64,AA",
    ...over,
  });

  const withQueue = (c: ReturnType<typeof candidate>) =>
    testState({ settings: recognising(), visionCandidates: [c] });

  it("shows how wide the face was in the frame", () => {
    // Every stored crop is 160x160, so the picture cannot say whether it was
    // upscaled from a distant face. This number is the missing signal.
    const h = harness();
    mount(<WebcamPane {...props(h, withQueue(candidate({ sourceWidth: 240 })))} />);
    expect(screen.getByTestId("triage-width").textContent).toContain("240px");
  });

  it("marks a capture smaller than the embedder's own input", () => {
    // Under 112px the crop was invented rather than sampled, and a vague
    // embedding sits close to everyone.
    const h = harness();
    mount(<WebcamPane {...props(h, withQueue(candidate({ sourceWidth: 58 })))} />);
    expect(screen.getByTestId("triage-width").className).toContain("thin");
  });

  it("does not mark a comfortably large capture", () => {
    const h = harness();
    mount(<WebcamPane {...props(h, withQueue(candidate({ sourceWidth: 240 })))} />);
    expect(screen.getByTestId("triage-width").className).not.toContain("thin");
  });

  it("says nothing when the width was not recorded", () => {
    // Faces enrolled before this existed. Absent is not zero.
    const h = harness();
    mount(<WebcamPane {...props(h, withQueue(candidate()))} />);
    expect(screen.queryByTestId("triage-width")).toBeNull();
  });

  it("opens the capture at full size", () => {
    const h = harness();
    mount(<WebcamPane {...props(h, withQueue(candidate({ sourceWidth: 58 })))} />);
    expect(screen.queryByTestId("face-zoom")).toBeNull();
    fireEvent.click(screen.getByTestId("zoom-candidate"));
    expect(screen.getByTestId("face-zoom-image")).toHaveAttribute("src", "data:image/jpeg;base64,AA");
    expect(screen.getByTestId("face-zoom-size").textContent).toContain("58px");
    expect(screen.getByTestId("face-zoom-size").textContent).toContain("upscaled");
  });

  it("says so when the size is unknown rather than implying zero", () => {
    const h = harness();
    mount(<WebcamPane {...props(h, withQueue(candidate()))} />);
    fireEvent.click(screen.getByTestId("zoom-candidate"));
    expect(screen.getByTestId("face-zoom-size").textContent).toContain("before sizes were recorded");
  });

  it("closes", () => {
    const h = harness();
    mount(<WebcamPane {...props(h, withQueue(candidate({ sourceWidth: 240 })))} />);
    fireEvent.click(screen.getByTestId("zoom-candidate"));
    fireEvent.click(screen.getByTestId("face-zoom-close"));
    expect(screen.queryByTestId("face-zoom")).toBeNull();
  });
});

describe("WebcamPane — the timeline", () => {
  it("tells a check apart from a caption, and says who was found", () => {
    // R12. The two are recorded separately precisely so a face recognised at
    // 21:00 is not confused with a frame described at 21:01, and a pane that
    // rendered them identically would give that distinction back.
    const h = harness();
    const state = testState({
      settings: watching(),
      visionTimeline: [check("2026-08-06T21:00:00.000Z", [matched()]), caption("2026-08-06T21:01:00.000Z")],
    });
    mount(<WebcamPane {...props(h, state)} />);

    const found = screen.getByTestId("timeline-check");
    expect(found).toHaveTextContent("Creator 71%");
    // Weight is shown as telemetry beside the confidence that actually decided.
    expect(found).toHaveTextContent("w 0.42");
    expect(screen.getByTestId("timeline-caption")).toHaveTextContent("A person sits at a desk.");
  });

  it("collapses a run of checks that found nobody into one row", () => {
    // R13. Five is a few seconds; a day is thousands. Nothing is dropped — the
    // row says how many and over what span, and the record keeps them all.
    const h = harness();
    const state = testState({
      settings: watching(),
      visionTimeline: [
        check("2026-08-06T21:00:00.000Z"),
        check("2026-08-06T21:00:03.000Z"),
        check("2026-08-06T21:00:06.000Z"),
        check("2026-08-06T21:00:09.000Z"),
        check("2026-08-06T21:00:12.000Z"),
      ],
    });
    mount(<WebcamPane {...props(h, state)} />);

    const rows = screen.getAllByTestId("timeline-absence");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("5 checks over 12s");
  });

  it("breaks a collapsed run where someone was actually seen", () => {
    // The collapse must not swallow the one event anybody cares about.
    const h = harness();
    const state = testState({
      settings: watching(),
      visionTimeline: [
        check("2026-08-06T21:00:00.000Z"),
        check("2026-08-06T21:00:03.000Z"),
        check("2026-08-06T21:00:06.000Z", [matched()]),
        check("2026-08-06T21:00:09.000Z"),
        check("2026-08-06T21:00:12.000Z"),
      ],
    });
    mount(<WebcamPane {...props(h, state)} />);

    expect(screen.getAllByTestId("timeline-absence")).toHaveLength(2);
    expect(screen.getAllByTestId("timeline-check")).toHaveLength(1);
  });

  it("says the window is bounded rather than truncating in silence", () => {
    // R14. The pane holds a window; the record holds everything. A list that
    // simply stopped at the top would read as "this is all there was".
    const h = harness();
    const state = testState({
      settings: watching(),
      visionTimelineWindow: 3,
      visionTimeline: [
        caption("2026-08-06T21:00:00.000Z", "one"),
        caption("2026-08-06T21:00:01.000Z", "two"),
        caption("2026-08-06T21:00:02.000Z", "three"),
      ],
    });
    mount(<WebcamPane {...props(h, state)} />);

    expect(screen.getByTestId("vision-timeline-bound")).toHaveTextContent("the last 3 entries");
  });

  it("says nothing about a bound nobody has reached", () => {
    const h = harness();
    const state = testState({
      settings: watching(),
      visionTimelineWindow: 200,
      visionTimeline: [caption("2026-08-06T21:00:00.000Z", "one")],
    });
    mount(<WebcamPane {...props(h, state)} />);

    expect(screen.queryByTestId("vision-timeline-bound")).not.toBeInTheDocument();
  });

  it("shows an empty state rather than nothing at all", () => {
    const h = harness();
    mount(<WebcamPane {...props(h, testState({ settings: watching(), visionTimeline: [] }))} />);

    expect(screen.getByText(/No eyes yet/)).toBeInTheDocument();
  });

  it("reports a face it could detect but not describe as its own case", () => {
    // Not "unrecognised" — that blames the gallery for a missing embedder.
    const h = harness();
    const state = testState({
      settings: watching(),
      visionTimeline: [
        check("2026-08-06T21:00:00.000Z", [{ embedded: false, sourceWidth: 120 }]),
      ],
    });
    mount(<WebcamPane {...props(h, state)} />);

    expect(screen.getByTestId("timeline-check")).toHaveTextContent("a face it could not describe");
  });
});
