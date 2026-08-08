// The recogniser: a local process that finds faces in a frame and turns each
// one into a comparable vector.
//
// Pointed at rather than managed, exactly as the captioner and Ollama are
// (R2). HAL never starts it, supervises it, or stops it.
//
// It is stateless by construction — it tracks nothing between calls and
// returns everything per face — which is what leaves appearance continuity in
// HAL where R5 puts it. Nothing in this file should accumulate anything
// either; that job belongs to `appearances.ts`.

export class RecogniserError extends Error {
  constructor(
    message: string,
    readonly kind: "unreachable" | "slow" | "failed",
  ) {
    super(message);
    this.name = "RecogniserError";
  }
}

export interface DetectedFace {
  box: { x: number; y: number; w: number; h: number };
  score: number;
  landmarks: [number, number][];
  // Null when the recogniser's embedder is unavailable. Detection is the half
  // that still works, and a null must never be treated as a zero vector — it
  // would score 0 against everything and read as a confident non-match.
  embedding: number[] | null;
  // How well the five landmarks fitted the canonical template, in template
  // pixels. Low is good. A poor alignment means a less trustworthy embedding.
  alignment: number;
}

export interface DetectResult {
  width: number;
  height: number;
  faces: DetectedFace[];
}

// What `/health` reports. The two legs are separate because the recogniser
// distinguishes "cannot detect" from "cannot match", and collapsing them would
// throw away the distinction its model-fetch guarantee was built to preserve.
export interface RecogniserHealth {
  // The process answered and identified itself as a recogniser.
  reachable: boolean;
  detector: string;
  embedder: string;
}

export interface Recogniser {
  detect(jpeg: Buffer, signal?: AbortSignal): Promise<DetectResult>;
  probe(): Promise<RecogniserHealth>;
}

// The identifier the recogniser puts in its own health response. Checked rather
// than assumed: a bare 200 from something else holding the port must not read
// as a healthy recogniser. `docs/solutions/diagnosing-a-process-that-isnt-your-code.md`
// records four instances of that lesson, most recently a probe satisfied by a
// previous run's process, which then wrote artifacts that looked like proof.
const SERVICE_ID = "hal1000-recogniser";

// Short where the captioner's is generous, and for the opposite reason. A
// captioner on CPU takes tens of seconds by design, so a blown deadline there
// means "still thinking". Detection costs single-digit milliseconds, so seconds
// of silence means something is wrong — and R8 wants that reported as its own
// condition rather than as absence.
const DEFAULT_TIMEOUT_MS = 5_000;
const PROBE_TIMEOUT_MS = 3_000;

// SFace returns 128. Anything wildly larger is a malformed or hostile response,
// not a model we recognise, and would otherwise be stored and cosine'd forever.
const MAX_EMBEDDING_DIMS = 4_096;

// A camera scene has a handful of faces. A response claiming thousands is
// malformed, and each one costs a warp, a crop and a queue offer.
const MAX_FACES = 64;

export class HttpRecogniser implements Recogniser {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  async detect(jpeg: Buffer, signal?: AbortSignal): Promise<DetectResult> {
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const composed = signal ? AbortSignal.any([signal, deadline]) : deadline;

    let res: Response;
    try {
      res = await fetch(`${this.trimmed()}/detect`, {
        method: "POST",
        headers: { "content-type": "image/jpeg" },
        body: new Uint8Array(jpeg),
        signal: composed,
        // Refuse redirects. Whole camera frames cross this boundary, and a
        // process holding the configured port could otherwise 302 them to a
        // host the user never named — off the machine entirely.
        redirect: "error",
      });
    } catch (err) {
      // The caller's own cancellation is not a fault of the recogniser.
      if (signal?.aborted) throw new RecogniserError("Detection was cancelled.", "failed");
      // A recogniser that is merely slow is not one that is missing. R8 makes
      // this distinction explicit because the two send a user looking in
      // completely different places.
      if (deadline.aborted) {
        throw new RecogniserError(
          `The recogniser did not answer within ${Math.round(this.timeoutMs / 1000)}s.`,
          "slow",
        );
      }
      throw new RecogniserError(`The recogniser at ${this.trimmed()} is not reachable.`, "unreachable");
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new RecogniserError(
        `The recogniser returned ${res.status}. ${detail.slice(0, 200)}`.trim(),
        "failed",
      );
    }

    const parsed = (await res.json().catch(() => null)) as DetectResult | null;
    if (!parsed || !Array.isArray(parsed.faces)) {
      throw new RecogniserError("The recogniser returned an unreadable response.", "failed");
    }
    return {
      width: parsed.width,
      height: parsed.height,
      faces: parsed.faces.slice(0, MAX_FACES).map(normalizeFace),
    };
  }

  async probe(): Promise<RecogniserHealth> {
    try {
      const res = await fetch(`${this.trimmed()}/health`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        redirect: "error",
      });
      if (!res.ok) return absent();
      const body = (await res.json().catch(() => null)) as Partial<{
        service: string;
        detector: string;
        embedder: string;
      }> | null;
      // Identity, not liveness. Something else answering 200 on this port is
      // not a recogniser, and reporting it as one is how a probe manufactures
      // false evidence.
      if (!body || body.service !== SERVICE_ID) return absent();
      return {
        reachable: true,
        detector: body.detector ?? "unknown",
        embedder: body.embedder ?? "unknown",
      };
    } catch {
      return absent();
    }
  }

  private trimmed(): string {
    return this.baseUrl.replace(/\/+$/, "");
  }
}

function absent(): RecogniserHealth {
  return { reachable: false, detector: "unreachable", embedder: "unreachable" };
}

// Tolerant of a response missing optional pieces, strict about the one field
// whose absence must not be papered over: a missing embedding stays null.
function normalizeFace(face: Partial<DetectedFace>): DetectedFace {
  return {
    box: face.box ?? { x: 0, y: 0, w: 0, h: 0 },
    score: typeof face.score === "number" ? face.score : 0,
    landmarks: Array.isArray(face.landmarks) ? face.landmarks : [],
    // Every element must be finite. One NaN or Infinity from the sidecar makes
    // every cosine against this vector NaN, and a NaN score used to pass the
    // match threshold as a confident identification. Rejecting the vector here
    // is the first of the two guards; `PeopleStore.match` is the second.
    embedding:
      Array.isArray(face.embedding) &&
      face.embedding.length > 0 &&
      face.embedding.length <= MAX_EMBEDDING_DIMS &&
      face.embedding.every((v) => typeof v === "number" && Number.isFinite(v))
        ? face.embedding
        : null,
    alignment: typeof face.alignment === "number" ? face.alignment : Number.POSITIVE_INFINITY,
  };
}

// Both vectors arrive unit-length from the recogniser, so this is a dot
// product. Kept total rather than throwing on a length mismatch: a mismatch
// means a model changed underneath us, and scoring zero is a safe answer where
// an exception mid-detection is not.
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    na += (a[i] ?? 0) ** 2;
    nb += (b[i] ?? 0) ** 2;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
