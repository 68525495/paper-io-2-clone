import { describe, expect, it } from "vitest";
import { applyTrailSync } from "../../../src/game/GameClient.js";

describe("trail synchronization compatibility", () => {
  it("replaces stale data with a complete packed snapshot", () => {
    const trails = { stale: [9, 9] };

    const next = applyTrailSync(trails, {
      player: [0, 0, 1, 1, 2, 2],
    });

    expect(next).toEqual({ player: [0, 0, 1, 1, 2, 2] });
    expect(next).not.toBe(trails);
    expect(applyTrailSync(next, {})).toEqual({});
  });

  it("also accepts incremental packets during a rolling server restart", () => {
    let trails: Record<string, number[]> = {};

    trails = applyTrailSync(trails, {
      player: {
        reset: true,
        startPoint: 0,
        points: [0, 0, 1, 1],
      },
    });
    trails = applyTrailSync(trails, {
      player: {
        reset: false,
        startPoint: 2,
        points: [2, 2, 3, 3],
      },
    });

    expect(trails.player).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
  });

  it("drops a gapped incremental packet instead of drawing a false segment", () => {
    const trails = { player: [0, 0, 1, 1] };

    applyTrailSync(trails, {
      player: {
        reset: false,
        startPoint: 3,
        points: [4, 4],
      },
    });

    expect(trails.player).toBeUndefined();
  });
});
