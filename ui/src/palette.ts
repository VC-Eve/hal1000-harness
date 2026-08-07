// Curated colours offered for adapter and chat text.
//
// A UI convenience only: the stored value is a plain colour and the protocol
// carries no palette concept, so a custom pick is every bit as valid as one
// of these.
//
// Every entry is chosen to survive the server's normalization untouched
// (`server/src/storage/colors.ts`): WCAG contrast >= 4.5:1 against the pane
// background (`--panel`, #0c0c0e) and CIE76 deltaE >= 25 from both reserved
// colours, HAL's red (`--red`) and the status amber (`--amber`). Every hue
// here clears the reserved distance by 58 or more, so a swatch never comes
// back from the server as something else. Hues sit wide of red and amber for
// the same reason provenance needs them to: they must not read as HAL's own
// voice or as a status report.

export interface PaletteEntry {
  name: string;
  value: string;
}

export const PALETTE: PaletteEntry[] = [
  { name: "bone", value: "#e8c8c2" },
  { name: "rose", value: "#ff9db0" },
  { name: "orchid", value: "#e07ad0" },
  { name: "amethyst", value: "#b79cf5" },
  { name: "ice", value: "#8ab4f8" },
  { name: "cyan", value: "#63d4e0" },
  { name: "jade", value: "#5fd3a6" },
  { name: "moss", value: "#8fc98a" },
  { name: "slate", value: "#a8b3c4" },
];

// Mirrors the server's DEFAULT_ADAPTER_COLOR and DEFAULT_CHAT_COLOR
// (`server/src/storage/settings.ts`). Used only to render an adapter the
// stored settings have not seen yet; the server's value wins the moment a
// settings broadcast arrives.
export const DEFAULT_ADAPTER_COLOR = "#e8c8c2";
export const DEFAULT_CHAT_COLOR = "#d6d6d2";
// Mirrors DEFAULT_VISION.color on the server — "jade" above.
export const DEFAULT_VISION_COLOR = "#5fd3a6";

// Hex comparison for swatch selection: the server stores lowercase 6-digit
// hex, but a custom pick or a hand-edited file may not.
export function sameColor(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
