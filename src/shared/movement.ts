export interface MutableTurningPose {
  x: number;
  y: number;
  angle: number;
}

function normalizeAngle(angle: number): number {
  let normalized = (angle + Math.PI) % (Math.PI * 2);
  if (normalized < 0) normalized += Math.PI * 2;
  return normalized - Math.PI;
}

/**
 * Integrates a constant-speed turn as an exact circular arc. The result is
 * independent of whether the same duration is split across 30, 60 or 120 Hz.
 */
export function advanceTurningPose(
  pose: MutableTurningPose,
  targetAngle: number,
  speed: number,
  turnSpeed: number,
  durationSeconds: number
) {
  const duration = Math.max(0, durationSeconds);
  if (duration === 0) return;

  const target = normalizeAngle(targetAngle);
  const difference = normalizeAngle(target - pose.angle);
  if (Math.abs(difference) < 1e-8) {
    pose.angle = target;
    pose.x += Math.cos(pose.angle) * speed * duration;
    pose.y += Math.sin(pose.angle) * speed * duration;
    return;
  }
  if (turnSpeed <= 0) {
    pose.x += Math.cos(pose.angle) * speed * duration;
    pose.y += Math.sin(pose.angle) * speed * duration;
    return;
  }

  const direction = Math.sign(difference);
  const angularVelocity = direction * turnSpeed;
  const turnDuration = Math.min(duration, Math.abs(difference) / turnSpeed);
  const startAngle = pose.angle;
  const endAngle = startAngle + angularVelocity * turnDuration;
  const radius = speed / angularVelocity;

  pose.x += radius * (Math.sin(endAngle) - Math.sin(startAngle));
  pose.y += radius * (Math.cos(startAngle) - Math.cos(endAngle));
  pose.angle = turnDuration < duration ? target : normalizeAngle(endAngle);

  const straightDuration = duration - turnDuration;
  if (straightDuration > 0) {
    pose.x += Math.cos(pose.angle) * speed * straightDuration;
    pose.y += Math.sin(pose.angle) * speed * straightDuration;
  }
}
