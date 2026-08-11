// Screenshots of the running UI, for verifying visual work by eye.
//
// AGENTS.md puts the HAL aesthetic under screenshot review rather than
// assertions, which left visual changes verified only by whoever happened to be
// sitting at the machine. This closes that: it boots a HAL against a throwaway
// data directory, drives the real UI, and writes PNGs.
//
// A throwaway HAL_DATA_DIR is the point — the shots must never depend on, or
// disturb, the settings and conversations of the instance the user is running.
//
//   npm run build                                  # FIRST — see below
//   node scripts/screenshot.mjs                    # every scene, default widths
//   node scripts/screenshot.mjs settings           # one scene
//   node scripts/screenshot.mjs settings --width 720
//
// Output goes to .screenshots/ (gitignored).
//
// RUN `npm run build` FIRST. This boots the server, which serves `ui/dist` —
// it does not build. Without a build you are reviewing the last bundle somebody
// made, and it looks entirely plausible: a UI change verified this way came back
// clean while the change was not in the picture at all. The failure is silent in
// both directions, so it is worth the four hundred milliseconds every time.

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = Number(process.env.SHOT_PORT ?? 8130);
const OUT = process.env.SHOT_OUT ?? ".screenshots";
const DEFAULT_WIDTHS = [1440, 900];

// A scene is a name, the clicks that get the UI into that state, and the widths
// worth seeing it at. Add one here rather than writing a new script.
const SCENES = {
  app: {
    description: "the three-section layout as it opens",
    widths: [1440, 900],
    async setup() {},
  },
  settings: {
    description: "the settings modal on its opening category",
    widths: [1440, 1100, 720],
    async setup(page) {
      await openSettings(page);
    },
  },
  // A prompt that used to be a plain textarea, now a template editor with its
  // slot list open. The claim under review is that the list stays readable once
  // it carries a role's own readings grouped by source plus the universal tier
  // — which is a thing to look at, not a thing to assert.
  "converted-prompt": {
    description: "the narration prompt as a template editor, slot list expanded",
    widths: [1440, 1100],
    async setup(page) {
      await openSettings(page);
      await category(page, "sessions").click();
      await page.locator('[data-testid="template-narrationPrompt"] button', { hasText: "slots (" }).click();
      await page.waitForSelector('[data-testid="template-slots-narrationPrompt"]');
      await page.locator('[data-testid="template-slots-narrationPrompt"]').scrollIntoViewIfNeeded();
    },
  },
  // The same list at its largest: the conversation context template carries
  // readings from all three Observation Sources, so this is where grouping
  // either earns its place or does not.
  "grouped-slots": {
    description: "the conversation context template's slot list, grouped by source",
    widths: [1440, 1100],
    async setup(page) {
      await openSettings(page);
      await category(page, "chat").click();
      await page.getByTestId("disclosure-chat-context").click();
      await page.locator('[data-testid="template-chat-context"] button', { hasText: "slots (" }).click();
      await page.waitForSelector('[data-testid="template-slots-chat-context"]');
      await page.locator('[data-testid="template-slots-chat-context"]').scrollIntoViewIfNeeded();
    },
  },
  // The chat-side prompt editor, opted in, with its slot list open. This is the
  // surface the whole feature exists for: it went from three names to roughly
  // eighteen, and whether that is still findable is a thing to look at.
  "conversation-prompt": {
    description: "a thread's own prompt editor, slot list grouped by source",
    widths: [1440, 1100],
    async setup(page) {
      await page.getByRole("button", { name: "+ new conversation" }).click();
      await page.getByRole("button", { name: /system prompt:/ }).click();
      await page.getByTestId("convo-prompt-enable-slots").click();
      await page.waitForSelector('[data-testid="convo-prompt-slots"]');
      await page.locator('[data-testid="convo-prompt-slots"]').scrollIntoViewIfNeeded();
    },
  },
  // The vision timeline needs a record to render, and this HAL boots against an
  // empty throwaway directory with no camera. Seeded on disk before boot rather
  // than driven through the UI: there is no user action that produces a check.
  "vision-timeline": {
    description: "the vision pane showing checks, captions and a collapsed absence",
    widths: [1440, 900],
    async seed(dataDir) {
      const at = (second) => new Date(Date.UTC(2026, 7, 8, 17, 4, second)).toISOString();
      const check = (second, faces) => ({ kind: "check", at: at(second), faces });
      const seen = (name, confidence, weight, band) => [
        { embedded: true, personId: name, name, confidence, band, weight, sourceWidth: 180 },
      ];
      const events = [
        check(0, []),
        check(3, []),
        check(6, []),
        check(9, []),
        check(12, []),
        check(15, seen("Steve", 0.74, 0.19, "stated")),
        { kind: "caption", at: at(18), caption: "A person sits at a desk in a dim room, facing the camera." },
        check(21, seen("Steve", 0.68, 0.35, "stated")),
        check(24, seen("Steve", 0.55, 0.47, "hedged")),
        check(27, [{ embedded: true, sourceWidth: 96 }]),
        check(30, []),
        check(33, []),
        check(36, []),
      ];
      await fs.mkdir(path.join(dataDir, "vision-timeline"), { recursive: true });
      await fs.writeFile(
        path.join(dataDir, "vision-timeline", "2026-08-08.jsonl"),
        events.map((e) => `${JSON.stringify(e)}\n`).join(""),
        "utf8",
      );
    },
    // The other two sections collapse so the timeline gets the height it needs
    // to show a run, a sighting and a caption at once — which is the whole
    // claim being reviewed by eye.
    async setup(page) {
      await page.getByRole("button", { name: "Collapse conversation" }).click();
      await page.getByRole("button", { name: "Collapse session observation" }).click();
    },
  },
  // The context control, open, on a fresh conversation. Its whole claim is that
  // a level reads in characters and the number is true for the model in use, so
  // the shot has to show the picker expanded rather than the collapsed summary.
  "conversation-context": {
    description: "the two context switches, labelled by what they will send",
    widths: [1440, 900],
    async setup(page) {
      await page.getByRole("button", { name: "+ new conversation" }).click();
      await page.getByRole("button", { name: /what I can see/ }).click();
      await page.waitForSelector(".context-readout");
      // Both sources on, so the shot carries the two things worth reviewing by
      // eye: the character figure the levels resolve to on this model, and the
      // notice that a watched session is what the session source needs.
      const [vision, session] = await page.locator(".context-row select").all();
      await vision.selectOption("large");
      await session.selectOption("large");
      await page.waitForTimeout(150);
    },
  },
  "settings-vision": {
    description: "the largest settings category, where scrolling is worst",
    widths: [1440],
    async setup(page) {
      await openSettings(page);
      await category(page, "vision").click();
    },
  },
  // The on/off pairs, both colours in one frame. Recognition is turned on
  // rather than watching, deliberately: enabling watching would open the real
  // camera, and the device is exclusive — a screenshot must not take it away
  // from the instance the user is running.
  "settings-toggles": {
    description: "enable/disable pairs, showing the on and off colours together",
    widths: [1440],
    async setup(page) {
      await openSettings(page);
      await category(page, "vision").click();
      // Second "on" in the panel: the first belongs to watching, which must
      // not be enabled here — see above.
      await page.getByRole("button", { name: "on", exact: true }).nth(1).click();
      await page.getByText("remark in the observation feed").scrollIntoViewIfNeeded();
      await page.waitForTimeout(150);
    },
  },
  "settings-chat": {
    description: "the chat category, including what gets added to a conversation",
    widths: [1440],
    async setup(page) {
      await openSettings(page);
      await category(page, "chat").click();
      await page.getByText("what else gets added").scrollIntoViewIfNeeded();
      await page.waitForTimeout(150);
    },
  },
  // The wording editors, now inside the section that owns them. Two scenes
  // rather than one: the shape with the blocks open, and the shape a reader
  // actually works in — slot list expanded, a validation error showing —
  // because those are the parts with no equivalent anywhere else in the panel.
  //
  // Vision is the worst case by a distance: two envelopes and twenty phrase
  // editors on top of the largest section in the drawer. If the collapsing
  // earns its keep anywhere, it is here.
  "settings-vision-wording": {
    description: "vision with both envelopes open, the heaviest section in the drawer",
    widths: [1440, 1100],
    async setup(page) {
      await openSettings(page);
      await category(page, "vision").click();
      await page.getByTestId("disclosure-vision").click();
      await page.getByTestId("disclosure-captioner").click();
      await page.waitForSelector('[data-testid="template-captioner-user"]');
      await page.getByTestId("disclosure-vision").scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);
    },
  },
  "conversation-prompt": {
    description: "a thread's own prompt, before and after opting into slots",
    widths: [1100],
    async setup(page) {
      await page.getByRole("button", { name: /new conversation/i }).click();
      await page.waitForSelector(".convo-prompt-toggle");
      await page.getByRole("button", { name: /system prompt:/ }).click();
      const box = page.getByLabel("Conversation system prompt");
      await box.fill("You are HAL. Answer briefly.");
      await page.getByTestId("convo-prompt-enable-slots").click();
      await page.waitForTimeout(400);
      await box.fill(["{context}", "", "You are HAL. Answer briefly."].join("\n"));
      await page.waitForTimeout(300);
    },
  },
  "settings-help": {
    description: "the syntax cheat sheet, reached from the section that needs it",
    widths: [1440],
    async setup(page) {
      await openSettings(page);
      await category(page, "vision").click();
      await page.getByTestId("open-template-help-vision").click();
      await page.waitForSelector("[data-testid='template-help']");
      await page.waitForTimeout(200);
    },
  },
  "settings-phrases": {
    description: "the per-line phrase editors, in the section whose lines they are",
    widths: [1440],
    async setup(page) {
      await openSettings(page);
      await category(page, "vision").click();
      await page.getByTestId("disclosure-vision-lines").click();
      await page.getByTestId("phrase-group-sight").scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);
    },
  },
  "settings-templates-working": {
    description: "a template mid-edit: slots listed, a rejected slot name, the preview",
    widths: [1440],
    async setup(page) {
      await openSettings(page);
      await category(page, "log monitors").click();
      await page.getByTestId("disclosure-monitor").click();
      const monitor = page.getByTestId("template-monitor-user");
      await monitor.scrollIntoViewIfNeeded();
      await monitor.getByRole("button", { name: /^slots \(/ }).click();
      const box = monitor.getByRole("textbox");
      await box.fill("{#reason_cycle}Summarise {monitor_label}.{/}\n\n{monitor_lines}\n{data_vison}");
      await page.waitForTimeout(200);
    },
  },
  "settings-chat": {
    description: "chat, with the envelope collapsed beneath the preamble it wraps",
    widths: [1440, 1100],
    async setup(page) {
      await openSettings(page);
      await category(page, "chat").click();
      await page.waitForTimeout(200);
    },
  },
  // The disclosure collapsing a SECOND time. jsdom loads no stylesheet, so the
  // component test reads the `hidden` attribute and passes either way; whether
  // the block actually closes depends on `.settings-disclosure-body[hidden]`
  // beating its own `display: flex`. That is only visible here.
  "settings-disclosure-recollapsed": {
    description: "an envelope opened once and closed again — proves hidden beats the flex rule",
    widths: [1100],
    async setup(page) {
      await openSettings(page);
      await category(page, "chat").click();
      const toggle = page.getByTestId("disclosure-chat-context");
      await toggle.click();
      await page.waitForSelector('[data-testid="template-chat-context"]');
      await toggle.click();
      await page.waitForTimeout(200);
    },
  },
  "settings-readiness": {
    description: "the smallest category, the worst case for empty space",
    widths: [1440],
    async setup(page) {
      await openSettings(page);
      await category(page, "readiness").click();
    },
  },
};

async function openSettings(page) {
  await page.getByRole("button", { name: /settings/i }).click();
  await page.waitForSelector('[data-testid="settings-panel"]');
}

// Scoped to the rail on purpose. The panes behind the modal have their own
// controls — "Collapse vision" is a button named vision too — so an unscoped
// role query is ambiguous the moment a category shares a word with a pane.
function category(page, name) {
  return page.getByTestId("settings-nav").getByRole("button", { name });
}

function parseArgs(argv) {
  const names = [];
  let width = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--width") {
      width = Number(argv[i + 1]);
      i += 1;
    } else {
      names.push(argv[i]);
    }
  }
  return { names: names.length > 0 ? names : Object.keys(SCENES), width };
}

// Resolves when the server answers, rather than after a fixed sleep — boot time
// varies and a sleep is either flaky or wasteful.
async function waitForServer(url, timeoutMs = 30_000) {
  const started = Date.now();
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // Not up yet.
    }
    if (Date.now() - started > timeoutMs) throw new Error(`Server did not answer at ${url} within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/**
 * Kills the server and everything it spawned.
 *
 * `child.kill()` is not enough here: the command runs through a shell on
 * Windows, so the signal reaches the shell and leaves the node process holding
 * the port. The next run then finds the port taken, its own server exits, and
 * the readiness probe cheerfully connects to the *previous* run's instance.
 */
async function stopServer(child) {
  if (process.platform === "win32" && child.pid) {
    await new Promise((resolve) => {
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" }).on("close", resolve);
    });
    return;
  }
  child.kill();
}

async function main() {
  const { names, width } = parseArgs(process.argv.slice(2));
  for (const name of names) {
    if (!SCENES[name]) {
      console.error(`Unknown scene "${name}". Known: ${Object.keys(SCENES).join(", ")}`);
      process.exit(1);
    }
  }

  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "hal1000-shots-"));
  await fs.mkdir(OUT, { recursive: true });

  // Before boot: a seed is state the server reads at startup or greets clients
  // with, not something a click can produce.
  for (const name of names) {
    if (SCENES[name].seed) await SCENES[name].seed(dataDir);
  }

  const server = spawn("npx", ["tsx", "server/src/index.ts"], {
    env: { ...process.env, HAL_DATA_DIR: dataDir, HAL_PORT: String(PORT) },
    stdio: "ignore",
    shell: process.platform === "win32",
  });

  const browser = await chromium.launch();
  const written = [];
  try {
    await waitForServer(`http://127.0.0.1:${PORT}/`);
    if (server.exitCode !== null) {
      throw new Error(
        `The screenshot server exited immediately (code ${server.exitCode}) — port ${PORT} is probably held by an ` +
          `orphan from an earlier run. Whatever is listening there is not this run's build.`,
      );
    }

    for (const name of names) {
      const scene = SCENES[name];
      for (const w of width ? [width] : scene.widths ?? DEFAULT_WIDTHS) {
        const page = await browser.newPage({ viewport: { width: w, height: Math.round(w * 0.66) } });
        await page.goto(`http://127.0.0.1:${PORT}/`);
        // The UI paints from a WebSocket handshake, not from the HTML, so the
        // settings button does not exist at load. Waiting on a real element
        // beats a sleep.
        await page.waitForSelector(".layout", { timeout: 15_000 });
        // Wait for the socket to settle before touching anything. Two reasons,
        // both of which produced intermittent failures: the settings panel is
        // gated on settings having arrived over the WebSocket, so a click lands
        // on nothing until then; and while disconnected a reconnect banner sits
        // beside the settings button, so the button moves every time the banner
        // toggles and never satisfies Playwright's stability check.
        await page.waitForSelector(".reconnect-banner", { state: "detached", timeout: 20_000 });
        await scene.setup(page);
        // Let transitions and webfonts settle before capturing.
        await page.waitForTimeout(400);
        const file = path.join(OUT, `${name}-${w}.png`);
        await page.screenshot({ path: file });
        written.push(file);
        await page.close();
      }
    }
  } finally {
    await browser.close();
    await stopServer(server);
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }

  console.log(written.join("\n"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
