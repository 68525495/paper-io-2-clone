import {
  ArcRotateCamera,
  Color4,
  DirectionalLight,
  Engine,
  HemisphericLight,
  Scene,
  Vector3,
} from "@babylonjs/core";

export class SceneManager {
  public engine: Engine;
  public scene: Scene;
  public camera: ArcRotateCamera;
  public dirLight: DirectionalLight;
  public hemiLight: HemisphericLight;

  private targetPosition: Vector3 = new Vector3(0, 0, 0);

  constructor(canvas: HTMLCanvasElement) {
    this.engine = new Engine(canvas, true, {
      preserveDrawingBuffer: false,
      stencil: false,
      antialias: true,
    });

    this.scene = new Scene(this.engine);
    // Background ocean water color matching screenshot
    this.scene.clearColor = new Color4(0.55, 0.88, 0.82, 1.0); // #8de0d1

    // Effectively orthogonal to the ground. ArcRotateCamera needs a tiny
    // non-zero beta to avoid its polar singularity, but 0.01 is visually a
    // true top-down view and keeps circles circular on screen.
    const aspect = window.innerWidth / window.innerHeight;
    const baseRadius = aspect < 1 ? 52 : 42; // pull camera back on portrait
    const cameraBeta = 0.01;

    this.camera = new ArcRotateCamera(
      "MainCamera",
      -Math.PI / 2,
      cameraBeta,
      baseRadius,
      new Vector3(0, 0, 0),
      this.scene
    );
    // Lock camera – no user rotation/zoom/pan
    this.camera.lowerBetaLimit = cameraBeta;
    this.camera.upperBetaLimit = cameraBeta;
    this.camera.lowerRadiusLimit = baseRadius;
    this.camera.upperRadiusLimit = baseRadius;
    this.camera.lowerAlphaLimit = -Math.PI / 2;
    this.camera.upperAlphaLimit = -Math.PI / 2;
    this.camera.fov = 0.78; // ~45 deg FOV
    // Detach user input so touch/mouse doesn't rotate camera
    this.camera.detachControl();

    // Soft ambient hemispheric lighting
    this.hemiLight = new HemisphericLight(
      "HemiLight",
      new Vector3(0, 1, 0),
      this.scene
    );
    this.hemiLight.intensity = 0.65;
    this.hemiLight.diffuse.set(1, 1, 1);
    this.hemiLight.groundColor.set(0.8, 0.9, 0.88);

    // Directional light for clean 3D character shading
    this.dirLight = new DirectionalLight(
      "DirLight",
      new Vector3(-0.5, -1, -0.4).normalize(),
      this.scene
    );
    this.dirLight.intensity = 0.20;
    this.dirLight.diffuse.set(1, 1, 1);

    // Window resize handler – also adapt camera radius
    window.addEventListener("resize", () => {
      this.engine.resize();
      const newAspect = window.innerWidth / window.innerHeight;
      const newRadius = newAspect < 1 ? 52 : 42;
      this.camera.radius = newRadius;
      this.camera.lowerRadiusLimit = newRadius;
      this.camera.upperRadiusLimit = newRadius;
    });
  }

  setCameraTarget(x: number, z: number) {
    // Follow the same already-smoothed pose as the local character. Keeping a
    // second camera lerp here creates visible relative drift when FPS changes.
    this.targetPosition.x = x;
    this.targetPosition.z = z;
    this.camera.target.copyFrom(this.targetPosition);
  }

  startRenderLoop(onUpdate: (deltaTime: number) => void) {
    this.engine.runRenderLoop(() => {
      const dt = this.engine.getDeltaTime() / 1000;
      try {
        onUpdate(dt);
      } catch (err) {
        console.error("[SceneManager] render loop error:", err);
      }
      this.scene.render();
    });
  }

  destroy() {
    this.scene.dispose();
    this.engine.dispose();
  }
}
