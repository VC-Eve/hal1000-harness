// How to get a captioner running.
//
// HAL points at the captioner rather than installing or supervising it, exactly
// as it points at Ollama: one mental model for "a local model server HAL talks
// to", one shape of failure, one readiness leg each. The cost of that choice is
// that a new install has something to do first — so the instructions live here,
// in one place, and both the settings drawer and the pane render this constant
// rather than each spelling the command out. Two copies of a command string is
// the shape `docs/solutions/css-tracks-with-two-sources-of-truth.md` warns about.

// llama.cpp rather than Ollama on purpose. Chat Preemption works because
// ProviderQueue owns the lane and can abort what it scheduled; a captioner
// inside Ollama could sit in front of a chat request in Ollama's own scheduler,
// where HAL's abort has no reach.
export const CAPTIONER_MODEL = "ggml-org/Qwen2.5-VL-3B-Instruct-GGUF";

export const CAPTIONER_DEFAULT_PORT = 8099;

// `-hf` downloads the model on first run, so the only thing to install is the
// binary. `-ngl 0` keeps the captioner off the GPU: a cycle is minutes long, so
// it can afford CPU, and the card stays free for chat and narration.
export const CAPTIONER_COMMAND =
  `llama-server -hf ${CAPTIONER_MODEL} -ngl 0 --host 127.0.0.1 --port ${CAPTIONER_DEFAULT_PORT}`;

export const CAPTIONER_SETUP_STEPS: readonly string[] = [
  "Download a llama.cpp release build for this machine from github.com/ggml-org/llama.cpp/releases — no compiling.",
  "Run the command below. The model downloads itself the first time, so this is the only install step.",
  "Leave it running. HAL talks to it; it does not start or stop it.",
];

// Roughly 2.6GB of weights, and about 20s per frame on CPU — ample against an
// interval measured in minutes. Drop `-ngl 0` to put it on the GPU instead:
// faster per frame, and about 3.6GB of VRAM taken from chat.
export const CAPTIONER_NOTE =
  "Drop -ngl 0 to run it on the GPU: faster per frame, about 3.6GB of VRAM taken from chat and narration.";
