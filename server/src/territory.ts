import {
  CELL_SIZE,
  GRID_CELLS,
  HALF_ARENA_SIZE,
  INITIAL_BASE_RADIUS_CELLS,
} from "./constants.js";
import { isPointInsideArena } from "./arenaShape.js";
import { clamp, gridToWorld, worldToGrid } from "./geometry.js";

export interface TerritoryCaptureResult {
  capturedCount: number;
  newPercent: number;
  centerX: number;
  centerY: number;
  trappedPlayerIds: string[];
}

export interface OwnedBoundaryPoint {
  x: number;
  y: number;
  distance: number;
}

export class TerritoryGrid {
  readonly width: number = GRID_CELLS;
  readonly height: number = GRID_CELLS;
  readonly totalCells: number = GRID_CELLS * GRID_CELLS;

  /** Grid storing player indices: 0 = neutral, 1..255 = playerIndex */
  readonly cells: Uint8Array;
  /** 1 for cells whose center is inside the organic island boundary. */
  readonly playableMask: Uint8Array;
  readonly playableCellCount: number;

  /** Map player ID (string) to numeric player index (1..255) */
  private playerIndices = new Map<string, number>();
  private indexToPlayerId = new Map<number, string>();
  private nextIndex = 1;

  constructor() {
    this.cells = new Uint8Array(this.totalCells);
    this.playableMask = new Uint8Array(this.totalCells);

    let playableCellCount = 0;
    for (let gy = 0; gy < this.height; gy++) {
      for (let gx = 0; gx < this.width; gx++) {
        const point = gridToWorld(gx, gy);
        if (!isPointInsideArena(point.x, point.y)) continue;
        this.playableMask[gy * this.width + gx] = 1;
        playableCellCount++;
      }
    }
    this.playableCellCount = playableCellCount;
  }

  registerPlayer(playerId: string): number {
    let idx = this.playerIndices.get(playerId);
    if (idx) return idx;

    // Find first available index 1..255
    for (let i = 1; i <= 255; i++) {
      if (!this.indexToPlayerId.has(i)) {
        idx = i;
        break;
      }
    }
    if (!idx) idx = (this.nextIndex++ % 254) + 1;

    this.playerIndices.set(playerId, idx);
    this.indexToPlayerId.set(idx, playerId);
    return idx;
  }

  unregisterPlayer(playerId: string) {
    const idx = this.playerIndices.get(playerId);
    if (idx) {
      this.clearPlayerTerritory(playerId);
      this.playerIndices.delete(playerId);
      this.indexToPlayerId.delete(idx);
    }
  }

  getPlayerIndex(playerId: string): number {
    return this.playerIndices.get(playerId) || 0;
  }

  getPlayerId(index: number): string | undefined {
    return this.indexToPlayerId.get(index);
  }

  getCell(gx: number, gy: number): number {
    if (gx < 0 || gx >= this.width || gy < 0 || gy >= this.height) return 0;
    return this.cells[gy * this.width + gx];
  }

  isPlayableCell(gx: number, gy: number): boolean {
    if (gx < 0 || gx >= this.width || gy < 0 || gy >= this.height) {
      return false;
    }
    return this.playableMask[gy * this.width + gx] === 1;
  }

  setCell(gx: number, gy: number, val: number) {
    if (gx < 0 || gx >= this.width || gy < 0 || gy >= this.height) return;
    if (!this.isPlayableCell(gx, gy)) return;
    this.cells[gy * this.width + gx] = val;
  }

  isOwnTerritory(playerId: string, worldX: number, worldY: number): boolean {
    const idx = this.playerIndices.get(playerId);
    if (!idx || !isPointInsideArena(worldX, worldY)) return false;
    const { gx, gy } = worldToGrid(worldX, worldY);
    return this.isPlayableCell(gx, gy) && this.getCell(gx, gy) === idx;
  }

  /**
   * Find the owned boundary cell whose center is closest to a world position.
   * A boundary cell has at least one 4-connected neighbor that is outside the
   * grid or not owned by the player. This query never changes cell ownership.
   */
  findNearestOwnedBoundary(
    playerId: string,
    worldX: number,
    worldY: number,
    maxWorldDistance?: number
  ): OwnedBoundaryPoint | null {
    const playerIdx = this.playerIndices.get(playerId);
    if (!playerIdx || !Number.isFinite(worldX) || !Number.isFinite(worldY)) {
      return null;
    }
    if (
      maxWorldDistance !== undefined &&
      (Number.isNaN(maxWorldDistance) || maxWorldDistance < 0)
    ) {
      return null;
    }

    const maxDistanceSq =
      maxWorldDistance === undefined || maxWorldDistance === Infinity
        ? Infinity
        : maxWorldDistance * maxWorldDistance;
    const hasFiniteDistanceLimit = Number.isFinite(maxWorldDistance);
    let searchMinX = 0;
    let searchMaxX = this.width - 1;
    let searchMinY = 0;
    let searchMaxY = this.height - 1;

    if (hasFiniteDistanceLimit) {
      const maxDistance = maxWorldDistance!;
      const rawMinX = Math.ceil(
        (worldX - maxDistance + HALF_ARENA_SIZE) / CELL_SIZE - 0.5
      );
      const rawMaxX = Math.floor(
        (worldX + maxDistance + HALF_ARENA_SIZE) / CELL_SIZE - 0.5
      );
      const rawMinY = Math.ceil(
        (worldY - maxDistance + HALF_ARENA_SIZE) / CELL_SIZE - 0.5
      );
      const rawMaxY = Math.floor(
        (worldY + maxDistance + HALF_ARENA_SIZE) / CELL_SIZE - 0.5
      );

      if (
        rawMaxX < 0 ||
        rawMinX >= this.width ||
        rawMaxY < 0 ||
        rawMinY >= this.height ||
        rawMinX > rawMaxX ||
        rawMinY > rawMaxY
      ) {
        return null;
      }

      searchMinX = clamp(rawMinX, 0, this.width - 1);
      searchMaxX = clamp(rawMaxX, 0, this.width - 1);
      searchMinY = clamp(rawMinY, 0, this.height - 1);
      searchMaxY = clamp(rawMaxY, 0, this.height - 1);
    }

    const origin = worldToGrid(worldX, worldY);
    const maxRing = Math.max(
      origin.gx - searchMinX,
      searchMaxX - origin.gx,
      origin.gy - searchMinY,
      searchMaxY - origin.gy
    );
    let bestGridX = -1;
    let bestGridY = -1;
    let bestDistanceSq = maxDistanceSq;

    const considerCell = (gx: number, gy: number) => {
      const point = gridToWorld(gx, gy);
      const dx = point.x - worldX;
      const dy = point.y - worldY;
      const distanceSq = dx * dx + dy * dy;
      if (distanceSq > bestDistanceSq) return;

      const rowOffset = gy * this.width;
      const cellIndex = rowOffset + gx;
      if (this.cells[cellIndex] !== playerIdx) return;

      const isBoundary =
        gx === 0 ||
        gx === this.width - 1 ||
        gy === 0 ||
        gy === this.height - 1 ||
        this.cells[cellIndex - 1] !== playerIdx ||
        this.cells[cellIndex + 1] !== playerIdx ||
        this.cells[cellIndex - this.width] !== playerIdx ||
        this.cells[cellIndex + this.width] !== playerIdx;
      if (!isBoundary) return;
      if (bestGridX !== -1 && distanceSq === bestDistanceSq) return;

      bestGridX = gx;
      bestGridY = gy;
      bestDistanceSq = distanceSq;
    };

    for (let ring = 0; ring <= maxRing; ring++) {
      const ringMinX = origin.gx - ring;
      const ringMaxX = origin.gx + ring;
      const ringMinY = origin.gy - ring;
      const ringMaxY = origin.gy + ring;
      const minX = Math.max(searchMinX, ringMinX);
      const maxX = Math.min(searchMaxX, ringMaxX);

      if (ring === 0) {
        if (
          origin.gx >= searchMinX &&
          origin.gx <= searchMaxX &&
          origin.gy >= searchMinY &&
          origin.gy <= searchMaxY
        ) {
          considerCell(origin.gx, origin.gy);
        }
      } else {
        if (ringMinY >= searchMinY && ringMinY <= searchMaxY) {
          for (let gx = minX; gx <= maxX; gx++) considerCell(gx, ringMinY);
        }
        if (
          ringMaxY !== ringMinY &&
          ringMaxY >= searchMinY &&
          ringMaxY <= searchMaxY
        ) {
          for (let gx = minX; gx <= maxX; gx++) considerCell(gx, ringMaxY);
        }

        const minY = Math.max(searchMinY, ringMinY + 1);
        const maxY = Math.min(searchMaxY, ringMaxY - 1);
        if (ringMinX >= searchMinX && ringMinX <= searchMaxX) {
          for (let gy = minY; gy <= maxY; gy++) considerCell(ringMinX, gy);
        }
        if (
          ringMaxX !== ringMinX &&
          ringMaxX >= searchMinX &&
          ringMaxX <= searchMaxX
        ) {
          for (let gy = minY; gy <= maxY; gy++) considerCell(ringMaxX, gy);
        }
      }

      if (bestGridX !== -1) {
        const scannedMinX = Math.max(searchMinX, ringMinX);
        const scannedMaxX = Math.min(searchMaxX, ringMaxX);
        const scannedMinY = Math.max(searchMinY, ringMinY);
        const scannedMaxY = Math.min(searchMaxY, ringMaxY);
        let unscannedDistanceLowerBound = Infinity;

        if (scannedMinX > searchMinX) {
          const nextX = gridToWorld(scannedMinX - 1, origin.gy).x;
          unscannedDistanceLowerBound = Math.min(
            unscannedDistanceLowerBound,
            Math.abs(nextX - worldX)
          );
        }
        if (scannedMaxX < searchMaxX) {
          const nextX = gridToWorld(scannedMaxX + 1, origin.gy).x;
          unscannedDistanceLowerBound = Math.min(
            unscannedDistanceLowerBound,
            Math.abs(nextX - worldX)
          );
        }
        if (scannedMinY > searchMinY) {
          const nextY = gridToWorld(origin.gx, scannedMinY - 1).y;
          unscannedDistanceLowerBound = Math.min(
            unscannedDistanceLowerBound,
            Math.abs(nextY - worldY)
          );
        }
        if (scannedMaxY < searchMaxY) {
          const nextY = gridToWorld(origin.gx, scannedMaxY + 1).y;
          unscannedDistanceLowerBound = Math.min(
            unscannedDistanceLowerBound,
            Math.abs(nextY - worldY)
          );
        }

        if (bestDistanceSq <= unscannedDistanceLowerBound ** 2) break;
      }
    }

    if (bestGridX === -1) return null;
    const point = gridToWorld(bestGridX, bestGridY);
    return {
      x: point.x,
      y: point.y,
      distance: Math.sqrt(bestDistanceSq),
    };
  }

  /** Spawn circular initial base */
  spawnBase(playerId: string, worldX: number, worldY: number): number {
    const idx = this.registerPlayer(playerId);
    const { gx, gy } = worldToGrid(worldX, worldY);
    const r = INITIAL_BASE_RADIUS_CELLS;
    let count = 0;

    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy <= r * r + 1) {
          const cx = gx + dx;
          const cy = gy + dy;
          if (!this.isPlayableCell(cx, cy)) continue;
          this.setCell(cx, cy, idx);
          count++;
        }
      }
    }
    return count;
  }

  clearPlayerTerritory(playerId: string) {
    const idx = this.playerIndices.get(playerId);
    if (!idx) return;

    for (let i = 0; i < this.totalCells; i++) {
      if (this.cells[i] === idx) {
        this.cells[i] = 0;
      }
    }
  }

  /** Transfer all territory cells of victim to killer */
  transferPlayerTerritory(fromPlayerId: string, toPlayerId: string): number {
    const fromIdx = this.playerIndices.get(fromPlayerId);
    const toIdx = this.registerPlayer(toPlayerId);
    if (!fromIdx || !toIdx) return 0;

    let count = 0;
    for (let i = 0; i < this.totalCells; i++) {
      if (this.cells[i] === fromIdx) {
        this.cells[i] = toIdx;
        count++;
      }
    }
    return count;
  }

  countTerritoryCells(playerId: string): number {
    const idx = this.playerIndices.get(playerId);
    if (!idx) return 0;

    let count = 0;
    for (let i = 0; i < this.totalCells; i++) {
      if (this.cells[i] === idx) count++;
    }
    return count;
  }

  getTerritoryPercent(playerId: string): number {
    const count = this.countTerritoryCells(playerId);
    return Number(((count / this.playableCellCount) * 100).toFixed(2));
  }

  countNeutralCells(): number {
    let count = 0;
    for (let i = 0; i < this.totalCells; i++) {
      if (this.playableMask[i] === 1 && this.cells[i] === 0) count++;
    }
    return count;
  }

  /**
   * Enclosure capture algorithm:
   * 1. Rasterize trail points onto a trail mask.
   * 2. Perform a virtual padded BFS (width+2, height+2) from outside edges.
   *    Any cell blocked by (existing territory OR trail mask) is a barrier.
   * 3. Cells that are unreachable from the outside boundary are enclosed!
   * 4. Fill enclosed cells + trail cells with player's index.
   */
  captureEnclosure(
    playerId: string,
    trail: Array<{ x: number; y: number }>,
    otherPlayerPositions: Map<string, { x: number; y: number }>
  ): TerritoryCaptureResult {
    const playerIdx = this.playerIndices.get(playerId);
    if (!playerIdx || trail.length === 0) {
      return {
        capturedCount: 0,
        newPercent: 0,
        centerX: 0,
        centerY: 0,
        trappedPlayerIds: [],
      };
    }

    const trailMask = new Uint8Array(this.totalCells);

    // Rasterize trail segments using Bresenham algorithm
    for (let i = 0; i < trail.length - 1; i++) {
      const p1 = worldToGrid(trail[i].x, trail[i].y);
      const p2 = worldToGrid(trail[i + 1].x, trail[i + 1].y);
      this.rasterizeLine(p1.gx, p1.gy, p2.gx, p2.gy, trailMask);
    }

    // Also mark individual trail points to ensure coverage
    for (const pt of trail) {
      const g = worldToGrid(pt.x, pt.y);
      const gridIdx = g.gy * this.width + g.gx;
      if (this.playableMask[gridIdx] === 1) trailMask[gridIdx] = 1;
    }

    // Padded BFS: grid dimensions +2 for virtual boundary padding
    const pWidth = this.width + 2;
    const pHeight = this.height + 2;
    const pTotal = pWidth * pHeight;
    const visited = new Uint8Array(pTotal);

    // BFS queue (using typed array for speed)
    const queue = new Int32Array(pTotal);
    let head = 0;
    let tail = 0;

    // Start BFS from outer padded boundary (0, 0)
    queue[tail++] = 0;
    visited[0] = 1;

    while (head < tail) {
      const idx = queue[head++];
      const px = idx % pWidth;
      const py = Math.floor(idx / pWidth);

      // 4 neighbors
      const neighbors = [
        [px + 1, py],
        [px - 1, py],
        [px, py + 1],
        [px, py - 1],
      ];

      for (let n = 0; n < 4; n++) {
        const nx = neighbors[n][0];
        const ny = neighbors[n][1];

        if (nx < 0 || nx >= pWidth || ny < 0 || ny >= pHeight) continue;
        const nIdx = ny * pWidth + nx;
        if (visited[nIdx]) continue;

        // Check if neighbor is a barrier in actual grid coordinates
        const gx = nx - 1;
        const gy = ny - 1;

        if (gx >= 0 && gx < this.width && gy >= 0 && gy < this.height) {
          const gridIdx = gy * this.width + gx;
          const isBarrier =
            this.playableMask[gridIdx] === 1 &&
            (this.cells[gridIdx] === playerIdx || trailMask[gridIdx] === 1);
          if (isBarrier) {
            // Do not cross barrier
            continue;
          }
        }

        visited[nIdx] = 1;
        queue[tail++] = nIdx;
      }
    }

    // Existing territory is unvisited because it is a BFS barrier, but it is
    // not part of the newly enclosed area. Evaluate positions before the fill
    // below overwrites captured ownership.
    const trappedPlayerIds: string[] = [];
    for (const [otherId, pos] of otherPlayerPositions) {
      if (otherId === playerId) continue;
      if (!isPointInsideArena(pos.x, pos.y)) continue;
      const g = worldToGrid(pos.x, pos.y);
      const gridIdx = g.gy * this.width + g.gx;
      if (this.playableMask[gridIdx] !== 1) continue;
      const pIdx = (g.gy + 1) * pWidth + (g.gx + 1);
      const wasOwnedBeforeCapture = this.cells[gridIdx] === playerIdx;
      if (!wasOwnedBeforeCapture && visited[pIdx] === 0) {
        trappedPlayerIds.push(otherId);
      }
    }

    // Any cell in the actual grid that was NOT visited is enclosed!
    let capturedCount = 0;
    let sumX = 0;
    let sumY = 0;

    for (let gy = 0; gy < this.height; gy++) {
      for (let gx = 0; gx < this.width; gx++) {
        const pIdx = (gy + 1) * pWidth + (gx + 1);
        const gridIdx = gy * this.width + gx;
        if (this.playableMask[gridIdx] !== 1) continue;
        const isTrail = trailMask[gridIdx] === 1;
        const isEnclosed = visited[pIdx] === 0;

        if (isEnclosed || isTrail) {
          if (this.cells[gridIdx] !== playerIdx) {
            this.cells[gridIdx] = playerIdx;
            capturedCount++;
            sumX += (gx + 0.5) * CELL_SIZE - HALF_ARENA_SIZE;
            sumY += (gy + 0.5) * CELL_SIZE - HALF_ARENA_SIZE;
          }
        }
      }
    }

    // Check if another player's entire territory was surrounded/engulfed
    this.playerIndices.forEach((otherIdx, otherId) => {
      if (otherId === playerId || trappedPlayerIds.includes(otherId)) return;
      let otherTotal = 0;
      let otherEnclosed = 0;
      for (let gy = 0; gy < this.height; gy++) {
        for (let gx = 0; gx < this.width; gx++) {
          const gridIdx = gy * this.width + gx;
          if (this.cells[gridIdx] === otherIdx) {
            otherTotal++;
            const pIdx = (gy + 1) * pWidth + (gx + 1);
            if (visited[pIdx] === 0) {
              otherEnclosed++;
            }
          }
        }
      }
      if (otherTotal > 0 && otherEnclosed === otherTotal) {
        trappedPlayerIds.push(otherId);
      }
    });

    const totalCellsOwned = this.countTerritoryCells(playerId);
    const newPercent = Number(
      ((totalCellsOwned / this.playableCellCount) * 100).toFixed(2)
    );
    const centerX = capturedCount > 0 ? sumX / capturedCount : 0;
    const centerY = capturedCount > 0 ? sumY / capturedCount : 0;

    return {
      capturedCount,
      newPercent,
      centerX,
      centerY,
      trappedPlayerIds,
    };
  }

  /** Rasterize line using Bresenham algorithm */
  private rasterizeLine(x0: number, y0: number, x1: number, y1: number, mask: Uint8Array) {
    let dx = Math.abs(x1 - x0);
    let dy = Math.abs(y1 - y0);
    let sx = x0 < x1 ? 1 : -1;
    let sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;

    let x = x0;
    let y = y0;

    while (true) {
      if (x >= 0 && x < this.width && y >= 0 && y < this.height) {
        const index = y * this.width + x;
        if (this.playableMask[index] === 1) mask[index] = 1;
      }
      if (x === x1 && y === y1) break;
      let e2 = 2 * err;
      if (e2 > -dy) {
        err -= dy;
        x += sx;
      }
      if (e2 < dx) {
        err += dx;
        y += sy;
      }
    }
  }

  /** Get snapshot of cells for client initial sync or minimap */
  getRawCells(): Uint8Array {
    return this.cells;
  }
}
