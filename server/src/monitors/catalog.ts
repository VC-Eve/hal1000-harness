import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { MonitorSource, MonitorSuggestion } from "../../../shared/src/types.js";

// Commands cost more than a file read — a fresh PowerShell plus Get-WinEvent
// against a 39,000-record log is not cheap, and this runs forever on a machine
// also hosting model inference. The quiet cycle is five minutes anyway, so a
// faster poll buys only earlier severe-line detection.
const COMMAND_POLL_MS = 120_000;

// A shipped suggestion before its availability is probed.
interface CatalogEntry {
  id: string;
  label: string;
  reason: string;
  source: MonitorSource;
  // What has to exist for this to be usable: a file path, or an executable.
  requires: { kind: "file"; path: string } | { kind: "exe"; name: string };
}

// Windows event logs are not files, so they arrive by command. Output is
// formatted to the level/source/message tab convention the command runner
// parses, which is what lets LevelDisplayName reach severity as a stated level.
//
// Deliberately no backslash regex: the command crosses cmd.exe and then
// PowerShell, and a `\s` written here loses its backslash on the way and turns
// into a literal `s` match that eats every letter s in the message. Character
// codes survive both layers.
function winEventCommand(logName: string): string {
  const inner = [
    `Get-WinEvent -LogName ${logName} -MaxEvents 40 -ErrorAction SilentlyContinue`,
    `ForEach-Object { ($_.LevelDisplayName, $_.ProviderName, $_.Message.Replace([char]13,' ').Replace([char]10,' ')) -join [char]9 }`,
  ].join(" | ");
  return `powershell -NoProfile -NonInteractive -Command "${inner}"`;
}

// journald states PRIORITY, so severity is read rather than guessed.
//
// Bounded with journalctl's own -n rather than a `--since` substitution or a
// pipe to tail. `--since` would need a timestamp format this codebase cannot
// verify from Windows — an ISO-8601 Z value is not obviously parsed the way the
// substitution produces it, and getting it wrong makes the monitor silently
// blind rather than noisy. Piping to tail would also mask journalctl's exit
// code, turning a failure into empty output. The line-identity window already
// makes re-emitted lines free, so the only cost is a slightly larger read.
function journalCommand(extra = ""): string {
  return `journalctl --no-pager --output=short-iso -n 200${extra ? ` ${extra}` : ""}`;
}

const WINDOWS: CatalogEntry[] = [
  {
    id: "win-system",
    label: "Windows System log",
    reason: "Service failures, driver problems, and unexpected restarts.",
    source: { kind: "command", command: winEventCommand("System"), intervalMs: COMMAND_POLL_MS },
    requires: { kind: "exe", name: "powershell" },
  },
  {
    id: "win-application",
    label: "Windows Application log",
    reason: "Application crashes and faults reported by installed software.",
    source: { kind: "command", command: winEventCommand("Application"), intervalMs: COMMAND_POLL_MS },
    requires: { kind: "exe", name: "powershell" },
  },
  {
    id: "ollama-server",
    label: "Ollama server log",
    reason: "HAL's own model provider — model loads, memory pressure, and request failures.",
    source: { kind: "file", path: path.join(os.homedir(), "AppData", "Local", "Ollama", "server.log") },
    requires: { kind: "file", path: path.join(os.homedir(), "AppData", "Local", "Ollama", "server.log") },
  },
  {
    id: "win-cbs",
    label: "Windows servicing log",
    reason: "Component servicing and update repair. High volume and mostly routine — quiet verbosity strongly advised.",
    source: { kind: "file", path: "C:\\Windows\\Logs\\CBS\\CBS.log" },
    requires: { kind: "file", path: "C:\\Windows\\Logs\\CBS\\CBS.log" },
  },
];

const LINUX: CatalogEntry[] = [
  {
    id: "journal-system",
    label: "systemd journal",
    reason: "The whole machine's log — services, kernel, and sessions in one stream.",
    source: { kind: "command", command: journalCommand(), intervalMs: COMMAND_POLL_MS },
    requires: { kind: "exe", name: "journalctl" },
  },
  {
    id: "journal-errors",
    label: "systemd journal (errors only)",
    reason: "The same stream filtered to error priority and above — much quieter.",
    source: { kind: "command", command: journalCommand("-p err"), intervalMs: COMMAND_POLL_MS },
    requires: { kind: "exe", name: "journalctl" },
  },
  {
    id: "syslog",
    label: "/var/log/syslog",
    reason: "General system messages on Debian and Ubuntu family distributions.",
    source: { kind: "file", path: "/var/log/syslog" },
    requires: { kind: "file", path: "/var/log/syslog" },
  },
  {
    id: "auth-log",
    label: "/var/log/auth.log",
    reason: "Authentication attempts, sudo use, and SSH activity.",
    source: { kind: "file", path: "/var/log/auth.log" },
    requires: { kind: "file", path: "/var/log/auth.log" },
  },
];

const MACOS: CatalogEntry[] = [
  {
    id: "macos-system",
    label: "/var/log/system.log",
    reason: "Classic system messages still written alongside unified logging.",
    source: { kind: "file", path: "/var/log/system.log" },
    requires: { kind: "file", path: "/var/log/system.log" },
  },
  {
    id: "macos-install",
    label: "/var/log/install.log",
    reason: "Installer and software update activity.",
    source: { kind: "file", path: "/var/log/install.log" },
    requires: { kind: "file", path: "/var/log/install.log" },
  },
];

export function catalogFor(platform: NodeJS.Platform = process.platform): CatalogEntry[] {
  if (platform === "win32") return WINDOWS;
  if (platform === "darwin") return MACOS;
  return LINUX;
}

async function onPath(name: string): Promise<boolean> {
  const raw = process.env.PATH ?? "";
  const dirs = raw.split(path.delimiter).filter(Boolean);
  // PATHEXT is what makes `powershell` resolve to powershell.exe on Windows.
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean) : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      try {
        await fs.access(path.join(dir, name + ext.toLowerCase()));
        return true;
      } catch {
        // Try the next combination; absence here is the normal case.
      }
    }
  }
  return false;
}

async function available(entry: CatalogEntry): Promise<boolean> {
  if (entry.requires.kind === "file") {
    try {
      await fs.access(entry.requires.path);
      return true;
    } catch {
      return false;
    }
  }
  return onPath(entry.requires.name);
}

// Probed per request rather than cached: a target can appear after an install,
// and a stale "unavailable" would hide a suggestion that now works.
export async function suggestions(platform: NodeJS.Platform = process.platform): Promise<MonitorSuggestion[]> {
  const entries = catalogFor(platform);
  const probed = await Promise.all(entries.map((e) => available(e)));
  return entries.map(({ id, label, reason, source }, i) => ({
    id,
    label,
    reason,
    source,
    available: probed[i]!,
  }));
}
