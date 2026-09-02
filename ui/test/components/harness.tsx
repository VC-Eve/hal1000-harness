import { cleanup, render } from "@testing-library/react";
import { afterEach, expect } from "vitest";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { ReactElement } from "react";
import type {
  ClientMessage,
  LibraryListing,
  LiveState,
  Monitor,
  MonitorSuggestion,
  Settings,
  World,
  WorldReports,
} from "../../../shared/src/types";
import { worldReports } from "../../../shared/src/world-graph";
import { WORLD_VERSION } from "../../../shared/src/worlds";
import { initialState, type AppState } from "../../src/store";

// Component-test harness.
//
// This exists because two real defects shipped past a full suite and a
// ten-reviewer code review: the whole UI went unverified, and a request loop in
// a mount effect hammered the server at render speed. Neither was reachable
// from a pure-module test, because neither is pure — they are about what the
// DOM shows and how often an effect runs.
//
// Scope is deliberately narrow. This is not for asserting the HAL aesthetic,
// which AGENTS.md says is verified by screenshot. It is for behaviour a reader
// cannot check by eye: disabled states, what gets sent, and how many times.

expect.extend(matchers);

// Every test unmounts. Without this a component's effects keep running into the
// next test, which is exactly the class of bug this harness exists to catch.
afterEach(cleanup);

export const testSettings = (over: Partial<Settings> = {}): Settings => ({
  backends: {
    observation: { endpoint: "http://localhost:11434", protocol: "auto", hasKey: false },
    chat: { endpoint: "http://localhost:11434", protocol: "auto", hasKey: false },
  },
  chatModel: "test-model",
  narrationModel: null,
  narrationPrompt: null,
  chatDefaultPrompt: null,
  monitorPrompt: null,
  chatContextPreamble: null,
  personaIntensity: "medium",
  watchedSessionId: null,
  chatContextCap: 8192,
  // Unacknowledged, as it ships. The fixture's endpoint is loopback, so the
  // gate does not fire for tests that are not about it.
  offMachineAcknowledged: false,
  // Every template unedited, as it ships: each resolves to the shipped default
  // and no fixture silently pins wording a release may improve.
  templates: {},
  templateBaselines: {},
  adapters: { "claude-code": { enabled: true, color: "#e8c8c2" } },
  chatColors: { user: "#d6d6d2", assistant: "#d6d6d2" },
  // Off, as it ships: a fixture that enabled Vision would have every component
  // test rendering a role the test is not about.
  vision: {
    enabled: false,
    device: null,
    captionerEndpoint: "http://127.0.0.1:8099",
    intervalSeconds: 60,
    cycleSeconds: 300,
    sensitivity: "medium",
    color: "#5fd3a6",
    retainFrames: 20,
    prompt: null,
    captionPrompt: null,
    // Off for the same reason Vision is: a fixture that enabled recognition
    // would put the strip in front of every pane test that is not about it.
    recognitionEnabled: false,
    recogniserEndpoint: "http://127.0.0.1:8100",
    detectionIntervalSeconds: 3,
    confidenceThreshold: 0.5,
    statementThreshold: 0.6,
    candidateFaces: 20,
    queueUncertainMatches: false,
    weightHalfLifeSeconds: 120,
    weightGain: 0.35,
  },
  ...over,
});

export const testMonitor = (over: Partial<Monitor> = {}): Monitor => ({
  id: "m1",
  label: "Ollama server log",
  source: { kind: "file", path: "/tmp/ollama.log" },
  verbosity: "quiet",
  cycleMs: 300_000,
  color: "#9ec5d8",
  enabled: true,
  ...over,
});

export const testSuggestion = (over: Partial<MonitorSuggestion> = {}): MonitorSuggestion => ({
  id: "s1",
  label: "systemd journal",
  reason: "The whole machine's log.",
  source: { kind: "command", command: "journalctl -n 200", intervalMs: 120_000 },
  available: true,
  ...over,
});

/**
 * A small machine: two States, a transition between them, and one Bool.
 *
 * Deliberately complete enough to run — a fixture with no clip would make every
 * player test assert the empty case by accident.
 */
export const testWorld = (over: Partial<World> = {}): World => ({
  version: WORLD_VERSION,
  id: "lounge",
  name: "Lounge",
  defaultStateId: "s-couch",
  states: [
    { id: "s-couch", name: "couch", clip: { path: "clips/couch-idle.mp4", durationMs: 4000 }, x: 100, y: 100 },
    { id: "s-booth", name: "booth", clip: { path: "clips/booth-idle.mp4", durationMs: 4000 }, x: 400, y: 100 },
  ],
  transitions: [
    {
      id: "t1",
      from: "s-couch",
      to: "s-booth",
      conditions: [{ parameter: "ready", op: "is", value: true }],
      hasExitTime: true,
      exitTime: 1,
      order: 0,
    },
  ],
  parameters: [{ name: "ready", type: "bool", defaultValue: false }],
  ...over,
});

export const testLive = (over: Partial<LiveState> = {}): LiveState => ({
  worldId: "lounge",
  stateId: "s-couch",
  clip: { path: "clips/couch-idle.mp4", durationMs: 4000 },
  parameters: { ready: false },
  generation: 7,
  fault: null,
  ...over,
});

/** Derived by the same function the server uses, so no fixture invents a report. */
export const testReports = (world: World): WorldReports => worldReports(world);

/** One folder of the clip library, as the server would answer a browse. */
export const testListing = (over: Partial<LibraryListing> = {}): LibraryListing => ({
  folder: "/takes",
  parent: "/",
  folders: [{ name: "old", path: "/takes/old" }],
  clips: [
    { name: "couch-idle.mp4", path: "/takes/couch-idle.mp4", sizeBytes: 2048 },
    { name: "booth-idle.mp4", path: "/takes/booth-idle.mp4", sizeBytes: 4096 },
  ],
  ...over,
});

export const testState = (over: Partial<AppState> = {}): AppState => ({
  ...initialState,
  connection: "open",
  settings: testSettings(),
  ...over,
});

export interface Harness {
  sent: ClientMessage[];
  send: (msg: ClientMessage) => void;
  // How many of a given message type have been sent so far — the assertion the
  // request-loop regression turns on.
  countOf: (type: ClientMessage["type"]) => number;
}

// A recording `send`, stable across renders exactly as App's is. Stability is
// load-bearing: an unstable `send` is what made a mount effect re-run forever,
// so a harness that handed out a fresh function each render would hide the very
// bug this is here to catch.
export function harness(): Harness {
  const sent: ClientMessage[] = [];
  return {
    sent,
    send: (msg: ClientMessage) => {
      sent.push(msg);
    },
    countOf: (type) => sent.filter((m) => m.type === type).length,
  };
}

export function mount(ui: ReactElement) {
  return render(ui);
}
