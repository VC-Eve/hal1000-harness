import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Conversation, ConversationContext, ConversationMeta, ContextLevel, StoredMessage } from "../../../shared/src/types.js";
import { CONTEXT_LEVELS } from "../../../shared/src/types.js";
import { readJson, writeJsonAtomic } from "./atomic.js";

const TITLE_MAX = 60;

// Undefined means "not part of this patch" and keeps what is stored; anything
// unrecognised means the value cannot be trusted and falls back to off. The two
// are deliberately different: a partial patch must not clear the other switch,
// and a bad value must not be honoured.
function level(next: unknown, previous: ContextLevel): ContextLevel {
  if (next === undefined) return previous;
  return CONTEXT_LEVELS.includes(next as ContextLevel) ? (next as ContextLevel) : "off";
}

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

  async create(model: string, systemPrompt = "", isTemplate = false): Promise<Conversation> {
    await fs.mkdir(this.dir, { recursive: true });
    const now = new Date().toISOString();
    const convo: Conversation = {
      id: crypto.randomUUID(),
      title: "New conversation",
      model,
      systemPrompt,
      // Only ever set true, never written as false — absent is what "literal"
      // means everywhere else, and a stored `false` would be a second spelling
      // of it.
      ...(isTemplate ? { promptIsTemplate: true } : {}),
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

  // Drops a trailing interrupted reply and returns the conversation, with the
  // read and the write inside one lock. Doing get -> pop -> save from the
  // caller would write a snapshot taken before any concurrent edit, silently
  // reverting a model or prompt change applied while this was loading.
  async popInterrupted(id: string): Promise<Conversation | null> {
    return this.withLock(id, async () => {
      const convo = await this.get(id);
      if (!convo) return null;
      const last = convo.messages.at(-1);
      if (last?.role !== "assistant" || !last.interrupted) return convo;
      convo.messages.pop();
      convo.updatedAt = new Date().toISOString();
      await writeJsonAtomic(this.file(convo.id), convo);
      return convo;
    });
  }

  async setSystemPrompt(id: string, systemPrompt: string, isTemplate = false): Promise<Conversation | null> {
    return this.withLock(id, async () => {
      const convo = await this.get(id);
      if (!convo) return null;
      convo.systemPrompt = systemPrompt;
      // Opting in is per Conversation and only ever happens on a deliberate
      // save. A client that does not know about templates keeps writing literal
      // prompts and keeps getting literal behaviour.
      if (isTemplate) convo.promptIsTemplate = true;
      convo.updatedAt = new Date().toISOString();
      await writeJsonAtomic(this.file(convo.id), convo);
      return convo;
    });
  }

  /**
   * Set one or both context switches.
   *
   * Merged onto whatever is stored rather than replacing it, so a client
   * moving the vision switch cannot silently clear the session one. An absent
   * record starts from both off, which is what absent already means.
   *
   * Levels are validated here rather than trusted: this value decides how much
   * text reaches a model, and a hand-edited file or an older client must not be
   * able to put something else in the slot. Acceptance-shaped — an unrecognised
   * value falls back to `off` rather than being passed along.
   */
  async setContext(id: string, patch: Partial<ConversationContext>): Promise<Conversation | null> {
    return this.withLock(id, async () => {
      const convo = await this.get(id);
      if (!convo) return null;
      const current = convo.context ?? { vision: "off" as const, session: "off" as const };
      convo.context = {
        vision: level(patch.vision, current.vision),
        session: level(patch.session, current.session),
        // Absent reads as off, which is what the type says and what a thread
        // written before the Monitor source existed means. Writing it back is
        // not optional though: this line was missing, so the switch the UI sent
        // and `assembleContext` read was never stored, and the whole source was
        // off end to end with nothing failing to say so.
        monitor: level(patch.monitor, current.monitor ?? "off"),
      };
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
