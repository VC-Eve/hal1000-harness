// The `/live` layout's browser verification — U5 of the layout plan, kept runnable.
//
// jsdom lays nothing out, so every claim this feature makes about *room* is
// unproven by the suite: that hiding the video actually hands the column to the
// playlist, that exactly one thing in that column scrolls, that the sidebar's
// sections are told apart by a drawn border, and that `display: contents` really
// does put the canvas and the sidebar into the body's grid. A screenshot cannot
// be diffed on a width either, so this measures and prints numbers.
//
//   npm run build                          # FIRST — the server serves ui/dist
//   node scripts/live-layout-check.mjs     # prints the measurements as JSON
//
// Its own script rather than a fold-in: `overlays-check.mjs` synthesises its
// media through ffmpeg and throws when that fails, and nothing here needs media
// at all — the seed writes undecodable placeholder files on purpose, exactly as
// the `live-playlist` screenshot scene does. Needs playwright's chromium.
// Output goes to .screenshots/live-layout/ (gitignored).
//
// What to read in the output:
//   tracks.videoOff        five tracks, not three — the two seams are grid items
//   tracks.inlineGrid      must be "" — an inline grid beats the stylesheet
//   playlist.videoOff.h    must be well above playlist.videoOn.h
//   playlist.*.scrollers   must be 1 with the video off; siblings count, not
//                          only ancestors
//   sidebar.cards[].border every section carries one
//   graph.gridParent       "live-body" for both the canvas and the sidebar
//   graph.runFirstStyled   the eight `.state-graph` descendant rules still match
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const OUT = path.join(REPO, ".screenshots", "live-layout");
const PORT = Number(process.env.SHOT_PORT ?? 8132);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A World with a fault in it, and a playlist long enough to overflow.
 *
 * The tracks are not decodable, deliberately: the browser refuses them and says
 * so, which is honest — what is being measured here is the height of a list of
 * rows, and a row's height does not depend on whether its file decodes.
 *
 * The World holds one State whose clip is missing, which is what raises a
 * report — the sidebar needs at least one problem for the group to exist.
 */
async function seed(dataDir) {
  const audio = path.join(dataDir, "audio");
  await fs.mkdir(path.join(audio, "tracks"), { recursive: true });
  await fs.mkdir(path.join(audio, "playlists"), { recursive: true });
  const tracks = Array.from({ length: 24 }, (_, i) => `track-${String(i + 1).padStart(2, "0")}.flac`);
  for (const name of tracks) await fs.writeFile(path.join(audio, "tracks", name), "not really audio", "utf8");
  await fs.writeFile(
    path.join(audio, "playlists", "long-set.json"),
    JSON.stringify(
      {
        id: "long-set",
        name: "Long Set",
        shuffle: false,
        tracks: tracks.map((name, i) => ({ path: `tracks/${name}`, name, durationMs: 300_000 + i * 1_000 })),
      },
      null,
      2,
    ),
    "utf8",
  );

  const worlds = path.join(dataDir, "worlds");
  await fs.mkdir(path.join(worlds, "dancefloor", "clips"), { recursive: true });
  await fs.writeFile(
    path.join(worlds, "dancefloor", "world.json"),
    JSON.stringify(
      {
        version: 4,
        id: "dancefloor",
        name: "Dancefloor",
        playlistId: "long-set",
        defaultStateId: "a",
        states: [{ id: "a", name: "hold", clips: [], x: 40, y: 40 }],
        transitions: [],
        parameters: [{ name: "swing", type: "int", defaultValue: 0, min: 2, max: 0 }],
        effects: [{ parameter: "gone", op: "add", operand: 1, intervalMs: 2000 }],
      },
      null,
      2,
    ),
    "utf8",
  );
  await fs.writeFile(path.join(worlds, "last-open.json"), JSON.stringify({ worldId: "dancefloor" }), "utf8");
}

/** Everything the page can answer about the column and the sidebar. */
const measure = (page) =>
  page.evaluate(() => {
    const round = (n) => Math.round(n);
    const scrolls = (el) => {
      const overflow = getComputedStyle(el).overflowY;
      return (overflow === "auto" || overflow === "scroll") && el.scrollHeight > el.clientHeight + 1;
    };
    const body = document.querySelector(".live-body");
    const stage = document.querySelector('[data-testid="live-stage"]');
    const list = document.querySelector(".playlist-tracks");
    const canvas = document.querySelector(".graph-canvas");
    const side = document.querySelector(".graph-side");
    const run = document.querySelector(".clip-set li.in-run.run-first");

    return {
      tracks: {
        // Read back from the browser, so this is what grid actually resolved —
        // five entries means the two seams got tracks of their own.
        resolved: body ? getComputedStyle(body).gridTemplateColumns : null,
        count: body ? getComputedStyle(body).gridTemplateColumns.split(/\s+/).length : 0,
        inlineGrid: body ? body.style.gridTemplateColumns : null,
        property: body ? body.style.getPropertyValue("--live-cols") : null,
      },
      playlist: list
        ? {
            h: round(list.getBoundingClientRect().height),
            clientH: list.clientHeight,
            scrollH: list.scrollHeight,
            overflows: list.scrollHeight > list.clientHeight + 1,
            // Counted across the whole column, not up the ancestor chain: two
            // uncapped `overflow-y: auto` siblings is the failure this guards,
            // and a sibling is invisible to an ancestor walk.
            scrollers: stage
              ? [stage, ...Array.from(stage.querySelectorAll("*"))]
                  .filter(scrolls)
                  .map((el) => el.dataset.testid ?? el.className)
              : null,
            // The chain from the column to the list, so a height that did not
            // arrive can be traced to the box that kept it.
            chain: stage
              ? [stage, ...Array.from(stage.children)].map((el) => ({
                  what: el.dataset.testid ?? el.className,
                  h: round(el.getBoundingClientRect().height),
                  flex: getComputedStyle(el).flex,
                  minH: getComputedStyle(el).minHeight,
                  overflowY: getComputedStyle(el).overflowY,
                }))
              : null,
            editor: (() => {
              const ed = document.querySelector(".playlist-editor");
              if (!ed) return null;
              return {
                h: round(ed.getBoundingClientRect().height),
                flex: getComputedStyle(ed).flex,
                children: Array.from(ed.children).map((el) => ({
                  what: el.dataset.testid ?? el.className,
                  h: round(el.getBoundingClientRect().height),
                  flex: getComputedStyle(el).flex,
                  maxH: getComputedStyle(el).maxHeight,
                })),
              };
            })(),
          }
        : null,
      // Upward from the column, because a height that never arrived was kept by
      // one of these boxes and the chain says which.
      ancestors: stage
        ? (() => {
            const out = [];
            for (let el = stage; el && el !== document.body; el = el.parentElement) {
              const cs = getComputedStyle(el);
              out.push({
                what: el.dataset.testid ?? (el.className || el.tagName),
                h: round(el.getBoundingClientRect().height),
                display: cs.display,
                flex: cs.flex,
                alignItems: cs.alignItems,
                gridRows: cs.gridTemplateRows,
              });
            }
            return out;
          })()
        : null,
      pane: Array.from(document.querySelector(".live-pane")?.children ?? []).map((el) => ({
        what: el.dataset.testid ?? (el.className || el.tagName),
        h: round(el.getBoundingClientRect().height),
        parts: Array.from(el.children ?? [])
          .map((c) => `${c.dataset.testid ?? (c.className || c.tagName)}:${round(c.getBoundingClientRect().height)}`)
          .join(" "),
      })),
      player: {
        present: document.querySelector('[data-testid="clip-player"]') !== null,
        stageClass: stage ? stage.className : null,
      },
      sidebar: {
        cards: Array.from(document.querySelectorAll(".graph-side > section")).map((s) => {
          const cs = getComputedStyle(s);
          return {
            testid: s.dataset.testid ?? s.className,
            border: `${cs.borderTopWidth} ${cs.borderTopStyle}`,
            padding: cs.paddingTop,
          };
        }),
        problems: document.querySelector('[data-testid="toggle-problems"]')?.textContent ?? null,
        // Collapsed with `hidden`, so a report must be out of the layout, not
        // merely small.
        reportBoxed: document.querySelector('[data-testid="dangling-effects"]')?.getBoundingClientRect().height ?? null,
      },
      graph: {
        // `display: contents` means these two are laid out by `.live-body`.
        gridParent: {
          canvas: canvas?.parentElement?.className ?? null,
          side: side?.parentElement?.className ?? null,
        },
        wrapperDisplay: document.querySelector(".state-graph")
          ? getComputedStyle(document.querySelector(".state-graph")).display
          : null,
        canvasW: canvas ? round(canvas.getBoundingClientRect().width) : null,
        sideW: side ? round(side.getBoundingClientRect().width) : null,
        // One of the eight rules that would have stopped matching had the
        // wrapper been replaced by a fragment.
        runFirstStyled: run ? getComputedStyle(run).borderTopLeftRadius : null,
      },
    };
  });

async function main() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "hal-live-layout-"));
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
  const results = {};
  try {
    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) break;
      } catch {}
      await wait(500);
    }

    const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
    await page.goto(`http://127.0.0.1:${PORT}/live`);
    await page.waitForSelector('[data-testid="live-world"]', { timeout: 20_000 });
    await page.getByTestId("open-playlists").click();
    await page.getByRole("button", { name: "Long Set" }).first().click();
    await page.waitForSelector(".playlist-tracks");

    results.videoOn = await measure(page);
    await page.screenshot({ path: path.join(OUT, "live-video-on.png") });

    await page.getByTestId("toggle-video").click();
    await page.waitForTimeout(300);
    results.videoOff = await measure(page);
    await page.screenshot({ path: path.join(OUT, "live-video-off.png") });

    // The sidebar's group, opened, so the reports can be seen to be cards'
    // contents rather than cards of their own.
    const toggle = page.getByTestId("toggle-problems");
    if (await toggle.count()) {
      await toggle.click();
      await page.waitForTimeout(200);
      results.problemsOpen = (await measure(page)).sidebar;
      await page.screenshot({ path: path.join(OUT, "live-problems-open.png") });
    }

    // A drag on the stage seam, and the same drag back. The second reading must
    // return the first: a seam pushed aside on the way out recovers on the way
    // back, which is the reversibility the suite asserts in numbers and this
    // confirms against a real grid.
    const bar = page.getByTestId("live-divider-stage");
    const box = await bar.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 400, box.y + box.height / 2, { steps: 12 });
    results.dragged = (await measure(page)).tracks;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    results.draggedBack = (await measure(page)).tracks;
    await page.screenshot({ path: path.join(OUT, "live-dragged.png") });

    // The claim that matters is not one number but that the list now *scales*.
    // Capped, it was 260px in a 950px window and 260px in a 1400px one; the cap
    // is what made a long playlist a small sliding window regardless of screen.
    await page.setViewportSize({ width: 1440, height: 1400 });
    await page.waitForTimeout(300);
    results.tallVideoOff = await measure(page);
    await page.getByTestId("toggle-video").click();
    await page.waitForTimeout(300);
    results.tallVideoOn = await measure(page);
    await page.getByTestId("toggle-video").click();
    await page.waitForTimeout(300);

    await page.setViewportSize({ width: 900, height: 800 });
    await page.waitForTimeout(300);
    results.narrow = await measure(page);
    await page.screenshot({ path: path.join(OUT, "live-900.png"), fullPage: true });
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

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
