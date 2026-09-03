import {
  Color3,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
  TransformNode,
  Vector3,
} from "@babylonjs/core";


interface CharacterInstance {
  root: TransformNode;
  bodyMesh: Mesh;
  crownMesh: Mesh | null;

  nameTag: Mesh | null;
  color: string;
  isLeader: boolean;
  bobTime: number;
}

export class CharacterRenderer {
  private scene: Scene;
  private characters = new Map<string, CharacterInstance>();
  private goldMaterial: StandardMaterial;

  constructor(scene: Scene) {
    this.scene = scene;

    this.goldMaterial = new StandardMaterial("CrownGoldMat", scene);
    this.goldMaterial.diffuseColor = new Color3(1.0, 0.82, 0.2);
    this.goldMaterial.emissiveColor = new Color3(0.4, 0.3, 0.05);
    this.goldMaterial.specularColor = new Color3(1, 0.9, 0.5);
  }

  getOrCreate(playerId: string, name: string, color: string, isBot: boolean): CharacterInstance {
    let char = this.characters.get(playerId);
    if (char) {
      if (char.color !== color) {
        this.updateColor(char, color);
      }
      return char;
    }

    const root = new TransformNode(`char_${playerId}`, this.scene);

    // 1. Cute Cuboid Body
    const bodyMesh = MeshBuilder.CreateBox(
      `body_${playerId}`,
      { width: 1.8, height: 1.3, depth: 1.8 },
      this.scene
    );
    bodyMesh.position.y = 0.75;
    bodyMesh.parent = root;

    const bodyMat = new StandardMaterial(`bodyMat_${playerId}`, this.scene);
    bodyMat.diffuseColor = Color3.FromHexString(color).scale(0.85);
    bodyMat.emissiveColor = Color3.FromHexString(color).scale(0.15);
    bodyMat.specularColor = new Color3(0, 0, 0);
    bodyMesh.material = bodyMat;

    // 2. Ears
    const earL = MeshBuilder.CreateBox(`earL_${playerId}`, { width: 0.35, height: 0.45, depth: 0.35 }, this.scene);
    earL.position.set(-0.6, 0.75, 0.5);
    earL.parent = bodyMesh;
    earL.material = bodyMat;

    const earR = MeshBuilder.CreateBox(`earR_${playerId}`, { width: 0.35, height: 0.45, depth: 0.35 }, this.scene);
    earR.position.set(0.6, 0.75, 0.5);
    earR.parent = bodyMesh;
    earR.material = bodyMat;

    // 3. Eyes (White sclera + dark pupils)
    const eyeWhiteMat = new StandardMaterial("eyeWhiteMat", this.scene);
    eyeWhiteMat.diffuseColor = new Color3(1, 1, 1);

    const eyePupilMat = new StandardMaterial("eyePupilMat", this.scene);
    eyePupilMat.diffuseColor = new Color3(0.1, 0.1, 0.15);

    const eyeL = MeshBuilder.CreateBox(`eyeL_${playerId}`, { width: 0.38, height: 0.38, depth: 0.1 }, this.scene);
    eyeL.position.set(-0.42, 0.1, 0.92);
    eyeL.parent = bodyMesh;
    eyeL.material = eyeWhiteMat;

    const pupilL = MeshBuilder.CreateBox(`pupilL_${playerId}`, { width: 0.2, height: 0.2, depth: 0.08 }, this.scene);
    pupilL.position.set(-0.42, 0.08, 0.98);
    pupilL.parent = bodyMesh;
    pupilL.material = eyePupilMat;

    const eyeR = MeshBuilder.CreateBox(`eyeR_${playerId}`, { width: 0.38, height: 0.38, depth: 0.1 }, this.scene);
    eyeR.position.set(0.42, 0.1, 0.92);
    eyeR.parent = bodyMesh;
    eyeR.material = eyeWhiteMat;

    const pupilR = MeshBuilder.CreateBox(`pupilR_${playerId}`, { width: 0.2, height: 0.2, depth: 0.08 }, this.scene);
    pupilR.position.set(0.42, 0.08, 0.98);
    pupilR.parent = bodyMesh;
    pupilR.material = eyePupilMat;

    // 4. Snout / Nose
    const snout = MeshBuilder.CreateBox(`snout_${playerId}`, { width: 0.5, height: 0.25, depth: 0.15 }, this.scene);
    snout.position.set(0, -0.15, 0.95);
    snout.parent = bodyMesh;
    const snoutMat = new StandardMaterial("snoutMat", this.scene);
    snoutMat.diffuseColor = new Color3(0.95, 0.85, 0.75);
    snout.material = snoutMat;

    // 5. Crown Mesh (Golden crown for leader)
    const crown = this.createCrownMesh(playerId);
    crown.parent = root;
    crown.position.set(0, 1.9, 0);
    crown.setEnabled(false);



    char = {
      root,
      bodyMesh,
      crownMesh: crown,

      nameTag: null,
      color,
      isLeader: false,
      bobTime: Math.random() * 10,
    };

    this.characters.set(playerId, char);
    return char;
  }

  private createCrownMesh(playerId: string): Mesh {
    const crown = MeshBuilder.CreateCylinder(
      `crown_${playerId}`,
      { diameterTop: 1.1, diameterBottom: 0.8, height: 0.5, tessellation: 5 },
      this.scene
    );
    crown.material = this.goldMaterial;
    return crown;
  }



  private updateColor(char: CharacterInstance, color: string) {
    char.color = color;
    if (char.bodyMesh.material instanceof StandardMaterial) {
      char.bodyMesh.material.diffuseColor = Color3.FromHexString(color).scale(0.85);
      char.bodyMesh.material.emissiveColor = Color3.FromHexString(color).scale(0.15);
      char.bodyMesh.material.specularColor = new Color3(0, 0, 0);
    }
  }

  updatePlayer(
    playerId: string,
    x: number,
    z: number,
    angle: number,
    isAlive: boolean,
    isLeader: boolean,
    dt: number
  ) {
    const char = this.characters.get(playerId);
    if (!char) return;

    if (!isAlive) {
      char.root.setEnabled(false);
      return;
    }

    char.root.setEnabled(true);

    // Smooth movement interpolation (snap immediately if just spawned or far away)
    const distSq = (x - char.root.position.x) ** 2 + (z - char.root.position.z) ** 2;
    if (distSq > 64 || (char.root.position.x === 0 && char.root.position.z === 0)) {
      char.root.position.x = x;
      char.root.position.z = z;
    } else {
      char.root.position.x += (x - char.root.position.x) * 0.4;
      char.root.position.z += (z - char.root.position.z) * 0.4;
    }

    // Rotate character towards heading angle
    // In Babylon, 2D angle (Math.atan2(dy, dx)) maps to Y rotation (-angle + Math.PI/2)
    const targetRotY = -angle + Math.PI / 2;
    char.root.rotation.y = targetRotY;

    // Bobbing walk animation
    char.bobTime += dt * 10;
    const bobOffset = Math.sin(char.bobTime) * 0.12;
    const wobbleRoll = Math.cos(char.bobTime * 0.5) * 0.08;
    char.bodyMesh.position.y = 0.75 + Math.abs(bobOffset);
    char.bodyMesh.rotation.z = wobbleRoll;

    // Update Crown visibility and rotation
    if (char.crownMesh) {
      char.crownMesh.setEnabled(isLeader);
      if (isLeader) {
        char.crownMesh.rotation.y += dt * 2.0;
        char.crownMesh.position.y = 1.9 + Math.sin(char.bobTime * 0.6) * 0.08;
      }
    }


  }

  cleanupRemoved(activePlayers: { has(id: string): boolean }) {
    const toRemove: string[] = [];
    this.characters.forEach((_, id) => {
      if (!activePlayers.has(id)) {
        toRemove.push(id);
      }
    });
    for (const id of toRemove) {
      this.remove(id);
    }
  }

  remove(playerId: string) {
    const char = this.characters.get(playerId);
    if (char) {
      char.root.dispose();
      this.characters.delete(playerId);
    }
  }
}
