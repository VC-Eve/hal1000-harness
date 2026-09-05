/**
 * Where the picture actually is inside its box.
 *
 * Both stages draw their video with `object-fit: contain`, so whenever the
 * clip's aspect differs from the container's, the picture is smaller than the
 * box and centred in it, with bars on two sides. An overlay sized to the box
 * would put "bottom left" in a bar and would make a percentage of the picture's
 * height a percentage of something else on every output. So the layer is
 * placed on the rect this returns, and its container-query units resolve
 * against the picture.
 *
 * A pure module with its own suite, the `layout.ts` precedent: jsdom lays
 * nothing out, so the arithmetic is the whole of what can be asserted.
 */

export interface Size {
  width: number;
  height: number;
}

export interface Rect extends Size {
  left: number;
  top: number;
}

/**
 * The contained rect of a picture with `intrinsic` size inside `container`.
 *
 * With no intrinsic size — nothing assigned, or metadata not yet read — the
 * answer is the whole container, which is what keeps the title up over black.
 * A zero or non-finite intrinsic dimension counts as none: dividing by it would
 * produce a rect nothing can be placed on.
 */
export function fittedRect(container: Size, intrinsic: Size | null | undefined): Rect {
  const whole = { left: 0, top: 0, width: container.width, height: container.height };
  if (!intrinsic) return whole;
  if (!(isUsable(intrinsic.width) && isUsable(intrinsic.height))) return whole;
  if (!(isUsable(container.width) && isUsable(container.height))) return whole;
  const scale = Math.min(container.width / intrinsic.width, container.height / intrinsic.height);
  const width = intrinsic.width * scale;
  const height = intrinsic.height * scale;
  return {
    left: (container.width - width) / 2,
    top: (container.height - height) / 2,
    width,
    height,
  };
}

function isUsable(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}
