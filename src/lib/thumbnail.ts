// thumbnail.ts — rasterizes an SVG export string (from buildSVGString) into a
// small PNG dataURL for a project library tile. Mirrors exportPNG's
// blob->Image->canvas pipeline in DotArtTool.tsx, just scaled down and
// returning a dataURL instead of triggering a download.

export function captureThumbnail(svgString: string, srcW: number, srcH: number, maxDim = 480): Promise<string> {
  return new Promise((resolve, reject) => {
    const blob = new Blob([svgString], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(maxDim / srcW, maxDim / srcH, 1);
      const w = Math.max(1, Math.round(srcW * scale));
      const h = Math.max(1, Math.round(srcH * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext("2d");
      URL.revokeObjectURL(url);
      if (!ctx) { reject(new Error("2d context unavailable")); return; }
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("thumbnail image failed to load")); };
    img.src = url;
  });
}
