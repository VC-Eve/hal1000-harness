// The two ONNX models, and how they get here.
//
// YuNet is 227KB and committed. SFace is 37MB and fetched once on first run
// (R35), because thirty-seven megabytes in git is a cost every clone pays
// forever. That split follows the captioner, whose weights also arrive on
// first run rather than in the repo.
//
// The hash each file is checked against is not one we computed from whatever
// arrived first. `opencv_zoo` keeps its ONNX files in git LFS, and the pointer
// file — served as plain text by raw.githubusercontent.com at the same path —
// carries `oid sha256:<digest>` and `size <bytes>` for the exact blob. Those
// are published by the model's own repository, so they are independent
// provenance rather than a record of our own first download. They protect
// against corruption, truncation and later substitution; they are not a
// signature, and this file does not pretend otherwise.

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type ModelState =
  // Present on disk and matching its published digest.
  | "ok"
  // The one-time download is in flight.
  | "fetching"
  // The download could not be reached or did not complete.
  | "unreachable"
  // Bytes arrived but did not match the published digest or length. The file
  // is not installed; this is distinct from "unreachable" because the network
  // worked and the artifact is wrong, which is a different thing to tell a
  // user and a different thing to retry.
  | "corrupt"
  // Not on disk and no fetch has been attempted.
  | "absent";

export interface ModelSpec {
  readonly name: string;
  readonly file: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly url: string;
  // Committed models are never fetched: an absent one means a broken checkout,
  // not a first run, and downloading over it would hide that.
  readonly committed: boolean;
}

// Pinned to the exact dated releases the spike measured and the origin brief's
// Measured Constraints were taken against — not to a moving alias of "the
// current model". A different export can change the tensor layout, the input
// size, or the landmark order, none of which fail loudly.
export const YUNET: ModelSpec = {
  name: "yunet",
  file: "face_detection_yunet_2023mar.onnx",
  sha256: "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4",
  bytes: 232589,
  url: "https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx",
  committed: true,
};

export const SFACE: ModelSpec = {
  name: "sface",
  file: "face_recognition_sface_2021dec.onnx",
  sha256: "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79",
  bytes: 38696353,
  url: "https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx",
  committed: false,
};

export class ModelStore {
  private readonly states = new Map<string, ModelState>();

  constructor(
    private readonly dir: string,
    private readonly fetchAllowed: boolean,
  ) {}

  pathFor(spec: ModelSpec): string {
    return path.join(this.dir, spec.file);
  }

  state(spec: ModelSpec): ModelState {
    return this.states.get(spec.name) ?? "absent";
  }

  // Bring a model to "ok" if it can be. Verifies what is already on disk,
  // fetches once when it is missing and fetching is allowed, and records the
  // outcome either way. Never throws: a model that cannot be had is a reported
  // state, because R35's failure mode is "says so through readiness" rather
  // than a process that will not start.
  async ensure(spec: ModelSpec): Promise<ModelState> {
    const target = this.pathFor(spec);

    const onDisk = await this.verifyFile(target, spec);
    if (onDisk === "ok") return this.set(spec, "ok");
    // Bytes are present and wrong. Refetching would overwrite evidence of a
    // corrupted checkout for a committed model, and for a fetched one the
    // installer below already deletes its own failures — so anything wrong
    // that survived to here is reported rather than papered over.
    if (onDisk === "corrupt") return this.set(spec, "corrupt");

    if (spec.committed) {
      // A committed model that is absent is a broken checkout. Downloading it
      // silently would make a mangled clone look healthy.
      return this.set(spec, "absent");
    }
    if (!this.fetchAllowed) return this.set(spec, "absent");

    this.set(spec, "fetching");
    return this.set(spec, await this.download(spec, target));
  }

  // Present-and-correct, present-and-wrong, or not present.
  private async verifyFile(file: string, spec: ModelSpec): Promise<"ok" | "corrupt" | "absent"> {
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(file);
    } catch {
      return "absent";
    }
    return matches(bytes, spec) ? "ok" : "corrupt";
  }

  private async download(spec: ModelSpec, target: string): Promise<ModelState> {
    // Unique temp name then rename, the discipline `server/src/storage/atomic.ts`
    // applies to conversation writes and for the same reason: a truncated 37MB
    // file that looks installed is worse than no file at all.
    const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
    try {
      await fs.mkdir(this.dir, { recursive: true });
      const res = await fetch(spec.url, { signal: AbortSignal.timeout(300_000) });
      if (!res.ok) return "unreachable";
      const bytes = Buffer.from(await res.arrayBuffer());

      if (!matches(bytes, spec)) {
        // Nothing is written. The next start retries rather than pinning a bad
        // artifact, which is why the temp file is removed rather than kept.
        await fs.rm(temp, { force: true }).catch(() => {});
        return "corrupt";
      }

      await fs.writeFile(temp, bytes);
      await fs.rename(temp, target);
      return "ok";
    } catch {
      await fs.rm(temp, { force: true }).catch(() => {});
      return "unreachable";
    }
  }

  private set(spec: ModelSpec, state: ModelState): ModelState {
    this.states.set(spec.name, state);
    return state;
  }
}

// Length first: a truncated transfer is the common failure and saying so is
// more useful than "the digest did not match", which reads as tampering.
export function matches(bytes: Buffer, spec: ModelSpec): boolean {
  if (bytes.length !== spec.bytes) return false;
  return sha256(bytes) === spec.sha256;
}

export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
