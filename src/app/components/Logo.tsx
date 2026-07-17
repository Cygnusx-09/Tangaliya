// The Tangaliya mark — five dots in a plus arrangement. Shared between the
// editor header and the Home screen (the only two places it appears).
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 39 39" className="shrink-0" aria-label="Tangaliya logo">
      {[
        [18.5, 3.5],  // top
        [3.5, 18.5],  // left
        [18.5, 18.5], // center
        [34.5, 18.5], // right
        [18.5, 34.5], // bottom
      ].map(([cx, cy]) => (
        <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={3.5} fill="#FF2A2A" />
      ))}
    </svg>
  );
}
