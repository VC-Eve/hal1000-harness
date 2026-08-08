import type { CandidateQueue } from "../../src/vision/candidates.js";
import type { Gallery } from "../../src/vision/people.js";
import type { VisionCandidate } from "../../../shared/src/types.js";

// An in-memory triage queue. Real enough to test the service's behaviour
// around it without writing face crops to a temp directory in every suite.
type FakeItem = { id: string; embedding: number[]; suspected?: { personId: string; name: string; confidence: number } };

export function fakeCandidates(): CandidateQueue & { items: FakeItem[] } {
  const items: FakeItem[] = [];
  let seq = 0;
  let dropped = 0;
  return {
    items,
    list: async (): Promise<VisionCandidate[]> =>
      [...items].reverse().map((c) => ({
        id: c.id,
        at: "2026-08-07T12:00:00.000Z",
        thumbnail: "data:image/jpeg;base64,AA",
        ...(c.suspected ? { suspected: c.suspected } : {}),
      })),
    overflow: () => ({ dropped, since: dropped ? "2026-08-07T12:00:00.000Z" : null }),
    count: async () => items.length,
    offer: async (embedding, _thumbnail, cap, suspected) => {
      if (cap <= 0) return null;
      const id = `c${++seq}`;
      items.push({ id, embedding, ...(suspected ? { suspected } : {}) });
      while (items.length > cap) { items.shift(); dropped += 1; }
      return {
        id,
        at: "2026-08-07T12:00:00.000Z",
        thumbnail: "data:image/jpeg;base64,AA",
        ...(suspected ? { suspected } : {}),
      };
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

// A gallery that answers everything and remembers nothing.
//
// Extracted after the third interface change broke four inline object literals
// across two suites. A fake spelled out at every use site is a fake that has to
// be edited at every use site, and the edits are pure noise — none of those
// tests care about `tally` or `rename`.
export function fakeGallery(over: Partial<Gallery> = {}): Gallery {
  return {
    list: async () => [],
    create: async () => {
      throw new Error("not used");
    },
    enrolByName: async () => {
      throw new Error("not used");
    },
    addFace: async () => false,
    remove: async () => false,
    rename: async () => ({ ok: false, reason: "not used" }),
    removeFace: async () => ({ ok: false, reason: "not used" }),
    setProfile: async () => ({ ok: true }),
    setOperator: async () => ({ ok: true }),
    tally: async () => ({ people: 0, faces: 0 }),
    clear: async () => {},
    match: async () => null,
    ...over,
  };
}
