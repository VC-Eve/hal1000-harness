import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Completeness, as a test rather than as a sentence in a guide.
//
// `AGENTS.md` claimed there was no human-chosen wording left reaching a model
// without an editor. It was false when it was written and stayed false through
// every review, because extending a catalogue pulls attention onto the entries
// that exist and auditing a catalogue cannot find an absence. A user asking why
// a slot was unavailable found the first one; this file is what looks for the
// next.
//
// WHAT IT CHECKS. Every string built by interpolation or by joining with a
// literal separator, in the files that assemble what a model reads, must be
// accounted for by name. All five instances the audit found were exactly this
// shape — `[${kind}] ${text}`, `${source}: `, `[${names}] ${caption}`,
// `.join(" and ")` — and so were the three it missed. A plain string literal is
// not scanned: those are the shipped Template and Phrase defaults, which are
// editable by construction and pinned by the oracle.
//
// HOW TO ADD ONE. Write the new line, run this test, and put the fragment it
// prints in ACCOUNTED under the category that is true of it. If the category is
// `wording`, the test will not accept it — give it a Phrase instead. That
// refusal is the whole point: the list is not a way to pass, it is a way to say
// which of the three things a string is.

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
  /** A distinctive fragment of the built string, matched literally. */
  fragment: string;
  category: Category;
  why: string;
}

// The files that assemble what a model reads. Kept explicit rather than
// globbed, and guarded below: a new file that renders a role message or a
// phrase has to be listed here, which is the moment to ask what it builds.
const SURFACE = [
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
    fragment: "[${sessionId.slice(0, 8)}]",
    category: "format",
    why: "The Session's name. Stamped on the entry and rendered in the feed as well as quoted into a message, so a prompt-side editor would make the two disagree. See CONCEPTS.md, Wording and Format.",
  },
  {
    fragment: "second${seconds === 1",
    category: "format",
    why: "relativeAge's singular/plural. Named explicitly because it sits on the line and looks like wording: it is grammatical agreement with a number, not a claim.",
  },
  { fragment: "minute${minutes === 1", category: "format", why: "See the note on seconds — grammatical agreement with a number, not a claim." },
  { fragment: "hour${hours === 1", category: "format", why: "See the note on seconds — grammatical agreement with a number, not a claim." },
  { fragment: "day${days === 1", category: "format", why: "See the note on seconds — grammatical agreement with a number, not a claim." },
  {
    fragment: "${pad(d.getHours())}",
    category: "format",
    why: "clockTime. 24-hour, zero-padded, to the second — change the shape and a reader reads the same instant in a worse notation, not a different claim.",
  },
  {
    fragment: "${MONTHS[d.getMonth()]} ${d.getDate()} ${clockTime(ms)}",
    category: "format",
    why: "entryStamp's other-day form. A date is added only when a bare clock would read as this morning and be wrong by however long HAL was off.",
  },
  {
    fragment: "${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}",
    category: "format",
    why: "dateStamp. A written-out date, one correct shape — a reader reads the same day whatever the notation.",
  },
  {
    fragment: "${Math.round(confidence * 100)}%",
    category: "format",
    why: "A match confidence as a percentage. The band phrases decide what is said around it; this is the number itself.",
  },
  {
    fragment: "${Math.round(entry.confidence * 100)}%",
    category: "format",
    why: "The same percentage, supplied to a reply that named someone without one. Band enforcement, not wording.",
  },
  {
    fragment: "data:image/jpeg;base64,",
    category: "format",
    why: "A data URL carrying the last frame to the UI preview pane. Bytes, not words.",
  },

  // -- structure ----------------------------------------------------------
  {
    fragment: "lines.join(\"\\n\")",
    category: "structure",
    why: "One line per line. A separator that says nothing is not wording, and there is nothing here a reader could be told differently.",
  },
  { fragment: "chosen.join(\"\\n\")", category: "structure", why: "See the note on lines.join — a separator that says nothing is not wording." },
  { fragment: "rendered.join(\"\\n\")", category: "structure", why: "See the note on lines.join — a separator that says nothing is not wording." },
  { fragment: "${lines.join(\"\\n\")}${note}${close}", category: "structure", why: "See the note on lines.join — a separator that says nothing is not wording." },
  { fragment: "${chosen.join(\"\\n\")}\\n${note}", category: "structure", why: "See the note on lines.join — a separator that says nothing is not wording." },
  { fragment: "session_lines: lines.join(\"\\n\")", category: "structure", why: "See the note on lines.join — a separator that says nothing is not wording." },
  {
    fragment: "phrases, { count: String(omitted) })}\\n${rendered.join",
    category: "structure",
    why: "The omitted-lines notice is itself a Phrase; this is only the newline that puts it above the lines it reports on.",
  },
  {
    fragment: ".join(\"|\")",
    category: "structure",
    why: "A regex alternation of enrolled names, for the band check on what a model wrote. Not read by anyone.",
  },
  {
    fragment: "(?<![\\\\p{L}\\\\p{N}])",
    category: "structure",
    why: "The band-enforcement regex itself, matching names a model wrote so they can be rebanded.",
  },
  {
    fragment: "${lead}${entry.name.trim()}${tail}",
    category: "structure",
    why: "Rewrites a name a model already wrote back into its banded form. The words come from the band phrases; this puts the model's own sentence back together around them.",
  },

  // -- not model facing ---------------------------------------------------
  {
    fragment: "${role}:${[...degraded].sort().join(\",\")}",
    category: "not-model-facing",
    why: "A cache key, so the warning below is logged once per shape of breakage rather than once per render.",
  },
  {
    fragment: ").join(\",\")",
    category: "not-model-facing",
    why: "The sorted slot names inside that cache key. Never read by a person, let alone a model.",
  },
  {
    fragment: "degraded.join(\", \")",
    category: "not-model-facing",
    why: "Lists the missing slot names in the warning shown to the user about their own template.",
  },
  {
    fragment: "That part of the message is rendering empty",
    category: "not-model-facing",
    why: "A warning to the user about their own template, in the log — not something HAL says.",
  },
  {
    fragment: "template ${role} names ",
    category: "not-model-facing",
    why: "The same warning's opening half, naming the role whose template lost a slot.",
  },
  {
    fragment: "`Claude ${sessionId}`",
    category: "not-model-facing",
    why: "Names the inference-log file this request is written to.",
  },
  {
    fragment: "is readable again.",
    category: "not-model-facing",
    why: "A Monitor status entry in HAL's own voice, shown in the feed. Never sent to a model.",
  },
  {
    fragment: "I could not narrate ${monitor.label}",
    category: "not-model-facing",
    why: "A Monitor failure entry in the feed. Never sent to a model.",
  },
  {
    fragment: "is not on this machine, and sending it a frame",
    category: "not-model-facing",
    why: "The off-machine acknowledgement refusal, shown in settings.",
  },
  {
    fragment: "The recogniser cannot keep up with a ${cfg.detectionIntervalSeconds}s",
    category: "not-model-facing",
    why: "A readiness warning shown in the Vision settings when detection is asked for faster than the recogniser answers.",
  },
  {
    fragment: "That image is too large.",
    category: "not-model-facing",
    why: "An enrolment error shown to the user.",
  },
  {
    fragment: "faces in it. Use one with only the person",
    category: "not-model-facing",
    why: "An enrolment error shown to the user.",
  },
  {
    fragment: "faces are in view. Enrol with one person in frame",
    category: "not-model-facing",
    why: "An enrolment error shown to the user.",
  },
  {
    fragment: "Merged ${result.mergedFrom} into",
    category: "not-model-facing",
    why: "A gallery merge confirmation shown to the user.",
  },
  {
    fragment: "Enrolment failed: ",
    category: "not-model-facing",
    why: "An enrolment error shown to the user.",
  },
  {
    fragment: "Could not add that face: ",
    category: "not-model-facing",
    why: "An enrolment error shown to the user.",
  },
  {
    fragment: "Could not save that person: ",
    category: "not-model-facing",
    why: "A gallery error shown to the user.",
  },

  // -- oracles ------------------------------------------------------------
  {
    fragment: "If there is nothing worth saying, reply with exactly ${VISION_SILENCE_TOKEN}",
    category: "oracle",
    why: "visionSensitivityInstruction, which has no production caller. It is the before-picture the vision-user Template's four sensitivity branches are snapshotted against, and it must not follow the editable side.",
  },
  {
    fragment: "${NARRATION_BASE} Keep commentary to one short",
    category: "oracle",
    why: "A shipped narration preset, composed from the shared base. Presets are Templates and editable; this is how the three are built from one base so they cannot drift.",
  },
  {
    fragment: "${NARRATION_BASE} Keep commentary to one or two short",
    category: "oracle",
    why: "See the note on the first preset.",
  },
  {
    fragment: "${NARRATION_BASE} Use two to three sentences",
    category: "oracle",
    why: "See the note on the first preset.",
  },
];

/**
 * Every `${…}` template literal and every join on a literal separator.
 *
 * Console output is dropped rather than listed one line at a time. It cannot
 * reach a model by any path — it goes to the terminal — and a dozen entries
 * saying so would be noise around the entries that carry an argument. Note that
 * this is the one exemption granted by shape rather than by name, which is why
 * it is narrow: `console.<something>(` and nothing else.
 *
 * Joins keep their receiver, so `lines.join("\n")` and `parts.join(", ")` are
 * distinguishable. A bare separator would collapse every list in the codebase
 * into one entry and account for all of them the first time one was explained.
 */
function builtStrings(source: string): string[] {
  const stripped = source
    // Comments first, so a fragment quoted in prose is not mistaken for code.
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/console\.\w+\([^;]*?\);/gs, "");
  const found = new Set<string>();
  for (const m of stripped.matchAll(/`[^`]*\$\{[^`]*`/g)) found.add(m[0]);
  for (const m of stripped.matchAll(/([\w.\])]+)\.join\("(?:[^"\\]|\\.)+"\)/g)) found.add(m[0]);
  return [...found];
}

const read = (rel: string) => fs.readFile(path.join(ROOT, rel), "utf8");

describe("every string that reaches a model has an editor", () => {
  it("accounts for every built string on the message-building surface", async () => {
    const unaccounted: string[] = [];
    for (const rel of SURFACE) {
      const source = await read(rel);
      for (const built of builtStrings(source)) {
        if (ACCOUNTED.some((e) => built.includes(e.fragment))) continue;
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
      expect(e.why.length, e.fragment).toBeGreaterThan(30);
    }
  });

  it("lists every file that renders a role message or a phrase", async () => {
    // The surface cannot be globbed without catching every file that happens to
    // build a string, so it is a list — and a list goes stale. This is what
    // notices: a new file that reaches the render machinery is a new place a
    // hardcoded line could hide.
    const roots = ["server/src", "shared/src"];
    const renderers: string[] = [];
    for (const root of roots) {
      const walk = async (dir: string): Promise<void> => {
        for (const entry of await fs.readdir(path.join(ROOT, dir), { withFileTypes: true })) {
          const rel = `${dir}/${entry.name}`;
          if (entry.isDirectory()) await walk(rel);
          else if (entry.name.endsWith(".ts")) {
            const source = await read(rel);
            if (/\brenderRoleMessage\s*\(|\brenderPhrase\s*\(/.test(source)) renderers.push(rel);
          }
        }
      };
      await walk(root);
    }
    // The two definition sites are not surface: they are the machinery.
    const surface = renderers.filter(
      (r) => r !== "shared/src/phrases.ts" && r !== "server/src/templates/roleMessages.ts",
    );
    for (const r of surface) {
      expect(SURFACE as readonly string[], `${r} renders messages but is not on the scanned surface`).toContain(r);
    }
  });

  it("fails when a hardcoded line is added to a render path", async () => {
    // The guard's own guard. A plausible new line — the shape all five audit
    // findings had — must not pass, or this file is decoration.
    const invented = 'const line = `[${kind}] ${text} <${severity}>`;';
    expect(builtStrings(invented)).toHaveLength(1);
    expect(ACCOUNTED.some((e) => builtStrings(invented)[0]!.includes(e.fragment))).toBe(false);
  });
});
