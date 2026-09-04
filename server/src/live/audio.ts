import path from "node:path";

/**
 * Audio types the store accepts and the track route will answer with.
 *
 * A table of its own, exactly as `VIDEO_MIME` in `clips.ts` is one: the static
 * table describes what the UI bundle is made of, and an `.mp3` appearing there
 * would make every unrelated file in `ui/dist` a candidate for the byte-range
 * path this needs and that one does not have.
 *
 * Deliberately the *single* gate. The browser offers what this table names and
 * the byte route serves what this table names, so what the author can pick and
 * what HAL can play cannot drift apart — the same rule `videoMime` establishes,
 * and the reason it lives here rather than inside either caller.
 *
 * Small on purpose. Origin R1 permits any format the browser already decodes,
 * but a format listed here is one the import path claims to understand — it
 * reads its tag, and U8 decodes it to measure a tempo. Adding `.ogg` to be
 * generous would offer files whose tag nothing here can read, which reads to
 * the author as a broken import rather than as an unsupported format.
 */
const AUDIO_MIME: Record<string, string> = {
  ".flac": "audio/flac",
  ".mp3": "audio/mpeg",
};

export function audioMime(file: string): string | null {
  return AUDIO_MIME[path.extname(file).toLowerCase()] ?? null;
}
