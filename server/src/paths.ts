import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Per-OS user-data directory for conversations, settings, and watcher state.
export function dataDir(): string {
  const override = process.env.HAL_DATA_DIR;
  if (override) return override;
  const home = os.homedir();
  switch (process.platform) {
    case "win32":
      return path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "hal1000");
    case "darwin":
      return path.join(home, "Library", "Application Support", "hal1000");
    default:
      return path.join(process.env.XDG_DATA_HOME ?? path.join(home, ".local", "share"), "hal1000");
  }
}

export function ensureDataDir(): string {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Every World lives in its own directory under here, holding a manifest and a
// `clips/` folder. The folder is the World (R3): copying one produces an
// independent fork, and HAL's own data holds only which was last open (R4).
export function worldsDir(dataDir: string): string {
  return path.join(dataDir, "worlds");
}

// Tracks and named playlists, a sibling of `worlds/` rather than a folder
// inside one. Audio is shared: a playlist exists independently of any World
// (R9), several Worlds may name the same one, and deleting a World must take no
// track and no playlist with it (R13) — which a store living inside a World
// folder could not promise.
export function audioDir(dataDir: string): string {
  return path.join(dataDir, "audio");
}

// Claude Code writes per-session JSONL logs under ~/.claude/projects.
export function claudeProjectsDir(): string {
  return process.env.HAL_CLAUDE_PROJECTS_DIR ?? path.join(os.homedir(), ".claude", "projects");
}
