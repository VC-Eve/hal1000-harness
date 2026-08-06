import { describe, it, expect } from "vitest";
import { catalogFor, suggestions } from "../../src/monitors/catalog.js";

describe("monitor suggestion catalog", () => {
  it("offers a different list per platform", () => {
    const win = catalogFor("win32").map((e) => e.id);
    const linux = catalogFor("linux").map((e) => e.id);
    const mac = catalogFor("darwin").map((e) => e.id);

    expect(win).toContain("win-system");
    expect(linux).toContain("journal-system");
    expect(mac).toContain("macos-system");
    // No cross-contamination: a Windows entry must not appear on Linux.
    expect(linux).not.toContain("win-system");
    expect(win).not.toContain("syslog");
  });

  it("covers both acquisition modes, including the logs that are not files (R14)", () => {
    const win = catalogFor("win32");
    const linux = catalogFor("linux");

    // The Windows event logs are only reachable by command.
    expect(win.find((e) => e.id === "win-system")!.source.kind).toBe("command");
    expect(win.find((e) => e.id === "ollama-server")!.source.kind).toBe("file");
    expect(linux.find((e) => e.id === "journal-system")!.source.kind).toBe("command");
    expect(linux.find((e) => e.id === "syslog")!.source.kind).toBe("file");
  });

  it("gives every entry a non-empty label and reason", () => {
    // Guards a half-filled catalog entry reaching the drawer.
    for (const platform of ["win32", "linux", "darwin"] as const) {
      for (const entry of catalogFor(platform)) {
        expect(entry.label.trim().length).toBeGreaterThan(0);
        expect(entry.reason.trim().length).toBeGreaterThan(0);
        expect(entry.id.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("formats the Windows event-log command to the structured convention", () => {
    const cmd = catalogFor("win32").find((e) => e.id === "win-system")!.source;
    expect(cmd.kind).toBe("command");
    if (cmd.kind !== "command") return;
    // Tab-joined level/provider/message is what lets LevelDisplayName reach
    // severity instead of being guessed from the message text.
    expect(cmd.command).toContain("LevelDisplayName");
    expect(cmd.command).toContain("[char]9");
    // No backslash regex: it does not survive cmd.exe then PowerShell, and the
    // surviving literal eats every letter s in the message.
    expect(cmd.command).not.toContain("\\s");
    expect(cmd.command).toContain("[char]13");
  });

  it("bounds journald output with journalctl's own flag, not a pipe", () => {
    for (const entry of catalogFor("linux")) {
      if (entry.source.kind !== "command") continue;
      expect(entry.source.command).toContain("-n 200");
      // A pipe would mask journalctl's exit code, turning a failure into
      // empty output that looks like a healthy quiet log.
      expect(entry.source.command).not.toContain("|");
    }
  });

  it("polls commands less often than files, since a process launch is not free", () => {
    for (const platform of ["win32", "linux"] as const) {
      for (const entry of catalogFor(platform)) {
        if (entry.source.kind !== "command") continue;
        expect(entry.source.intervalMs).toBeGreaterThanOrEqual(60_000);
      }
    }
  });

  it("probes a real absent path and reports it unavailable (R15, AE6)", async () => {
    // Asserted against a path that cannot exist on any platform, so this tests
    // the decision rather than whichever OS the suite happens to run on.
    const foreign = process.platform === "win32" ? "linux" : "win32";
    const probed = await suggestions(foreign);
    expect(probed.length).toBeGreaterThan(0);
    // Every file-backed entry for a foreign platform is absent here.
    for (const s of probed) {
      if (s.source.kind === "file") expect(s.available).toBe(false);
    }
  });

  it("reports availability for every entry on the current platform", async () => {
    // Machine-independent: assert the shape is answered for all of them, not
    // that a particular tool happens to be installed on this box.
    const here = await suggestions();
    expect(here.length).toBeGreaterThan(0);
    for (const s of here) {
      expect(typeof s.available).toBe("boolean");
    }
  });

  it("carries the source through to the suggestion so it can become a monitor", async () => {
    const win = await suggestions("win32");
    const entry = catalogFor("win32").find((e) => e.id === "win-system")!;
    expect(win.find((s) => s.id === "win-system")!.source).toEqual(entry.source);
  });

  it("re-probes on every call rather than caching a stale answer", async () => {
    const a = await suggestions("linux");
    const b = await suggestions("linux");
    expect(a).toEqual(b);
    // Distinct objects: nothing is memoized, so a target created after boot is
    // picked up without a restart.
    expect(a).not.toBe(b);
  });
});
