// The blend's browser verification — U7 of the clip-blending plan.
//
// Does the crossfade actually happen, and does it look like a crossfade?
//
// jsdom lays nothing out and plays no media, so nothing in the suite can answer
// the three questions this feature stands or falls on:
//
//   1. Are both elements really playing at the same time through the window?
//   2. Does the picture ever go dark mid-blend? (Two elements crossing at 0.5
//      over the stage's black is a dip, not a dissolve.)
//   3. Does the fade happen on BOTH kinds of boundary? The outgoing element
//      alternates 0, 1, 0, 1, and DOM order paints element 1 over element 0 —
//      so without an explicit z-index the dissolve is invisible on half of them.
//
//   npm run build                      # FIRST — the server serves ui/dist
//   node scripts/blend-check.mjs       # prints the measurements as JSON
//
// Node is used only to detect that a boundary happened. The sampling is done
// IN THE PAGE by a requestAnimationFrame loop, because a CDP round trip costs
// tens of milliseconds with unbounded jitter and a 250ms window can be missed
// entirely between two Node-side samples.
//
// Needs ffmpeg on PATH (the media must actually decode) and playwright's
// chromium.
import { chromium } from "playwright";
import { spawn, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const PORT = Number(process.env.SHOT_PORT ?? 8133);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The blend the seeded World asks for. `BLEND_MS=0 node scripts/blend-check.mjs`
 * is the control run: it must report no overlap at all, which is what proves the
 * no-blend path is still the hard cut it always was.
 */
const BLEND_MS = Number(process.env.BLEND_MS ?? 250);

function synth(args, file) {
  const result = spawnSync("ffmpeg", ["-y", "-loglevel", "error", ...args, file], { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`ffmpeg failed for ${file}`);
}

/**
 * One State looping a run of two clips, so a boundary comes round every 2s and
 * the outgoing element alternates between the two.
 *
 * The two clips are visually distinct on purpose — a solid red and a solid blue
 * — so a composite that dips through black is measurable as a luminance drop
 * rather than having to be eyeballed.
 */
async function seed(dataDir, BLEND_MS) {
  const clips = path.join(dataDir, "worlds", "blendworld", "clips");
  await fs.mkdir(clips, { recursive: true });
  synth(["-f", "lavfi", "-i", "color=c=red:size=640x360:rate=25:duration=2", "-pix_fmt", "yuv420p"], path.join(clips, "red.mp4"));
  synth(["-f", "lavfi", "-i", "color=c=blue:size=640x360:rate=25:duration=2", "-pix_fmt", "yuv420p"], path.join(clips, "blue.mp4"));
  await fs.writeFile(
    path.join(dataDir, "worlds", "blendworld", "world.json"),
    JSON.stringify(
      {
        version: 4,
        id: "blendworld",
        name: "Blend World",
        defaultStateId: "a",
        states: [
          {
            id: "a",
            name: "loop",
            clips: [{ clips: [{ path: "clips/red.mp4", durationMs: 2000 }, { path: "clips/blue.mp4", durationMs: 2000 }] }],
            x: 40,
            y: 40,
          },
        ],
        transitions: [],
        parameters: [],
        blendMs: BLEND_MS,
      },
      null,
      2,
    ),
    "utf8",
  );
  await fs.writeFile(path.join(dataDir, "worlds", "last-open.json"), JSON.stringify({ worldId: "blendworld" }), "utf8");
}

/**
 * Install an in-page recorder over both elements.
 *
 * Samples every animation frame: the computed opacity and z-index of each
 * element, whether it is actually advancing, and which classes it carries.
 * `paintedAlpha` is what the viewer sees — the composite of the two elements in
 * paint order — and is what answers the dark-pulse question.
 */
const RECORD = (selector) => {
  const els = Array.from(document.querySelectorAll(selector));
  if (els.length !== 2) return { error: `expected 2 elements, found ${els.length}` };
  const samples = [];
  const t0 = performance.now();
  let stop = false;
  const tick = () => {
    if (stop) return;
    const s = els.map((el) => {
      const cs = getComputedStyle(el);
      return {
        opacity: Number(cs.opacity),
        zIndex: cs.zIndex === "auto" ? 0 : Number(cs.zIndex),
        t: el.currentTime,
        paused: el.paused,
        cls: el.className,
      };
    });
    // Paint order: later DOM element paints on top unless z-index says
    // otherwise. Composite over the stage's black.
    const order = s[0].zIndex > s[1].zIndex ? [1, 0] : s[0].zIndex < s[1].zIndex ? [0, 1] : [0, 1];
    let alpha = 0;
    for (const i of order) alpha = alpha + s[i].opacity * (1 - alpha);
    samples.push({ ms: Math.round(performance.now() - t0), a: s[0], b: s[1], paintedAlpha: alpha });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  window.__blendStop = () => {
    stop = true;
    return samples;
  };
  return { ok: true };
};

/** Reduce raw frames to the claims the plan makes. */
function analyse(samples) {
  const blending = samples.filter((s) => s.a.cls.includes("blending-out") || s.b.cls.includes("blending-out"));
  const windows = [];
  let run = null;
  for (const s of samples) {
    const inWindow = s.a.cls.includes("blending-out") || s.b.cls.includes("blending-out");
    if (inWindow && !run) run = { fadingIndex: s.a.cls.includes("blending-out") ? 0 : 1, frames: [] };
    if (inWindow && run) run.frames.push(s);
    if (!inWindow && run) {
      windows.push(run);
      run = null;
    }
  }
  const first = samples[0];
  const last = samples[samples.length - 1];
  const verdicts = windows.map((w) => {
    const both = w.frames.filter((f) => !f.a.paused && !f.b.paused).length;
    return { both, frames: w.frames.length };
  });
  return {
    /**
     * The three claims, answered outright.
     *
     * `bothMoving` exists because its absence is what shipped: a version of
     * this feature dissolved a frozen last frame into the clip arriving and
     * every other measurement here looked perfect while it did. The window ran,
     * the composite never dipped, the stacking was right — and no two clips
     * were ever moving at once. Read this line first.
     */
    verdict: {
      bothMoving: verdicts.length > 0 && verdicts.every((v) => v.both >= v.frames - 2),
      neverDarkens: windows.every((w) => w.frames.every((f) => f.paintedAlpha >= 1)),
      fadesOnBothBoundaries: [...new Set(windows.map((w) => w.fadingIndex))].length === 2,
      incomingNeverMidRise: windows.every((w) =>
        w.frames.every((f) => (w.fadingIndex === 0 ? f.b.opacity : f.a.opacity) === 1),
      ),
    },
    diagnostic: {
      classesSeen: [...new Set(samples.flatMap((s) => [s.a.cls, s.b.cls]))],
      aTimeStart: first?.a.t, aTimeEnd: last?.a.t, aPausedEnd: last?.a.paused,
      bTimeStart: first?.b.t, bTimeEnd: last?.b.t, bPausedEnd: last?.b.paused,
      // How many times the pair of classes changed — one per swap.
      classChanges: samples.reduce((n, s, i) => (i > 0 && (s.a.cls + s.b.cls) !== (samples[i-1].a.cls + samples[i-1].b.cls) ? n + 1 : n), 0),
    },
    totalFrames: samples.length,
    blendFrames: blending.length,
    windowsObserved: windows.length,
    // Which element faded — must include BOTH 0 and 1 across the run, or the
    // alternating-boundary case is untested.
    fadedIndices: [...new Set(windows.map((w) => w.fadingIndex))].sort(),
    windows: windows.map((w) => {
      const first = w.frames[0];
      const last = w.frames[w.frames.length - 1];
      const bothMoving = w.frames.filter((f) => !f.a.paused && !f.b.paused).length;
      return {
        fadingIndex: w.fadingIndex,
        durationMs: last.ms - first.ms,
        frames: w.frames.length,
        framesBothPlaying: bothMoving,
        // Where in the window a paused element sits, as a fraction of the way
        // through: 0 = at the start (incoming had not begun), 1 = at the end
        // (outgoing reached its true end).
        pausedAt: w.frames
          .map((f, i) => ({ at: +(i / Math.max(w.frames.length - 1, 1)).toFixed(2), a: f.a.paused, b: f.b.paused }))
          .filter((x) => x.a || x.b),
        minPaintedAlpha: Math.min(...w.frames.map((f) => f.paintedAlpha)),
        // The element being faded must be the one on top, or the fade is hidden.
        fadingElementOnTop: w.frames.every((f) => {
          const fade = w.fadingIndex === 0 ? f.a : f.b;
          const other = w.fadingIndex === 0 ? f.b : f.a;
          return fade.zIndex > other.zIndex;
        }),
        // The incoming element must arrive opaque, not rise into it.
        incomingOpacities: [...new Set(w.frames.map((f) => (w.fadingIndex === 0 ? f.b.opacity : f.a.opacity)))],
      };
    }),
  };
}

async function measure(page, selector, seconds) {
  const installed = await page.evaluate(RECORD, selector);
  if (installed.error) return installed;
  await wait(seconds * 1000);
  const samples = await page.evaluate(() => window.__blendStop());
  return analyse(samples);
}

async function main() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "hal-blend-"));
  await seed(dataDir, BLEND_MS);
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
  const results = {};
  try {
    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) break;
      } catch {}
      await wait(500);
    }
    for (const [name, route, selector] of [
      ["live", "/live", ".clip-video"],
      ["broadcast", "/broadcast", ".broadcast-video"],
    ]) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await page.goto(`http://127.0.0.1:${PORT}${route}`);
      await page.waitForSelector(selector, { timeout: 20_000 });
      // Let the first clip actually start before recording.
      await wait(2000);
      results[name] = await measure(page, selector, 9);
      await page.close();
    }
  } catch (err) {
    results.error = String(err);
    results.serverLog = log.slice(-2000);
  } finally {
    await browser.close();
    await new Promise((resolve) =>
      process.platform === "win32"
        ? spawn("taskkill", ["/pid", String(server.pid), "/t", "/f"], { stdio: "ignore" }).on("close", resolve)
        : (server.kill("SIGTERM"), resolve()),
    );
  }
  console.log(JSON.stringify(results, null, 2));
}

main();
