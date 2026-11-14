import { useCallback, useEffect, useRef, useState } from "react";

/** Measure an element's content width (px). Charts draw in real pixels so
 *  strokes, dots and text never stretch. */
export function useMeasure<T extends HTMLElement>(): [(el: T | null) => void, number] {
  const [width, setWidth] = useState(0);
  const obs = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: T | null) => {
    obs.current?.disconnect();
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    obs.current = new ResizeObserver((entries) => {
      const w = Math.round(entries[0].contentRect.width);
      setWidth((cur) => (cur === w ? cur : w));
    });
    obs.current.observe(el);
  }, []);
  useEffect(() => () => obs.current?.disconnect(), []);
  return [ref, width];
}

/** Round a maximum up to a clean axis top (1, 2, 2.5, 5 × 10ⁿ). */
export function niceMax(max: number): number {
  if (!Number.isFinite(max) || max <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(max)));
  const f = max / exp;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nice * exp;
}

/** About `count` ticks from 0 up, on a clean step (1, 2, 2.5, 5 × 10ⁿ).
 *  The top tick is the first step at or above `max`, so the plot is not
 *  squashed under a needlessly high ceiling. */
export function niceTicks(max: number, count = 4): number[] {
  if (!Number.isFinite(max) || max <= 0) return [0, 1];
  const step = niceMax(max / count);
  const steps = Math.max(1, Math.ceil(max / step - 1e-9));
  return Array.from({ length: steps + 1 }, (_, i) => +(step * i).toPrecision(12));
}

/** Indices of ~`target` evenly spaced x labels, always including the ends. */
export function pickLabelIndices(n: number, target: number): number[] {
  if (n <= 0) return [];
  if (n <= target) return Array.from({ length: n }, (_, i) => i);
  const step = (n - 1) / (target - 1);
  const out = new Set<number>();
  for (let i = 0; i < target; i++) out.add(Math.round(i * step));
  return [...out].sort((a, b) => a - b);
}

/** Smooth-ish path through points (monotone-safe straight segments with
 *  round joins read cleaner than splines for daily data). */
export function linePath(points: Array<[number, number]>): string {
  return points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
}

export interface ChartSeries {
  id: string;
  label: string;
  /** A CSS colour: use the chart tokens, e.g. "var(--chart-1)". */
  color: string;
  values: number[];
}
