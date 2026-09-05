// The overlay's browser verification — U6 of the overlay plan, kept runnable.
//
// jsdom lays nothing out, so the claims that matter about the overlay cannot be
// asserted in the suite: that a slot asked to be 5% of the picture's height *is*
// 5% on the small player and on a 1080p output alike, that the layer sits on
// the letterboxed picture rather than the box around it, and that the words
// stay up while the picture fades. This boots a HAL against a throwaway data
// dir seeded with two synthetic clips of different aspect and two synthetic
// tracks, opens /live and /broadcast in a real browser, and measures.
//
//   npm run build                       # FIRST — the server serves ui/dist
//   node scripts/overlays-check.mjs     # prints the measurements as JSON
//
// Needs ffmpeg on PATH to synthesise the media (nothing is committed), and
// playwright's chromium as scripts/screenshot.mjs does. Output — PNGs,
// results.json and the server log — goes to .screenshots/overlays/ (gitignored).
//
// What to read in the output: every slot's `ratio` (font size over the
// picture's height) must equal its `size` / 100 on both routes and after the
// aspect swap; `picture.h` must equal `expectedPictureHeight`. The fade step is
// best-effort — with two clips alternating across two elements a deleted file
// may never be refetched and so never fault (see the note in
// docs/plans/2026-09-04-002-feat-broadcast-surface-plan.md, U6).
import { chromium } from "playwright";
import { spawn, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const OUT = path.join(REPO, ".screenshots", "overlays");
const PORT = Number(process.env.SHOT_PORT ?? 8131);

function synth(args, file) {
  const result = spawnSync("ffmpeg", ["-y", "-loglevel", "error", ...args, file], { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`ffmpeg failed for ${file}`);
}

async function seed(dataDir) {
  const media = path.join(dataDir, "media");
  await fs.mkdir(media, { recursive: true });
  synth(["-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=25:duration=6", "-pix_fmt", "yuv420p"], path.join(media, "wide.mp4"));
  synth(["-f", "lavfi", "-i", "testsrc2=size=640x480:rate=25:duration=6", "-pix_fmt", "yuv420p"], path.join(media, "square.mp4"));
  synth(["-f", "lavfi", "-i", "sine=frequency=440:duration=20", "-c:a", "libmp3lame"], path.join(media, "one.mp3"));
  synth(["-f", "lavfi", "-i", "sine=frequency=660:duration=20", "-c:a", "libmp3lame"], path.join(media, "two.mp3"));

  const audio = path.join(dataDir, "audio");
  await fs.mkdir(path.join(audio, "tracks"), { recursive: true });
  await fs.mkdir(path.join(audio, "playlists"), { recursive: true });
  for (const name of ["one.mp3", "two.mp3"]) {
    await fs.copyFile(path.join(media, name), path.join(audio, "tracks", name));
  }
  await fs.writeFile(
    path.join(audio, "playlists", "late-set.json"),
    JSON.stringify(
      {
        id: "late-set",
        name: "Late Set",
        header: "Late Set — live from the booth",
        tracks: [
          { path: "tracks/one.mp3", name: "one.mp3", durationMs: 20_000, description: "A slow one to open with" },
          { path: "tracks/two.mp3", name: "two.mp3", durationMs: 20_000 },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
  const world = path.join(dataDir, "worlds", "night-drive");
  await fs.mkdir(path.join(world, "clips"), { recursive: true });
  for (const name of ["wide.mp4", "square.mp4"]) {
    await fs.copyFile(path.join(media, name), path.join(world, "clips", name));
  }
  await fs.writeFile(
    path.join(world, "world.json"),
    JSON.stringify(
      {
        version: 4,
        id: "night-drive",
        name: "Night Drive",
        title: "NIGHT DRIVE",
        playlistId: "late-set",
        defaultStateId: "a",
        states: [
          {
            id: "a",
            name: "loop",
            clips: [
              { clips: [{ path: "clips/wide.mp4", durationMs: 6000 }] },
              { clips: [{ path: "clips/square.mp4", durationMs: 6000 }] },
            ],
            x: 40,
            y: 40,
          },
        ],
        transitions: [],
        parameters: [],
      },
      null,
      2,
    ),
    "utf8",
  );
  await fs.writeFile(path.join(dataDir, "worlds", "last-open.json"), JSON.stringify({ worldId: "night-drive" }), "utf8");
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function measure(page, label) {
  return page.evaluate((label) => {
    const layer = document.querySelector('[data-testid="overlay-layer"]');
    const picture = document.querySelector('[data-testid="overlay-picture"]');
    const slots = Array.from(document.querySelectorAll("[data-overlay-slot]"));
    const front = Array.from(document.querySelectorAll("video")).find((v) => v.className.includes("front"));
    const box = layer?.getBoundingClientRect();
    const pic = picture?.getBoundingClientRect();
    const intrinsic = front && front.videoWidth ? { w: front.videoWidth, h: front.videoHeight } : null;
    const expected = intrinsic && box ? Math.min(box.height, (box.width * intrinsic.h) / intrinsic.w) : box?.height;
    const texts = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = (n.textContent ?? "").trim();
      if (t) texts.push(t);
    }
    return {
      label,
      box: box && { w: Math.round(box.width), h: Math.round(box.height) },
      picture: pic && {
        left: Math.round(pic.left - box.left),
        top: Math.round(pic.top - box.top),
        w: Math.round(pic.width),
        h: Math.round(pic.height),
      },
      intrinsic,
      expectedPictureHeight: expected && Math.round(expected),
      slots: slots.map((s) => {
        const cs = getComputedStyle(s);
        const px = parseFloat(cs.fontSize);
        return {
          index: s.getAttribute("data-overlay-slot"),
          text: s.textContent,
          fontPx: Math.round(px * 100) / 100,
          ratio: pic ? Math.round((px / pic.height) * 10000) / 10000 : null,
          color: cs.color,
          family: cs.fontFamily,
        };
      }),
      faded: document.querySelector('[data-testid="broadcast-stage"]')?.className.includes("faded") ?? null,
      pictureOpacity: (() => {
        const p = document.querySelector('[data-testid="broadcast-picture"]');
        return p ? getComputedStyle(p).opacity : null;
      })(),
      layerOpacity: layer ? getComputedStyle(layer).opacity : null,
      ...(document.querySelector('[data-testid="broadcast-stage"]') ? { texts } : {}),
    };
  }, label);
}

async function main() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "hal-overlays-"));
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
    const enable = live.getByTestId("audio-enable");
    if (await enable.count()) await enable.click().catch(() => {});

    const broadcast = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await broadcast.goto(`http://127.0.0.1:${PORT}/broadcast`);
    await broadcast.waitForSelector('[data-testid="overlay-layer"]', { timeout: 20_000 });

    await wait(4000);
    results.push(await measure(live, "live, first clip"));
    results.push(await measure(broadcast, "broadcast, first clip"));
    await live.screenshot({ path: path.join(OUT, "live-1.png") });
    await broadcast.screenshot({ path: path.join(OUT, "broadcast-1.png") });

    const firstSrc = await broadcast.evaluate(() => document.querySelector("video.front")?.getAttribute("src"));
    for (let i = 0; i < 40; i++) {
      const src = await broadcast.evaluate(() => document.querySelector("video.front")?.getAttribute("src"));
      if (src && src !== firstSrc) break;
      await wait(500);
    }
    await wait(800);
    results.push(await measure(live, "live, after swap"));
    results.push(await measure(broadcast, "broadcast, after swap"));
    await broadcast.screenshot({ path: path.join(OUT, "broadcast-2.png") });

    await live.setViewportSize({ width: 900, height: 700 });
    await live.getByTestId("open-playlists").click();
    await live.getByRole("button", { name: "Late Set" }).first().click();
    await live.waitForSelector('[aria-label="description for one.mp3"]');
    results.push({
      label: "playlist row at 900px",
      rows: await live.evaluate(() =>
        Array.from(document.querySelector('[data-testid="entry-one.mp3"]').children).map((c) => {
          const r = c.getBoundingClientRect();
          return {
            tag: c.tagName,
            label: c.getAttribute("aria-label") ?? c.textContent?.slice(0, 20),
            w: Math.round(r.width),
            h: Math.round(r.height),
            top: Math.round(r.top),
          };
        }),
      ),
    });
    await live.screenshot({ path: path.join(OUT, "live-playlist-900.png"), fullPage: true });

    for (const name of ["wide.mp4", "square.mp4"]) {
      await fs.rename(path.join(dataDir, "worlds", "night-drive", "clips", name), path.join(dataDir, `${name}.gone`));
    }
    for (let i = 0; i < 60; i++) {
      const faded = await broadcast.evaluate(() =>
        document.querySelector('[data-testid="broadcast-stage"]')?.className.includes("faded"),
      );
      if (faded) break;
      await wait(500);
    }
    await wait(1200);
    results.push(await measure(broadcast, "broadcast, after the clips were removed"));
    await broadcast.screenshot({ path: path.join(OUT, "broadcast-faulted.png") });
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
