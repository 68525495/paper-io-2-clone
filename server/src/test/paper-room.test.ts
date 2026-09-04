import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BotController } from "../bot.js";
import {
  arenaBoundaryClearance,
  arenaRadiusAtAngle,
  isPointInsideArena,
  sampleArenaContour,
} from "../arenaShape.js";
import {
  CELL_SIZE,
  INITIAL_BASE_COUNT,
  INITIAL_BASE_RADIUS_CELLS,
  PLAYER_RADIUS,
} from "../constants.js";
import { PaperRoom } from "../PaperRoom.js";
import { GameState, PlayerState, TrailPoint } from "../schema.js";
import { TerritoryGrid } from "../territory.js";

interface PaperRoomInternals {
  grid: TerritoryGrid;
  playerTrails: Map<string, TrailPoint[]>;
  bots: Map<string, BotController>;
  botRespawnAt: Map<string, number>;
  isGameOver: boolean;
  isLateGame: boolean;
  playerInputs: Map<
    string,
    {
      targetAngle: number;
      boost: boolean;
      seq: number;
      dt: number;
      clientTime: number;
    }
  >;
  spawnPlayer(id: string, name: string, isBot: boolean): PlayerState;
  spawnBot(): void;
  updateInner(deltaTime: number): void;
  checkTrailCollisions(): void;
  captureTerritory(player: PlayerState): void;
  buildFullTrailSync(): Record<string, number[]>;
  resetMatch(): void;
}

function createRoomHarness() {
  const room = new PaperRoom();
  room.setState(new GameState());
  const broadcastSpy = vi
    .spyOn(room as unknown as { broadcast: (...args: unknown[]) => void }, "broadcast")
    .mockImplementation(() => undefined);

  return {
    room,
    internals: room as unknown as PaperRoomInternals,
    broadcastSpy,
  };
}

describe("PaperRoom authoritative regressions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("keeps a dead bot inactive for the full 1.8 second respawn delay", () => {
    const { room, internals } = createRoomHarness();
    internals.spawnBot();

    const [botId] = internals.bots.keys();
    const bot = room.state.players.get(botId)!;
    const deathTime = Date.now();
    bot.alive = false;

    internals.updateInner(1000 / 30);
    expect(internals.botRespawnAt.get(botId)).toBe(deathTime + 1800);
    expect(bot.alive).toBe(false);

    vi.setSystemTime(deathTime + 1799);
    internals.updateInner(1000 / 30);
    expect(bot.alive).toBe(false);

    vi.setSystemTime(deathTime + 1800);
    internals.updateInner(1000 / 30);
    expect(bot.alive).toBe(true);
    expect(internals.botRespawnAt.has(botId)).toBe(false);
  });

  it("publishes authoritative velocity and the processed input sequence", () => {
    const { internals } = createRoomHarness();
    const player = internals.spawnPlayer("synced-player", "Synced", false);
    player.x = 0;
    player.y = 0;
    player.angle = 0;
    player.targetAngle = 0;
    const input = internals.playerInputs.get(player.id)!;
    input.targetAngle = 0;
    input.seq = 17;

    internals.updateInner(1000 / 30);

    expect(player.lastProcessedInputSeq).toBe(17);
    expect(player.vx).toBeCloseTo(14, 5);
    expect(player.vy).toBeCloseTo(0, 5);
  });

  it("increments the life id and clears motion when a player respawns", () => {
    const { internals } = createRoomHarness();
    const player = internals.spawnPlayer("respawning-player", "Runner", false);
    const firstLifeId = player.lifeId;
    player.vx = 12;
    player.vy = -4;

    const respawned = internals.spawnPlayer(player.id, player.name, false);

    expect(respawned).toBe(player);
    expect(respawned.lifeId).toBe(firstLifeId + 1);
    expect(respawned.vx).toBe(0);
    expect(respawned.vy).toBe(0);
    expect(respawned.lastProcessedInputSeq).toBe(0);
  });

  it("ignores collisions with the player's own trail", () => {
    const { room, internals, broadcastSpy } = createRoomHarness();
    const player = internals.spawnPlayer("self-hit", "Looper", false);
    player.x = 0;
    player.y = 0.5;
    player.score = 321;
    player.kills = 4;

    const trail = [
      new TrailPoint(-3, 0),
      new TrailPoint(-2, 0),
      new TrailPoint(-1, 0),
      new TrailPoint(0, 0),
      new TrailPoint(1, 0),
      new TrailPoint(2, 0),
      new TrailPoint(3, 0),
      new TrailPoint(3, 1),
      new TrailPoint(3, 2),
      new TrailPoint(2, 2),
      new TrailPoint(1, 1),
      new TrailPoint(0, 0.5),
    ];
    internals.playerTrails.set("self-hit", trail);

    internals.checkTrailCollisions();

    expect(player.alive).toBe(true);
    expect(player.kills).toBe(4);
    expect(player.score).toBe(321);
    expect(internals.playerTrails.get(player.id)).toBe(trail);
    expect(broadcastSpy).not.toHaveBeenCalledWith(
      "player_killed",
      expect.anything()
    );
  });

  it("still eliminates a player when an opponent cuts their trail", () => {
    const { room, internals, broadcastSpy } = createRoomHarness();
    const attacker = internals.spawnPlayer("attacker", "Cutter", false);
    const victim = internals.spawnPlayer("victim", "Runner", false);
    attacker.x = 0;
    attacker.y = 0.5;
    attacker.kills = 2;
    internals.playerTrails.set(victim.id, [
      new TrailPoint(-3, 0),
      new TrailPoint(3, 0),
    ]);

    internals.checkTrailCollisions();

    expect(attacker.alive).toBe(true);
    expect(attacker.kills).toBe(3);
    expect(victim.alive).toBe(false);
    expect(internals.playerTrails.get(victim.id)).toEqual([]);
    expect(broadcastSpy).toHaveBeenCalledWith(
      "player_killed",
      expect.objectContaining({
        killerId: attacker.id,
        victimId: victim.id,
        isSuicide: false,
      })
    );
  });

  it("packs complete trail snapshots in the legacy-compatible wire format", () => {
    const { internals } = createRoomHarness();
    const player = internals.spawnPlayer("snapshot-runner", "Snapshot", false);
    const trail = [
      new TrailPoint(0, 0),
      new TrailPoint(1, 1),
      new TrailPoint(2, 2),
    ];
    internals.playerTrails.set(player.id, trail);

    expect(internals.buildFullTrailSync()[player.id]).toEqual([
      0, 0, 1, 1, 2, 2,
    ]);

    trail.push(new TrailPoint(3, 3));
    expect(internals.buildFullTrailSync()[player.id]).toEqual([
      0, 0, 1, 1, 2, 2, 3, 3,
    ]);

    internals.playerTrails.set(player.id, []);
    expect(internals.buildFullTrailSync()[player.id]).toBeUndefined();
  });

  it("keeps repeated spawns and their complete bases inside the organic arena", () => {
    const { internals } = createRoomHarness();
    let randomState = 0x51f15e;
    vi.spyOn(Math, "random").mockImplementation(() => {
      randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
      return randomState / 0x1_0000_0000;
    });
    const spawnInset =
      INITIAL_BASE_RADIUS_CELLS * CELL_SIZE + PLAYER_RADIUS + CELL_SIZE;

    for (let index = 0; index < 24; index++) {
      const id = `spawn-${index}`;
      const player = internals.spawnPlayer(id, `Player ${index}`, false);

      expect(isPointInsideArena(player.x, player.y, spawnInset)).toBe(true);
      expect(internals.grid.isOwnTerritory(id, player.x, player.y)).toBe(true);
      expect(player.territoryCells).toBe(INITIAL_BASE_COUNT);

      const playerIndex = internals.grid.getPlayerIndex(id);
      for (let cell = 0; cell < internals.grid.totalCells; cell++) {
        if (internals.grid.cells[cell] === playerIndex) {
          expect(internals.grid.playableMask[cell]).toBe(1);
        }
      }
    }
  });

  it.each([
    0,
    Math.PI / 4,
    Math.PI / 2,
    (3 * Math.PI) / 4,
    Math.PI,
    (-3 * Math.PI) / 4,
    -Math.PI / 2,
    -Math.PI / 4,
  ])("keeps an outward-moving player inside at angle %s", (angle) => {
    const { internals } = createRoomHarness();
    const player = internals.spawnPlayer("edge-runner", "Edge Runner", false);
    const startingRadius = arenaRadiusAtAngle(angle) - PLAYER_RADIUS - 0.1;
    player.x = Math.cos(angle) * startingRadius;
    player.y = Math.sin(angle) * startingRadius;
    player.angle = angle;
    player.targetAngle = angle;
    player.inTerritory = false;
    internals.playerTrails.set(player.id, []);
    internals.playerInputs.get(player.id)!.targetAngle = angle;

    internals.updateInner(100);

    expect(arenaBoundaryClearance(player.x, player.y)).toBeGreaterThanOrEqual(
      PLAYER_RADIUS - 1e-9
    );
    expect(Math.hypot(player.x, player.y)).toBeCloseTo(
      arenaRadiusAtAngle(angle) - PLAYER_RADIUS,
      8
    );
  });

  it("locks the room when a normal territory capture crosses 50 percent", () => {
    const { room, internals, broadcastSpy } = createRoomHarness();
    const lockSpy = vi.spyOn(room, "lock").mockResolvedValue(undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const player = internals.spawnPlayer("capturer", "Closer", false);
    const trapped = internals.spawnPlayer("trapped", "Inside", false);
    trapped.x = 0;
    trapped.y = 0;

    internals.grid.clearPlayerTerritory(player.id);
    const loop = sampleArenaContour(128, 12);
    const start = loop[0];
    internals.grid.spawnBase(player.id, start.x, start.y);
    player.x = start.x;
    player.y = start.y;
    player.inTerritory = true;
    internals.playerTrails.set(
      player.id,
      loop.map((point) => new TrailPoint(point.x, point.y))
    );

    const claimedBefore =
      100 *
      (internals.grid.playableCellCount - internals.grid.countNeutralCells()) /
      internals.grid.playableCellCount;
    expect(claimedBefore).toBeLessThan(50);

    internals.captureTerritory(player);

    const claimedAfter =
      100 *
      (internals.grid.playableCellCount - internals.grid.countNeutralCells()) /
      internals.grid.playableCellCount;
    expect(claimedAfter).toBeGreaterThan(50);
    expect(player.territoryPercent).toBeGreaterThan(50);
    expect(player.territoryPercent).toBeCloseTo(claimedAfter, 2);
    expect(trapped.alive).toBe(false);
    expect(
      broadcastSpy.mock.calls.filter(([type]) => type === "full_grid_sync")
    ).toHaveLength(1);
    expect(internals.isGameOver).toBe(false);
    expect(internals.isLateGame).toBe(true);
    expect(lockSpy).toHaveBeenCalledTimes(1);
  });

  it("unlocks a late-game room when resetting the match", () => {
    const { room, internals } = createRoomHarness();
    const unlockSpy = vi.spyOn(room, "unlock").mockResolvedValue(undefined);
    internals.spawnPlayer("human", "Human", false);
    internals.spawnBot();
    internals.isGameOver = true;
    internals.isLateGame = true;
    internals.botRespawnAt.set("bot_1", Date.now() + 1800);

    internals.resetMatch();

    expect(internals.isGameOver).toBe(false);
    expect(internals.isLateGame).toBe(false);
    expect(internals.botRespawnAt.size).toBe(0);
    expect(unlockSpy).toHaveBeenCalledTimes(1);
    for (const player of room.state.players.values()) {
      expect(player.alive).toBe(true);
    }
  });
});
