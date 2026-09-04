import { Client, Room } from "@colyseus/sdk";
import {
  ClockPingMessage,
  ClockPongMessage,
  decodeGridSync,
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

export interface SentInputSample {
  targetAngle: number;
  boost: boolean;
  seq: number;
  dt: number;
  clientTime: number;
}

const CHANGED_INPUT_SEND_INTERVAL_MS = 1000 / 60;
const INPUT_HEARTBEAT_MS = 250;
const INPUT_ANGLE_EPSILON = 0.0025;

interface TransitionalTrailDelta {
  reset: boolean;
  startPoint: number;
  points: number[];
}

export type TrailSyncPayload = Record<
  string,
  number[] | TransitionalTrailDelta
>;

/**
 * Accept both the stable full-snapshot format and the short-lived incremental
 * format so a WebView refresh cannot lose trails during a rolling restart.
 */
export function applyTrailSync(
  trails: Record<string, number[]>,
  message: TrailSyncPayload
): Record<string, number[]> {
  const entries = Object.entries(message);
  if (entries.every(([, value]) => Array.isArray(value))) {
    const snapshot: Record<string, number[]> = {};
    for (const [playerId, points] of entries) {
      if (Array.isArray(points)) snapshot[playerId] = points;
    }
    return snapshot;
  }

  for (const [playerId, payload] of entries) {
    if (Array.isArray(payload)) {
      trails[playerId] = payload;
      continue;
    }
    if (!payload || !Array.isArray(payload.points)) continue;

    if (payload.reset) {
      if (payload.points.length >= 2) trails[playerId] = payload.points;
      else delete trails[playerId];
      continue;
    }

    const existing = trails[playerId];
    if (!existing || existing.length !== payload.startPoint * 2) {
      delete trails[playerId];
      continue;
    }
    existing.push(...payload.points);
  }
  return trails;
}

function normalizeAngle(angle: number): number {
  let normalized = (angle + Math.PI) % (Math.PI * 2);
  if (normalized < 0) normalized += Math.PI * 2;
  return normalized - Math.PI;
}

function angleDistance(a: number, b: number): number {
  return Math.abs(normalizeAngle(b - a));
}

export class GameClient {
  private client: Client | null = null;
  public room: Room<GameState> | null = null;
  public localSessionId: string = "";

  public onGridSync: OnGridSyncCallback | null = null;
  public onTerritoryCaptured: OnTerritoryCapturedCallback | null = null;
  public onPlayerKilled: OnPlayerKilledCallback | null = null;
  public onPickupCollected: OnPickupCollectedCallback | null = null;
  public onGameOver: OnGameOverCallback | null = null;
  // Keep the wire-efficient flat representation. Expanding every 3 Hz trail
  // snapshot into thousands of short-lived point objects causes GC stalls in
  // long-running mobile WebViews.
  public trailData: Record<string, number[]> = {};

  private pingInterval: number | null = null;
  private smoothedRtt: number = 0;
  private bestRtt: number = Number.POSITIVE_INFINITY;
  private serverClockOffsetMs: number = 0;
  private hasClockSync: boolean = false;
  private inputSeq: number = 0;
  private lastInputSentAt: number = Number.NEGATIVE_INFINITY;
  private lastSentTargetAngle: number = Number.NaN;
  private lastSentBoost: boolean = false;

  async connect(playerName: string): Promise<Room<GameState>> {
    const endpoint = await this.resolveEndpoint();
    if (import.meta.env.DEV) {
      console.log("[GameClient] Connecting to Colyseus endpoint:", endpoint);
    }

    this.client = new Client(endpoint);
    this.room = await this.client.joinOrCreate<GameState>("paper", { name: playerName }, GameState);
    this.localSessionId = this.room.sessionId;
    this.inputSeq = 0;
    this.lastInputSentAt = Number.NEGATIVE_INFINITY;
    this.lastSentTargetAngle = Number.NaN;
    this.lastSentBoost = false;
    this.smoothedRtt = 0;
    this.bestRtt = Number.POSITIVE_INFINITY;
    this.serverClockOffsetMs = 0;
    this.hasClockSync = false;

    if (import.meta.env.DEV) {
      console.log("[GameClient] Joined room successfully. SessionId:", this.localSessionId);
    }

    // Setup message handlers
    this.room.onMessage("full_grid_sync", (msg: FullGridSyncMessage) => {
      if (!this.onGridSync) return;
      try {
        this.onGridSync(decodeGridSync(msg), msg.width, msg.height);
      } catch (error) {
        console.error("[GameClient] Invalid full_grid_sync payload:", error);
      }
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

    this.room.onMessage("trail_sync", (msg: TrailSyncPayload) => {
      // Full packed snapshots are intentionally protocol-compatible with
      // previously deployed servers. Keeping them packed avoids allocating a
      // point object for every coordinate in long-running mobile WebViews.
      this.trailData = applyTrailSync(this.trailData, msg);
    });

    this.room.onMessage("clock_pong", (msg: ClockPongMessage) => {
      this.handleClockPong(msg);
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

  sendInput(targetAngle: number, boost: boolean = false): SentInputSample | null {
    if (!this.room || !Number.isFinite(targetAngle)) return null;

    const normalizedAngle = normalizeAngle(targetAngle);
    const now = performance.now();
    const elapsed = now - this.lastInputSentAt;
    const inputChanged =
      !Number.isFinite(this.lastSentTargetAngle) ||
      angleDistance(this.lastSentTargetAngle, normalizedAngle) >= INPUT_ANGLE_EPSILON ||
      boost !== this.lastSentBoost;
    const sendInterval = inputChanged
      ? CHANGED_INPUT_SEND_INTERVAL_MS
      : INPUT_HEARTBEAT_MS;
    if (elapsed < sendInterval) {
      return null;
    }

    this.inputSeq = (this.inputSeq + 1) >>> 0;
    if (this.inputSeq === 0) this.inputSeq = 1;
    const msg: SentInputSample = {
      targetAngle: normalizedAngle,
      boost,
      seq: this.inputSeq,
      dt: Number.isFinite(elapsed) ? Math.max(0, Math.min(100, elapsed)) : 0,
      clientTime: Date.now(),
    };
    this.room.send("input", msg as InputMessage);
    this.lastInputSentAt = now;
    this.lastSentTargetAngle = normalizedAngle;
    this.lastSentBoost = boost;
    return msg;
  }

  requestRespawn() {
    if (!this.room) return;
    this.room.send("respawn", {});
  }

  private startMetricsReporting() {
    if (this.pingInterval !== null) clearInterval(this.pingInterval);
    this.sendClockPing();
    this.pingInterval = window.setInterval(() => {
      this.sendClockPing();
    }, 2000);
  }

  private sendClockPing() {
    if (!this.room) return;
    this.room.send("clock_ping", { clientTime: Date.now() } as ClockPingMessage);
  }

  private handleClockPong(message: ClockPongMessage) {
    const receivedAt = Date.now();
    const clientTime = Number(message.clientTime);
    const serverTime = Number(message.serverTime);
    if (!Number.isFinite(clientTime) || !Number.isFinite(serverTime)) return;

    const rtt = receivedAt - clientTime;
    if (rtt < 0 || rtt > 10_000) return;

    const offsetSample = serverTime - (clientTime + rtt / 2);
    if (!this.hasClockSync) {
      this.serverClockOffsetMs = offsetSample;
      this.bestRtt = rtt;
      this.hasClockSync = true;
    } else if (rtt <= this.bestRtt + 12) {
      const weight = rtt < this.bestRtt ? 0.35 : 0.12;
      this.serverClockOffsetMs += (offsetSample - this.serverClockOffsetMs) * weight;
      this.bestRtt = Math.min(this.bestRtt, rtt);
    }

    this.smoothedRtt = this.smoothedRtt === 0 ? rtt : this.smoothedRtt * 0.8 + rtt * 0.2;
    try {
      this.room?.send("__runner_metrics", { latency: Math.round(this.smoothedRtt) });
    } catch {
      // Runner metrics are advisory and must never interrupt gameplay.
    }
  }

  getServerClockOffsetMs(): number {
    return this.serverClockOffsetMs;
  }

  getSmoothedRttMs(): number {
    return this.smoothedRtt;
  }

  getEstimatedServerTime(clientTime: number = Date.now()): number {
    return clientTime + this.serverClockOffsetMs;
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
    if (this.pingInterval !== null) clearInterval(this.pingInterval);
    this.pingInterval = null;
    if (this.room) {
      this.room.leave();
      this.room = null;
    }
    this.trailData = {};
    this.localSessionId = "";
    this.inputSeq = 0;
    this.lastInputSentAt = Number.NEGATIVE_INFINITY;
    this.lastSentTargetAngle = Number.NaN;
    this.lastSentBoost = false;
    this.smoothedRtt = 0;
    this.bestRtt = Number.POSITIVE_INFINITY;
    this.serverClockOffsetMs = 0;
    this.hasClockSync = false;
  }
}
