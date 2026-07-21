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

  // Reads dot state via the dev-only __tangaliyaTest hook (src/app/components/
  // DotArtTool.tsx) instead of counting SVG <circle>/<rect> DOM nodes — keeps
  // this suite decoupled from the render layer, which the planned Canvas2D
  // rewrite will change (dots stop being DOM nodes at all). Still parks the
  // mouse off-canvas first: unrelated to counting now, but avoids a stray
  // hover ring in the [data-selection-overlay] checks elsewhere in this file.
  const countDots = async () => {
    await page.mouse.move(130, 850);
    await page.waitForTimeout(120);
    return page.evaluate(() => window.__tangaliyaTest.count());
  };

  const cx = 700, cy = 450;

  const homeTileCount = () => page.locator("[data-project-tile]").count();
  const createNewBtn = () => page.getByRole("button", { name: /create new/i });

  // 1 — boot: fresh profile means a fresh document, AND — since Home now
  // shows on cold opens (a fresh session, no sessionStorage flag yet) — it's
  // the first thing on screen, before any interaction. Home screen checks
  // run here while the document is still blank and the library still empty
  // (a fresh profile has no AUTOSAVE_KEY, so the one-time migration bails
  // without creating an entry) — keeps the tile-count assertions below exact
  // instead of coupled to dot counts built up by the rest of the suite.
  check("boot: canvas renders, no dots", (await countDots()) === 0);
  check("boot: Home shows on cold open", await createNewBtn().first().isVisible());
  check("home: no tiles on a fresh, untouched document", (await homeTileCount()) === 0, `${await homeTileCount()} tiles`);

  await createNewBtn().first().click();
  await page.waitForTimeout(200);
  check("home: Create New closes Home", !(await createNewBtn().first().isVisible().catch(() => false)));
  check("home: Create New leaves a blank canvas", (await countDots()) === 0);

  // Draw a couple of dots so the file round-trip below is meaningful.
  await page.keyboard.press("b");
  await page.mouse.click(cx, cy);
  await page.mouse.click(cx + 40, cy);
  await page.waitForTimeout(100);
  const dotsForHomeTest = await countDots();

  // Save to disk from the editor (Home is closed) — this also flushes the
  // active project to the library, and the saved file feeds the "Open from
  // file" round-trip further down.
  const saveDl = page.waitForEvent("download", { timeout: 5000 }).catch(() => null);
  await page.locator('button[title="Download an editable project file"]').click();
  const savedDownload = await saveDl;
  const savedPath = savedDownload ? await savedDownload.path() : null;
  check("home: Save Project triggers a download", !!savedPath);

  await page.locator('button[title="Home"]').click();
  await page.waitForTimeout(300);
  check("home: the flushed project shows one tile", (await homeTileCount()) === 1, `${await homeTileCount()} tiles`);
  // Names are now auto-generated (Indian flower names, randomly picked) rather
  // than a fixed "Untitled" string — just confirm it got a real, non-empty name.
  const newTileName = await page.locator("[data-project-tile] .truncate").first().innerText();
  check("home: new tile gets an auto-generated name", newTileName.trim().length > 0, newTileName);

  // Rename
  await page.locator('[data-project-tile] button[title="Rename"]').first().click();
  await page.locator('[data-project-tile] input').first().fill("My Pattern");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(150);
  check("home: rename updates the tile name",
    (await page.locator("[data-project-tile]").first().innerText()).includes("My Pattern"));

  // Duplicate
  await page.locator('[data-project-tile] button[title="Duplicate"]').first().click();
  await page.waitForTimeout(150);
  check("home: duplicate adds a tile", (await homeTileCount()) === 2, `${await homeTileCount()} tiles`);

  // Search filters, then clears
  await page.locator('input[placeholder="Search projects"]').fill("zzz-no-match");
  await page.waitForTimeout(150);
  check("home: search filters out non-matching tiles", (await homeTileCount()) === 0, `${await homeTileCount()} tiles`);
  await page.locator('input[placeholder="Search projects"]').fill("");
  await page.waitForTimeout(150);
  check("home: clearing search restores tiles", (await homeTileCount()) === 2, `${await homeTileCount()} tiles`);

  // Grid/list toggle — structural only, matching the suite's loose-assertion style.
  await page.locator('button[title="List view"]').click();
  await page.waitForTimeout(150);
  check("home: list view renders without error", (await homeTileCount()) === 2, `${await homeTileCount()} tiles`);
  await page.locator('button[title="Grid view"]').click();
  await page.waitForTimeout(150);

  // "Open from file" round-trip — feeds back the file saved above through
  // Home's OWN hidden input (data-home-file-input, distinct from the editor's
  // own "Open" input which is also in the DOM while Home is open) and checks
  // it both loads AND registers a new library tile.
  if (savedPath) {
    await page.locator('input[data-home-file-input]').setInputFiles(savedPath);
    await page.waitForTimeout(300);
    check("home: Open from file closes Home", !(await createNewBtn().first().isVisible().catch(() => false)));
    check("home: Open from file restores the saved dots", (await countDots()) === dotsForHomeTest, `${await countDots()}`);

    await page.locator('button[title="Home"]').click();
    await page.waitForTimeout(300);
    check("home: Open from file registers a new tile", (await homeTileCount()) === 3, `${await homeTileCount()} tiles`);
  } else {
    check("home: Open from file closes Home", false, "skipped — no saved file");
    check("home: Open from file restores the saved dots", false, "skipped — no saved file");
    check("home: Open from file registers a new tile", false, "skipped — no saved file");
  }

  // Delete
  const beforeDelete = await homeTileCount();
  await page.locator('[data-project-tile] button[title="Delete"]').first().click();
  await page.waitForTimeout(150);
  check("home: delete removes a tile", (await homeTileCount()) === beforeDelete - 1, `${beforeDelete} -> ${await homeTileCount()}`);

  // Escape closes Home without touching the canvas
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  check("home: Escape closes Home", !(await createNewBtn().first().isVisible().catch(() => false)));
  check("home: canvas untouched after closing Home", (await countDots()) === dotsForHomeTest, `${await countDots()}`);

  // Reset to a genuinely fresh boot — the rest of this suite assumes a
  // pristine document AND the exact view fit/pan/zoom a first boot produces,
  // and relies on fixed screen coordinates (`cx`/`cy`) for every subsequent
  // click. Re-creating a blank document in-app (Create New + Fit to view)
  // gets the DOTS right but does not reliably reproduce the same pan/zoom as
  // a true first boot — clearing storage and reloading sidesteps that
  // entirely instead of chasing the discrepancy.
  await page.evaluate(() => { try { localStorage.clear(); } catch { /* ignore */ } });
  await page.evaluate(() => new Promise((resolve) => {
    const req = indexedDB.deleteDatabase("tangaliya-projects");
    req.onsuccess = () => resolve(); req.onerror = () => resolve(); req.onblocked = () => resolve();
  }));
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector("svg");
  await page.waitForTimeout(600);
  check("home: reload after Home tests restores a blank, pristine boot", (await countDots()) === 0);
  // sessionStorage (unlike localStorage/IndexedDB, both cleared above) survives
  // a same-page reload, and Home was already dismissed once earlier in this
  // session (the very first Create New click) — so this reload must land
  // straight in the editor, not back on Home.
  check("boot: same-session reload skips Home", !(await createNewBtn().first().isVisible().catch(() => false)));

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

  // SelectionOverlay regression guard — the data-selection-overlay marker
  // scopes this unambiguously, replacing the old clear-then-diff workaround
  // (rings live in their own <g> now, not mixed into DotLayer's dot circles).
  const overlayRingCount = await page.evaluate(
    () => document.querySelectorAll("[data-selection-overlay] circle").length
  );
  check("selection: SelectionOverlay renders one ring per selected dot", overlayRingCount === 5, `${overlayRingCount} rings`);

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

  // All placed dots must sit inside the canvas (edges inclusive).
  const outOfBoundsCount = () =>
    page.evaluate(() => {
      const { w, h } = window.__tangaliyaTest.canvasBounds();
      let out = 0;
      for (const d of window.__tangaliyaTest.dots()) {
        if (d.x < -0.01 || d.x > w + 0.01 || d.y < -0.01 || d.y > h + 0.01) out++;
      }
      return out;
    });
  check("bounds: array never places outside the canvas", (await outOfBoundsCount()) === 0,
    `${await outOfBoundsCount()} circles out of bounds`);

  // Dragging a selection past the edge must stop flush at the wall. The drag
  // must start ON a dot (else it's a marquee), so read a real dot's screen
  // position via the test hook (world coords through the live pan/zoom/rot).
  await page.keyboard.press("Control+a");
  const dragFrom = await page.evaluate(() => window.__tangaliyaTest.dotScreenPos(0));
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
  await page.getByRole("button", { name: /^export svg$/i }).first().click();
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

  // Clearing the session flag (not localStorage/IndexedDB this time) and
  // reloading simulates a genuinely new tab — pins the actual new gating
  // behavior end to end, distinct from the "reload skips Home" check above.
  await page.evaluate(() => { try { sessionStorage.clear(); } catch { /* ignore */ } });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector("svg");
  await page.waitForTimeout(600);
  check("boot: clearing the session flag brings Home back on reload", await createNewBtn().first().isVisible());

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
