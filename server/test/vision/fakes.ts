import type { CandidateQueue } from "../../src/vision/candidates.js";
import type { VisionCandidate } from "../../../shared/src/types.js";

// An in-memory triage queue. Real enough to test the service's behaviour
// around it without writing face crops to a temp directory in every suite.
export function fakeCandidates(): CandidateQueue & { items: { id: string; embedding: number[] }[] } {
  const items: { id: string; embedding: number[] }[] = [];
  let seq = 0;
  let dropped = 0;
  return {
    items,
    list: async (): Promise<VisionCandidate[]> =>
      [...items].reverse().map((c) => ({ id: c.id, at: "2026-08-07T12:00:00.000Z", thumbnail: "data:image/jpeg;base64,AA" })),
    overflow: () => ({ dropped, since: dropped ? "2026-08-07T12:00:00.000Z" : null }),
    count: async () => items.length,
    offer: async (embedding, _thumbnail, cap) => {
      if (cap <= 0) return null;
      const id = `c${++seq}`;
      items.push({ id, embedding });
      while (items.length > cap) { items.shift(); dropped += 1; }
      return { id, at: "2026-08-07T12:00:00.000Z", thumbnail: "data:image/jpeg;base64,AA" };
    },
    take: async (id) => {
      const i = items.findIndex((c) => c.id === id);
      if (i < 0) return null;
      const [taken] = items.splice(i, 1);
      return { embedding: taken!.embedding, thumbnail: Buffer.from("crop") };
    },
    dismiss: async (id) => {
      const i = items.findIndex((c) => c.id === id);
      if (i < 0) return false;
      items.splice(i, 1);
      return true;
    },
    clear: async () => { items.length = 0; dropped = 0; },
  };
}
