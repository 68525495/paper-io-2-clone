import { describe, expect, it } from "vitest";
import {
  MINIMAP_RASTER_SIZE,
  rasterizeMiniMapTerritory,
} from "../../../src/ui/MiniMap.js";
import { GRID_CELLS } from "../../../src/shared/constants.js";

function pixelAt(pixels: Uint8ClampedArray, x: number, y: number) {
  const offset = (y * MINIMAP_RASTER_SIZE + x) * 4;
  return Array.from(pixels.slice(offset, offset + 4));
}

describe("minimap territory raster", () => {
  it("converts sampled ownership cells to one reusable RGBA image", () => {
    const grid = new Uint8Array(GRID_CELLS * GRID_CELLS);
    const pixels = new Uint8ClampedArray(
      MINIMAP_RASTER_SIZE * MINIMAP_RASTER_SIZE * 4
    );

    grid[0] = 1;
    grid[254 * GRID_CELLS + 254] = 2;

    rasterizeMiniMapTerritory(
      grid,
      new Map([
        [1, "#123456"],
        [2, "#ABCDEF"],
      ]),
      pixels
    );

    // Canvas Y runs opposite to the world/grid Y axis.
    expect(pixelAt(pixels, 0, MINIMAP_RASTER_SIZE - 1)).toEqual([
      0x12,
      0x34,
      0x56,
      0xff,
    ]);
    expect(pixelAt(pixels, MINIMAP_RASTER_SIZE - 1, 0)).toEqual([
      0xab,
      0xcd,
      0xef,
      0xff,
    ]);
    expect(pixelAt(pixels, 64, 64)).toEqual([0, 0, 0, 0]);
  });

  it("rejects a buffer that cannot hold the complete raster", () => {
    const grid = new Uint8Array(GRID_CELLS * GRID_CELLS);
    const pixels = new Uint8ClampedArray(4);

    expect(() =>
      rasterizeMiniMapTerritory(grid, new Map(), pixels)
    ).toThrow(/Expected .* minimap RGBA values/);
  });
});
