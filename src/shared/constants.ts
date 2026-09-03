export const ARENA_SIZE = 160;
export const HALF_ARENA_SIZE = ARENA_SIZE / 2;
export const GRID_CELLS = 120;
export const CELL_SIZE = ARENA_SIZE / GRID_CELLS; // ~1.333 world units per cell

export const PLAYER_SPEED = 14.0;
export const PLAYER_BOOST_SPEED = 20.0;
export const PLAYER_TURN_SPEED = 8.0;
export const PLAYER_RADIUS = 1.2;
export const TRAIL_RADIUS = 0.45;
export const TRAIL_MIN_SEGMENT_DIST = 0.55;

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

export const CHARACTER_SKINS = [
  "box-bear",
  "box-fox",
  "box-bot",
  "box-bunny",
  "box-cat",
  "box-frog",
];
