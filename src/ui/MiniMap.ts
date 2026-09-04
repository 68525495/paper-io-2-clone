import {
  ARENA_SIZE,
  COLOR_PALETTE,
  GRID_CELLS,
  HALF_ARENA_SIZE,
} from "../shared/constants.js";
import {
  ARENA_CONTOUR,
  ArenaPoint,
} from "../shared/arenaShape.js";

export class MiniMap {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private size: number = 130;

  constructor(container: HTMLElement) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "minimap-canvas";
    this.canvas.width = this.size;
    this.canvas.height = this.size;
    container.appendChild(this.canvas);

    this.ctx = this.canvas.getContext("2d") as CanvasRenderingContext2D;
  }

  private worldToCanvas(point: ArenaPoint): { x: number; y: number } {
    return {
      x: ((point.x + HALF_ARENA_SIZE) / ARENA_SIZE) * this.size,
      y:
        this.size -
        ((point.y + HALF_ARENA_SIZE) / ARENA_SIZE) * this.size,
    };
  }

  private traceArenaPath() {
    const first = this.worldToCanvas(ARENA_CONTOUR[0]);
    this.ctx.beginPath();
    this.ctx.moveTo(first.x, first.y);
    for (let index = 1; index < ARENA_CONTOUR.length; index++) {
      const point = this.worldToCanvas(ARENA_CONTOUR[index]);
      this.ctx.lineTo(point.x, point.y);
    }
    this.ctx.closePath();
  }

  render(
    rawGrid: Uint8Array | number[],
    playerColors: Map<number, string>,
    players: Array<{ id: string; x: number; y: number; isLocal: boolean; color: string; alive: boolean }>
  ) {
    const ctx = this.ctx;
    const s = this.size;

    ctx.clearRect(0, 0, s, s);

    // 1. Draw and clip to the exact same canonical coastline as the 3D map.
    ctx.save();
    this.traceArenaPath();

    // Island background
    ctx.fillStyle = "#F5FCFA";
    ctx.fill();
    ctx.clip(); // Clip territory inside the island boundary

    // 2. Draw low-res territory pixels
    const step = 2; // Step 2 cells for fast rendering
    const cellW = s / GRID_CELLS;

    for (let gy = 0; gy < GRID_CELLS; gy += step) {
      for (let gx = 0; gx < GRID_CELLS; gx += step) {
        const ownerIdx = rawGrid[gy * GRID_CELLS + gx];
        if (ownerIdx === 0) continue;

        const color = playerColors.get(ownerIdx) || COLOR_PALETTE[(ownerIdx - 1) % COLOR_PALETTE.length];
        ctx.fillStyle = color;
        const mx = gx * cellW;
        const my = s - (gy + step) * cellW;
        ctx.fillRect(mx, my, cellW * step, cellW * step);
      }
    }

    // 3. Draw player radar dots within the same coastline clip.
    for (const p of players) {
      if (!p.alive) continue;

      const normX = (p.x + HALF_ARENA_SIZE) / ARENA_SIZE;
      const normY = 1 - (p.y + HALF_ARENA_SIZE) / ARENA_SIZE;

      const px = normX * s;
      const py = normY * s;

      if (p.isLocal) {
        // Local player has white halo and cute arrow/dot
        ctx.fillStyle = "#FFFFFF";
        ctx.beginPath();
        ctx.arc(px, py, 4.5, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(px, py, 3, 0, Math.PI * 2);
        ctx.fill();
      } else {
        // Other players
        ctx.fillStyle = "#222222";
        ctx.beginPath();
        ctx.arc(px, py, 2.5, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(px, py, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.restore();

    // 4. Keep the shared smooth coastline visible above territory and dots.
    this.traceArenaPath();
    ctx.lineWidth = 3.5;
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#2C5364";
    ctx.stroke();
  }
}
