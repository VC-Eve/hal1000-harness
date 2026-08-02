import type { ClientMessage, Conversation } from "../../shared/src/types.js";
import { ProviderError, type ChatMessage, type Provider } from "./providers/provider.js";
import type { ProviderQueue } from "./providers/queue.js";
import type { ConversationStore } from "./storage/conversations.js";
import type { SettingsStore } from "./storage/settings.js";
import type { WsHub } from "./ws.js";

export type ProviderFactory = (endpoint: string) => Provider;

// Chat service: wires WS chat messages to storage and the provider queue.
// Single-user tool — all updates broadcast so every open tab stays in sync.
export class ChatService {
  constructor(
    private readonly hub: WsHub,
    private readonly store: ConversationStore,
    private readonly settings: SettingsStore,
    private readonly queue: ProviderQueue,
    private readonly providerFactory: ProviderFactory,
  ) {
    hub.onMessage((msg) => void this.handle(msg));
  }

  // Provider resolves per request so an endpoint change applies next-request (R18).
  private provider(): Provider {
    return this.providerFactory(this.settings.get().providerEndpoint);
  }

  private async handle(msg: ClientMessage): Promise<void> {
    switch (msg.type) {
      case "list-conversations":
        this.hub.broadcast({ type: "conversations", conversations: await this.store.list() });
        return;
      case "open-conversation": {
        const conversation = await this.store.get(msg.conversationId);
        if (conversation) this.hub.broadcast({ type: "conversation", conversation });
        return;
      }
      case "new-conversation": {
        const conversation = await this.store.create(msg.model);
        this.hub.broadcast({ type: "conversation", conversation });
        this.hub.broadcast({ type: "conversations", conversations: await this.store.list() });
        return;
      }
      case "delete-conversation":
        await this.store.delete(msg.conversationId);
        this.hub.broadcast({ type: "conversations", conversations: await this.store.list() });
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
      case "list-models":
        await this.listModels();
        return;
      case "get-settings":
        this.hub.broadcast({ type: "settings", settings: this.settings.get() });
        return;
      case "update-settings":
        this.hub.broadcast({ type: "settings", settings: await this.settings.update(msg.patch) });
        return;
      default:
        return;
    }
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
    const conversation = await this.store.get(conversationId);
    if (!conversation) return;
    const last = conversation.messages.at(-1);
    if (last?.role === "assistant" && last.interrupted) {
      conversation.messages.pop();
      await this.store.save(conversation);
      this.hub.broadcast({ type: "conversation", conversation });
    }
    await this.generate(conversation);
  }

  private async generate(conversation: Conversation): Promise<void> {
    const history: ChatMessage[] = conversation.messages.map((m) => ({ role: m.role, content: m.content }));
    let accumulated = "";
    try {
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
    if (partial.length > 0) {
      // Persist what streamed before the failure, marked interrupted (AE-style
      // recovery: the UI offers regenerate).
      const message = { role: "assistant" as const, content: partial, at: new Date().toISOString(), interrupted: true };
      await this.store.appendMessage(conversationId, message);
      this.hub.broadcast({ type: "chat-done", conversationId, message });
    }
    const detail = err instanceof Error ? err.message : String(err);
    this.hub.broadcast({ type: "chat-error", conversationId, code, message: detail });
  }
}
