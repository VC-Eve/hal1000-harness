// Text to token ids, with sentence boundaries and punctuation intact.
//
// This reimplements what `kokoro-onnx` does in Python, and the two do not start
// from the same place. The reference calls eSpeak NG through a wrapper that
// takes `preserve_punctuation=True`; the npm `phonemizer` takes no options at
// all — its entire API is `phonemize(text, language)` — and returns an **array
// split on punctuation clauses** with the punctuation itself removed:
//
//     "I am afraid, Dave."  ->  ["aɪɐm ɐfɹˈeɪd", "dˈeɪv"]
//
// So punctuation is put back here. Word-index alignment is not available and
// must not be attempted: eSpeak collapses "I am" into a single `aɪɐm`, so source
// word count and phoneme token count routinely differ.
//
// Nor is aligning whole-line output by clause index, which was the first attempt
// — the phonemiser splits on **length** as well as on punctuation, so a long
// clause comes back as several pieces and a returned-piece count can exceed the
// source's clause count with nothing wrong. Instead each clause is sent on its
// own: every piece that comes back belongs to the clause that was sent, and the
// alignment question stops being askable. A comma in the wrong place is a pause
// in the wrong place, which is audible, so the design removes the guess rather
// than making a good one.
//
// Punctuation is worth the trouble because it is in the vocabulary (`;` 1, `:` 2,
// `,` 3, `.` 4, `!` 5, `?` 6) and drives prosody. Dropping it makes a read sound
// like a list.
//
// **The vowel rule.** The two eSpeak builds spell one phoneme differently: the
// npm build emits `oː` where the reference emits `ɔː`. Measured over the
// 186-line corpus in `server/test/voice/fixtures/`, that single substitution
// accounts for 38 of 57 divergences, and the reference emits `oː` on **none** of
// 195 recorded lines — so the rewrite is total rather than a heuristic. Both
// symbols are in the vocabulary, so without it nothing errors and the character
// simply says a different vowel on words as common as *aboard*, *reports* and
// *support*. See `server/test/voice/fixtures/README.md` for the measurement and
// for the residual 10.2% that cannot be closed.

import { phonemize } from "phonemizer";
import { MAX_PHONEME_LENGTH, VOCAB } from "./vocab.js";

/** One unit of synthesis: a sentence, or a piece of one too long for the model. */
export interface Utterance {
  /** The source text this came from, which is what a subtitle shows. */
  text: string;
  /** The phonemes the model will actually read, after the vowel rule and the vocabulary filter. */
  ipa: string;
  /** Token ids, without the model's two padding zeroes. */
  tokens: number[];
}

/** The marks the phonemiser splits on, and the only ones re-attached. */
const CLAUSE_MARKS = /[,;:.!?]/;

/**
 * One phonemisation at a time, process-wide.
 *
 * eSpeak NG holds global state, and `kokoro-onnx` guards its use with a lock
 * noting that concurrent phonemisation returns corrupted phonemes. The WASM
 * build has no reason to differ, and `phonemize` is async — so two callers can
 * interleave inside it at an await point even though JavaScript runs one thread.
 * A worker would not fix that; a queue does.
 *
 * The lock lives here rather than at a call site so every entry point is covered
 * by construction: synthesis, and the editor's phoneme readout, which is the
 * surface added precisely because a wrong pronunciation is silent.
 */
let phonemiserQueue: Promise<unknown> = Promise.resolve();

function serialised<T>(work: () => Promise<T>): Promise<T> {
  const run = phonemiserQueue.then(work, work);
  // The chain must not stay rejected, or every later call inherits the failure.
  phonemiserQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Words whose trailing period does not end a sentence.
 *
 * Not exhaustive and cannot be: this is the ambiguity English does not resolve.
 * The cost of a miss is a subtitle boundary in an odd place and two shorter
 * synthesis calls, not a wrong pronunciation, so the list is kept short and
 * common rather than complete.
 */
const ABBREVIATIONS = new Set([
  "dr", "mr", "mrs", "ms", "prof", "sr", "jr", "st", "mt",
  "vs", "etc", "approx", "no", "fig", "cf", "al", "inc", "ltd", "co",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
]);

/** The one systematic difference between the two eSpeak builds. */
export function applyVowelRule(ipa: string): string {
  return ipa.replace(/oː/g, "ɔː");
}

/**
 * Split text into sentences.
 *
 * Sentences are the unit of synthesis and therefore the unit of subtitle timing
 * (R16): each is rendered separately, which is what makes its exact duration a
 * by-product rather than something to estimate. Per-phoneme timings would be the
 * alternative, and the shipped model refuses to produce them.
 *
 * A period followed by a digit is a decimal, not an ending — the lookahead for
 * whitespace covers that without a special case.
 */
export function splitSentences(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];

  const out: string[] = [];
  const boundary = /[.!?]+(?=\s|$)/g;
  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = boundary.exec(trimmed)) !== null) {
    const end = match.index + match[0].length;
    const candidate = trimmed.slice(start, end);
    if (endsWithAbbreviation(candidate)) continue;
    const sentence = candidate.trim();
    if (sentence.length > 0) out.push(sentence);
    start = end;
  }
  const tail = trimmed.slice(start).trim();
  if (tail.length > 0) out.push(tail);
  return out;
}

function endsWithAbbreviation(candidate: string): boolean {
  const match = /([A-Za-z]+)\.$/.exec(candidate.trim());
  if (!match) return false;
  return ABBREVIATIONS.has(match[1]!.toLowerCase());
}

/**
 * The clause structure of the source, as a list of trailing marks.
 *
 * One entry per clause that has words in it, carrying whatever punctuation
 * followed it. A mark with nothing before it — a doubled `!!`, or a leading
 * comma — is attached to the clause before it rather than creating an empty
 * one, because the phonemiser produces no clause for it either.
 */
function sourceClauses(text: string): { words: string; mark: string }[] {
  const out: { words: string; mark: string }[] = [];
  let segment = "";

  const push = (mark: string) => {
    if (segment.trim().length === 0) {
      // A mark with nothing before it — a doubled `!!`, or a leading comma.
      // Attached to the clause before it rather than opening an empty one,
      // because the phonemiser produces no clause for it either.
      if (mark.length > 0 && out.length > 0) out[out.length - 1]!.mark += mark;
      return;
    }
    out.push({ words: segment.trim(), mark });
    segment = "";
  };

  for (let i = 0; i < text.length; i += 1) {
    const character = text[i]!;
    if (CLAUSE_MARKS.test(character) && !betweenDigits(text, i)) {
      push(character);
      continue;
    }
    segment += character;
  }
  push("");
  return out;
}

/**
 * Whether a mark sits between two digits, and so is not a clause boundary.
 *
 * `0.5` is a decimal, `1,200` is a thousands separator and `09:00` is a time.
 * Splitting on any of them hands the phonemiser two fragments instead of one
 * number, and eSpeak reads "1,200" as "one, two hundred" rather than "one
 * thousand two hundred" — a wrong reading, not a wrong pause. Measured on the
 * differential corpus, this one rule accounts for most of the remaining
 * divergence; see `server/test/voice/fixtures/README.md`.
 */
function betweenDigits(text: string, index: number): boolean {
  const before = text[index - 1];
  const after = text[index + 1];
  return before !== undefined && after !== undefined && /\d/.test(before) && /\d/.test(after);
}

/**
 * The phonemes for one line, with punctuation restored — what R21 shows.
 *
 * Null when the two sides disagree about clause structure. That is a refusal
 * rather than a best effort on purpose: a misplaced comma is a pause in the
 * wrong place, and a silently wrong read is the failure this whole surface
 * exists to make visible.
 */
export async function phonemesFor(text: string): Promise<string | null> {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;

  // Each clause is phonemised on its own, rather than phonemising the whole line
  // and matching the returned pieces back to it. The phonemiser splits on
  // **length** as well as on punctuation — a long clause comes back as several
  // pieces — so a returned-piece count can exceed the source's clause count with
  // nothing wrong, and there is then no way to tell which piece belongs where.
  // Handing it one clause at a time makes the question unaskable: every piece
  // that comes back belongs to the clause that was sent, and pieces are rejoined
  // with the space they were split on.
  const source = sourceClauses(trimmed);
  if (source.length === 0) return null;

  let out = "";
  for (let i = 0; i < source.length; i += 1) {
    const clause = source[i]!;
    const pieces = await serialised(() => phonemize(clause.words, "en-us"));
    const spoken = pieces.join(" ").trim();
    if (spoken.length === 0) continue;
    out += spoken;
    out += clause.mark;
    if (i < source.length - 1) out += " ";
  }
  return filterToVocabulary(applyVowelRule(out));
}

/**
 * Keep only what the model has a token for.
 *
 * The reference filters before tokenising and so does this, so the IPA shown by
 * the readout is the IPA that will be spoken rather than a superset of it.
 */
export function filterToVocabulary(ipa: string): string {
  let out = "";
  for (const character of ipa) if (VOCAB.has(character)) out += character;
  // Space is a real token (id 16), so a doubled one is a doubled token and a
  // longer pause than anything wrote. They arise where eSpeak drops a character
  // it does not speak — a hyphen in `AE-35` — and leaves the space around it.
  return out.replace(/ {2,}/g, " ").trim();
}

/** Token ids for phonemes already filtered to the vocabulary. */
export function tokenise(ipa: string): number[] {
  const tokens: number[] = [];
  for (const character of ipa) {
    const id = VOCAB.get(character);
    if (id !== undefined) tokens.push(id);
  }
  return tokens;
}

/**
 * Text to the units that will be synthesised.
 *
 * Sentences first, then any sentence whose tokens exceed the model's cap is
 * divided further — at a space, so a division falls between words rather than
 * inside one. The reference prefers punctuation and then word boundaries for the
 * same reason. Splitting rather than truncating matters: a truncated line stops
 * mid-word and sounds like a fault, while a split one is only a longer pause
 * than the author wrote.
 *
 * A sentence the phonemiser and the source disagree about is dropped, and the
 * caller is told by its absence — `text` is preserved on every unit returned, so
 * comparing the returned text against the input says exactly what was lost.
 */
export async function toUtterances(text: string): Promise<Utterance[]> {
  const out: Utterance[] = [];
  for (const sentence of splitSentences(text)) {
    const ipa = await phonemesFor(sentence);
    if (ipa === null) continue;
    for (const piece of dividePhonemes(ipa)) {
      const tokens = tokenise(piece);
      if (tokens.length > 0) out.push({ text: sentence, ipa: piece, tokens });
    }
  }
  return out;
}

/** One IPA string as pieces no longer than the model's cap. */
function dividePhonemes(ipa: string): string[] {
  const characters = [...ipa];
  if (characters.length <= MAX_PHONEME_LENGTH) return [ipa];

  const pieces: string[] = [];
  let current: string[] = [];
  for (const character of characters) {
    if (current.length >= MAX_PHONEME_LENGTH) {
      // Back up to the last space so a piece ends between words. If there is no
      // space at all — one very long word — the hard cut stands, because a piece
      // over the cap is refused by the model outright.
      const lastSpace = current.lastIndexOf(" ");
      if (lastSpace > 0) {
        pieces.push(current.slice(0, lastSpace).join("").trim());
        current = current.slice(lastSpace + 1);
      } else {
        pieces.push(current.join("").trim());
        current = [];
      }
    }
    current.push(character);
  }
  if (current.length > 0) pieces.push(current.join("").trim());
  return pieces.filter((piece) => piece.length > 0);
}
