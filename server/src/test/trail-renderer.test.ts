import { NullEngine, Scene, VertexBuffer } from "@babylonjs/core";
import { afterEach, describe, expect, it } from "vitest";
import { TrailRenderer } from "../../../src/game/TrailRenderer.js";

function getTrailPositions(scene: Scene): number[] {
  const mesh = scene.getMeshByName("trail_player");
  expect(mesh).not.toBeNull();
  const positions = mesh!.getVerticesData(VertexBuffer.PositionKind);
  expect(positions).not.toBeNull();
  return Array.from(positions!);
}

function getHeadCenter(positions: number[]): [number, number] {
  const totalVertices = positions.length / 3;
  const capacity = (totalVertices - 36) / 3;
  const headCenterVertex = capacity * 3 + 18;
  return [positions[headCenterVertex * 3], positions[headCenterVertex * 3 + 2]];
}

describe("TrailRenderer presentation spine", () => {
  const engines: NullEngine[] = [];

  afterEach(() => {
    for (const engine of engines) engine.dispose();
    engines.length = 0;
  });

  it("keeps the committed prefix and mesh stable when a network batch grows", () => {
    const engine = new NullEngine();
    engines.push(engine);
    const scene = new Scene(engine);
    const renderer = new TrailRenderer(scene);
    let packet = [
      0, 0,
      0.55, 0,
    ];

    for (let frame = 0; frame <= 40; frame++) {
      const angle = frame * 0.035;
      renderer.updateTrail(
        "player",
        "#ff00aa",
        packet,
        0.55 + Math.sin(angle) * 4,
        4 - Math.cos(angle) * 4
      );
    }

    const mesh = scene.getMeshByName("trail_player");
    const prefixBefore = getTrailPositions(scene).slice(0, 5 * 9);

    // This mimics a 3 Hz packet suddenly contributing several bend samples.
    packet = [
      ...packet,
      1.3, 0.1,
      1.9, 0.3,
      2.5, 0.7,
      3.0, 1.2,
    ];
    for (let frame = 41; frame <= 60; frame++) {
      const angle = frame * 0.035;
      renderer.updateTrail(
        "player",
        "#ff00aa",
        packet,
        0.55 + Math.sin(angle) * 4,
        4 - Math.cos(angle) * 4
      );
    }

    expect(scene.getMeshByName("trail_player")).toBe(mesh);
    expect(getTrailPositions(scene).slice(0, prefixBefore.length)).toEqual(prefixBefore);
    expect(getTrailPositions(scene).every(Number.isFinite)).toBe(true);
  });

  it("holds the cap when an out-of-order head would reverse the trail", () => {
    const engine = new NullEngine();
    engines.push(engine);
    const scene = new Scene(engine);
    const renderer = new TrailRenderer(scene);
    const packet = [
      0, 0,
      0.55, 0,
    ];

    renderer.updateTrail("player", "#00d2ff", packet, 2.2, 0);
    const headBefore = getHeadCenter(getTrailPositions(scene));
    // A correction larger than one world unit used to bypass the direction
    // guard and permanently commit a backwards hairpin.
    renderer.updateTrail("player", "#00d2ff", packet, 1.0, 0);
    const headAfter = getHeadCenter(getTrailPositions(scene));

    expect(headAfter).toEqual(headBefore);
    expect(headAfter[0]).toBeCloseTo(2.2, 5);
    expect(headAfter[1]).toBeCloseTo(0, 5);

    renderer.clearTrail("player");
    expect(scene.getMeshByName("trail_player")).toBeNull();
  });
});
