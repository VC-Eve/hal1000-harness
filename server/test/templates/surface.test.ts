import { describe, expect, it } from "vitest";
import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as promptsModule from "../../../shared/src/prompts.js";
import { PHRASES } from "../../../shared/src/phrases.js";
import { SLOT_VOCABULARY } from "../../../shared/src/templates.js";

// Completeness, as a test rather than as a sentence in a guide.
//
// `AGENTS.md` claimed there was no human-chosen wording left reaching a model
// without an editor. It was false when it was written and stayed false through
// every review, because extending a catalogue pulls attention onto the entries
// that exist and auditing a catalogue cannot find an absence. A user asking why
// a slot was unavailable found the first one; this file is what looks for the
// next.
//
// WHAT IT CHECKS. Every string a person wrote that could reach a model, in the
// files that assemble what a model reads, must be accounted for by name. Three
// shapes: an interpolated template literal, a join on a literal separator, and
// a prose literal. All five instances the audit found were the first two —
// `[${kind}] ${text}`, `${source}: `, `[${names}] ${caption}`, `.join(" and ")`
// — and so were the three it missed.
//
// The third shape was added after a review pointed out that the first version
// of this file could not see a plain literal, and therefore reported green
// while the gap entry's whole sentence sat in front of the chat model from a
// file this test was already scanning. Its header claimed plain literals were
// safe because they are "the shipped Template and Phrase defaults" — true of
// `templates.ts` and `phrases.ts`, neither of which is on this list. Shipped
// defaults are exempted by asking the catalogues what they actually ship, so
// the claim is now checked rather than asserted.
//
// HOW TO ADD ONE. Write the new line, run this test, and put the fragment it
// prints in ACCOUNTED under the category that is true of it. If the category is
// `wording`, the test will not accept it — give it a Phrase instead. That
// refusal is the whole point: the list is not a way to pass, it is a way to say
// which of the four things a string is.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");

/**
 * Why a built string is allowed to have no editor.
 *
 * `wording` is deliberately absent. A string a reader could be told something
 * different by is a Phrase, and there is no category that excuses one.
 */
type Category =
  /** Renders a value the reader reads back — a clock, a duration, an id. One correct shape. */
  | "format"
  /** Structural assembly: newlines between lines, a separator inside a key. Says nothing. */
  | "structure"
  /** Never reaches a model: console output, a UI string, a cache key, an inference-log filename. */
  | "not-model-facing"
  /** The recorded before-picture a Template or Phrase is snapshotted against. */
  | "oracle";

interface Entry {
  /**
   * Distinctive fragments of the built strings this entry explains.
   *
   * A group rather than one string, so a single argument can cover a set of
   * siblings — twenty enrolment errors need one reason, not twenty copies of
   * it. Every string is still named individually: the grouping shares the
   * prose, never the scrutiny.
   */
  fragments: readonly string[];
  category: Category;
  why: string;
}

// The files that assemble what a model reads. Kept explicit rather than
// globbed, and guarded below: a new file that renders a role message or a
// phrase has to be listed here, which is the moment to ask what it builds.
const SURFACE = [
  "server/src/chat.ts",
  "server/src/monitors/runner.ts",
  "server/src/vision/captioner.ts",
  "server/src/narration/narrator.ts",
  "server/src/narration/coalescer.ts",
  "server/src/monitors/narrator.ts",
  "server/src/vision/service.ts",
  "server/src/templates/roleMessages.ts",
  "server/src/templates/chatContext.ts",
  "server/src/templates/merged.ts",
  "shared/src/prompts.ts",
] as const;

const ACCOUNTED: Entry[] = [
  // -- formats ------------------------------------------------------------
  {
    fragments: ["${this.registry.adapterLabel(adapterId)} [${sessionId.slice(0, 8)}]"],
    category: "format",
    why: "The Session's name. Stamped on the entry and rendered in the feed as well as quoted into a message, so a prompt-side editor would make the two disagree. See CONCEPTS.md, Wording and Format.",
  },
  {
    fragments: [
      '${seconds} second${seconds === 1 ? "" : "s"}',
      '${minutes} minute${minutes === 1 ? "" : "s"}',
      '${hours} hour${hours === 1 ? "" : "s"}',
      '${days} day${days === 1 ? "" : "s"}',
    ],
    category: "format",
    why: "relativeAge, whose singular/plural is named here explicitly because it sits on the line and looks like wording. It is grammatical agreement with a number, not a claim: a reader learns the same duration either way.",
  },
  {
    fragments: ["${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}"],
    category: "format",
    why: "clockTime. 24-hour, zero-padded, to the second — change the shape and a reader reads the same instant in a worse notation, not a different claim.",
  },
  {
    fragments: ["${MONTHS[d.getMonth()]} ${d.getDate()} ${clockTime(ms)}"],
    category: "format",
    why: "entryStamp's other-day form. A date is added only when a bare clock would read as this morning and be wrong by however long HAL was off.",
  },
  {
    fragments: ["${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}"],
    category: "format",
    why: "dateStamp. A written-out date, one correct shape — a reader reads the same day whatever the notation.",
  },
  {
    fragments: ["${Math.round(confidence * 100)}%", "${Math.round(entry.confidence * 100)}%"],
    category: "format",
    why: "A match confidence as a percentage — first as the band phrases receive it, then as band enforcement supplies it to a reply that named someone without one. The phrases decide what is said around the number; this is the number.",
  },
  {
    fragments: ['data:image/jpeg;base64,${jpeg.toString("base64")}'],
    category: "format",
    why: "A data URL carrying the last camera frame to the UI preview pane. Bytes rather than words, and it reaches a browser rather than a model.",
  },

  // -- structure ----------------------------------------------------------
  {
    fragments: [
      'lines.join("\\n")',
      'chosen.join("\\n")',
      'rendered.join("\\n")',
      '${lines.join("\\n")}${note}${close}',
      '${chosen.join("\\n")}\\n${note}',
      '${renderPhrase("monitor.lines_omitted", phrases, { count: String(omitted) })}\\n${rendered.join("\\n")}',
    ],
    category: "structure",
    why: "One line per line. A newline between items says nothing a reader could be told differently, and where a notice sits above the lines it reports on, that notice is itself a Phrase and only the newline is here.",
  },
  {
    // Nearly the whole expression, because the anchoring rule wants a fragment
    // to be most of what it claims to explain — a short prefix of a long regex
    // could absorb a different long regex added later.
    fragments: [
      '(?<![\\\\p{L}\\\\p{N}])(${HEDGE_PREFIX.trim().replace(/\\s+/g, "\\\\s+")}\\\\s+)?(${alternation})(?![\\\\p{L}\\\\p{N}])',
    ],
    category: "structure",
    why: "The band-enforcement regex and the alternation of enrolled names it is built from. Matched against what a model wrote so a name can be put back into its band; never read by anyone.",
  },
  {
    fragments: ["${lead}${entry.name.trim()}${tail}"],
    category: "structure",
    why: "Rewrites a name a model already wrote back into its banded form. The words come from the band phrases; this only puts the model's own sentence back together around them.",
  },

  // -- not model facing ---------------------------------------------------
  //
  // Every string is named rather than the route being exempted wholesale, and
  // that is deliberate. The obvious shortcut — "anything reaching the client in
  // an `error:` field is safe" — is very nearly right and fails on exactly one
  // field: a Monitor's `problem` becomes a status entry and reaches the CHAT
  // model through {monitor_remarks}. A categorical exemption is how that
  // mislabel happened once already, so the list stays long and each argument
  // stays attached to the strings it actually covers.
  {
    fragments: ['${role}:${[...degraded].sort().join(",")}', ').join(",")'],
    category: "not-model-facing",
    why: "A cache key, and the sorted slot names inside it, so the warning below is logged once per shape of breakage rather than once per render.",
  },
  {
    fragments: ["Claude ${sessionId}"],
    category: "not-model-facing",
    why: "Names the inference-log file this request is written to, so each followed session gets its own readable stream rather than one interleaved file.",
  },
  {
    fragments: ["The narration backend is not reachable.", "The chat backend is not reachable."],
    category: "not-model-facing",
    why: "Thrown as a ProviderError when no backend resolves. It reaches a status entry and the readiness pane; there is no model to send it to, which is the condition it reports.",
  },
  {
    fragments: [
      "I am unable to reach the model provider at the moment. My observations continue; narration will resume when contact is restored.",
    ],
    category: "not-model-facing",
    why: "A status entry in HAL's own voice, recorded with no sessionId — so unlike the gap entry beside it, sessionRemarksSlot's filter never picks this one up and it stays in the feed the user reads.",
  },
  {
    fragments: [
      "The recogniser at ${cfg.recogniserEndpoint} is not on this machine, and sending it a frame sends the whole picture off this machine. Accept that in settings first, or point it back at loopback.",
      "The recogniser cannot keep up with a ${cfg.detectionIntervalSeconds}s detection interval.",
      "The recogniser is not reachable.",
      "The recogniser could not be reached.",
      "The recogniser is busy with the camera. Try that again in a moment.",
      "The recogniser can see a face but cannot describe it yet. Check its readiness.",
      "I can see a face in that picture but cannot describe it yet. Check the recogniser's readiness.",
    ],
    category: "not-model-facing",
    why: "Recogniser conditions, shown in the Vision settings and the readiness pane. They report on a sidecar that does face detection and speaks no language at all; nothing here is ever put in front of an inference backend.",
  },
  {
    fragments: [
      "That image is too large. Pictures up to ${Math.floor(MAX_ENROL_IMAGE_BYTES / 1_000_000)}MB work.",
      "That picture has ${faces.length} faces in it. Use one with only the person you are adding.",
      "${faces.length} faces are in view. Enrol with one person in frame so the right face is stored.",
      "Enrolment failed: ${err instanceof Error ? err.message : String(err)}",
      "Could not add that face: ${err instanceof Error ? err.message : String(err)}",
      "Could not save that person: ${err instanceof Error ? err.message : String(err)}",
      "Merged ${result.mergedFrom} into ${msg.name.trim()} — ${result.faceCount} faces now.",
      "That file did not arrive as an image I can read.",
      "I could not find a face in that picture. A photo where the face is large and upright works best — a small face in a wide shot is often missed.",
      "I could not crop that face out of the picture.",
      "Could not crop that face. Check that ffmpeg is available.",
      "No face in view. Look at the camera and try again.",
      "No frame from the camera yet.",
      "A person needs a name.",
      "That person is no longer on the roster.",
      "That face is no longer waiting.",
      "That face is no longer waiting to be named.",
      "The waiting queue is full. Name or dismiss one of those first.",
      "Vision is off, so there is nothing to enrol from.",
      "Recognition is off.",
      "I am not watching. Start me before asking me to look.",
    ],
    category: "not-model-facing",
    why: "Enrolment and gallery results, broadcast to the browser in the `error` or `note` field of a vision-roster-result or vision-enrol-result. They answer a button the user just pressed and are read in the pane where it sits; no inference path touches them.",
  },

  {
    fragments: ["${stat.dev}:${stat.ino}", 'rest.join("\\t")'],
    category: "structure",
    why: "A watched file's identity, from its device and inode, so a rotation is noticed rather than read at a stale offset; and the tab that rejoins the columns of a Windows event record. Neither is language.",
  },
  {
    fragments: [
      "${this.trimmed()}/v1/chat/completions",
      "${this.trimmed()}/v1/models",
      "${this.trimmed()}/health",
    ],
    category: "structure",
    why: "The captioner's HTTP routes. They address a llama.cpp server rather than saying anything to it, and their shape is that server's to define, not this project's.",
  },
  {
    fragments: [
      "The captioner did not answer within ${Math.round(this.timeoutMs / 1000)}s.",
      "The captioner at ${this.trimmed()} is not reachable.",
      "The captioner returned ${res.status}. ${detail.slice(0, 200)}",
      "The captioner returned an unreadable response.",
      "The captioner returned an empty description.",
      "Capture was cancelled.",
    ],
    category: "not-model-facing",
    why: "Captioner faults, raised as a CaptionerError and shown in the Vision pane with the install instructions beside them. They describe a small vision model that failed to answer — a cycle that raises one produces no observation at all, so there is nothing for them to be carried into.",
  },

  // -- oracles ------------------------------------------------------------
  {
    fragments: [
      "${NARRATION_BASE} Keep commentary to one short, plain sentence with minimal persona flavor.",
      "${NARRATION_BASE} Keep commentary to one or two short sentences with a calm, understated HAL 9000 tone.",
      "${NARRATION_BASE} Use two to three sentences, fully in HAL 9000 character: unhurried, courteous, faintly ominous.",
    ],
    category: "oracle",
    why: "The three shipped narration presets, each composed from one shared base. They are editable Templates; composing them from a common base rather than writing the base out three times is what stops the three drifting apart.",
  },
  {
    fragments: [
      "${instruction} If there is nothing worth saying, reply with exactly ${VISION_SILENCE_TOKEN} and nothing else.",
    ],
    category: "oracle",
    why: "visionSensitivityInstruction, which has no production caller. It is the before-picture the vision-user Template's four sensitivity branches are snapshotted against, and it must not follow the editable side or the snapshot would agree with itself no matter what changed.",
  },
];

/**
 * Every string a person wrote that could end up in front of a model.
 *
 * Three shapes, because the first version of this scanner had two and that was
 * not enough: it saw interpolation and literal joins only, so the gap entry's
 * whole sentence — a plain literal, in a file already scanned — sat in front of
 * the chat model with the test reporting green.
 *
 *   1. an interpolated template literal
 *   2. a join on a literal separator, single or double quoted
 *   3. a PROSE literal: quoted text with a space, a lowercase letter, and
 *      enough length to be a sentence rather than a key, a slot name, a mime
 *      type or a path
 *
 * The third is the loose one and is meant to be. It over-reaches into UI error
 * strings, which is a cost paid once in ACCOUNTED and worth it: the alternative
 * is a scanner that cannot see the exact defect it exists to find. String
 * concatenation needs no rule of its own — the literals inside it are prose
 * literals and are caught individually.
 *
 * Two exemptions, both narrow:
 *
 * Console output, by shape. It reaches a terminal and nothing else, and a dozen
 * entries saying so would be noise around the ones carrying an argument.
 *
 * Shipped editable text, BY VALUE rather than by syntax. Every Template
 * default, prompt default, preset and Phrase is already editable by
 * construction, and they are written as long `+`-joined literals — thirty in
 * `prompts.ts` alone. Rather than list them, the scanner asks the catalogues
 * what they actually ship and skips any literal contained in one. That cannot
 * go stale when a default is reworded. Its one hole is a hardcoded line that
 * duplicates a default's wording verbatim, which is a different defect and a
 * rarer one.
 */
function builtStrings(source: string, shipped = "", proseOnly = false): string[] {
  const stripped = source
    // Line endings first. This repo is Windows-primary and checks out CRLF,
    // while the values the modules hold at runtime are LF — so a multi-line
    // shipped default read from disk never matched the same default read from
    // the catalogue, and every Template default looked like a hardcoded line.
    // Normalising is also what the template parser itself does before anything
    // else, so this compares the two the way production sees them.
    .replace(/\r\n/g, "\n")
    // Comments next, so a fragment quoted in prose is not mistaken for code.
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    // Then console output, which reaches a terminal and nothing else. The
    // argument list is consumed as literals-or-code rather than "up to the
    // next semicolon", because these messages contain semicolons and an
    // early stop leaves the tail of one looking like a hardcoded line.
    .replace(
      /console\.\w+\((?:`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\([^()]*\)|[^()`"'])*\)/g,
      "",
    );
  const found = new Set<string>();

  // Backtick literals are CONSUMED, not merely matched, and that ordering is
  // the whole trick. Matching them in place let a pattern run from the closing
  // backtick of one literal to the opening backtick of the next and capture the
  // code in between — the scanner reported half of `service.ts`'s message
  // handler as a hardcoded string. Removing each literal as it is taken leaves
  // no gap for the next pattern to span.
  const rest = stripped.replace(/`(?:[^`\\]|\\.)*`/g, (lit) => {
    const inner = lit.slice(1, -1);
    if (lit.includes("${")) found.add(lit);
    else if (isProse(inner) && !shipped.includes(inner)) found.add(inner);
    return '""';
  });

  const code = rest;

  // Joins keep their receiver, so `lines.join("\n")` and `parts.join(", ")` are
  // distinguishable. A bare separator would collapse every list in the codebase
  // into one entry and account for all of them the first time one was explained.
  for (const m of code.matchAll(/([\w.\])]+)\.join\("(?:[^"\\]|\\.)+"\)/g)) found.add(m[0]);
  for (const m of code.matchAll(/([\w.\])]+)\.join\('(?:[^'\\]|\\.)+'\)/g)) found.add(m[0]);
  // `*` and not `+`, so an empty string is CONSUMED rather than skipped. With
  // `+`, `inputs.model ?? "", backend: inputs.backend ?? ""` matched from the
  // closing quote of the first empty string to the opening quote of the second
  // and reported the code between them as a hardcoded line.
  for (const m of code.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'/g)) {
    const text = m[1] ?? m[2];
    if (text && isProse(text) && !shipped.includes(text)) found.add(text);
  }
  return [...found];
}

/**
 * Does this literal read like something a model would be told, rather than like
 * a name?
 *
 * Deliberately crude. A slot name, a role, an adapter id, a mime type and a
 * path all fail it; a sentence passes. Erring towards passing is correct here —
 * a false positive costs one line in ACCOUNTED, a false negative is the whole
 * failure this file exists to prevent.
 */
function isProse(text: string): boolean {
  if (text.length < 12) return false;
  if (!/\s/.test(text)) return false;
  if (!/[a-z]/.test(text)) return false;
  // "chat context", "windows event log" — words with no sentence punctuation
  // and nothing but name characters. A real sentence has punctuation somewhere.
  if (/^[\w.\-/ ]+$/.test(text) && !/[.!?,;:]/.test(text)) return false;
  return true;
}

/**
 * Everything the release ships as editable text, flattened.
 *
 * Walked from the modules rather than enumerated, so a new Template default or
 * a new preset is covered the day it is added and a reworded one never has to
 * be re-listed here.
 */
function shippedEditableText(): string {
  const out: string[] = [];
  const walk = (v: unknown, depth: number): void => {
    if (depth > 8) return;
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
    else if (v && typeof v === "object") for (const x of Object.values(v)) walk(x, depth + 1);
  };
  walk(promptsModule, 0);
  walk(PHRASES, 0);
  walk(SLOT_VOCABULARY, 0);
  return out.join("\n");
}

const read = (rel: string) => fs.readFile(path.join(ROOT, rel), "utf8");
const readSync = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

/** Every `.ts` under the two source roots. */
async function allSourceFiles(): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const e of await fs.readdir(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) await walk(rel);
      else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) out.push(rel);
    }
  };
  await walk("server/src");
  await walk("shared/src");
  return out;
}

/** Relative imports, resolved to the `.ts` they came from. */
function importsOf(source: string, rel: string): string[] {
  const dir = path.posix.dirname(rel.replace(/\\/g, "/"));
  return [...source.matchAll(/from\s+"(\.[^"]+)"/g)].map((m) =>
    path.posix.normalize(path.posix.join(dir, m[1]!)).replace(/\.js$/, ".ts"),
  );
}

/**
 * Files that could put a string in front of a model, and why each is suspected.
 *
 * Nominates rather than decides. Every candidate must end up either on SURFACE,
 * where its strings are accounted for one by one, or on NOT_SURFACE with an
 * argument. The machinery itself is neither: `phrases.ts` and `templates.ts`
 * ARE the editable text and the engine that renders it, so scanning them would
 * be scanning the answer.
 */
async function messageBuildingCandidates(): Promise<{ file: string; signals: string[] }[]> {
  const files = await allSourceFiles();
  const source = new Map<string, string>();
  for (const f of files) source.set(f, await read(f));

  // DIRECTLY imported by a scanned file, not transitively. `coalescer.ts` —
  // the file this signal exists to catch — is a direct import of
  // `narration/narrator.ts`, and one hop is where a module that builds a line
  // for someone else's message actually sits. Transitive reach pulled in the
  // whole storage and provider layer and nominated thirty files that cannot
  // reach a prompt, which is how a guard becomes something people switch off.
  const imported = new Set<string>();
  for (const f of SURFACE) {
    for (const dep of importsOf(source.get(f) ?? "", f)) if (source.has(dep)) imported.add(dep);
  }

  const MACHINERY = ["shared/src/phrases.ts", "shared/src/templates.ts"];
  const shipped = shippedEditableText();
  const out: { file: string; signals: string[] }[] = [];
  for (const f of files) {
    if (MACHINERY.includes(f)) continue;
    const s = source.get(f)!;
    const signals: string[] = [];
    if (/\brenderRoleMessage\s*\(|\brenderPhrase\s*\(/.test(s)) signals.push("renders");
    if (/\bchatStream\s*\(\s*\{|role:\s*"(system|user)"/.test(s)) signals.push("requests");
    if (imported.has(f) && builtStrings(s, shipped, true).length > 0) signals.push("feeds");
    if (signals.length > 0) out.push({ file: f, signals });
  }
  return out;
}

/**
 * Candidates that cannot reach a model, with the argument for each.
 *
 * Kept beside SURFACE rather than as a silent absence: a file left off a list
 * looks the same whether it was considered or forgotten, and forgetting is the
 * failure this whole file exists because of.
 */
const NOT_SURFACE: { file: string; why: string }[] = [
  {
    file: "server/src/providers/provider.ts",
    why: "Defines the request shape and carries the messages array from one side to the other. It writes none of the text it transports; every string it touches was chosen in a file that is on SURFACE.",
  },
  {
    file: "server/src/logging/instrument.ts",
    why: "Writes a copy of each request to the inference log for a human to read afterwards. It observes messages that have already been assembled and adds nothing to them.",
  },
  {
    file: "shared/src/types.ts",
    why: "The wire contract. Its strings are union members and field names — `narration`, `chat-context` — which the prose test lets through only where a name happens to contain a space, never a sentence a model could read.",
  },
  {
    file: "server/src/vision/recogniser.ts",
    why: "Talks to the face-recogniser sidecar over HTTP and returns boxes, landmarks and embeddings. Its strings are endpoint paths and failure kinds; the sidecar has no language model in it at all.",
  },
  {
    file: "server/src/vision/capture.ts",
    why: "Shells out to ffmpeg for a frame and returns bytes. Its strings are command arguments and device errors, read by the Vision pane when a webcam is busy.",
  },
  {
    file: "server/src/vision/stream.ts",
    why: "Holds the MJPEG camera stream open for the browser preview. Its `problem` strings describe a dead camera to the pane; the Monitor path that turns a problem into a status entry is a different producer, and that one is on SURFACE.",
  },
  {
    file: "server/src/vision/people.ts",
    why: "The gallery store — reads and writes people, faces and profiles on disk. Profile TEXT reaches a model, but the user wrote it; the strings in this file are storage errors and file names.",
  },
  {
    file: "server/src/monitors/severity.ts",
    why: "Decides whether a line is severe, from the user's own rule. Its strings are level names it matches against — the MARKER a severity earns is a Phrase, and it lives on the narrator's side of this line.",
  },
  {
    file: "server/src/origin.ts",
    why: "Answers whether an endpoint is on this machine and whether identity may leave it. Its strings are hostnames and loopback forms, compared rather than read.",
  },
  {
    file: "server/src/providers/windows.ts",
    why: "Caches a model's context window per endpoint. Its strings are the field names a provider reports a window under, which differ between Ollama and the OpenAI shape.",
  },
  {
    file: "server/src/storage/conversations.ts",
    why: "Reads and writes conversation files. Message TEXT passes through it and reaches a model, but every word of that was typed by the user or generated by the model; this file contributes file paths and lock errors.",
  },
  {
    file: "server/src/storage/observations.ts",
    why: "The entry log on disk. It stores and returns what the narrators already worded — the sentences that reach a Conversation through it are Phrases, and they are declared where they are written.",
  },
  {
    file: "server/src/vision/candidates.ts",
    why: "The queue of unnamed faces waiting to be identified. It holds thumbnails and embeddings; nothing in it is language, and a candidate has no name to say until the user gives it one.",
  },
  {
    file: "server/src/vision/frames.ts",
    why: "Writes captured frames to disk and prunes them. Its strings are file names and directory paths for images.",
  },
  {
    file: "server/src/vision/thumbnail.ts",
    why: "Crops a face out of a frame with ffmpeg. Its strings are command arguments; what it returns is image bytes.",
  },
  {
    file: "server/src/vision/timeline.ts",
    why: "The on-disk record of every check and caption. It stores what the vision service already worded and hands it back to the pane; the caption text inside came from the captioner, not from here.",
  },
  {
    file: "server/src/watchers/registry.ts",
    why: "Holds the watched session and names its adapter — 'Claude Code'. That name reaches a model only inside the Session label, which is a format and is accounted for as one where it is assembled.",
  },
  {
    file: "server/src/ws.ts",
    why: "The socket hub: origin checks, the token handshake, and broadcast. Its strings are close reasons and protocol errors read by a browser, and an unadmitted socket receives nothing at all.",
  },
];

/**
 * Does this entry account for this built string?
 *
 * A fragment must be a substring AND cover most of what it claims to explain.
 * Substring alone let a bare structural fragment absorb a whole new line:
 * ``return `Recent activity:\n${lines.join("\n")}`;`` contains
 * `lines.join("\n")`, so it was silently filed as "structure" and the hardcoded
 * claim "Recent activity:" reached every model with nobody able to edit it.
 * Requiring the fragment to be most of the string means a genuinely new line
 * has to be classified on its own terms.
 */
function accountsFor(entry: Entry, built: string): boolean {
  return entry.fragments.some(
    (f) => built.includes(f) && f.length >= built.trim().length * 0.6,
  );
}

describe("every string that reaches a model has an editor", () => {
  it("accounts for every built string on the message-building surface", async () => {
    const unaccounted: string[] = [];
    const shipped = shippedEditableText();
    for (const rel of SURFACE) {
      const source = await read(rel);
      for (const built of builtStrings(source, shipped)) {
        if (ACCOUNTED.some((e) => accountsFor(e, built))) continue;
        unaccounted.push(`${rel}\n    ${built.replace(/\s+/g, " ").slice(0, 160)}`);
      }
    }
    expect(
      unaccounted,
      unaccounted.length === 0
        ? ""
        : `\n\n${unaccounted.length} built string(s) on the message-building surface are not accounted for.\n` +
          `If a string tells a model something, give it a Phrase in shared/src/phrases.ts.\n` +
          `If it is a format, structure, not model-facing, or an oracle, add it to ACCOUNTED in this file with the reason.\n\n` +
          `${unaccounted.join("\n\n")}\n`,
    ).toEqual([]);
  });

  it("has no way to declare a string 'just wording' and move on", () => {
    // The categories are the argument. If `wording` were one of them this test
    // would be a place to record the very thing it exists to prevent.
    const categories = new Set(ACCOUNTED.map((e) => e.category));
    expect([...categories].sort()).toEqual(["format", "not-model-facing", "oracle", "structure"]);
  });

  it("gives every accounted string a reason someone can disagree with", () => {
    for (const e of ACCOUNTED) {
      expect(e.why.length, e.fragments[0]).toBeGreaterThan(30);
      expect(e.fragments.length, `${e.category}: an entry with no fragments explains nothing`).toBeGreaterThan(0);
    }
  });

  it("has no entry that stopped matching anything", () => {
    // A fragment that matches nothing is a decision about a string that no
    // longer exists, and it reads as coverage. The list is meant to shrink when
    // the code does.
    const built: string[] = [];
    const shipped = shippedEditableText();
    for (const rel of SURFACE) built.push(...builtStrings(readSync(rel), shipped));
    const dead = ACCOUNTED.flatMap((e) => e.fragments).filter((f) => !built.some((b) => b.includes(f)));
    expect(dead, `these ACCOUNTED fragments match nothing on the surface any more`).toEqual([]);
  });

  it("has decided about every file that could be message-building", async () => {
    // The list of scanned files goes stale, so something has to notice. The
    // first version of this guard asked "does the file call renderRoleMessage
    // or renderPhrase" — which is precisely the signal `coalescer.ts` LACKED
    // before this work. It built `[${kind}] ${text}` and handed finished
    // strings to narrator.ts, so the guard would not have required the very
    // file the whole audit exists because of.
    //
    // Three signals now, because no one of them is the property that matters:
    //
    //   renders   — calls the render machinery
    //   requests  — assembles a provider request, or a role-tagged message
    //   feeds     — is imported BY a scanned file and contains prose of its own
    //
    // The third is what catches a line-builder. It is a crude stand-in for
    // "your string can reach a message", and crude in the safe direction: it
    // over-nominates and each candidate then has to be decided.
    const candidates = await messageBuildingCandidates();
    const undecided = candidates.filter(
      (c) => !SURFACE.includes(c.file as (typeof SURFACE)[number]) && !NOT_SURFACE.some((n) => n.file === c.file),
    );
    expect(
      undecided.map((c) => `${c.file} [${c.signals.join(",")}]`),
      "these files could put a string in front of a model. Add each to SURFACE and account for its strings, " +
        "or to NOT_SURFACE with the reason it cannot reach one.",
    ).toEqual([]);
  });

  it("keeps NOT_SURFACE honest — no entry for a file that is not a candidate", async () => {
    // An exclusion for a file nothing nominates is a decision about a risk that
    // does not exist, and it makes the list look more considered than it is.
    const candidates = new Set((await messageBuildingCandidates()).map((c) => c.file));
    const stale = NOT_SURFACE.filter((n) => !candidates.has(n.file)).map((n) => n.file);
    expect(stale, "these NOT_SURFACE entries exclude files nothing nominates any more").toEqual([]);
  });

  it("gives every exclusion a reason someone can disagree with", () => {
    for (const n of NOT_SURFACE) expect(n.why.length, n.file).toBeGreaterThan(40);
  });

  it("fails when a hardcoded line is added to a render path", async () => {
    // The guard's own guard. A plausible new line — the shape all five audit
    // findings had — must not pass, or this file is decoration.
    const invented = 'const line = `[${kind}] ${text} <${severity}>`;';
    expect(builtStrings(invented)).toHaveLength(1);
    expect(ACCOUNTED.some((e) => accountsFor(e, builtStrings(invented)[0]!))).toBe(false);
  });
});
