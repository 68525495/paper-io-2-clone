import { Color3, Matrix, MeshBuilder, Scene, StandardMaterial, Vector3 } from "@babylonjs/core";

export class ParticleEffects {
  private scene: Scene;
  private container: HTMLDivElement;

  constructor(scene: Scene) {
    this.scene = scene;

    let c = document.getElementById("world-effects-container") as HTMLDivElement;
    if (!c) {
      c = document.createElement("div");
      c.id = "world-effects-container";
      c.style.position = "absolute";
      c.style.top = "0";
      c.style.left = "0";
      c.style.width = "100%";
      c.style.height = "100%";
      c.style.pointerEvents = "none";
      c.style.overflow = "hidden";
      c.style.zIndex = "50";
      document.body.appendChild(c);
    }
    this.container = c;
  }

  showFloatingText(worldX: number, worldY: number, text: string, color: string = "#FFD700", size: number = 22) {
    const el = document.createElement("div");
    el.className = "floating-score-popup";
    el.innerText = text;
    el.style.color = color;
    el.style.fontSize = `${size}px`;
    this.container.appendChild(el);

    const worldPos = new Vector3(worldX, 1.2, worldY);
    let life = 0;
    const maxLife = 1.0;

    const animate = () => {
      life += 0.025;
      const screenPos = Vector3.Project(
        worldPos,
        Matrix.IdentityReadOnly,
        this.scene.getTransformMatrix(),
        this.scene.activeCamera!.viewport.toGlobal(
          this.scene.getEngine().getRenderWidth(),
          this.scene.getEngine().getRenderHeight()
        )
      );

      worldPos.y += 0.06; // Float upward in 3D

      const alpha = Math.max(0, 1 - life / maxLife);
      const scale = 1.0 + Math.sin(life * Math.PI) * 0.35;

      el.style.left = `${screenPos.x}px`;
      el.style.top = `${screenPos.y}px`;
      el.style.opacity = `${alpha}`;
      el.style.transform = `translate(-50%, -50%) scale(${scale})`;

      if (life < maxLife) {
        requestAnimationFrame(animate);
      } else {
        el.remove();
      }
    };

    requestAnimationFrame(animate);
  }

  /** Expanding 3D Shockwave Ring on the ground in player's color */
  create3DShockwave(worldX: number, worldZ: number, colorHex: string, maxRadius: number = 7.0) {
    const disc = MeshBuilder.CreateDisc(
      `shockwave_${Date.now()}_${Math.random()}`,
      { radius: 0.5, tessellation: 36 },
      this.scene
    );
    disc.rotation.x = Math.PI / 2; // Flat on the ground
    disc.position.set(worldX, 0.09, worldZ);

    const mat = new StandardMaterial(`shockwaveMat_${Date.now()}`, this.scene);
    mat.diffuseColor = Color3.FromHexString(colorHex);
    mat.emissiveColor = Color3.FromHexString(colorHex);
    mat.alpha = 0.85;
    mat.specularColor = new Color3(0, 0, 0);
    mat.backFaceCulling = false;
    disc.material = mat;

    let progress = 0;
    const observer = this.scene.onBeforeRenderObservable.add(() => {
      progress += 0.055;
      const currentScale = 0.5 + progress * maxRadius;
      disc.scaling.set(currentScale, currentScale, 1);
      mat.alpha = Math.max(0, 0.85 * (1 - progress));

      if (progress >= 1.0) {
        this.scene.onBeforeRenderObservable.remove(observer);
        mat.dispose();
        disc.dispose();
      }
    });
  }

  /** Visual effect triggered when enclosing territory */
  triggerCaptureEffect(worldX: number, worldZ: number, colorHex: string, cellsCount: number) {
    // 1. Expanding 3D Shockwave Ring on the ground
    this.create3DShockwave(worldX, worldZ, colorHex, 9.0);

    // 2. Rising floating score
    this.showFloatingText(worldX, worldZ, `+${cellsCount} LAND!`, colorHex, 26);

    // 3. Sparkle burst surrounding capture center
    for (let i = 0; i < 4; i++) {
      const offsetX = (Math.random() - 0.5) * 6;
      const offsetZ = (Math.random() - 0.5) * 6;
      setTimeout(() => {
        this.showFloatingText(worldX + offsetX, worldZ + offsetZ, "✨", "#FFFFFF", 20);
      }, i * 60);
    }
  }

  /** Special conquest visual effect when eliminating an opponent and taking their land */
  triggerConquestEffect(
    victimX: number,
    victimZ: number,
    killerColorHex: string,
    victimName: string,
    absorbedPercent: number
  ) {
    // 1. Double expanding shockwaves
    this.create3DShockwave(victimX, victimZ, killerColorHex, 15.0);
    setTimeout(() => {
      this.create3DShockwave(victimX, victimZ, "#FFE066", 11.0);
    }, 140);

    // 2. Conquest Banner Popup
    const text = absorbedPercent > 0
      ? `⚔️ CONQUERED ${victimName}! +${absorbedPercent}%`
      : `⚔️ ELIMINATED ${victimName}!`;
    this.showFloatingText(victimX, victimZ, text, "#FFE066", 26);

    // 3. Victory crowns & sparkle burst
    for (let i = 0; i < 6; i++) {
      const offsetX = (Math.random() - 0.5) * 8;
      const offsetZ = (Math.random() - 0.5) * 8;
      setTimeout(() => {
        this.showFloatingText(victimX + offsetX, victimZ + offsetZ, "👑", killerColorHex, 22);
      }, i * 75);
    }
  }

  triggerCaptureSparkles(worldX: number, worldY: number, count: number = 3) {
    for (let i = 0; i < count; i++) {
      const offsetX = (Math.random() - 0.5) * 4;
      const offsetY = (Math.random() - 0.5) * 4;
      setTimeout(() => {
        this.showFloatingText(worldX + offsetX, worldY + offsetY, "+5", "#FFFFFF");
      }, i * 80);
    }
  }
}
