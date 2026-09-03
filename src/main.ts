import { ArenaRenderer } from "./game/ArenaRenderer.js";
import { CharacterRenderer } from "./game/CharacterRenderer.js";
import { GameClient } from "./game/GameClient.js";
import { InputController } from "./game/InputController.js";
import { ParticleEffects } from "./game/ParticleEffects.js";
import { SceneManager } from "./game/SceneManager.js";
import { TrailRenderer } from "./game/TrailRenderer.js";
import { MiniMap } from "./ui/MiniMap.js";
import { LeaderboardItem, UIManager } from "./ui/UIManager.js";

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

  let started = false;

  const startGame = () => {
    if (started) return; // prevent double-init from touch + click
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
      started = false; // allow retry
      startScreen.classList.remove("hidden");
      gameScreen.classList.add("hidden");
    });
  };

  playBtn.addEventListener("click", startGame);

  // Also allow Enter key on name input
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

  // Wait one frame so the browser lays out #game-screen (was display:none)
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

  // Force canvas to fill screen
  canvas.width = window.innerWidth * (window.devicePixelRatio || 1);
  canvas.height = window.innerHeight * (window.devicePixelRatio || 1);

  // 1. Initialize 3D Engine & Scene
  const sceneManager = new SceneManager(canvas);
  // Force engine to recalculate after layout
  sceneManager.engine.resize();

  const arenaRenderer = new ArenaRenderer(sceneManager.scene);
  const charRenderer = new CharacterRenderer(sceneManager.scene);
  const trailRenderer = new TrailRenderer(sceneManager.scene);
  const particleEffects = new ParticleEffects(sceneManager.scene);
  const inputController = new InputController(canvas);

  // 2. Initialize UI
  const uiManager = new UIManager();
  const minimapBox = document.getElementById("minimap-box") as HTMLElement;
  const miniMap = new MiniMap(minimapBox);

  // 3. Initialize Network Client
  const client = new GameClient();

  // Color mapping by playerIndex
  const playerColorMap = new Map<number, string>();
  let totalTime = 0;
  let wasLocalDead = false;

  // Setup Network Event Handlers
  client.onGridSync = (gridArray, width, height) => {
    arenaRenderer.updateGrid(gridArray);
    arenaRenderer.renderTerritory();
  };

  client.onTerritoryCaptured = (msg) => {
    arenaRenderer.renderTerritory();
    const capturingPlayer = client.room?.state.players.get(msg.playerId);
    const color = capturingPlayer?.color || "#3CB5F9";
    particleEffects.triggerCaptureEffect(msg.centerX, msg.centerY, color, msg.cellsCount);
  };

  client.onPlayerKilled = (msg) => {
    trailRenderer.clearTrail(msg.victimId);
    arenaRenderer.renderTerritory();

    const killer = client.room?.state.players.get(msg.killerId);
    const killerColor = killer?.color || "#FFE066";

    // Trigger conquer visual effects with expanding shockwaves and banners
    particleEffects.triggerConquestEffect(
      msg.x,
      msg.y,
      killerColor,
      msg.victimName || "Opponent",
      msg.absorbedPercent || 0
    );

    if (msg.victimId === client.localSessionId) {
      // Local player died!
      const player = client.room?.state.players.get(client.localSessionId);
      uiManager.showDeathScreen(
        msg.killerName,
        msg.isSuicide,
        player?.territoryPercent || 0,
        player?.kills || 0
      );
    }
  };

  client.onGameOver = (msg) => {
    const isWinner = msg.winnerId === client.localSessionId;
    uiManager.showGameOverScreen(msg.winnerName, isWinner, msg.winnerPercent, msg.winnerKills);
  };

  uiManager.onRespawnClick = () => {
    uiManager.hideDeathScreen();
    client.requestRespawn();
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
    const room = await client.connect(playerName);
    connectOverlay.remove();

    // Handle state changes
    room.onStateChange((state) => {
      if (state.players) {
        state.players.forEach((p: any) => {
          if (p.playerIndex > 0 && p.color) {
            arenaRenderer.setPlayerColor(p.playerIndex, p.color);
            playerColorMap.set(p.playerIndex, p.color);
          }
        });
        charRenderer.cleanupRemoved(state.players);
      }
      arenaRenderer.renderTerritory();
    });
  } catch (err) {
    console.error("[main] Failed to connect to game server:", err);
    connectOverlay.textContent = `Connection failed! ${(err as Error)?.message || ""}`;
    connectOverlay.style.background = "rgba(200,30,30,0.6)";
    throw err; // propagate so start screen shows again
  }

  // 4. Main Game & Render Loop
  let renderFrameCount = 0;
  sceneManager.startRenderLoop((dt) => {
    totalTime += dt;
    renderFrameCount++;
    arenaRenderer.animateWater(totalTime);
    arenaRenderer.renderTerritory();

    if (!client.room || !client.room.state || !client.room.state.players) {
      if (renderFrameCount % 60 === 0) {
        console.warn("[main] no room/state/players", {
          hasRoom: !!client.room,
          hasState: !!client.room?.state,
          hasPlayers: !!(client.room?.state as any)?.players,
        });
      }
      return;
    }

    // Log state health every ~1 second
    if (renderFrameCount % 60 === 0) {
      const p = client.room.state.players;
      const local = p.get(client.localSessionId);
      console.log(`[main] frame=${renderFrameCount} players=${p.size} localAlive=${local?.alive} localX=${local?.x?.toFixed(1)} localY=${local?.y?.toFixed(1)}`);
    }

    // Send local steering input to server
    client.sendInput(inputController.targetAngle, inputController.boost);

    const playersState = client.room.state.players;
    const leaderId = client.room.state.leaderId;
    const miniMapPlayers: Array<{ id: string; x: number; y: number; isLocal: boolean; color: string; alive: boolean }> = [];
    const leaderboardItems: LeaderboardItem[] = [];

    // Process all players
    playersState.forEach((player: any, sessionId: string) => {
      const isLocal = sessionId === client.localSessionId;
      const isLeader = sessionId === leaderId;

      if (player.playerIndex > 0) {
        arenaRenderer.setPlayerColor(player.playerIndex, player.color);
        playerColorMap.set(player.playerIndex, player.color);
      }

      charRenderer.getOrCreate(sessionId, player.name, player.color, player.isBot);
      charRenderer.updatePlayer(sessionId, player.x, player.y, player.angle, player.alive, isLeader, dt);

      // Trail update (from raw message, not schema)
      const trailPoints = client.trailData[sessionId];
      if (player.alive && trailPoints && trailPoints.length > 0) {
        trailRenderer.updateTrail(sessionId, player.color, trailPoints, player.x, player.y);
      } else {
        trailRenderer.clearTrail(sessionId);
      }

      if (isLocal) {
        // Smooth camera follow (snap camera immediately if player just spawned / respawned)
        const snap = (wasLocalDead || renderFrameCount <= 3) && player.alive;
        sceneManager.setCameraTarget(player.x, player.y, !snap);
        wasLocalDead = !player.alive;

        // Update local HUD
        uiManager.updatePlayerStats(player.territoryPercent, player.kills, player.score);
      }

      // Collect data for minimap
      miniMapPlayers.push({
        id: sessionId,
        x: player.x,
        y: player.y,
        isLocal,
        color: player.color,
        alive: player.alive,
      });

      // Collect data for leaderboard
      if (player.alive) {
        leaderboardItems.push({
          id: sessionId,
          name: player.name,
          percent: player.territoryPercent,
          color: player.color,
          rank: player.rank,
          characterSkin: player.characterSkin,
        });
      }
    });

    // Sort leaderboard by percentage descending
    leaderboardItems.sort((a, b) => b.percent - a.percent);
    uiManager.updateLeaderboard(leaderboardItems);

    // Update MiniMap
    miniMap.render(arenaRenderer["rawGrid"], playerColorMap, miniMapPlayers);
  });
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
