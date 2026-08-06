import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Conversation, ConversationMeta, StoredMessage } from "../../../shared/src/types.js";
import { readJson, writeJsonAtomic } from "./atomic.js";

const TITLE_MAX = 60;

export class ConversationStore {
  private readonly dir: string;
  // Per-conversation mutation chains: get->mutate->save must not interleave
  // across concurrent WS handlers (multi-tab, double-submit).
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, "conversations");
  }

  private file(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  private withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(id, next.then(
      () => undefined,
      () => undefined,
    ));
    return next;
  }

  async list(): Promise<ConversationMeta[]> {
    await fs.mkdir(this.dir, { recursive: true });
    const entries = await fs.readdir(this.dir);
    const metas: ConversationMeta[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const convo = await readJson<Conversation>(path.join(this.dir, entry));
      if (convo) {
        const { messages: _messages, ...meta } = convo;
        metas.push(meta);
      }
    }
    return metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(id: string): Promise<Conversation | null> {
    return readJson<Conversation>(this.file(id));
  }

  async create(model: string, systemPrompt = ""): Promise<Conversation> {
    await fs.mkdir(this.dir, { recursive: true });
    const now = new Date().toISOString();
    const convo: Conversation = {
      id: crypto.randomUUID(),
      title: "New conversation",
      model,
      systemPrompt,
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    await writeJsonAtomic(this.file(convo.id), convo);
    return convo;
  }

  async save(convo: Conversation): Promise<void> {
    await this.withLock(convo.id, async () => {
      convo.updatedAt = new Date().toISOString();
      await writeJsonAtomic(this.file(convo.id), convo);
    });
  }

  async appendMessage(id: string, message: StoredMessage): Promise<Conversation | null> {
    return this.withLock(id, async () => {
      const convo = await this.get(id);
      if (!convo) return null;
      convo.messages.push(message);
      if (message.role === "user" && convo.title === "New conversation") {
        convo.title = message.content.length > TITLE_MAX ? `${message.content.slice(0, TITLE_MAX)}…` : message.content;
      }
      convo.updatedAt = new Date().toISOString();
      await writeJsonAtomic(this.file(convo.id), convo);
      return convo;
    });
  }

  async setModel(id: string, model: string): Promise<Conversation | null> {
    return this.withLock(id, async () => {
      const convo = await this.get(id);
      if (!convo) return null;
      convo.model = model;
      convo.updatedAt = new Date().toISOString();
      await writeJsonAtomic(this.file(convo.id), convo);
      return convo;
    });
  }

  async setSystemPrompt(id: string, systemPrompt: string): Promise<Conversation | null> {
    return this.withLock(id, async () => {
      const convo = await this.get(id);
      if (!convo) return null;
      convo.systemPrompt = systemPrompt;
      convo.updatedAt = new Date().toISOString();
      await writeJsonAtomic(this.file(convo.id), convo);
      return convo;
    });
  }

  async delete(id: string): Promise<void> {
    await this.withLock(id, async () => {
      await fs.rm(this.file(id), { force: true });
    });
  }
}
