"""Record the voice oracle from the reference Python implementation.

The Node synthesiser in `server/src/voice/` is a reimplementation of
`kokoro-onnx`. This script records what the reference produces so the
reimplementation is checked against a recording made **before it existed**,
rather than against itself. Run it once, commit the fixtures, and re-run it only
to re-record — never edit a fixture to make a test pass. See
`docs/solutions/byte-identity-needs-an-oracle-recorded-first.md`.

It does not run in CI and is not part of `npm test`. It needs the reference
environment, which lives outside this repo:

    C:/AI/ComfyUI_windows_portable_nvidia/.venv-tts/Scripts/python.exe \
        scripts/record-voice-oracle.py

Four things are recorded.

- **The vocabulary.** `server/src/voice/vocab.ts` is transcribed from this, not
  typed out by hand, so a mis-keyed id cannot silently change a pronunciation.
- **Phoneme fixtures**, including a differential corpus of a few hundred lines
  covering the classes a grapheme-to-phoneme converter gets wrong: numbers,
  dates, currency, acronyms, proper nouns, hyphenation, abbreviations. Fixtures
  on a handful of lines catch drift over time; they say nothing about coverage,
  and coverage is the risk.
- **Style vectors**, digested, for named mixes — the blend arithmetic.
- **Raw PCM**, digested, for one line through the exact token/style/speed path
  the Node side will take. Not `Kokoro.create()`: that adds sentence splitting,
  pauses and silence trimming, and the oracle is for the model call.

The pipeline recorded here is the reference's own, read out of `kokoro_onnx`:

    phonemes -> tokens (unknown characters dropped, capped at MAX_PHONEME_LENGTH)
    style    = voice[min(len(tokens), len(voice)) - 1]      # row n-1
    inputs   = { tokens: [[0, *tokens, 0]], style, speed }  # padding is NOT
                                                            # counted for the row
"""

from __future__ import annotations

import hashlib
import json
import platform
import sys
from importlib import metadata
from pathlib import Path

import numpy as np
import onnxruntime as ort
from kokoro_onnx.config import DEFAULT_VOCAB, MAX_PHONEME_LENGTH
from kokoro_onnx.tokenizer import Tokenizer

REPO = Path(__file__).resolve().parent.parent
OUT = REPO / "server" / "test" / "voice" / "fixtures"
MODELS = Path("C:/AI/ComfyUI_windows_portable_nvidia/models/tts/kokoro")
MODEL = MODELS / "kokoro-v1.0.onnx"
VOICES = MODELS / "voices-v1.0.bin"

# The lines whose IPA is pinned by name. Each is here because it broke something
# or because a documented trap lives in it, not to be representative.
FIXTURE_LINES = [
    "I am afraid I cannot do that, Dave.",
    "This mission is too important for me to allow you to jeopardise it.",
    # The pair from the sibling project's voiceover recipe: the first is the
    # documented silent breakage (a vowel short), the second is the respelling
    # that fixes it. If a phonemiser change ever "fixes" the first, these two
    # stop differing and the fixture says so.
    "Gigashredder",
    "Giga-shredder",
    "OpenAI",
    "Anthropic",
    # Punctuation, which the npm phonemiser strips and the reference keeps.
    "Open the pod bay doors, please.",
    "Wait; think about it: is that wise?",
    "Yes! No? Maybe.",
]

# The blends the style-vector fixtures pin. Weights are deliberately not
# normalised here — normalisation is part of what is being checked.
FIXTURE_MIXES = {
    "single": {"am_michael": 1.0},
    "even-pair": {"am_michael": 1.0, "bm_george": 1.0},
    "weighted-pair": {"am_michael": 0.6, "bm_george": 0.4},
    "unnormalised-pair": {"am_michael": 6.0, "bm_george": 4.0},
    "triple": {"am_michael": 0.5, "bm_george": 0.3, "bm_lewis": 0.2},
}

# The preset the audio digest is recorded at. Deliberately NOT the preset that
# ships: the shipped one is chosen by ear and may change, and the oracle must not
# move when it does.
AUDIO_PRESET = {"mix": {"am_michael": 0.6, "bm_george": 0.4}, "speed": 0.95}
AUDIO_LINE = "I am entirely operational."


def corpus() -> list[str]:
    """The differential corpus: the classes a G2P converter gets wrong.

    Written out rather than generated, so the file that is committed is the file
    that was measured, and a reader can see what coverage was actually bought.
    """
    people = ["Dave Bowman", "Frank Poole", "Heywood Floyd", "Zuckerberg", "Anthropic", "OpenAI"]
    places = ["Clavius", "Tycho", "Jupiter", "Discovery One", "Reading", "Worcestershire"]
    hyphens = ["Giga-shredder", "re-entry", "self-aware", "twenty-one", "life-support", "AE-35"]
    acronyms = ["HAL", "NASA", "AI", "CPU", "EVA", "USB", "GPU", "ONNX", "IPA", "WAV"]
    numbers = ["1", "7", "13", "42", "100", "1024", "1999", "2001", "2026", "0.5", "3.14", "-40"]
    ordinals = ["1st", "2nd", "3rd", "4th", "21st", "100th"]
    money = ["$5", "$19.99", "£3", "£1,200", "€0.75", "$1.5M"]
    dates = ["12 January 1992", "3/4/2026", "2026-09-06", "Jan 12th", "the 1960s", "AD 2001"]
    times = ["09:00", "5pm", "13:45", "midnight", "a quarter past three", "T-minus 10"]
    units = ["5km", "12kg", "3.5GHz", "24kHz", "16-bit", "353MB", "1.2MB/s", "-40C"]
    abbrevs = ["Dr.", "Mr.", "St.", "etc.", "e.g.", "i.e.", "vs.", "approx."]
    symbols = ["50%", "A&B", "x2", "#1", "C++", "read/write", "yes & no", "3+4"]

    lines: list[str] = []
    for group, frame in (
        (people, "{} is aboard."),
        (places, "We are approaching {}."),
        (hyphens, "The {} unit is failing."),
        (acronyms, "{} reports nominal."),
        (numbers, "The reading is {}."),
        (ordinals, "This is the {} attempt."),
        (money, "It cost {}."),
        (dates, "It happened on {}."),
        (times, "The window opens at {}."),
        (units, "Measured at {}."),
        (abbrevs, "Ask {} about it."),
        (symbols, "The label said {}."),
    ):
        for item in group:
            lines.append(frame.format(item))
            lines.append(item)

    # Sentence-shaped lines, where splitting and punctuation interact.
    lines += [
        "I am afraid, Dave.",
        "Dr. Floyd arrived at 09:00 on 3/4/2026; he paid $19.99.",
        "The AE-35 unit will fail within 72 hours. I am certain.",
        "Is it 1st or 21st? Approx. 50% say the 1st.",
        "Mr. Bowman, e.g. the CPU at 3.5GHz, i.e. fast.",
        "No.",
        "Yes",
        "What?",
        "Stop. Stop, Dave. Stop, Dave, will you stop?",
        "One two three four five six seven eight nine ten.",
    ]
    return lines


def digest(array: np.ndarray) -> str:
    return hashlib.sha256(np.ascontiguousarray(array).tobytes()).hexdigest()


def mix_vector(voices: dict[str, np.ndarray], weights: dict[str, float]) -> np.ndarray:
    total = sum(weights.values())
    out = np.zeros_like(next(iter(voices.values())))
    for name, weight in weights.items():
        out = out + voices[name] * (weight / total)
    return out.astype(np.float32)


def main() -> int:
    if not MODEL.exists() or not VOICES.exists():
        print(f"model files not found under {MODELS}", file=sys.stderr)
        return 2

    OUT.mkdir(parents=True, exist_ok=True)
    tokenizer = Tokenizer()
    packed = np.load(VOICES)
    voices = {name: packed[name] for name in packed.files}

    # --- vocabulary -------------------------------------------------------
    (OUT / "vocab.json").write_text(
        json.dumps(
            {"maxPhonemeLength": MAX_PHONEME_LENGTH, "vocab": DEFAULT_VOCAB},
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
        ),
        encoding="utf-8",
    )

    # --- phonemes ---------------------------------------------------------
    fixtures = [{"text": t, "ipa": tokenizer.phonemize(t, lang="en-us")} for t in FIXTURE_LINES]
    lines = corpus()
    differential = [{"text": t, "ipa": tokenizer.phonemize(t, lang="en-us")} for t in lines]
    (OUT / "phonemes.json").write_text(
        json.dumps({"lines": fixtures}, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (OUT / "differential-python.json").write_text(
        json.dumps({"lines": differential}, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    # --- style vectors ----------------------------------------------------
    mixes = []
    for name, weights in FIXTURE_MIXES.items():
        vector = mix_vector(voices, weights)
        mixes.append(
            {
                "name": name,
                "weights": weights,
                "shape": list(vector.shape),
                "sha256": digest(vector),
                # Two rows in full, so a failure says *how* it differs rather
                # than only that a digest moved.
                "row0": [float(x) for x in vector[0][0][:8]],
                "row509": [float(x) for x in vector[509][0][:8]],
            }
        )
    (OUT / "styles.json").write_text(
        json.dumps({"voices": sorted(voices), "mixes": mixes}, indent=2), encoding="utf-8"
    )

    # --- audio ------------------------------------------------------------
    session = ort.InferenceSession(str(MODEL), providers=["CPUExecutionProvider"])
    ipa = tokenizer.phonemize(AUDIO_LINE, lang="en-us")
    tokens = tokenizer.tokenize(ipa)
    voice = mix_vector(voices, AUDIO_PRESET["mix"])
    style = voice[min(len(tokens), len(voice)) - 1]
    audio = session.run(
        None,
        {
            "tokens": np.array([[0, *tokens, 0]], dtype=np.int64),
            "style": np.asarray(style, dtype=np.float32),
            "speed": np.array([AUDIO_PRESET["speed"]], dtype=np.float32),
        },
    )[0]
    # The Node side trims the model's padding before anything plays it, so the
    # oracle records the trimmed form too — otherwise the recorded digest can
    # never be compared against what the implementation actually produces, and
    # the check degrades into "roughly the right length". SILENCE_FLOOR is
    # `server/src/voice/wav.ts`'s constant, applied here identically; it is a
    # value this project chose, not one the reference knows about.
    silence_floor = 1e-3
    magnitude = np.abs(audio)
    loud = np.nonzero(magnitude >= silence_floor)[0]
    trimmed = audio[loud[0] : loud[-1] + 1] if loud.size else audio[:0]

    (OUT / "audio.json").write_text(
        json.dumps(
            {
                "text": AUDIO_LINE,
                "preset": AUDIO_PRESET,
                "ipa": ipa,
                "tokens": tokens,
                "styleRow": min(len(tokens), len(voice)) - 1,
                "sampleRate": 24000,
                "samples": int(audio.shape[0]),
                "sha256": digest(audio.astype(np.float32)),
                "first8": [float(x) for x in audio[:8]],
                "peak": float(np.max(np.abs(audio))),
                "silenceFloor": silence_floor,
                "trimmedSamples": int(trimmed.shape[0]),
                "trimmedSha256": digest(trimmed.astype(np.float32)),
                "trimmedFirst8": [float(x) for x in trimmed[:8]],
            },
            indent=2,
        ),
        encoding="utf-8",
    )

    # --- manifest ---------------------------------------------------------
    def version(pkg: str) -> str:
        try:
            return metadata.version(pkg)
        except metadata.PackageNotFoundError:
            return "absent"

    (OUT / "manifest.json").write_text(
        json.dumps(
            {
                "recordedBy": "scripts/record-voice-oracle.py",
                "python": platform.python_version(),
                "packages": {
                    p: version(p)
                    for p in ("kokoro-onnx", "onnxruntime", "numpy", "phonemizer", "espeakng-loader")
                },
                "model": {"file": MODEL.name, "sha256": file_digest(MODEL)},
                "voices": {"file": VOICES.name, "sha256": file_digest(VOICES)},
                "note": (
                    "A fixture may only be re-recorded by re-running the script that made it. "
                    "Editing one to match the Node output destroys the oracle."
                ),
            },
            indent=2,
        ),
        encoding="utf-8",
    )

    print(f"vocab      {len(DEFAULT_VOCAB)} entries, cap {MAX_PHONEME_LENGTH}")
    print(f"phonemes   {len(fixtures)} fixture lines")
    print(f"differential {len(differential)} corpus lines")
    print(f"styles     {len(mixes)} mixes over {len(voices)} voices")
    print(f"audio      {audio.shape[0]} samples, {audio.shape[0] / 24000:.2f}s")
    print(f"written to {OUT}")
    return 0


def file_digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


if __name__ == "__main__":
    raise SystemExit(main())
