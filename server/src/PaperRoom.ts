import { Client, Room } from "@colyseus/core";
import {
  BOT_NAMES,
  CELL_SIZE,
  CHARACTER_SKINS,
  COLOR_PALETTE,
  INITIAL_BASE_RADIUS_CELLS,
  MAX_BUBBLES,
  MAX_COINS,
  PLAYER_BOOST_SPEED,
  PLAYER_RADIUS,
  PLAYER_SPEED,
  PLAYER_TURN_SPEED,
  TRAIL_MIN_SEGMENT_DIST,
  TRAIL_RADIUS,
  TRAIL_SELF_HIT_SAFE_SEGMENTS,
  TERRITORY_SCORE_PER_CELL,
} from "./constants.js";
import {
  constrainPointToArena,
  randomPointInsideArena,
} from "./arenaShape.js";
import {
  FullGridSyncMessage,
  GameOverMessage,
  InputMessage,
  PickupCollectedMessage,
  PlayerKilledMessage,
  TerritoryCapturedMessage,
} from "./protocol.js";
import { BotController } from "./bot.js";
import {
  circleIntersectsSegment,
  clamp,
  distance,
  distToSegmentSq,
  normalizeAngle,
  stepAngle,
} from "./geometry.js";
import { GameState, PickupState, PlayerState, TrailPoint } from "./schema.js";
import { TerritoryGrid } from "./territory.js";

interface PlayerInput {
  targetAngle: number;
  boost: boolean;
  seq: number;
  dt: number;
  clientTime: number;
}

export class PaperRoom extends Room<{ state: GameState }> {
  maxClients = Math.max(1, Number(process.env.MAX_PLAYERS_PER_ROOM || 8));

  private grid = new TerritoryGrid();
  private playerInputs = new Map<string, PlayerInput>();
  private playerTrails = new Map<string, TrailPoint[]>();
  private bots = new Map<string, BotController>();
  private botRespawnAt = new Map<string, number>();
  private nextBotId = 1;
  private targetBotCount = 4;
  private pickupCounter = 1;
  private lastGridSyncTime = 0;
  private gridSyncPending = false;
  private tickCount = 0;

  onCreate(options: { practice?: boolean } = {}) {
    this.setState(new GameState());
    this.setPatchRate(1000 / 15); // 15Hz patching
    this.setSimulationInterval((dt) => this.update(dt), 1000 / 30); // 30Hz simulation

    // Register input handler
    this.onMessage("input", (client, message: Partial<InputMessage>) => {
      const input = this.playerInputs.get(client.sessionId);
      if (!input) return;

      const nextSeq = Number(message.seq);
      if (Number.isSafeInteger(nextSeq)) {
        if (nextSeq <= input.seq) return;
        input.seq = nextSeq;
      } else {
        input.seq++;
      }

      if (Number.isFinite(message.targetAngle)) {
        input.targetAngle = normalizeAngle(Number(message.targetAngle));
      }
      input.boost = Boolean(message.boost);
      input.dt = clamp(Number(message.dt) || 0, 0, 100);
      const clientTime = Number(message.clientTime);
      input.clientTime = Number.isFinite(clientTime) ? clientTime : Date.now();

      const player = this.state.players.get(client.sessionId);
      if (player) {
        player.targetAngle = input.targetAngle;
      }
    });

    // Handle respawn request
    this.onMessage("respawn", (client) => {
      if (this.isGameOver) {
        this.resetMatch();
        return;
      }
      const player = this.state.players.get(client.sessionId);
      if (player && !player.alive) {
        this.spawnPlayer(client.sessionId, player.name, false);
      }
    });

    // Diagnostic logging
    this.onMessage("diagnostic", (client, message: unknown) => {
      // Diagnostic message from runner/client
    });

    // Fallback wildcard handler so NO unknown message ever triggers CloseCode.WITH_ERROR (4002)
    this.onMessage("*", (client, type: string | number, message: unknown) => {
      // Silently ignore unknown message types
    });

    // Initialize map pickups
    this.initPickups();

  }

  onJoin(client: Client, options: { name?: string }) {
    if (this.isLateGame) {
      client.leave(4003, "Game in late stage (>50% occupied)");
      return;
    }

    const rawName = typeof options.name === "string" ? options.name.trim() : "";
    const name = rawName.slice(0, 14) || `Player_${client.sessionId.slice(-4)}`;

    this.spawnPlayer(client.sessionId, name, false);

    // Rooms are created by a real join. Delay Bot creation until that player is
    // present so empty Rooms can auto-dispose without running AI forever.
    if (this.bots.size === 0) {
      for (let i = 0; i < this.targetBotCount; i++) this.spawnBot();
    }

    // Send initial full grid sync
    client.send("full_grid_sync", {
      grid: this.grid.getRawCells(),
      width: this.grid.width,
      height: this.grid.height,
    } as FullGridSyncMessage);
  }

  onLeave(client: Client, code?: number) {
    const player = this.state.players.get(client.sessionId);
    if (player) {
      this.grid.clearPlayerTerritory(client.sessionId);
      this.grid.unregisterPlayer(client.sessionId);
      this.state.players.delete(client.sessionId);
      this.playerTrails.delete(client.sessionId);
      this.syncGridToAll();
    }
    this.playerInputs.delete(client.sessionId);
  }

  private syncGridToAll() {
    this.gridSyncPending = true;
  }

  private broadcastGridNow() {
    this.lastGridSyncTime = Date.now();
    this.gridSyncPending = false;
    this.broadcast("full_grid_sync", {
      grid: this.grid.getRawCells(),
      width: this.grid.width,
      height: this.grid.height,
    } as FullGridSyncMessage);
  }

  private flushGridSync() {
    if (!this.gridSyncPending) return;
    const now = Date.now();
    if (now - this.lastGridSyncTime < 1000) return;
    this.broadcastGridNow();
  }

  private initPickups() {
    for (let i = 0; i < MAX_BUBBLES; i++) {
      const p = new PickupState();
      p.id = `bubble_${this.pickupCounter++}`;
      p.kind = "bubble";
      const position = randomPointInsideArena(12);
      p.x = position.x;
      p.y = position.y;
      p.active = true;
      this.state.pickups.push(p);
    }

    for (let i = 0; i < MAX_COINS; i++) {
      const p = new PickupState();
      p.id = `coin_${this.pickupCounter++}`;
      p.kind = "coin";
      const position = randomPointInsideArena(10);
      p.x = position.x;
      p.y = position.y;
      p.active = true;
      this.state.pickups.push(p);
    }
  }

  private pickColor(): string {
    const usedColors = new Set<string>();
    this.state.players.forEach((p) => {
      if (p.alive) usedColors.add(p.color);
    });

    const unused = COLOR_PALETTE.filter((c) => !usedColors.has(c));
    if (unused.length > 0) {
      return unused[Math.floor(Math.random() * unused.length)];
    }
    return COLOR_PALETTE[Math.floor(Math.random() * COLOR_PALETTE.length)];
  }

  private spawnPlayer(
    id: string,
    name: string,
    isBot: boolean
  ): PlayerState {
    let player = this.state.players.get(id);
    if (!player) {
      player = new PlayerState();
      player.id = id;
      this.state.players.set(id, player);
    }

    // Pick spawn location away from active players if possible
    let spawnX = 0;
    let spawnY = 0;
    let bestDist = -1;
    const spawnInset =
      INITIAL_BASE_RADIUS_CELLS * CELL_SIZE + PLAYER_RADIUS + CELL_SIZE;

    for (let attempt = 0; attempt < 15; attempt++) {
      const candidate = randomPointInsideArena(spawnInset);
      const candX = candidate.x;
      const candY = candidate.y;
      let minDist = 9999;
      this.state.players.forEach((other) => {
        if (other.id !== id && other.alive) {
          const d = distance(candX, candY, other.x, other.y);
          if (d < minDist) minDist = d;
        }
      });
      if (minDist > bestDist) {
        bestDist = minDist;
        spawnX = candX;
        spawnY = candY;
      }
    }

    player.name = name;
    player.color = this.pickColor();
    player.characterSkin =
      CHARACTER_SKINS[Math.floor(Math.random() * CHARACTER_SKINS.length)];
    player.x = spawnX;
    player.y = spawnY;
    player.spawnX = spawnX;
    player.spawnY = spawnY;
    player.angle = Math.random() * Math.PI * 2 - Math.PI;
    player.targetAngle = player.angle;
    player.speed = PLAYER_SPEED;
    player.alive = true;
    player.isBot = isBot;
    player.inTerritory = true;
    player.boostUntil = 0;
    this.playerTrails.set(id, []);

    // Clear any previous territory & spawn fresh circular base
    this.grid.clearPlayerTerritory(id);
    const baseCount = this.grid.spawnBase(id, spawnX, spawnY);
    player.playerIndex = this.grid.getPlayerIndex(id);
    player.color = COLOR_PALETTE[(player.playerIndex - 1) % COLOR_PALETTE.length];
    player.territoryCells = baseCount;
    player.territoryPercent = this.grid.getTerritoryPercent(id);

    this.playerInputs.set(id, {
      targetAngle: player.angle,
      boost: false,
      seq: 0,
      dt: 0,
      clientTime: Date.now(),
    });


    this.syncGridToAll();
    return player;
  }

  private spawnBot() {
    if (this.isLateGame) return; // Do not enter new characters in late game
    const botId = `bot_${this.nextBotId++}`;
    const botName =
      BOT_NAMES[(this.nextBotId + Math.floor(Math.random() * 5)) % BOT_NAMES.length];

    const botPlayer = this.spawnPlayer(botId, botName, true);
    const controller = new BotController(botId, botPlayer.x, botPlayer.y);
    this.bots.set(botId, controller);
    this.botRespawnAt.delete(botId);
  }

  private isGameOver = false;

  private update(deltaTime: number) {
    if (this.isGameOver || this.clients.length === 0) return;
    this.tickCount++;
    try {
      this.updateInner(deltaTime);
    } catch (err) {
      console.error(`[PaperRoom] update() threw at tick ${this.tickCount}:`, err);
      if (err instanceof Error) console.error(err.stack);
    }
    // Log every ~1 second
    if (this.tickCount <= 3 || this.tickCount % 30 === 0) {
      let trailTotal = 0;
      this.playerTrails.forEach((t) => { trailTotal += t.length; });
      console.log(`[PaperRoom] tick=${this.tickCount} dt=${deltaTime.toFixed(0)}ms players=${this.state.players.size} trails=${trailTotal}`);
    }
  }

  private updateInner(deltaTime: number) {
    const dt = Math.min(deltaTime / 1000, 0.1);


    // 1. Update Bots AI
    const playersMap = new Map<string, PlayerState>();
    this.state.players.forEach((p, id) => playersMap.set(id, p));

    this.bots.forEach((botCtrl, botId) => {
      const botPlayer = this.state.players.get(botId);
      if (!botPlayer) return;

      if (!botPlayer.alive) {
        const now = Date.now();
        let respawnAt = this.botRespawnAt.get(botId);
        if (!respawnAt) {
          respawnAt = now + 1800;
          this.botRespawnAt.set(botId, respawnAt);
        }
        if (now < respawnAt) return;

        this.spawnPlayer(botId, botPlayer.name, true);
        botCtrl.reset(botPlayer.x, botPlayer.y, botPlayer.angle);
        this.botRespawnAt.delete(botId);
        return;
      }

      const decision = botCtrl.update(botPlayer, playersMap, this.grid, dt, this.playerTrails);
      botPlayer.targetAngle = decision.targetAngle;
      const input = this.playerInputs.get(botId);
      if (input) {
        input.targetAngle = decision.targetAngle;
        input.boost = decision.boost;
      }
    });

    // 2. Update all living players movement & trails
    const playerIds: string[] = [];
    this.state.players.forEach((_p, id) => playerIds.push(id));

    for (const playerId of playerIds) {
      const player = this.state.players.get(playerId);
      if (!player || !player.alive) continue;

      const input = this.playerInputs.get(player.id);
      const targetAngle = input ? input.targetAngle : player.targetAngle;

      // Turn towards target angle with max angular speed
      player.angle = stepAngle(player.angle, targetAngle, PLAYER_TURN_SPEED * dt);

      // Speed calculation (boost from pickup)
      const isBoosted = Date.now() < player.boostUntil;
      const moveSpeed = isBoosted ? PLAYER_BOOST_SPEED : PLAYER_SPEED;
      player.speed = moveSpeed;

      // Move player forward in current heading angle
      player.x += Math.cos(player.angle) * moveSpeed * dt;
      player.y += Math.sin(player.angle) * moveSpeed * dt;

      // Boundary check: keep the entire character on the same smooth island
      // contour used by the world mesh and minimap.
      const constrained = constrainPointToArena(
        player.x,
        player.y,
        PLAYER_RADIUS
      );
      player.x = constrained.x;
      player.y = constrained.y;

      // Check Territory status
      const inOwnLand = this.grid.isOwnTerritory(player.id, player.x, player.y);

      if (inOwnLand) {
        const trail = this.playerTrails.get(player.id) || [];
        if (!player.inTerritory && trail.length > 0) {
          // Player returned to own territory -> Capture enclosure!
          this.captureTerritory(player);
        }
        player.inTerritory = true;
      } else {
        // Outside own territory: lay down trail
        player.inTerritory = false;

        const trail = this.playerTrails.get(player.id) || [];
        let shouldAddPoint = false;

        if (trail.length === 0) {
          shouldAddPoint = true;
        } else {
          const lastPoint = trail[trail.length - 1];
          const distFromLast = distance(player.x, player.y, lastPoint.x, lastPoint.y);
          if (distFromLast >= TRAIL_MIN_SEGMENT_DIST) {
            shouldAddPoint = true;
          }
        }

        if (shouldAddPoint) {
          trail.push(new TrailPoint(player.x, player.y));
          this.playerTrails.set(player.id, trail);
        }
      }
    }

    // 3. Collision Detection: Cutting enemy trails
    this.checkTrailCollisions();

    // 4. Pickup checks: Bubbles and Coins
    this.checkPickups();

    // 5. Update Leaderboard & Crown
    this.updateLeaderboard();

    // 6. Ensure bot count is maintained
    let botCount = 0;
    this.state.players.forEach((p) => {
      if (p.isBot) botCount++;
    });
    if (this.clients.length > 0 && botCount < this.targetBotCount) {
      this.spawnBot();
    }

    // 7. Broadcast trail data as raw message (~3Hz)
    if (this.tickCount % 10 === 0) {
      const trailData: Record<string, number[]> = {};
      this.playerTrails.forEach((trail, playerId) => {
        if (trail.length > 0) {
          // Pack as flat array: [x1, y1, x2, y2, ...] with 1 decimal precision
          const flat: number[] = [];
          for (const p of trail) {
            flat.push(Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10);
          }
          trailData[playerId] = flat;
        }
      });
      this.broadcast("trail_sync", trailData);
    }

    // 8. Flush throttled grid sync
    this.flushGridSync();
  }

  private checkTrailCollisions() {
    const players: PlayerState[] = [];
    this.state.players.forEach((p) => {
      if (p.alive) players.push(p);
    });

    for (let i = 0; i < players.length; i++) {
      const killer = players[i];
      if (!killer.alive) continue;

      for (let j = 0; j < players.length; j++) {
        const victim = players[j];
        const victimTrail = this.playerTrails.get(victim.id) || [];
        if (!victim.alive || victimTrail.length < 2) continue;

        const isSelfCollision = killer.id === victim.id;
        const segmentLimit = isSelfCollision
          ? victimTrail.length - TRAIL_SELF_HIT_SAFE_SEGMENTS - 1
          : victimTrail.length - 1;
        if (segmentLimit <= 0) continue;

        // Enemy trails are lethal to their owner when cut. Crossing an old
        // portion of one's own trail is a suicide; recent head segments are
        // excluded so a freshly emitted trail cannot kill its owner.
        for (let s = 0; s < segmentLimit; s++) {
          const p1 = victimTrail[s];
          const p2 = victimTrail[s + 1];
          if (
            circleIntersectsSegment(
              killer.x,
              killer.y,
              PLAYER_RADIUS + TRAIL_RADIUS,
              p1.x,
              p1.y,
              p2.x,
              p2.y
            )
          ) {
            this.eliminatePlayer(
              victim.id,
              killer.id,
              isSelfCollision
            );
            break;
          }
        }

        if (!killer.alive) break;
      }
    }
  }

  private checkPickups() {
    this.state.pickups.forEach((pickup) => {
      if (!pickup.active) return;

      this.state.players.forEach((player) => {
        if (!player.alive) return;

        const d = distance(player.x, player.y, pickup.x, pickup.y);
        const radius = pickup.kind === "bubble" ? 2.5 : 1.8;

        if (d < radius + PLAYER_RADIUS) {
          pickup.active = false;

          if (pickup.kind === "bubble") {
            // Speed boost for 4 seconds
            player.boostUntil = Date.now() + 4000;
            player.score += 50;
          } else {
            // Coin
            player.score += 20;
          }

          this.broadcast("pickup_collected", {
            playerId: player.id,
            pickupId: pickup.id,
            kind: pickup.kind as "bubble" | "coin",
            x: pickup.x,
            y: pickup.y,
          } as PickupCollectedMessage);

          // Respawn pickup after delay
          this.clock.setTimeout(() => {
            const position = randomPointInsideArena(12);
            pickup.x = position.x;
            pickup.y = position.y;
            pickup.active = true;
          }, 8000);
        }
      });
    });
  }

  private captureTerritory(player: PlayerState) {
    const trail = this.playerTrails.get(player.id) || [];
    const trailPoints: Array<{ x: number; y: number }> = [];
    trail.forEach((pt) => trailPoints.push({ x: pt.x, y: pt.y }));
    // Add current position to close the loop
    trailPoints.push({ x: player.x, y: player.y });

    const otherPositions = new Map<string, { x: number; y: number }>();
    this.state.players.forEach((other, id) => {
      if (id !== player.id && other.alive) {
        otherPositions.set(id, { x: other.x, y: other.y });
      }
    });

    const result = this.grid.captureEnclosure(player.id, trailPoints, otherPositions);

    this.playerTrails.set(player.id, []);
    player.territoryCells = this.grid.countTerritoryCells(player.id);
    player.territoryPercent = result.newPercent;
    player.score += Math.round(result.capturedCount * TERRITORY_SCORE_PER_CELL);

    // Eliminate any players trapped inside
    for (const trappedId of result.trappedPlayerIds) {
      this.eliminatePlayer(trappedId, player.id, false);
    }

    // Recalculate territory percent for all players
    this.state.players.forEach((p) => {
      if (p.alive && p.id !== player.id) {
        p.territoryCells = this.grid.countTerritoryCells(p.id);
        p.territoryPercent = this.grid.getTerritoryPercent(p.id);
        if (p.territoryCells === 0) {
          this.eliminatePlayer(p.id, player.id, false);
        }
      }
    });


    // Instant grid broadcast so newly captured territory appears in 1 frame
    this.broadcastGridNow();

    // Broadcast capture event for client VFX / floating score.
    this.broadcast("territory_captured", {
      playerId: player.id,
      cellsCount: result.capturedCount,
      territoryPercent: result.newPercent,
      centerX: result.centerX,
      centerY: result.centerY,
    } as TerritoryCapturedMessage);

    // Check if map is 100% full or occupied
    this.checkGameOver();
    this.checkLateGame();
  }

  private eliminatePlayer(victimId: string, killerId: string, isSuicide: boolean) {
    const victim = this.state.players.get(victimId);
    if (!victim || !victim.alive) return;

    victim.alive = false;
    this.playerTrails.set(victimId, []);

    let absorbedCount = 0;
    let absorbedPercent = 0;
    const killer = killerId ? this.state.players.get(killerId) : null;
    const killerName = killer ? killer.name : "";

    if (killer && killer.id !== victimId) {
      // CONQUER: Transfer victim's territory to the killer!
      absorbedCount = this.grid.transferPlayerTerritory(victimId, killer.id);
      killer.territoryCells = this.grid.countTerritoryCells(killer.id);
      killer.territoryPercent = this.grid.getTerritoryPercent(killer.id);
      absorbedPercent = Number(
        ((absorbedCount / this.grid.playableCellCount) * 100).toFixed(2)
      );
      killer.kills++;
      killer.score += 250 + Math.round(absorbedCount * TERRITORY_SCORE_PER_CELL);
    } else {
      // Dissolve to neutral if no killer
      this.grid.clearPlayerTerritory(victimId);
    }

    victim.territoryCells = 0;
    victim.territoryPercent = 0;

    // Send updated grid to all clients immediately!
    this.broadcastGridNow();

    this.broadcast("player_killed", {
      killerId,
      victimId,
      killerName,
      victimName: victim.name,
      isSuicide,
      x: victim.x,
      y: victim.y,
      absorbedCells: absorbedCount,
      absorbedPercent,
    } as PlayerKilledMessage);

    // Check if game is over
    this.checkGameOver();
    this.checkLateGame();
  }

  private isLateGame = false;

  private checkLateGame() {
    if (this.isLateGame) return;
    const neutralCells = this.grid.countNeutralCells();
    const claimedPercent =
      ((this.grid.playableCellCount - neutralCells) /
        this.grid.playableCellCount) *
      100;
    if (claimedPercent >= 50) {
      this.isLateGame = true;
      this.lock(); // Lock room so Colyseus matchmaker routes new players elsewhere
      console.log(`[PaperRoom] Late game triggered! ${claimedPercent.toFixed(1)}% claimed. Room locked against new players.`);
    }
  }

  private checkGameOver() {
    if (this.isGameOver) return;
    const neutralCells = this.grid.countNeutralCells();
    let maxPercent = 0;
    let winner: PlayerState | undefined;

    for (const [, p] of this.state.players) {
      if (p.alive && p.territoryPercent > maxPercent) {
        maxPercent = p.territoryPercent;
        winner = p;
      }
    }

    // If map is full (<= 30 neutral cells, i.e. 99.8%+ claimed) or single player dominates
    if (neutralCells <= 30 || maxPercent >= 99.9) {
      this.isGameOver = true;
      const winnerId = winner ? winner.id : "";
      const winnerName = winner ? winner.name : "Champion";
      const winnerColor = winner ? winner.color : "#00D2FF";
      const winnerPercent = winner ? winner.territoryPercent : 100;
      const winnerKills = winner ? winner.kills : 0;

      console.log(`[PaperRoom] GAME OVER! Winner: ${winnerName} (${winnerPercent}%)`);
      this.broadcast("game_over", {
        winnerId,
        winnerName,
        winnerColor,
        winnerPercent,
        winnerKills,
      } as GameOverMessage);
    }
  }

  private resetMatch() {
    this.isGameOver = false;
    this.isLateGame = false;
    this.unlock();
    this.botRespawnAt.clear();
    // Clear entire grid
    for (let i = 0; i < this.grid.totalCells; i++) {
      this.grid.cells[i] = 0;
    }
    // Respawn all players fresh
    this.state.players.forEach((p, id) => {
      this.spawnPlayer(id, p.name, p.isBot);
      if (p.isBot) {
        this.bots.get(id)?.reset(p.x, p.y, p.angle);
      }
    });
    this.broadcastGridNow();
  }

  private updateLeaderboard() {
    const activePlayers: PlayerState[] = [];
    this.state.players.forEach((p) => {
      if (p.alive) activePlayers.push(p);
    });

    activePlayers.sort((a, b) => b.territoryPercent - a.territoryPercent);

    for (let i = 0; i < activePlayers.length; i++) {
      activePlayers[i].rank = i + 1;
    }

    if (activePlayers.length > 0) {
      this.state.leaderId = activePlayers[0].id;
    } else {
      this.state.leaderId = "";
    }
  }
}
