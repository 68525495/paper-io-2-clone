import {
  ARENA_SIZE,
  COLOR_PALETTE,
  GRID_CELLS,
  HALF_ARENA_SIZE,
} from "../shared/constants.js";

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

  render(
    rawGrid: Uint8Array | number[],
    playerColors: Map<number, string>,
    players: Array<{ id: string; x: number; y: number; isLocal: boolean; color: string; alive: boolean }>
  ) {
    const ctx = this.ctx;
    const s = this.size;

    ctx.clearRect(0, 0, s, s);

    // 1. Draw organic island container shape (matching screenshot)
    ctx.save();
    ctx.beginPath();
    // Rounded organic path resembling the reference screenshot
    ctx.moveTo(s * 0.15, s * 0.45);
    ctx.bezierCurveTo(s * 0.05, s * 0.25, s * 0.35, s * 0.05, s * 0.65, s * 0.08);
    ctx.bezierCurveTo(s * 0.85, s * 0.1, s * 0.95, s * 0.35, s * 0.92, s * 0.65);
    ctx.bezierCurveTo(s * 0.9, s * 0.92, s * 0.55, s * 0.95, s * 0.35, s * 0.9);
    ctx.bezierCurveTo(s * 0.1, s * 0.85, s * 0.05, s * 0.65, s * 0.15, s * 0.45);
    ctx.closePath();

    // Island background
    ctx.fillStyle = "#F5FCFA";
    ctx.fill();

    // Island border outline (dark slate border matching screenshot)
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = "#2C5364";
    ctx.stroke();

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

    ctx.restore();

    // 3. Draw player radar dots
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
  }
}
