import {
  Color3,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
  Vector3,
} from "@babylonjs/core";

interface PickupItem {
  id: string;
  mesh: Mesh;
  kind: "bubble" | "coin";
  targetX: number;
  targetZ: number;
  bobTime: number;
}

export class BubbleRenderer {
  private scene: Scene;
  private pickups = new Map<string, PickupItem>();
  private bubbleMaterial: StandardMaterial;
  private coinMaterial: StandardMaterial;

  constructor(scene: Scene) {
    this.scene = scene;

    // Iridescent soap bubble material matching screenshot
    this.bubbleMaterial = new StandardMaterial("BubbleMat", scene);
    this.bubbleMaterial.diffuseColor = new Color3(0.85, 0.65, 0.95);
    this.bubbleMaterial.emissiveColor = new Color3(0.3, 0.15, 0.4);
    this.bubbleMaterial.specularColor = new Color3(1, 1, 1);
    this.bubbleMaterial.specularPower = 32;
    this.bubbleMaterial.alpha = 0.72;

    // Golden coin material
    this.coinMaterial = new StandardMaterial("CoinMat", scene);
    this.coinMaterial.diffuseColor = new Color3(1.0, 0.8, 0.15);
    this.coinMaterial.emissiveColor = new Color3(0.4, 0.3, 0.05);
    this.coinMaterial.specularColor = new Color3(1, 1, 0.8);
  }

  syncPickups(serverPickups: Array<{ id: string; kind: string; x: number; y: number; active: boolean }>) {
    const activeIds = new Set<string>();

    for (const sp of serverPickups) {
      if (!sp.active) continue;
      activeIds.add(sp.id);

      let item = this.pickups.get(sp.id);
      if (!item) {
        item = this.createPickup(sp.id, sp.kind as "bubble" | "coin", sp.x, sp.y);
        this.pickups.set(sp.id, item);
      }
      item.targetX = sp.x;
      item.targetZ = sp.y;
    }

    // Remove inactive pickups
    this.pickups.forEach((item, id) => {
      if (!activeIds.has(id)) {
        this.popPickup(id);
      }
    });
  }

  private createPickup(id: string, kind: "bubble" | "coin", x: number, z: number): PickupItem {
    let mesh: Mesh;
    if (kind === "bubble") {
      mesh = MeshBuilder.CreateSphere(
        `bubble_${id}`,
        { diameter: 2.6, segments: 16 },
        this.scene
      );
      mesh.material = this.bubbleMaterial;
      mesh.position.set(x, 1.4, z);
    } else {
      mesh = MeshBuilder.CreateCylinder(
        `coin_${id}`,
        { diameter: 1.2, height: 0.25, tessellation: 16 },
        this.scene
      );
      mesh.rotation.x = Math.PI / 2;
      mesh.material = this.coinMaterial;
      mesh.position.set(x, 0.35, z);
    }

    return {
      id,
      mesh,
      kind,
      targetX: x,
      targetZ: z,
      bobTime: Math.random() * 10,
    };
  }

  popPickup(id: string) {
    const item = this.pickups.get(id);
    if (!item) return;

    // Quick pop scale animation
    let scale = 1.0;
    const interval = window.setInterval(() => {
      scale += 0.25;
      if (item.mesh && !item.mesh.isDisposed()) {
        item.mesh.scaling.set(scale, scale, scale);
      }
      if (scale > 1.8) {
        clearInterval(interval);
        item.mesh.dispose();
        this.pickups.delete(id);
      }
    }, 25);
  }

  update(dt: number) {
    this.pickups.forEach((item) => {
      item.bobTime += dt * 3;
      if (item.kind === "bubble") {
        item.mesh.position.y = 1.4 + Math.sin(item.bobTime) * 0.25;
      } else {
        // Spin coin
        item.mesh.rotation.y += dt * 3;
        item.mesh.position.y = 0.35 + Math.sin(item.bobTime * 0.8) * 0.08;
      }
    });
  }

  destroy() {
    this.pickups.forEach((item) => item.mesh.dispose());
    this.pickups.clear();
  }
}
