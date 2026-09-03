import { describe, expect, it } from "vitest";
import {
  ARENA_SIZE,
  CELL_SIZE,
  GRID_CELLS,
} from "../constants.js";
import {
  circleIntersectsSegment,
  distToSegment,
  worldToGrid,
} from "../geometry.js";
import { TerritoryGrid } from "../territory.js";

describe("TerritoryGrid", () => {
  it("spawns circular base correctly", () => {
    const grid = new TerritoryGrid();
    const count = grid.spawnBase("player1", 0, 0);

    expect(count).toBeGreaterThan(30);
    expect(grid.isOwnTerritory("player1", 0, 0)).toBe(true);
    expect(grid.isOwnTerritory("player1", 50, 50)).toBe(false);
  });

  it("captures rectangular loop around unowned space", () => {
    const grid = new TerritoryGrid();
    const initialCount = grid.spawnBase("p1", 0, 0);

    // Initial base is around (0, 0)
    // Make a loop extending to the right and back:
    // (0,0) -> (10, 0) -> (10, 10) -> (0, 10) -> (0, 0)
    const trail = [
      { x: 3, y: 0 },
      { x: 15, y: 0 },
      { x: 15, y: 15 },
      { x: 0, y: 15 },
      { x: 0, y: 3 },
    ];

    const trappedPositions = new Map<string, { x: number; y: number }>();
    trappedPositions.set("p2", { x: 8, y: 8 }); // Inside loop
    trappedPositions.set("p3", { x: 30, y: 30 }); // Outside loop

    const result = grid.captureEnclosure("p1", trail, trappedPositions);

    expect(result.capturedCount).toBeGreaterThan(0);
    const totalCount = grid.countTerritoryCells("p1");
    expect(totalCount).toBeGreaterThan(initialCount);

    // p2 was trapped inside the loop
    expect(result.trappedPlayerIds).toContain("p2");
    // p3 was not trapped
    expect(result.trappedPlayerIds).not.toContain("p3");
  });

  it("clears territory upon player elimination", () => {
    const grid = new TerritoryGrid();
    grid.spawnBase("p1", 0, 0);
    expect(grid.countTerritoryCells("p1")).toBeGreaterThan(0);

    grid.clearPlayerTerritory("p1");
    expect(grid.countTerritoryCells("p1")).toBe(0);
  });
});

describe("Geometry and Collision", () => {
  it("detects circle intersecting line segment (trail cut)", () => {
    // Segment from (0, 0) to (10, 0)
    // Circle at (5, 0.5) with radius 1.0 should intersect
    expect(circleIntersectsSegment(5, 0.5, 1.0, 0, 0, 10, 0)).toBe(true);

    // Circle at (5, 3.0) with radius 1.0 should NOT intersect
    expect(circleIntersectsSegment(5, 3.0, 1.0, 0, 0, 10, 0)).toBe(false);

    // Circle beyond end of segment (12, 0) with radius 1.0
    expect(circleIntersectsSegment(12, 0, 1.0, 0, 0, 10, 0)).toBe(false);
  });

  it("computes distance to segment correctly", () => {
    const d = distToSegment(5, 4, 0, 0, 10, 0);
    expect(d).toBeCloseTo(4.0, 3);
  });
});
