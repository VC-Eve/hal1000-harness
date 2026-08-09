// Appearance continuity — HAL's half of the bargain the sidecar was built for.
//
// The recogniser is stateless on purpose: it answers about one frame and
// tracks nothing between calls, so the question "is this the same person as a
// moment ago" lands here (R5). Detection fires every few seconds; a person
// stands in frame for minutes. Without this module the summariser would see a
// hundred identity decisions per visit, alternating between matched and
// unmatched, and read them as arrivals and departures — reproducing against
// people the fabricated-event defect
// `docs/residual-review-findings/feat-vision.md` records against the captioner.
//
// So: consecutive detections of one face collapse into ONE appearance carrying
// ONE identity decision (R4), and that decision is made on entry and never
// revisited while the appearance is open.
//
// Everything here is pure. No I/O, no clock of its own — time is passed in,
// the same injection `VisionService` already uses. That is what makes the
// acceptance examples testable as sequences rather than as timing.

import crypto from "node:crypto";
import type { Match } from "./people.js";
import { cosine, type DetectedFace } from "./recogniser.js";

/**
 * How long an appearance survives without a matching detection.
 *
 * The brief states the cost is two-sided and no value satisfies both: too
 * short and one visit refragments whenever a face turns away, restoring the
 * flood and the flicker; too long and a departure merges with a different
 * person's arrival, so the second person inherits the first's identity and is
 * never flagged.
 *
 * It errs short, per the brief's own asymmetry — a duplicate appearance is a
 * nuisance the user absorbs, while a missed stranger is the failure the
 * feature exists to prevent. At the default three-second detection interval
 * this tolerates two consecutive misses.
 *
 * A constant rather than a setting: R31 enumerates the recognition settings
 * and this is not among them. The brief deferred the value to planning, not
 * the knob to the user.
 */
export const APPEARANCE_GAP_MS = 10_000;

/**
 * How similar two faces must be, on the embedding alone, to count as the same
 * appearance.
 *
 * This started at 0.75 on the strength of the sidecar's measurement — same
 * person 0.93, non-face 0.21 — and running the real loop showed that number
 * was measured wrong. Those figures came from SYNTHETIC reframings of a single
 * captured frame: rotate it, scale it, shift it. Genuinely independent
 * captures, seconds apart, with ordinary movement and changing expression
 * between them, score 0.53 to 0.78 against each other.
 *
 * At 0.75 almost every detection opened a NEW appearance. One person sitting
 * still produced seventeen appearances in forty seconds, and a single
 * observation carried "someone who looks like SW" four times over — exactly
 * the flood and flicker R4 exists to prevent, arriving through the threshold
 * rather than through the absence of a tracker.
 *
 * So the bar for the embedding alone sits just under the observed floor.
 */
export const CONTINUITY_THRESHOLD = 0.62;

/**
 * The embedding bar when the two boxes also overlap substantially.
 *
 * A face occupying nearly the same pixels two seconds later is almost
 * certainly the same face, and the embedding's job there is only to not
 * contradict it. This is what absorbs the bottom of the observed range without
 * dropping the bar globally.
 *
 * It still refuses AE10's case — a different person stepping into the same
 * position inside the gap window — because two different people score well
 * below this against each other. That last claim is the weakest link in this
 * file: a non-face scores 0.21, but different-person-versus-same-person has
 * never been measured here, for want of a second face to measure it with.
 */
const CONTINUITY_WITH_OVERLAP = 0.45;

/**
 * The floor a face must clear to join an appearance on identity alone.
 *
 * Deliberately below both continuity bars — the whole point of the identity
 * signal is to survive drift those bars reject — but above the ~0.21 a non-face
 * scores and the ~0.26 expected of a different person. It exists so that a
 * false gallery match cannot silently absorb a stranger into someone else's
 * appearance; it is a sanity check, not a second identity decision.
 */
const IDENTITY_FLOOR = 0.3;

// How much two boxes must overlap to count as "the same place". Also the bar
// when neither face carries an embedding, and the tie-break when two open
// appearances are both plausible on similarity alone.
const BOX_OVERLAP_THRESHOLD = 0.3;

export interface Appearance {
  id: string;
  // Decided once, on entry. Null means unrecognised, which is a decision — not
  // an absence of one, and not a pending state to be retried.
  //
  // This is what HAL ACTS on: narration, banding, and profile delivery all read
  // it, and its stability across a visit is the whole point of this module.
  match: Match | null;
  // What the gallery said about the face this appearance claimed THIS frame.
  //
  // The lookup below already runs per face per frame for continuity; this stops
  // throwing the answer away. It exists because the vision timeline records
  // what each check FOUND, and reading `match` for that made every check in a
  // visit report the reading the appearance opened on — fifteen consecutive
  // entries of "Creator 61%" while the person moved around, and a weight that
  // could only rise because the confidence feeding it never changed.
  //
  // Null when this frame's embedding matched nobody, which is a real thing to
  // record: it is what a drifting face looks like from the recogniser's side.
  // Undefined only for an appearance that claimed no face this frame.
  currentMatch?: Match | null;
  // The highest confidence this visit has produced for the person it resolves
  // to. What the Identity Band is computed from.
  //
  // The band's setting promises "at or above this I say the name outright",
  // with no mention of when the reading was taken — so banding on the opening
  // frame alone broke that promise: a visit that opened at 0.55 stayed hedged
  // while every later frame read 0.68, and the pane showed "someone who looks
  // like Creator 68%" against a threshold of 0.6.
  //
  // A running maximum rather than the current frame, because it can then only
  // ever rise within a visit. That is what keeps the anti-flicker guarantee:
  // the reason the identity decision is frozen is that oscillation reads as
  // someone arriving and leaving, and a value that never falls cannot
  // oscillate. Only readings for the SAME person count — a different face
  // matching mid-visit must not promote this one.
  bestConfidence?: number;
  firstSeen: number;
  lastSeen: number;
  // False when the recogniser could detect but not embed. Such an appearance
  // is tracked by position and never named.
  embedded: boolean;
  box: { x: number; y: number; w: number; h: number };
}

// The in-flight face data R5 allows: held for the duration of the appearance
// and discarded when it ends. Kept off `Appearance` so nothing that leaves this
// module carries a biometric vector by accident.
interface Tracked extends Appearance {
  embedding: number[] | null;
}

// Consulted for a new appearance only, never for one already open.
export type GalleryLookup = (embedding: number[]) => Promise<Match | null>;

/**
 * The confidence an Identity Band is decided from.
 *
 * One function, so the pane, the caption line and the candidate queue cannot
 * disagree about what HAL believes — the drift that once had the pane
 * rebuilding the hedge as literal JSX while the server used a helper.
 *
 * Falls back to the opening decision when no better reading has been seen,
 * which is every appearance's first frame.
 */
export function bandConfidence(appearance: Pick<Appearance, "match" | "bestConfidence">): number {
  const opened = appearance.match?.confidence;
  const best = appearance.bestConfidence;
  const candidates = [opened, best].filter((n): n is number => typeof n === "number" && Number.isFinite(n));
  return candidates.length > 0 ? Math.max(...candidates) : Number.NEGATIVE_INFINITY;
}

export class AppearanceTracker {
  private tracked: Tracked[] = [];

  /**
   * Fold one detection result into the open set and return it.
   *
   * Assignment is greedy by similarity, strongest face first, and each open
   * appearance may claim AT MOST ONE face per call. That last rule is what
   * similarity alone would violate: two people in one frame are two
   * appearances however alike they look, because a frame physically contains
   * two people.
   */
  async observe(faces: DetectedFace[], now: number, gallery: GalleryLookup): Promise<Appearance[]> {
    // Close first, so a stale appearance cannot claim a face that arrived after
    // the gap elapsed.
    this.tracked = this.tracked.filter((a) => now - a.lastSeen <= APPEARANCE_GAP_MS);

    const claimed = new Set<string>();
    // Cleared before assignment, so an appearance that claims no face this
    // frame does not carry last frame's reading forward as though it were
    // current. It is the staleness this field exists to remove.
    for (const a of this.tracked) a.currentMatch = undefined;
    const ordered = [...faces].sort((a, b) => b.score - a.score);

    for (const face of ordered) {
      // The gallery is consulted per face per frame now, not only when an
      // appearance opens. It is a handful of dot products over an in-memory
      // roster, and it buys the strongest continuity signal there is: two
      // different people cannot both be the same enrolled person, so a face
      // matching P continues the open appearance that already resolves to P
      // no matter how much the embedding drifted between frames.
      //
      // The identity DECISION is still made once, on entry, and never
      // revisited while the appearance is open — that is what stops the
      // matched/unmatched flicker. This lookup only decides which appearance
      // a face belongs to.
      const match = face.embedding ? await gallery(face.embedding).catch(() => null) : null;

      const existing = this.bestOpen(face, claimed, match?.personId ?? null);
      if (existing) {
        claimed.add(existing.id);
        existing.lastSeen = now;
        existing.box = face.box;
        // The reading, kept. Not the decision — that stays where it was made.
        existing.currentMatch = match;
        // Raised only by a reading of the person this appearance already
        // resolves to, and only upward. Acceptance-shaped: a NaN confidence
        // fails `>` and leaves the running maximum alone rather than replacing
        // it with something that compares false against every threshold.
        if (match && existing.match && match.personId === existing.match.personId) {
          if (match.confidence > (existing.bestConfidence ?? Number.NEGATIVE_INFINITY)) {
            existing.bestConfidence = match.confidence;
          }
        }
        // The representative embedding tracks the most recent view, so a slowly
        // turning head stays continuous rather than drifting out of threshold
        // against its first frame.
        if (face.embedding) existing.embedding = face.embedding;
        continue;
      }

      const fresh: Tracked = {
        id: crypto.randomUUID(),
        match: null,
        currentMatch: match,
        firstSeen: now,
        lastSeen: now,
        embedded: face.embedding !== null,
        box: face.box,
        embedding: face.embedding,
      };
      fresh.match = match;
      if (match && Number.isFinite(match.confidence)) fresh.bestConfidence = match.confidence;
      this.tracked.push(fresh);
      claimed.add(fresh.id);
    }

    return this.open();
  }

  // What leaves this module: no embeddings, by construction.
  open(): Appearance[] {
    return this.tracked.map(({ embedding: _embedding, ...rest }) => ({ ...rest }));
  }

  // Vision switched off, or the recogniser endpoint changed. A closed
  // appearance's face data is dropped rather than archived (R5).
  reset(): void {
    this.tracked = [];
  }

  private bestOpen(face: DetectedFace, claimed: Set<string>, personId: string | null): Tracked | null {
    const candidates = this.tracked.filter((a) => !claimed.has(a.id));

    // Same person, same appearance. This is the signal that survives a head
    // turn, a change of expression, and a three-second gap — all the things
    // that drag raw frame-to-frame similarity down into the range where the
    // rules below start opening duplicates.
    if (personId && face.embedding) {
      // Identity is a strong signal, not an unconditional one.
      //
      // Returning here without any similarity check meant a single false
      // gallery match welded a stranger onto an enrolled person's appearance:
      // no new appearance opened, so the stranger was never queued for triage,
      // AND the rolling embedding update below then replaced the appearance's
      // representative face with the stranger's — leaving it tracking one
      // person under another's name. One bad match, three failures.
      //
      // So identity only RELAXES the bar it does not replace it. A face
      // claiming to be the same person still has to look vaguely like the
      // appearance it is joining.
      const sameIdentity = candidates
        .filter((a) => a.match?.personId === personId && a.embedded && a.embedding)
        .filter((a) => cosine(face.embedding!, a.embedding!) >= IDENTITY_FLOOR);
      if (sameIdentity.length > 0) {
        // If somehow several are open for one person, keep the oldest: it is
        // the appearance the identity decision was actually made on.
        return sameIdentity.reduce((oldest, a) => (a.firstSeen < oldest.firstSeen ? a : oldest));
      }
    }

    // An unembedded face may only continue an unembedded appearance, and vice
    // versa. Mixing them would let a face nobody can identify inherit a name
    // that was decided from a real embedding.
    if (!face.embedding) {
      const byBox = candidates
        .filter((a) => !a.embedded)
        .map((a) => ({ a, overlap: iou(a.box, face.box) }))
        .filter((c) => c.overlap > BOX_OVERLAP_THRESHOLD)
        .sort((l, r) => r.overlap - l.overlap);
      return byBox[0]?.a ?? null;
    }

    const scored = candidates
      .filter((a) => a.embedded && a.embedding)
      .map((a) => ({ a, score: cosine(face.embedding!, a.embedding!), overlap: iou(a.box, face.box) }))
      // Two ways to be the same appearance: convincing on the embedding alone,
      // or plausible on the embedding while occupying the same place. The
      // second is what makes a real visit hold together, since live captures
      // of one person span a wider range than a still frame reframed.
      .filter(
        (c) =>
          c.score >= CONTINUITY_THRESHOLD ||
          (c.score >= CONTINUITY_WITH_OVERLAP && c.overlap >= BOX_OVERLAP_THRESHOLD),
      )
      // Similarity decides; box overlap breaks a tie between two appearances
      // the embedding cannot separate.
      .sort((l, r) => r.score - l.score || r.overlap - l.overlap);

    return scored[0]?.a ?? null;
  }
}

function iou(a: Appearance["box"], b: Appearance["box"]): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}
