import { describe, expect, it } from "vitest";
import {
  extractSmoothedPlayerContours,
  simplifyClosedLoop,
  smoothClosedLoop,
} from "../contour.js";

function distanceToClosedLoop(
  point: { x: number; y: number },
  loop: Array<{ x: number; y: number }>
): number {
  let minDistance = Infinity;
  for (let i = 0; i < loop.length; i++) {
    const start = loop[i];
    const end = loop[(i + 1) % loop.length];
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lengthSq = dx * dx + dy * dy;
    const projection =
      lengthSq === 0
        ? 0
        : Math.max(
            0,
            Math.min(
              1,
              ((point.x - start.x) * dx + (point.y - start.y) * dy) /
                lengthSq
            )
          );
    const closestX = start.x + projection * dx;
    const closestY = start.y + projection * dy;
    minDistance = Math.min(
      minDistance,
      Math.hypot(point.x - closestX, point.y - closestY)
    );
  }
  return minDistance;
}

describe("Contour Extraction & Smoothing", () => {
  it("extracts a smooth closed contour from circular spawn base", () => {
    const size = 256;
    const grid = new Uint8Array(size * size);
    const cx = 128;
    const cy = 128;
    const r = 9;

    // Fill circular base
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy <= r * r + 1) {
          grid[(cy + dy) * size + (cx + dx)] = 1;
        }
      }
    }

    const contours = extractSmoothedPlayerContours(grid, 1, {
      gridSize: size,
      chaikinIterations: 2,
      maxDeviation: 0.5,
    });

    expect(contours.length).toBe(1);
    const loop = contours[0];
    expect(loop.length).toBeGreaterThan(60);

    // Marching Squares uses cell-sample coordinates, so the disc is centered
    // directly on the spawn grid coordinate.
    const centerX = cx;
    const centerY = cy;
    for (const pt of loop) {
      const dist = Math.hypot(pt.x - centerX, pt.y - centerY);
      expect(dist).toBeGreaterThan(8.7);
      expect(dist).toBeLessThan(9.6);
    }
  });

  it("extracts both outer boundary and inner hole for enclosed hollow ring", () => {
    const size = 256;
    const grid = new Uint8Array(size * size);

    // Create a 20x20 outer box with an 8x8 hole inside
    for (let y = 50; y < 70; y++) {
      for (let x = 50; x < 70; x++) {
        const isHole = x >= 56 && x < 64 && y >= 56 && y < 64;
        if (!isHole) {
          grid[y * size + x] = 2;
        }
      }
    }

    const contours = extractSmoothedPlayerContours(grid, 2, {
      gridSize: size,
      chaikinIterations: 1,
      maxDeviation: 0.5,
    });

    // Should extract 2 loops: outer boundary and hole
    expect(contours.length).toBe(2);
    for (const loop of contours) {
      expect(loop.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("strictly constrains smoothed points to within maxDeviation from original polygon", () => {
    // Sharp L-shaped corner
    const rawLoop = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 5 },
      { x: 5, y: 5 },
      { x: 5, y: 10 },
      { x: 0, y: 10 },
    ];

    const maxDev = 0.5;
    const smoothed = smoothClosedLoop(rawLoop, 3, maxDev);

    expect(smoothed.length).toBe(rawLoop.length * 8);

    // Function to calculate min distance to original polygon segments
    const distToSegment = (
      px: number,
      py: number,
      x0: number,
      y0: number,
      x1: number,
      y1: number
    ) => {
      const dx = x1 - x0;
      const dy = y1 - y0;
      const l2 = dx * dx + dy * dy;
      if (l2 === 0) return Math.hypot(px - x0, py - y0);
      let t = Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / l2));
      return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
    };

    for (const pt of smoothed) {
      let minDist = Infinity;
      for (let i = 0; i < rawLoop.length; i++) {
        const p0 = rawLoop[i];
        const p1 = rawLoop[(i + 1) % rawLoop.length];
        const d = distToSegment(pt.x, pt.y, p0.x, p0.y, p1.x, p1.y);
        if (d < minDist) minDist = d;
      }
      expect(minDist).toBeLessThanOrEqual(maxDev + 0.001);
    }
  });

  it("simplifies raster stair steps before smoothing", () => {
    const staircase: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < 20; i++) {
      staircase.push({ x: i, y: i });
      staircase.push({ x: i + 1, y: i });
    }
    staircase.push({ x: 20, y: 26 }, { x: 0, y: 26 });

    const tolerance = 0.75;
    const simplified = simplifyClosedLoop(staircase, tolerance);

    expect(simplified.length).toBeLessThan(staircase.length / 3);
    for (const point of staircase) {
      expect(distanceToClosedLoop(point, simplified)).toBeLessThanOrEqual(
        tolerance + 0.001
      );
    }
  });

  it("extracts one merged silhouette for a spawn base plus captured extension", () => {
    const size = 64;
    const grid = new Uint8Array(size * size);
    const cx = 20;
    const cy = 32;
    const radius = 7;

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const inBase =
          (x - cx) * (x - cx) + (y - cy) * (y - cy) <=
          radius * radius + 1;
        const inCapture = x >= cx && x <= 48 && y >= cy - 4 && y <= cy + 4;
        if (inBase || inCapture) grid[y * size + x] = 1;
      }
    }

    const contours = extractSmoothedPlayerContours(grid, 1, {
      gridSize: size,
      simplifyTolerance: 0.9,
      chaikinIterations: 3,
      maxDeviation: 0.8,
    });

    expect(contours).toHaveLength(1);
    expect(contours[0].some((point) => point.x > 47)).toBe(true);
  });

  it("keeps simplified smoothing within the raw contour deviation budget", () => {
    const size = 64;
    const grid = new Uint8Array(size * size);
    for (let x = 8; x < 54; x++) {
      const top = 12 + Math.floor((x - 8) * 0.45);
      for (let y = top; y < 52; y++) grid[y * size + x] = 3;
    }

    const [rawContour] = extractSmoothedPlayerContours(grid, 3, {
      gridSize: size,
      chaikinIterations: 0,
    });
    const [smoothedContour] = extractSmoothedPlayerContours(grid, 3, {
      gridSize: size,
      simplifyTolerance: 0.9,
      chaikinIterations: 3,
      maxDeviation: 0.8,
    });

    expect(smoothedContour.length).toBeLessThan(rawContour.length * 8);
    for (const point of smoothedContour) {
      expect(distanceToClosedLoop(point, rawContour)).toBeLessThanOrEqual(0.801);
    }
  });
});
