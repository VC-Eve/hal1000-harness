import type { CandidateQueue } from "../../src/vision/candidates.js";
import { cosine } from "../../src/vision/recogniser.js";
import type { Gallery } from "../../src/vision/people.js";
import type { VisionCandidate } from "../../../shared/src/types.js";

// An in-memory triage queue. Real enough to test the service's behaviour
// around it without writing face crops to a temp directory in every suite.
type FakeItem = {
  id: string;
  embedding: number[];
  suspected?: { personId: string; name: string; confidence: number };
  sourceWidth?: number;
  setAsideAt?: string;
  lastSeenAt?: string;
};

export function fakeCandidates(): CandidateQueue & { items: FakeItem[] } {
  const items: FakeItem[] = [];
  let seq = 0;
  let dropped = 0;
  let shelfDropped = 0;
  let matched = 0;
  let writes = 0;
  const AT = "2026-08-07T12:00:00.000Z";
  const pending = () => items.filter((c) => c.setAsideAt === undefined);
  return {
    items,
    revision: () => writes,
    list: async (): Promise<VisionCandidate[]> =>
      [...items].reverse().map((c) => ({
        id: c.id,
        at: AT,
        thumbnail: "data:image/jpeg;base64,AA",
        ...(c.suspected ? { suspected: c.suspected } : {}),
        ...(c.sourceWidth ? { sourceWidth: c.sourceWidth } : {}),
        ...(c.setAsideAt ? { setAsideAt: c.setAsideAt } : {}),
        ...(c.lastSeenAt ? { lastSeenAt: c.lastSeenAt } : {}),
      })),
    overflow: () => ({ dropped, since: dropped ? AT : null }),
    setAsideOverflow: () => ({ dropped: shelfDropped, since: shelfDropped ? AT : null }),
    shelfMatches: () => ({ matched, since: matched ? AT : null }),
    acknowledgeOverflow: async (which) => {
      // The same three-way shape as the real store, including its refusal to
      // guess: a value outside the union clears nothing.
      if (which === "pending") dropped = 0;
      else if (which === "setAside") shelfDropped = 0;
      else if (which === "shelfMatches") matched = 0;
    },
    count: async () => {
      const setAside = items.length - pending().length;
      return { pending: pending().length, setAside, total: items.length };
    },
    offer: async (embedding, _thumbnail, cap, suspected, sourceWidth) => {
      if (cap <= 0) return null;
      // The duplicate check, because leaving it out is how this fake lied. Every
      // service-level test runs against this object, so a branch missing here is
      // a branch no service test can reach: the shelf-match path — which stamps a
      // returning face, upgrades its crop and moves the match tally — was
      // unreachable, and so was the rebroadcast it needs. The same shape hid
      // `sourceWidth` never being forwarded, which shipped and had to be fixed on
      // its own.
      const match = items.find((c) => cosine(embedding, c.embedding) >= 0.45);
      if (match) {
        if (match.setAsideAt === undefined) return null;
        if (sourceWidth !== undefined && sourceWidth > (match.sourceWidth ?? 0)) match.sourceWidth = sourceWidth;
        const firstToday = match.lastSeenAt === undefined;
        match.lastSeenAt = AT;
        if (firstToday) matched += 1;
        writes += 1;
        return null;
      }
      const id = `c${++seq}`;
      items.push({ id, embedding, ...(suspected ? { suspected } : {}), ...(sourceWidth ? { sourceWidth } : {}) });
      writes += 1;
      // Only the active pool is bounded here, mirroring the real store: a
      // shelved face is not displaced by a stranger arriving.
      while (pending().length > cap) {
        const oldest = pending()[0];
        if (!oldest) break;
        items.splice(items.indexOf(oldest), 1);
        dropped += 1;
      }
      return {
        id,
        at: AT,
        thumbnail: "data:image/jpeg;base64,AA",
        ...(suspected ? { suspected } : {}),
        ...(sourceWidth ? { sourceWidth } : {}),
      };
    },
    take: async (id) => {
      const i = items.findIndex((c) => c.id === id);
      if (i < 0) return null;
      const [taken] = items.splice(i, 1);
      writes += 1;
      // The whole item travels, exactly as the real store's does, so a rollback
      // puts back the same id with its own sighting time, shelf age and
      // suspicion. A fake that handed back a summary made every one of those
      // losses invisible to the suite.
      return {
        embedding: taken!.embedding,
        thumbnail: Buffer.from("crop"),
        record: { at: AT, ...taken! },
        position: i,
        ...(taken!.sourceWidth ? { sourceWidth: taken!.sourceWidth } : {}),
        ...(taken!.setAsideAt ? { setAside: true } : {}),
      };
    },
    reinstate: async (taken) => {
      const record = taken.record;
      if (!record) return false;
      if (items.some((c) => c.id === record.id)) return false;
      items.splice(Math.min(taken.position ?? items.length, items.length), 0, { ...record });
      writes += 1;
      return true;
    },
    dismiss: async (id) => {
      const i = items.findIndex((c) => c.id === id);
      if (i < 0) return false;
      items.splice(i, 1);
      writes += 1;
      return true;
    },
    setAside: async (id, cap) => {
      const found = items.find((c) => c.id === id);
      if (!found || found.setAsideAt !== undefined) return false;
      if (cap <= 0) return false;
      found.setAsideAt = AT;
      writes += 1;
      while (items.filter((c) => c.setAsideAt !== undefined).length > cap) {
        const oldest = items.find((c) => c.setAsideAt !== undefined);
        if (!oldest) break;
        items.splice(items.indexOf(oldest), 1);
        shelfDropped += 1;
      }
      return true;
    },
    restore: async (id, cap) => {
      const found = items.find((c) => c.id === id);
      if (!found || found.setAsideAt === undefined) return false;
      if (pending().length >= cap) return false;
      delete found.setAsideAt;
      delete found.lastSeenAt;
      writes += 1;
      return true;
    },
    clear: async () => {
      items.length = 0;
      dropped = 0;
      shelfDropped = 0;
      matched = 0;
      writes += 1;
    },
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
