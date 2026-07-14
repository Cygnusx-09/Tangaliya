// download.ts — cross-platform "save this file" helper, extracted so every
// exporter (SVG/PNG/PDF/project JSON) shares one code path.
//
// iOS Safari does not reliably honor the `download` attribute on <a> — and
// once the download fires *after* an async step (image decode, canvas.toBlob,
// a dynamic import), WebKit no longer trusts it as a direct user action and
// silently drops it: no save, no error, nothing. That's exactly the shape of
// this app's exporters (exportSVG is synchronous and worked; exportPNG/PDF
// both wait on img.onload + toBlob/a dynamic import first).
//
// Fix: on iOS, route through the Web Share API with a File — the
// Apple-sanctioned way to hand a generated file to the user, popping the
// native "Save Image" / "Save to Files" sheet. Desktop/Android keep the
// existing direct blob-download, untouched.
export async function downloadBlob(blob: Blob, filename: string): Promise<void> {
  if (isIOS()) {
    const file = new File([blob], filename, { type: blob.type });
    const nav = navigator as Navigator & {
      canShare?: (data: { files: File[] }) => boolean;
      share?: (data: { files: File[] }) => Promise<void>;
    };
    if (nav.share && (!nav.canShare || nav.canShare({ files: [file] }))) {
      try {
        await nav.share({ files: [file] });
        return;
      } catch {
        // User cancelled, or share failed for some other reason — fall
        // through to the new-tab fallback instead of doing nothing.
      }
    }
    // No Share API (older iOS) or it failed: open the file in a new tab.
    // Safari can't download it directly from there either, but its inline
    // viewer has its own share/save icon the user can use.
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  // iPadOS 13+ reports its platform as "MacIntel" (desktop-class Safari UA)
  // but exposes touch points a real Mac never does — the standard sniff to
  // tell an iPad apart from an actual Mac.
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}
