import {
  Color3,
  DynamicTexture,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
  Texture,
  VertexData,
} from "@babylonjs/core";
import {
  ARENA_SIZE,
  CELL_SIZE,
  COLOR_PALETTE,
  GRID_CELLS,
  HALF_ARENA_SIZE,
  INITIAL_BASE_RADIUS_CELLS,
  TRAIL_RADIUS,
  worldToGrid,
} from "../shared/constants.js";
import {
  ARENA_CONTOUR,
  ArenaPoint,
} from "../shared/arenaShape.js";
import { extractSmoothedPlayerContours } from "../shared/contour.js";

export interface PlayerTerritoryMeta {
  color: string;
  spawnX: number;
  spawnY: number;
  territoryCells: number;
  alive: boolean;
}

export class ArenaRenderer {
  public islandMesh: Mesh;
  public groundMesh: Mesh;
  public waterMesh: Mesh;
  private territoryTexture: DynamicTexture;
  private territoryMaterial: StandardMaterial;
  private textureContext: CanvasRenderingContext2D;

  private textureSize = 2048;
  private cellTexSize: number;
  public rawGrid: Uint8Array;
  public playerColorMap = new Map<number, string>();
  public playerMeta = new Map<number, PlayerTerritoryMeta>();

  constructor(scene: Scene) {
    this.cellTexSize = this.textureSize / GRID_CELLS;
    this.rawGrid = new Uint8Array(GRID_CELLS * GRID_CELLS);

    // 1. Ocean Water Plane (Bottom Layer)
    this.waterMesh = MeshBuilder.CreateGround(
      "OceanWater",
      { width: ARENA_SIZE * 2.2, height: ARENA_SIZE * 2.2 },
      scene
    );
    this.waterMesh.position.y = -0.6;

    const waterMat = new StandardMaterial("WaterMat", scene);
    waterMat.diffuseColor = new Color3(0.48, 0.84, 0.78);
    waterMat.specularColor = new Color3(0.2, 0.4, 0.4);
    this.waterMesh.material = waterMat;

    // 2. Main playable island. A custom center-visible mesh gives the actual
    // world the same smooth organic coastline used by the minimap and server.
    this.islandMesh = this.createIslandMesh(scene);
    const islandSideMat = new StandardMaterial("IslandSideMat", scene);
    islandSideMat.diffuseColor = new Color3(0.95, 0.96, 0.98); // Clean white paper platform edge
    islandSideMat.specularColor = new Color3(0.05, 0.05, 0.05);
    this.islandMesh.material = islandSideMat;

    // 3. Flat territory surface with square-bounds UVs. The geometry itself is
    // clipped to ARENA_CONTOUR, while UVs remain aligned to the 256x256 grid.
    this.groundMesh = this.createTerritoryGroundMesh(scene);

    // Territory Material with DynamicTexture for territory
    this.territoryMaterial = new StandardMaterial("TerritoryMat", scene);
    this.territoryTexture = new DynamicTexture(
      "TerritoryDynamicTexture",
      { width: this.textureSize, height: this.textureSize },
      scene,
      true,
      Texture.TRILINEAR_SAMPLINGMODE
    );
    this.textureContext = this.territoryTexture.getContext() as CanvasRenderingContext2D;
    this.textureContext.imageSmoothingEnabled = true;
    this.textureContext.imageSmoothingQuality = "high";
    this.territoryTexture.anisotropicFilteringLevel = 8;
    this.territoryTexture.wrapU = Texture.CLAMP_ADDRESSMODE;
    this.territoryTexture.wrapV = Texture.CLAMP_ADDRESSMODE;

    this.territoryMaterial.diffuseTexture = this.territoryTexture;
    this.territoryMaterial.emissiveTexture = this.territoryTexture;
    this.territoryMaterial.diffuseColor = new Color3(0.85, 0.85, 0.85);
    this.territoryMaterial.emissiveColor = new Color3(0.15, 0.15, 0.15);
    this.territoryMaterial.specularColor = new Color3(0, 0, 0);
    this.groundMesh.material = this.territoryMaterial;

    // Initial draw of clean white paper ground
    this.drawInitialPaperGround();
  }

  private createIslandMesh(scene: Scene): Mesh {
    const mesh = new Mesh("IslandGround", scene);
    const positions: number[] = [];
    const indices: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const topY = 0;
    const bottomY = -0.6;
    const count = ARENA_CONTOUR.length;

    const pushVertex = (point: ArenaPoint, height: number) => {
      positions.push(point.x, height, point.y);
      uvs.push(
        (point.x + HALF_ARENA_SIZE) / ARENA_SIZE,
        (point.y + HALF_ARENA_SIZE) / ARENA_SIZE
      );
    };

    pushVertex({ x: 0, y: 0 }, topY);
    for (const point of ARENA_CONTOUR) pushVertex(point, topY);
    const bottomCenter = positions.length / 3;
    pushVertex({ x: 0, y: 0 }, bottomY);
    const bottomStart = positions.length / 3;
    for (const point of ARENA_CONTOUR) pushVertex(point, bottomY);

    for (let index = 0; index < count; index++) {
      const next = (index + 1) % count;
      const topCurrent = 1 + index;
      const topNext = 1 + next;
      const bottomCurrent = bottomStart + index;
      const bottomNext = bottomStart + next;

      // Babylon's default left-handed winding faces the upper coastline cap
      // toward the camera and the wall quads outward toward the ocean.
      indices.push(0, topCurrent, topNext);
      indices.push(bottomCenter, bottomNext, bottomCurrent);
      indices.push(topCurrent, bottomNext, topNext);
      indices.push(topCurrent, bottomCurrent, bottomNext);
    }

    VertexData.ComputeNormals(positions, indices, normals);
    const vertexData = new VertexData();
    vertexData.positions = positions;
    vertexData.indices = indices;
    vertexData.normals = normals;
    vertexData.uvs = uvs;
    vertexData.applyToMesh(mesh);
    return mesh;
  }

  private createTerritoryGroundMesh(scene: Scene): Mesh {
    const mesh = new Mesh("TerritoryGround", scene);
    const positions: number[] = [0, 0.005, 0];
    const indices: number[] = [];
    const normals: number[] = [0, 1, 0];
    const uvs: number[] = [0.5, 0.5];
    const count = ARENA_CONTOUR.length;

    for (const point of ARENA_CONTOUR) {
      positions.push(point.x, 0.005, point.y);
      normals.push(0, 1, 0);
      uvs.push(
        (point.x + HALF_ARENA_SIZE) / ARENA_SIZE,
        (point.y + HALF_ARENA_SIZE) / ARENA_SIZE
      );
    }

    for (let index = 0; index < count; index++) {
      const current = 1 + index;
      const next = 1 + ((index + 1) % count);
      indices.push(0, current, next);
    }

    const vertexData = new VertexData();
    vertexData.positions = positions;
    vertexData.indices = indices;
    vertexData.normals = normals;
    vertexData.uvs = uvs;
    vertexData.applyToMesh(mesh);
    return mesh;
  }

  private arenaPointToCanvas(point: ArenaPoint): { x: number; y: number } {
    return {
      x: ((point.x + HALF_ARENA_SIZE) / ARENA_SIZE) * this.textureSize,
      y:
        this.textureSize -
        ((point.y + HALF_ARENA_SIZE) / ARENA_SIZE) * this.textureSize,
    };
  }

  private traceArenaPath(ctx: CanvasRenderingContext2D) {
    const first = this.arenaPointToCanvas(ARENA_CONTOUR[0]);
    ctx.beginPath();
    ctx.moveTo(first.x, first.y);
    for (let index = 1; index < ARENA_CONTOUR.length; index++) {
      const point = this.arenaPointToCanvas(ARENA_CONTOUR[index]);
      ctx.lineTo(point.x, point.y);
    }
    ctx.closePath();
  }

  setPlayerColor(playerIndex: number, hexColor: string) {
    this.playerColorMap.set(playerIndex, hexColor);
  }

  setPlayerMeta(
    playerIndex: number,
    color: string,
    spawnX: number,
    spawnY: number,
    territoryCells: number,
    alive: boolean
  ) {
    this.playerMeta.set(playerIndex, {
      color,
      spawnX,
      spawnY,
      territoryCells,
      alive,
    });
    this.playerColorMap.set(playerIndex, color);
  }

  updateGrid(cells: Uint8Array | number[]) {
    if (cells instanceof Uint8Array) {
      this.rawGrid.set(cells);
    } else {
      this.rawGrid.set(new Uint8Array(cells));
    }
  }

  setCell(gx: number, gy: number, playerIndex: number) {
    if (gx >= 0 && gx < GRID_CELLS && gy >= 0 && gy < GRID_CELLS) {
      this.rawGrid[gy * GRID_CELLS + gx] = playerIndex;
    }
  }

  /** Marching Squares coordinates are cell-sample coordinates, not cell corners. */
  private gridSampleToCanvas(vx: number, vy: number): { x: number; y: number } {
    const cs = this.cellTexSize;
    return {
      x: (vx + 0.5) * cs,
      y: this.textureSize - (vy + 0.5) * cs,
    };
  }

  /**
   * Keep the untouched spawn base perfectly round. As soon as territory grows
   * beyond that footprint, return the complete authoritative grid so the base
   * and captured area become one contour with no internal circle edge.
   */
  private createVisualContourGrid(
    playerIdx: number,
    meta: PlayerTerritoryMeta | undefined
  ): { cells: Uint8Array; baseCenter?: { x: number; y: number } } {
    if (!meta?.alive) return { cells: this.rawGrid };

    const { gx, gy } = worldToGrid(meta.spawnX, meta.spawnY);
    if (this.rawGrid[gy * GRID_CELLS + gx] !== playerIdx) {
      return { cells: this.rawGrid };
    }

    const radius = INITIAL_BASE_RADIUS_CELLS;
    let footprintCells = 0;
    let ownedFootprintCells = 0;
    let hasOwnedCellsOutsideFootprint = false;

    for (let y = 0; y < GRID_CELLS; y++) {
      const dy = y - gy;
      for (let x = 0; x < GRID_CELLS; x++) {
        if (this.rawGrid[y * GRID_CELLS + x] !== playerIdx) continue;
        const dx = x - gx;
        if (dx * dx + dy * dy > radius * radius + 1) {
          hasOwnedCellsOutsideFootprint = true;
          break;
        }
      }
      if (hasOwnedCellsOutsideFootprint) break;
    }

    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx * dx + dy * dy > radius * radius + 1) continue;
        const x = gx + dx;
        const y = gy + dy;
        if (x < 0 || x >= GRID_CELLS || y < 0 || y >= GRID_CELLS) continue;
        footprintCells++;
        if (this.rawGrid[y * GRID_CELLS + x] === playerIdx) {
          ownedFootprintCells++;
        }
      }
    }

    // Extended territory must be contoured with the complete base included;
    // otherwise the separately stroked circle remains visible inside it.
    // Likewise, never redraw a circle over even one stolen footprint cell.
    if (
      hasOwnedCellsOutsideFootprint ||
      footprintCells === 0 ||
      ownedFootprintCells !== footprintCells
    ) {
      return { cells: this.rawGrid };
    }

    const cells = this.rawGrid.slice();
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx * dx + dy * dy > radius * radius + 1) continue;
        const x = gx + dx;
        const y = gy + dy;
        if (x < 0 || x >= GRID_CELLS || y < 0 || y >= GRID_CELLS) continue;
        const index = y * GRID_CELLS + x;
        if (cells[index] === playerIdx) cells[index] = 0;
      }
    }

    return {
      cells,
      baseCenter: this.gridSampleToCanvas(gx, gy),
    };
  }

  private drawInitialPaperGround() {
    const ctx = this.textureContext;
    const size = this.textureSize;

    ctx.clearRect(0, 0, size, size);

    // Pristine pure white paper base inside the canonical island contour.
    this.traceArenaPath(ctx);
    ctx.fillStyle = "#FFFFFF";
    ctx.fill();

    // Island edge border
    this.traceArenaPath(ctx);
    ctx.strokeStyle = "#E2E8F0";
    ctx.lineWidth = 12;
    ctx.lineJoin = "round";
    ctx.stroke();

    this.territoryTexture.update();
  }

  /**
   * Dual-layer representation:
   * The synchronized grid remains authoritative. The browser turns it into a
   * continuous presentation mask: analytic spawn circles plus smoothed
   * Marching Squares contours, rendered into Babylon.js DynamicTexture.
   */
  renderTerritory() {
    const ctx = this.textureContext;
    const size = this.textureSize;

    // 1. Pristine paper background and a coastline clip shared with the mesh.
    ctx.clearRect(0, 0, size, size);
    this.traceArenaPath(ctx);
    ctx.fillStyle = "#FFFFFF";
    ctx.fill();
    ctx.save();
    this.traceArenaPath(ctx);
    ctx.clip();

    // 2. Find unique player indices present on the playable grid.
    const presentPlayers = new Set<number>();
    for (let i = 0; i < this.rawGrid.length; i++) {
      const idx = this.rawGrid[i];
      if (idx > 0) presentPlayers.add(idx);
    }

    // 3. Render each player's territory, clipped at the organic coastline.
    for (const playerIdx of presentPlayers) {
      const meta = this.playerMeta.get(playerIdx);
      const color =
        meta?.color ||
        this.playerColorMap.get(playerIdx) ||
        COLOR_PALETTE[(playerIdx - 1) % COLOR_PALETTE.length];

      ctx.fillStyle = color;
      ctx.strokeStyle = color;
      // A one-cell captured trail is CELL_SIZE wide in the logical grid. Expand
      // its visual outline to the same width as the live capsule trail.
      const pixelsPerWorldUnit = this.textureSize / ARENA_SIZE;
      ctx.lineWidth = Math.max(
        2,
        (TRAIL_RADIUS * 2 - CELL_SIZE) * pixelsPerWorldUnit
      );
      ctx.lineJoin = "round";
      ctx.lineCap = "round";

      const visual = this.createVisualContourGrid(playerIdx, meta);
      const loops = extractSmoothedPlayerContours(visual.cells, playerIdx, {
        gridSize: GRID_CELLS,
        simplifyTolerance: 0.9,
        chaikinIterations: 3,
        maxDeviation: 0.8,
      });

      ctx.beginPath();
      let hasPath = false;
      for (const loop of loops) {
        if (loop.length < 3) continue;

        hasPath = true;
        const first = this.gridSampleToCanvas(loop[0].x, loop[0].y);
        ctx.moveTo(first.x, first.y);

        for (let i = 1; i < loop.length; i++) {
          const pt = this.gridSampleToCanvas(loop[i].x, loop[i].y);
          ctx.lineTo(pt.x, pt.y);
        }

        ctx.closePath();
      }

      if (hasPath) {
        // A small texture-space shadow and highlight provide paper-like
        // thickness without changing the authoritative ground geometry.
        ctx.save();
        ctx.shadowColor = "rgba(15, 23, 42, 0.2)";
        ctx.shadowBlur = this.cellTexSize * 0.7;
        ctx.shadowOffsetX = this.cellTexSize * 0.18;
        ctx.shadowOffsetY = this.cellTexSize * 0.28;
        ctx.fill("evenodd");
        ctx.restore();

        ctx.strokeStyle = color;
        ctx.stroke();

        ctx.save();
        ctx.globalAlpha = 0.2;
        ctx.strokeStyle = "#FFFFFF";
        ctx.lineWidth = Math.max(1.25, this.cellTexSize * 0.18);
        ctx.stroke();
        ctx.restore();
      }

      if (visual.baseCenter) {
        // This path is used only while the base is pristine. Once territory
        // expands, the full grid above produces a single merged silhouette.
        // Match the mean radius of the unified raster contour so the first
        // capture does not visibly pop between the two representations.
        const baseRadius =
          (INITIAL_BASE_RADIUS_CELLS + 0.1) * this.cellTexSize;
        ctx.beginPath();
        ctx.arc(
          visual.baseCenter.x,
          visual.baseCenter.y,
          baseRadius,
          0,
          Math.PI * 2
        );
        ctx.save();
        ctx.shadowColor = "rgba(15, 23, 42, 0.2)";
        ctx.shadowBlur = this.cellTexSize * 0.7;
        ctx.shadowOffsetX = this.cellTexSize * 0.18;
        ctx.shadowOffsetY = this.cellTexSize * 0.28;
        ctx.fill();
        ctx.restore();

        ctx.strokeStyle = color;
        ctx.stroke();

        ctx.save();
        ctx.globalAlpha = 0.2;
        ctx.strokeStyle = "#FFFFFF";
        ctx.lineWidth = Math.max(1.25, this.cellTexSize * 0.18);
        ctx.stroke();
        ctx.restore();
      }
    }

    ctx.restore();

    // 4. Draw the same smooth coastline over territory so it remains crisp.
    this.traceArenaPath(ctx);
    ctx.strokeStyle = "#E2E8F0";
    ctx.lineWidth = 12;
    ctx.lineJoin = "round";
    ctx.stroke();

    this.territoryTexture.update();
  }

  animateWater(time: number) {
    this.waterMesh.position.y = -0.6 + Math.sin(time * 1.5) * 0.05;
  }
}
