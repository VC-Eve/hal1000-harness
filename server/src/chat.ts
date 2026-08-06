import type { ClientMessage, Conversation } from "../../shared/src/types.js";
import { DEFAULT_CHAT_PROMPT, PROMPT_CATALOG, isBlankPrompt, resolvePrompt } from "../../shared/src/prompts.js";
import { ProviderError, type ChatMessage, type Provider, type ProviderFactory } from "./providers/provider.js";
import type { ProviderQueue } from "./providers/queue.js";
import type { ConversationStore } from "./storage/conversations.js";
import type { SettingsStore } from "./storage/settings.js";
import type { WsHub } from "./ws.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Chat service: wires WS chat messages to storage and the provider queue.
// Single-user tool — all updates broadcast so every open tab stays in sync.
export class ChatService {
  // Conversations with a generation queued or streaming; blocks duplicates.
  private readonly generating = new Set<string>();

  constructor(
    private readonly hub: WsHub,
    private readonly store: ConversationStore,
    private readonly settings: SettingsStore,
    private readonly queue: ProviderQueue,
    private readonly providerFactory: ProviderFactory,
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

  // Provider resolves per request so an endpoint change applies next-request (R18).
  private provider(): Provider {
    return this.providerFactory(this.settings.get().providerEndpoint);
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
        const conversation = await this.store.setSystemPrompt(msg.conversationId, msg.prompt);
        if (conversation) this.hub.broadcast({ type: "conversation", conversation });
        return;
      }
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

  private async listModels(): Promise<void> {
    try {
      const models = await this.provider().listModels();
      this.hub.broadcast({ type: "models", models: models.map((m) => m.name) });
    } catch {
      this.hub.broadcast({ type: "models", models: [], error: "provider_unavailable" });
    }
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

  private async runGeneration(conversation: Conversation): Promise<void> {
    let accumulated = "";
    // Built inside the try: a hand-edited store can put a non-string in the
    // prompt slot, and a throw out here would escape into the handler's
    // catch-all, leaving the client with no chat-error and a dead composer.
    try {
      // A blank prompt omits the system message entirely rather than sending an
      // empty one (R11) — that is what preserves pre-prompt chat behaviour byte
      // for byte, and an empty system message is not the same request.
      const prompt = conversation.systemPrompt ?? "";
      const history: ChatMessage[] = [
        ...(isBlankPrompt(prompt) ? [] : [{ role: "system" as const, content: String(prompt) }]),
        ...conversation.messages.map((m) => ({ role: m.role, content: m.content })),
      ];
      await this.queue.enqueue("chat", async (signal) => {
        const stream = this.provider().chatStream({ model: conversation.model, messages: history, signal });
        for await (const token of stream) {
          accumulated += token;
          this.hub.broadcast({ type: "chat-token", conversationId: conversation.id, token });
        }
      });
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
