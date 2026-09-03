import {
  HALF_ARENA_SIZE,
  TRAIL_SELF_HIT_SAFE_SEGMENTS,
} from "./constants.js";
import { angleDiff, distance, distToSegment } from "./geometry.js";
import { PlayerState, TrailPoint } from "./schema.js";
import { TerritoryGrid } from "./territory.js";

enum BotBehavior {
  EXPAND,
  RETURN_HOME,
  HUNT,
  AVOID_DANGER,
}

export class BotController {
  readonly playerId: string;
  private state: BotBehavior = BotBehavior.EXPAND;
  private stateTimer: number = 0;
  private chosenAngle: number = 0;
  private homeBaseX: number = 0;
  private homeBaseY: number = 0;
  private maxTrailLength: number = 18;

  constructor(playerId: string, startX: number, startY: number) {
    this.playerId = playerId;
    this.homeBaseX = startX;
    this.homeBaseY = startY;
    this.chosenAngle = Math.random() * Math.PI * 2 - Math.PI;
    this.maxTrailLength = 12 + Math.random() * 12; // 12..24 units
  }

  update(
    botPlayer: PlayerState,
    allPlayers: Map<string, PlayerState>,
    grid: TerritoryGrid,
    dt: number,
    playerTrails: Map<string, TrailPoint[]>
  ): { targetAngle: number; boost: boolean } {
    this.stateTimer += dt;

    const botX = botPlayer.x;
    const botY = botPlayer.y;
    const inHome = botPlayer.inTerritory;

    // 1. Boundary check: If close to edge of arena, steer sharply back toward center
    const wallMargin = 12;
    if (
      Math.abs(botX) > HALF_ARENA_SIZE - wallMargin ||
      Math.abs(botY) > HALF_ARENA_SIZE - wallMargin
    ) {
      const angleToCenter = Math.atan2(-botY, -botX);
      return { targetAngle: angleToCenter, boost: false };
    }

    // 2. Hunting Opportunity: Can we cut someone's trail nearby?
    let nearestEnemyTrailPoint: { x: number; y: number; dist: number } | null = null;
    for (const [id, other] of allPlayers) {
      if (id === this.playerId || !other.alive) continue;
      const otherTrail = playerTrails.get(id) || [];
      if (otherTrail.length > 2) {
        for (let i = 0; i < otherTrail.length; i++) {
          const pt = otherTrail[i];
          const d = distance(botX, botY, pt.x, pt.y);
          if (d < 22 && (!nearestEnemyTrailPoint || d < nearestEnemyTrailPoint.dist)) {
            nearestEnemyTrailPoint = { x: pt.x, y: pt.y, dist: d };
          }
        }
      }
    }

    if (nearestEnemyTrailPoint && nearestEnemyTrailPoint.dist < 18) {
      // Steer towards enemy trail to cut it!
      const huntAngle = Math.atan2(
        nearestEnemyTrailPoint.y - botY,
        nearestEnemyTrailPoint.x - botX
      );
      return { targetAngle: huntAngle, boost: nearestEnemyTrailPoint.dist < 10 };
    }

    // 3. Self-trail safety: Avoid turning into own trail
    const myTrail = playerTrails.get(this.playerId) || [];
    if (myTrail.length > TRAIL_SELF_HIT_SAFE_SEGMENTS + 2) {
      for (
        let i = 0;
        i < myTrail.length - TRAIL_SELF_HIT_SAFE_SEGMENTS - 1;
        i++
      ) {
        const p1 = myTrail[i];
        const p2 = myTrail[i + 1];
        const d = distToSegment(botX, botY, p1.x, p1.y, p2.x, p2.y);
        if (d < 3.5) {
          // Dangerous! Steer 90 degrees away
          const segAngle = Math.atan2(p2.y - p1.y, p2.x - p1.x);
          const escapeAngle = segAngle + Math.PI / 2;
          return { targetAngle: escapeAngle, boost: false };
        }
      }
    }

    // 4. State Machine: EXPAND vs RETURN_HOME
    if (inHome) {
      // Inside home territory: pick a direction to venture outside
      this.state = BotBehavior.EXPAND;
      if (this.stateTimer > 1.0) {
        this.stateTimer = 0;
        // Wander slightly outward
        this.chosenAngle += (Math.random() - 0.5) * 1.2;
      }
    } else {
      // Outside home: trail is building up
      const trailCount = myTrail.length;
      if (trailCount > this.maxTrailLength || this.stateTimer > 4.0) {
        this.state = BotBehavior.RETURN_HOME;
      }

      if (this.state === BotBehavior.RETURN_HOME) {
        // Find nearest cell of own territory
        const angleToHome = Math.atan2(this.homeBaseY - botY, this.homeBaseX - botX);
        this.chosenAngle = angleToHome;
      } else {
        // Gently curve while expanding to make a loop
        this.chosenAngle += 0.04;
      }
    }

    // Wrap chosenAngle into [-PI, PI]
    let target = this.chosenAngle % (Math.PI * 2);
    if (target > Math.PI) target -= Math.PI * 2;
    if (target < -Math.PI) target += Math.PI * 2;

    return { targetAngle: target, boost: false };
  }

  setHome(x: number, y: number) {
    this.homeBaseX = x;
    this.homeBaseY = y;
  }
}
