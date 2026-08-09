// A settings store for tests, with the protocol already decided.
//
// A test that fakes the provider factory has faked the wrong layer on its own.
// `backendForRole` resolves a protocol *before* the factory is reached, and on
// the shipped default of `auto` that means `detectProtocol` issues a real HTTP
// probe to `localhost:11434` with a two-second deadline. A unit test with a
// stubbed provider therefore still depends on whether a real Ollama answers in
// time — and under a parallel suite it often does not. The probe fails, the
// backend resolves to null, no inference happens, and the assertion fails with
// an empty string or a zero count rather than with anything that names the
// cause.
//
// That was latent for as long as the protocol cache held one lucky answer for
// the whole process. Making `SettingsStore.update` drop the cache — correct in
// production, because applying settings is what a user does after changing what
// is listening — turned one probe per run into one per update, and took the
// suite from about one failure to about six.
//
// Pinning the protocol removes the network from the question entirely:
// `resolveProtocol` short-circuits on an explicit preference and never probes.
// Tests that are *about* detection still set their own protocol, or stub fetch,
// and they should — this is for the majority, which are about something else.

import { SettingsStore } from "../src/storage/settings.js";

/**
 * Load a store and pin both backends to Ollama's native protocol.
 *
 * `ollama` rather than `openai` because it is what the default endpoint speaks
 * and what the fake providers in these tests imitate.
 */
export async function pinnedSettings(dir: string): Promise<SettingsStore> {
  const store = new SettingsStore(dir);
  await store.load();
  await store.update({
    backends: { chat: { protocol: "ollama" }, observation: { protocol: "ollama" } },
  });
  return store;
}
