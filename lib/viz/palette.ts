/** Colours tuned for additive glow on a near-black sky. */
const CURATED = [
  '#7cc4ff', // sky
  '#ff8fc8', // pink
  '#ffd166', // amber
  '#7ef0a8', // mint
  '#b69cff', // violet
  '#ff9e7a', // coral
  '#5ee6d6', // teal
  '#f6f07a', // lemon
  '#8fa2ff', // periwinkle
  '#c3f57a', // lime
  '#ff7b9c', // rose
  '#7ae0ff', // cyan
];

export type RGB = [number, number, number];

export function hexToRgb(hex: string): RGB {
  const v = parseInt(hex.slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

export function rgbToCss([r, g, b]: RGB): string {
  return `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)})`;
}

function hslToRgb(h: number, s: number, l: number): RGB {
  const k = (n: number) => (n + h * 12) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}

export function groupColor(index: number): RGB {
  if (index < 0) return [0.78, 0.82, 0.95];
  if (index < CURATED.length) return hexToRgb(CURATED[index]);
  // Golden-angle hues beyond the curated set.
  const hue = ((index * 137.508) % 360) / 360;
  return hslToRgb(hue, 0.75, 0.7);
}

export function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export const WHITE: RGB = [1, 1, 1];
export const EXTERNAL_COLOR: RGB = [0.55, 0.62, 0.78];
export const BUILTIN_COLOR: RGB = [0.45, 0.5, 0.6];

/** Edge colours by kind: contains, import, call, render, inherit. */
export const EDGE_COLORS: RGB[] = [
  [0.35, 0.4, 0.6],
  [0.45, 0.62, 1.0],
  [1.0, 0.72, 0.3],
  [1.0, 0.42, 0.78],
  [0.45, 1.0, 0.6],
];

export const EDGE_COLOR_CSS = EDGE_COLORS.map(rgbToCss);
