import { ArenaRenderer } from "./game/ArenaRenderer.js";
import { CharacterRenderer } from "./game/CharacterRenderer.js";
import { GameClient } from "./game/GameClient.js";
import { InputController } from "./game/InputController.js";
import { MovementSynchronizer } from "./game/MovementSynchronizer.js";
import { ParticleEffects } from "./game/ParticleEffects.js";
import { SceneManager } from "./game/SceneManager.js";
import { TrailRenderer } from "./game/TrailRenderer.js";
import { MiniMap, type MiniMapPlayer } from "./ui/MiniMap.js";
import { type LeaderboardItem, UIManager } from "./ui/UIManager.js";

let sceneManager: SceneManager | null = null;
let arenaRenderer: ArenaRenderer | null = null;
let charRenderer: CharacterRenderer | null = null;
let trailRenderer: TrailRenderer | null = null;
let particleEffects: ParticleEffects | null = null;
let inputController: InputController | null = null;
let uiManager: UIManager | null = null;
let miniMap: MiniMap | null = null;
let client: GameClient | null = null;
let movementSynchronizer: MovementSynchronizer | null = null;
let pendingTerritoryGrid: Uint8Array | number[] | null = null;
let territoryRenderRequest: number | null = null;
let started = false;

function cancelPendingTerritoryRender() {
  if (territoryRenderRequest !== null) {
    cancelAnimationFrame(territoryRenderRequest);
    territoryRenderRequest = null;
  }
  pendingTerritoryGrid = null;
}

function returnToStartScreen() {
  started = false;
  cancelPendingTerritoryRender();
  if (client) {
    client.disconnect();
  }
  if (charRenderer) {
    charRenderer.removeAll();
  }
  if (trailRenderer) {
    trailRenderer.removeAll();
  }
  movementSynchronizer?.reset();
  if (uiManager) {
    uiManager.hideDeathScreen();
    uiManager.hideGameOverScreen();
  }

  document.getElementById("game-screen")?.classList.add("hidden");
  const startScreen = document.getElementById("start-screen");
  if (startScreen) {
    startScreen.classList.remove("hidden");
    const nameInput = document.getElementById("player-name-input") as HTMLInputElement;
    if (nameInput) {
      nameInput.focus();
      nameInput.select();
    }
  }
}

/* -------------------------------------------------------
   START SCREEN LOGIC
   ------------------------------------------------------- */
function setupStartScreen() {
  const startScreen = document.getElementById("start-screen")!;
  const gameScreen = document.getElementById("game-screen")!;
  const nameInput = document.getElementById("player-name-input") as HTMLInputElement;
  const playBtn = document.getElementById("play-btn")!;

  // Pre-fill from localStorage
  const savedName = localStorage.getItem("paper_player_name") || "";
  if (savedName) nameInput.value = savedName;

  const startGame = () => {
    if (started) return;
    started = true;

    let playerName = nameInput.value.trim();
    if (!playerName) {
      playerName = `Player_${Math.floor(Math.random() * 899 + 100)}`;
    }
    localStorage.setItem("paper_player_name", playerName);

    startScreen.classList.add("hidden");
    gameScreen.classList.remove("hidden");

    initGame(playerName).catch((err) => {
      console.error("[main] initGame failed:", err);
      started = false;
      startScreen.classList.remove("hidden");
      gameScreen.classList.add("hidden");
    });
  };

  playBtn.addEventListener("click", startGame);

  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      startGame();
    }
  });
}

/* -------------------------------------------------------
   MAIN GAME INIT (called after PLAY)
   ------------------------------------------------------- */
async function initGame(playerName: string) {
  const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
  if (!canvas) throw new Error("Canvas element not found");

  cancelPendingTerritoryRender();
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

  // 1. Initialize singletons on first run
  if (!sceneManager) {
    sceneManager = new SceneManager(canvas);

    arenaRenderer = new ArenaRenderer(sceneManager.scene);
    charRenderer = new CharacterRenderer(sceneManager.scene);
    trailRenderer = new TrailRenderer(sceneManager.scene);
    particleEffects = new ParticleEffects(sceneManager.scene);
    inputController = new InputController(canvas);

    uiManager = new UIManager();
    const minimapBox = document.getElementById("minimap-box") as HTMLElement;
    miniMap = new MiniMap(minimapBox);

    client = new GameClient();
    movementSynchronizer = new MovementSynchronizer();

    // 2. Main Game & Render Loop (starts once)
    let totalTime = 0;

    sceneManager.startRenderLoop((dt) => {
      totalTime += dt;
      arenaRenderer!.animateWater(totalTime);

      if (!client || !client.room || !client.room.state || !client.room.state.players) {
        return;
      }

      const clientTime = Date.now();
      const frameTime = performance.now();
      movementSynchronizer!.setLocalInput(inputController!.targetAngle);
      movementSynchronizer!.setNetworkTiming(
        client.getServerClockOffsetMs(),
        client.getSmoothedRttMs()
      );
      uiManager!.updateLatency(client.getSmoothedRttMs());
      const sentInput = client.room.state.gameOver
        ? null
        : client.sendInput(
            inputController!.targetAngle,
            inputController!.boost
          );
      if (sentInput) movementSynchronizer!.recordLocalInput(sentInput);

      const playersState = client.room.state.players;
      const leaderId = client.room.state.leaderId;
      const miniMapPlayers: MiniMapPlayer[] = [];

      playersState.forEach((player: any, sessionId: string) => {
        const isLocal = sessionId === client!.localSessionId;
        const isLeader = sessionId === leaderId;
        const renderPose = movementSynchronizer!.getRenderPose(
          sessionId,
          player,
          isLocal,
          clientTime,
          frameTime
        );

        if (player.playerIndex > 0) {
          arenaRenderer!.setPlayerMeta(
            player.playerIndex,
            player.color,
            player.spawnX,
            player.spawnY,
            player.territoryCells,
            player.alive
          );
        }

        charRenderer!.getOrCreate(sessionId, player.name, player.color, player.isBot);
        charRenderer!.updatePlayer(
          sessionId,
          renderPose.x,
          renderPose.y,
          renderPose.angle,
          player.alive,
          isLeader,
          dt
        );

        const trailPoints = client!.trailData[sessionId];
        if (player.alive && trailPoints && trailPoints.length > 0) {
          const renderedPosition = charRenderer!.getRenderedPosition(sessionId);
          trailRenderer!.updateTrail(
            sessionId,
            player.color,
            trailPoints,
            renderedPosition?.x ?? player.x,
            renderedPosition?.z ?? player.y
          );
        } else {
          trailRenderer!.clearTrail(sessionId);
        }

        if (isLocal) {
          sceneManager!.setCameraTarget(renderPose.x, renderPose.y);
          uiManager!.updatePlayerStats(player.territoryPercent, player.kills, player.score);
        }

        miniMapPlayers.push({
          id: sessionId,
          x: renderPose.x,
          y: renderPose.y,
          isLocal,
          color: player.color,
          alive: player.alive,
        });

      });

      miniMap!.renderPlayers(miniMapPlayers);
    });
  } else {
    // Re-use: cleanup previous match
    client!.disconnect();
    charRenderer!.removeAll();
    trailRenderer!.removeAll();
    movementSynchronizer!.reset();
  }

  // Babylon owns the backing-store resolution. Reapplying devicePixelRatio
  // here makes a restarted WebView render DPR^2 more pixels than the first run.
  sceneManager.engine.resize();

  // Helper to ensure player metadata is available for analytic base drawing
  const syncPlayerMeta = () => {
    if (client!.room?.state?.players) {
      client!.room.state.players.forEach((p: any) => {
        if (p.playerIndex > 0) {
          arenaRenderer!.setPlayerMeta(
            p.playerIndex,
            p.color,
            p.spawnX,
            p.spawnY,
            p.territoryCells,
            p.alive
          );
        }
      });
    }
  };

  // A capture/kill can deliver several full-grid messages in one WebSocket
  // burst. Keep only the newest grid and perform at most one expensive canvas
  // rebuild + GPU texture upload in the next animation frame.
  const scheduleTerritoryRender = () => {
    if (territoryRenderRequest !== null) return;

    territoryRenderRequest = requestAnimationFrame(() => {
      territoryRenderRequest = null;
      const grid = pendingTerritoryGrid;
      pendingTerritoryGrid = null;
      if (!grid || !arenaRenderer || !miniMap) return;

      arenaRenderer.updateGrid(grid);
      syncPlayerMeta();
      if (!arenaRenderer.hasPendingTerritoryChanges()) return;
      arenaRenderer.renderTerritory();
      miniMap.updateTerritory(
        arenaRenderer.rawGrid,
        arenaRenderer.playerColorMap
      );
    });
  };

  // Only a true -> false transition in durable state means the server reset
  // the match. Legacy servers send only game_over messages, so an ordinary
  // false patch from them must not dismiss the result page.
  let observedGameOverState = false;

  // 3. Setup Network Event Handlers on client
  client!.onGridSync = (gridArray) => {
    pendingTerritoryGrid = gridArray;
    scheduleTerritoryRender();
  };

  client!.onTerritoryCaptured = (msg) => {
    const capturingPlayer = client!.room?.state.players.get(msg.playerId);
    const color = capturingPlayer?.color || "#00D2FF";
    // The server has already consumed this trail into territory. Remove the
    // cached presentation mesh immediately instead of waiting for the next
    // low-frequency trail_sync message.
    delete client!.trailData[msg.playerId];
    trailRenderer!.clearTrail(msg.playerId);
    particleEffects!.triggerCaptureEffect(msg.centerX, msg.centerY, color, msg.cellsCount);
  };

  client!.onPlayerKilled = (msg) => {
    delete client!.trailData[msg.victimId];
    trailRenderer!.clearTrail(msg.victimId);

    const killer = client!.room?.state.players.get(msg.killerId);
    const killerColor = killer?.color || "#FFE066";

    particleEffects!.triggerConquestEffect(
      msg.x,
      msg.y,
      killerColor,
      msg.victimName || "Opponent",
      msg.absorbedPercent || 0
    );

    if (msg.victimId === client!.localSessionId) {
      const player = client!.room?.state.players.get(client!.localSessionId);
      uiManager!.showDeathScreen(
        msg.killerName,
        msg.isSuicide,
        player?.territoryPercent || 0,
        player?.kills || 0
      );
    }
  };

  client!.onGameOver = (msg) => {
    const isWinner = msg.winnerId === client!.localSessionId;
    uiManager!.showGameOverScreen(
      msg.winnerId,
      msg.winnerName,
      msg.winnerColor,
      isWinner,
      msg.winnerPercent,
      msg.winnerKills,
      msg.victoryReason ?? "map_occupied"
    );
  };

  uiManager!.onRespawnClick = () => {
    returnToStartScreen();
  };

  canvas.setAttribute("tabindex", "0");
  canvas.focus();

  // Show connecting indicator
  const connectOverlay = document.createElement("div");
  connectOverlay.id = "connect-overlay";
  connectOverlay.style.cssText = `
    position:fixed;top:0;left:0;width:100%;height:100%;
    display:flex;align-items:center;justify-content:center;
    background:rgba(0,0,0,0.3);z-index:200;
    font-family:'Outfit',sans-serif;font-size:20px;font-weight:700;
    color:#fff;text-shadow:0 2px 8px rgba(0,0,0,0.3);
  `;
  connectOverlay.textContent = "Connecting...";
  document.body.appendChild(connectOverlay);

  // Connect to room
  try {
    const room = await client!.connect(playerName);
    connectOverlay.remove();
    movementSynchronizer!.setLocalPlayer(client!.localSessionId);
    const localPlayer = room.state.players.get(client!.localSessionId);
    if (localPlayer) {
      // Do not force every newly spawned player toward the default zero angle
      // before their first touch sample arrives.
      inputController!.targetAngle = localPlayer.angle;
      movementSynchronizer!.setLocalInput(localPlayer.angle);
    }

    const updateStatePresentation = (state: typeof room.state) => {
      movementSynchronizer!.captureState(state);
      if (state.players) {
        const leaderboardItems: LeaderboardItem[] = [];
        state.players.forEach((p: any) => {
          if (p.playerIndex > 0 && p.color) {
            arenaRenderer!.setPlayerColor(p.playerIndex, p.color);
          }
          if (p.alive) {
            leaderboardItems.push({
              id: p.id,
              name: p.name,
              percent: p.territoryPercent,
              color: p.color,
              rank: p.rank || 0,
              characterSkin: p.characterSkin || "cube",
            });
          }
        });
        leaderboardItems.sort((a, b) => b.percent - a.percent);
        uiManager!.updateLeaderboard(leaderboardItems);
        charRenderer!.cleanupRemoved(state.players);
        trailRenderer!.cleanupRemoved(state.players);
        movementSynchronizer!.cleanupRemoved(state.players);

        // Match completion is durable state as well as an immediate message,
        // so a delayed patch still produces the result page reliably.
        if (state.gameOver && state.winnerId) {
          const winner = state.players.get(state.winnerId);
          const victoryReason =
            state.winnerReason === "last_survivor"
              ? "last_survivor"
              : "map_occupied";
          uiManager!.showGameOverScreen(
            state.winnerId,
            state.winnerName || winner?.name || "Champion",
            state.winnerColor || winner?.color || "#6350E5",
            state.winnerId === client!.localSessionId,
            state.winnerPercent || winner?.territoryPercent || 100,
            state.winnerKills || winner?.kills || 0,
            victoryReason
          );
          observedGameOverState = true;
        } else if (observedGameOverState) {
          uiManager!.hideGameOverScreen();
          observedGameOverState = false;
        }
      }
    };
    updateStatePresentation(room.state);
    room.onStateChange(updateStatePresentation);
  } catch (err) {
    console.error("[main] Failed to connect to game server:", err);
    connectOverlay.textContent = `Connection failed! ${(err as Error)?.message || ""}`;
    connectOverlay.style.background = "rgba(200,30,30,0.6)";
    throw err;
  }
}

/* -------------------------------------------------------
   BOOTSTRAP
   ------------------------------------------------------- */
if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", () => {
    setupStartScreen();
  });
} else {
  setupStartScreen();
}
