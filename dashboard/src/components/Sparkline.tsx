/**
 * A level/XP sparkline over a run's state samples. Inline SVG rather than a
 * canvas: it is a dozen points, it scales with the page, and it inherits the
 * theme colours for free.
 */

import { Show } from "solid-js";

export function Sparkline(props: { values: number[]; width?: number; height?: number; title?: string }) {
  const w = (): number => props.width ?? 180;
  const h = (): number => props.height ?? 28;
  const path = (): string => {
    const v = props.values;
    if (v.length < 2) return "";
    const lo = Math.min(...v);
    const hi = Math.max(...v);
    // A flat series has no range to normalise against; draw it down the middle.
    const span = hi - lo || 1;
    return v
      .map((n, i) => {
        const x = (i / (v.length - 1)) * (w() - 2) + 1;
        const y = h() - 1 - ((n - lo) / span) * (h() - 2);
        return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  };
  return (
    <Show when={props.values.length >= 2} fallback={<span class="dim">—</span>}>
      <svg width={w()} height={h()} role="img" aria-label={props.title ?? "sparkline"}>
        <title>{props.title ?? ""}</title>
        <path d={path()} fill="none" stroke="var(--accent)" stroke-width="1.5" />
      </svg>
    </Show>
  );
}
