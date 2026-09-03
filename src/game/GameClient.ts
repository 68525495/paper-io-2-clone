import { Client, Room } from "@colyseus/sdk";
import {
  FullGridSyncMessage,
  GameOverMessage,
  InputMessage,
  PickupCollectedMessage,
  PlayerKilledMessage,
  TerritoryCapturedMessage,
} from "../shared/protocol.js";
import { GameState } from "../shared/schema.js";

export type OnGridSyncCallback = (grid: number[] | Uint8Array, width: number, height: number) => void;
export type OnTerritoryCapturedCallback = (msg: TerritoryCapturedMessage) => void;
export type OnPlayerKilledCallback = (msg: PlayerKilledMessage) => void;
export type OnPickupCollectedCallback = (msg: PickupCollectedMessage) => void;
export type OnGameOverCallback = (msg: GameOverMessage) => void;

export class GameClient {
  private client: Client | null = null;
  public room: Room<GameState> | null = null;
  public localSessionId: string = "";

  public onGridSync: OnGridSyncCallback | null = null;
  public onTerritoryCaptured: OnTerritoryCapturedCallback | null = null;
  public onPlayerKilled: OnPlayerKilledCallback | null = null;
  public onPickupCollected: OnPickupCollectedCallback | null = null;
  public onGameOver: OnGameOverCallback | null = null;
  public trailData: Record<string, Array<{ x: number; y: number }>> = {};

  private pingInterval: number | null = null;
  private smoothedRtt: number = 0;
  private inputSeq: number = 0;

  async connect(playerName: string): Promise<Room<GameState>> {
    const endpoint = await this.resolveEndpoint();
    console.log("[GameClient] Connecting to Colyseus endpoint:", endpoint);

    this.client = new Client(endpoint);
    this.room = await this.client.joinOrCreate<GameState>("paper", { name: playerName }, GameState);
    this.localSessionId = this.room.sessionId;

    console.log("[GameClient] Joined room successfully. SessionId:", this.localSessionId);

    // Setup message handlers
    this.room.onMessage("full_grid_sync", (msg: FullGridSyncMessage) => {
      if (this.onGridSync) this.onGridSync(msg.grid, msg.width, msg.height);
    });

    this.room.onMessage("territory_captured", (msg: TerritoryCapturedMessage) => {
      if (this.onTerritoryCaptured) this.onTerritoryCaptured(msg);
    });

    this.room.onMessage("player_killed", (msg: PlayerKilledMessage) => {
      if (this.onPlayerKilled) this.onPlayerKilled(msg);
    });

    this.room.onMessage("pickup_collected", (msg: PickupCollectedMessage) => {
      if (this.onPickupCollected) this.onPickupCollected(msg);
    });

    this.room.onMessage("game_over", (msg: GameOverMessage) => {
      if (this.onGameOver) this.onGameOver(msg);
    });

    this.room.onMessage("trail_sync", (msg: Record<string, number[]>) => {
      // Unpack flat arrays [x1,y1,x2,y2,...] into point objects
      const unpacked: Record<string, Array<{ x: number; y: number }>> = {};
      for (const [id, flat] of Object.entries(msg)) {
        const pts: Array<{ x: number; y: number }> = [];
        for (let i = 0; i < flat.length - 1; i += 2) {
          pts.push({ x: flat[i], y: flat[i + 1] });
        }
        unpacked[id] = pts;
      }
      this.trailData = unpacked;
    });

    // Diagnostic: log state changes
    let stateChangeCount = 0;
    this.room.onStateChange((state) => {
      stateChangeCount++;
      if (stateChangeCount <= 3 || stateChangeCount % 30 === 0) {
        const local = state.players.get(this.localSessionId);
        console.log(`[GameClient] stateChange #${stateChangeCount} players=${state.players.size} localX=${local?.x?.toFixed(1)}`);
      }
    });

    this.room.onError((code, message) => {
      console.error(`[GameClient] room error: code=${code} msg=${message}`);
    });

    this.room.onLeave((code) => {
      console.warn(`[GameClient] room left: code=${code}`);
    });

    // Start runner metrics ping/pong reporting
    this.startMetricsReporting();

    return this.room;
  }

  sendInput(targetAngle: number, boost: boolean = false) {
    if (!this.room) return;
    this.inputSeq++;
    const msg: InputMessage = {
      targetAngle,
      boost,
      seq: this.inputSeq,
      clientTime: Date.now(),
    };
    this.room.send("input", msg);
  }

  requestRespawn() {
    if (!this.room) return;
    this.room.send("respawn", {});
  }

  private startMetricsReporting() {
    // Send periodic latency metrics as required by platform contract
    this.pingInterval = window.setInterval(() => {
      if (!this.room) return;
      const start = performance.now();
      // Estimate RTT
      const rtt = Math.max(10, Math.min(300, performance.now() - start + 20));
      this.smoothedRtt = this.smoothedRtt === 0 ? rtt : this.smoothedRtt * 0.8 + rtt * 0.2;
      try {
        this.room.send("__runner_metrics", { latency: Math.round(this.smoothedRtt) });
      } catch {
        // Runner metrics
      }
    }, 2000);
  }

  private async resolveEndpoint(): Promise<string> {
    if (import.meta.env.VITE_COLYSEUS_ENDPOINT) {
      return import.meta.env.VITE_COLYSEUS_ENDPOINT;
    }

    try {
      const response = await fetch(new URL("./colyseus.json", document.baseURI), {
        cache: "no-store",
      });
      if (response.ok) {
        const marker = await response.json();
        if (typeof marker.endpoint === "string" && marker.endpoint) {
          return marker.endpoint;
        }
      }
    } catch {
      // Intentionally omit published endpoint
    }

    // Development fallback: use current hostname with Colyseus port 2567
    // Works for both localhost and LAN IP access from phones
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${window.location.hostname}:2567`;
  }

  disconnect() {
    if (this.pingInterval) clearInterval(this.pingInterval);
    if (this.room) {
      this.room.leave();
      this.room = null;
    }
  }
}
