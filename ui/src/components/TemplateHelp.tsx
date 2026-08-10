import { useEffect } from "react";

/**
 * The syntax, on one screen.
 *
 * A language nobody can look up is hidden by another route, and the slot lists
 * beside each editor say what the *names* mean without ever saying what the
 * braces do. This is the other half: the four things there are to know, each
 * with the smallest example that shows it working.
 *
 * Deliberately short. It is a reference to glance at mid-edit, not a manual —
 * and the whole language is four rules, so a longer sheet would be padding.
 */
export function TemplateHelp({ onClose }: { onClose: () => void }) {
  // Escape closes, and focus goes to the panel so a keyboard user is not left
  // behind the overlay.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="help-scrim" data-testid="template-help" onClick={onClose}>
      <div
        className="help-sheet"
        role="dialog"
        aria-label="template syntax"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="help-head">
          <h4>the four things there are to know</h4>
          <button className="ghost" onClick={onClose} aria-label="close">
            ×
          </button>
        </div>

        <dl className="help-rules">
          <dt>
            <code>{"{name}"}</code> — a slot
          </dt>
          <dd>
            Puts a live reading where you type it. Each editor lists the ones its role accepts, with
            what they mean. A name that role does not have is refused when you apply, and the message
            says what is valid.
            <pre>
              {"Who I can see at {clock}:\n{vision_faces}"}
              {"\n\n→ Who I can see at 18:22:04:\n  - Creator 74%, …"}
            </pre>
          </dd>

          <dt>
            <code>{"{#name} … {/}"}</code> — a block
          </dt>
          <dd>
            Keeps what is between the braces only while that slot has something to say, and takes it
            away — heading and all — when it does not. This is how a section disappears cleanly
            instead of leaving a title above nothing. A block that goes takes one line break with it,
            so the sections around it close up.
            <pre>
              {"{#vision_faces}Who I can see:\n{vision_faces}{/}"}
              {"\n\n→ (camera off) nothing at all, not an empty heading"}
            </pre>
          </dd>

          <dt>
            <code>{"{name[5]}"}</code> — how many
          </dt>
          <dd>
            Some slots draw a list and take a count. You still cannot exceed the Context Level — that
            is a share of the model's window, and whichever bound is smaller wins. What a slot drops
            it says so, in its own words.
            <pre>{"{session_remarks[5]}\n\n→ the five most recent, oldest first"}</pre>
          </dd>

          <dt>
            <code>{"{{"}</code> and <code>{"}}"}</code> — a literal brace
          </dt>
          <dd>
            For when you want to write a brace rather than a slot — a JSON example, say.
            <pre>{'Reply as {{"tone": "dry"}}\n\n→ Reply as {"tone": "dry"}'}</pre>
          </dd>
        </dl>

        <div className="help-aside">
          <p>
            <strong>two layers.</strong> A <em>template</em> is a whole message and decides where
            things go. A <em>phrase</em> is one line inside it — one face, one remark, one person —
            and decides how that line reads. Phrases use the same four rules with their own small
            field lists.
          </p>
          <p>
            <strong>three kinds of slot.</strong> The list beside each editor groups them. What{" "}
            <em>this message</em> can see is the role's own. Beneath that they are grouped by where
            they come from — what I can see, the session I am watching, the logs I watch — because
            that is what decides which Context Level pays for them, and readings from one source
            run out of room together. Last comes <em>everywhere</em>: a handful that mean something
            in every message, so no editor has to list them twice.
          </p>
          <p>
            <strong>nothing is locked.</strong> Every shipped default carries a note saying what its
            wording is protecting and which measured failure produced it. Several of them exist
            because an earlier phrasing made HAL worse in a way that was measured, not guessed — the
            note is there so you can weigh that before you change it, not to stop you.
          </p>
          <p>
            <strong>reset always works.</strong> Reset restores what the release ships. Save a
            baseline first and you get a second thing to fall back to, independent of the default.
          </p>
        </div>
      </div>
    </div>
  );
}
