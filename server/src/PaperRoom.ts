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
  TERRITORY_SCORE_PER_CELL,
} from "./constants.js";
import {
  constrainPointToArena,
  randomPointInsideArena,
} from "./arenaShape.js";
import {
  ClockPingMessage,
  ClockPongMessage,
  encodeGridRle,
  FullGridSyncMessage,
  GameOverMessage,
  InputMessage,
  PickupCollectedMessage,
  PlayerKilledMessage,
  TerritoryCapturedMessage,
  VictoryReason,
} from "./protocol.js";
import { BotController } from "./bot.js";
import {
  circleIntersectsSegment,
  clamp,
  distance,
  distToSegmentSq,
  normalizeAngle,
} from "./geometry.js";
import { advanceTurningPose } from "./movement.js";
import { GameState, PickupState, PlayerState, TrailPoint } from "./schema.js";
import { TerritoryGrid } from "./territory.js";

interface PlayerInput {
  targetAngle: number;
  boost: boolean;
  seq: number;
  dt: number;
  clientTime: number;
}

const ENTRY_LOCK_TERRITORY_PERCENT = 50;
const ENTRY_LOCK_CLOSE_CODE = 4403;

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
    this.state.serverTime = Date.now();
    this.setPatchRate(1000 / 30); // Match the 30Hz authoritative simulation
    this.setSimulationInterval((dt) => this.update(dt), 1000 / 30); // 30Hz simulation

    // Register input handler
    this.onMessage("input", (client, message: Partial<InputMessage>) => {
      const input = this.playerInputs.get(client.sessionId);
      if (!input) return;

      const nextSeq = Number(message.seq);
      if (Number.isSafeInteger(nextSeq)) {
        if (nextSeq <= input.seq || nextSeq < 0 || nextSeq > 0xffff_ffff) return;
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

    this.onMessage("clock_ping", (client, message: Partial<ClockPingMessage>) => {
      const clientTime = Number(message.clientTime);
      if (!Number.isFinite(clientTime)) return;
      client.send("clock_pong", {
        clientTime,
        serverTime: Date.now(),
        serverTick: this.state.serverTick,
      } as ClockPongMessage);
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
    if (this.isGameOver || this.checkLateGame()) {
      void client.leave(
        ENTRY_LOCK_CLOSE_CODE,
        this.isGameOver
          ? "The match is already complete"
          : "A player controls more than 50% of the map"
      );
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

    // One broadcast includes the joining client and updates existing clients
    // with the new spawn bases without sending the same 65 KiB grid twice.
    this.broadcastGridNow();
    client.send("trail_sync", this.buildFullTrailSync());
  }

  onLeave(client: Client, code?: number) {
    const player = this.state.players.get(client.sessionId);
    if (player) {
      this.grid.unregisterPlayer(client.sessionId);
      this.state.players.delete(client.sessionId);
      this.playerTrails.delete(client.sessionId);
      this.syncGridToAll();
    }
    this.playerInputs.delete(client.sessionId);
    if (player) this.checkGameOver();
  }

  private syncGridToAll() {
    this.gridSyncPending = true;
  }

  private broadcastGridNow() {
    this.lastGridSyncTime = Date.now();
    this.gridSyncPending = false;
    const rawGrid = this.grid.getRawCells();
    const rleGrid = encodeGridRle(rawGrid);
    // RLE entries are ordinary msgpack numbers, so require a clear element
    // count win before choosing them over the byte array.
    const useRle = rleGrid.length * 2 < rawGrid.length;
    this.broadcast("full_grid_sync", {
      grid: useRle ? rleGrid : rawGrid,
      width: this.grid.width,
      height: this.grid.height,
      encoding: useRle ? "rle" : "raw",
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

  private packTrail(trail: TrailPoint[]): number[] {
    const flat: number[] = [];
    for (let index = 0; index < trail.length; index++) {
      const point = trail[index];
      flat.push(
        Math.round(point.x * 10) / 10,
        Math.round(point.y * 10) / 10
      );
    }
    return flat;
  }

  private buildFullTrailSync(): Record<string, number[]> {
    const message: Record<string, number[]> = {};
    this.playerTrails.forEach((trail, playerId) => {
      if (trail.length === 0) return;
      message[playerId] = this.packTrail(trail);
    });
    return message;
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
    player.vx = 0;
    player.vy = 0;
    player.lastProcessedInputSeq = 0;
    player.lifeId = (player.lifeId % 0xffff) + 1;
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

    this.noteContestedMatch();
    this.syncGridToAll();
    return player;
  }

  private noteContestedMatch() {
    if (this.matchWasContested) return;
    let alivePlayers = 0;
    for (const player of this.state.players.values()) {
      if (!player.alive) continue;
      alivePlayers++;
      if (alivePlayers >= 2) {
        this.matchWasContested = true;
        return;
      }
    }
  }

  private spawnBot() {
    if (this.isGameOver || this.checkLateGame()) return;
    const botId = `bot_${this.nextBotId++}`;
    const botName =
      BOT_NAMES[(this.nextBotId + Math.floor(Math.random() * 5)) % BOT_NAMES.length];

    const botPlayer = this.spawnPlayer(botId, botName, true);
    const controller = new BotController(botId, botPlayer.x, botPlayer.y);
    this.bots.set(botId, controller);
    this.botRespawnAt.delete(botId);
  }

  private isGameOver = false;
  private matchWasContested = false;

  private update(deltaTime: number) {
    if (this.isGameOver || this.clients.length === 0) return;
    this.tickCount++;
    try {
      this.updateInner(deltaTime);
      this.state.serverTick = this.tickCount;
      this.state.serverTime = Date.now();
    } catch (err) {
      console.error(`[PaperRoom] update() threw at tick ${this.tickCount}:`, err);
      if (err instanceof Error) console.error(err.stack);
    }
    // Tick logs are opt-in because container stdout backpressure can stall the
    // authoritative simulation and surface as movement hitches for everyone.
    if (
      process.env.DEBUG_GAME_TICKS === "1" &&
      (this.tickCount <= 3 || this.tickCount % 30 === 0)
    ) {
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
        if (this.isLateGame) {
          // A lock permanently retires dead Bots for the rest of this match,
          // including any respawn that was scheduled before the lock.
          this.botRespawnAt.delete(botId);
          return;
        }

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
      if (!player) continue;
      if (!player.alive) {
        player.vx = 0;
        player.vy = 0;
        continue;
      }

      const input = this.playerInputs.get(player.id);
      const targetAngle = input ? input.targetAngle : player.targetAngle;
      const previousX = player.x;
      const previousY = player.y;

      // Speed calculation (boost from pickup)
      const isBoosted = Date.now() < player.boostUntil;
      const moveSpeed = isBoosted ? PLAYER_BOOST_SPEED : PLAYER_SPEED;
      player.speed = moveSpeed;

      // Exact circular-arc integration gives the same path regardless of
      // client render FPS and avoids recurring prediction corrections.
      advanceTurningPose(
        player,
        targetAngle,
        moveSpeed,
        PLAYER_TURN_SPEED,
        dt
      );

      // Boundary check: keep the entire character on the same smooth island
      // contour used by the world mesh and minimap.
      const constrained = constrainPointToArena(
        player.x,
        player.y,
        PLAYER_RADIUS
      );
      player.x = constrained.x;
      player.y = constrained.y;
      if (dt > 0) {
        player.vx = (player.x - previousX) / dt;
        player.vy = (player.y - previousY) / dt;
      } else {
        player.vx = 0;
        player.vy = 0;
      }
      if (input) {
        player.lastProcessedInputSeq = input.seq;
      }

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

    // 7. Broadcast a complete packed snapshot (~3Hz). This keeps the wire
    // format compatible across rolling frontend/backend updates while avoiding
    // per-point object allocation in mobile WebViews.
    if (this.tickCount % 10 === 0) {
      this.broadcast("trail_sync", this.buildFullTrailSync());
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
        if (killer.id === victim.id) continue;

        const victimTrail = this.playerTrails.get(victim.id) || [];
        if (!victim.alive || victimTrail.length < 2) continue;

        // A player's head can cut another player's trail. Their own trail is
        // intentionally harmless and is skipped above.
        for (let s = 0; s < victimTrail.length - 1; s++) {
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
            this.eliminatePlayer(victim.id, killer.id, false);
            break;
          }
        }
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
      this.eliminatePlayer(trappedId, player.id, false, false, false);
    }

    // Recalculate territory percent for all players
    this.state.players.forEach((p) => {
      if (p.alive && p.id !== player.id) {
        p.territoryCells = this.grid.countTerritoryCells(p.id);
        p.territoryPercent = this.grid.getTerritoryPercent(p.id);
        if (p.territoryCells === 0) {
          this.eliminatePlayer(p.id, player.id, false, false, false);
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

  private eliminatePlayer(
    victimId: string,
    killerId: string,
    isSuicide: boolean,
    broadcastGrid: boolean = true,
    checkMatchState: boolean = true
  ) {
    const victim = this.state.players.get(victimId);
    if (!victim || !victim.alive) return;

    victim.alive = false;
    victim.vx = 0;
    victim.vy = 0;
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

    // Enclosure capture may eliminate several players synchronously. Its
    // caller sends one final authoritative grid after all transfers finish.
    if (broadcastGrid) this.broadcastGridNow();

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

    if (checkMatchState) {
      this.checkGameOver();
      this.checkLateGame();
    }
  }

  private isLateGame = false;

  private checkLateGame(): boolean {
    if (this.isGameOver) return true;
    if (this.isLateGame) return true;

    let dominantPlayer: PlayerState | undefined;
    let dominantTerritoryCells = 0;
    for (const player of this.state.players.values()) {
      if (!player.alive) continue;
      const territoryCells = this.grid.countTerritoryCells(player.id);
      if (
        territoryCells * 100 >
        this.grid.playableCellCount * ENTRY_LOCK_TERRITORY_PERCENT
      ) {
        dominantPlayer = player;
        dominantTerritoryCells = territoryCells;
        break;
      }
    }

    if (!dominantPlayer) return false;

    this.isLateGame = true;
    // Make joinOrCreate route subsequent players elsewhere. The synchronous
    // latch above remains the admission fallback for already-reserved seats.
    void this.lock().catch((error: unknown) => {
      console.error("[PaperRoom] Failed to persist late-game room lock:", error);
    });
    const territoryPercent =
      (dominantTerritoryCells / this.grid.playableCellCount) * 100;
    console.log(
      `[PaperRoom] Late game triggered! ${dominantPlayer.name} owns ${territoryPercent.toFixed(1)}%. Room locked against new players and Bots.`
    );
    return true;
  }

  private checkGameOver() {
    if (this.isGameOver) return;
    const alivePlayers = [...this.state.players.values()].filter(
      (player) => player.alive
    );
    let winner: PlayerState | undefined;
    let victoryReason: VictoryReason | undefined;

    // Exact map occupation remains the highest-priority victory condition.
    for (const p of alivePlayers) {
      if (!this.grid.tryFinalizeMapOccupation(p.id)) continue;
      winner = p;
      victoryReason = "map_occupied";
      break;
    }

    // A match that was genuinely contested also ends when only one living
    // participant remains. Dead players awaiting respawn are no longer on the
    // map; zero survivors is a draw-in-progress rather than a victory.
    if (!winner && this.matchWasContested && alivePlayers.length === 1) {
      winner = alivePlayers[0];
      victoryReason = "last_survivor";
    }

    if (!winner || !victoryReason) return;

    this.isGameOver = true;
    this.state.players.forEach((player) => {
      player.territoryCells = this.grid.countTerritoryCells(player.id);
      player.territoryPercent = this.grid.getTerritoryPercent(player.id);
    });
    this.state.gameOver = true;
    this.state.winnerId = winner.id;
    this.state.winnerName = winner.name;
    this.state.winnerColor = winner.color;
    this.state.winnerPercent = winner.territoryPercent;
    this.state.winnerKills = winner.kills;
    this.state.winnerReason = victoryReason;

    // Last-survivor wins can happen below the late-game territory threshold,
    // so lock the completed room while retaining the synchronous onJoin guard.
    if (!this.isLateGame) {
      void this.lock().catch((error: unknown) => {
        console.error("[PaperRoom] Failed to persist completed room lock:", error);
      });
    }

    // Publish the final authoritative grid before clients receive the result.
    // Map occupation may have just awarded the unreachable neutral coastline;
    // last-survivor victory intentionally preserves the actual territory map.
    this.broadcastGridNow();

    console.log(
      `[PaperRoom] GAME OVER! Winner: ${winner.name} (${winner.territoryPercent.toFixed(2)}%, ${victoryReason})`
    );
    this.broadcast("game_over", {
      winnerId: winner.id,
      winnerName: winner.name,
      winnerColor: winner.color,
      winnerPercent: winner.territoryPercent,
      winnerKills: winner.kills,
      victoryReason,
    } as GameOverMessage);
  }

  private resetMatch() {
    this.isGameOver = false;
    this.isLateGame = false;
    this.matchWasContested = false;
    this.state.gameOver = false;
    this.state.winnerId = "";
    this.state.winnerName = "";
    this.state.winnerColor = "";
    this.state.winnerPercent = 0;
    this.state.winnerKills = 0;
    this.state.winnerReason = "";
    void this.unlock().catch((error: unknown) => {
      console.error("[PaperRoom] Failed to unlock reset room:", error);
    });
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
