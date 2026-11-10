import { describe, expect, test } from "bun:test";
import { clampRect, MIN_SIZE, resizeRect, type Rect } from "./window";

const VIEWPORT = { w: 1200, h: 800 };
const BAR = 40;
const START: Rect = { x: 200, y: 100, w: 600, h: 400 };

describe("clampRect", () => {
  test("a window inside the viewport is left alone", () => {
    expect(clampRect(START, VIEWPORT, BAR)).toEqual(START);
  });

  test("the title bar never leaves the viewport vertically", () => {
    expect(clampRect({ ...START, y: -50 }, VIEWPORT, BAR).y).toBe(0);
    expect(clampRect({ ...START, y: 5000 }, VIEWPORT, BAR).y).toBe(VIEWPORT.h - BAR);
  });

  test("the window may hang off a side but keeps a strip on screen", () => {
    const left = clampRect({ ...START, x: -5000 }, VIEWPORT, BAR);
    expect(left.x + left.w).toBeGreaterThan(0);
    expect(left.x).toBeLessThan(0);
    const right = clampRect({ ...START, x: 5000 }, VIEWPORT, BAR);
    expect(right.x).toBeLessThan(VIEWPORT.w);
    expect(right.x + right.w).toBeGreaterThan(VIEWPORT.w);
  });

  test("size is bounded by the minimum and the viewport", () => {
    const tiny = clampRect({ ...START, w: 10, h: 10 }, VIEWPORT, BAR);
    expect(tiny.w).toBe(MIN_SIZE.w);
    expect(tiny.h).toBe(MIN_SIZE.h);
    const huge = clampRect({ x: 0, y: 0, w: 9000, h: 9000 }, VIEWPORT, BAR);
    expect(huge).toEqual({ x: 0, y: 0, w: VIEWPORT.w, h: VIEWPORT.h });
  });

  test("a viewport smaller than the minimum size wins", () => {
    const phone = { w: 280, h: 200 };
    const r = clampRect({ x: 0, y: 0, w: 600, h: 400 }, phone, BAR);
    expect(r.w).toBe(280);
    expect(r.h).toBe(200);
  });
});

describe("resizeRect", () => {
  test("east and south edges grow the window from a fixed top-left", () => {
    expect(resizeRect(START, "se", 50, 30, VIEWPORT)).toEqual({
      x: 200,
      y: 100,
      w: 650,
      h: 430,
    });
  });

  test("west and north edges move the origin and keep the far corner", () => {
    const r = resizeRect(START, "nw", -40, -20, VIEWPORT);
    expect(r).toEqual({ x: 160, y: 80, w: 640, h: 420 });
    expect(r.x + r.w).toBe(START.x + START.w);
    expect(r.y + r.h).toBe(START.y + START.h);
  });

  test("a single edge leaves the other axis untouched", () => {
    expect(resizeRect(START, "e", 25, 999, VIEWPORT)).toEqual({ ...START, w: 625 });
    expect(resizeRect(START, "n", 999, -25, VIEWPORT)).toEqual({
      ...START,
      y: 75,
      h: 425,
    });
  });

  test("shrinking stops at the minimum size without moving the far edge", () => {
    const fromEast = resizeRect(START, "e", -5000, 0, VIEWPORT);
    expect(fromEast).toEqual({ ...START, w: MIN_SIZE.w });
    const fromWest = resizeRect(START, "w", 5000, 0, VIEWPORT);
    expect(fromWest.w).toBe(MIN_SIZE.w);
    expect(fromWest.x + fromWest.w).toBe(START.x + START.w);
    const fromNorth = resizeRect(START, "n", 0, 5000, VIEWPORT);
    expect(fromNorth.h).toBe(MIN_SIZE.h);
    expect(fromNorth.y + fromNorth.h).toBe(START.y + START.h);
  });

  test("growing stops at the viewport's top, right and bottom", () => {
    const up = resizeRect(START, "n", 0, -5000, VIEWPORT);
    expect(up.y).toBe(0);
    expect(up.h).toBe(START.y + START.h);
    const out = resizeRect(START, "se", 5000, 5000, VIEWPORT);
    expect(out.x + out.w).toBe(VIEWPORT.w);
    expect(out.y + out.h).toBe(VIEWPORT.h);
  });
});
