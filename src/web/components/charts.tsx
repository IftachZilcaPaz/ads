import { useEffect, useRef, useState } from 'preact/hooks';

/**
 * Small SVG charts in the dataviz house style: one validated accent hue
 * (--chart-accent) for the data, gray (--chart-muted) for context, 2px lines,
 * 4px rounded data-ends, ≤24px bars, hairline grid, hover/focus tooltips.
 * Text always uses text tokens, never the series color.
 */

export type Fmt = (v: number) => string;

interface Tip {
  x: number;
  y: number;
  value: string;
  label: string;
}

function Tooltip({ tip }: { tip: Tip | null }) {
  if (!tip) return null;
  return (
    <div class="chart-tip" style={{ left: `${tip.x}px`, top: `${tip.y}px` }} role="status">
      <strong>{tip.value}</strong>
      <span>{tip.label}</span>
    </div>
  );
}

/** Clean axis ticks: 0 and two round steps above. */
function niceMax(max: number): { top: number; ticks: number[] } {
  if (max <= 0) return { top: 1, ticks: [0] };
  const raw = max / 2;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  return { top: step * 2, ticks: [0, step, step * 2] };
}

const H = 220;
/** Right padding leaves room for the direct label at the end of the line. */
const PAD = { top: 16, right: 56, bottom: 28, left: 48 };
const TIP_HALF = 70;

/** Tracks an element's content width so SVG draws at 1:1 (text and strokes keep their size on phones). */
function useWidth(ref: { current: HTMLElement | null }, fallback: number): number {
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => entry && setWidth(Math.round(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

/** Single-series trend (line + 10% wash), crosshair snapping to the nearest day. */
export function TrendChart({ points, fmt, label }: { points: { date: string; value: number }[]; fmt: Fmt; label: string }) {
  const box = useRef<HTMLDivElement>(null);
  const W = useWidth(box, 640);
  const [active, setActive] = useState<number | null>(null);
  if (points.length < 2) return <p class="muted small">אין מספיק נקודות לגרף.</p>;

  const { top, ticks } = niceMax(Math.max(...points.map((p) => p.value)));
  const iw = W - PAD.left - PAD.right;
  const ih = H - PAD.top - PAD.bottom;
  // RTL page, but time still runs left → right on a chart axis.
  const x = (i: number) => PAD.left + (i / (points.length - 1)) * iw;
  const y = (v: number) => PAD.top + ih - (v / top) * ih;
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join('');
  const area = `${line}L${x(points.length - 1)},${PAD.top + ih}L${x(0)},${PAD.top + ih}Z`;
  const last = points.length - 1;
  const dd = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;

  const pick = (clientX: number) => {
    const rect = box.current!.getBoundingClientRect();
    const sx = clientX - rect.left;
    setActive(Math.max(0, Math.min(last, Math.round(((sx - PAD.left) / iw) * last))));
  };
  const tip: Tip | null =
    active === null || !box.current
      ? null
      : {
          // Keep the tooltip inside the chart near the edges.
          x: Math.min(Math.max(x(active), TIP_HALF), W - TIP_HALF),
          y: y(points[active]!.value),
          value: fmt(points[active]!.value),
          label: `${label} · ${dd(points[active]!.date)}`,
        };

  return (
    <div
      ref={box}
      class="chart"
      tabIndex={0}
      aria-label={`${label}: ${points.length} ימים`}
      onPointerMove={(e) => pick(e.clientX)}
      onPointerLeave={() => setActive(null)}
      onFocus={() => setActive(last)}
      onBlur={() => setActive(null)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') setActive((a) => Math.max(0, (a ?? last) - 1));
        if (e.key === 'ArrowRight') setActive((a) => Math.min(last, (a ?? last) + 1));
      }}
    >
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
        {ticks.map((t) => (
          <g key={t}>
            <line class="grid" x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} />
            <text class="tick" x={PAD.left - 8} y={y(t) + 4} text-anchor="end">
              {fmt(t)}
            </text>
          </g>
        ))}
        {[0, Math.floor(last / 2), last].map((i) => (
          <text key={i} class="tick" x={x(i)} y={H - 8} text-anchor={i === 0 ? 'start' : i === last ? 'end' : 'middle'}>
            {dd(points[i]!.date)}
          </text>
        ))}
        <path class="area" d={area} />
        <path class="line" d={line} />
        {active !== null && <line class="crosshair" x1={x(active)} x2={x(active)} y1={PAD.top} y2={PAD.top + ih} />}
        <circle class="dot" cx={x(active ?? last)} cy={y(points[active ?? last]!.value)} r={4} />
      </svg>
      <span class="end-label" style={{ left: `${x(last) + 8}px`, top: `${y(points[last]!.value)}px` }}>
        {fmt(points[last]!.value)}
      </span>
      <Tooltip tip={tip} />
    </div>
  );
}

export interface BarItem {
  key: string;
  label: string;
  value: number | null;
  /** Secondary line in the tooltip (e.g. "3 פוסטים"). */
  sub: string;
  emphasis?: boolean;
}

/** Horizontal bars growing from the start edge, value at the tip; the emphasized bar takes the accent. */
export function BarList({ items, fmt, emphasize }: { items: BarItem[]; fmt: Fmt; emphasize?: boolean }) {
  const [hover, setHover] = useState<string | null>(null);
  const max = Math.max(0, ...items.map((i) => i.value ?? 0)) || 1;
  return (
    <ul class="bar-list">
      {items.map((item) => {
        const pct = item.value === null ? 0 : (item.value / max) * 100;
        const tone = !emphasize || item.emphasis ? 'accent' : 'muted';
        return (
          <li
            key={item.key}
            tabIndex={0}
            onPointerEnter={() => setHover(item.key)}
            onPointerLeave={() => setHover(null)}
            onFocus={() => setHover(item.key)}
            onBlur={() => setHover(null)}
            class={hover === item.key ? 'hover' : ''}
          >
            <span class="bar-label">{item.label}</span>
            <span class="bar-track">
              {item.value !== null && <span class={`bar ${tone}`} style={{ width: `${Math.max(pct, 2)}%` }} />}
              <span class="bar-value">{item.value === null ? 'אין נתונים' : fmt(item.value)}</span>
            </span>
            {hover === item.key && (
              <span class="chart-tip inline" role="status">
                <strong>{item.value === null ? 'אין נתונים' : fmt(item.value)}</strong>
                <span>
                  {item.label} · {item.sub}
                </span>
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Columns (e.g. weekdays), value on the cap; the best one in the accent, the rest gray. */
export function ColumnChart({ items, fmt }: { items: BarItem[]; fmt: Fmt }) {
  const [hover, setHover] = useState<string | null>(null);
  const max = Math.max(0, ...items.map((i) => i.value ?? 0)) || 1;
  return (
    <div class="columns" role="list">
      {items.map((item) => (
        <div
          key={item.key}
          role="listitem"
          tabIndex={0}
          class={`col-item${hover === item.key ? ' hover' : ''}`}
          onPointerEnter={() => setHover(item.key)}
          onPointerLeave={() => setHover(null)}
          onFocus={() => setHover(item.key)}
          onBlur={() => setHover(null)}
        >
          <span class="col-plot">
            <span class="col-value">{item.value === null ? '-' : fmt(item.value)}</span>
            {item.value !== null && <span class={`column ${item.emphasis ? 'accent' : 'muted'}`} style={{ height: `${Math.max((item.value / max) * 100, 2)}%` }} />}
          </span>
          <span class="col-label">{item.label}</span>
          {hover === item.key && (
            <span class="chart-tip inline" role="status">
              <strong>{item.value === null ? 'אין נתונים' : fmt(item.value)}</strong>
              <span>
                {item.label} · {item.sub}
              </span>
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
