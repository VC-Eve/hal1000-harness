# The voice oracle

Recorded from the reference Python implementation (`kokoro-onnx`) by
`scripts/record-voice-oracle.py`, **before** `server/src/voice/` existed. The Node synthesiser is a
reimplementation, and these files are what it is checked against — a recording made independently of
the code under test, rather than a snapshot of that code's own output.

**A fixture may only be re-recorded by re-running the script that made it.** Editing one to make a
test pass destroys the only thing it is for. See
`docs/solutions/byte-identity-needs-an-oracle-recorded-first.md`.

| File | What it pins |
|---|---|
| `manifest.json` | The reference environment: interpreter, package versions, model digests |
| `vocab.json` | The 114-entry IPA-to-id table and the 510-token cap. `server/src/voice/vocab.ts` is transcribed from this, never typed by hand |
| `phonemes.json` | IPA for the named fixture lines, including the documented `Gigashredder` breakage |
| `differential-python.json` | IPA for the 186-line differential corpus |
| `styles.json` | Digests of five blended style vectors, plus the first eight floats of rows 0 and 509 so a failure says *how* it differs |
| `audio.json` | Raw PCM digest for one line through the exact token/style/speed path, plus the tokens and style row that produced it |

## The pipeline these were recorded through

Read out of `kokoro_onnx`, not guessed:

```
text  -> normalize_text (which is only text.strip())
      -> espeak-ng via phonemizer, preserve_punctuation=True, with_stress=True
      -> keep only characters present in the vocabulary
tokens = [vocab[c] for c in phonemes]          # unknown characters dropped, cap 510
style  = voice[min(len(tokens), len(voice)) - 1]   # row n-1, NOT row n
inputs = { tokens: [[0, *tokens, 0]], style, speed }   # the padding is not counted for the row
```

Two of those are easy to get wrong and neither is obvious from the outside. The style row is
`n - 1`, and the two padding zeroes are added *after* the row is chosen.

## Measured divergence from the npm phonemiser

`node scripts/differential-phonemes.mjs` compares the npm `phonemizer` against
`differential-python.json`. Measured 2026-09-06, `phonemizer` 1.2.1 against espeak-ng 1.52.0 on the
Python side:

```
corpus       186 lines
divergent    57 (30.6%)
  explained by oː -> ɔː alone: 38
  unexplained:                 19  (10.2% of the corpus)
```

Spot-checking five lines during planning found **zero** divergence, because those lines happened to
contain `ɑː` and no `ɔː`. Thirty percent of a realistic corpus diverges. That gap between a sample
and a corpus is the entire reason this pass exists.

### The vowel rule is total, not a heuristic

The reference emits `ɔː` on 45 of 195 recorded lines and **`oː` on none of them**. The two builds
spell one phoneme differently; there is no case where `oː` is what the reference meant. So
`phonemes.ts` rewrites `oː` to `ɔː` unconditionally. Both symbols are in the vocabulary (`ɔ` is 76,
`o` is 57), so without the rule nothing errors — the character just says a different vowel, on words
as common as *aboard*, *reports*, *forty* and *support*. Silent wrong pronunciation is the failure
class R21's phoneme readout exists for, and this is it at 20% of a corpus.

### The remaining 10.2% is not closable, and is not a defect

The npm package's whole API is `phonemize(text, language)` — it takes no options, so
`preserve_punctuation=True` cannot be passed. That flag changes how espeak *segments* text, not just
what it prints, so the difference cannot be post-processed away:

| Input | Reference | Node |
|---|---|---|
| `0.5` | zero. five | zero point five |
| `09:00` | zero nine**:**zero zero (a literal colon in the phoneme stream) | nine zero zero |
| `Dr.` | dˈɑːktɚ**.** | dˈɑːktɚɹ |
| `e.g.` | ˈiː.dʒˈiː. | for example |

Where these differ, Node is generally the better reading — the reference's "zero. five" is an
artefact of punctuation preservation, not an intended pronunciation. They are pinned as fixtures so
the difference is known rather than discovered, and they cluster on decimals, times and Latin
abbreviations, which are rare in spoken character dialogue.

Re-run the pass after any `phonemizer` bump. A change in either number is a change in how the
character pronounces things, and nothing else in the suite would notice.
