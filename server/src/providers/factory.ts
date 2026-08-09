// Which implementation serves a backend.
//
// One switch, in one place. The alternative — each call site choosing — is how
// a fifth inference role ends up reaching only one of the two protocols
// because nobody remembered it existed.

import { OllamaProvider } from "./ollama.js";
import { ProviderError, type Provider, type ResolvedBackend } from "./provider.js";

export function makeProvider(backend: ResolvedBackend): Provider {
  switch (backend.protocol) {
    case "ollama":
      return new OllamaProvider(backend.endpoint);
    case "openai":
      // Filled in when the OpenAI-compatible provider lands. Reachable only
      // from a backend that names the protocol, and nothing names it yet.
      throw new ProviderError(
        "provider_unavailable",
        "No implementation is registered for the OpenAI-compatible protocol.",
      );
  }
}
