import { cleanup, render } from "@testing-library/react";
import { afterEach, expect } from "vitest";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { ReactElement } from "react";
import type { ClientMessage, Monitor, MonitorSuggestion, Settings } from "../../../shared/src/types";
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
    shared: { endpoint: "http://localhost:11434", protocol: "auto", hasKey: false },
    chat: { enabled: false, endpoint: "", protocol: "auto", hasKey: false },
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
