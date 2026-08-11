import { describe, it, expect } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { WebcamPane } from "../../src/components/WebcamPane";
import { harness, mount, testSettings, testState } from "./harness";
import type { AppState } from "../../src/store";
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

const seen = (
  over: Partial<{
    id: string;
    match: { personId: string; name: string; confidence: number } | null;
    currentConfidence: number | null;
    weight: number;
    embedded: boolean;
  }> = {},
) => ({
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
      visionAppearances: [
        seen({ match: { personId: "p1", name: "Dave", confidence: 0.92 }, currentConfidence: 0.92 }),
      ],
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
      visionAppearances: [
        seen({ match: { personId: "p1", name: "Dave", confidence: 0.55 }, currentConfidence: 0.55 }),
      ],
    });
    mount(<WebcamPane {...props(h, state)} />);

    const identity = screen.getByTestId("vision-identity");
    expect(identity.dataset.band).toBe("hedged");
    expect(identity.textContent).toContain("someone who looks like");
    expect(identity.textContent).toContain("55%");
  });

  describe("the number it shows is this check's, not the visit's first", () => {
    // Reported from the running instance: the strip sat on one percentage
    // while the timeline beside it moved every few seconds. `match` is decided
    // when the appearance opens and never revisited, so rendering it here can
    // only ever show a frozen value — the defect
    // a-value-frozen-for-one-caller-is-stale-for-the-next.md records, in a
    // second consumer after the first was fixed.

    it("renders the live reading rather than the standing decision", () => {
      const h = harness();
      const state = testState({
        settings: recognising(),
        visionAppearances: [
          seen({ match: { personId: "p1", name: "Dave", confidence: 0.92 }, currentConfidence: 0.64 }),
        ],
      });
      mount(<WebcamPane {...props(h, state)} />);
      const identity = screen.getByTestId("vision-identity");
      expect(identity.textContent).toContain("64%");
      expect(identity.textContent).not.toContain("92%");
    });

    it("keeps the band on the standing decision, so it cannot flicker mid-visit", () => {
      // The opposite pull. Banding off the live reading would swing between
      // "Dave" and "someone who looks like Dave" across one continuous visit,
      // which is the flicker appearance continuity exists to prevent.
      const h = harness();
      const state = testState({
        settings: recognising(),
        visionAppearances: [
          seen({ match: { personId: "p1", name: "Dave", confidence: 0.92 }, currentConfidence: 0.51 }),
        ],
      });
      mount(<WebcamPane {...props(h, state)} />);
      const identity = screen.getByTestId("vision-identity");
      expect(identity.dataset.band).toBe("stated");
      expect(identity.textContent).not.toContain("someone who looks like");
    });

    it("shows a dash when this check claimed no face for the appearance", () => {
      const h = harness();
      const state = testState({
        settings: recognising(),
        visionAppearances: [
          seen({ match: { personId: "p1", name: "Dave", confidence: 0.92 }, currentConfidence: null }),
        ],
      });
      mount(<WebcamPane {...props(h, state)} />);
      const identity = screen.getByTestId("vision-identity");
      expect(identity.textContent).toContain("—");
      expect(identity.textContent).not.toContain("92%");
    });

    it("shows the recognition weight beside the reading", () => {
      const h = harness();
      const state = testState({
        settings: recognising(),
        visionAppearances: [
          seen({ match: { personId: "p1", name: "Dave", confidence: 0.7 }, currentConfidence: 0.7, weight: 0.9 }),
        ],
      });
      mount(<WebcamPane {...props(h, state)} />);
      expect(screen.getByTestId("vision-identity").textContent).toContain("w 0.90");
    });

    it("omits the weight rather than printing a zero for one it does not have", () => {
      const h = harness();
      const state = testState({
        settings: recognising(),
        visionAppearances: [
          seen({ match: { personId: "p1", name: "Dave", confidence: 0.7 }, currentConfidence: 0.7 }),
        ],
      });
      mount(<WebcamPane {...props(h, state)} />);
      expect(screen.getByTestId("vision-identity").textContent).not.toContain("w ");
    });
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

describe("WebcamPane — setting a face aside", () => {
  const pending = (over = {}) => ({
    id: "p1",
    at: "2026-08-11T09:00:00.000Z",
    thumbnail: "data:image/jpeg;base64,AA",
    ...over,
  });

  const shelved = (over = {}) => pending({ id: "s1", setAsideAt: "2026-08-11T10:00:00.000Z", ...over });

  const withPools = (candidates: ReturnType<typeof pending>[], over: Partial<AppState> = {}) =>
    testState({ settings: recognising(), visionCandidates: candidates, ...over });

  function openShelf() {
    fireEvent.click(screen.getByTestId("triage-set-aside-toggle"));
  }

  it("keeps a shelved face out of the active row and a pending one in it", () => {
    // The assertion the wire field exists for. A client that ignored the marker
    // would render both faces in the active row and this would fail — which is
    // the point: a flag nothing reads looks shipped.
    const h = harness();
    mount(<WebcamPane {...props(h, withPools([pending(), shelved()]))} />);

    const active = within(screen.getByTestId("triage-row")).getAllByTestId("triage-face");
    expect(active).toHaveLength(1);
    expect(within(active[0]!).getByTestId("triage-later")).toBeInTheDocument();

    openShelf();
    expect(within(screen.getByTestId("triage-set-aside-row")).getAllByTestId("triage-face")).toHaveLength(1);
  });

  it("sets a face aside and does nothing else", () => {
    const h = harness();
    mount(<WebcamPane {...props(h, withPools([pending({ id: "c7" })]))} />);

    fireEvent.click(screen.getByTestId("triage-later"));
    expect(h.sent).toEqual([{ type: "set-aside-candidate", id: "c7" }]);
  });

  it("offers later on a hedged card as well as an unrecognised one", () => {
    // R1 covers both kinds. A face you cannot decide about is at least as
    // likely to be one HAL half-recognised as one it did not know at all.
    const h = harness();
    const suspected = pending({ suspected: { personId: "p9", name: "Dave", confidence: 0.55 } });
    mount(<WebcamPane {...props(h, withPools([suspected]))} />);

    fireEvent.click(screen.getByTestId("triage-later"));
    expect(h.sent).toEqual([{ type: "set-aside-candidate", id: "p1" }]);
  });

  it("restores a shelved face to the active queue", () => {
    const h = harness();
    mount(<WebcamPane {...props(h, withPools([shelved({ id: "s9" })]))} />);

    openShelf();
    fireEvent.click(screen.getByTestId("triage-restore"));
    expect(h.sent).toEqual([{ type: "restore-candidate", id: "s9" }]);
  });

  it("does not offer later on a face already set aside", () => {
    const h = harness();
    mount(<WebcamPane {...props(h, withPools([shelved()]))} />);

    openShelf();
    expect(screen.queryByTestId("triage-later")).toBeNull();
  });

  it("names a shelved face by the same path as a pending one", () => {
    // R2. The shelf is not a dead end: naming and dismissing still work, and
    // enrolment carries the candidate id so it is that face that lands.
    const h = harness();
    mount(<WebcamPane {...props(h, withPools([shelved({ id: "s4" })]))} />);

    openShelf();
    fireEvent.click(screen.getByTestId("triage-name"));
    fireEvent.change(screen.getByTestId("triage-name-input"), { target: { value: "Marvin" } });
    fireEvent.click(screen.getByTestId("triage-save"));

    expect(h.sent).toEqual([{ type: "enrol-person", name: "Marvin", candidateId: "s4" }]);
  });

  it("dismisses a shelved face", () => {
    const h = harness();
    mount(<WebcamPane {...props(h, withPools([shelved({ id: "s5" })]))} />);

    openShelf();
    fireEvent.click(screen.getByTestId("triage-dismiss"));
    expect(h.sent).toEqual([{ type: "dismiss-candidate", id: "s5" }]);
  });

  it("reaches the roster datalist from the shelf, not only from the active row", () => {
    // One datalist for both sections. Two would share the id, `list=` would
    // resolve to whichever rendered first, and autocomplete would quietly stop
    // working in the other place R2 requires naming to work.
    const h = harness();
    const people = [
      { id: "p-liam", name: "Liam", createdAt: "2026-08-01T00:00:00.000Z", faceCount: 2, thumbnail: "data:,BB" },
    ];
    mount(<WebcamPane {...props(h, withPools([shelved()], { visionPeople: people }))} />);

    openShelf();
    fireEvent.click(screen.getByTestId("triage-name"));
    const input = screen.getByTestId("triage-name-input");
    expect(input.getAttribute("list")).toBe("vision-known-people");
    expect(document.querySelectorAll("#vision-known-people option")).toHaveLength(1);

    fireEvent.change(input, { target: { value: "liam " } });
    expect(screen.getByTestId("triage-merge-hint").textContent).toContain("Liam");
  });

  it("hides the section when nothing is set aside", () => {
    const h = harness();
    mount(<WebcamPane {...props(h, withPools([pending()]))} />);
    expect(screen.queryByTestId("triage-set-aside")).toBeNull();
  });

  it("states the count and the bound in the header, unopened", () => {
    // R5: the bound is said, not discovered after it bites. It shows collapsed
    // because a shelf silently filling up is one that starts evicting without
    // warning.
    const h = harness();
    const state = withPools([shelved(), shelved({ id: "s2" })], {
      settings: recognising({ setAsideFaces: 25 }),
    });
    mount(<WebcamPane {...props(h, state)} />);

    expect(screen.getByTestId("triage-set-aside-toggle").textContent).toContain("2 of 25");
    expect(screen.queryByTestId("triage-set-aside-row")).toBeNull();
  });

  it("still renders the block when the active queue is empty and the shelf is not", () => {
    // The state this feature produces most often. A guard that only counted the
    // active list would make setting aside your only face hide the section
    // holding it.
    const h = harness();
    mount(<WebcamPane {...props(h, withPools([shelved()]))} />);

    expect(screen.getByTestId("vision-triage")).toBeInTheDocument();
    expect(screen.getByTestId("triage-set-aside")).toBeInTheDocument();
    expect(within(screen.getByTestId("triage-row")).queryAllByTestId("triage-face")).toHaveLength(0);
  });

  it("reports what the shelf's own bound dropped, in its own words", () => {
    const h = harness();
    const state = withPools([], {
      visionSetAsideOverflow: { dropped: 3, since: "2026-08-11T09:00:00.000Z" },
    });
    mount(<WebcamPane {...props(h, state)} />);

    const notice = screen.getByTestId("triage-set-aside-overflow");
    expect(notice.textContent).toContain("3 faces you set aside were dropped");
    // Not the active queue's sentence, and not its advice: the setting it points
    // at is not the bound that bit here.
    expect(notice.textContent).not.toContain("before you looked");
    expect(notice.textContent).not.toContain("Raise the limit");
    expect(screen.queryByTestId("triage-overflow")).toBeNull();
  });

  it("keeps the two eviction tallies apart in both directions", () => {
    const h = harness();
    mount(
      <WebcamPane
        {...props(h, withPools([], { visionCandidateOverflow: { dropped: 2, since: "2026-08-11T09:00:00.000Z" } }))}
      />,
    );
    expect(screen.getByTestId("triage-overflow")).toBeInTheDocument();
    expect(screen.queryByTestId("triage-set-aside-overflow")).toBeNull();
  });

  it("acknowledges the shelf tally without clearing the active one", () => {
    const h = harness();
    const state = withPools([], { visionSetAsideOverflow: { dropped: 1, since: "2026-08-11T09:00:00.000Z" } });
    mount(<WebcamPane {...props(h, state)} />);

    fireEvent.click(screen.getByTestId("triage-set-aside-overflow-dismiss"));
    expect(h.sent).toEqual([{ type: "acknowledge-overflow", which: "setAside" }]);
  });

  it("says how often an arrival was taken for a face on the shelf", () => {
    // The instrument for whether 0.45 is right against a pool that does not
    // turn over. Uncounted, a stranger absorbed into someone else's card is a
    // person HAL saw and never mentioned.
    const h = harness();
    const state = withPools([], { visionShelfMatches: { matched: 4, since: "2026-08-11T09:00:00.000Z" } });
    mount(<WebcamPane {...props(h, state)} />);

    const notice = screen.getByTestId("triage-shelf-matches").textContent ?? "";
    expect(notice).toContain("On 4 days HAL took an arriving face for one you set aside");
    // Occasions, not people. "4 faces" invited the reading that four DIFFERENT
    // visitors had been absorbed, when the ordinary cause is one shelved regular
    // walking past again — which the per-day gate caps at one a day.
    expect(notice).toContain("once a day per shelved face");
    expect(notice).not.toContain("4 faces");
    fireEvent.click(screen.getByTestId("triage-shelf-matches-dismiss"));
    expect(h.sent).toEqual([{ type: "acknowledge-overflow", which: "shelfMatches" }]);
  });

  it("stays hidden when both pools are empty and all three tallies are zero", () => {
    const h = harness();
    mount(<WebcamPane {...props(h, withPools([]))} />);
    expect(screen.queryByTestId("vision-triage")).toBeNull();
  });

  it("renders a refused restore rather than failing silently", () => {
    // The one triage verb the server can refuse. Without this the click would
    // appear to do nothing at all.
    const h = harness();
    const state = withPools([shelved()], {
      visionRosterResult: { confirm: { ok: false, error: "The waiting queue is full." } },
    });
    mount(<WebcamPane {...props(h, state)} />);

    expect(screen.getByTestId("triage-refusal").textContent).toContain("The waiting queue is full.");
  });

  it("says when a shelved face was seen again", () => {
    // A returning face updates the card rather than making a second one, so
    // without this the shelf would still read as last seen when it was first
    // captured.
    const h = harness();
    mount(<WebcamPane {...props(h, withPools([shelved({ lastSeenAt: "2026-08-11T14:30:00.000Z" })]))} />);

    openShelf();
    expect(screen.getByTestId("triage-seen-again")).toBeInTheDocument();
  });

  it("sends nothing on its own with faces in both pools", () => {
    // Repo convention: a caller re-creating `send` on every render must not
    // start a loop.
    const h = harness();
    const unstable = () => (msg: Parameters<typeof h.send>[0]) => h.send(msg);
    const state = withPools([pending(), shelved()]);

    const { rerender } = mount(<WebcamPane {...props(h, state)} send={unstable()} />);
    for (let i = 0; i < 5; i += 1) {
      rerender(<WebcamPane {...props(h, state)} send={unstable()} />);
    }

    expect(h.sent).toEqual([]);
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
