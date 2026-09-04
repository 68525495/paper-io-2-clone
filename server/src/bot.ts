import {
  CELL_SIZE,
  PLAYER_RADIUS,
  PLAYER_SPEED,
  PLAYER_TURN_SPEED,
  TRAIL_RADIUS,
  TRAIL_SELF_HIT_SAFE_SEGMENTS,
} from "./constants.js";
import { arenaBoundaryClearance } from "./arenaShape.js";
import {
  angleDiff,
  distToSegmentSq,
  normalizeAngle,
  stepAngle,
  worldToGrid,
} from "./geometry.js";
import { PlayerState, TrailPoint } from "./schema.js";
import { TerritoryGrid } from "./territory.js";

export enum BotBehavior {
  PATROL_HOME = "patrol_home",
  SEEK_EXIT = "seek_exit",
  EXPAND = "expand",
  RETURN_HOME = "return_home",
  INTERCEPT = "intercept",
  EVADE = "evade",
  RECOVER = "recover",
}

export interface BotDecision {
  targetAngle: number;
  boost: boolean;
}

interface BotPersonality {
  aggression: number;
  greed: number;
  caution: number;
  precision: number;
  persistence: number;
  perceptionRadius: number;
  decisionInterval: number;
  mistakeChance: number;
}

interface InterceptTarget {
  playerId: string;
  x: number;
  y: number;
  score: number;
  expiresAt: number;
}

interface ScoredAngle {
  angle: number;
  score: number;
}

const FULL_TURN = Math.PI * 2;
const BOT_THINK_HZ = 8;
const STATE_LOCK_MIN = 0.4;
const STATE_LOCK_MAX = 0.8;
const INTERCEPT_LOCK_SECONDS = 0.55;
const MAX_OUTSIDE_SECONDS = 4.5;
const STEERING_HORIZON_SECONDS = 0.9;
const STEERING_STEP_SECONDS = 0.1;
const COLLISION_PADDING = 0.25;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function distanceSq(x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  return dx * dx + dy * dy;
}

function trailLength(trail: TrailPoint[]): number {
  let total = 0;
  for (let index = 1; index < trail.length; index++) {
    total += Math.hypot(
      trail[index].x - trail[index - 1].x,
      trail[index].y - trail[index - 1].y
    );
  }
  return total;
}

function closestPointOnSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): { x: number; y: number; distanceSq: number } {
  const abX = bx - ax;
  const abY = by - ay;
  const lengthSq = abX * abX + abY * abY;
  const t = lengthSq > 0
    ? clamp01(((px - ax) * abX + (py - ay) * abY) / lengthSq)
    : 0;
  const x = ax + abX * t;
  const y = ay + abY * t;
  return { x, y, distanceSq: distanceSq(px, py, x, y) };
}

function hashSeed(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0 || 1;
}

class SeededRandom {
  constructor(private state: number) {}

  next(): number {
    this.state += 0x6d2b79f5;
    let value = this.state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }
}

/**
 * Server-side Bot brain. It produces only the same target-angle input a human
 * can send; movement, collisions, captures and scores remain authoritative in
 * PaperRoom.
 */
export class BotController {
  readonly playerId: string;

  private readonly random: SeededRandom;
  private readonly personality: BotPersonality;
  private state = BotBehavior.PATROL_HOME;
  private stateAge = 0;
  private stateLockRemaining = 0;
  private thinkAccumulator = 0;
  private elapsedTime = 0;
  private outsideAge = 0;
  private wasInHome = true;
  private enteredHomeSinceLastDecision = false;
  private initialized = false;

  private homeBaseX: number;
  private homeBaseY: number;
  private chosenAngle = 0;
  private currentDecision: BotDecision = { targetAngle: 0, boost: false };
  private expansionStartAngle = 0;
  private expansionTurnSign = 1;
  private targetTrailLength = 16;
  private interceptTarget: InterceptTarget | null = null;

  constructor(playerId: string, startX: number, startY: number) {
    this.playerId = playerId;
    this.homeBaseX = startX;
    this.homeBaseY = startY;
    this.random = new SeededRandom(
      hashSeed(`${playerId}:${Math.round(startX * 10)}:${Math.round(startY * 10)}`)
    );

    const aggression = this.random.range(0.2, 0.9);
    const greed = this.random.range(0.25, 0.9);
    const caution = this.random.range(0.3, 0.95);
    const precision = this.random.range(0.65, 0.95);
    const persistence = this.random.range(0.4, 0.95);
    this.personality = {
      aggression,
      greed,
      caution,
      precision,
      persistence,
      perceptionRadius: 22 + precision * 6,
      decisionInterval: (1 / BOT_THINK_HZ) + (1 - precision) * 0.12,
      mistakeChance: 0.05 + (1 - precision) * 0.2,
    };
    // Stagger brains so all bots do not perform strategic work on one tick.
    this.thinkAccumulator = this.random.range(0, this.personality.decisionInterval);
  }

  update(
    botPlayer: PlayerState,
    allPlayers: Map<string, PlayerState>,
    grid: TerritoryGrid,
    dt: number,
    playerTrails: Map<string, TrailPoint[]>
  ): BotDecision {
    const safeDt = Math.max(0, Math.min(dt, 0.1));
    this.elapsedTime += safeDt;
    this.stateAge += safeDt;
    this.stateLockRemaining = Math.max(0, this.stateLockRemaining - safeDt);
    this.thinkAccumulator += safeDt;

    if (!this.initialized) {
      this.initialized = true;
      this.chosenAngle = normalizeAngle(botPlayer.angle);
      this.currentDecision = { targetAngle: this.chosenAngle, boost: false };
    }

    const myTrail = playerTrails.get(this.playerId) || [];
    const inHome = grid.isOwnTerritory(this.playerId, botPlayer.x, botPlayer.y);
    if (inHome && !this.wasInHome) this.enteredHomeSinceLastDecision = true;
    this.wasInHome = inHome;
    this.outsideAge = inHome ? 0 : this.outsideAge + safeDt;
    if (this.hasImmediateHazard(botPlayer, myTrail)) {
      this.transition(BotBehavior.EVADE, 0.25, true);
      const centerAngle = Math.atan2(-botPlayer.y, -botPlayer.x);
      const safeAngle = this.chooseSafeSteering(
        centerAngle,
        botPlayer,
        myTrail,
        BotBehavior.EVADE
      );
      this.currentDecision = { targetAngle: safeAngle, boost: false };
      return this.currentDecision;
    }

    if (this.thinkAccumulator < this.personality.decisionInterval) {
      return this.currentDecision;
    }
    this.thinkAccumulator %= this.personality.decisionInterval;

    const desiredAngle = this.chooseIntentAngle(
      botPlayer,
      allPlayers,
      grid,
      myTrail,
      playerTrails
    );
    this.enteredHomeSinceLastDecision = false;
    const safeAngle = this.chooseSafeSteering(
      desiredAngle,
      botPlayer,
      myTrail,
      this.state
    );
    this.chosenAngle = safeAngle;
    this.currentDecision = { targetAngle: safeAngle, boost: false };
    return this.currentDecision;
  }

  reset(startX: number, startY: number, initialAngle: number) {
    this.homeBaseX = startX;
    this.homeBaseY = startY;
    this.state = BotBehavior.PATROL_HOME;
    this.stateAge = 0;
    this.stateLockRemaining = 0;
    this.thinkAccumulator = this.random.range(0, this.personality.decisionInterval);
    this.elapsedTime = 0;
    this.outsideAge = 0;
    this.wasInHome = true;
    this.enteredHomeSinceLastDecision = false;
    this.initialized = true;
    this.chosenAngle = normalizeAngle(initialAngle);
    this.currentDecision = { targetAngle: this.chosenAngle, boost: false };
    this.interceptTarget = null;
  }

  setHome(x: number, y: number) {
    this.homeBaseX = x;
    this.homeBaseY = y;
  }

  getDebugState() {
    return {
      behavior: this.state,
      targetAngle: this.currentDecision.targetAngle,
      targetTrailLength: this.targetTrailLength,
      personality: { ...this.personality },
    };
  }

  private chooseIntentAngle(
    botPlayer: PlayerState,
    allPlayers: Map<string, PlayerState>,
    grid: TerritoryGrid,
    myTrail: TrailPoint[],
    playerTrails: Map<string, TrailPoint[]>
  ): number {
    const inHome = grid.isOwnTerritory(this.playerId, botPlayer.x, botPlayer.y);

    if (inHome) {
      if (
        this.enteredHomeSinceLastDecision &&
        (
          this.state === BotBehavior.RETURN_HOME ||
          this.state === BotBehavior.EXPAND ||
          this.state === BotBehavior.INTERCEPT ||
          this.state === BotBehavior.EVADE
        )
      ) {
        this.interceptTarget = null;
        this.transition(BotBehavior.RECOVER, 0.25, true);
      }

      if (this.state === BotBehavior.EVADE) {
        if (this.stateLockRemaining > 0) return this.currentDecision.targetAngle;
        this.transition(BotBehavior.RECOVER, 0.25, true);
      }

      if (this.state === BotBehavior.INTERCEPT) {
        const refreshed = this.refreshLockedIntercept(
          botPlayer,
          allPlayers,
          grid,
          playerTrails
        );
        if (refreshed) {
          return Math.atan2(
            refreshed.y - botPlayer.y,
            refreshed.x - botPlayer.x
          );
        }
        this.interceptTarget = null;
        this.transition(BotBehavior.RECOVER, 0.25, true);
      }

      const hunt = this.findBestIntercept(
        botPlayer,
        allPlayers,
        grid,
        playerTrails
      );
      if (
        hunt &&
        this.stateLockRemaining <= 0 &&
        this.random.next() < this.personality.aggression * 0.45
      ) {
        this.interceptTarget = hunt;
        this.transition(
          BotBehavior.INTERCEPT,
          INTERCEPT_LOCK_SECONDS + this.personality.persistence * 0.35
        );
        return Math.atan2(hunt.y - botPlayer.y, hunt.x - botPlayer.x);
      }

      if (this.state === BotBehavior.RECOVER && this.stateLockRemaining > 0) {
        return this.chosenAngle;
      }

      if (this.state !== BotBehavior.SEEK_EXIT || this.stateAge > 2.5) {
        this.expansionStartAngle = this.chooseExpansionExitAngle(
          botPlayer,
          allPlayers,
          grid
        );
        this.expansionTurnSign = this.random.next() < 0.5 ? -1 : 1;
        this.targetTrailLength = this.random.range(
          11 + this.personality.caution * 2,
          18 + this.personality.greed * 18
        );
        this.transition(
          BotBehavior.SEEK_EXIT,
          this.random.range(STATE_LOCK_MIN, STATE_LOCK_MAX),
          true
        );
        // A same-state replan starts a fresh route window. Without resetting
        // this age, every later think would immediately replan again.
        this.stateAge = 0;
      }
      return this.expansionStartAngle;
    }

    if (
      this.state === BotBehavior.PATROL_HOME ||
      this.state === BotBehavior.SEEK_EXIT ||
      this.state === BotBehavior.RECOVER
    ) {
      this.expansionStartAngle = normalizeAngle(botPlayer.angle);
      this.transition(
        BotBehavior.EXPAND,
        this.random.range(STATE_LOCK_MIN, STATE_LOCK_MAX),
        true
      );
    }

    const currentTrailLength = trailLength(myTrail);
    const returnTarget = grid.findNearestOwnedBoundary(
      this.playerId,
      botPlayer.x,
      botPlayer.y
    );
    const returnEta = returnTarget
      ? returnTarget.distance / Math.max(1, botPlayer.speed || PLAYER_SPEED)
      : Number.POSITIVE_INFINITY;
    const threatened = this.isTrailThreatened(
      botPlayer,
      allPlayers,
      myTrail,
      returnEta
    );

    if (
      threatened ||
      currentTrailLength >= this.targetTrailLength ||
      this.outsideAge >= MAX_OUTSIDE_SECONDS
    ) {
      this.interceptTarget = null;
      this.transition(BotBehavior.RETURN_HOME, 0.35, true);
    }

    if (this.state === BotBehavior.EVADE && this.stateLockRemaining <= 0) {
      this.transition(BotBehavior.RETURN_HOME, 0.35, true);
    }

    if (this.state === BotBehavior.EVADE) {
      return this.currentDecision.targetAngle;
    }

    if (this.state === BotBehavior.RETURN_HOME) {
      if (returnTarget) {
        return Math.atan2(
          returnTarget.y - botPlayer.y,
          returnTarget.x - botPlayer.x
        );
      }
      return Math.atan2(this.homeBaseY - botPlayer.y, this.homeBaseX - botPlayer.x);
    }

    if (this.state === BotBehavior.INTERCEPT) {
      const refreshed = this.refreshLockedIntercept(
        botPlayer,
        allPlayers,
        grid,
        playerTrails
      );
      if (refreshed) {
        return Math.atan2(
          refreshed.y - botPlayer.y,
          refreshed.x - botPlayer.x
        );
      }
      this.interceptTarget = null;
      this.transition(BotBehavior.RETURN_HOME, 0.35, true);
      return returnTarget
        ? Math.atan2(returnTarget.y - botPlayer.y, returnTarget.x - botPlayer.x)
        : Math.atan2(this.homeBaseY - botPlayer.y, this.homeBaseX - botPlayer.x);
    }

    if (this.stateLockRemaining <= 0) {
      const hunt = this.findBestIntercept(
        botPlayer,
        allPlayers,
        grid,
        playerTrails
      );
      if (hunt && this.random.next() < this.personality.aggression) {
        this.interceptTarget = hunt;
        this.transition(
          BotBehavior.INTERCEPT,
          INTERCEPT_LOCK_SECONDS + this.personality.persistence * 0.35
        );
        return Math.atan2(hunt.y - botPlayer.y, hunt.x - botPlayer.x);
      }
    }

    const progress = currentTrailLength / Math.max(1, this.targetTrailLength);
    if (progress < 0.38) return this.expansionStartAngle;
    if (progress < 0.72) {
      return normalizeAngle(
        this.expansionStartAngle + this.expansionTurnSign * Math.PI * 0.52
      );
    }

    this.transition(BotBehavior.RETURN_HOME, 0.35, true);
    return returnTarget
      ? Math.atan2(returnTarget.y - botPlayer.y, returnTarget.x - botPlayer.x)
      : Math.atan2(this.homeBaseY - botPlayer.y, this.homeBaseX - botPlayer.x);
  }

  private chooseExpansionExitAngle(
    botPlayer: PlayerState,
    allPlayers: Map<string, PlayerState>,
    grid: TerritoryGrid
  ): number {
    const ownerIndex = grid.getPlayerIndex(this.playerId);
    const candidates: ScoredAngle[] = [];
    const candidateCount = 12;

    for (let index = 0; index < candidateCount; index++) {
      const angle = -Math.PI + (index / candidateCount) * FULL_TURN;
      let score = -Math.abs(angleDiff(botPlayer.angle, angle)) * 0.6;
      let leftHome = false;
      let edgePenalty = 0;

      for (let distance = CELL_SIZE * 2; distance <= 32; distance += CELL_SIZE * 2) {
        const x = botPlayer.x + Math.cos(angle) * distance;
        const y = botPlayer.y + Math.sin(angle) * distance;
        const edgeClearance = arenaBoundaryClearance(x, y);
        if (edgeClearance <= PLAYER_RADIUS + 2) {
          edgePenalty += 30;
          break;
        }

        const cell = worldToGrid(x, y);
        const owner = grid.getCell(cell.gx, cell.gy);
        if (owner !== ownerIndex) {
          leftHome = true;
          score += owner === 0 ? 1.2 : 1.6;
        } else if (leftHome) {
          score += 0.2;
        }

        for (const [id, other] of allPlayers) {
          if (id === this.playerId || !other.alive) continue;
          const dSq = distanceSq(x, y, other.x, other.y);
          const cautionRadius = 8 + this.personality.caution * 8;
          if (dSq < cautionRadius * cautionRadius) {
            score -= (1 - Math.sqrt(dSq) / cautionRadius) * 2.5;
          }
        }
      }

      if (!leftHome) score -= 5;
      score -= edgePenalty;
      score += this.random.range(-0.18, 0.18);
      candidates.push({ angle, score });
    }

    candidates.sort((a, b) => b.score - a.score || a.angle - b.angle);
    const chooseSecond =
      candidates.length > 1 && this.random.next() < this.personality.mistakeChance;
    const selected = candidates[chooseSecond ? 1 : 0];
    const planError = (1 - this.personality.precision) * 0.14;
    return normalizeAngle(
      (selected?.angle ?? botPlayer.angle) + this.random.range(-planError, planError)
    );
  }

  private findBestIntercept(
    botPlayer: PlayerState,
    allPlayers: Map<string, PlayerState>,
    grid: TerritoryGrid,
    playerTrails: Map<string, TrailPoint[]>
  ): InterceptTarget | null {
    let best: InterceptTarget | null = null;
    const perceptionSq = this.personality.perceptionRadius ** 2;
    const botSpeed = Math.max(1, botPlayer.speed || PLAYER_SPEED);

    for (const [otherId, other] of allPlayers) {
      if (
        otherId === this.playerId ||
        !other.alive ||
        grid.isOwnTerritory(otherId, other.x, other.y)
      ) continue;
      const trail = playerTrails.get(otherId) || [];
      if (trail.length < 2) continue;
      let closest: { x: number; y: number; distanceSq: number } | null = null;
      for (let index = 0; index < trail.length - 1; index++) {
        const point = closestPointOnSegment(
          botPlayer.x,
          botPlayer.y,
          trail[index].x,
          trail[index].y,
          trail[index + 1].x,
          trail[index + 1].y
        );
        if (!closest || point.distanceSq < closest.distanceSq) closest = point;
      }
      // Perception is based on the visible trail segment, not the remote
      // owner's head. A long exposed trail can pass right beside the Bot while
      // its owner is already outside the local sensing radius.
      if (!closest || closest.distanceSq > perceptionSq) continue;

      const home = grid.findNearestOwnedBoundary(otherId, other.x, other.y);
      if (!home) continue;
      const interceptAngle = Math.atan2(
        closest.y - botPlayer.y,
        closest.x - botPlayer.x
      );
      const turnSeconds =
        Math.abs(angleDiff(botPlayer.angle, interceptAngle)) / PLAYER_TURN_SPEED;
      const attackEta = Math.sqrt(closest.distanceSq) / botSpeed + turnSeconds;
      const enemyEta = home.distance / Math.max(1, other.speed || PLAYER_SPEED);
      const safetyMargin = 0.15 + this.personality.caution * 0.2;
      const advantage = enemyEta - attackEta - safetyMargin;
      if (advantage <= 0) continue;

      const score = advantage * (1 + this.personality.aggression);
      if (
        !best ||
        score > best.score + 1e-9 ||
        (Math.abs(score - best.score) <= 1e-9 && otherId < best.playerId)
      ) {
        best = {
          playerId: otherId,
          x: closest.x,
          y: closest.y,
          score,
          expiresAt:
            this.elapsedTime +
            INTERCEPT_LOCK_SECONDS +
            this.personality.persistence * 0.35,
        };
      }
    }

    return best;
  }

  private refreshLockedIntercept(
    botPlayer: PlayerState,
    allPlayers: Map<string, PlayerState>,
    grid: TerritoryGrid,
    playerTrails: Map<string, TrailPoint[]>
  ): InterceptTarget | null {
    const locked = this.interceptTarget;
    if (!locked) return null;
    const target = allPlayers.get(locked.playerId);
    if (
      !target ||
      !target.alive ||
      grid.isOwnTerritory(locked.playerId, target.x, target.y)
    ) return null;

    if (this.elapsedTime < locked.expiresAt) return locked;

    const refreshed = this.findBestIntercept(
      botPlayer,
      new Map([[locked.playerId, target]]),
      grid,
      playerTrails
    );
    if (!refreshed) return null;
    this.interceptTarget = refreshed;
    return refreshed;
  }

  private isTrailThreatened(
    botPlayer: PlayerState,
    allPlayers: Map<string, PlayerState>,
    myTrail: TrailPoint[],
    returnEta: number
  ): boolean {
    if (myTrail.length < 2 || !Number.isFinite(returnEta)) return false;
    const perceptionSq = this.personality.perceptionRadius ** 2;
    let enemyEta = Number.POSITIVE_INFINITY;

    for (const [id, other] of allPlayers) {
      if (id === this.playerId || !other.alive) continue;
      if (distanceSq(botPlayer.x, botPlayer.y, other.x, other.y) > perceptionSq) continue;

      let nearestSq = Number.POSITIVE_INFINITY;
      for (let index = 0; index < myTrail.length - 1; index++) {
        nearestSq = Math.min(
          nearestSq,
          distToSegmentSq(
            other.x,
            other.y,
            myTrail[index].x,
            myTrail[index].y,
            myTrail[index + 1].x,
            myTrail[index + 1].y
          )
        );
      }
      enemyEta = Math.min(
        enemyEta,
        Math.sqrt(nearestSq) / Math.max(1, other.speed || PLAYER_SPEED)
      );
    }

    const safetyMargin = 0.25 + this.personality.caution * 0.45;
    return enemyEta < returnEta + safetyMargin;
  }

  private hasImmediateHazard(botPlayer: PlayerState, myTrail: TrailPoint[]): boolean {
    const lookAhead = 0.35;
    const moveSpeed = Math.max(1, botPlayer.speed || PLAYER_SPEED);
    const x = botPlayer.x + Math.cos(botPlayer.angle) * moveSpeed * lookAhead;
    const y = botPlayer.y + Math.sin(botPlayer.angle) * moveSpeed * lookAhead;
    if (arenaBoundaryClearance(x, y) <= PLAYER_RADIUS + 1.5) return true;

    const unsafeSq = (PLAYER_RADIUS + TRAIL_RADIUS + COLLISION_PADDING) ** 2;
    const segmentLimit = myTrail.length - TRAIL_SELF_HIT_SAFE_SEGMENTS - 1;
    for (let index = 0; index < segmentLimit; index++) {
      if (
        distToSegmentSq(
          x,
          y,
          myTrail[index].x,
          myTrail[index].y,
          myTrail[index + 1].x,
          myTrail[index + 1].y
        ) <= unsafeSq
      ) {
        return true;
      }
    }
    return false;
  }

  private chooseSafeSteering(
    desiredAngle: number,
    botPlayer: PlayerState,
    myTrail: TrailPoint[],
    behavior: BotBehavior
  ): number {
    const offsets = [0, 0.22, -0.22, 0.45, -0.45, 0.75, -0.75, 1.05, -1.05];
    const scored: ScoredAngle[] = [];
    const moveSpeed = Math.max(1, botPlayer.speed || PLAYER_SPEED);

    for (const offset of offsets) {
      const candidate = normalizeAngle(desiredAngle + offset);
      let x = botPlayer.x;
      let y = botPlayer.y;
      let angle = botPlayer.angle;
      let safe = true;
      let clearanceScore = 0;

      for (
        let elapsed = 0;
        elapsed < STEERING_HORIZON_SECONDS;
        elapsed += STEERING_STEP_SECONDS
      ) {
        angle = stepAngle(
          angle,
          candidate,
          PLAYER_TURN_SPEED * STEERING_STEP_SECONDS
        );
        x += Math.cos(angle) * moveSpeed * STEERING_STEP_SECONDS;
        y += Math.sin(angle) * moveSpeed * STEERING_STEP_SECONDS;

        const edgeClearance = arenaBoundaryClearance(x, y);
        if (edgeClearance <= PLAYER_RADIUS + 0.5) {
          safe = false;
          break;
        }
        clearanceScore += Math.min(8, edgeClearance) * 0.01;

        const unsafeSq = (PLAYER_RADIUS + TRAIL_RADIUS + COLLISION_PADDING) ** 2;
        const segmentLimit = myTrail.length - TRAIL_SELF_HIT_SAFE_SEGMENTS - 1;
        for (let index = 0; index < segmentLimit; index++) {
          if (
            distToSegmentSq(
              x,
              y,
              myTrail[index].x,
              myTrail[index].y,
              myTrail[index + 1].x,
              myTrail[index + 1].y
            ) <= unsafeSq
          ) {
            safe = false;
            break;
          }
        }
        if (!safe) break;
      }

      if (!safe) continue;
      const turnPenalty = Math.abs(offset) * (behavior === BotBehavior.EVADE ? 0.25 : 1);
      scored.push({ angle: candidate, score: clearanceScore - turnPenalty });
    }

    scored.sort((a, b) => b.score - a.score || a.angle - b.angle);
    if (scored.length > 0) return scored[0].angle;
    return normalizeAngle(Math.atan2(-botPlayer.y, -botPlayer.x));
  }

  private transition(next: BotBehavior, lockSeconds: number, force = false) {
    if (!force && this.stateLockRemaining > 0) return;
    if (this.state !== next) {
      this.state = next;
      this.stateAge = 0;
    }
    this.stateLockRemaining = Math.max(this.stateLockRemaining, lockSeconds);
  }
}
