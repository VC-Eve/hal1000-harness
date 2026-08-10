import { BACKEND_SLOTS, type BackendSlot, type ClientMessage, type Conversation, type NarrationEntry, type VisionPresence } from "../../shared/src/types.js";
import {
  DEFAULT_CHAT_PROMPT,
  DEFAULT_CONTEXT_PREAMBLE,
  PROMPT_CATALOG,
  contextBudgetChars,
  isBlankPrompt,
  resolvePrompt,
  usableWindowTokens,
} from "../../shared/src/prompts.js";
import { renderChatContext } from "./templates/chatContext.js";
import { composeSystemMessage } from "./templates/conversationSystem.js";
import { identityMayLeave } from "./origin.js";
import { ProviderError, type ChatMessage, type ModelInfo, type Provider, type ProviderFactory } from "./providers/provider.js";
import { probeEachBackend } from "./providers/probe.js";
import { backendForRole, contextCapFor, endpointForRole } from "./providers/resolve.js";
import { knownWindow, rememberWindow, windowFor } from "./providers/windows.js";
import type { ProviderQueue } from "./providers/queue.js";
import type { ConversationStore } from "./storage/conversations.js";
import type { SettingsStore } from "./storage/settings.js";
import type { WsHub } from "./ws.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// How much of the feed to read before filtering to the watched session. A
// bound on the read, not on the budget — the budget decides what survives.
const FEED_READ = 300;

/**
 * What a Conversation may be told about, read at send time.
 *
 * An interface rather than the concrete services because chat has no business
 * knowing about appearance continuity or day-partitioned logs, and because
 * every method here must be read per request: a value captured once for one
 * caller is stale for the next, which this project has already paid for once.
 */
export interface ContextSources {
  presence(): VisionPresence;
  newestCaption(): Promise<{ caption: string; at: string } | null>;
  people(): Promise<readonly { name: string; profile?: string; isOperator?: boolean }[]>;
  recentObservations(limit: number): Promise<readonly NarrationEntry[]>;
  identityThresholds(): { recognition: number; statement: number };
}

// Chat service: wires WS chat messages to storage and the provider queue.
// Single-user tool — all updates broadcast so every open tab stays in sync.
export class ChatService {
  // Conversations with a generation queued or streaming; blocks duplicates.
  private readonly generating = new Set<string>();

  // Model windows live in `providers/windows.ts`, not in a field here. They
  // used to be private to this service, which was fine while chat was the only
  // role that clamped against one; now narration, monitors and Vision each need
  // the same number to derive the same `num_ctx`, and a second cache would be a
  // second answer.

  constructor(
    private readonly hub: WsHub,
    private readonly store: ConversationStore,
    private readonly settings: SettingsStore,
    private readonly queue: ProviderQueue,
    private readonly providerFactory: ProviderFactory,
    private readonly sources?: ContextSources,
  ) {
    // Catch everything: an escaped rejection from a fire-and-forget handler
    // would crash the process.
    hub.onMessage((msg) => {
      this.handle(msg).catch((err: unknown) => {
        console.error(`chat handler error: ${err instanceof Error ? err.message : String(err)}`);
      });
    });
    hub.onConnection((client) => {
      void this.greet(client).catch(() => {});
    });
  }

  // On-connect resync: push chat-domain state like narration and readiness
  // already do, so any client gets a uniform contract without a handshake.
  private async greet(client: Parameters<WsHub["sendTo"]>[0]): Promise<void> {
    this.hub.sendTo(client, { type: "settings", settings: this.settings.get(), prompts: PROMPT_CATALOG });
    this.hub.sendTo(client, { type: "conversations", conversations: await this.store.list() });
  }

  // Provider resolves per request so a backend change applies next-request
  // (R18). An endpoint whose protocol cannot be determined is reported as
  // unavailable here rather than further in, so every caller sees the same
  // failure it already handles for an unreachable provider.
  private async provider(): Promise<Provider> {
    const backend = await backendForRole("chat", this.settings);
    if (!backend) {
      throw new ProviderError("provider_unavailable", "The chat backend is not reachable.");
    }
    return this.providerFactory(backend);
  }

  private async handle(msg: ClientMessage): Promise<void> {
    // conversationId is client-supplied and becomes a file path segment —
    // reject anything that is not a UUID before it reaches the store.
    if ("conversationId" in msg && !UUID_PATTERN.test(msg.conversationId)) return;
    switch (msg.type) {
      case "list-conversations":
        await this.broadcastConversations();
        return;
      case "open-conversation": {
        const conversation = await this.store.get(msg.conversationId);
        if (conversation) this.hub.broadcast({ type: "conversation", conversation });
        return;
      }
      case "new-conversation": {
        // Pin the default chat model server-side on a fresh install so
        // narration's follow-chat-model default works for every client type.
        if (!this.settings.get().chatModel) {
          this.hub.broadcast({ type: "settings", settings: await this.settings.update({ chatModel: msg.model }), prompts: PROMPT_CATALOG });
        }
        // The prompt is resolved and stamped server-side rather than taken
        // from the client, so every client type gets the same seeding and the
        // copy is fixed from the moment the Conversation exists (R8).
        const s = this.settings.get();
        const conversation = await this.store.create(msg.model, resolvePrompt(s.chatDefaultPrompt, DEFAULT_CHAT_PROMPT));
        this.hub.broadcast({ type: "conversation", conversation });
        await this.broadcastConversations();
        return;
      }
      case "delete-conversation":
        await this.store.delete(msg.conversationId);
        await this.broadcastConversations();
        return;
      case "send-message":
        await this.sendMessage(msg.conversationId, msg.content);
        return;
      case "regenerate":
        await this.regenerate(msg.conversationId);
        return;
      case "select-model": {
        const conversation = await this.store.setModel(msg.conversationId, msg.model);
        if (conversation) this.hub.broadcast({ type: "conversation", conversation });
        return;
      }
      case "set-conversation-prompt": {
        const conversation = await this.store.setSystemPrompt(msg.conversationId, msg.prompt, msg.isTemplate === true);
        if (conversation) this.hub.broadcast({ type: "conversation", conversation });
        return;
      }
      case "set-conversation-context": {
        const conversation = await this.store.setContext(msg.conversationId, msg.context);
        if (conversation) this.hub.broadcast({ type: "conversation", conversation });
        return;
      }
      case "acknowledge-off-machine":
        this.hub.broadcast({
          type: "settings",
          settings: await this.settings.update({ offMachineAcknowledged: msg.accepted === true }),
          prompts: PROMPT_CATALOG,
        });
        return;
      case "list-models":
        await this.listModels();
        return;
      case "get-settings":
        this.hub.broadcast({ type: "settings", settings: this.settings.get(), prompts: PROMPT_CATALOG });
        return;
      case "update-settings":
        this.hub.broadcast({ type: "settings", settings: await this.settings.update(msg.patch), prompts: PROMPT_CATALOG });
        return;
      default:
        return;
    }
  }

  private async broadcastConversations(): Promise<void> {
    this.hub.broadcast({ type: "conversations", conversations: await this.store.list() });
  }

  /**
   * List each backend's models, one broadcast per slot.
   *
   * Per slot because a model list belongs to a server. Listing only chat's and
   * letting the narration picker read it offered models from the wrong machine
   * — harmless while both slots named the same one, and wrong as soon as they
   * did not.
   *
   * One request when both name the same destination, which `probeEachBackend`
   * decides: asking twice would cost a round trip to say the same thing, and
   * would let the two lists disagree about one machine while it was being
   * restarted. Deciding it here, by endpoint, is what reported a working
   * observation backend as unreachable because chat's keyless request to the
   * same host had failed.
   */
  private async listModels(): Promise<void> {
    const probed = await probeEachBackend(BACKEND_SLOTS, this.settings, (backend) =>
      this.providerFactory(backend).listModels(),
    );

    for (const slot of BACKEND_SLOTS) {
      const probe = probed.get(slot);
      const result: ModelInfo[] | "error" = probe && "value" in probe ? probe.value : "error";
      if (result === "error") {
        this.hub.broadcast({ type: "models", slot, models: [], error: "provider_unavailable" });
        continue;
      }
      // Windows are chat's alone: Context Level sizes a conversation's request,
      // and nothing sizes a narration prompt against a window the user picked.
      if (slot !== "chat") {
        this.hub.broadcast({ type: "models", slot, models: result.map((m) => m.name) });
        continue;
      }
      const windows = await this.windowsFor(result);
      this.hub.broadcast({
        type: "models",
        slot,
        models: result.map((m) => m.name),
        windows,
        windowSource: await this.windowSource(windows),
      });
    }
  }

  /**
   * The window for each model, filled here rather than at send time so the
   * control's label and the request cannot disagree: a window discovered later
   * would make the label a promise the request did not keep. Only the models
   * that omitted it cost a request, and the answers warm the send-time cache.
   *
   * A cached null is an answer, not an absence — the same distinction
   * `windowFor` makes with `has`. Read with `??` it was a miss, so a backend
   * that reports no window at all was re-asked about every model on every
   * connect, one timeout at a time.
   */
  private async windowsFor(models: readonly ModelInfo[]): Promise<Record<string, number>> {
    const windows: Record<string, number> = {};
    let provider: Provider;
    try {
      provider = await this.provider();
    } catch {
      return windows;
    }
    const endpoint = endpointForRole("chat", this.settings.get());
    for (const model of models) {
      const cached = knownWindow(endpoint, model.name);
      let known: number | null;
      if (model.contextTokens !== undefined) {
        known = model.contextTokens;
      } else if (cached !== undefined) {
        known = cached;
      } else {
        known = (await provider.modelWindow?.(model.name).catch(() => null)) ?? null;
      }
      rememberWindow(endpoint, model.name, known);
      if (known !== null) windows[model.name] = known;
    }
    return windows;
  }

  private async sendMessage(conversationId: string, content: string): Promise<void> {
    const conversation = await this.store.appendMessage(conversationId, {
      role: "user",
      content,
      at: new Date().toISOString(),
    });
    if (!conversation) return;
    this.hub.broadcast({ type: "conversation", conversation });
    await this.generate(conversation);
  }

  private async regenerate(conversationId: string): Promise<void> {
    const conversation = await this.store.popInterrupted(conversationId);
    if (!conversation) return;
    this.hub.broadcast({ type: "conversation", conversation });
    await this.generate(conversation);
  }

  private async generate(conversation: Conversation): Promise<void> {
    if (this.generating.has(conversation.id)) return;
    this.generating.add(conversation.id);
    try {
      await this.runGeneration(conversation);
    } finally {
      this.generating.delete(conversation.id);
    }
  }

  /**
   * How many tokens this model can hold, asked once per model.
   *
   * Never throws: not knowing the window is a degraded answer the caller
   * already handles by falling back to a conservative one, whereas a failure
   * here would take down a send over a number it can do without.
   */
  private async windowFor(model: string): Promise<number | null> {
    const endpoint = endpointForRole("chat", this.settings.get());
    const known = knownWindow(endpoint, model);
    if (known !== undefined) return known;
    let provider: Provider;
    try {
      provider = await this.provider();
    } catch {
      // An unreachable provider is an answer worth caching: without it a
      // backend that is down is re-asked on every keystroke-length message.
      rememberWindow(endpoint, model, null);
      return null;
    }
    return windowFor(endpoint, model, provider);
  }

  /**
   * Whether this backend takes a context window per request.
   *
   * Only Ollama's native API does. `llama-server` fixes `n_ctx` when it starts
   * and a hosted API does not expose one at all, so on those the cap describes
   * a budget HAL spends inside a window it did not choose. The control says
   * which, because a control whose meaning changes silently with a setting
   * elsewhere is the failure the per-request window was added to prevent.
   *
   * `"reported"` is a claim about a number that arrived, so it is derived from
   * whether one did. Deriving it from the protocol alone made it unconditional
   * for every non-Ollama backend — including a hosted API that 404s the window
   * route, where nothing was reported, the conservative default is in force, and
   * the control nonetheless told the user the server had fixed the window. That
   * left the `"unknown"` branch, whose wording exists for exactly this case,
   * reachable only when the backend failed to resolve at all.
   *
   * Per slot rather than per model, because that is the granularity the message
   * carries: a backend that answered for none of its models cannot have its
   * window described as reported for any of them.
   */
  private async windowSource(windows: Record<string, number>): Promise<"requested" | "reported" | "unknown"> {
    const backend = await backendForRole("chat", this.settings).catch(() => null);
    if (!backend) return "unknown";
    if (backend.protocol === "ollama") return "requested";
    return Object.keys(windows).length > 0 ? "reported" : "unknown";
  }

  /**
   * The observation context this send carries, and the profile text to keep out
   * of the inference log.
   *
   * Assembled per request and never written to the Conversation: persisting it
   * would put profile text beyond the reach of per-person deletion and the
   * biometric purge, and would freeze the roster at the moment the thread was
   * created so a rename never reached an open thread.
   */
  private async assembleContext(conversation: Conversation): Promise<{ text: string; redact: string[] }> {
    const empty = { text: "", redact: [] };
    const level = conversation.context;
    // Both off is the untouched path, and it is checked before anything is
    // read: a thread that asked for nothing must not even consult the camera.
    if (!level || (level.vision === "off" && level.session === "off")) return empty;
    if (!this.sources) return empty;

    const s = this.settings.get();
    // Gated on the provider in effect at THIS send, not on the switch
    // transition — configuring a remote provider after turning the switch on
    // must not carry identity data out on the strength of an older decision.
    // The check sits at the send for the reason
    // docs/solutions/a-gate-that-checks-one-direction-is-half-a-gate.md gives:
    // a gate at the toggle guards the toggle and gives the sends away.
    // Against the backend *chat* resolves to, not a global endpoint: a local
    // chat backend is not gated because narration is remote, and a remote chat
    // backend is gated even while narration stays local.
    if (!identityMayLeave(endpointForRole("chat", s), s.offMachineAcknowledged)) return empty;

    const window = usableWindowTokens(await this.windowFor(conversation.model), s.chatContextCap);

    // Only what this thread asked for is read. A conversation with sight
    // switched off must not cause a camera read, and one with the session
    // switched off must not cause a feed read — the switches govern what HAL
    // consults, not only what it says.
    const wantsVision = level.vision !== "off";
    const wantsSession = level.session !== "off";

    // The shipped default puts session before sight, and that order is
    // load-bearing rather than arbitrary: with sight first, a model asked what
    // it could see answered from the narration instead, while a caption
    // describing the room sat above it. The order now belongs to the template,
    // so the default is where the reasoning is kept.
    const rendered = renderChatContext(s.templates?.["chat-context"] ?? null, {
      phrases: s.phrases,
      presence: wantsVision ? this.sources.presence() : { watching: false, present: [] },
      lastLook: wantsVision ? await this.sources.newestCaption() : null,
      people: wantsVision ? await this.sources.people() : [],
      thresholds: this.sources.identityThresholds(),
      entries: wantsSession ? await this.sources.recentObservations(FEED_READ) : [],
      watchedSessionId: s.watchedSessionId,
      preamble: resolvePrompt(s.chatContextPreamble, DEFAULT_CONTEXT_PREAMBLE),
      visionBudget: wantsVision ? contextBudgetChars(level.vision, window) : 0,
      sessionBudget: wantsSession ? contextBudgetChars(level.session, window) : 0,
    });

    if (rendered.text.length === 0) return empty;
    // The profile text is named by the slot that rendered it rather than
    // recovered by searching the finished string, which is what survives the
    // wording around it becoming the user's.
    return { text: rendered.text, redact: rendered.redact };
  }

  private async runGeneration(conversation: Conversation): Promise<void> {
    let accumulated = "";
    // Built inside the try: a hand-edited store can put a non-string in the
    // prompt slot, and a throw out here would escape into the handler's
    // catch-all, leaving the client with no chat-error and a dead composer.
    try {
      // A blank prompt omits the system message entirely rather than sending an
      // empty one (R11) — that is what preserves pre-prompt chat behaviour byte
      // for byte, and an empty system message is not the same request.
      //
      // Context is appended to it rather than sent as a second system message.
      // With both switches off this whole branch adds nothing, which is what
      // keeps the pre-feature request identical; with either on, a blank prompt
      // now produces exactly one system message where it produced none.
      const prompt = conversation.systemPrompt ?? "";
      // Failure here degrades the send rather than ending it: a camera or a log
      // that cannot be read is a reason to say less, not a reason to refuse a
      // reply the user is waiting on.
      const context = await this.assembleContext(conversation).catch((err: unknown) => {
        console.error(`context assembly failed: ${err instanceof Error ? err.message : String(err)}`);
        return { text: "", redact: [] as string[] };
      });
      // The raw value, not `String(prompt)`: a hand-edited store can put a
      // number in this slot, and stringifying before the blank check turns a
      // value that should be dropped into a system message reading "42".
      const system = composeSystemMessage(conversation, prompt, context.text);
      const history: ChatMessage[] = [
        ...(system.length > 0 ? [{ role: "system" as const, content: system }] : []),
        ...conversation.messages.map((m) => ({ role: m.role, content: m.content })),
      ];
      // Resolved before the job is queued, not inside it, because the queue
      // needs to know where this job is going to decide whether it contends
      // with in-flight narration.
      const provider = await this.provider();
      const endpoint = endpointForRole("chat", this.settings.get());
      // The cap is the one in force for this model on this machine, not chat's
      // own — see `contextCapFor`. Only ever raised by a role that shares the
      // destination, so the budgets packed above still fit inside it.
      const numCtx = usableWindowTokens(
        await this.windowFor(conversation.model),
        contextCapFor(endpoint, conversation.model, this.settings.get(), this.settings.get().chatContextCap),
      );
      await this.queue.enqueue("chat", async (signal) => {
        const stream = provider.chatStream({
          model: conversation.model,
          messages: history,
          signal,
          // Set explicitly, the way every narration path already does. Left
          // unset, the budgets above would be sized against a window nobody
          // stated and overflow would cost the front of the prompt — which is
          // where the user's own system prompt sits.
          //
          // Ollama only. The OpenAI-compatible schema has no field for it, and
          // its provider ignores this rather than sending something a server
          // would reject; naming the condition here keeps the reason visible at
          // the site that would otherwise look unconditional.
          options: { num_ctx: numCtx },
          ...(context.redact.length > 0 ? { redact: context.redact } : {}),
          // Keyed by conversation, so one thread's inference history is one
          // file rather than a slice of a shared one.
          source: { kind: "chat", id: conversation.id, label: conversation.title },
        });
        for await (const token of stream) {
          accumulated += token;
          this.hub.broadcast({ type: "chat-token", conversationId: conversation.id, token });
        }
      }, endpoint);
      const message = { role: "assistant" as const, content: accumulated, at: new Date().toISOString() };
      await this.store.appendMessage(conversation.id, message);
      this.hub.broadcast({ type: "chat-done", conversationId: conversation.id, message });
    } catch (err) {
      await this.handleGenerateError(conversation.id, accumulated, err);
    }
  }

  private async handleGenerateError(conversationId: string, partial: string, err: unknown): Promise<void> {
    const code = err instanceof ProviderError && err.code === "model_not_found" ? "model_not_found" : "provider_unavailable";
    try {
      if (partial.length > 0) {
        // Persist what streamed before the failure, marked interrupted
        // (AE-style recovery: the UI offers regenerate).
        const message = { role: "assistant" as const, content: partial, at: new Date().toISOString(), interrupted: true };
        await this.store.appendMessage(conversationId, message);
        this.hub.broadcast({ type: "chat-done", conversationId, message });
      }
    } catch (persistErr) {
      console.error(`failed to persist interrupted reply: ${persistErr instanceof Error ? persistErr.message : String(persistErr)}`);
    } finally {
      // The UI must always learn the generation ended, even if the recovery
      // write itself failed — otherwise it hangs on a phantom stream.
      const detail = err instanceof Error ? err.message : String(err);
      this.hub.broadcast({ type: "chat-error", conversationId, code, message: detail });
    }
  }
}
