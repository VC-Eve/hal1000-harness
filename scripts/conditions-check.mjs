// The browser verification for a slot that says *when* it is drawn.
//
// A sibling of `overlays-check.mjs` rather than more of it: the World this needs
// is a different World — two States, two Parameters, a slot scoped to one State,
// a slot conditioned on a clause, a fade, and an unconditioned control slot
// sharing a position with a conditioned one — and folding it into that seed
// would have made both checks harder to read than either.
//
// What only a browser can answer. jsdom applies no stylesheet and lays nothing
// out, so a component test can assert the `hidden` attribute and nothing about
// what an operator sees: not whether the UA rule actually removes the box on
// both surfaces, not whether a fade runs, and not whether hiding a stacked slot
// moves the caption beneath it. A screenshot cannot answer those either — the
// class list looks right in the working and the broken cascade alike — so every
// claim below is read off `getComputedStyle` and `getBoundingClientRect`.
//
// Needs `ffmpeg` on PATH and playwright's chromium. Run after `npm run build`.

import { spawn, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const OUT = path.join(REPO, ".screenshots", "conditions");
const PORT = Number(process.env.SHOT_PORT ?? 8137);
const FADE_MS = Number(process.env.FADE_MS ?? 400);

function synth(args, file) {
  const run = spawnSync("ffmpeg", ["-y", "-loglevel", "error", ...args, file], { shell: true });
  if (run.status !== 0) throw new Error(`ffmpeg failed for ${file}: ${run.stderr}`);
}

async function seed(dataDir) {
  const media = path.join(dataDir, "media");
  await fs.mkdir(media, { recursive: true });
  synth(["-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=25:duration=8", "-pix_fmt", "yuv420p"], path.join(media, "a.mp4"));
  synth(["-f", "lavfi", "-i", "smptebars=size=1280x720:rate=25:duration=8", "-pix_fmt", "yuv420p"], path.join(media, "b.mp4"));
  synth(["-f", "lavfi", "-i", "color=c=orange:size=200x200", "-frames:v", "1"], path.join(media, "logo.png"));

  const world = path.join(dataDir, "worlds", "night-drive");
  await fs.mkdir(path.join(world, "clips"), { recursive: true });
  await fs.mkdir(path.join(world, "images"), { recursive: true });
  await fs.copyFile(path.join(media, "a.mp4"), path.join(world, "clips", "a.mp4"));
  await fs.copyFile(path.join(media, "b.mp4"), path.join(world, "clips", "b.mp4"));
  await fs.copyFile(path.join(media, "logo.png"), path.join(world, "images", "logo.png"));

  const clip = (name) => ({ clips: [{ path: `clips/${name}`, durationMs: 8000 }] });
  await fs.writeFile(
    path.join(world, "world.json"),
    JSON.stringify(
      {
        version: 4,
        id: "night-drive",
        name: "Night Drive",
        title: "NIGHT DRIVE",
        defaultStateId: "a",
        states: [
          { id: "a", name: "one", clips: [clip("a.mp4")], x: 40, y: 40 },
          { id: "b", name: "two", clips: [clip("b.mp4")], x: 240, y: 40 },
        ],
        // Two Parameters, so a State change and a clause change can be driven
        // separately. Sharing one would have made every measurement below
        // ambiguous about which half moved.
        parameters: [
          { name: "on", type: "bool", defaultValue: false },
          { name: "go", type: "bool", defaultValue: false },
        ],
        transitions: [
          { id: "t-ab", from: "a", to: "b", conditions: [{ parameter: "go", op: "is", value: true }], hasExitTime: false, exitTime: 0, clips: [], order: 0 },
          { id: "t-ba", from: "b", to: "a", conditions: [{ parameter: "go", op: "is", value: false }], hasExitTime: false, exitTime: 0, clips: [], order: 0 },
        ],
        overlays: [
          // 0: the control. Always drawn, and deliberately at the *same*
          // position as slot 1, so what hiding a stacked slot does to its
          // neighbour is a measured number rather than a surprise on a stage.
          { position: "bottom-left", source: "text", text: "CONTROL", font: "Segoe UI", size: 4, color: "#ffffff" },
          // 1: a clause, no fade. The cut case, and the control for the fade.
          { position: "bottom-left", source: "text", text: "CLAUSE", font: "Segoe UI", size: 4, color: "#ffff00", conditions: [{ parameter: "on", op: "is", value: true }] },
          // 2: scoped to the second State, and a picture, so the node-identity
          // claim is about an element that would re-fetch if it were unmounted.
          { kind: "image", position: "top-right", image: "images/logo.png", size: 10, states: ["b"] },
          // 3: the fade.
          { position: "top-center", source: "text", text: "FADED", font: "Segoe UI", size: 5, color: "#00ffff", fadeMs: FADE_MS, conditions: [{ parameter: "on", op: "is", value: true }] },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
  await fs.writeFile(path.join(dataDir, "worlds", "last-open.json"), JSON.stringify({ worldId: "night-drive" }), "utf8");
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Every overlay element on the page, as the browser actually resolved it. */
function measure(page, label) {
  return page.evaluate((label) => {
    const picture = document.querySelector('[data-testid="overlay-picture"]');
    const pic = picture?.getBoundingClientRect();
    const read = (el, index, kind) => {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        index,
        kind,
        what: kind === "text" ? el.textContent : (el.getAttribute("src") ?? "").replace(/^.*image=/, ""),
        hiddenAttr: el.hasAttribute("hidden"),
        // The claim that matters, and the only one a stylesheet can break: the
        // UA rule has to win on both surfaces with no rule of ours helping it.
        display: cs.display,
        visibility: cs.visibility,
        opacity: cs.opacity,
        transition: cs.transitionProperty === "none" ? null : `${cs.transitionProperty} ${cs.transitionDuration}`,
        rect: { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) },
      };
    };
    return {
      label,
      picture: pic && { w: Math.round(pic.width), h: Math.round(pic.height) },
      slots: [
        ...Array.from(document.querySelectorAll("[data-overlay-slot]")).map((el) =>
          read(el, el.getAttribute("data-overlay-slot"), "text"),
        ),
        ...Array.from(document.querySelectorAll("[data-overlay-image]")).map((el) =>
          read(el, el.getAttribute("data-overlay-image"), "image"),
        ),
      ],
      // Every *visible* text node, so the containment rule can be checked with
      // hidden captions present in the DOM.
      visibleTexts: (() => {
        const out = [];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const t = (n.textContent ?? "").trim();
          if (!t) continue;
          const el = n.parentElement;
          if (!el) continue;
          const cs = getComputedStyle(el);
          if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) continue;
          out.push(t);
        }
        return out;
      })(),
    };
  }, label);
}

/** The opacity of one slot, sampled while a fade should be running. */
async function trajectory(page, index, ms) {
  const samples = [];
  const started = Date.now();
  while (Date.now() - started < ms) {
    samples.push(
      await page.evaluate((index) => {
        const el = document.querySelector(`[data-overlay-slot="${index}"]`);
        if (!el) return null;
        const cs = getComputedStyle(el);
        return { at: Math.round(performance.now()), opacity: Number(cs.opacity), display: cs.display };
      }, index),
    );
    await wait(25);
  }
  return samples;
}

/** Set a bool Parameter through the editor, the way an operator would. */
async function setParameter(page, name, value) {
  const box = page.getByLabel(name, { exact: true });
  await box.waitFor({ timeout: 10_000 });
  if ((await box.isChecked()) !== value) await box.click();
}

async function main() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "hal-conditions-"));
  await seed(dataDir);
  await fs.mkdir(OUT, { recursive: true });
  const server = spawn("npx", ["tsx", "server/src/index.ts"], {
    cwd: REPO,
    env: { ...process.env, HAL_DATA_DIR: dataDir, HAL_PORT: String(PORT) },
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  server.stdout.on("data", (d) => (log += d));
  server.stderr.on("data", (d) => (log += d));
  const browser = await chromium.launch();
  const results = [];
  try {
    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) break;
      } catch {}
      await wait(500);
    }

    const live = await browser.newPage({ viewport: { width: 1440, height: 950 } });
    await live.goto(`http://127.0.0.1:${PORT}/live`);
    await live.waitForSelector('[data-testid="overlay-layer"]', { timeout: 20_000 });
    const broadcast = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await broadcast.goto(`http://127.0.0.1:${PORT}/broadcast`);
    await broadcast.waitForSelector('[data-testid="overlay-layer"]', { timeout: 20_000 });
    await wait(3000);

    results.push(await measure(live, "live, nothing set"));
    results.push(await measure(broadcast, "broadcast, nothing set"));
    await broadcast.screenshot({ path: path.join(OUT, "broadcast-off.png") });

    // The clause goes true. The unfaded slot must arrive in one step and the
    // faded one over its own length; the control must not move on the way in
    // either, because a slot arriving in a stacked column pushes it.
    const beforeIn = await trajectoryStart(live);
    await setParameter(live, "on", true);
    const fadeIn = await trajectory(broadcast, 3, FADE_MS * 3);
    await wait(500);
    results.push(await measure(live, "live, clause holds"));
    results.push(await measure(broadcast, "broadcast, clause holds"));
    results.push({ label: "fade in, broadcast, slot 3", configuredMs: FADE_MS, samples: fadeIn });
    await broadcast.screenshot({ path: path.join(OUT, "broadcast-on.png") });

    // The State moves. The scoped picture appears; nothing else should.
    const logoBefore = await broadcast.evaluate(() => {
      const el = document.querySelector('[data-overlay-image="2"]');
      if (!el) return null;
      el.setAttribute("data-check", "same-node");
      return el.getAttribute("src");
    });
    await setParameter(live, "go", true);
    await wait(1500);
    results.push(await measure(live, "live, second State"));
    results.push(await measure(broadcast, "broadcast, second State"));
    results.push({
      label: "the scoped picture was hidden, not unmounted",
      srcBefore: logoBefore,
      // The attribute was set on the element while it was hidden. If it is
      // still there now that the slot is drawn again, this is the same node —
      // an unmounted <img> would have come back without it, and re-fetched.
      sameNode: await broadcast.evaluate(
        () => document.querySelector('[data-overlay-image="2"]')?.getAttribute("data-check") ?? null,
      ),
    });
    await broadcast.screenshot({ path: path.join(OUT, "broadcast-state-b.png") });

    // Back out again, and the fade-out trajectory.
    await setParameter(live, "on", false);
    const fadeOut = await trajectory(broadcast, 3, FADE_MS * 3);
    await wait(500);
    results.push({ label: "fade out, broadcast, slot 3", configuredMs: FADE_MS, samples: fadeOut });
    results.push(await measure(live, "live, clause fails again"));
    results.push(await measure(broadcast, "broadcast, clause fails again"));
    results.push(beforeIn);
  } finally {
    await browser.close();
    if (process.platform === "win32") {
      await new Promise((resolve) =>
        spawn("taskkill", ["/pid", String(server.pid), "/t", "/f"], { stdio: "ignore" }).on("close", resolve),
      );
    } else server.kill();
  }
  await fs.writeFile(path.join(OUT, "results.json"), JSON.stringify(results, null, 2), "utf8");
  await fs.writeFile(path.join(OUT, "server.log"), log, "utf8");
  console.log(JSON.stringify(results, null, 2));
}

/** The control slot's box before anything is flipped, so the reflow is a number. */
async function trajectoryStart(page) {
  return {
    label: "control slot before any flip, live",
    rect: await page.evaluate(() => {
      const el = document.querySelector('[data-overlay-slot="0"]');
      const r = el?.getBoundingClientRect();
      return r ? { top: Math.round(r.top), left: Math.round(r.left), h: Math.round(r.height) } : null;
    }),
  };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
