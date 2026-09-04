import { describe, expect, it } from "vitest";
import {
  ARENA_SIZE,
  CELL_SIZE,
  GRID_CELLS,
  PLAYER_RADIUS,
} from "../constants.js";
import { sampleArenaContour } from "../arenaShape.js";
import {
  circleIntersectsSegment,
  distToSegment,
  gridToWorld,
  worldToGrid,
} from "../geometry.js";
import { TerritoryGrid } from "../territory.js";
import { extractSmoothedPlayerContours } from "../../../src/shared/contour.js";

function expectOwnedCellsToBeFourConnected(
  grid: TerritoryGrid,
  playerId: string
) {
  const playerIndex = grid.getPlayerIndex(playerId);
  const ownedCells: number[] = [];

  for (let gy = 0; gy < grid.height; gy++) {
    for (let gx = 0; gx < grid.width; gx++) {
      if (grid.getCell(gx, gy) === playerIndex) {
        ownedCells.push(gy * grid.width + gx);
      }
    }
  }

  expect(ownedCells.length).toBeGreaterThan(0);

  const owned = new Set(ownedCells);
  const visited = new Set<number>();
  const pending = [ownedCells[0]];

  while (pending.length > 0) {
    const index = pending.pop()!;
    if (visited.has(index)) continue;
    visited.add(index);

    const gx = index % grid.width;
    const gy = Math.floor(index / grid.width);
    const neighbors = [
      [gx - 1, gy],
      [gx + 1, gy],
      [gx, gy - 1],
      [gx, gy + 1],
    ] as const;

    for (const [neighborX, neighborY] of neighbors) {
      const neighborIndex = neighborY * grid.width + neighborX;
      if (
        neighborX >= 0 &&
        neighborX < grid.width &&
        neighborY >= 0 &&
        neighborY < grid.height &&
        owned.has(neighborIndex) &&
        !visited.has(neighborIndex)
      ) {
        pending.push(neighborIndex);
      }
    }
  }

  expect(visited.size).toBe(ownedCells.length);
}

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

  it("reserves the displayed 100 percent value for exact full ownership", () => {
    const grid = new TerritoryGrid();
    const playerId = "completionist";
    const playerIndex = grid.registerPlayer(playerId);
    let lastPlayableCell = -1;

    for (let index = 0; index < grid.totalCells; index++) {
      if (grid.playableMask[index] !== 1) continue;
      grid.cells[index] = playerIndex;
      lastPlayableCell = index;
    }

    grid.cells[lastPlayableCell] = 0;
    expect(grid.getTerritoryPercent(playerId)).toBe(99.99);

    grid.cells[lastPlayableCell] = playerIndex;
    expect(grid.getTerritoryPercent(playerId)).toBe(100);
  });

  it("turns a legal outer-boundary capture into an exact full-map occupation", () => {
    const grid = new TerritoryGrid();
    const playerId = "coast-conqueror";
    grid.registerPlayer(playerId);
    const outerRoute = sampleArenaContour(512, PLAYER_RADIUS);
    outerRoute.push({ ...outerRoute[0] });

    grid.captureEnclosure(playerId, outerRoute, new Map());

    expect(grid.countNeutralCells()).toBeGreaterThan(0);
    expect(grid.getTerritoryPercent(playerId)).toBeLessThan(100);
    expect(grid.tryFinalizeMapOccupation(playerId)).toBe(true);
    expect(grid.countNeutralCells()).toBe(0);
    expect(grid.countTerritoryCells(playerId)).toBe(grid.playableCellCount);
    expect(grid.getTerritoryPercent(playerId)).toBe(100);
  });

  it("never awards a boundary-mapped cell that is still owned by a rival", () => {
    const grid = new TerritoryGrid();
    const playerId = "interior-owner";
    const rivalId = "coastal-rival";
    const playerIndex = grid.registerPlayer(playerId);
    const rivalIndex = grid.registerPlayer(rivalId);

    for (let index = 0; index < grid.totalCells; index++) {
      if (grid.completionMask[index] === 1) grid.cells[index] = playerIndex;
    }

    const legalBoundaryRoute = sampleArenaContour(512, PLAYER_RADIUS);
    const rivalCell = legalBoundaryRoute
      .map((point) => worldToGrid(point.x, point.y))
      .map(({ gx, gy }) => gy * grid.width + gx)
      .find((index) => grid.completionMask[index] === 0);
    expect(rivalCell).toBeDefined();
    grid.cells[rivalCell!] = rivalIndex;

    expect(grid.tryFinalizeMapOccupation(playerId)).toBe(false);
    expect(grid.cells[rivalCell!]).toBe(rivalIndex);
    expect(grid.getTerritoryPercent(playerId)).toBeLessThan(100);
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

  it.each([
    ["45-degree down-right", 18, 18],
    ["45-degree up-left", -18, -18],
    ["45-degree up-right", 18, -18],
    ["45-degree down-left", -18, 18],
    ["shallow down-right", 18, 7],
    ["steep down-right", 7, 18],
    ["shallow down-left", -18, 7],
    ["steep down-left", -7, 18],
    ["shallow up-left", -18, -7],
    ["steep up-left", -7, -18],
    ["shallow up-right", 18, -7],
    ["steep up-right", 7, -18],
    ["horizontal", 18, 0],
    ["vertical", 0, 18],
    ["zero-length", 0, 0],
  ])("keeps a captured %s trail 4-connected", (_name, dx, dy) => {
    const grid = new TerritoryGrid();
    const playerId = "diagonal-capturer";
    grid.registerPlayer(playerId);

    const start = { gx: 128, gy: 128 };
    const end = { gx: start.gx + dx, gy: start.gy + dy };
    const result = grid.captureEnclosure(
      playerId,
      [
        gridToWorld(start.gx, start.gy),
        gridToWorld(end.gx, end.gy),
      ],
      new Map()
    );

    expect(result.capturedCount).toBe(Math.abs(dx) + Math.abs(dy) + 1);
    expectOwnedCellsToBeFourConnected(grid, playerId);
    expect(
      extractSmoothedPlayerContours(
        grid.cells,
        grid.getPlayerIndex(playerId),
        {
          gridSize: GRID_CELLS,
          simplifyTolerance: 0.9,
          chaikinIterations: 3,
          maxDeviation: 0.8,
        }
      )
    ).toHaveLength(1);

    const reverseGrid = new TerritoryGrid();
    reverseGrid.registerPlayer(playerId);
    reverseGrid.captureEnclosure(
      playerId,
      [
        gridToWorld(end.gx, end.gy),
        gridToWorld(start.gx, start.gy),
      ],
      new Map()
    );
    expect(reverseGrid.cells).toEqual(grid.cells);
  });

  it("uses the playable bridge when a diagonal trail runs beside the coast", () => {
    const grid = new TerritoryGrid();
    const playerId = "coastal-diagonal-capturer";
    const playerIndex = grid.registerPlayer(playerId);
    const start = { gx: 131, gy: 14 };
    const end = { gx: 130, gy: 15 };
    const oceanBridge = { gx: 130, gy: 14 };
    const playableBridge = { gx: 131, gy: 15 };

    expect(grid.isPlayableCell(start.gx, start.gy)).toBe(true);
    expect(grid.isPlayableCell(end.gx, end.gy)).toBe(true);
    expect(grid.isPlayableCell(oceanBridge.gx, oceanBridge.gy)).toBe(false);
    expect(grid.isPlayableCell(playableBridge.gx, playableBridge.gy)).toBe(true);

    const result = grid.captureEnclosure(
      playerId,
      [
        gridToWorld(start.gx, start.gy),
        gridToWorld(end.gx, end.gy),
      ],
      new Map()
    );

    expect(result.capturedCount).toBe(3);
    expect(grid.getCell(oceanBridge.gx, oceanBridge.gy)).toBe(0);
    expect(grid.getCell(playableBridge.gx, playableBridge.gy)).toBe(playerIndex);
    expectOwnedCellsToBeFourConnected(grid, playerId);
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
