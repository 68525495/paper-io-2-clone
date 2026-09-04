import { describe, expect, it } from "vitest";
import { advanceTurningPose as advanceClientPose } from "../../../src/shared/movement.js";
import { PLAYER_TURN_SPEED } from "../constants.js";
import { advanceTurningPose as advanceServerPose } from "../movement.js";

interface Pose {
  x: number;
  y: number;
  angle: number;
}

function createPose(): Pose {
  return { x: -3.5, y: 7.25, angle: -0.7 };
}

function runSteps(
  advance: typeof advanceServerPose,
  stepCount: number,
  totalSeconds: number
): Pose {
  const pose = createPose();
  for (let step = 0; step < stepCount; step++) {
    advance(
      pose,
      1.2,
      14,
      PLAYER_TURN_SPEED,
      totalSeconds / stepCount
    );
  }
  return pose;
}

function expectSamePose(actual: Pose, expected: Pose) {
  expect(actual.x).toBeCloseTo(expected.x, 10);
  expect(actual.y).toBeCloseTo(expected.y, 10);
  expect(actual.angle).toBeCloseTo(expected.angle, 10);
}

describe("frame-rate-independent turning motion", () => {
  it("produces the same arc at one step, 30 Hz and 120 Hz", () => {
    const singleStep = runSteps(advanceServerPose, 1, 1);
    expectSamePose(runSteps(advanceServerPose, 30, 1), singleStep);
    expectSamePose(runSteps(advanceServerPose, 120, 1), singleStep);
  });

  it("keeps client prediction bit-for-bit aligned with server math", () => {
    const clientPose = runSteps(advanceClientPose, 17, 0.31);
    const serverPose = runSteps(advanceServerPose, 17, 0.31);
    expect(clientPose).toEqual(serverPose);
  });
});
