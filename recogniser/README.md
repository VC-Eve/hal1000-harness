# @hal1000/recogniser

A local process that finds faces in a frame and turns each one into a comparable vector. HAL points
at it by URL and never starts, supervises, or stops it — exactly as it points at Ollama and at the
captioner.

It answers one question and holds no opinion about people. It tracks nothing between calls: no
cache, no last-seen face, no state of any kind. Deciding that two detections are the same person
across time is HAL's job, and this process is built so it cannot quietly do that job instead.

## Running it

```
npm install          # at the repo root — this is the entire build step
npm run start:recogniser
```

It listens on `127.0.0.1:8100` by default, beside the captioner on 8099.

The first start downloads SFace (37MB) and verifies it against a digest published by the OpenCV Zoo
repository. That download happens once. If it fails, the process still starts and still detects
faces — `/health` says why matching is unavailable rather than the process refusing to boot.

| Variable | Default | What it does |
|---|---|---|
| `HAL_RECOGNISER_PORT` | `8100` | Listening port |
| `HAL_RECOGNISER_ALLOW_REMOTE` | unset | Must be `1` before it binds anywhere but loopback |
| `HAL_RECOGNISER_HOST` | `127.0.0.1` | Bind address; ignored unless the flag above is set |
| `HAL_RECOGNISER_MODELS_DIR` | `./models` | Where the two ONNX files live |
| `HAL_RECOGNISER_DETECTION_THRESHOLD` | `0.6` | Minimum YuNet score for a face |
| `HAL_RECOGNISER_MAX_FRAME_BYTES` | `16777216` | Largest accepted frame body |
| `HAL_RECOGNISER_FETCH_MODELS` | `1` | Set `0` to never touch the network |

Binding off loopback takes a separate acknowledgement because whole camera frames cross this
boundary on the detection cadence — everyone in the room, not just enrolled faces.

## The protocol

### `GET /health`

```json
{ "service": "hal1000-recogniser", "version": 1, "detector": "ok", "embedder": "ok" }
```

`service` is there so a caller can tell this process from anything else that happens to be listening
on the port. A liveness probe answers "is something listening", never "is this mine".

`detector` and `embedder` are reported separately and are each one of `ok`, `fetching`,
`unreachable`, `corrupt`, or `absent`. A missing embedder is not a missing recogniser.

### `POST /detect`

Body: a JPEG frame, `Content-Type: image/jpeg`.

```json
{
  "width": 640,
  "height": 480,
  "faces": [
    {
      "box": { "x": 241.4, "y": 90.2, "w": 165.1, "h": 224.3 },
      "score": 0.935,
      "landmarks": [[290,174],[363,176],[327,215],[294,255],[352,257]],
      "embedding": [0.031, -0.118, ...],
      "alignment": 0.68
    }
  ]
}
```

One entry per face: two people in frame produce two entries, and nothing is merged across them.

- **Coordinates are yours.** The box and landmarks are in the frame you sent, not in the 640×640 the
  detector works in internally. Cut a crop straight out of your own frame with them.
- **Landmarks** are `[right eye, left eye, nose, right mouth corner, left mouth corner]` — the
  subject's right, so the first point is the left-most in the image.
- **`embedding`** is 128 values, L2-normalised, so comparing two faces is a dot product. It is `null`
  when SFace is unavailable; detection still works.
- **`alignment`** is how well the five landmarks fitted the canonical template, in template pixels.
  Low is good. A frontal face lands near 1; a profile or a bad detection climbs past 10, and the
  embedding is correspondingly less trustworthy.

Other statuses: `400` for an undecodable frame, `413` for one over the size cap, `415` for a body
that is not JPEG, `503` with `condition: "busy"` when too many requests are already waiting.
Inference is serialised — a face costs single-digit milliseconds against a cadence measured in
seconds, so there is no throughput to win and there is contention with chat and narration to avoid.

## The models

Both are from the [OpenCV Zoo](https://github.com/opencv/opencv_zoo) under Apache 2.0.

| Model | Size | How it arrives |
|---|---|---|
| YuNet 2023mar (detection) | 227KB | Committed to the repo |
| SFace 2021dec (embedding) | 37MB | Fetched once on first run |

Each is verified against the `sha256` in the OpenCV Zoo repository's own git-LFS pointer — published
by the model's repository rather than computed from whatever arrived first. That protects against
corruption, truncation and later substitution. It is not a signature.

Both are pinned to dated releases rather than a moving alias. A different export can change the
tensor layout, the fixed input size, or the landmark order, and none of those fail loudly.

## Tests

```
npm test
```

The geometry, decode, NMS and hash-verification suites run everywhere. The suites that need a real
face need two things this repo deliberately does not ship: SFace, and a face fixture. They skip
**loudly**, printing what was skipped and how to fix it, because a suite that reports success while
having verified nothing is worse than one that fails.

To create the fixture:

```
npx tsx recogniser/scripts/capture-fixture.mts            # or pass a device name
npx tsx recogniser/scripts/capture-fixture.mts --list     # to see the cameras
```

It takes a burst of frames and keeps the best, judged on detection score **and** how well the five
landmarks fit the template. If no frame qualifies it writes nothing and exits non-zero — a fixture
of a badly-posed face would let every downstream test pass while proving little. The output is
gitignored and never leaves your machine: a photograph of a person in git history is permanent, and
this feature's whole brief is about not holding biometric data for people who did not ask to be
held.
