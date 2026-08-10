import {
  clockTime,
  entryStamp,
  formatIdentity,
  identityBand,
  knownPeopleSection,
  relativeAge,
  runStrength,
  type LastLook,
} from "../../../shared/src/prompts.js";

// The hand-assembled context sections, as they were before the template
// renderer replaced them.
//
// These are the oracle the byte-identity suites compare against, and nothing
// else may call them — they live under server/test/ precisely so that is true
// by construction rather than by a comment asking nicely. They were production
// code until 2026-08-09; see
// docs/residual-review-findings/feat-editable-prompt-templates.md.
//
// Do not "fix" anything here. A difference between these and the renderer is
// the finding; changing these to agree is deleting it.

// The separator every rendered line carries.
const NEWLINE = 1;

/**
 * What HAL can see, for a Conversation that asked to be told.
 *
 * Written as HAL's own sight rather than as a document handed to it, for the
 * reason `knownPeopleSection` is: naming the source makes the source the
 * subject, and "both reports place a room…" is a measured outcome of doing
 * that, not a hypothetical.
 *
 * The caption is quoted and dated rather than asserted. It comes from a small
 * vision model that invents object counts, and this is the one place in the
 * product where that text reaches a conversation — the cycle summary, which
 * used to be the only filter, says nothing at all on a quiet cycle, which is
 * exactly when someone asks what HAL can see. Attribution is the mitigation,
 * and it is placement rather than a prompt rule for the reason
 * docs/solutions/an-instruction-that-fights-its-own-input-loses.md gives.
 *
 * Banding reads the appearance's standing decision, not the current frame's
 * reading: that decision is what HAL acts on everywhere else, and a band that
 * moved mid-conversation would read as someone arriving and leaving.
 *
 * Returns empty when there is nothing to say, so a blank section never appears.
 */
export function visionContextSection(
  presence: {
    watching: boolean;
    present: readonly { match: { name: string; confidence: number } | null; since?: string; weight?: number }[];
  },
  lastLook: LastLook | null,
  people: readonly { name: string; profile?: string; isOperator?: boolean }[],
  thresholds: { recognition: number; statement: number },
  budget: number,
  now: Date = new Date(),
): string {
  if (!(budget > 0)) return "";

  const lines: string[] = [];
  let spent = 0;
  let droppedPeople = 0;
  const spend = (line: string): boolean => {
    if (spent + line.length > budget) return false;
    lines.push(line);
    spent += line.length;
    return true;
  };

  // Whether HAL is looking is the first thing, and it is not the same claim as
  // whether anyone is there. A section that said "nobody is in view" while the
  // camera was off would be inventing an observation.
  if (!presence.watching) {
    spend("I am not looking at anything right now; my camera is off.");
  } else if (presence.present.length === 0) {
    // Claims what recognition knows, and nothing more. This line comes from
    // face detection, so it means "no face I can place" — not "the room is
    // empty". Phrased as the latter it outranked a caption describing someone
    // sitting in the frame, and HAL answered "the room is empty" about an
    // occupied room. The caption is what carries occupancy; this carries
    // identity, and a line that overstates its own source is worse than silence.
    spend("I am watching, and no face I can place is in view; that is not the same as nobody being there.");
  } else {
    // Stated as current, and glosses nothing. The earlier version added "a
    // percentage is how strongly that face matched, nothing more" — meant as a
    // unit, taken as a caution. The model escalated it into a prohibition it
    // invented ("do not read it as a record of who is sitting here now") and
    // then obeyed that against its own data, refusing to name someone it had
    // recognised continuously for two minutes in the stated band. A qualifier
    // became the subject, exactly as
    // docs/solutions/an-instruction-that-fights-its-own-input-loses.md
    // describes. The evidence is supplied instead, and the band already decides
    // what may be said.
    spend(`Who I can see, read live just now at ${clockTime(now.getTime())}:`);
    for (const face of presence.present) {
      const band = face.match
        ? identityBand(face.match.confidence, thresholds.recognition, thresholds.statement)
        : "unrecognised";
      const who = face.match && band !== "unrecognised"
        ? formatIdentity(face.match.name, face.match.confidence, band)
        : "someone I do not recognise";
      // What the duration means, not just its size. An Appearance is one
      // person's continuous presence under a single identity decision, so a
      // two-minute one is two minutes of the same person — not a fresh guess
      // that happens to agree. Saying only "in view for 2 minutes" left that
      // inference unavailable, and HAL reported it could not tell who was in
      // front of it while watching them without a break.
      const since = face.since ? Date.parse(face.since) : Number.NaN;
      const held = Number.isFinite(since)
        ? `, recognised without a break as the same person for ${relativeAge(now.getTime() - since)}`
        : "";
      if (!spend(`- ${who}${held}${runStrength(face.weight)}.`)) droppedPeople += 1;
    }
    // The note has to fit too, and by this point the budget is spent — so room
    // is made for it by giving back the lines it is reporting on. A bound that
    // silently drops its own "I dropped things" notice is worse than no bound:
    // the result reads as a complete list.
    if (droppedPeople > 0) {
      let note = `- (${droppedPeople} other${droppedPeople === 1 ? "" : "s"} in view, not listed here.)`;
      while (spent + note.length > budget && lines.length > 1) {
        spent -= lines.pop()!.length;
        droppedPeople += 1;
        note = `- (${droppedPeople} other${droppedPeople === 1 ? "" : "s"} in view, not listed here.)`;
      }
      spend(note);
    }
  }

  // Quoted, dated, and attributed to a look rather than stated as fact.
  // Marked as the one stale part. The two ages are separate — presence is read
  // at this instant, the description is whenever the camera last described the
  // scene — and with only the caption carrying an age, HAL applied that age to
  // everything: "my last look was eighteen seconds ago, so I don't know what
  // has happened", said about a reading taken that same second.
  if (lastLook && lastLook.caption.trim()) {
    const at = Date.parse(lastLook.at);
    const when = Number.isFinite(at) ? `${relativeAge(now.getTime() - at)} ago at ${clockTime(at)}` : "at an unknown time";
    spend(`Separately, and this is the one thing above that is not current — my last description of the room, ${when}: "${lastLook.caption.trim()}"`);
  }

  if (lines.length === 0) return "";

  // Only a stated band unlocks a profile. Handing HAL someone's history on the
  // strength of a maybe is how a marginal match becomes a confident story about
  // the wrong person — and the operator is standing context regardless, because
  // who HAL is talking to is true with the camera off.
  const statedNames = new Set(
    presence.present
      .filter((f) => f.match && identityBand(f.match.confidence, thresholds.recognition, thresholds.statement) === "stated")
      .map((f) => f.match!.name),
  );
  const unlocked = people.filter((p) => p.profile?.trim() && (p.isOperator || statedNames.has(p.name)));
  const profiles = knownPeopleSection(
    unlocked.map((p) => ({ name: p.name, profile: p.profile!, ...(p.isOperator ? { isOperator: true } : {}) })),
    Math.max(0, budget - spent),
    // No closing instruction in a conversation. This is knowledge HAL holds
    // about people it is talking to, and a standing rule to speak of them only
    // as far as sight supports made ordinary exchanges stilted for subjects the
    // camera has nothing to say about.
    { closing: false },
  );

  return profiles ? `${lines.join("\n")}\n${profiles}` : lines.join("\n");
}

/**
 * What HAL has been saying about the session it is watching.
 *
 * Scoped to the watched session and nothing else. Several sessions are
 * followed at once, and a budget split across four of them follows none of them
 * far enough to be a story — so this buys depth with the one session the user
 * singled out. Filtering on the session id is also what structurally excludes
 * vision and monitor entries: they carry no session id, so they cannot arrive
 * here through a second rule that might drift from the first.
 *
 * Selected newest-first so the bound drops the oldest, and rendered oldest-first
 * so the model reads them in the order they happened.
 *
 * Returns empty when no session is being watched. The visible explanation for
 * that belongs to the control, not to this text: a conversation told "you are
 * watching nothing" would discuss it.
 */

export function sessionContextSection(
  entries: readonly { text: string; at: string; sessionId?: string | null; sessionLabel?: string }[],
  watchedSessionId: string | null,
  budget: number,
  now: Date = new Date(),
): string {
  if (!(budget > 0) || !watchedSessionId) return "";

  const mine = entries.filter((e) => e.sessionId === watchedSessionId);
  if (mine.length === 0) return "";

  const label = mine.at(-1)?.sessionLabel ?? "the session I am watching";
  // The clock anchor is what makes the per-entry stamps usable: the model can
  // work out how long ago something happened rather than knowing only the
  // order. Selection and ordering were always by time; until now the time was
  // computed and then thrown away, so HAL could say what happened but never
  // when.
  const header = `What I have been saying about ${label}, oldest first; it is now ${clockTime(now.getTime())}:`;

  const chosen: string[] = [];
  // Each line costs its own newline as well as its text, because the render
  // below joins with one. Counting only the text overran the budget by one
  // character per line — invisibly, since nothing downstream re-measures: the
  // control promised a size the request did not keep, which is the failure
  // `contextBudgetChars` exists to prevent one level up.
  let spent = header.length;
  let dropped = 0;
  for (let i = mine.length - 1; i >= 0; i -= 1) {
    const line = `- [${entryStamp(Date.parse(mine[i]!.at), now.getTime())}] ${mine[i]!.text.trim()}`;
    if (!(spent + NEWLINE + line.length <= budget)) {
      dropped += 1;
      continue;
    }
    chosen.unshift(line);
    spent += NEWLINE + line.length;
  }

  // What the bound dropped is stated rather than silently omitted, the rule
  // the profile budget and the candidate queue's eviction tally both follow —
  // and the notice is given room by giving back the remarks it reports on,
  // because a notice that does not fit is a silent truncation wearing a label.
  if (dropped > 0) {
    let note = `(${dropped} earlier remark${dropped === 1 ? "" : "s"} not recalled here.)`;
    while (spent + NEWLINE + note.length > budget && chosen.length > 0) {
      spent -= NEWLINE + chosen.shift()!.length;
      dropped += 1;
      note = `(${dropped} earlier remark${dropped === 1 ? "" : "s"} not recalled here.)`;
    }
    if (chosen.length === 0) return "";
    return `${header}\n${chosen.join("\n")}\n${note}`;
  }

  if (chosen.length === 0) return "";
  return `${header}\n${chosen.join("\n")}`;
}
