import { HALF_ARENA_SIZE } from "./constants.js";

export interface ArenaPoint {
  x: number;
  y: number;
}

export interface ConstrainedArenaPoint extends ArenaPoint {
  constrained: boolean;
}

export const ARENA_SHAPE_VERSION = 1;
export const ARENA_CONTOUR_SAMPLES = 128;

// The Runner server is compiled as an independent artifact, so this module is
// mirrored at server/src/arenaShape.ts. Keep the deterministic geometry exact.
const TWO_PI = Math.PI * 2;

/** Returns the island radius along a world-space direction. */
export function arenaRadiusAtAngle(angle: number): number {
  // Low harmonics keep curvature gentle, continuous and center-visible.
  const radiusScale =
    0.875 +
    0.035 * Math.sin(2 * angle + 0.35) +
    0.03 * Math.sin(3 * angle - 1.05) +
    0.012 * Math.cos(5 * angle + 0.7);
  return HALF_ARENA_SIZE * radiusScale;
}

/**
 * Radial clearance to the smooth island edge. Positive values are on land;
 * negative values are in the ocean.
 */
export function arenaBoundaryClearance(x: number, y: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return -Infinity;
  const distanceFromCenter = Math.hypot(x, y);
  return arenaRadiusAtAngle(Math.atan2(y, x)) - distanceFromCenter;
}

/** True when a point, optionally inset from the coast, is playable. */
export function isPointInsideArena(
  x: number,
  y: number,
  inset: number = 0
): boolean {
  const safeInset = Math.max(0, inset);
  return arenaBoundaryClearance(x, y) >= safeInset;
}

/**
 * Projects a point radially onto the playable outline. The map is deliberately
 * center-visible, so this projection cannot jump across a bay or separate arm.
 */
export function constrainPointToArena(
  x: number,
  y: number,
  inset: number = 0
): ConstrainedArenaPoint {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return { x: 0, y: 0, constrained: true };
  }

  const angle = Math.atan2(y, x);
  const maxRadius = Math.max(0, arenaRadiusAtAngle(angle) - Math.max(0, inset));
  const radius = Math.hypot(x, y);
  if (radius <= maxRadius || radius <= 1e-9) {
    return { x, y, constrained: false };
  }

  const scale = maxRadius / radius;
  return {
    x: x * scale,
    y: y * scale,
    constrained: true,
  };
}

/** Deterministic world-space points consumed by map geometry consumers. */
export function sampleArenaContour(
  samples: number = ARENA_CONTOUR_SAMPLES,
  inset: number = 0
): ArenaPoint[] {
  const safeSamples = Math.max(16, Math.floor(samples));
  const points: ArenaPoint[] = [];
  for (let index = 0; index < safeSamples; index++) {
    const angle = -Math.PI / 2 + (index / safeSamples) * TWO_PI;
    const radius = Math.max(0, arenaRadiusAtAngle(angle) - Math.max(0, inset));
    points.push({
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
    });
  }
  return points;
}

/** Rejection-samples the island interior without favoring its narrow lobes. */
export function randomPointInsideArena(
  inset: number = 0,
  random: () => number = Math.random
): ArenaPoint {
  const safeInset = Math.max(0, inset);
  const extent = Math.max(0, HALF_ARENA_SIZE - safeInset);
  for (let attempt = 0; attempt < 128; attempt++) {
    const x = (random() * 2 - 1) * extent;
    const y = (random() * 2 - 1) * extent;
    if (isPointInsideArena(x, y, safeInset)) return { x, y };
  }
  return { x: 0, y: 0 };
}

export const ARENA_CONTOUR: ReadonlyArray<ArenaPoint> =
  sampleArenaContour();
