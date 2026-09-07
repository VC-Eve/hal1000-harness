// The character speaking, verified in a browser — U9 of the speech plan.
//
// jsdom plays no media and lays nothing out, so three of this feature's claims
// are unproven by the suite however green it is:
//
//   * that the soundtrack actually **drops** while a line is spoken and comes
//     back after — the component test asserts an element's `volume` property,
//     which is a number this code set and not a statement about loudness;
//   * that a subtitle is **drawn at a readable size** on both surfaces, sized
//     against the picture rather than the window;
//   * that `/broadcast` shows the spoken line and **nothing else** while it is
//     speaking.
//
//   npm run build                        # FIRST — the server serves ui/dist
//   HAL_VOICE_MODELS_DIR=... node scripts/speech-check.mjs
//
// Needs playwright's chromium and the two Kokoro model files; point
// `HAL_VOICE_MODELS_DIR` at a directory holding them, or let HAL fetch them
// once. Needs ffmpeg for the soundtrack bed only: the transport serves `.flac`
// and `.mp3` and nothing else, so the bed cannot be hand-written — two drafts of
// this fixture used a WAV, were refused by the route, and read as a feature
// failure. The World's clip is still an undecodable placeholder on purpose, because
// what is measured here is level and type size, and neither depends on whether a
// video decodes.
//
// The music level is read with a WebAudio `AnalyserNode` tapped off the
// soundtrack element, not from `element.volume`. Reading the property back would
// only re-assert what the component test already asserts and would say nothing
// about what a room would hear.
//
// What to read in the output:
//   duck.before / duck.during / duck.after   during must be clearly below both
//   duck.ratioDb                             near the configured depth
//   subtitle.live.size / subtitle.broadcast  share of the *picture* height, and
//                                            the two must agree
//   broadcast.unauthorised                   must be []
//   sentences.seen                           one entry per sentence, in order
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")),
  "..",
);
const OUT = path.join(REPO, ".screenshots", "speech");
// A fresh port per run unless one is named. The server is started through `npx`
// and a shell, so on Windows `kill()` reaches the shell and not the node process
// under it — a run that ends badly leaves the port held, and the next run then
// measures the *previous* run's server against the wrong data directory. That
// happened twice while writing this and read as a feature failure both times.
const PORT = Number(process.env.SHOT_PORT ?? 8140 + Math.floor(Math.random() * 400));
const LINE = "I am afraid I cannot do that, Dave. This mission is too important.";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Progress, to stderr, so a run that stalls says where. */
const step = (what) => process.stderr.write(`  .. ${what}
`);

/**
 * A World that captions, and a track to duck.
 *
 * The World carries a `speech` overlay slot: without one no spoken word reaches
 * either surface, which is the opt-in the whole subtitle design rests on. It is
 * placed bottom-centre with a band behind it, which is the arrangement the
 * legibility question is actually about.
 *
 * The track is not decodable and does not need to be — but it does need to
 * *play* for the duck to be visible, so the check drives an oscillator into the
 * element's place if the browser refuses the file. See `probe` below.
 */
async function seed(dataDir) {
  const audio = path.join(dataDir, "audio");
  await fs.mkdir(path.join(audio, "tracks"), { recursive: true });
  await fs.mkdir(path.join(audio, "playlists"), { recursive: true });
  // An mp3, made with ffmpeg. See the note at the top on why it cannot be a WAV.
  // With no music playing there is nothing attending, so every speak is refused —
  // correctly — and every measurement below reads zero for a reason that has
  // nothing to do with the feature.
  await new Promise((done, fail) => {
    const ff = spawn(
      "ffmpeg",
      [
        "-y", "-f", "lavfi", "-i", "sine=frequency=220:duration=20",
        "-c:a", "libmp3lame", "-b:a", "96k",
        path.join(audio, "tracks", "bed.mp3"),
      ],
      { stdio: "ignore" },
    );
    ff.on("close", (code) => (code === 0 ? done() : fail(new Error("ffmpeg could not write the bed"))));
    ff.on("error", fail);
  });
  await fs.writeFile(
    path.join(audio, "playlists", "bed.json"),
    JSON.stringify(
      {
        id: "bed",
        name: "Bed",
        shuffle: false,
        tracks: [{ path: "tracks/bed.mp3", name: "bed.mp3", durationMs: 20_000 }],
      },
      null,
      2,
    ),
    "utf8",
  );

  const worlds = path.join(dataDir, "worlds");
  await fs.mkdir(path.join(worlds, "stage", "clips"), { recursive: true });
  await fs.writeFile(
    path.join(worlds, "stage", "world.json"),
    JSON.stringify(
      {
        version: 4,
        id: "stage",
        name: "Stage",
        playlistId: "bed",
        defaultStateId: "a",
        states: [{ id: "a", name: "hold", clips: [], x: 40, y: 40 }],
        transitions: [],
        overlays: [
          { position: "top-center", source: "title", font: "Georgia", size: 5, color: "#ffffff" },
          {
            position: "bottom-center",
            source: "speech",
            font: "Georgia",
            size: 4.5,
            color: "#ffffff",
            backing: "band",
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
  await fs.writeFile(path.join(worlds, "last-open.json"), JSON.stringify({ worldId: "stage" }), "utf8");
}

/**
 * Tap the soundtrack element and report its RMS on demand.
 *
 * `createMediaElementSource` re-routes the element through the graph, so the
 * analyser hears exactly what the speakers would — including the duck, which is
 * applied as the element's own volume.
 */
const installMeter = (page) =>
  page.evaluate(async () => {
    const audio = document.querySelector('[data-testid="audio-element"]');
    if (!audio) return false;
    const ctx = new AudioContext();
    // Resumed explicitly. A context starts suspended without an activation, and
    // once `createMediaElementSource` re-routes the element its output goes to a
    // graph that is not running — the element plays, the room hears nothing, and
    // the analyser reads a flat zero that looks exactly like a duck that never
    // lifted.
    await ctx.resume();
    const source = ctx.createMediaElementSource(audio);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    analyser.connect(ctx.destination);
    const buf = new Float32Array(analyser.fftSize);
    window.__ctxState = () => ctx.state;
    window.__rms = () => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      return Math.sqrt(sum / buf.length);
    };
    return true;
  });

/** The peak RMS over a window, so a zero-crossing is not read as silence. */
const meter = (page, ms) =>
  page.evaluate(async (duration) => {
    if (typeof window.__rms !== "function") return null;
    let peak = 0;
    const until = performance.now() + duration;
    while (performance.now() < until) {
      peak = Math.max(peak, window.__rms());
      await new Promise((r) => setTimeout(r, 20));
    }
    return peak;
  }, ms);

/** The subtitle's drawn size, as a share of the picture it sits on. */
const subtitle = (page) =>
  page.evaluate(() => {
    const picture = document.querySelector('[data-testid="overlay-picture"]');
    const slots = Array.from(document.querySelectorAll("[data-overlay-slot]"));
    const box = picture?.getBoundingClientRect() ?? null;
    const found = slots
      .map((el) => ({ el, text: (el.textContent ?? "").trim() }))
      .filter((entry) => entry.text.length > 0);
    // The speech slot is the one whose words are not the World's title.
    const speech = found.find((entry) => entry.text !== "Stage") ?? null;
    if (!speech || !box) return { pictureH: box?.height ?? null, text: null };
    const cs = getComputedStyle(speech.el);
    const rect = speech.el.getBoundingClientRect();
    return {
      pictureH: Math.round(box.height),
      text: speech.text,
      fontPx: Math.round(parseFloat(cs.fontSize) * 10) / 10,
      // The claim the `cqh` units make: a share of the picture, not of the
      // window, so /live's small player and a fullscreened /broadcast agree.
      shareOfPicture: Math.round((parseFloat(cs.fontSize) / box.height) * 10000) / 100,
      background: cs.backgroundColor,
      textShadow: cs.textShadow,
      withinPicture:
        rect.left >= box.left - 1 &&
        rect.right <= box.right + 1 &&
        rect.bottom <= box.bottom + 1,
    };
  });

/** Every text node on /broadcast that is not a slot's resolved words. */
const unauthorised = (page) =>
  page.evaluate(() => {
    const root = document.body;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const found = [];
    let node = walker.nextNode();
    while (node) {
      const text = (node.textContent ?? "").trim();
      if (text.length > 0 && !(node.parentElement ?? root).closest("[data-overlay-slot]")) {
        found.push(text);
      }
      node = walker.nextNode();
    }
    return found;
  });

async function main() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "hal-speech-"));
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

  // Autoplay must be allowed, or the element never sounds and every number here
  // is zero for a reason that has nothing to do with the feature.
  const browser = await chromium.launch({
    args: ["--autoplay-policy=no-user-gesture-required"],
  });
  const results = { line: LINE };
  try {
    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) { step('server up'); break; }
      } catch {}
      await wait(500);
    }

    step("opening /live");
    const live = await browser.newPage({ viewport: { width: 1440, height: 950 } });
    await live.goto(`http://127.0.0.1:${PORT}/live`);
    await live.waitForSelector('[data-testid="live-world"]', { timeout: 20_000 });

    step("opening /broadcast");
    const broadcast = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await broadcast.goto(`http://127.0.0.1:${PORT}/broadcast`);
    await broadcast.waitForTimeout(1000);

    results.readiness = await live.evaluate(async () => {
      const res = await fetch("/api/health");
      return res.ok;
    });

    // Start the soundtrack, then tap it.
    step("pressing the sound control");
    // `audio-enable` is the one press that both lifts the browser's gate and
    // starts what is armed. Without it the transport runs unattended, nothing is
    // listening, and every speak is refused — correctly, which is what made the
    // first run of this script read as a feature failure.
    await live.getByTestId("audio-enable").click({ timeout: 10_000 });
    await live.waitForTimeout(1200);
    await live.waitForTimeout(1500);
    step("installing the meter");
    results.meterInstalled = await installMeter(live);
    results.duck = { before: await meter(live, 600) };
    // What the page believes about its own sound. Without this the numbers below
    // are uninterpretable: a zero reads the same whether the duck worked, the
    // browser refused to play, or nothing was ever attending.
    results.sound = await live.evaluate(() => ({
      blocked: document.querySelector('[data-testid="audio-sound-fault"]')?.textContent ?? null,
      unattended: document.querySelector('[data-testid="audio-unattended"]')?.textContent ?? null,
      audible: document.querySelector('[data-testid="audio-audible"]')?.textContent ?? null,
      element: (() => {
        const a = document.querySelector('[data-testid="audio-element"]');
        return a
          ? {
              paused: a.paused,
              volume: Math.round(a.volume * 1000) / 1000,
              currentTime: Math.round(a.currentTime * 10) / 10,
              readyState: a.readyState,
              src: a.getAttribute("src"),
              error: a.error ? `${a.error.code}: ${a.error.message}` : null,
            }
          : null;
      })(),
      contextState: window.__ctxState?.() ?? null,
      enableStillOffered: document.querySelector('[data-testid="audio-enable"]') !== null,
      readonly: document.querySelector('[data-testid="audio-readonly"]')?.textContent ?? null,
    }));

    // Speak, and measure while it is speaking.
    step("typing the line");
    await live.getByTestId("speech-line").fill(LINE);
    await live.getByTestId("speak").click();
    await live.waitForTimeout(2500);

    step("measuring during");
    results.duck.during = await meter(live, 800);
    results.subtitle = { live: await subtitle(live), broadcast: await subtitle(broadcast) };
    results.broadcast = { unauthorised: await unauthorised(broadcast) };
    await live.screenshot({ path: path.join(OUT, "live-speaking.png") });
    await broadcast.screenshot({ path: path.join(OUT, "broadcast-speaking.png") });

    // Collect the sentences as they go by, then measure the level after.
    step("watching subtitles");
    results.sentences = { seen: [] };
    for (let i = 0; i < 30; i++) {
      const now = await broadcast.evaluate(() => {
        const slot = Array.from(document.querySelectorAll("[data-overlay-slot]"))
          .map((el) => (el.textContent ?? "").trim())
          .filter((t) => t.length > 0 && t !== "Stage");
        return slot[0] ?? null;
      });
      if (now && results.sentences.seen.at(-1) !== now) results.sentences.seen.push(now);
      if (!now && results.sentences.seen.length > 0) break;
      await wait(400);
    }

    await live.waitForTimeout(1500);
    results.duck.after = await meter(live, 600);
    const db = (a, b) => (a > 0 && b > 0 ? Math.round(20 * Math.log10(b / a) * 10) / 10 : null);
    results.duck.ratioDb = db(results.duck.before, results.duck.during);
    results.duck.recoveredDb = db(results.duck.before, results.duck.after);

    await broadcast.screenshot({ path: path.join(OUT, "broadcast-after.png") });
  } finally {
    await browser.close();
    await killTree(server.pid);
  }

  results.serverLogTail = log.split("\n").slice(-6).join("\n");
  console.log(JSON.stringify(results, null, 2));
  console.log(`\nscreenshots in ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * Kill the server and everything under it.
 *
 * `spawn` with `shell: true` gives back the shell's pid, and `npx` starts node
 * beneath that, so killing the returned pid leaves the listener running and the
 * port held. `taskkill /T` walks the tree; the POSIX branch kills the group.
 */
async function killTree(pid) {
  if (!pid) return;
  await new Promise((done) => {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" }).on("close", done);
      return;
    }
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    done();
  });
}
