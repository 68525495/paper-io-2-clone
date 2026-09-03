import {
  Color3,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
  Vector3,
} from "@babylonjs/core";

interface TrailData {
  mesh: Mesh | null;
  lastPointCount: number;
  color: string;
}

export class TrailRenderer {
  private scene: Scene;
  private trails = new Map<string, TrailData>();
  private materials = new Map<string, StandardMaterial>();

  constructor(scene: Scene) {
    this.scene = scene;
  }

  private getMaterial(colorHex: string): StandardMaterial {
    let mat = this.materials.get(colorHex);
    if (!mat) {
      mat = new StandardMaterial(`trailMat_${colorHex}`, this.scene);
      mat.diffuseColor = Color3.FromHexString(colorHex).scale(0.85);
      mat.emissiveColor = Color3.FromHexString(colorHex).scale(0.15);
      mat.specularColor = new Color3(0, 0, 0);
      mat.backFaceCulling = false;
      this.materials.set(colorHex, mat);
    }
    return mat;
  }

  updateTrail(
    playerId: string,
    colorHex: string,
    points: Array<{ x: number; y: number }>,
    currentHeadX: number,
    currentHeadZ: number
  ) {
    let data = this.trails.get(playerId);
    if (!data) {
      data = { mesh: null, lastPointCount: 0, color: colorHex };
      this.trails.set(playerId, data);
    }

    if (points.length < 1) {
      if (data.mesh) {
        data.mesh.dispose();
        data.mesh = null;
        data.lastPointCount = 0;
      }
      return;
    }

    // Build path including current head
    const allPts: Vector3[] = [];
    for (const pt of points) {
      allPts.push(new Vector3(pt.x, 0.08, pt.y));
    }
    allPts.push(new Vector3(currentHeadX, 0.08, currentHeadZ));

    if (allPts.length < 2) return;

    // Build ribbon paths (two parallel paths for width)
    const halfWidth = 0.45;
    const pathLeft: Vector3[] = [];
    const pathRight: Vector3[] = [];

    for (let i = 0; i < allPts.length; i++) {
      let dirX = 0;
      let dirZ = 1;

      if (i < allPts.length - 1) {
        dirX = allPts[i + 1].x - allPts[i].x;
        dirZ = allPts[i + 1].z - allPts[i].z;
      } else if (i > 0) {
        dirX = allPts[i].x - allPts[i - 1].x;
        dirZ = allPts[i].z - allPts[i - 1].z;
      }

      const len = Math.sqrt(dirX * dirX + dirZ * dirZ) || 1;
      const nx = -dirZ / len;
      const nz = dirX / len;

      pathLeft.push(
        new Vector3(
          allPts[i].x + nx * halfWidth,
          0.08,
          allPts[i].z + nz * halfWidth
        )
      );
      pathRight.push(
        new Vector3(
          allPts[i].x - nx * halfWidth,
          0.08,
          allPts[i].z - nz * halfWidth
        )
      );
    }

    const ribbonPaths = [pathLeft, pathRight];

    // Only recreate the mesh when the number of points changes
    // (Babylon ribbons can only be updated in-place if the vertex count is the same)
    if (data.mesh && data.lastPointCount === allPts.length) {
      // In-place update: reuse existing mesh geometry
      MeshBuilder.CreateRibbon(
        `trail_${playerId}`,
        { pathArray: ribbonPaths, instance: data.mesh }
      );
    } else {
      // Point count changed: must recreate the mesh
      if (data.mesh) {
        data.mesh.dispose();
      }
      data.mesh = MeshBuilder.CreateRibbon(
        `trail_${playerId}`,
        { pathArray: ribbonPaths, closeArray: false, closePath: false, updatable: true },
        this.scene
      );
      data.mesh.material = this.getMaterial(colorHex);
      data.lastPointCount = allPts.length;
    }

    data.color = colorHex;
  }

  clearTrail(playerId: string) {
    const data = this.trails.get(playerId);
    if (data?.mesh) {
      data.mesh.dispose();
      data.mesh = null;
      data.lastPointCount = 0;
    }
  }

  removeAll() {
    this.trails.forEach((data) => {
      if (data.mesh) data.mesh.dispose();
    });
    this.trails.clear();
  }
}
