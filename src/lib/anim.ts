// Noise helpers for the text tool's dot animation. Pure math, no React.
// noise2 is 2D value noise (smooth clumpy field, 0..1); curl2 is the curl of
// that field (a divergence-free flow — dots pushed by it swirl, never bunch);
// backOut is an overshoot ease for the reveal "pop".
import { hash01 } from "./dots";

// Smooth 2D value noise in [0,1]: hash the 4 surrounding lattice corners,
// blend with a smoothstep so there are no grid-line creases.
export function noise2(x: number, y: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash01(ix, iy), b = hash01(ix + 1, iy);
  const c = hash01(ix, iy + 1), d = hash01(ix + 1, iy + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

// Curl of the noise field via central differences: rotate the gradient 90°.
// Magnitude is O(1); scale by an amplitude at the call site.
export function curl2(x: number, y: number): [number, number] {
  const e = 0.3;
  const dx = noise2(x + e, y) - noise2(x - e, y);
  const dy = noise2(x, y + e) - noise2(x, y - e);
  return [dy / (2 * e), -dx / (2 * e)];
}

// Back-out ease: overshoots ~10% past 1 then settles — the elastic "pop".
export function backOut(p: number): number {
  const s = 1.70158, q = p - 1;
  return 1 + q * q * ((s + 1) * q + s);
}
