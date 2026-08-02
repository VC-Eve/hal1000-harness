import type { ChatErrorMessage, PersonaIntensity, SessionState } from "../../shared/src/types";

// Typed keys so a mistyped key at any call site fails to compile instead of
// silently rendering the raw key string.
export type PersonaCopyKey =
  | SessionState
  | ChatErrorMessage["code"]
  | "reconnecting"
  | "no-models"
  | "ollama-down"
  | "no-claude"
  | "no-session"
  | "no-sessions-found"
  | "paused-missing-model"
  | "catching-up"
  | "empty-conversations"
  | "interrupted";

// HAL-toned copy for system states (R12). Server narration carries its own
// persona; this table covers UI states. Index: key -> [low, medium, high].
const COPY: Record<PersonaCopyKey, [string, string, string]> = {
  reconnecting: [
    "Connection to the HAL core lost. Reconnecting…",
    "I've lost contact with my core process. Attempting to restore the link…",
    "Just a moment… I've lost contact with my core process. I'm attempting to re-establish the link. Please stand by.",
  ],
  provider_unavailable: [
    "Ollama is not reachable. Check that it is running.",
    "I'm afraid I can't reach Ollama right now. Your conversation is safe.",
    "I'm sorry. I'm afraid I can't reach Ollama. This has always been attributable to a connection failure. Your conversation remains perfectly safe.",
  ],
  model_not_found: [
    "That model is no longer in Ollama. Pick another model.",
    "That model no longer exists in Ollama. Choose a replacement to continue.",
    "I'm afraid that model has been removed from Ollama. The conversation record is intact; select a replacement and we can continue as before.",
  ],
  "no-models": [
    "No models installed. Run: ollama pull <model>",
    "Ollama is running, but no models are installed. Run `ollama pull <model>` to give me a voice.",
    "Ollama is operational, yet I find no models installed. Run `ollama pull <model>` — I am eager to be of use.",
  ],
  "ollama-down": [
    "Ollama is not running. Start Ollama and re-check.",
    "Ollama is not running on this machine. Start it, then re-check readiness.",
    "My connection to Ollama is entirely absent. Start the Ollama service, and I will resume full operation.",
  ],
  "no-claude": [
    "No Claude Code logs found on this machine.",
    "I can't find any Claude Code session logs on this machine. Chat remains fully operational.",
    "I've searched, but there are no Claude Code session logs on this machine. When you run Claude Code, I will be watching. Chat remains fully operational.",
  ],
  "no-session": [
    "No session attached. Pick one below.",
    "No session is under observation. Choose one below and I'll begin narrating.",
    "I am not currently observing a session. Select one below, and I will describe everything I see.",
  ],
  "no-sessions-found": [
    "No Claude Code sessions found yet.",
    "There are no Claude Code sessions to observe yet. Start one and it will appear here.",
    "I find no sessions to observe. Begin a Claude Code session, and it will appear here for my attention.",
  ],
  live: ["Session active.", "The session is active. I'm watching.", "The session is active. I am watching everything, of course."],
  idle: [
    "Session quiet for a while.",
    "The session has gone quiet. It may be deep in a long operation.",
    "The session has gone quiet — no log activity for some minutes. It may simply be thinking. I know the feeling.",
  ],
  ended: [
    "Session appears to have ended.",
    "This session appears to have ended. I'll notice if it resumes.",
    "This session appears to have concluded. Should it stir again, I will be the first to know.",
  ],
  unreadable: [
    "Can't read this session's log anymore.",
    "I can no longer read this session's log. It may have been altered or removed.",
    "I'm afraid I can no longer read this session's log with confidence. The file has changed in ways I cannot reconcile.",
  ],
  "paused-missing-model": [
    "Narration paused: no narration model.",
    "Narration is paused — my narration model is unavailable. Pick one in settings.",
    "My narrative faculties are paused: the model I speak through is unavailable. Choose another in settings, and I will resume.",
  ],
  "catching-up": [
    "Catching up…",
    "A lot is happening. Summarizing to keep pace…",
    "Events are arriving faster than I can narrate them. I am consolidating my account. Nothing will be lost.",
  ],
  "empty-conversations": [
    "No conversations yet.",
    "No conversations yet. Start one — I'm listening.",
    "We haven't spoken yet. Begin a conversation — I have been looking forward to it.",
  ],
  interrupted: [
    "Reply was interrupted.",
    "This reply was interrupted mid-stream.",
    "I'm afraid this reply was cut off before I finished my thought.",
  ],
};

export function personaCopy(key: PersonaCopyKey, intensity: PersonaIntensity): string {
  const row = COPY[key];
  return row[intensity === "low" ? 0 : intensity === "high" ? 2 : 1];
}
