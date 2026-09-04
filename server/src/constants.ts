export const ARENA_SIZE = 160;
export const HALF_ARENA_SIZE = ARENA_SIZE / 2;
export const GRID_CELLS = 256;
export const CELL_SIZE = ARENA_SIZE / GRID_CELLS; // 0.625 world units per cell

export const PLAYER_SPEED = 14.0;
export const PLAYER_BOOST_SPEED = 20.0;
// Must match the client predictor. 90 degrees takes ~112 ms.
export const PLAYER_TURN_SPEED = 14.0;
export const PLAYER_RADIUS = 1.2;
export const TRAIL_RADIUS = 0.45;
export const TRAIL_MIN_SEGMENT_DIST = 0.55;
export const TRAIL_SELF_HIT_SAFE_SEGMENTS = 5; // Do not collide with recent 5 trail vertices

export const INITIAL_BASE_RADIUS_CELLS = 9; // Preserves the previous ~5.3 world-unit spawn radius
export const INITIAL_BASE_COUNT = 261;

// Keep territory scoring comparable to the original 120x120 grid.
export const TERRITORY_SCORE_PER_CELL = 5 * (120 / GRID_CELLS) ** 2;

export const COLOR_PALETTE = [
  "#00D2FF", // 1. Electric Cyan (Fresh bright cyan)
  "#FF2A6D", // 2. Vivid Hot Coral (Punchy candy coral)
  "#05FFA1", // 3. Neon Spring Mint (Crisp lime mint)
  "#FFD000", // 4. Sunny Lemon (Bright cheerful yellow)
  "#B5179E", // 5. Electric Magenta (Vivid bright magenta)
  "#FF6B35", // 6. Bright Tangerine (Juicy radiant orange)
  "#4361EE", // 7. Brilliant Royal Blue (Sharp modern blue)
  "#7209B7", // 8. Deep Violet (Rich electric purple)
  "#00F5D4", // 9. Bright Aquamarine (Luminous turquoise)
  "#F72585", // 10. Candy Neon Pink (Fresh neon pink)
];

export const BOT_NAMES = [
  "Matakor",
  "Chrono",
  "PixelFox",
  "Boba",
  "Mochi",
  "Spike",
  "Aura",
  "Nebula",
  "Turbo",
  "Zippy",
  "Kitsune",
  "Blaze",
];

export const CHARACTER_SKINS = [
  "box-bear",
  "box-fox",
  "box-bot",
  "box-bunny",
  "box-cat",
  "box-frog",
];

export const MAX_BUBBLES = 0;
export const MAX_COINS = 0;

export const MILESTONES = [10, 25, 50, 75, 100];
