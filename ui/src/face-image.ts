// Turning a picture the user picked into something the recogniser can read.
//
// The transcode happens here rather than on the server for three reasons, and
// each of them is a bug avoided rather than a preference.
//
// EXIF. A phone portrait is stored sideways with an orientation tag, and every
// image viewer honours it — so the user sees an upright face while a decoder
// that ignores the tag sees a rotated one and finds nothing. The camera path
// never hits this because ffmpeg frames carry no EXIF, which is exactly why it
// would have gone unnoticed. `createImageBitmap` applies the tag when asked.
//
// Format. HEIC is the default on an iPhone and is the single most likely file
// anyone picks. The browser decodes whatever it can display; ffmpeg on the
// server cannot decode HEIC without libheif, and adding a decoder to the
// server was the alternative.
//
// One buffer. The bytes produced here go to both detection and the crop. The
// box the recogniser returns is in the coordinates of the buffer it detected
// on, so re-encoding between those two steps would shift the crop off the face.

// Wide enough that a face in a normal photo stays well above the detector's
// floor, small enough that the base64 payload stays sane. Detection letterboxes
// to a fixed 640x640 anyway, so pixels beyond this buy nothing.
const MAX_EDGE = 1600;

// Stated to the user before anything is sent, so the limit is not discovered as
// a failure. Comfortably under the server's own backstop.
export const MAX_FILE_BYTES = 12 * 1024 * 1024;

export class ImageError extends Error {}

/**
 * Read a picked file into a base64 JPEG, upright and bounded.
 *
 * Throws `ImageError` with wording meant for the user — every failure here is
 * something they can act on by choosing a different file.
 */
export async function fileToJpegBase64(file: File): Promise<string> {
  if (file.size > MAX_FILE_BYTES) {
    throw new ImageError(`That file is ${Math.round(file.size / 1_000_000)}MB. Pictures up to ${MAX_FILE_BYTES / 1_000_000}MB work.`);
  }

  let bitmap: ImageBitmap;
  try {
    // `from-image` is what applies the EXIF orientation. Without it a portrait
    // photo arrives rotated and the face is simply not found.
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new ImageError("I could not read that file as a picture. JPEG, PNG, HEIC and WebP all work.");
  }

  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new ImageError("This browser would not give me a canvas to convert the picture with.");
    context.drawImage(bitmap, 0, 0, width, height);

    const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
    const comma = dataUrl.indexOf(",");
    if (!dataUrl.startsWith("data:image/jpeg") || comma === -1) {
      throw new ImageError("I could not convert that picture to a format the recogniser reads.");
    }
    return dataUrl.slice(comma + 1);
  } finally {
    // Bitmaps hold decoded pixels outside the JS heap; a large photo left
    // unclosed is tens of megabytes the GC has no reason to hurry over.
    bitmap.close();
  }
}
