import { describe, expect, it } from "vitest";
import { encodeGridRle } from "../protocol.js";
import {
  decodeGridSync,
  type FullGridSyncMessage,
} from "../../../src/shared/protocol.js";

describe("grid wire encoding", () => {
  it("round-trips server RLE through the browser decoder", () => {
    const grid = new Uint8Array([0, 0, 0, 1, 1, 2, 2, 2]);
    const message: FullGridSyncMessage = {
      grid: encodeGridRle(grid),
      width: 4,
      height: 2,
      encoding: "rle",
    };

    expect(Array.from(decodeGridSync(message))).toEqual(Array.from(grid));
  });

  it("keeps raw byte payloads backward compatible", () => {
    const grid = new Uint8Array([1, 2, 3, 4]);
    expect(
      decodeGridSync({ grid, width: 2, height: 2, encoding: "raw" })
    ).toBe(grid);
  });

  it("rejects malformed RLE instead of presenting a partial map", () => {
    expect(() =>
      decodeGridSync({
        grid: [1, 5],
        width: 2,
        height: 2,
        encoding: "rle",
      })
    ).toThrow(/Invalid grid RLE payload/);
  });
});
