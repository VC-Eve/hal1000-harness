import crypto from "node:crypto";
import path from "node:path";
import { appendJsonl, dayStamp, safeSegment } from "../storage/jsonl.js";

// The inference log: every request HAL sends to a model, with its input and
// its output, written where it can be analysed later.
//
// Nothing else in the app retains a prompt or a completion. The feed keeps
// HAL's finished sentences and the conversation store keeps chat turns, but
// what was actually asked of a model — the system prompt in force, the event
// lines a narration was built from, the caption a frame produced — existed
// only in memory for the length of one call. That is the gap this closes.
//
// Deliberately not the feed's storage and not the conversation store's: this
// is an audit trail about the models, keyed by the thing that provoked the
// call, and it is written even when the call fails.

export type InferenceKind =
  // A user-facing chat turn, keyed by conversation.
  | "chat"
  // Session narration, keyed by the Claude Code session whose events produced
  // it — one file per followed log, which is what makes a single session's
  // narration history readable on its own.
  | "session"
  // Monitor narration, keyed by monitor id.
  | "monitor"
  // A Vision cycle summary. One stream, so no id.
  | "vision"
  // One frame described by the captioner. Separate from `vision` because it is
  // a different model on a different endpoint, at a completely different rate.
  | "vision-caption";

// Who provoked the call. `id` is what splits the log into per-source files;
// `label` is only for a reader, and never affects the path.
export interface InferenceSource {
  kind: InferenceKind;
  id?: string | null;
  label?: string;
}

// Counts as the provider reported them. Optional throughout: a provider that
// does not report usage should log a call with no numbers rather than zeros,
// which would read as a real measurement of nothing.
export interface InferenceMetrics {
  promptTokens?: number;
  outputTokens?: number;
  totalDurationMs?: number;
}

export interface InferenceMessage {
  role: string;
  content: string;
}

export interface InferenceRecord {
  id: string;
  at: string;
  source: InferenceSource;
  model: string;
  endpoint: string;
  // Split out of `input` as well as left in it: the system prompt is the field
  // most analysis groups by, and digging it out of a message array every time
  // is friction for no reason.
  system: string | null;
  input: InferenceMessage[];
  // Present on every outcome. A failed call logs what streamed before the
  // failure — a truncated completion is evidence, and discarding it would
  // leave the most interesting records empty.
  output: string;
  outcome: "ok" | "error" | "aborted";
  error?: { code: string; message: string };
  // Wall-clock from request to last token, measured here rather than taken
  // from the provider: it includes the queue-free portion of the call as the
  // app actually experienced it.
  durationMs: number;
  outputChars: number;
  metrics?: InferenceMetrics;
  // Set for a caption: the retained frame this call described, so a record can
  // be read back against the picture that produced it.
  frame?: string;
}

/**
 * Where inference records land.
 *
 * `inference/<kind>/<id>/<YYYY-MM-DD>.jsonl`, or `inference/<kind>/<date>.jsonl`
 * for a source with no id. A directory per source is what the "one identifying
 * file per log we follow" requirement asks for; every record still carries its
 * full source, so the files concatenate into one timeline whenever a
 * cross-source question is the one being asked.
 *
 * Never prunes. The retention decision was made explicitly: these records are
 * the long-horizon analysis material, and a log that quietly deletes the
 * period you wanted to study is worse than a large directory.
 */
export class InferenceLog {
  private readonly root: string;

  constructor(dataRoot: string) {
    this.root = path.join(dataRoot, "inference");
  }

  fileFor(source: InferenceSource, at = new Date()): string {
    const dir = source.id
      ? path.join(this.root, source.kind, safeSegment(source.id))
      : path.join(this.root, source.kind);
    return path.join(dir, `${dayStamp(at)}.jsonl`);
  }

  // Failures are reported and swallowed. A full disk must not take down a chat
  // turn or wedge the narration pump — the log is an observer of the app, not
  // a participant in it.
  async append(record: InferenceRecord): Promise<void> {
    try {
      await appendJsonl(this.fileFor(record.source, new Date(record.at)), record);
    } catch (err) {
      console.error(`inference log write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export function newInferenceId(): string {
  return crypto.randomUUID();
}
