// Perf regression script for two related large-canvas freezes, both fixed
// 2026-07-15 (see CLAUDE.md's Layers section): (1) Ctrl+A on tens of
// thousands of dots used to stall 1.3-1.9s (per-dot selection rings), and
// (2) switching to the Select tool cost ~2s on its own (a CSS cursor-
// inheritance recalculation across the whole dot subtree), regardless of
// selection. NOT part of `npm run smoke`'s fast chain — building a 30k+-dot
// layer and timing real interactions is too slow to run on every check.
// Run explicitly: `npm run perf:selection`.
// Reuse a server you already have running with: PERF_URL=http://localhost:5174 npm run perf:selection

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PORT = 5200;
const URL = process.env.PERF_URL || `http://localhost:${PORT}`;
const ELAPSED_BUDGET_MS = 150; // ~2 orders of magnitude below the documented 1.3-1.9s freeze

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
if (!process.env.PERF_URL) {
  vite = spawn(`npx vite --port ${PORT} --strictPort`, { cwd: ROOT, shell: true, stdio: "ignore" });
}

try {
  await waitForServer(URL);

  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  await page.goto(URL, { waitUntil: "networkidle" });
  await page.waitForSelector("svg");
  await page.waitForTimeout(600);

  const countDots = async () => {
    await page.mouse.move(130, 850);
    await page.waitForTimeout(120);
    return page.evaluate(() => {
      const svgs = [...document.querySelectorAll("svg")];
      const canvas = svgs.sort((a, b) => b.querySelectorAll("line").length - a.querySelectorAll("line").length)[0];
      return canvas ? canvas.querySelectorAll("circle, g > rect[rx]").length : -1;
    });
  };

  const overlayStats = () => page.evaluate(() => ({
    circles: document.querySelectorAll("[data-selection-overlay] circle").length,
    rects: document.querySelectorAll("[data-selection-overlay] rect").length,
  }));

  // Anchor for a small marquee: a real dot's screen position (via its
  // getScreenCTM, same technique smoke.mjs uses for its edge-drag test) —
  // more robust than computing a fraction of canvas world-space, which
  // doesn't account for the fit-to-view zoom/pan applied after import.
  const anyDotScreenPos = () => page.evaluate(() => {
    const svgs = [...document.querySelectorAll("svg")];
    const canvas = svgs.sort((a, b) => b.querySelectorAll("line").length - a.querySelectorAll("line").length)[0];
    const c = canvas.querySelector("circle");
    const m = c.getScreenCTM();
    const x = Number(c.getAttribute("cx")), y = Number(c.getAttribute("cy"));
    return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
  });

  // 1 — synthesize a large, detailed source image entirely in-browser (no
  // committed binary asset, no new dependency). A smooth gradient plus
  // per-pixel noise gives every pixel a distinct luminance/color so the
  // import pipeline doesn't degenerately skip large flat regions.
  const dataUrl = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 512; c.height = 512;
    const ctx = c.getContext("2d");
    const grad = ctx.createLinearGradient(0, 0, 512, 512);
    grad.addColorStop(0, "#ff2a2a");
    grad.addColorStop(0.33, "#ffcc00");
    grad.addColorStop(0.66, "#29cc74");
    grad.addColorStop(1, "#4361ee");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 512, 512);
    const img = ctx.getImageData(0, 0, 512, 512);
    for (let i = 0; i < img.data.length; i += 4) {
      const n = (Math.random() - 0.5) * 40;
      img.data[i] = Math.min(255, Math.max(0, img.data[i] + n));
      img.data[i + 1] = Math.min(255, Math.max(0, img.data[i + 1] + n));
      img.data[i + 2] = Math.min(255, Math.max(0, img.data[i + 2] + n));
    }
    ctx.putImageData(img, 0, 0);
    return c.toDataURL("image/png");
  });
  const pngBuffer = Buffer.from(dataUrl.split(",")[1], "base64");

  // 2 — drive the Image import modal: default fresh-document canvas (20x20cm
  // @ 1cm cell, per CLAUDE.md's new-document defaults) at Sub-grid (fine)
  // detail, Density maxed so no pixel is skipped regardless of image
  // content — this reliably reproduces the ~30k+-dot scale of the original
  // diagnosed freeze without depending on the synthesized image's exact tones.
  await page.getByRole("button", { name: /^image$/i }).first().click();
  await page.waitForTimeout(150);
  const importModal = page.locator("div.dotart", { has: page.getByText("Import Image") }).last();
  await importModal.locator("input[type=file]").setInputFiles({
    name: "perf-test.png", mimeType: "image/png", buffer: pngBuffer,
  });
  await page.waitForTimeout(400);

  const densitySlider = importModal.locator('input[type=range][aria-label="Density"]');
  await densitySlider.fill("1");
  await page.waitForTimeout(150);

  await importModal.getByRole("button", { name: "Sub-grid" }).click();
  await page.waitForTimeout(400);

  await importModal.getByRole("button", { name: /^add to canvas$/i }).click();
  await page.waitForTimeout(400);

  const dotCount = await countDots();
  check("setup: image import produces a 30k+-dot layer", dotCount >= 25000, `${dotCount} dots`);

  // Start from the Draw tool (the default on load, but explicit here for
  // determinism) — the exact real-world sequence that used to freeze was
  // "press a tool key, then Ctrl+A", not an isolated selection cost.
  await page.keyboard.press("b");
  await page.waitForTimeout(200);

  // 3 — cursor-surface correctness. Headless Chrome can't render the actual
  // OS cursor icon, so this asserts indirectly but rigorously: (a) the new
  // data-cursor-surface rect is structurally what the browser resolves for
  // cursor purposes at a given point (elementFromPoint), not just
  // coincidentally showing the right value from somewhere else; (b) its
  // computed `cursor` matches what the app's reactive state should produce.
  // Two deterministic states — hover state at 40k-dot density isn't reliable
  // to predict from a script, so this avoids relying on it:
  //   - Draw tool, anywhere on canvas -> "crosshair"
  //   - Select tool, mid-drag on a real dot -> "grabbing" (isDragging is the
  //     first branch in the cursor computation, overrides hover entirely)
  const cursorAt = (x, y) => page.evaluate(([px, py]) => {
    const el = document.elementFromPoint(px, py);
    return { onSurface: !!el && el.hasAttribute("data-cursor-surface"), cursor: el ? getComputedStyle(el).cursor : null };
  }, [x, y]);

  const drawCursor = await cursorAt(700, 450);
  check("cursor: draw tool resolves through data-cursor-surface as crosshair",
    drawCursor.onSurface && drawCursor.cursor === "crosshair", JSON.stringify(drawCursor));

  await page.keyboard.press("v");
  await page.waitForTimeout(200);
  const dragAnchor = await anyDotScreenPos();
  await page.mouse.move(dragAnchor.x, dragAnchor.y);
  await page.mouse.down();
  await page.mouse.move(dragAnchor.x + 40, dragAnchor.y + 20, { steps: 4 });
  const dragCursor = await cursorAt(dragAnchor.x + 40, dragAnchor.y + 20);
  check("cursor: dragging a selection resolves through data-cursor-surface as grabbing",
    dragCursor.onSurface && dragCursor.cursor === "grabbing", JSON.stringify(dragCursor));
  await page.mouse.up();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);

  // 4 — tool-switch timing: the specific operation that used to cost ~2s
  // regardless of selection — a raw CSS cursor-inheritance cost on the <svg>
  // root (unrelated to the ring/bbox work below), fixed by moving the
  // reactive `cursor` onto the data-cursor-surface rect. Switching to Select
  // changes the cursor value (crosshair -> default), the exact transition
  // that was slow.
  await page.keyboard.press("b");
  await page.waitForTimeout(200);
  const switchT0 = await page.evaluate(() => performance.now());
  await page.keyboard.press("v");
  const switchT1 = await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now()))))
  );
  check("perf: Draw -> Select tool switch under 200ms budget (was ~2s)",
    (switchT1 - switchT0) < 200, `${(switchT1 - switchT0).toFixed(1)}ms`);

  // 5 — the actual regression this script exists for: the real, unmodified
  // user flow. Ctrl+A always calls setTool("select") internally regardless
  // of the current tool, dispatched as a real, separately-dispatched key
  // event (not batched inside one page.evaluate() — batching was a
  // documented false lead in the original investigation, see SESSIONS.md
  // 2026-07-14). This now exercises BOTH fixed cost paths at once (the
  // tool-switch cursor cost and the selection ring/bbox cost) — previously
  // this script pre-switched to Select before timing, specifically to dodge
  // the cursor cost while it was still unfixed; now that it's fixed too,
  // timing the full realistic sequence is a stronger regression guard.
  await page.keyboard.press("b");
  await page.waitForTimeout(200);
  await page.mouse.move(130, 850); // park off-canvas so no stray hover ring
  await page.waitForTimeout(100);
  const t0 = await page.evaluate(() => performance.now());
  await page.keyboard.press("Control+a");
  const t1 = await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now()))))
  );
  const elapsed = t1 - t0;

  const stats = await overlayStats();
  check("perf: Ctrl+A on large layer uses the bbox fallback, not per-dot rings",
    stats.rects === 1 && stats.circles === 0, `${stats.rects} rect(s), ${stats.circles} circle(s)`);
  check(`perf: Ctrl+A-from-Draw elapsed under ${ELAPSED_BUDGET_MS}ms budget (was ~1.3-1.9s + ~2s cursor cost)`,
    elapsed < ELAPSED_BUDGET_MS, `${elapsed.toFixed(1)}ms`);

  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);

  // 6 — below-threshold sanity check: a small marquee (a fixed 220x220
  // screen-px box anchored on a real dot, well under
  // LARGE_SELECTION_RING_THRESHOLD) should still use the per-dot ring path.
  // Informational only (count/timing vary with layout), not folded into the
  // pass/fail budget above.
  const anchor = await anyDotScreenPos();
  const dragT0 = Date.now();
  await page.mouse.move(anchor.x - 110, anchor.y - 110);
  await page.mouse.down();
  await page.mouse.move(anchor.x + 110, anchor.y + 110, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  const dragElapsed = Date.now() - dragT0;
  const smallStats = await overlayStats();
  check("perf: small marquee (below threshold) selects via per-dot rings",
    smallStats.rects === 0 && smallStats.circles > 0,
    `${smallStats.circles} ring(s) in ${dragElapsed}ms (informational, not budget-gated)`);

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
