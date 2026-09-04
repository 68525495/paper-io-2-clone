import { describe, expect, it } from "vitest";
import { BotBehavior, BotController } from "../bot.js";
import {
  arenaBoundaryClearance,
  arenaRadiusAtAngle,
} from "../arenaShape.js";
import {
  PLAYER_RADIUS,
  PLAYER_SPEED,
  PLAYER_TURN_SPEED,
  TRAIL_MIN_SEGMENT_DIST,
} from "../constants.js";
import { angleDiff, gridToWorld, stepAngle } from "../geometry.js";
import { PlayerState, TrailPoint } from "../schema.js";
import { TerritoryGrid } from "../territory.js";

const DECISION_DT = 0.1;

function makePlayer(
  id: string,
  overrides: Partial<PlayerState> = {}
): PlayerState {
  const player = new PlayerState();
  Object.assign(player, {
    id,
    alive: true,
    isBot: true,
    speed: PLAYER_SPEED,
    angle: 0,
    targetAngle: 0,
    inTerritory: true,
    ...overrides,
  });
  return player;
}

function fillOwnedRectangle(
  grid: TerritoryGrid,
  playerId: string,
  minX: number,
  maxX: number,
  minY: number,
  maxY: number
) {
  const playerIndex = grid.registerPlayer(playerId);
  for (let gy = minY; gy <= maxY; gy++) {
    for (let gx = minX; gx <= maxX; gx++) {
      grid.setCell(gx, gy, playerIndex);
    }
  }
}

function runUntilBehavior(
  controller: BotController,
  expected: BotBehavior,
  player: PlayerState,
  players: Map<string, PlayerState>,
  grid: TerritoryGrid,
  trails: Map<string, TrailPoint[]>,
  maxUpdates = 80
) {
  let decision = { targetAngle: player.angle, boost: false };
  for (let update = 0; update < maxUpdates; update++) {
    decision = controller.update(player, players, grid, DECISION_DT, trails);
    if (controller.getDebugState().behavior === expected) break;
  }
  return decision;
}

describe("BotController", () => {
  it("produces the same decision trace for the same identity, spawn and observations", () => {
    const id = "deterministic-bot";
    const grid = new TerritoryGrid();
    grid.spawnBase(id, 0, 0);

    const player = makePlayer(id, { angle: 0.35 });
    const players = new Map([[id, player]]);
    const trails = new Map<string, TrailPoint[]>([[id, []]]);

    const first = new BotController(id, 0, 0);
    const second = new BotController(id, 0, 0);

    const trace = (controller: BotController) => {
      const decisions = [];
      for (let tick = 0; tick < 180; tick++) {
        const decision = controller.update(player, players, grid, 1 / 30, trails);
        decisions.push({
          targetAngle: decision.targetAngle,
          boost: decision.boost,
          behavior: controller.getDebugState().behavior,
        });
      }
      return decisions;
    };

    expect(first.getDebugState().personality).toEqual(
      second.getDebugState().personality
    );
    expect(trace(first)).toEqual(trace(second));
  });

  it("returns to the nearest owned boundary instead of the spawn point", () => {
    const id = "returning-bot";
    const grid = new TerritoryGrid();
    fillOwnedRectangle(grid, id, 80, 100, 120, 140);

    const position = gridToWorld(106, 130);
    const deliberatelyWrongHome = { x: 40, y: position.y };
    const player = makePlayer(id, {
      x: position.x,
      y: position.y,
      angle: 0,
      inTerritory: false,
    });
    const players = new Map([[id, player]]);
    const longDistantTrail = Array.from(
      { length: 25 },
      (_, index) => new TrailPoint(-70 + index * 2, -60)
    );
    const trails = new Map<string, TrailPoint[]>([[id, longDistantTrail]]);
    const controller = new BotController(
      id,
      deliberatelyWrongHome.x,
      deliberatelyWrongHome.y
    );

    const decision = runUntilBehavior(
      controller,
      BotBehavior.RETURN_HOME,
      player,
      players,
      grid,
      trails
    );
    const nearestBoundary = grid.findNearestOwnedBoundary(
      id,
      player.x,
      player.y
    );

    expect(controller.getDebugState().behavior).toBe(BotBehavior.RETURN_HOME);
    expect(nearestBoundary).not.toBeNull();
    const boundaryAngle = Math.atan2(
      nearestBoundary!.y - player.y,
      nearestBoundary!.x - player.x
    );
    const spawnAngle = Math.atan2(
      deliberatelyWrongHome.y - player.y,
      deliberatelyWrongHome.x - player.x
    );
    expect(Math.abs(angleDiff(decision.targetAngle, boundaryAngle))).toBeLessThan(
      0.05
    );
    expect(Math.abs(angleDiff(decision.targetAngle, spawnAngle))).toBeGreaterThan(
      1
    );
  });

  it("keeps its exit intent stable across small per-tick observations", () => {
    const id = "stable-bot";
    const grid = new TerritoryGrid();
    grid.spawnBase(id, 0, 0);
    const player = makePlayer(id, { angle: 0.2 });
    const players = new Map([[id, player]]);
    const trails = new Map<string, TrailPoint[]>([[id, []]]);
    const controller = new BotController(id, 0, 0);

    const initial = runUntilBehavior(
      controller,
      BotBehavior.SEEK_EXIT,
      player,
      players,
      grid,
      trails
    );
    expect(controller.getDebugState().behavior).toBe(BotBehavior.SEEK_EXIT);

    for (let tick = 0; tick < 12; tick++) {
      // Tiny observation noise must not make the bot choose a new route each tick.
      player.x = tick % 2 === 0 ? 0.01 : -0.01;
      player.y = tick % 2 === 0 ? -0.01 : 0.01;
      const decision = controller.update(player, players, grid, 1 / 30, trails);
      expect(controller.getDebugState().behavior).toBe(BotBehavior.SEEK_EXIT);
      expect(
        Math.abs(angleDiff(initial.targetAngle, decision.targetAngle))
      ).toBeLessThan(1e-9);
    }
  });

  it("replans a blocked exit at bounded intervals instead of every think", () => {
    const id = "wide-home-bot";
    const grid = new TerritoryGrid();
    fillOwnedRectangle(grid, id, 72, 184, 72, 184);
    const player = makePlayer(id, { x: 0, y: 0, angle: 0.2 });
    const players = new Map([[id, player]]);
    const trails = new Map<string, TrailPoint[]>([[id, []]]);
    const controller = new BotController(id, 0, 0);

    runUntilBehavior(
      controller,
      BotBehavior.SEEK_EXIT,
      player,
      players,
      grid,
      trails
    );

    let previousAngle = controller.getDebugState().targetAngle;
    let directionChanges = 0;
    for (let update = 0; update < 60; update++) {
      const decision = controller.update(
        player,
        players,
        grid,
        DECISION_DT,
        trails
      );
      if (Math.abs(angleDiff(decision.targetAngle, previousAngle)) > 1e-9) {
        directionChanges++;
        previousAngle = decision.targetAngle;
      }
    }

    expect(controller.getDebugState().behavior).toBe(BotBehavior.SEEK_EXIT);
    expect(directionChanges).toBeLessThanOrEqual(3);
  });

  it.each(["capture-loop-bot", "bot_1", "bot_2", "bot_3", "bot_4"])(
    "%s repeatedly leaves home, closes loops and grows territory",
    (id) => {
      const grid = new TerritoryGrid();
      const initialCells = grid.spawnBase(id, 0, 0);
      const player = makePlayer(id, { x: 0, y: 0, angle: 0 });
      const players = new Map([[id, player]]);
      const trail: TrailPoint[] = [];
      const trails = new Map<string, TrailPoint[]>([[id, trail]]);
      const controller = new BotController(id, 0, 0);
      let wasHome = true;
      let exits = 0;
      let captures = 0;

      for (let tick = 0; tick < 3600; tick++) {
        const decision = controller.update(player, players, grid, 1 / 30, trails);
        player.angle = stepAngle(
          player.angle,
          decision.targetAngle,
          PLAYER_TURN_SPEED / 30
        );
        player.x += Math.cos(player.angle) * PLAYER_SPEED / 30;
        player.y += Math.sin(player.angle) * PLAYER_SPEED / 30;

        const isHome = grid.isOwnTerritory(id, player.x, player.y);
        if (!isHome) {
          if (wasHome) exits++;
          const last = trail[trail.length - 1];
          if (
            !last ||
            Math.hypot(player.x - last.x, player.y - last.y) >=
              TRAIL_MIN_SEGMENT_DIST
          ) {
            trail.push(new TrailPoint(player.x, player.y));
          }
        } else if (!wasHome && trail.length > 1) {
          grid.captureEnclosure(
            id,
            [...trail, { x: player.x, y: player.y }],
            new Map()
          );
          trail.length = 0;
          captures++;
        }

        player.inTerritory = isHome;
        wasHome = isHome;
      }

      expect(exits).toBeGreaterThanOrEqual(2);
      expect(captures).toBeGreaterThanOrEqual(2);
      expect(grid.countTerritoryCells(id)).toBeGreaterThan(initialCells);
    }
  );

  it("intercepts an exposed trail only when its ETA advantage is positive", () => {
    const makeScenario = (favorable: boolean) => {
      const botId = "bot";
      const enemyId = favorable ? "enemy-favorable" : "enemy-unfavorable";
      const grid = new TerritoryGrid();
      grid.spawnBase(botId, -20, 0);

      const enemyHomeX = favorable ? 40 : 20;
      const enemyX = favorable ? 20 : 13;
      grid.spawnBase(enemyId, enemyHomeX, 0);

      const bot = makePlayer(botId, {
        x: 0,
        y: 0,
        angle: 0,
        inTerritory: false,
      });
      const enemy = makePlayer(enemyId, {
        x: enemyX,
        y: 0,
        angle: 0,
        isBot: false,
        inTerritory: false,
      });
      const players = new Map<string, PlayerState>([
        [botId, bot],
        [enemyId, enemy],
      ]);
      const enemyTrail = favorable
        ? [
            new TrailPoint(35, 0),
            new TrailPoint(4, 0),
            new TrailPoint(enemyX, 0),
          ]
        : [
            new TrailPoint(14.5, 0),
            new TrailPoint(4, 0),
            new TrailPoint(enemyX, 0),
          ];
      const trails = new Map<string, TrailPoint[]>([
        [botId, []],
        [enemyId, enemyTrail],
      ]);
      return {
        bot,
        players,
        grid,
        trails,
        controller: new BotController(botId, 0, 0),
      };
    };

    const favorable = makeScenario(true);
    const interceptDecision = runUntilBehavior(
      favorable.controller,
      BotBehavior.INTERCEPT,
      favorable.bot,
      favorable.players,
      favorable.grid,
      favorable.trails,
      45
    );
    expect(favorable.controller.getDebugState().behavior).toBe(
      BotBehavior.INTERCEPT
    );
    expect(Math.abs(angleDiff(interceptDecision.targetAngle, 0))).toBeLessThan(
      0.05
    );

    const unfavorable = makeScenario(false);
    for (let tick = 0; tick < 45; tick++) {
      unfavorable.controller.update(
        unfavorable.bot,
        unfavorable.players,
        unfavorable.grid,
        DECISION_DT,
        unfavorable.trails
      );
      expect(unfavorable.controller.getDebugState().behavior).not.toBe(
        BotBehavior.INTERCEPT
      );
    }
  });

  it("keeps an intercept launched from home instead of cancelling it next think", () => {
    const botId = "home-interceptor";
    const enemyId = "exposed-enemy";
    const grid = new TerritoryGrid();
    grid.spawnBase(botId, 0, 0);
    grid.spawnBase(enemyId, 40, 0);
    const bot = makePlayer(botId, { x: 0, y: 0, angle: 0 });
    const enemy = makePlayer(enemyId, {
      x: 20,
      y: 0,
      angle: 0,
      isBot: false,
      inTerritory: false,
    });
    const players = new Map<string, PlayerState>([
      [botId, bot],
      [enemyId, enemy],
    ]);
    const trails = new Map<string, TrailPoint[]>([
      [botId, []],
      [
        enemyId,
        [new TrailPoint(35, 0), new TrailPoint(4, 0), new TrailPoint(20, 0)],
      ],
    ]);
    const controller = new BotController(botId, 0, 0);

    runUntilBehavior(
      controller,
      BotBehavior.INTERCEPT,
      bot,
      players,
      grid,
      trails,
      200
    );
    expect(controller.getDebugState().behavior).toBe(BotBehavior.INTERCEPT);

    for (let update = 0; update < 5; update++) {
      controller.update(bot, players, grid, DECISION_DT, trails);
      expect(controller.getDebugState().behavior).toBe(BotBehavior.INTERCEPT);
    }
  });

  it("notices a nearby exposed trail even when its owner is farther away", () => {
    const botId = "trail-aware-bot";
    const enemyId = "remote-enemy";
    const grid = new TerritoryGrid();
    grid.spawnBase(botId, 0, 0);
    grid.spawnBase(enemyId, 70, 0);
    const bot = makePlayer(botId, { x: 0, y: 0, angle: 0 });
    const enemy = makePlayer(enemyId, {
      x: 50,
      y: 0,
      angle: 0,
      isBot: false,
      inTerritory: false,
    });
    const players = new Map<string, PlayerState>([
      [botId, bot],
      [enemyId, enemy],
    ]);
    const trails = new Map<string, TrailPoint[]>([
      [botId, []],
      [
        enemyId,
        [new TrailPoint(65, 0), new TrailPoint(4, 0), new TrailPoint(50, 0)],
      ],
    ]);
    const controller = new BotController(botId, 0, 0);

    const decision = runUntilBehavior(
      controller,
      BotBehavior.INTERCEPT,
      bot,
      players,
      grid,
      trails,
      200
    );

    expect(controller.getDebugState().behavior).toBe(BotBehavior.INTERCEPT);
    expect(Math.abs(angleDiff(decision.targetAngle, 0))).toBeLessThan(0.05);
  });

  it.each([
    ["east coast", 0],
    ["north-east coast", Math.PI / 4],
    ["north coast", Math.PI / 2],
    ["north-west coast", (3 * Math.PI) / 4],
    ["west coast", Math.PI],
    ["south-west coast", (-3 * Math.PI) / 4],
    ["south coast", -Math.PI / 2],
    ["south-east coast", -Math.PI / 4],
    ["irregular north-east coast", 0.37],
    ["irregular south-west coast", -2.18],
  ])(
    "chooses a safe inward route near the %s",
    (_label, outwardAngle) => {
      const id = `edge-bot-${outwardAngle}`;
      const startClearance = 5.2;
      const startRadius = arenaRadiusAtAngle(outwardAngle) - startClearance;
      const player = makePlayer(id, {
        x: Math.cos(outwardAngle) * startRadius,
        y: Math.sin(outwardAngle) * startRadius,
        angle: outwardAngle,
        inTerritory: false,
      });
      const players = new Map([[id, player]]);
      const grid = new TerritoryGrid();
      const trails = new Map<string, TrailPoint[]>([[id, []]]);
      const controller = new BotController(id, player.x, player.y);

      const decision = controller.update(
        player,
        players,
        grid,
        DECISION_DT,
        trails
      );
      expect(controller.getDebugState().behavior).toBe(BotBehavior.EVADE);
      expect(Number.isFinite(decision.targetAngle)).toBe(true);

      let x = player.x;
      let y = player.y;
      let angle = player.angle;
      for (let step = 0; step < 10; step++) {
        angle = stepAngle(
          angle,
          decision.targetAngle,
          PLAYER_TURN_SPEED * DECISION_DT
        );
        x += Math.cos(angle) * PLAYER_SPEED * DECISION_DT;
        y += Math.sin(angle) * PLAYER_SPEED * DECISION_DT;
        const edgeClearance = arenaBoundaryClearance(x, y);
        expect(edgeClearance).toBeGreaterThan(PLAYER_RADIUS + 0.5);
      }
    }
  );
});
