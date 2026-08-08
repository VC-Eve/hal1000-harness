// The vision timeline, as rows a person can read.
//
// The record is deliberately complete: every detection pass is written,
// including the ones that found nobody, because an absence that is only the gap
// between two entries is not evidence of anything. That completeness is exactly
// what makes the raw list unreadable — a check every few seconds is thousands
// of rows a day, and most of them say "nobody".
//
// So runs of nobody collapse into one row that says how many and over what
// span. Nothing is dropped: the count and the span are the whole run, and the
// record on disk is untouched. This is a rendering decision, not a retention
// one.

import type { VisionCheckFace, VisionEvent } from "../../shared/src/types";

export type TimelineRow =
  | { kind: "check"; at: string; faces: VisionCheckFace[] }
  | { kind: "caption"; at: string; caption: string }
  // A run of consecutive checks that found nobody. `at` is when the run began,
  // `until` when it ended; they are equal for a run of one.
  | { kind: "absence"; at: string; until: string; count: number };

const foundNobody = (event: VisionEvent): boolean => event.kind === "check" && event.faces.length === 0;

/**
 * Collapse a timeline into rows, oldest first.
 *
 * Only consecutive nobody-found checks collapse. Anything else — a match, a
 * caption — ends the run, so a person appearing mid-absence reads as two
 * separate stretches of empty room with the sighting between them, which is
 * what happened.
 */
export function timelineRows(events: VisionEvent[]): TimelineRow[] {
  const rows: TimelineRow[] = [];

  for (const event of events) {
    if (foundNobody(event)) {
      const last = rows.at(-1);
      if (last?.kind === "absence") {
        last.until = event.at;
        last.count += 1;
      } else {
        rows.push({ kind: "absence", at: event.at, until: event.at, count: 1 });
      }
      continue;
    }

    rows.push(event.kind === "check" ? { kind: "check", at: event.at, faces: event.faces } : { ...event });
  }

  return rows;
}

/**
 * How long a collapsed run lasted, in words.
 *
 * The span is the point of the row — "nobody, 40 times" says nothing without
 * it, since the same count could be two minutes or two hours depending on the
 * detection interval in force.
 */
export function spanLabel(from: string, to: string): string {
  const ms = new Date(to).getTime() - new Date(from).getTime();
  // A malformed stamp reads as no span rather than as NaN. Acceptance-phrased,
  // because NaN is false against every comparison.
  if (!(ms >= 1_000)) return "";
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `over ${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `over ${minutes}m`;
  return `over ${Math.round(minutes / 60)}h`;
}

/**
 * One matched or unmatched face, as the row states it.
 *
 * A face the recogniser could find but not describe is its own case: reporting
 * it as unrecognised would blame the gallery for a missing embedder.
 */
export function faceLabel(face: VisionCheckFace): string {
  if (!face.embedded) return "a face it could not describe";
  if (!face.name) return "an unrecognised face";
  return `${face.name} ${Math.round((face.confidence ?? 0) * 100)}%`;
}
