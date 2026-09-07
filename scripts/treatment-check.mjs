// The browser verification for how a slot's words are treated.
//
// A sibling of `overlays-check.mjs` and `conditions-check.mjs` rather than more
// of either: the World this needs is four slots at one position differing only
// in their treatment, and folding that into a seed built for aspect ratios or
// for state changes would have made every one of them harder to read.
//
// What only a browser can answer. jsdom applies no stylesheet and lays nothing
// out, so a component test can assert that the layer set
// `-webkit-text-stroke-width: 0.04em` — which is an assertion about a string
// this code produced, and says nothing about what an operator sees. Three
// claims need a real engine:
//
//   1. That the properties resolve at all, and to a share of the slot's own
//      type size that is the *same* on `/live` and on `/broadcast`, whose
//      pixel sizes differ by more than three times.
//   2. That the outline sits *outside* the letterform. This is the one the
//      whole design rests on: a stroke centred on the glyph edge and painted
//      over the fill eats inward, so the letters get heavier instead of
//      bordered, and the computed style looks identical either way.
//
//      Measured in *pixels*, because nothing cheaper can see it. A stroke
//      changes no layout metric in any engine — a Range over the text reports
//      the same width stroked or bare, which is a real measurement of the
//      wrong thing. So the word is screenshotted over a flat grey clip, white
//      fill and black stroke, and the white pixels are counted. Painted
//      behind the fill, the letter keeps its shape and its white count;
//      painted over it, the black stroke eats the stem and the white count
//      collapses.
//   3. That a slot asking for no treatment has no treatment property at all,
//      which is the promise that every World written before this draws exactly
//      as it did.
//
// If (2) fails, the fallback is the ring of offsets the old fixed backing drew,
// generated from the same authored numbers — a change inside `outlineCss` in
// `ui/src/textTreatment.ts` and its suite, moving neither the layer nor
// anything stored. This script is what says which of the two is in force.
//
// Needs `ffmpeg` on PATH and playwright's chromium. Run after `npm run build`.

import { spawn, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const OUT = path.join(REPO, ".screenshots", "treatment");
const PORT = Number(process.env.SHOT_PORT ?? 8139);

/** The one word every slot draws, so a width is a comparison and not a reading. */
const WORD = "HHHOOO";

function synth(args, file) {
  const run = spawnSync("ffmpeg", ["-y", "-loglevel", "error", ...args, file], { shell: true });
  if (run.status !== 0) throw new Error(`ffmpeg failed for ${file}: ${run.stderr}`);
}

async function seed(dataDir) {
  const media = path.join(dataDir, "media");
  await fs.mkdir(media, { recursive: true });
  // Flat mid-grey, and not the test pattern the other checks use. The outline
  // claim is settled by counting white and black pixels in a word, and a busy
  // frame carries whites and blacks of its own that no threshold can separate
  // from the letters. A treatment over a plain field is also the honest place
  // to look at one.
  synth(["-f", "lavfi", "-i", "color=c=gray:size=1280x720:rate=25:duration=8", "-pix_fmt", "yuv420p"], path.join(media, "a.mp4"));

  const world = path.join(dataDir, "worlds", "night-drive");
  await fs.mkdir(path.join(world, "clips"), { recursive: true });
  await fs.copyFile(path.join(media, "a.mp4"), path.join(world, "clips", "a.mp4"));

  // One position, one size, one font, one word. Everything that differs between
  // these four is the treatment, which is what makes a width comparison mean
  // something.
  const base = { position: "middle-left", source: "text", text: WORD, font: "Arial", size: 8, color: "#ffffff" };
  await fs.writeFile(
    path.join(world, "world.json"),
    JSON.stringify(
      {
        version: 4,
        id: "night-drive",
        name: "Night Drive",
        title: "NIGHT DRIVE",
        defaultStateId: "a",
        states: [{ id: "a", name: "one", clips: [{ clips: [{ path: "clips/a.mp4", durationMs: 8000 }] }], x: 40, y: 40 }],
        parameters: [],
        transitions: [],
        overlays: [
          // 0: the control. No treatment at all — the R12 measurement, and the
          // bare width every other width is read against.
          { ...base },
          // 1: an outline only. The R3 measurement.
          { ...base, outline: { color: "#000000", width: 8 } },
          // 2: a shadow only, cast down and to the right.
          { ...base, shadow: { color: "#000000", opacity: 90, angle: 135, distance: 6, blur: 4 } },
          // 3: a glow — a shadow at no distance, which is the claim that there
          // is one dial and not a mode.
          { ...base, shadow: { color: "#00ffff", opacity: 100, angle: 0, distance: 0, blur: 30 } },
          // 4: both together, plus the band, so the ordering claim and the
          // plate are drawn where they can be seen.
          { ...base, outline: { color: "#ff0000", width: 5 }, shadow: { color: "#000000", angle: 180, distance: 8, blur: 8 }, band: true },
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

/**
 * Every slot's treatment as the browser resolved it, and its ink.
 *
 * The ink width is measured with a Range over the element's own text node
 * rather than off the element's box: the box is the cell's width and would be
 * the same number for every slot no matter what the stroke did.
 */
function measure(page, label) {
  return page.evaluate(
    ({ label }) => {
      const picture = document.querySelector('[data-testid="overlay-picture"]');
      const pic = picture?.getBoundingClientRect();
      const slots = Array.from(document.querySelectorAll("[data-overlay-slot]")).map((el) => {
        const cs = getComputedStyle(el);
        const fontPx = parseFloat(cs.fontSize);
        const node = el.firstChild;
        let ink = null;
        if (node && node.nodeType === Node.TEXT_NODE) {
          const range = document.createRange();
          range.selectNodeContents(node);
          const r = range.getBoundingClientRect();
          ink = { w: Number(r.width.toFixed(2)), h: Number(r.height.toFixed(2)) };
        }
        const strokePx = parseFloat(cs.webkitTextStrokeWidth) || 0;
        return {
          index: el.getAttribute("data-overlay-slot"),
          text: el.textContent,
          band: el.className.includes("overlay-band"),
          fontPx: Number(fontPx.toFixed(2)),
          textShadow: cs.textShadow === "none" ? null : cs.textShadow,
          strokeWidth: cs.webkitTextStrokeWidth,
          strokeColor: cs.webkitTextStrokeColor,
          paintOrder: cs.paintOrder,
          // The number that must agree across the two surfaces: everything is
          // authored as a share of the type size, so the pixels differ and the
          // share may not.
          strokeShareOfType: fontPx > 0 ? Number(((strokePx / fontPx) * 100).toFixed(2)) : null,
          ink,
        };
      });
      return { label, picture: pic && { w: Math.round(pic.width), h: Math.round(pic.height) }, slots };
    },
    { label },
  );
}

/** What the measurements have to say, as pass or fail, per surface. */
function verdicts(reading) {
  const by = (i) => reading.slots.find((s) => s.index === String(i));
  const control = by(0);
  const outlined = by(1);
  const shadowed = by(2);
  const glow = by(3);
  const out = [];

  out.push({
    claim: "an untreated slot carries no treatment at all",
    ok: control.textShadow === null && (parseFloat(control.strokeWidth) || 0) === 0 && !control.band,
    saw: { textShadow: control.textShadow, strokeWidth: control.strokeWidth },
  });

  out.push({
    claim: "a shadow is cast down and to the right at 135 degrees",
    ok: /(^|\s)([\d.]+)px\s+([\d.]+)px/.test(shadowed.textShadow ?? "") && !/-[\d.]+px/.test(shadowed.textShadow ?? ""),
    saw: shadowed.textShadow,
  });

  out.push({
    claim: "a shadow at distance 0 is a glow with no direction",
    ok: /0px\s+0px/.test(glow.textShadow ?? ""),
    saw: glow.textShadow,
  });

  return out;
}

/**
 * How much white and black is painted inside one slot's box.
 *
 * The screenshot is taken by Playwright and handed *back* to the page to be
 * counted, because Node has no PNG decoder here and the browser has one built
 * in. A `<canvas>` in a blank page reads the pixels; nothing about the page
 * under test is touched.
 */
async function pixels(page, counter, index) {
  const box = await page.locator(`[data-overlay-slot="${index}"]`).boundingBox();
  if (!box) return null;
  const shot = await page.screenshot({
    clip: { x: Math.floor(box.x), y: Math.floor(box.y), width: Math.ceil(box.width), height: Math.ceil(box.height) },
  });
  return counter.evaluate(async (data) => {
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = reject;
      image.src = `data:image/png;base64,${data}`;
    });
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0);
    const { data: px } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let white = 0;
    let black = 0;
    for (let i = 0; i < px.length; i += 4) {
      // Antialiasing puts a fringe on every edge, so these are the cores of
      // white and black rather than their exact values.
      if (px[i] > 200 && px[i + 1] > 200 && px[i + 2] > 200) white += 1;
      else if (px[i] < 55 && px[i + 1] < 55 && px[i + 2] < 55) black += 1;
    }
    return { white, black, w: canvas.width, h: canvas.height };
  }, shot.toString("base64"));
}

async function main() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "hal-treatment-"));
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
  let failed = [];
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

    const onLive = await measure(live, "live");
    const onBroadcast = await measure(broadcast, "broadcast");
    results.push(onLive, onBroadcast);
    await live.screenshot({ path: path.join(OUT, "live.png") });
    await broadcast.screenshot({ path: path.join(OUT, "broadcast.png") });

    for (const reading of [onLive, onBroadcast]) {
      const verdict = { label: reading.label, checks: verdicts(reading) };
      results.push(verdict);
      failed.push(...verdict.checks.filter((c) => !c.ok).map((c) => `${reading.label}: ${c.claim}`));
    }

    // The claim the design rests on, measured on `/broadcast` because the type
    // is five times larger there and the count is that much less about
    // antialiasing. Slot 0 is the same word, same font, same size, no
    // treatment; slot 1 is it with a black border.
    const counter = await browser.newPage();
    const bare = await pixels(broadcast, counter, 0);
    const outlined = await pixels(broadcast, counter, 1);
    const kept = outlined.white / bare.white;
    results.push({
      label: "the outline sits outside the letterform",
      // Painted behind the fill, the letter keeps its shape and very nearly all
      // of its white. Painted over it, an 8%-of-type-size stroke is thicker
      // than the stem and the white collapses — there is no threshold between
      // 0.9 and 0.1 that needs arguing about.
      ok: kept > 0.7 && outlined.black > bare.black,
      bare,
      outlined,
      whiteKept: Number(kept.toFixed(3)),
      paintOrder: onBroadcast.slots[1].paintOrder,
    });
    if (!(kept > 0.7 && outlined.black > bare.black)) {
      failed.push("broadcast: the outline is eating the letterform rather than bordering it");
    }

    // The share of the type size is the number that must agree; the pixels may
    // not, and the picture is more than three times larger on the projector.
    const agree = onLive.slots.map((s, i) => ({
      index: s.index,
      liveFontPx: s.fontPx,
      broadcastFontPx: onBroadcast.slots[i].fontPx,
      liveStrokeShare: s.strokeShareOfType,
      broadcastStrokeShare: onBroadcast.slots[i].strokeShareOfType,
      same: s.strokeShareOfType === onBroadcast.slots[i].strokeShareOfType,
    }));
    results.push({ label: "the same proportions on both surfaces", slots: agree });
    failed.push(...agree.filter((a) => !a.same).map((a) => `slot ${a.index}: stroke share differs between surfaces`));
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
  if (failed.length > 0) {
    console.error(`\n${failed.length} claim(s) failed:\n  ${failed.join("\n  ")}`);
    process.exit(1);
  }
  console.log("\nevery claim held");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
