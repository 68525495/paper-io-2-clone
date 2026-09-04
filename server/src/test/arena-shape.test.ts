import { describe, expect, it } from "vitest";
import {
  arenaBoundaryClearance,
  arenaRadiusAtAngle,
  constrainPointToArena,
  isPointInsideArena,
} from "../arenaShape.js";
import { HALF_ARENA_SIZE, PLAYER_RADIUS } from "../constants.js";

describe("organic arena shape", () => {
  it("keeps the center playable while excluding the old square corners", () => {
    expect(isPointInsideArena(0, 0)).toBe(true);

    const oldSquareCorner = HALF_ARENA_SIZE - 0.01;
    expect(isPointInsideArena(oldSquareCorner, oldSquareCorner)).toBe(false);
    expect(isPointInsideArena(-oldSquareCorner, oldSquareCorner)).toBe(false);
    expect(isPointInsideArena(oldSquareCorner, -oldSquareCorner)).toBe(false);
    expect(isPointInsideArena(-oldSquareCorner, -oldSquareCorner)).toBe(false);
  });

  it.each([
    -Math.PI,
    -2.4,
    -Math.PI / 2,
    -0.7,
    0,
    0.65,
    Math.PI / 2,
    2.45,
  ])("projects an outside point to the player-radius inset at angle %s", (angle) => {
    const outsideRadius = HALF_ARENA_SIZE * 2;
    const constrained = constrainPointToArena(
      Math.cos(angle) * outsideRadius,
      Math.sin(angle) * outsideRadius,
      PLAYER_RADIUS
    );

    expect(constrained.constrained).toBe(true);
    expect(Math.hypot(constrained.x, constrained.y)).toBeCloseTo(
      arenaRadiusAtAngle(angle) - PLAYER_RADIUS,
      8
    );
    expect(arenaBoundaryClearance(constrained.x, constrained.y)).toBeCloseTo(
      PLAYER_RADIUS,
      8
    );
    expect(
      isPointInsideArena(
        constrained.x * (1 - 1e-12),
        constrained.y * (1 - 1e-12),
        PLAYER_RADIUS
      )
    ).toBe(true);
  });
});
