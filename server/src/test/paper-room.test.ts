import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "@colyseus/core";
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
  matchWasContested: boolean;
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
  eliminatePlayer(
    victimId: string,
    killerId: string,
    isSuicide: boolean,
    broadcastGrid?: boolean,
    checkMatchState?: boolean
  ): void;
  checkLateGame(): boolean;
  checkGameOver(): void;
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

function setTerritoryCellCounts(
  room: PaperRoom,
  internals: PaperRoomInternals,
  ownership: Array<readonly [playerId: string, cells: number]>
) {
  internals.grid.cells.fill(0);
  let ownerIndex = 0;
  let remaining = ownership[0]?.[1] ?? 0;

  for (let cell = 0; cell < internals.grid.totalCells; cell++) {
    if (internals.grid.playableMask[cell] !== 1) continue;
    while (ownerIndex < ownership.length && remaining === 0) {
      ownerIndex++;
      remaining = ownership[ownerIndex]?.[1] ?? 0;
    }
    if (ownerIndex >= ownership.length) break;

    const [playerId] = ownership[ownerIndex];
    internals.grid.cells[cell] = internals.grid.getPlayerIndex(playerId);
    remaining--;
  }

  for (const [playerId] of ownership) {
    const player = room.state.players.get(playerId)!;
    player.territoryCells = internals.grid.countTerritoryCells(playerId);
    player.territoryPercent = internals.grid.getTerritoryPercent(playerId);
  }
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

  it("starts a normal joined room with living opponents instead of an instant win", () => {
    const { room, internals, broadcastSpy } = createRoomHarness();
    const client = {
      sessionId: "joining-human",
      send: vi.fn(),
      leave: vi.fn().mockResolvedValue(undefined),
    } as unknown as Client;

    room.onJoin(client, { name: "Human" });

    const alivePlayers = [...room.state.players.values()].filter(
      (player) => player.alive
    );
    expect(alivePlayers).toHaveLength(5);
    expect(internals.bots.size).toBe(4);
    expect(internals.matchWasContested).toBe(true);
    expect(internals.isGameOver).toBe(false);
    expect(room.state.gameOver).toBe(false);
    expect(
      broadcastSpy.mock.calls.filter(([type]) => type === "game_over")
    ).toHaveLength(0);
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

  it("keeps dead Bots retired after the room locks", () => {
    const { room, internals } = createRoomHarness();
    vi.spyOn(room, "lock").mockResolvedValue(undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const leader = internals.spawnPlayer("leader", "Leader", false);
    internals.spawnBot();
    internals.spawnBot();
    const [scheduledBotId, lateDeathBotId] = internals.bots.keys();
    const scheduledBot = room.state.players.get(scheduledBotId)!;
    const lateDeathBot = room.state.players.get(lateDeathBotId)!;
    const deathTime = Date.now();

    scheduledBot.alive = false;
    internals.updateInner(1000 / 30);
    expect(internals.botRespawnAt.get(scheduledBotId)).toBe(deathTime + 1800);

    setTerritoryCellCounts(room, internals, [
      [leader.id, internals.grid.playableCellCount / 2 + 1],
    ]);
    expect(internals.checkLateGame()).toBe(true);
    lateDeathBot.alive = false;
    const scheduledLifeId = scheduledBot.lifeId;
    const lateDeathLifeId = lateDeathBot.lifeId;

    vi.setSystemTime(deathTime + 1800);
    internals.updateInner(1000 / 30);

    expect(scheduledBot.alive).toBe(false);
    expect(lateDeathBot.alive).toBe(false);
    expect(scheduledBot.lifeId).toBe(scheduledLifeId);
    expect(lateDeathBot.lifeId).toBe(lateDeathLifeId);
    expect(internals.botRespawnAt.size).toBe(0);
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
    const witness = internals.spawnPlayer("witness", "Witness", false);
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
    expect(witness.alive).toBe(true);
    expect(internals.isGameOver).toBe(false);
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
    const remainingOpponent = internals.spawnPlayer(
      "remaining-opponent",
      "Outside",
      false
    );
    trapped.x = 0;
    trapped.y = 0;
    const [outerPosition] = sampleArenaContour(1, PLAYER_RADIUS);
    remainingOpponent.x = outerPosition.x;
    remainingOpponent.y = outerPosition.y;
    internals.grid.clearPlayerTerritory(remainingOpponent.id);
    remainingOpponent.territoryCells = internals.grid.spawnBase(
      remainingOpponent.id,
      outerPosition.x,
      outerPosition.y
    );
    remainingOpponent.territoryPercent = internals.grid.getTerritoryPercent(
      remainingOpponent.id
    );

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
    const playerShare =
      100 *
      internals.grid.countTerritoryCells(player.id) /
      internals.grid.playableCellCount;
    expect(claimedAfter).toBeGreaterThan(50);
    expect(player.territoryPercent).toBeGreaterThan(50);
    expect(player.territoryPercent).toBeCloseTo(playerShare, 2);
    expect(trapped.alive).toBe(false);
    expect(remainingOpponent.alive).toBe(true);
    expect(
      broadcastSpy.mock.calls.filter(([type]) => type === "full_grid_sync")
    ).toHaveLength(1);
    expect(internals.isGameOver).toBe(false);
    expect(internals.isLateGame).toBe(true);
    expect(lockSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps admissions open when combined territory exceeds 50 percent but no player does", () => {
    const { room, internals } = createRoomHarness();
    const lockSpy = vi.spyOn(room, "lock").mockResolvedValue(undefined);
    const first = internals.spawnPlayer("first", "First", false);
    const second = internals.spawnPlayer("second", "Second", false);
    const thirtyPercent = Math.floor(internals.grid.playableCellCount * 0.3);
    setTerritoryCellCounts(room, internals, [
      [first.id, thirtyPercent],
      [second.id, thirtyPercent],
    ]);

    expect(internals.checkLateGame()).toBe(false);
    expect(internals.isLateGame).toBe(false);
    expect(lockSpy).not.toHaveBeenCalled();

    internals.spawnBot();
    expect(internals.bots.size).toBe(1);
  });

  it("blocks new human players and Bots only after one player owns more than 50 percent", () => {
    const { room, internals } = createRoomHarness();
    const lockSpy = vi.spyOn(room, "lock").mockResolvedValue(undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const leader = internals.spawnPlayer("leader", "Leader", false);
    const halfOfMap = internals.grid.playableCellCount / 2;
    setTerritoryCellCounts(room, internals, [[leader.id, halfOfMap]]);

    expect(internals.checkLateGame()).toBe(false);
    expect(lockSpy).not.toHaveBeenCalled();

    setTerritoryCellCounts(room, internals, [[leader.id, halfOfMap + 1]]);
    internals.spawnBot();

    const leaveSpy = vi.fn().mockResolvedValue(undefined);
    const lateClient = {
      sessionId: "late-human",
      leave: leaveSpy,
    } as unknown as Client;

    room.onJoin(lateClient, { name: "Too Late" });

    expect(internals.isLateGame).toBe(true);
    expect(lockSpy).toHaveBeenCalledTimes(1);
    expect(leaveSpy).toHaveBeenCalledWith(
      4403,
      "A player controls more than 50% of the map"
    );
    expect(room.state.players.has(lateClient.sessionId)).toBe(false);
    expect(internals.bots.size).toBe(0);
  });

  it("ends the match from an arena-legal outer enclosure", () => {
    const { room, internals, broadcastSpy } = createRoomHarness();
    vi.spyOn(room, "lock").mockResolvedValue(undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const player = internals.spawnPlayer("legal-winner", "Navigator", false);
    const outerRoute = sampleArenaContour(512, PLAYER_RADIUS);
    for (const point of outerRoute) {
      expect(arenaBoundaryClearance(point.x, point.y)).toBeCloseTo(
        PLAYER_RADIUS,
        8
      );
    }

    player.x = outerRoute[0].x;
    player.y = outerRoute[0].y;
    player.inTerritory = true;
    internals.playerTrails.set(
      player.id,
      outerRoute.map((point) => new TrailPoint(point.x, point.y))
    );

    internals.captureTerritory(player);

    expect(internals.isGameOver).toBe(true);
    expect(room.state.gameOver).toBe(true);
    expect(room.state.winnerId).toBe(player.id);
    expect(room.state.winnerReason).toBe("map_occupied");
    expect(player.territoryPercent).toBe(100);
    expect(internals.grid.countNeutralCells()).toBe(0);
    expect(
      broadcastSpy.mock.calls.filter(([type]) => type === "game_over")
    ).toHaveLength(1);
  });

  it("does not end while even one playable cell remains unclaimed", () => {
    const { room, internals, broadcastSpy } = createRoomHarness();
    const player = internals.spawnPlayer("almost-winner", "Almost", false);
    setTerritoryCellCounts(room, internals, [
      [player.id, internals.grid.playableCellCount],
    ]);
    const unfinishedCell = internals.grid.completionMask.findIndex(
      (isRequired) => isRequired === 1
    );
    internals.grid.cells[unfinishedCell] = 0;
    player.territoryCells = internals.grid.countTerritoryCells(player.id);
    player.territoryPercent = internals.grid.getTerritoryPercent(player.id);

    // The HUD must not display completion before the integer grid is full.
    expect(player.territoryPercent).toBe(99.99);
    expect(player.territoryCells).toBe(internals.grid.playableCellCount - 1);

    internals.checkGameOver();

    expect(internals.isGameOver).toBe(false);
    expect(room.state.gameOver).toBe(false);
    expect(
      broadcastSpy.mock.calls.filter(([type]) => type === "game_over")
    ).toHaveLength(0);
  });

  it("does not award a last-survivor victory before a match was contested", () => {
    const { room, internals, broadcastSpy } = createRoomHarness();
    internals.spawnPlayer("solo", "Solo", false);

    internals.checkGameOver();

    expect(internals.matchWasContested).toBe(false);
    expect(internals.isGameOver).toBe(false);
    expect(room.state.gameOver).toBe(false);
    expect(
      broadcastSpy.mock.calls.filter(([type]) => type === "game_over")
    ).toHaveLength(0);
  });

  it("ends with the last survivor and preserves their actual territory", () => {
    const { room, internals, broadcastSpy } = createRoomHarness();
    const lockSpy = vi.spyOn(room, "lock").mockResolvedValue(undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const winner = internals.spawnPlayer("survivor", "Survivor", false);
    const opponent = internals.spawnPlayer("opponent", "Opponent", false);

    internals.eliminatePlayer(opponent.id, winner.id, false);
    internals.checkGameOver();

    expect(internals.isGameOver).toBe(true);
    expect(room.state.gameOver).toBe(true);
    expect(room.state.winnerId).toBe(winner.id);
    expect(room.state.winnerReason).toBe("last_survivor");
    expect(room.state.winnerPercent).toBe(winner.territoryPercent);
    expect(room.state.winnerPercent).toBeLessThan(100);
    expect(room.state.winnerKills).toBe(1);
    expect(lockSpy).toHaveBeenCalledTimes(1);

    const gameOverCalls = broadcastSpy.mock.calls.filter(
      ([type]) => type === "game_over"
    );
    expect(gameOverCalls).toHaveLength(1);
    expect(gameOverCalls[0][1]).toEqual({
      winnerId: winner.id,
      winnerName: winner.name,
      winnerColor: winner.color,
      winnerPercent: winner.territoryPercent,
      winnerKills: 1,
      victoryReason: "last_survivor",
    });
  });

  it("waits until every opponent is gone before declaring a survivor", () => {
    const { room, internals, broadcastSpy } = createRoomHarness();
    vi.spyOn(room, "lock").mockResolvedValue(undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const winner = internals.spawnPlayer("winner", "Winner", false);
    const firstOpponent = internals.spawnPlayer("first-opponent", "First", false);
    const lastOpponent = internals.spawnPlayer("last-opponent", "Last", false);

    internals.eliminatePlayer(firstOpponent.id, winner.id, false);

    expect(internals.isGameOver).toBe(false);
    expect(lastOpponent.alive).toBe(true);
    expect(
      broadcastSpy.mock.calls.filter(([type]) => type === "game_over")
    ).toHaveLength(0);

    internals.eliminatePlayer(lastOpponent.id, winner.id, false);

    expect(internals.isGameOver).toBe(true);
    expect(room.state.winnerId).toBe(winner.id);
    expect(room.state.winnerKills).toBe(2);
    expect(room.state.winnerReason).toBe("last_survivor");
    expect(
      broadcastSpy.mock.calls.filter(([type]) => type === "game_over")
    ).toHaveLength(1);
  });

  it("treats the last opponent leaving as a survivor victory", () => {
    const { room, internals, broadcastSpy } = createRoomHarness();
    vi.spyOn(room, "lock").mockResolvedValue(undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const winner = internals.spawnPlayer("stayer", "Stayer", false);
    const leaver = internals.spawnPlayer("leaver", "Leaver", false);

    room.onLeave({ sessionId: leaver.id } as Client);

    expect(room.state.players.has(leaver.id)).toBe(false);
    expect(internals.grid.getPlayerIndex(leaver.id)).toBe(0);
    expect(internals.isGameOver).toBe(true);
    expect(room.state.winnerId).toBe(winner.id);
    expect(room.state.winnerReason).toBe("last_survivor");
    expect(
      broadcastSpy.mock.calls.filter(([type]) => type === "game_over")
    ).toHaveLength(1);
  });

  it("does not invent a winner when no living players remain", () => {
    const { room, internals, broadcastSpy } = createRoomHarness();
    const first = internals.spawnPlayer("first", "First", false);
    const second = internals.spawnPlayer("second", "Second", false);
    first.alive = false;
    second.alive = false;

    internals.checkGameOver();

    expect(internals.matchWasContested).toBe(true);
    expect(internals.isGameOver).toBe(false);
    expect(room.state.gameOver).toBe(false);
    expect(
      broadcastSpy.mock.calls.filter(([type]) => type === "game_over")
    ).toHaveLength(0);
  });

  it("does not declare a winner when several players collectively fill the map", () => {
    const { room, internals, broadcastSpy } = createRoomHarness();
    const first = internals.spawnPlayer("first-owner", "First", false);
    const second = internals.spawnPlayer("second-owner", "Second", false);
    const firstShare = Math.floor(internals.grid.playableCellCount / 2);
    setTerritoryCellCounts(room, internals, [
      [first.id, firstShare],
      [second.id, internals.grid.playableCellCount - firstShare],
    ]);

    expect(internals.grid.countNeutralCells()).toBe(0);
    internals.checkGameOver();

    expect(internals.isGameOver).toBe(false);
    expect(room.state.gameOver).toBe(false);
    expect(
      broadcastSpy.mock.calls.filter(([type]) => type === "game_over")
    ).toHaveLength(0);
  });

  it("broadcasts one final result after a player owns every playable cell", () => {
    const { room, internals, broadcastSpy } = createRoomHarness();
    vi.spyOn(room, "lock").mockResolvedValue(undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const winner = internals.spawnPlayer("full-owner", "Cartographer", false);
    const firstVictim = internals.spawnPlayer("victim-a", "A", false);
    const secondVictim = internals.spawnPlayer("victim-b", "B", false);
    setTerritoryCellCounts(room, internals, [
      [winner.id, internals.grid.playableCellCount - 2],
      [firstVictim.id, 1],
      [secondVictim.id, 1],
    ]);

    // Enclosure capture batches eliminations and checks the result only after
    // every transfer, so the result includes the final kill total.
    internals.eliminatePlayer(firstVictim.id, winner.id, false, false, false);
    internals.eliminatePlayer(secondVictim.id, winner.id, false, false, false);
    expect(internals.grid.countTerritoryCells(winner.id)).toBe(
      internals.grid.playableCellCount
    );
    expect(
      broadcastSpy.mock.calls.filter(([type]) => type === "game_over")
    ).toHaveLength(0);

    internals.checkGameOver();
    internals.checkGameOver();

    expect(internals.isGameOver).toBe(true);
    expect(room.state.gameOver).toBe(true);
    expect(room.state.winnerId).toBe(winner.id);
    expect(room.state.winnerName).toBe(winner.name);
    expect(room.state.winnerColor).toBe(winner.color);
    expect(room.state.winnerPercent).toBe(100);
    expect(room.state.winnerKills).toBe(2);
    expect(room.state.winnerReason).toBe("map_occupied");
    expect(winner.territoryCells).toBe(internals.grid.playableCellCount);
    expect(winner.territoryPercent).toBe(100);

    const gameOverCalls = broadcastSpy.mock.calls.filter(
      ([type]) => type === "game_over"
    );
    expect(gameOverCalls).toHaveLength(1);
    expect(gameOverCalls[0][1]).toEqual({
      winnerId: winner.id,
      winnerName: winner.name,
      winnerColor: winner.color,
      winnerPercent: 100,
      winnerKills: 2,
      victoryReason: "map_occupied",
    });
  });

  it("rejects new contestants after a survivor result", () => {
    const { room, internals } = createRoomHarness();
    vi.spyOn(room, "lock").mockResolvedValue(undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const winner = internals.spawnPlayer("winner", "Winner", false);
    const opponent = internals.spawnPlayer("opponent", "Opponent", false);
    internals.eliminatePlayer(opponent.id, winner.id, false);

    const leaveSpy = vi.fn().mockResolvedValue(undefined);
    const lateClient = {
      sessionId: "late-contestant",
      leave: leaveSpy,
    } as unknown as Client;
    room.onJoin(lateClient, { name: "Too Late" });
    const botCount = internals.bots.size;
    internals.spawnBot();

    expect(leaveSpy).toHaveBeenCalledWith(4403, "The match is already complete");
    expect(room.state.players.has(lateClient.sessionId)).toBe(false);
    expect(internals.bots.size).toBe(botCount);
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
    expect(room.state.gameOver).toBe(false);
    expect(room.state.winnerId).toBe("");
    expect(room.state.winnerName).toBe("");
    expect(room.state.winnerColor).toBe("");
    expect(room.state.winnerPercent).toBe(0);
    expect(room.state.winnerKills).toBe(0);
    expect(room.state.winnerReason).toBe("");
    expect(internals.matchWasContested).toBe(true);
    expect(internals.botRespawnAt.size).toBe(0);
    expect(unlockSpy).toHaveBeenCalledTimes(1);
    for (const player of room.state.players.values()) {
      expect(player.alive).toBe(true);
    }
  });

  it("does not carry a stale contested latch into a single-player reset", () => {
    const { room, internals } = createRoomHarness();
    vi.spyOn(room, "unlock").mockResolvedValue(undefined);
    internals.spawnPlayer("solo", "Solo", false);
    internals.matchWasContested = true;
    internals.isGameOver = true;

    internals.resetMatch();
    internals.checkGameOver();

    expect(internals.matchWasContested).toBe(false);
    expect(internals.isGameOver).toBe(false);
    expect(room.state.gameOver).toBe(false);
  });
});
