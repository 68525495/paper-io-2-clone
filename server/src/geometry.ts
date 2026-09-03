import { CELL_SIZE, GRID_CELLS, HALF_ARENA_SIZE } from "./constants.js";

export function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

export function distanceSq(x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  return dx * dx + dy * dy;
}

export function distance(x1: number, y1: number, x2: number, y2: number): number {
  return Math.sqrt(distanceSq(x1, y1, x2, y2));
}

/** Normalize angle to [-PI, PI] */
export function normalizeAngle(angle: number): number {
  let a = (angle + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
}

/** Shortest angle difference between two angles in [-PI, PI] */
export function angleDiff(from: number, to: number): number {
  const diff = normalizeAngle(to) - normalizeAngle(from);
  return normalizeAngle(diff);
}

/** Step angle towards target angle by max radians */
export function stepAngle(current: number, target: number, maxStep: number): number {
  const normCurrent = normalizeAngle(current);
  const normTarget = normalizeAngle(target);
  const diff = angleDiff(normCurrent, normTarget);
  if (Math.abs(diff) <= maxStep) {
    return normTarget;
  }
  return normalizeAngle(normCurrent + Math.sign(diff) * maxStep);
}

/** Distance from point (px, py) to line segment (ax, ay)-(bx, by) */
export function distToSegmentSq(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  const l2 = distanceSq(ax, ay, bx, by);
  if (l2 === 0) return distanceSq(px, py, ax, ay);
  let t = ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / l2;
  t = Math.max(0, Math.min(1, t));
  const projX = ax + t * (bx - ax);
  const projY = ay + t * (by - ay);
  return distanceSq(px, py, projX, projY);
}

export function distToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  return Math.sqrt(distToSegmentSq(px, py, ax, ay, bx, by));
}

/** Convert world coordinates to grid cell coordinates [0..GRID_CELLS-1] */
export function worldToGrid(x: number, y: number): { gx: number; gy: number } {
  const gx = Math.floor((x + HALF_ARENA_SIZE) / CELL_SIZE);
  const gy = Math.floor((y + HALF_ARENA_SIZE) / CELL_SIZE);
  return {
    gx: clamp(gx, 0, GRID_CELLS - 1),
    gy: clamp(gy, 0, GRID_CELLS - 1),
  };
}

/** Convert grid cell coordinates to world center coordinates */
export function gridToWorld(gx: number, gy: number): { x: number; y: number } {
  const x = (gx + 0.5) * CELL_SIZE - HALF_ARENA_SIZE;
  const y = (gy + 0.5) * CELL_SIZE - HALF_ARENA_SIZE;
  return { x, y };
}

/** Check if circle at (x, y) with radius r intersects segment */
export function circleIntersectsSegment(
  cx: number,
  cy: number,
  cr: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): boolean {
  return distToSegmentSq(cx, cy, ax, ay, bx, by) <= cr * cr;
}
