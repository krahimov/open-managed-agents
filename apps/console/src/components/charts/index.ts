/**
 * Muse chart kit — hand-built SVG, no chart library.
 *
 *   Sparkline        trend beside a number
 *   TimeSeriesChart  line / area / stacked columns over time, with axes,
 *                    hover crosshair + tooltip, and a screen-reader table
 *   BarList          ranked categories
 *   Meter            progress toward a limit
 *   ChartLegend      swatch + label (+ value) for ≥ 2 series
 *
 * Colour: series use the --chart-1…6 tokens IN ORDER (never cycled or
 * re-ranked); provider series use --chart-anthropic / --chart-openai.
 * Text on and around charts is always a text token, never a series colour.
 */
export { Sparkline } from "./Sparkline";
export { TimeSeriesChart } from "./TimeSeriesChart";
export { BarList, type BarListItem } from "./BarList";
export { Meter } from "./Meter";
export { ChartLegend } from "./ChartLegend";
export { type ChartSeries, niceMax, niceTicks } from "./util";
