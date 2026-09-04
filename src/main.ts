import { ArenaRenderer } from "./game/ArenaRenderer.js";
import { CharacterRenderer } from "./game/CharacterRenderer.js";
import { GameClient } from "./game/GameClient.js";
import { InputController } from "./game/InputController.js";
import { ParticleEffects } from "./game/ParticleEffects.js";
import { SceneManager } from "./game/SceneManager.js";
import { TrailRenderer } from "./game/TrailRenderer.js";
import { MiniMap } from "./ui/MiniMap.js";
import { LeaderboardItem, UIManager } from "./ui/UIManager.js";

let sceneManager: SceneManager | null = null;
let arenaRenderer: ArenaRenderer | null = null;
let charRenderer: CharacterRenderer | null = null;
let trailRenderer: TrailRenderer | null = null;
let particleEffects: ParticleEffects | null = null;
let inputController: InputController | null = null;
let uiManager: UIManager | null = null;
let miniMap: MiniMap | null = null;
let client: GameClient | null = null;
let started = false;

function returnToStartScreen() {
  started = false;
  if (client) {
    client.disconnect();
  }
  if (charRenderer) {
    charRenderer.removeAll();
  }
  if (trailRenderer) {
    trailRenderer.removeAll();
  }
  if (uiManager) {
    uiManager.hideDeathScreen();
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

  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

  canvas.width = window.innerWidth * (window.devicePixelRatio || 1);
  canvas.height = window.innerHeight * (window.devicePixelRatio || 1);

  // 1. Initialize singletons on first run
  if (!sceneManager) {
    sceneManager = new SceneManager(canvas);
    sceneManager.engine.resize();

    arenaRenderer = new ArenaRenderer(sceneManager.scene);
    charRenderer = new CharacterRenderer(sceneManager.scene);
    trailRenderer = new TrailRenderer(sceneManager.scene);
    particleEffects = new ParticleEffects(sceneManager.scene);
    inputController = new InputController(canvas);

    uiManager = new UIManager();
    const minimapBox = document.getElementById("minimap-box") as HTMLElement;
    miniMap = new MiniMap(minimapBox);

    client = new GameClient();

    // 2. Main Game & Render Loop (starts once)
    let totalTime = 0;
    let renderFrameCount = 0;
    let wasLocalDead = false;

    sceneManager.startRenderLoop((dt) => {
      totalTime += dt;
      renderFrameCount++;
      arenaRenderer!.animateWater(totalTime);

      if (!client || !client.room || !client.room.state || !client.room.state.players) {
        return;
      }

      client.sendInput(inputController!.targetAngle, inputController!.boost);

      const playersState = client.room.state.players;
      const leaderId = client.room.state.leaderId;
      const miniMapPlayers: Array<{ id: string; x: number; y: number; isLocal: boolean; color: string; alive: boolean }> = [];
      const leaderboardItems: LeaderboardItem[] = [];

      playersState.forEach((player: any, sessionId: string) => {
        const isLocal = sessionId === client!.localSessionId;
        const isLeader = sessionId === leaderId;

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
        charRenderer!.updatePlayer(sessionId, player.x, player.y, player.angle, player.alive, isLeader, dt);

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
          const snap = (wasLocalDead || renderFrameCount <= 3) && player.alive;
          sceneManager!.setCameraTarget(player.x, player.y, !snap);
          wasLocalDead = !player.alive;
          uiManager!.updatePlayerStats(player.territoryPercent, player.kills, player.score);
        }

        miniMapPlayers.push({
          id: sessionId,
          x: player.x,
          y: player.y,
          isLocal,
          color: player.color,
          alive: player.alive,
        });

        if (player.alive) {
          leaderboardItems.push({
            id: sessionId,
            name: player.name,
            percent: player.territoryPercent,
            color: player.color,
            rank: player.rank || 0,
            characterSkin: player.characterSkin || "cube",
          });
        }
      });

      leaderboardItems.sort((a, b) => b.percent - a.percent);
      uiManager!.updateLeaderboard(leaderboardItems);
      miniMap!.render(arenaRenderer!.rawGrid, arenaRenderer!.playerColorMap, miniMapPlayers);
    });
  } else {
    // Re-use: cleanup previous match
    client!.disconnect();
    charRenderer!.removeAll();
    trailRenderer!.removeAll();
  }

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

  // 3. Setup Network Event Handlers on client
  client!.onGridSync = (gridArray) => {
    arenaRenderer!.updateGrid(gridArray);
    syncPlayerMeta();
    arenaRenderer!.renderTerritory();
  };

  client!.onTerritoryCaptured = (msg) => {
    const capturingPlayer = client!.room?.state.players.get(msg.playerId);
    const color = capturingPlayer?.color || "#00D2FF";
    // The server has already consumed this trail into territory. Remove the
    // cached presentation mesh immediately instead of waiting for the next
    // low-frequency trail_sync message.
    delete client!.trailData[msg.playerId];
    trailRenderer!.clearTrail(msg.playerId);
    syncPlayerMeta();
    arenaRenderer!.renderTerritory();
    particleEffects!.triggerCaptureEffect(msg.centerX, msg.centerY, color, msg.cellsCount);
  };

  client!.onPlayerKilled = (msg) => {
    delete client!.trailData[msg.victimId];
    trailRenderer!.clearTrail(msg.victimId);
    syncPlayerMeta();
    arenaRenderer!.renderTerritory();

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
    uiManager!.showGameOverScreen(msg.winnerName, isWinner, msg.winnerPercent, msg.winnerKills);
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

    room.onStateChange((state) => {
      if (state.players) {
        state.players.forEach((p: any) => {
          if (p.playerIndex > 0 && p.color) {
            arenaRenderer!.setPlayerColor(p.playerIndex, p.color);
          }
        });
        charRenderer!.cleanupRemoved(state.players);
        trailRenderer!.cleanupRemoved(state.players);
      }
    });
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
