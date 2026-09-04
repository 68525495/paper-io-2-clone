import type { VictoryReason } from "../shared/protocol.js";

export interface LeaderboardItem {
  id: string;
  name: string;
  percent: number;
  color: string;
  rank: number;
  characterSkin: string;
}

export class UIManager {
  private territoryPercentText!: HTMLElement;
  private killsCountText!: HTMLElement;
  private latencyText!: HTMLElement;
  private leaderboardContainer!: HTMLElement;
  private deathModal!: HTMLElement;
  private deathTitleText!: HTMLElement;
  private deathReasonText!: HTMLElement;
  private deathStatsText!: HTMLElement;
  private respawnBtn!: HTMLElement;
  private gameOverModal!: HTMLElement;
  private gameOverCard!: HTMLElement;
  private gameOverTrophyText!: HTMLElement;
  private gameOverKickerText!: HTMLElement;
  private gameOverTitleText!: HTMLElement;
  private gameOverMessageText!: HTMLElement;
  private gameOverPercentText!: HTMLElement;
  private gameOverProgressFill!: HTMLElement;
  private gameOverKillsText!: HTMLElement;
  private playAgainBtn!: HTMLButtonElement;
  private leaderboardSignature = "";
  private displayedPercent: number | null = null;
  private displayedLatency: number | null = null;
  private displayedKills: number | null = null;
  private displayedWinnerId = "";
  private displayedVictoryReason: VictoryReason | "" = "";

  public onRespawnClick: (() => void) | null = null;

  constructor() {
    this.createUIElements();
  }

  private createUIElements() {
    const root = document.getElementById("ui-layer") as HTMLElement;

    // Top-Left Stats
    const statsContainer = document.createElement("div");
    statsContainer.className = "top-left-stats";
    statsContainer.innerHTML = `
      <div class="stat-pill territory-pill" title="Territory captured">
        <div class="stat-icon territory-icon">🗺️</div>
        <span class="stat-value territory-value" id="territory-value">0%</span>
      </div>
      <div class="stat-pill kills-pill">
        <div class="stat-icon skull-icon">💀</div>
        <span class="stat-value" id="kills-value">0</span>
      </div>
      <div class="stat-pill latency-pill" title="Server round-trip latency">
        <div class="stat-icon latency-icon">📶</div>
        <span class="stat-value latency-value latency-pending" id="latency-value">-- ms</span>
      </div>
    `;
    root.appendChild(statsContainer);

    this.territoryPercentText = statsContainer.querySelector("#territory-value") as HTMLElement;
    this.killsCountText = statsContainer.querySelector("#kills-value") as HTMLElement;
    this.latencyText = statsContainer.querySelector("#latency-value") as HTMLElement;

    // 3. Top-Right Leaderboard
    const lbContainer = document.createElement("div");
    lbContainer.className = "top-right-leaderboard";
    lbContainer.id = "leaderboard-list";
    root.appendChild(lbContainer);
    this.leaderboardContainer = lbContainer;

    // 4. Bottom-Left Minimap Container
    const minimapBox = document.createElement("div");
    minimapBox.className = "bottom-left-minimap-box";
    minimapBox.id = "minimap-box";
    root.appendChild(minimapBox);

    // 5. Death / Respawn Modal
    const deathOverlay = document.createElement("div");
    deathOverlay.className = "death-overlay hidden";
    deathOverlay.id = "death-overlay";
    deathOverlay.setAttribute("role", "dialog");
    deathOverlay.setAttribute("aria-modal", "true");
    deathOverlay.setAttribute("aria-labelledby", "death-title");
    deathOverlay.innerHTML = `
      <div class="death-card">
        <div class="death-title" id="death-title">ELIMINATED</div>
        <div class="death-reason" id="death-reason">You cut your own trail!</div>
        <div class="death-stats" id="death-stats">
          <div class="death-stat-row"><span>Area Captured:</span> <strong>0%</strong></div>
          <div class="death-stat-row"><span>Kills:</span> <strong>0</strong></div>
        </div>
        <button class="respawn-button" id="respawn-btn">PLAY AGAIN</button>
      </div>
    `;
    root.appendChild(deathOverlay);

    this.deathModal = deathOverlay;
    this.deathTitleText = deathOverlay.querySelector("#death-title") as HTMLElement;
    this.deathReasonText = deathOverlay.querySelector("#death-reason") as HTMLElement;
    this.deathStatsText = deathOverlay.querySelector("#death-stats") as HTMLElement;
    this.respawnBtn = deathOverlay.querySelector("#respawn-btn") as HTMLElement;

    this.respawnBtn.addEventListener("click", () => {
      if (this.onRespawnClick) this.onRespawnClick();
      this.hideDeathScreen();
    });

    // 6. Dedicated match result page. Keeping it separate from the death card
    // prevents a final kill event from leaving the winner labelled eliminated.
    const gameOverOverlay = document.createElement("div");
    gameOverOverlay.className = "game-over-overlay hidden";
    gameOverOverlay.id = "game-over-overlay";
    gameOverOverlay.setAttribute("role", "dialog");
    gameOverOverlay.setAttribute("aria-modal", "true");
    gameOverOverlay.setAttribute("aria-labelledby", "game-over-title");
    gameOverOverlay.innerHTML = `
      <div class="game-over-confetti" aria-hidden="true">
        <i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i>
      </div>
      <div class="game-over-card victory-result">
        <div class="game-over-halo" aria-hidden="true"></div>
        <div class="game-over-trophy" aria-hidden="true">🏆</div>
        <div class="game-over-kicker">MAP 100% OCCUPIED</div>
        <div class="game-over-title" id="game-over-title">VICTORY!</div>
        <div class="game-over-message"></div>
        <div class="game-over-progress" aria-label="Final territory captured">
          <div class="game-over-progress-head">
            <span>FINAL TERRITORY</span>
            <strong class="game-over-percent">100%</strong>
          </div>
          <div class="game-over-progress-track">
            <div class="game-over-progress-fill"></div>
          </div>
        </div>
        <div class="game-over-stat">
          <span>TOTAL KILLS</span>
          <strong class="game-over-kills">0</strong>
        </div>
        <button class="game-over-button" type="button">PLAY AGAIN</button>
      </div>
    `;
    root.appendChild(gameOverOverlay);

    this.gameOverModal = gameOverOverlay;
    this.gameOverCard = gameOverOverlay.querySelector(".game-over-card") as HTMLElement;
    this.gameOverTrophyText = gameOverOverlay.querySelector(".game-over-trophy") as HTMLElement;
    this.gameOverKickerText = gameOverOverlay.querySelector(".game-over-kicker") as HTMLElement;
    this.gameOverTitleText = gameOverOverlay.querySelector(".game-over-title") as HTMLElement;
    this.gameOverMessageText = gameOverOverlay.querySelector(".game-over-message") as HTMLElement;
    this.gameOverPercentText = gameOverOverlay.querySelector(".game-over-percent") as HTMLElement;
    this.gameOverProgressFill = gameOverOverlay.querySelector(".game-over-progress-fill") as HTMLElement;
    this.gameOverKillsText = gameOverOverlay.querySelector(".game-over-kills") as HTMLElement;
    this.playAgainBtn = gameOverOverlay.querySelector(".game-over-button") as HTMLButtonElement;

    this.playAgainBtn.addEventListener("click", () => {
      if (this.onRespawnClick) this.onRespawnClick();
      this.hideGameOverScreen();
    });
  }

  updatePlayerStats(percent: number, kills: number, _score: number) {
    const boundedPercent = Number.isFinite(percent)
      ? Math.max(0, Math.min(100, percent))
      : 0;
    const roundedPercent = Math.round(boundedPercent * 100) / 100;
    if (roundedPercent !== this.displayedPercent) {
      this.displayedPercent = roundedPercent;
      this.territoryPercentText.innerText = `${roundedPercent.toFixed(2)}%`;
    }

    if (kills !== this.displayedKills) {
      this.displayedKills = kills;
      this.killsCountText.innerText = `${kills}`;
    }
  }

  updateLatency(roundTripTimeMs: number) {
    const latency =
      Number.isFinite(roundTripTimeMs) && roundTripTimeMs > 0
        ? Math.round(roundTripTimeMs)
        : null;
    if (latency === this.displayedLatency) return;
    this.displayedLatency = latency;

    this.latencyText.textContent = latency === null ? "-- ms" : `${latency} ms`;
    this.latencyText.classList.remove(
      "latency-pending",
      "latency-good",
      "latency-medium",
      "latency-poor"
    );
    if (latency === null) {
      this.latencyText.classList.add("latency-pending");
    } else if (latency <= 80) {
      this.latencyText.classList.add("latency-good");
    } else if (latency <= 160) {
      this.latencyText.classList.add("latency-medium");
    } else {
      this.latencyText.classList.add("latency-poor");
    }
  }

  updateLeaderboard(entries: LeaderboardItem[]) {
    const rankBadges = ["👑", "②", "③"];
    const avatarIcons = ["🐰", "🦊", "🤖", "🐻", "🐱"];
    const signature = JSON.stringify(
      entries.map((item) => [
        item.id,
        item.name,
        item.percent.toFixed(2),
        item.color,
      ])
    );
    if (signature === this.leaderboardSignature) return;
    this.leaderboardSignature = signature;

    const fragment = document.createDocumentFragment();
    entries.forEach((item, idx) => {
      const avatar =
        avatarIcons[
          Math.abs(item.name.charCodeAt(0) || 0) % avatarIcons.length
        ];
      const row = document.createElement("div");
      row.className = `leaderboard-item ${idx < 3 ? `rank-${idx + 1}` : "rank-other"}`;

      const rankBadge = document.createElement("div");
      rankBadge.className = "lb-rank-badge";
      rankBadge.textContent = rankBadges[idx] ?? String(idx + 1);

      const avatarContainer = document.createElement("div");
      avatarContainer.className = "lb-avatar";
      avatarContainer.style.borderColor = item.color;
      const avatarEmoji = document.createElement("span");
      avatarEmoji.className = "avatar-emoji";
      avatarEmoji.textContent = avatar;
      avatarContainer.appendChild(avatarEmoji);

      const info = document.createElement("div");
      info.className = "lb-info";
      const name = document.createElement("span");
      name.className = "lb-name";
      name.textContent = item.name;
      name.title = item.name;
      const percent = document.createElement("span");
      percent.className = "lb-percent";
      percent.textContent = `${item.percent.toFixed(2)}%`;
      info.append(name, percent);

      row.append(rankBadge, avatarContainer, info);
      fragment.appendChild(row);
    });

    this.leaderboardContainer.replaceChildren(fragment);
  }

  showDeathScreen(killerName: string, isSuicide: boolean, percent: number, kills: number) {
    if (!this.gameOverModal.classList.contains("hidden")) return;
    this.deathTitleText.innerText = "ELIMINATED";
    this.deathModal.classList.remove("hidden");
    if (isSuicide) {
      this.deathReasonText.innerText = "You hit your own trail!";
    } else if (killerName) {
      this.deathReasonText.innerText = `Killed by ${killerName}!`;
    } else {
      this.deathReasonText.innerText = "You fell into the ocean!";
    }

    this.deathStatsText.innerHTML = `
      <div class="death-stat-row"><span>Area Captured:</span> <strong>${percent.toFixed(2)}%</strong></div>
      <div class="death-stat-row"><span>Kills:</span> <strong>${kills}</strong></div>
    `;
  }

  showGameOverScreen(
    winnerId: string,
    winnerName: string,
    winnerColor: string,
    isWinner: boolean,
    percent: number,
    kills: number,
    victoryReason: VictoryReason = "map_occupied"
  ) {
    const alreadyShowingWinner =
      this.displayedWinnerId === winnerId &&
      this.displayedVictoryReason === victoryReason &&
      !this.gameOverModal.classList.contains("hidden");
    if (alreadyShowingWinner) return;

    this.hideDeathScreen();
    this.displayedWinnerId = winnerId;
    this.displayedVictoryReason = victoryReason;

    const accentColor = /^#[0-9a-f]{6}$/i.test(winnerColor)
      ? winnerColor
      : "#6350E5";
    const occupiedMap = victoryReason === "map_occupied";
    this.gameOverCard.style.setProperty("--winner-color", accentColor);
    this.gameOverCard.classList.toggle("victory-result", isWinner);
    this.gameOverCard.classList.toggle("defeat-result", !isWinner);
    this.gameOverTrophyText.innerText = isWinner ? "🏆" : "🏁";
    this.gameOverKickerText.innerText = isWinner
      ? occupiedMap
        ? "MAP 100% OCCUPIED"
        : "LAST PLAYER STANDING"
      : "MATCH COMPLETE";
    this.gameOverTitleText.innerText = isWinner
      ? "VICTORY!"
      : occupiedMap
        ? "MAP CONQUERED"
        : "DEFEAT";
    this.gameOverMessageText.innerText = isWinner
      ? occupiedMap
        ? "You conquered every last piece of the map."
        : "No opponents remain. You are the last player standing."
      : occupiedMap
        ? `${winnerName} occupied 100% of the map.`
        : `${winnerName} is the last player standing.`;

    const boundedPercent = Number.isFinite(percent)
      ? Math.max(0, Math.min(100, percent))
      : 100;
    this.gameOverPercentText.innerText = `${Number.isInteger(boundedPercent) ? boundedPercent : boundedPercent.toFixed(2)}%`;
    this.gameOverProgressFill.style.width = `${boundedPercent}%`;
    this.gameOverKillsText.innerText = `${Math.max(0, Math.floor(kills))}`;
    this.gameOverModal.classList.remove("hidden");
    queueMicrotask(() => this.playAgainBtn.focus({ preventScroll: true }));
  }

  hideDeathScreen() {
    this.deathModal.classList.add("hidden");
    this.deathTitleText.innerText = "ELIMINATED";
    this.respawnBtn.innerText = "PLAY AGAIN";
  }

  hideGameOverScreen() {
    this.gameOverModal.classList.add("hidden");
    this.displayedWinnerId = "";
    this.displayedVictoryReason = "";
  }
}
