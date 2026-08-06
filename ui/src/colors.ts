import type { NarrationEntry, Settings, StoredMessage } from "../../shared/src/types";
import { DEFAULT_ADAPTER_COLOR, DEFAULT_CHAT_COLOR } from "./palette";

// HAL's own colour, mirroring `--red` in `styles.css`. Kept as a literal so
// this module stays pure and testable: a `var(--red)` string would resolve
// only inside a document.
export const HAL_RED = "#e0301e";

/**
 * The colour a narration entry renders in.
 *
 * Provenance, not recency: the colour comes from the entry's own recorded
 * `adapterId`, so an observation keeps the colour of the adapter that
 * produced it after the user switches adapters or detaches (R13, AE3).
 *
 * HAL's red is the fallback in two cases:
 *  - no adapter id — the `gap` and `status` kinds, which are HAL speaking
 *    about himself rather than about a session (R15);
 *  - an id with no entry in the settings map. The server re-seeds every
 *    registered adapter on load and drops ids it no longer knows
 *    (`mergeAdapters` in `server/src/storage/settings.ts`), so absence from
 *    the map means the adapter is no longer registered, and an orphaned
 *    observation reads as HAL's own voice rather than as nothing at all.
 *
 * Before the first settings broadcast nothing is known about any adapter, so
 * the default adapter colour stands in — the entry is attributed, and
 * painting it HAL red would misreport it as HAL's own for as long as the
 * connection takes to hand over settings.
 *
 * Never returns undefined: the caller feeds this straight to a CSS custom
 * property, where an empty value would silently fall through to the
 * stylesheet's default and erase provenance.
 */
export function entryColor(entry: Pick<NarrationEntry, "adapterId">, settings: Settings | null): string {
  if (!entry.adapterId) return HAL_RED;
  if (!settings) return DEFAULT_ADAPTER_COLOR;
  return settings.adapters?.[entry.adapterId]?.color ?? HAL_RED;
}

/** The colour a chat message body renders in, by role (R18). */
export function chatColor(role: StoredMessage["role"], settings: Settings | null): string {
  return settings?.chatColors?.[role] ?? DEFAULT_CHAT_COLOR;
}
