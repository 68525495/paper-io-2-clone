import {
  Color3,
  DynamicTexture,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
  Vector3,
} from "@babylonjs/core";
import {
  ARENA_SIZE,
  COLOR_PALETTE,
  GRID_CELLS,
  HALF_ARENA_SIZE,
} from "../shared/constants.js";

export class ArenaRenderer {
  public islandMesh: Mesh;
  public groundMesh: Mesh;
  public waterMesh: Mesh;
  private territoryTexture: DynamicTexture;
  private territoryMaterial: StandardMaterial;
  private textureContext: CanvasRenderingContext2D;

  private textureSize = 1024;
  private cellTexSize: number;
  private rawGrid: Uint8Array;
  private playerColorMap = new Map<number, string>();
  private dirty = true;

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
    waterMat.diffuseColor = new Color3(0.48, 0.84, 0.78); // Soft ocean teal #7ad6c7
    waterMat.specularColor = new Color3(0.2, 0.4, 0.4);
    this.waterMesh.material = waterMat;

    // 2. Main Playable Island Mesh (Beveled Paper Platform 3D Box)
    this.islandMesh = MeshBuilder.CreateBox(
      "IslandGround",
      { width: ARENA_SIZE, height: 0.6, depth: ARENA_SIZE },
      scene
    );
    this.islandMesh.position.y = -0.3;
    const islandSideMat = new StandardMaterial("IslandSideMat", scene);
    islandSideMat.diffuseColor = new Color3(0.88, 0.94, 0.92); // Mint-white paper platform edge
    islandSideMat.specularColor = new Color3(0.05, 0.05, 0.05);
    this.islandMesh.material = islandSideMat;

    // 3. Flat Territory Ground Plane (Correct UV alignment with 3D world coordinates)
    this.groundMesh = MeshBuilder.CreateGround(
      "TerritoryGround",
      { width: ARENA_SIZE, height: ARENA_SIZE },
      scene
    );
    this.groundMesh.position.y = 0.005; // Slightly above island top surface to avoid z-fighting

    // Territory Material with DynamicTexture for territory
    this.territoryMaterial = new StandardMaterial("TerritoryMat", scene);
    this.territoryTexture = new DynamicTexture(
      "TerritoryDynamicTexture",
      { width: this.textureSize, height: this.textureSize },
      scene,
      false
    );
    this.textureContext = this.territoryTexture.getContext() as CanvasRenderingContext2D;

    this.territoryMaterial.diffuseTexture = this.territoryTexture;
    this.territoryMaterial.emissiveTexture = this.territoryTexture;
    this.territoryMaterial.diffuseColor = new Color3(0.85, 0.85, 0.85);
    this.territoryMaterial.emissiveColor = new Color3(0.15, 0.15, 0.15);
    this.territoryMaterial.specularColor = new Color3(0, 0, 0);
    this.groundMesh.material = this.territoryMaterial;

    // Initial draw of mint paper ground
    this.drawInitialPaperGround();
  }

  setPlayerColor(playerIndex: number, hexColor: string) {
    this.playerColorMap.set(playerIndex, hexColor);
    this.dirty = true;
  }

  updateGrid(cells: Uint8Array | number[]) {
    if (cells instanceof Uint8Array) {
      this.rawGrid.set(cells);
    } else {
      this.rawGrid.set(new Uint8Array(cells));
    }
    this.dirty = true;
  }

  setCell(gx: number, gy: number, playerIndex: number) {
    if (gx >= 0 && gx < GRID_CELLS && gy >= 0 && gy < GRID_CELLS) {
      this.rawGrid[gy * GRID_CELLS + gx] = playerIndex;
      this.dirty = true;
    }
  }

  private drawInitialPaperGround() {
    const ctx = this.textureContext;
    const size = this.textureSize;

    // Pristine mint paper base
    ctx.fillStyle = "#EBF7F4"; // Soft pastel mint
    ctx.fillRect(0, 0, size, size);

    // Subtle paper edge border
    ctx.strokeStyle = "#C9EBE3";
    ctx.lineWidth = 6;
    ctx.strokeRect(3, 3, size - 6, size - 6);

    this.territoryTexture.update();
  }

  renderTerritory() {
    if (!this.dirty) return;
    this.dirty = false;

    const ctx = this.textureContext;
    const size = this.textureSize;
    const cs = this.cellTexSize;
    const radius = cs * 0.72; // Overlapping rounded blobs for organic feel

    // Clear with soft mint paper background
    ctx.fillStyle = "#EBF7F4";
    ctx.fillRect(0, 0, size, size);

    // Outer border
    ctx.strokeStyle = "#C4E8DF";
    ctx.lineWidth = 6;
    ctx.strokeRect(3, 3, size - 6, size - 6);

    // Draw owned territory cells as crisp straight-edged geometric paper tiles
    for (let gy = 0; gy < GRID_CELLS; gy++) {
      for (let gx = 0; gx < GRID_CELLS; gx++) {
        const ownerIdx = this.rawGrid[gy * GRID_CELLS + gx];
        if (ownerIdx === 0) continue;

        const color = this.playerColorMap.get(ownerIdx) || COLOR_PALETTE[(ownerIdx - 1) % COLOR_PALETTE.length];
        const x = gx * cs;
        const y = size - (gy + 1) * cs;

        ctx.fillStyle = color;
        ctx.fillRect(x, y, cs + 0.4, cs + 0.4);
      }
    }

    // Draw crisp boundary borders on territory edges
    ctx.lineWidth = 1.5;
    for (let gy = 0; gy < GRID_CELLS; gy++) {
      for (let gx = 0; gx < GRID_CELLS; gx++) {
        const ownerIdx = this.rawGrid[gy * GRID_CELLS + gx];
        if (ownerIdx === 0) continue;

        const x = gx * cs;
        const y = size - (gy + 1) * cs;

        const topEmpty = gy === GRID_CELLS - 1 || this.rawGrid[(gy + 1) * GRID_CELLS + gx] !== ownerIdx;
        const bottomEmpty = gy === 0 || this.rawGrid[(gy - 1) * GRID_CELLS + gx] !== ownerIdx;
        const leftEmpty = gx === 0 || this.rawGrid[gy * GRID_CELLS + (gx - 1)] !== ownerIdx;
        const rightEmpty = gx === GRID_CELLS - 1 || this.rawGrid[gy * GRID_CELLS + (gx + 1)] !== ownerIdx;

        if (topEmpty || bottomEmpty || leftEmpty || rightEmpty) {
          ctx.strokeStyle = "rgba(0, 0, 0, 0.16)";
          ctx.beginPath();
          if (topEmpty) {
            ctx.moveTo(x, y);
            ctx.lineTo(x + cs, y);
          }
          if (bottomEmpty) {
            ctx.moveTo(x, y + cs);
            ctx.lineTo(x + cs, y + cs);
          }
          if (leftEmpty) {
            ctx.moveTo(x, y);
            ctx.lineTo(x, y + cs);
          }
          if (rightEmpty) {
            ctx.moveTo(x + cs, y);
            ctx.lineTo(x + cs, y + cs);
          }
          ctx.stroke();
        }
      }
    }

    this.territoryTexture.update();
  }

  animateWater(time: number) {
    // Subtle ocean surface animation
    this.waterMesh.position.y = -0.6 + Math.sin(time * 1.5) * 0.05;
  }
}
