/**
 * Measure how far the npm phonemiser diverges from the reference Python one.
 *
 * `server/src/voice/phonemes.ts` reimplements what `kokoro-onnx` does in Python.
 * The two agreed byte-for-byte on the handful of lines that were spot-checked
 * during planning, but a handful of matching lines is not an equivalence proof:
 * fixtures recorded on the same lines catch *drift over time*, and say nothing
 * about *coverage*. This measures coverage, once, over the corpus in
 * `server/test/voice/fixtures/differential-python.json`.
 *
 *     node scripts/differential-phonemes.mjs [--verbose]
 *
 * It is a measurement, not a test: it prints a divergence rate and the lines
 * that diverge. The lines it finds are what get pinned as fixtures. Re-run it
 * after a `phonemizer` bump — a change in the rate is a change in how the
 * character pronounces things, which nothing else in the suite would notice.
 *
 * Comparison is on phoneme content only. The npm package returns an array split
 * on punctuation clauses and drops the punctuation itself; the reference keeps
 * it inline. Re-attaching punctuation is `phonemes.ts`'s job and is checked by
 * its own tests, so here both sides are stripped of the vocabulary's punctuation
 * ids and of whitespace before they are compared. A difference that survives
 * that is a difference in how a word sounds.
 */

import { readFileSync } from "node:fs";
import { phonemize } from "phonemizer";

const PUNCTUATION = /[;:,.!?"()—–\-\s]/g;

const verbose = process.argv.includes("--verbose");
const corpus = JSON.parse(
  readFileSync(new URL("../server/test/voice/fixtures/differential-python.json", import.meta.url)),
).lines;

/** Phoneme content, with everything the two sides format differently removed. */
const bare = (ipa) => ipa.replace(PUNCTUATION, "");

/**
 * Substitutions applied before re-comparing, to separate one systematic vowel
 * difference from genuinely unrelated divergences. Each entry is a known
 * difference between the two eSpeak NG builds, not a licence to ignore it — the
 * point is to say how much of the divergence one rule accounts for, so the fix
 * can be one rule rather than a table of special cases.
 */
const KNOWN = [[/oː/g, "ɔː"]];

const applyKnown = (s) => KNOWN.reduce((acc, [from, to]) => acc.replace(from, to), s);

const divergent = [];
for (const { text, ipa } of corpus) {
  const js = (await phonemize(text, "en-us")).join(" ");
  if (bare(js) === bare(ipa)) continue;
  const explained = applyKnown(bare(js)) === bare(ipa);
  divergent.push({ text, python: ipa, js, explained });
}

const unexplained = divergent.filter((d) => !d.explained);
const rate = (divergent.length / corpus.length) * 100;
console.log(`corpus       ${corpus.length} lines`);
console.log(`divergent    ${divergent.length} (${rate.toFixed(1)}%)`);
console.log(`  explained by oː -> ɔː alone: ${divergent.length - unexplained.length}`);
console.log(`  unexplained:                 ${unexplained.length}`);

if (unexplained.length) {
  console.log("\nunexplained divergences:");
  const show = verbose ? unexplained : unexplained.slice(0, 25);
  for (const d of show) {
    console.log(`  ${JSON.stringify(d.text)}`);
    console.log(`    python ${d.python}`);
    console.log(`    node   ${d.js}`);
  }
  if (show.length < unexplained.length) {
    console.log(`  ... and ${unexplained.length - show.length} more (--verbose for all)`);
  }
}
