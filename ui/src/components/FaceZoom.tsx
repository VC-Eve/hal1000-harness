import { useEffect } from "react";

/**
 * A stored face, shown at the size it was actually saved.
 *
 * Every crop is normalised to 160x160 on the way in, so the file cannot say
 * whether it was upscaled from a distant face or downscaled from a close one.
 * At the ~64px the roster renders, both look the same. At true size the
 * difference is visible by eye — an upscaled small capture is soft and blocky —
 * and the recorded source width says it in a number for the cases where eyes
 * disagree.
 *
 * Rendered with `image-rendering: pixelated` deliberately. Smoothing an
 * upscaled face is exactly the wrong favour here: it hides the artefact the
 * viewer was opened to judge.
 */
export function FaceZoom({
  src,
  sourceWidth,
  caption,
  onClose,
}: {
  src: string;
  sourceWidth?: number;
  caption?: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Below this a face has been upscaled into the crop rather than downscaled
  // into it, so the embedding is working from fewer pixels than it wants. Not a
  // hard rule — the embedder takes 112x112, so a capture under that was
  // genuinely invented — which is why the copy suggests rather than forbids.
  const thin = sourceWidth !== undefined && sourceWidth < 112;

  return (
    <div className="face-zoom" data-testid="face-zoom" onClick={onClose} role="presentation">
      <figure className="face-zoom-inner" onClick={(e) => e.stopPropagation()}>
        <img src={src} alt={caption ?? "a stored face"} data-testid="face-zoom-image" />
        <figcaption>
          {sourceWidth === undefined ? (
            <span className="face-zoom-unknown" data-testid="face-zoom-size">
              captured before sizes were recorded
            </span>
          ) : (
            <span className={thin ? "face-zoom-thin" : undefined} data-testid="face-zoom-size">
              captured {sourceWidth}px wide
              {thin ? " — smaller than the embedder's 112px, so this one was upscaled" : ""}
            </span>
          )}
          {caption ? <small>{caption}</small> : null}
          <button className="ghost" onClick={onClose} data-testid="face-zoom-close">
            close
          </button>
        </figcaption>
      </figure>
    </div>
  );
}
