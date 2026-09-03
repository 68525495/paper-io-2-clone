import {
  CELL_SIZE,
  GRID_CELLS,
  HALF_ARENA_SIZE,
  INITIAL_BASE_RADIUS_CELLS,
} from "./constants.js";
import { clamp, worldToGrid } from "./geometry.js";

export interface TerritoryCaptureResult {
  capturedCount: number;
  newPercent: number;
  centerX: number;
  centerY: number;
  trappedPlayerIds: string[];
}

export class TerritoryGrid {
  readonly width: number = GRID_CELLS;
  readonly height: number = GRID_CELLS;
  readonly totalCells: number = GRID_CELLS * GRID_CELLS;

  /** Grid storing player indices: 0 = neutral, 1..255 = playerIndex */
  readonly cells: Uint8Array;

  /** Map player ID (string) to numeric player index (1..255) */
  private playerIndices = new Map<string, number>();
  private indexToPlayerId = new Map<number, string>();
  private nextIndex = 1;

  constructor() {
    this.cells = new Uint8Array(this.totalCells);
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

  setCell(gx: number, gy: number, val: number) {
    if (gx < 0 || gx >= this.width || gy < 0 || gy >= this.height) return;
    this.cells[gy * this.width + gx] = val;
  }

  isOwnTerritory(playerId: string, worldX: number, worldY: number): boolean {
    const idx = this.playerIndices.get(playerId);
    if (!idx) return false;
    const { gx, gy } = worldToGrid(worldX, worldY);
    return this.getCell(gx, gy) === idx;
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
          const cx = clamp(gx + dx, 0, this.width - 1);
          const cy = clamp(gy + dy, 0, this.height - 1);
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
    return Number(((count / this.totalCells) * 100).toFixed(2));
  }

  countNeutralCells(): number {
    let count = 0;
    for (let i = 0; i < this.totalCells; i++) {
      if (this.cells[i] === 0) count++;
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
      trailMask[g.gy * this.width + g.gx] = 1;
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
          const isBarrier = this.cells[gridIdx] === playerIdx || trailMask[gridIdx] === 1;
          if (isBarrier) {
            // Do not cross barrier
            continue;
          }
        }

        visited[nIdx] = 1;
        queue[tail++] = nIdx;
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

    // Check if any other player was trapped inside or their territory was engulfed
    const trappedPlayerIds: string[] = [];
    for (const [otherId, pos] of otherPlayerPositions) {
      if (otherId === playerId) continue;
      const g = worldToGrid(pos.x, pos.y);
      const pIdx = (g.gy + 1) * pWidth + (g.gx + 1);
      if (visited[pIdx] === 0) {
        // Player body was inside the enclosed region!
        trappedPlayerIds.push(otherId);
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
    const newPercent = Number(((totalCellsOwned / this.totalCells) * 100).toFixed(2));
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
        mask[y * this.width + x] = 1;
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
