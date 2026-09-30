/**
 * A thin line with a faint fill, no axes. Reads a trend, not a value.
 * The last point is marked so the eye lands on "now".
 */
export function Sparkline({
  values,
  color = '#A48BFF',
  height = 44,
}: {
  readonly values: readonly number[];
  readonly color?: string | undefined;
  readonly height?: number;
}) {
  const w = 200;
  const pad = 2;
  if (values.length < 2) {
    return <div style={{ height }} className="mt-2" aria-hidden="true" />;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const sx = (i: number) => pad + (i * (w - 2 * pad)) / (values.length - 1);
  const sy = (v: number) => height - pad - ((v - min) / (max - min || 1)) * (height - 2 * pad);
  const points = values.map((v, i) => `${sx(i).toFixed(1)},${sy(v).toFixed(1)}`).join(' ');
  const last = values[values.length - 1]!;
  return (
    <svg
      className="mt-2 block w-full"
      style={{ height }}
      viewBox={`0 0 ${w} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <polygon
        points={`${sx(0)},${height} ${points} ${sx(values.length - 1)},${height}`}
        fill={color}
        opacity="0.12"
      />
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      <circle cx={sx(values.length - 1)} cy={sy(last)} r="2.4" fill={color} />
    </svg>
  );
}
