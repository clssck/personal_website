/**
 * Geometry for the terminal window: where a drag or an edge resize may put
 * it. Pure arithmetic in viewport pixels; Terminal.astro applies the result.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Size {
  w: number;
  h: number;
}

/** Any combination of n/s with e/w, e.g. "n", "se". */
export type ResizeEdge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export const MIN_SIZE: Size = { w: 320, h: 220 };

/** Width of the window that always stays on screen, so it can be grabbed back. */
const REACHABLE = 96;

const clamp = (value: number, low: number, high: number) =>
  Math.min(Math.max(value, low), Math.max(low, high));

/**
 * Keep a window usable inside the viewport: never larger than it, the title
 * bar (the top `barHeight` pixels) never above or below it, and at least a
 * strip of the window within reach horizontally. A viewport smaller than the
 * minimum size wins over the minimum.
 */
export function clampRect(rect: Rect, viewport: Size, barHeight: number): Rect {
  const w = clamp(rect.w, Math.min(MIN_SIZE.w, viewport.w), viewport.w);
  const h = clamp(rect.h, Math.min(MIN_SIZE.h, viewport.h), viewport.h);
  return {
    w,
    h,
    x: clamp(rect.x, REACHABLE - w, viewport.w - REACHABLE),
    y: clamp(rect.y, 0, viewport.h - barHeight),
  };
}

/**
 * The rectangle after dragging `edge` by (dx, dy) from `start`. The opposite
 * edge stays put; the dragged edge stops at the minimum size and at the
 * viewport's top, right and bottom.
 */
export function resizeRect(
  start: Rect,
  edge: ResizeEdge,
  dx: number,
  dy: number,
  viewport: Size
): Rect {
  let { x, y, w, h } = start;
  const right = start.x + start.w;
  const bottom = start.y + start.h;
  if (edge.includes("e")) {
    w = clamp(start.w + dx, MIN_SIZE.w, viewport.w - start.x);
  } else if (edge.includes("w")) {
    x = Math.min(start.x + dx, right - MIN_SIZE.w);
    w = right - x;
  }
  if (edge.includes("s")) {
    h = clamp(start.h + dy, MIN_SIZE.h, viewport.h - start.y);
  } else if (edge.includes("n")) {
    y = clamp(start.y + dy, 0, bottom - MIN_SIZE.h);
    h = bottom - y;
  }
  return { x, y, w, h };
}
