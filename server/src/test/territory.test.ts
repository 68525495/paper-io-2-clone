import { describe, expect, it } from "vitest";
import {
  ARENA_SIZE,
  CELL_SIZE,
  GRID_CELLS,
} from "../constants.js";
import {
  circleIntersectsSegment,
  distToSegment,
  gridToWorld,
  worldToGrid,
} from "../geometry.js";
import { TerritoryGrid } from "../territory.js";

describe("TerritoryGrid", () => {
  it("masks the ocean out of writes and playable-cell accounting", () => {
    const grid = new TerritoryGrid();
    const playerIndex = grid.registerPlayer("islander");

    expect(grid.playableCellCount).toBeGreaterThan(0);
    expect(grid.playableCellCount).toBeLessThan(grid.totalCells);
    expect(grid.playableCellCount).toBe(
      grid.playableMask.reduce((count, playable) => count + playable, 0)
    );
    expect(grid.countNeutralCells()).toBe(grid.playableCellCount);

    const oceanCorners = [
      [0, 0],
      [grid.width - 1, 0],
      [0, grid.height - 1],
      [grid.width - 1, grid.height - 1],
    ] as const;
    for (const [gx, gy] of oceanCorners) {
      expect(grid.isPlayableCell(gx, gy)).toBe(false);
      grid.setCell(gx, gy, playerIndex);
      expect(grid.getCell(gx, gy)).toBe(0);
    }
  });

  it("uses playableCellCount for territory percent and neutral cells", () => {
    const grid = new TerritoryGrid();
    const playerIndex = grid.registerPlayer("accounted-player");
    let ownedCells = 0;

    for (let gy = 0; gy < grid.height; gy++) {
      for (let gx = 0; gx < grid.width; gx++) {
        const index = gy * grid.width + gx;
        if (grid.playableMask[index] !== 1 || index % 2 !== 0) continue;
        grid.setCell(gx, gy, playerIndex);
        ownedCells++;
      }
    }

    expect(grid.countTerritoryCells("accounted-player")).toBe(ownedCells);
    expect(grid.countNeutralCells()).toBe(grid.playableCellCount - ownedCells);
    expect(grid.getTerritoryPercent("accounted-player")).toBe(
      Number(((ownedCells / grid.playableCellCount) * 100).toFixed(2))
    );
    expect(grid.getTerritoryPercent("accounted-player")).not.toBe(
      Number(((ownedCells / grid.totalCells) * 100).toFixed(2))
    );
  });

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

  it("never fills ocean cells during an enclosure capture", () => {
    const grid = new TerritoryGrid();
    grid.spawnBase("coastal-capturer", 0, 0);

    const result = grid.captureEnclosure(
      "coastal-capturer",
      [
        { x: -20, y: -20 },
        { x: 20, y: -20 },
        { x: 20, y: 20 },
        { x: -20, y: 20 },
        { x: -20, y: -20 },
      ],
      new Map()
    );

    expect(result.capturedCount).toBeGreaterThan(0);
    for (let index = 0; index < grid.totalCells; index++) {
      if (grid.playableMask[index] === 0) {
        expect(grid.cells[index]).toBe(0);
      }
    }
  });

  it("does not trap an opponent standing on existing territory outside the new enclosure", () => {
    const grid = new TerritoryGrid();
    grid.spawnBase("owner", 0, 0);
    const intruder = { x: -4, y: 0 };

    expect(grid.isOwnTerritory("owner", intruder.x, intruder.y)).toBe(true);

    const result = grid.captureEnclosure(
      "owner",
      [
        { x: 3, y: 0 },
        { x: 15, y: 0 },
        { x: 15, y: 15 },
        { x: 0, y: 15 },
        { x: 0, y: 3 },
      ],
      new Map([["intruder", intruder]])
    );

    expect(result.trappedPlayerIds).not.toContain("intruder");
  });

  it("clears territory upon player elimination", () => {
    const grid = new TerritoryGrid();
    grid.spawnBase("p1", 0, 0);
    expect(grid.countTerritoryCells("p1")).toBeGreaterThan(0);

    grid.clearPlayerTerritory("p1");
    expect(grid.countTerritoryCells("p1")).toBe(0);
  });

  it("finds the nearest owned boundary cell without returning an interior cell", () => {
    const grid = new TerritoryGrid();
    const playerIndex = grid.registerPlayer("p1");

    for (let gy = 126; gy <= 128; gy++) {
      for (let gx = 126; gx <= 128; gx++) {
        grid.setCell(gx, gy, playerIndex);
      }
    }

    const center = gridToWorld(127, 127);
    const cellsBeforeQuery = grid.cells.slice();
    const nearest = grid.findNearestOwnedBoundary("p1", center.x, center.y);

    expect(nearest).not.toBeNull();
    expect(nearest?.distance).toBeCloseTo(CELL_SIZE, 8);
    expect(worldToGrid(nearest!.x, nearest!.y)).not.toEqual({ gx: 127, gy: 127 });
    expect(grid.cells).toEqual(cellsBeforeQuery);
  });

  it("returns null when the player is unknown or owns no cells", () => {
    const grid = new TerritoryGrid();

    expect(grid.findNearestOwnedBoundary("missing", 0, 0)).toBeNull();

    grid.registerPlayer("registered");
    expect(grid.findNearestOwnedBoundary("registered", 0, 0)).toBeNull();
  });

  it("honors the maximum world distance inclusively", () => {
    const grid = new TerritoryGrid();
    const playerIndex = grid.registerPlayer("p1");
    const boundary = gridToWorld(80, 80);
    grid.setCell(80, 80, playerIndex);

    const queryX = boundary.x + CELL_SIZE * 4;
    const distance = CELL_SIZE * 4;

    expect(
      grid.findNearestOwnedBoundary("p1", queryX, boundary.y, distance - 0.001)
    ).toBeNull();
    expect(
      grid.findNearestOwnedBoundary("p1", queryX, boundary.y, distance)
    ).toEqual({
      x: boundary.x,
      y: boundary.y,
      distance,
    });
  });

  it("keeps searching when a later ring contains the Euclidean-nearest boundary", () => {
    const grid = new TerritoryGrid();
    const playerIndex = grid.registerPlayer("p1");
    const query = gridToWorld(100, 100);
    const earlierRingCorner = gridToWorld(103, 103);
    const laterRingAxis = gridToWorld(104, 100);
    grid.setCell(103, 103, playerIndex);
    grid.setCell(104, 100, playerIndex);

    expect(grid.findNearestOwnedBoundary("p1", query.x, query.y)).toEqual({
      x: laterRingAxis.x,
      y: laterRingAxis.y,
      distance: CELL_SIZE * 4,
    });
    expect(
      Math.hypot(earlierRingCorner.x - query.x, earlierRingCorner.y - query.y)
    ).toBeGreaterThan(CELL_SIZE * 4);
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
