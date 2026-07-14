// Automated smoke suite — drives the real editor in headless Chrome.
// Run: `npm run smoke` (spawns its own Vite on :5199, so it never collides
// with a dev server you have open, and uses a fresh browser profile, so
// your localStorage autosave is untouched).
// Reuse a server you already have running with: SMOKE_URL=http://localhost:5174 npm run smoke
//
// This is a smoke suite, not unit tests: assertions are deliberately loose
// (counts went up / went down / went to zero) so UI polish doesn't break it.
// Uses your installed Chrome (channel: "chrome") — no browser download.

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PORT = 5199;
const URL = process.env.SMOKE_URL || `http://localhost:${PORT}`;

// Tiny deterministic 8x8 PNG (left half red, right half blue) for the Image
// import checks below — generated once via an offscreen canvas, inlined so
// the suite has no runtime image-generation dependency.
const TEST_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAIUlEQVR4AdyKsQkAAAyDJP//bNfSpXsEB8EIbk8aHjqGAQAA///STYkeAAAABklEQVQDAGvBEAH37cXcAAAAAElFTkSuQmCC";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "  ok " : "FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
}

function waitForServer(url, timeoutMs = 30000) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      http.get(url, (res) => { res.resume(); resolve(); })
        .on("error", () => {
          if (Date.now() - t0 > timeoutMs) reject(new Error(`server not up at ${url}`));
          else setTimeout(poll, 300);
        });
    };
    poll();
  });
}

let vite = null;
if (!process.env.SMOKE_URL) {
  vite = spawn(`npx vite --port ${PORT} --strictPort`, {
    cwd: ROOT,
    shell: true,
    stdio: "ignore",
  });
}

try {
  await waitForServer(URL);

  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  await page.goto(URL, { waitUntil: "networkidle" });
  await page.waitForSelector("svg");
  await page.waitForTimeout(600);

  // The canvas svg is the one carrying the grid <line>s; toolbar icons are svgs too.
  // Park the mouse over the left panel first — hover ghosts, snap halos, and
  // tool cursors are also svg circles and would pollute the count.
  const countDots = async () => {
    await page.mouse.move(130, 850);
    await page.waitForTimeout(120);
    return page.evaluate(() => {
      const svgs = [...document.querySelectorAll("svg")];
      const canvas = svgs.sort((a, b) => b.querySelectorAll("line").length - a.querySelectorAll("line").length)[0];
      return canvas ? canvas.querySelectorAll("circle, g > rect[rx]").length : -1;
    });
  };

  const cx = 700, cy = 450;

  // 1 — boot: fresh profile means a fresh document
  check("boot: canvas renders, no dots", (await countDots()) === 0);

  // 2 — draw tool
  await page.keyboard.press("b");
  for (const [dx, dy] of [[0, 0], [40, 0], [80, 0], [0, 40], [40, 40]]) {
    await page.mouse.click(cx + dx, cy + dy);
    await page.waitForTimeout(50);
  }
  const drawn = await countDots();
  check("draw: 5 clicks place 5 dots", drawn === 5, `got ${drawn}`);

  // 3 — marquee select + Delete
  await page.keyboard.press("v");
  await page.mouse.move(cx - 120, cy - 120);
  await page.mouse.down();
  await page.mouse.move(cx + 160, cy + 160, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  await page.keyboard.press("Delete");
  await page.waitForTimeout(200);
  check("select+delete: dots removed", (await countDots()) === 0);

  // 4 — undo brings them back, redo removes again
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(200);
  check("undo: dots restored", (await countDots()) === 5, `got ${await countDots()}`);
  await page.keyboard.press("Control+y");
  await page.waitForTimeout(200);
  check("redo: dots removed again", (await countDots()) === 0);

  // 5 — line tool: drag places a row
  await page.keyboard.press("l");
  await page.mouse.move(cx - 100, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 100, cy, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  const afterLine = await countDots();
  check("line: drag places a row", afterLine >= 2, `got ${afterLine}`);

  // 6 — pen tool: 3 anchors + Enter commits a path
  await page.keyboard.press("p");
  await page.mouse.click(cx - 80, cy + 80);
  await page.mouse.click(cx, cy + 120);
  await page.mouse.click(cx + 80, cy + 80);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  const afterPen = await countDots();
  check("pen: 3-anchor path commits", afterPen > afterLine, `${afterLine} -> ${afterPen}`);

  // 7 — shape tool: drag a filled/outline shape
  await page.keyboard.press("s");
  await page.mouse.move(cx - 60, cy - 100);
  await page.mouse.down();
  await page.mouse.move(cx + 60, cy - 40, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  const afterShape = await countDots();
  check("shape: drag places a shape", afterShape > afterPen, `${afterPen} -> ${afterShape}`);

  // 8 — array tool: select all, A, Apply multiplies the motif
  await page.keyboard.press("Control+a");
  await page.waitForTimeout(100);
  await page.keyboard.press("a");
  await page.waitForTimeout(200);
  const applyBtn = page.getByRole("button", { name: /^apply/i }).first();
  let afterArray = afterShape;
  if (await applyBtn.count()) {
    await applyBtn.click();
    await page.waitForTimeout(300);
    afterArray = await countDots();
    check("array: apply multiplies motif", afterArray > afterShape, `${afterShape} -> ${afterArray}`);
  } else {
    check("array: apply multiplies motif", false, "Apply button not found");
  }

  // All placed dots must sit inside the canvas (edges inclusive). The canvas
  // svg's first <rect> is the background = the canvas bounds in world coords.
  const outOfBoundsCount = () =>
    page.evaluate(() => {
      const svgs = [...document.querySelectorAll("svg")];
      const canvas = svgs.sort((a, b) => b.querySelectorAll("line").length - a.querySelectorAll("line").length)[0];
      if (!canvas) return -1;
      const bg = canvas.querySelector("rect");
      const w = Number(bg?.getAttribute("width")), h = Number(bg?.getAttribute("height"));
      let out = 0;
      for (const c of canvas.querySelectorAll("circle")) {
        const x = Number(c.getAttribute("cx")), y = Number(c.getAttribute("cy"));
        if (x < -0.01 || x > w + 0.01 || y < -0.01 || y > h + 0.01) out++;
      }
      return out;
    });
  check("bounds: array never places outside the canvas", (await outOfBoundsCount()) === 0,
    `${await outOfBoundsCount()} circles out of bounds`);

  // Dragging a selection past the edge must stop flush at the wall. The drag
  // must start ON a dot (else it's a marquee), so compute a real dot's screen
  // position from its world coords via the SVG's screen transform.
  await page.keyboard.press("Control+a");
  const dragFrom = await page.evaluate(() => {
    const svgs = [...document.querySelectorAll("svg")];
    const canvas = svgs.sort((a, b) => b.querySelectorAll("line").length - a.querySelectorAll("line").length)[0];
    const c = canvas?.querySelector("circle");
    if (!c) return null;
    const m = c.getScreenCTM();
    const x = Number(c.getAttribute("cx")), y = Number(c.getAttribute("cy"));
    return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
  });
  await page.mouse.move(dragFrom.x, dragFrom.y);
  await page.mouse.down();
  await page.mouse.move(dragFrom.x + 600, dragFrom.y + 400, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  check("bounds: drag-move stops at the canvas edge", (await outOfBoundsCount()) === 0,
    `${await outOfBoundsCount()} circles out of bounds after drag`);
  await page.keyboard.press("Control+z"); // put the selection back for the erase step
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);

  // 9 — eraser removes along a stroke
  await page.keyboard.press("e");
  await page.mouse.move(cx - 150, cy - 150);
  await page.mouse.down();
  await page.mouse.move(cx + 200, cy + 200, { steps: 20 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  const afterErase = await countDots();
  check("erase: stroke removes dots", afterErase < afterArray, `${afterArray} -> ${afterErase}`);

  // 10 — layers: add a layer, draw on it, delete it — its dots go with it.
  // Escape first: selection rings are also <circle>s, so the baseline must be
  // taken with nothing selected or clearing selection skews the deltas.
  await page.keyboard.press("Escape");
  const preLayers = await countDots();
  await page.locator('button[title="Layers"]').click();
  await page.locator('button[title="New layer"]').click();
  await page.keyboard.press("b");
  await page.mouse.click(cx - 200, cy - 200);
  await page.mouse.click(cx - 200, cy - 160);
  const withLayer2 = await countDots();
  check("layers: new layer accepts dots", withLayer2 === preLayers + 2, `${preLayers} -> ${withLayer2}`);
  // One "Delete" button per layer row; the panel reverses the stack so the
  // new (topmost) layer's row renders first. Deleting it must remove only
  // its own dots.
  await page.locator('button[title="Delete"]').first().click();
  const afterLayerDelete = await countDots();
  check("layers: deleting the layer removes its dots only", afterLayerDelete === preLayers, `${withLayer2} -> ${afterLayerDelete}`);
  await page.locator('button[title="Layers"]').click();

  // 11 — SVG export triggers a download
  const dl = page.waitForEvent("download", { timeout: 5000 }).catch(() => null);
  await page.getByRole("button", { name: /^svg$/i }).first().click();
  const download = await dl;
  check("export: SVG download fires", !!download && /\.svg$/i.test(download.suggestedFilename()),
    download ? download.suggestedFilename() : "no download event");

  // 12 — Image import: palette quantization, Colors slider, explicit canvas
  // size, commit + undo. Clipboard-paste is NOT covered here — injecting a
  // real image onto the OS/browser clipboard is unreliable headlessly; that
  // path is a manual-only check (see CONTRIBUTING.md / ARCHITECTURE.md).
  await page.keyboard.press("Escape"); // clear selection — rings are <circle>s too
  const beforeImport = await countDots();

  await page.getByRole("button", { name: /^image$/i }).first().click();
  await page.waitForTimeout(150);
  const importModal = page.locator("div.dotart", { has: page.getByText("Import Image") }).last();
  check("image import: modal opens", await importModal.isVisible());

  await importModal.locator('input[type=file]').setInputFiles({
    name: "smoke-test.png", mimeType: "image/png", buffer: Buffer.from(TEST_PNG_B64, "base64"),
  });
  await page.waitForTimeout(400);
  const previewVisible = await importModal.locator("canvas").first().isVisible().catch(() => false);
  check("image import: preview canvas appears after choosing a file", previewVisible);

  const swatchCount = () => importModal.locator('div[title$="dots"]').count();
  const swatchesAtDefault = await swatchCount();
  check("image import: palette swatches render (red/blue test image)", swatchesAtDefault >= 2 && swatchesAtDefault <= 8,
    `${swatchesAtDefault} swatches`);

  // Select the Colors slider by its accessible label rather than a positional
  // index — the modal groups controls into Style/Appearance/Canvas sections,
  // and Colors' position among the modal's other range inputs can shift as
  // that layout changes (it currently sits ahead of Dot size/Density/Min.
  // Spacing under "Style", not after them).
  const colorsSlider = importModal.locator('input[type=range][aria-label="Colors"]');
  await colorsSlider.fill("2");
  await page.waitForTimeout(250);
  const swatchesAt2 = await swatchCount();
  check("image import: Colors=2 caps the palette at <=2 swatches", swatchesAt2 <= 2, `${swatchesAt2} swatches`);

  // Explicit canvas size: set W/H to 10x10 and commit via blur. The modal's
  // only type=number inputs are the Canvas-size W/H pair, in that DOM order.
  const sizeInputs = importModal.locator("input[type=number]");
  await sizeInputs.nth(0).fill("10"); await sizeInputs.nth(0).blur();
  await sizeInputs.nth(1).fill("10"); await sizeInputs.nth(1).blur();
  await page.waitForTimeout(200);

  await importModal.getByRole("button", { name: /^add to canvas$/i }).click();
  await page.waitForTimeout(300);
  const afterImport = await countDots();
  check("image import: Add to canvas commits a non-empty grid", afterImport > 0, `${afterImport} dots`);

  const liveWAfterImport = await page.locator('input[type=number]').first().inputValue();
  check("image import: real canvas W reflects the committed size", liveWAfterImport === "10", `W=${liveWAfterImport}`);

  await page.keyboard.press("Control+z");
  await page.waitForTimeout(200);
  const afterUndo = await countDots();
  check("image import: Ctrl+Z returns dot count to pre-import", afterUndo === beforeImport, `${beforeImport} -> ${afterImport} -> ${afterUndo}`);

  check("no uncaught page errors", pageErrors.length === 0, pageErrors.join("; "));

  await browser.close();
} finally {
  if (vite) {
    // Windows: kill the whole tree, vite spawns esbuild children.
    spawn("taskkill", ["/pid", String(vite.pid), "/T", "/F"], { shell: true, stdio: "ignore" });
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
