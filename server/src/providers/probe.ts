// Asking each distinct backend once, per pass.
//
// Two callers need every slot's answer and would rather not ask one server
// twice for it: readiness probes both backends, and `list-models` lists both.
// Each used to compare endpoints and copy one slot's result onto the other,
// which is correct exactly until two slots name one host with different
// credentials — and wrong in both directions when they do. A keyless chat slot
// was reported reachable on the observation slot's key; a working observation
// backend was reported unreachable on the chat slot's failure.
//
// So the comparison moves here, it compares whole backends, and it is the only
// place that asks. A caller cannot get this wrong by forgetting, because a
// caller no longer has the question.
//
// The memo is per call and is discarded when it returns. It is a dedupe, not a
// cache: a model list is not stable for a process lifetime — someone who pulls
// a model expects the next readiness refresh to show it, without touching a
// setting to invalidate anything.

import { sameDestination, type ResolvedBackend } from "./provider.js";
import { backendForRole, type InferenceRole } from "./resolve.js";
import type { SettingsStore } from "../storage/settings.js";
import type { BackendSlot } from "../../../shared/src/types.js";

/**
 * What one slot's probe produced.
 *
 * `backend: null` means the protocol could not be determined — nothing was
 * asked, because there was nothing to ask. That is distinct from a probe that
 * ran and threw, which arrives as `error`, and callers report the two the same
 * way today but need not forever.
 */
export type SlotProbe<T> =
  | { backend: ResolvedBackend; value: T }
  | { backend: ResolvedBackend; error: unknown }
  | { backend: null };

/** The role each slot's backend is resolved through. */
function roleFor(slot: BackendSlot): InferenceRole {
  return slot === "chat" ? "chat" : "narration";
}

/**
 * Run `probe` once per distinct destination across `slots`, and give every slot
 * its answer.
 *
 * Slots sharing a destination share one probe and one result. Slots that differ
 * by anything `sameDestination` looks at — including a credential one has and
 * the other does not — each get their own, which is the whole point.
 *
 * A slot that fails to resolve, and a probe that throws, are contained to the
 * group they belong to. One unreachable backend never decides what is said
 * about the other.
 */
export async function probeEachBackend<T>(
  slots: readonly BackendSlot[],
  settings: SettingsStore,
  probe: (backend: ResolvedBackend) => Promise<T>,
): Promise<Map<BackendSlot, SlotProbe<T>>> {
  const resolved = new Map<BackendSlot, ResolvedBackend | null>();
  for (const slot of slots) {
    resolved.set(slot, await backendForRole(roleFor(slot), settings).catch(() => null));
  }

  // One entry per distinct destination, each holding the slots that share it.
  const groups: { backend: ResolvedBackend; slots: BackendSlot[] }[] = [];
  for (const [slot, backend] of resolved) {
    if (!backend) continue;
    const existing = groups.find((g) => sameDestination(g.backend, backend));
    if (existing) existing.slots.push(slot);
    else groups.push({ backend, slots: [slot] });
  }

  const out = new Map<BackendSlot, SlotProbe<T>>();
  for (const slot of slots) if (!resolved.get(slot)) out.set(slot, { backend: null });

  await Promise.all(
    groups.map(async ({ backend, slots: sharing }) => {
      const result: SlotProbe<T> = await probe(backend).then(
        (value) => ({ backend, value }),
        (error: unknown) => ({ backend, error }),
      );
      for (const slot of sharing) out.set(slot, result);
    }),
  );

  return out;
}
