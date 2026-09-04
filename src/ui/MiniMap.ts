import {
  ARENA_SIZE,
  COLOR_PALETTE,
  GRID_CELLS,
  HALF_ARENA_SIZE,
} from "../shared/constants.js";
import {
  ARENA_CONTOUR,
  type ArenaPoint,
} from "../shared/arenaShape.js";

export interface MiniMapPlayer {
  id: string;
  x: number;
  y: number;
  isLocal: boolean;
  color: string;
  alive: boolean;
}

const TERRITORY_SAMPLE_STEP = 2;
export const MINIMAP_RASTER_SIZE = GRID_CELLS / TERRITORY_SAMPLE_STEP;

function parseHexColor(color: string): [number, number, number] {
  const normalized = color.startsWith("#") ? color.slice(1) : color;
  if (/^[0-9a-fA-F]{6}$/.test(normalized)) {
    const value = Number.parseInt(normalized, 16);
    return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
  }
  return [255, 255, 255];
}

/** Writes one RGBA output pixel for each sampled 2x2 ownership block. */
export function rasterizeMiniMapTerritory(
  rawGrid: Uint8Array | number[],
  playerColors: Map<number, string>,
  pixels: Uint8ClampedArray
) {
  const expectedLength = MINIMAP_RASTER_SIZE * MINIMAP_RASTER_SIZE * 4;
  if (pixels.length !== expectedLength) {
    throw new Error(`Expected ${expectedLength} minimap RGBA values, got ${pixels.length}`);
  }

  const resolvedColors = new Map<number, [number, number, number]>();
  for (let rasterY = 0; rasterY < MINIMAP_RASTER_SIZE; rasterY++) {
    const gridY = (MINIMAP_RASTER_SIZE - 1 - rasterY) * TERRITORY_SAMPLE_STEP;
    for (let rasterX = 0; rasterX < MINIMAP_RASTER_SIZE; rasterX++) {
      const gridX = rasterX * TERRITORY_SAMPLE_STEP;
      const owner = rawGrid[gridY * GRID_CELLS + gridX] || 0;
      const offset = (rasterY * MINIMAP_RASTER_SIZE + rasterX) * 4;
      if (owner === 0) {
        pixels[offset] = 0;
        pixels[offset + 1] = 0;
        pixels[offset + 2] = 0;
        pixels[offset + 3] = 0;
        continue;
      }

      let rgb = resolvedColors.get(owner);
      if (!rgb) {
        const color =
          playerColors.get(owner) ||
          COLOR_PALETTE[(owner - 1) % COLOR_PALETTE.length];
        rgb = parseHexColor(color);
        resolvedColors.set(owner, rgb);
      }
      pixels[offset] = rgb[0];
      pixels[offset + 1] = rgb[1];
      pixels[offset + 2] = rgb[2];
      pixels[offset + 3] = 255;
    }
  }
}

export class MiniMap {
  private territoryCanvas: HTMLCanvasElement;
  private playerCanvas: HTMLCanvasElement;
  private territoryContext: CanvasRenderingContext2D;
  private playerContext: CanvasRenderingContext2D;
  private rasterCanvas: HTMLCanvasElement;
  private rasterContext: CanvasRenderingContext2D;
  private rasterImage: ImageData;
  private size: number = 130;

  constructor(container: HTMLElement) {
    this.territoryCanvas = this.createLayer("minimap-territory-layer");
    this.playerCanvas = this.createLayer("minimap-player-layer");
    container.append(this.territoryCanvas, this.playerCanvas);

    this.territoryContext = this.territoryCanvas.getContext("2d") as CanvasRenderingContext2D;
    this.playerContext = this.playerCanvas.getContext("2d") as CanvasRenderingContext2D;

    this.rasterCanvas = document.createElement("canvas");
    this.rasterCanvas.width = MINIMAP_RASTER_SIZE;
    this.rasterCanvas.height = MINIMAP_RASTER_SIZE;
    this.rasterContext = this.rasterCanvas.getContext("2d") as CanvasRenderingContext2D;
    this.rasterImage = this.rasterContext.createImageData(
      MINIMAP_RASTER_SIZE,
      MINIMAP_RASTER_SIZE
    );

    this.updateTerritory(
      new Uint8Array(GRID_CELLS * GRID_CELLS),
      new Map<number, string>()
    );
  }

  private createLayer(layerClass: string): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    canvas.className = `minimap-canvas ${layerClass}`;
    canvas.width = this.size;
    canvas.height = this.size;
    canvas.setAttribute("aria-hidden", "true");
    return canvas;
  }

  private worldToCanvas(point: ArenaPoint): { x: number; y: number } {
    return {
      x: ((point.x + HALF_ARENA_SIZE) / ARENA_SIZE) * this.size,
      y:
        this.size -
        ((point.y + HALF_ARENA_SIZE) / ARENA_SIZE) * this.size,
    };
  }

  private traceArenaPath(ctx: CanvasRenderingContext2D) {
    const first = this.worldToCanvas(ARENA_CONTOUR[0]);
    ctx.beginPath();
    ctx.moveTo(first.x, first.y);
    for (let index = 1; index < ARENA_CONTOUR.length; index++) {
      const point = this.worldToCanvas(ARENA_CONTOUR[index]);
      ctx.lineTo(point.x, point.y);
    }
    ctx.closePath();
  }

  /** Rebuilds the static territory layer only after an authoritative grid update. */
  updateTerritory(
    rawGrid: Uint8Array | number[],
    playerColors: Map<number, string>
  ) {
    rasterizeMiniMapTerritory(rawGrid, playerColors, this.rasterImage.data);
    this.rasterContext.putImageData(this.rasterImage, 0, 0);

    const ctx = this.territoryContext;
    const size = this.size;
    ctx.clearRect(0, 0, size, size);
    this.traceArenaPath(ctx);
    ctx.fillStyle = "#F5FCFA";
    ctx.fill();
    ctx.save();
    this.traceArenaPath(ctx);
    ctx.clip();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.rasterCanvas, 0, 0, size, size);
    ctx.restore();

    this.traceArenaPath(ctx);
    ctx.lineWidth = 3.5;
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#2C5364";
    ctx.stroke();
  }

  /** Clears and redraws only the handful of moving player markers each frame. */
  renderPlayers(players: MiniMapPlayer[]) {
    const ctx = this.playerContext;
    const size = this.size;
    ctx.clearRect(0, 0, size, size);

    for (const player of players) {
      if (!player.alive) continue;

      const px = ((player.x + HALF_ARENA_SIZE) / ARENA_SIZE) * size;
      const py =
        (1 - (player.y + HALF_ARENA_SIZE) / ARENA_SIZE) * size;

      if (player.isLocal) {
        ctx.fillStyle = "#FFFFFF";
        ctx.beginPath();
        ctx.arc(px, py, 4.5, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = player.color;
        ctx.beginPath();
        ctx.arc(px, py, 3, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillStyle = "#222222";
        ctx.beginPath();
        ctx.arc(px, py, 2.5, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = player.color;
        ctx.beginPath();
        ctx.arc(px, py, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}
