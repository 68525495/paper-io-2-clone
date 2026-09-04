import { constrainPointToArena } from "../shared/arenaShape.js";
import { PLAYER_RADIUS, PLAYER_TURN_SPEED } from "../shared/constants.js";
import { advanceTurningPose } from "../shared/movement.js";
import type { GameState, PlayerState } from "../shared/schema.js";

interface LocalInputSample {
  targetAngle: number;
  boost: boolean;
  seq: number;
  dt: number;
  clientTime: number;
}

export interface RenderPose {
  x: number;
  y: number;
  angle: number;
}

interface PlayerSnapshot extends RenderPose {
  vx: number;
  vy: number;
  targetAngle: number;
  speed: number;
  alive: boolean;
  lifeId: number;
  lastProcessedInputSeq: number;
  serverTick: number;
  serverTime: number;
}

interface LocalPrediction extends RenderPose {
  speed: number;
  alive: boolean;
  lifeId: number;
  visualOffsetX: number;
  visualOffsetY: number;
  lastFrameTime: number;
  lastReconciledTick: number;
  lastReconciledServerTime: number;
}

const REMOTE_INTERPOLATION_DELAY_MS = 100;
const MAX_REMOTE_EXTRAPOLATION_MS = 100;
const MAX_LOCAL_PROJECTION_MS = 150;
const LOCAL_POSITION_DEAD_ZONE = 0.12;
const LOCAL_CORRECTION_RATE = 10;
const LOCAL_MAX_CORRECTION_SPEED = 2.5;
const LOCAL_HARD_SNAP_DISTANCE = 8;
const MAX_SNAPSHOTS_PER_PLAYER = 32;
const MAX_INPUT_HISTORY = 96;

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeAngle(angle: number): number {
  let normalized = (angle + Math.PI) % (Math.PI * 2);
  if (normalized < 0) normalized += Math.PI * 2;
  return normalized - Math.PI;
}

function angleDifference(from: number, to: number): number {
  return normalizeAngle(to - from);
}

function stepAngle(current: number, target: number, maxStep: number): number {
  const difference = angleDifference(current, target);
  if (Math.abs(difference) <= maxStep) return normalizeAngle(target);
  return normalizeAngle(current + Math.sign(difference) * maxStep);
}

function interpolateAngle(from: number, to: number, amount: number): number {
  return normalizeAngle(from + angleDifference(from, to) * amount);
}

function advancePredictedPose(
  pose: RenderPose,
  targetAngle: number,
  speed: number,
  durationSeconds: number
) {
  advanceTurningPose(
    pose,
    targetAngle,
    speed,
    PLAYER_TURN_SPEED,
    durationSeconds
  );
  const constrained = constrainPointToArena(pose.x, pose.y, PLAYER_RADIUS);
  pose.x = constrained.x;
  pose.y = constrained.y;
}

/**
 * Converts low-frequency authoritative state into a per-render-frame pose.
 * Local movement is predicted and reconciled; remote movement is sampled from
 * a short server-time snapshot buffer. Gameplay remains server-authoritative.
 */
export class MovementSynchronizer {
  private snapshots = new Map<string, PlayerSnapshot[]>();
  private localPlayerId = "";
  private localTargetAngle = 0;
  private localPrediction: LocalPrediction | null = null;
  private localInputHistory: LocalInputSample[] = [];
  private serverClockOffsetMs = 0;
  private roundTripTimeMs = 0;

  setLocalPlayer(playerId: string) {
    if (playerId === this.localPlayerId) return;
    this.localPlayerId = playerId;
    this.localPrediction = null;
    this.localInputHistory = [];
  }

  setLocalInput(targetAngle: number) {
    if (Number.isFinite(targetAngle)) {
      this.localTargetAngle = normalizeAngle(targetAngle);
    }
  }

  recordLocalInput(input: LocalInputSample) {
    if (!Number.isSafeInteger(input.seq) || input.seq <= 0) return;
    this.localTargetAngle = normalizeAngle(input.targetAngle);
    const last = this.localInputHistory[this.localInputHistory.length - 1];
    if (last && input.seq <= last.seq) return;
    this.localInputHistory.push(input);
    if (this.localInputHistory.length > MAX_INPUT_HISTORY) {
      this.localInputHistory.splice(0, this.localInputHistory.length - MAX_INPUT_HISTORY);
    }
  }

  setNetworkTiming(serverClockOffsetMs: number, roundTripTimeMs: number) {
    if (Number.isFinite(serverClockOffsetMs)) {
      this.serverClockOffsetMs = serverClockOffsetMs;
    }
    if (Number.isFinite(roundTripTimeMs)) {
      this.roundTripTimeMs = clamp(roundTripTimeMs, 0, 2000);
    }
  }

  captureState(state: GameState, receivedAt: number = Date.now()) {
    const stateServerTime = finiteOr(state.serverTime, 0);
    const serverTime = stateServerTime > 0 ? stateServerTime : receivedAt + this.serverClockOffsetMs;
    const serverTick = Math.max(0, Math.floor(finiteOr(state.serverTick, 0)));
    const activePlayerIds = new Set<string>();

    state.players.forEach((player, playerId) => {
      activePlayerIds.add(playerId);
      const snapshot = this.createSnapshot(player, serverTick, serverTime);
      let history = this.snapshots.get(playerId);
      if (!history) {
        history = [];
        this.snapshots.set(playerId, history);
      }

      const previous = history[history.length - 1];
      const isNewVersion =
        !previous ||
        snapshot.serverTick > previous.serverTick ||
        snapshot.serverTime > previous.serverTime ||
        snapshot.lifeId !== previous.lifeId ||
        snapshot.alive !== previous.alive;
      if (!isNewVersion) return;

      history.push(snapshot);
      if (history.length > MAX_SNAPSHOTS_PER_PLAYER) {
        history.splice(0, history.length - MAX_SNAPSHOTS_PER_PLAYER);
      }
    });

    this.cleanupRemoved(activePlayerIds);
  }

  getRenderPose(
    playerId: string,
    fallback: PlayerState,
    isLocal: boolean,
    clientTime: number = Date.now(),
    frameTime: number = clientTime
  ): RenderPose {
    const history = this.snapshots.get(playerId);
    const latest = history?.[history.length - 1] ?? this.createSnapshot(
      fallback,
      0,
      clientTime + this.serverClockOffsetMs
    );

    if (isLocal) {
      if (this.localPlayerId !== playerId) this.setLocalPlayer(playerId);
      return this.sampleLocal(latest, clientTime, frameTime);
    }
    return this.sampleRemote(history ?? [latest], clientTime + this.serverClockOffsetMs);
  }

  cleanupRemoved(activePlayers: { has(playerId: string): boolean }) {
    for (const playerId of this.snapshots.keys()) {
      if (!activePlayers.has(playerId)) this.snapshots.delete(playerId);
    }
    if (this.localPlayerId && !activePlayers.has(this.localPlayerId)) {
      this.localPrediction = null;
      this.localInputHistory = [];
    }
  }

  reset() {
    this.snapshots.clear();
    this.localPlayerId = "";
    this.localTargetAngle = 0;
    this.localPrediction = null;
    this.localInputHistory = [];
    this.serverClockOffsetMs = 0;
    this.roundTripTimeMs = 0;
  }

  private createSnapshot(
    player: PlayerState,
    serverTick: number,
    serverTime: number
  ): PlayerSnapshot {
    return {
      x: finiteOr(player.x, 0),
      y: finiteOr(player.y, 0),
      angle: normalizeAngle(finiteOr(player.angle, 0)),
      vx: finiteOr(player.vx, 0),
      vy: finiteOr(player.vy, 0),
      targetAngle: normalizeAngle(finiteOr(player.targetAngle, player.angle)),
      speed: Math.max(0, finiteOr(player.speed, 0)),
      alive: Boolean(player.alive),
      lifeId: Math.max(0, Math.floor(finiteOr(player.lifeId, 0))),
      lastProcessedInputSeq: Math.max(
        0,
        Math.floor(finiteOr(player.lastProcessedInputSeq, 0))
      ),
      serverTick,
      serverTime,
    };
  }

  private sampleRemote(history: PlayerSnapshot[], estimatedServerTime: number): RenderPose {
    const renderTime = estimatedServerTime - REMOTE_INTERPOLATION_DELAY_MS;
    const first = history[0];
    if (history.length === 1 || renderTime <= first.serverTime) {
      return { x: first.x, y: first.y, angle: first.angle };
    }

    for (let index = 1; index < history.length; index++) {
      const newer = history[index];
      if (newer.serverTime < renderTime) continue;
      const older = history[index - 1];
      const intervalMs = newer.serverTime - older.serverTime;
      if (
        intervalMs <= 0 ||
        older.lifeId !== newer.lifeId ||
        older.alive !== newer.alive
      ) {
        return { x: newer.x, y: newer.y, angle: newer.angle };
      }

      const amount = clamp((renderTime - older.serverTime) / intervalMs, 0, 1);
      const intervalSeconds = intervalMs / 1000;
      const amount2 = amount * amount;
      const amount3 = amount2 * amount;
      const h00 = 2 * amount3 - 3 * amount2 + 1;
      const h10 = amount3 - 2 * amount2 + amount;
      const h01 = -2 * amount3 + 3 * amount2;
      const h11 = amount3 - amount2;
      return {
        x:
          h00 * older.x +
          h10 * intervalSeconds * older.vx +
          h01 * newer.x +
          h11 * intervalSeconds * newer.vx,
        y:
          h00 * older.y +
          h10 * intervalSeconds * older.vy +
          h01 * newer.y +
          h11 * intervalSeconds * newer.vy,
        angle: interpolateAngle(older.angle, newer.angle, amount),
      };
    }

    const latest = history[history.length - 1];
    const extrapolationSeconds =
      clamp(renderTime - latest.serverTime, 0, MAX_REMOTE_EXTRAPOLATION_MS) / 1000;
    const projected = {
      x: latest.x + latest.vx * extrapolationSeconds,
      y: latest.y + latest.vy * extrapolationSeconds,
      angle: stepAngle(
        latest.angle,
        latest.targetAngle,
        PLAYER_TURN_SPEED * extrapolationSeconds
      ),
    };
    const constrained = constrainPointToArena(projected.x, projected.y, PLAYER_RADIUS);
    projected.x = constrained.x;
    projected.y = constrained.y;
    return projected;
  }

  private sampleLocal(
    snapshot: PlayerSnapshot,
    clientTime: number,
    frameTime: number
  ): RenderPose {
    if (!this.localPrediction) {
      const projected = this.projectLocalSnapshot(snapshot, clientTime);
      this.localPrediction = {
        ...projected,
        speed: snapshot.speed,
        alive: snapshot.alive,
        lifeId: snapshot.lifeId,
        visualOffsetX: 0,
        visualOffsetY: 0,
        lastFrameTime: frameTime,
        lastReconciledTick: snapshot.serverTick,
        lastReconciledServerTime: snapshot.serverTime,
      };
    } else {
      this.advanceLocalPrediction(frameTime);
      const prediction = this.localPrediction;
      const hasNewSnapshot =
        snapshot.serverTick > prediction.lastReconciledTick ||
        snapshot.serverTime > prediction.lastReconciledServerTime ||
        snapshot.lifeId !== prediction.lifeId ||
        snapshot.alive !== prediction.alive;
      if (hasNewSnapshot) {
        this.reconcileLocalPrediction(snapshot, clientTime, frameTime);
      }
    }

    const prediction = this.localPrediction;
    return {
      x: prediction.x + prediction.visualOffsetX,
      y: prediction.y + prediction.visualOffsetY,
      angle: prediction.angle,
    };
  }

  private advanceLocalPrediction(frameTime: number) {
    const prediction = this.localPrediction;
    if (!prediction) return;
    const elapsedSeconds = clamp(
      (frameTime - prediction.lastFrameTime) / 1000,
      0,
      0.1
    );
    if (prediction.alive && elapsedSeconds > 0) {
      advancePredictedPose(
        prediction,
        this.localTargetAngle,
        prediction.speed,
        elapsedSeconds
      );
    }
    const offsetLength = Math.hypot(
      prediction.visualOffsetX,
      prediction.visualOffsetY
    );
    if (offsetLength > 1e-8) {
      const exponentialRemoval =
        offsetLength * (1 - Math.exp(-LOCAL_CORRECTION_RATE * elapsedSeconds));
      const removal = Math.min(
        offsetLength,
        exponentialRemoval,
        LOCAL_MAX_CORRECTION_SPEED * elapsedSeconds
      );
      const remainingScale = (offsetLength - removal) / offsetLength;
      prediction.visualOffsetX *= remainingScale;
      prediction.visualOffsetY *= remainingScale;
    }
    prediction.lastFrameTime = frameTime;
  }

  private reconcileLocalPrediction(
    snapshot: PlayerSnapshot,
    clientTime: number,
    frameTime: number
  ) {
    const prediction = this.localPrediction;
    if (!prediction) return;

    const oldVisualX = prediction.x + prediction.visualOffsetX;
    const oldVisualY = prediction.y + prediction.visualOffsetY;
    const oldLocalAngle = prediction.angle;
    const projected = this.projectLocalSnapshot(snapshot, clientTime);
    const distance = Math.hypot(
      projected.x - oldVisualX,
      projected.y - oldVisualY
    );
    const mustSnap =
      snapshot.lifeId !== prediction.lifeId ||
      snapshot.alive !== prediction.alive ||
      distance > LOCAL_HARD_SNAP_DISTANCE;

    if (mustSnap) {
      prediction.x = projected.x;
      prediction.y = projected.y;
      prediction.angle = projected.angle;
      prediction.visualOffsetX = 0;
      prediction.visualOffsetY = 0;
    } else {
      // Ignore visually tiny errors instead of injecting a correction pulse on
      // every state patch. Drift is still bounded because accumulated error is
      // reconciled as soon as it leaves this sub-pixel-scale dead zone.
      if (distance > LOCAL_POSITION_DEAD_ZONE) {
        prediction.x = projected.x;
        prediction.y = projected.y;
        prediction.visualOffsetX = oldVisualX - projected.x;
        prediction.visualOffsetY = oldVisualY - projected.y;
      }
      // Local heading follows the latest joystick rather than a delayed patch.
      prediction.angle = oldLocalAngle;
    }
    prediction.speed = snapshot.speed;
    prediction.alive = snapshot.alive;
    prediction.lifeId = snapshot.lifeId;
    prediction.lastFrameTime = frameTime;
    prediction.lastReconciledTick = snapshot.serverTick;
    prediction.lastReconciledServerTime = snapshot.serverTime;

    this.localInputHistory = this.localInputHistory.filter(
      (input) => input.seq > snapshot.lastProcessedInputSeq
    );
  }

  private projectLocalSnapshot(snapshot: PlayerSnapshot, clientTime: number): RenderPose {
    const projected: RenderPose = {
      x: snapshot.x,
      y: snapshot.y,
      angle: snapshot.angle,
    };
    if (!snapshot.alive) return projected;

    const estimatedServerTime = clientTime + this.serverClockOffsetMs;
    const projectionEnd = Math.max(
      snapshot.serverTime,
      Math.min(estimatedServerTime, snapshot.serverTime + MAX_LOCAL_PROJECTION_MS)
    );
    let cursor = snapshot.serverTime;
    let activeTargetAngle = snapshot.targetAngle;
    const estimatedOneWayDelay = this.roundTripTimeMs / 2;

    for (const input of this.localInputHistory) {
      if (input.seq <= snapshot.lastProcessedInputSeq) continue;
      const estimatedArrival =
        input.clientTime + this.serverClockOffsetMs + estimatedOneWayDelay;
      if (estimatedArrival > projectionEnd) continue;
      const inputTime = clamp(estimatedArrival, cursor, projectionEnd);
      advancePredictedPose(
        projected,
        activeTargetAngle,
        snapshot.speed,
        (inputTime - cursor) / 1000
      );
      activeTargetAngle = normalizeAngle(input.targetAngle);
      cursor = inputTime;
    }

    advancePredictedPose(
      projected,
      activeTargetAngle,
      snapshot.speed,
      (projectionEnd - cursor) / 1000
    );
    return projected;
  }
}
