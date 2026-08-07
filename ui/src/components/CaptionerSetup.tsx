import {
  CAPTIONER_COMMAND,
  CAPTIONER_NOTE,
  CAPTIONER_SETUP_STEPS,
} from "../../../shared/src/vision";

/**
 * What to do when there is no captioner.
 *
 * Shown where the fault surfaces rather than in a setup screen nobody opens.
 * HAL points at the captioner instead of installing it, so a fresh machine has
 * one thing to do first — and the moment it matters is the moment HAL says it
 * cannot reach one.
 */
export function CaptionerSetup({ compact = false }: { compact?: boolean }) {
  return (
    <div className="captioner-setup" data-testid="captioner-setup">
      {compact ? (
        <p>Vision needs a captioner running. It is a separate local model server, like Ollama.</p>
      ) : (
        <ol>
          {CAPTIONER_SETUP_STEPS.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      )}
      <pre className="captioner-command">{CAPTIONER_COMMAND}</pre>
      {compact ? null : <small>{CAPTIONER_NOTE}</small>}
    </div>
  );
}
