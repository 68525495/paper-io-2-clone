export interface LeaderboardItem {
  id: string;
  name: string;
  percent: number;
  color: string;
  rank: number;
  characterSkin: string;
}

export class UIManager {
  private killsCountText!: HTMLElement;
  private leaderboardContainer!: HTMLElement;
  private deathModal!: HTMLElement;
  private deathReasonText!: HTMLElement;
  private deathStatsText!: HTMLElement;
  private respawnBtn!: HTMLElement;

  public onRespawnClick: (() => void) | null = null;

  constructor() {
    this.createUIElements();
  }

  private createUIElements() {
    const root = document.getElementById("ui-layer") as HTMLElement;

    // Top-Left Stats (Kills only, no coins)
    const statsContainer = document.createElement("div");
    statsContainer.className = "top-left-stats";
    statsContainer.innerHTML = `
      <div class="stat-pill kills-pill">
        <div class="stat-icon skull-icon">💀</div>
        <span class="stat-value" id="kills-value">0</span>
      </div>
    `;
    root.appendChild(statsContainer);

    this.killsCountText = statsContainer.querySelector("#kills-value") as HTMLElement;

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
    deathOverlay.innerHTML = `
      <div class="death-card">
        <div class="death-title">ELIMINATED</div>
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
    this.deathReasonText = deathOverlay.querySelector("#death-reason") as HTMLElement;
    this.deathStatsText = deathOverlay.querySelector("#death-stats") as HTMLElement;
    this.respawnBtn = deathOverlay.querySelector("#respawn-btn") as HTMLElement;

    this.respawnBtn.addEventListener("click", () => {
      if (this.onRespawnClick) this.onRespawnClick();
      this.hideDeathScreen();
    });
  }

  updatePlayerStats(percent: number, kills: number, _score: number) {
    this.killsCountText.innerText = `${kills}`;
  }

  updateLeaderboard(entries: LeaderboardItem[]) {
    const top3 = entries.slice(0, 3);
    let html = "";

    const rankBadges = ["👑", "②", "③"];
    const avatarIcons = ["🐰", "🦊", "🤖", "🐻", "🐱"];

    top3.forEach((item, idx) => {
      const avatar = avatarIcons[Math.abs(item.name.charCodeAt(0) || 0) % avatarIcons.length];
      const rankClass = `rank-${idx + 1}`;

      html += `
        <div class="leaderboard-item ${rankClass}">
          <div class="lb-rank-badge">${rankBadges[idx]}</div>
          <div class="lb-avatar" style="border-color: ${item.color};">
            <span class="avatar-emoji">${avatar}</span>
          </div>
          <div class="lb-info">
            <span class="lb-percent">${item.percent.toFixed(2)}%</span>
          </div>
        </div>
      `;
    });

    this.leaderboardContainer.innerHTML = html;
  }

  showDeathScreen(killerName: string, isSuicide: boolean, percent: number, kills: number) {
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

  showGameOverScreen(winnerName: string, isWinner: boolean, percent: number, kills: number) {
    this.deathModal.classList.remove("hidden");
    const titleEl = document.getElementById("death-title");
    if (titleEl) {
      titleEl.innerText = isWinner ? "🏆 VICTORY!" : "MAP CONQUERED!";
    }
    this.deathReasonText.innerText = isWinner
      ? "You occupied the entire map! Total Victory!"
      : `${winnerName} conquered the entire map!`;

    this.deathStatsText.innerHTML = `
      <div class="death-stat-row"><span>Final Area:</span> <strong>${percent.toFixed(2)}%</strong></div>
      <div class="death-stat-row"><span>Total Kills:</span> <strong>${kills}</strong></div>
    `;

    const respawnBtn = document.getElementById("btn-respawn");
    if (respawnBtn) {
      respawnBtn.innerText = "PLAY AGAIN";
    }
  }

  hideDeathScreen() {
    this.deathModal.classList.add("hidden");
    const titleEl = document.getElementById("death-title");
    if (titleEl) titleEl.innerText = "YOU DIED";
    const respawnBtn = document.getElementById("btn-respawn");
    if (respawnBtn) respawnBtn.innerText = "REVIVE";
  }
}
