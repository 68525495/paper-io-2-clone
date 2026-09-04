import {
  Color3,
  Mesh,
  Scene,
  StandardMaterial,
  VertexBuffer,
  VertexData,
} from "@babylonjs/core";
import { TRAIL_RADIUS } from "../shared/constants.js";

interface TrailSpinePoint {
  x: number;
  z: number;
}

interface TrailData {
  mesh: Mesh | null;
  spineCapacity: number;
  positions: Float32Array | null;
  tangents: Float32Array | null;
  sideNormals: Float32Array | null;
  presentationSpine: TrailSpinePoint[];
  renderHead: TrailSpinePoint | null;
  networkStart: TrailSpinePoint | null;
  lastNetworkPointCount: number;
  color: string;
}

const PRESENTATION_SAMPLE_SPACING = 0.22;
const TANGENT_SAMPLE_DISTANCE = 0.45;
const MIN_DYNAMIC_SPINE_CAPACITY = 256;
const MIN_SEGMENT_LENGTH = 0.02;
const NETWORK_START_RESET_DISTANCE = TRAIL_RADIUS * 2;
const HEAD_DISCONTINUITY_DISTANCE = 1.5;
const ALTITUDE = 0.08;
const CAP_STEPS = 16;
const CAP_VERTICES_PER_END = CAP_STEPS + 2;

/** Presentation-only smoothing; authoritative trail points remain unchanged. */
function smoothOpenSpine(
  points: TrailSpinePoint[],
  iterations: number
): TrailSpinePoint[] {
  if (points.length < 3 || iterations <= 0) return points;

  let current = points;
  for (let iteration = 0; iteration < iterations; iteration++) {
    const next: TrailSpinePoint[] = [current[0]];
    for (let i = 0; i < current.length - 1; i++) {
      const start = current[i];
      const end = current[i + 1];
      next.push(
        {
          x: start.x * 0.75 + end.x * 0.25,
          z: start.z * 0.75 + end.z * 0.25,
        },
        {
          x: start.x * 0.25 + end.x * 0.75,
          z: start.z * 0.25 + end.z * 0.75,
        }
      );
    }
    next.push(current[current.length - 1]);
    current = next;
  }
  return current;
}

function distanceBetween(a: TrailSpinePoint, b: TrailSpinePoint): number {
  return Math.hypot(b.x - a.x, b.z - a.z);
}

/** Uniformly samples an initial network snapshot once. */
function resampleOpenSpine(
  points: TrailSpinePoint[],
  spacing: number
): TrailSpinePoint[] {
  if (points.length === 0) return [];

  const result: TrailSpinePoint[] = [{ ...points[0] }];
  let distanceUntilNext = spacing;

  for (let i = 1; i < points.length; i++) {
    let segmentStart = points[i - 1];
    const segmentEnd = points[i];
    let dx = segmentEnd.x - segmentStart.x;
    let dz = segmentEnd.z - segmentStart.z;
    let segmentLength = Math.hypot(dx, dz);

    while (segmentLength >= distanceUntilNext && segmentLength > 1e-8) {
      const ratio = distanceUntilNext / segmentLength;
      const sample = {
        x: segmentStart.x + dx * ratio,
        z: segmentStart.z + dz * ratio,
      };
      result.push(sample);
      segmentStart = sample;
      dx = segmentEnd.x - segmentStart.x;
      dz = segmentEnd.z - segmentStart.z;
      segmentLength = Math.hypot(dx, dz);
      distanceUntilNext = spacing;
    }

    distanceUntilNext -= segmentLength;
  }

  const lastPoint = points[points.length - 1];
  const lastSample = result[result.length - 1];
  if (distanceBetween(lastSample, lastPoint) >= MIN_SEGMENT_LENGTH) {
    result.push({ ...lastPoint });
  }
  return result;
}

/**
 * A trail packet can arrive before its matching player-state patch. Clip only
 * the newest few network segments to the rendered head so initialization never
 * creates a short backwards hook.
 */
function clipNetworkSnapshotToHead(
  points: TrailSpinePoint[],
  head: TrailSpinePoint
): TrailSpinePoint[] {
  if (points.length === 0) return [{ ...head }];
  if (points.length === 1) {
    const result = [{ ...points[0] }];
    if (distanceBetween(result[0], head) >= MIN_SEGMENT_LENGTH) {
      result.push({ ...head });
    } else {
      result[0] = { ...head };
    }
    return result;
  }

  const last = points[points.length - 1];
  const previous = points[points.length - 2];
  const lastSegmentX = last.x - previous.x;
  const lastSegmentZ = last.z - previous.z;
  const lastSegmentLength = Math.hypot(lastSegmentX, lastSegmentZ);
  const headProgress = lastSegmentLength > 1e-8
    ? ((head.x - last.x) * lastSegmentX + (head.z - last.z) * lastSegmentZ) / lastSegmentLength
    : 0;

  if (headProgress >= -MIN_SEGMENT_LENGTH) {
    const result = points.map((point) => ({ ...point }));
    if (distanceBetween(result[result.length - 1], head) >= MIN_SEGMENT_LENGTH) {
      result.push({ ...head });
    } else {
      result[result.length - 1] = { ...head };
    }
    return result;
  }

  const searchStart = Math.max(0, points.length - 16);
  let bestSegment = points.length - 2;
  let bestT = 1;
  let bestDistanceSq = Number.POSITIVE_INFINITY;

  for (let i = searchStart; i < points.length - 1; i++) {
    const start = points[i];
    const end = points[i + 1];
    const dx = end.x - start.x;
    const dz = end.z - start.z;
    const lengthSq = dx * dx + dz * dz;
    const t = lengthSq > 1e-8
      ? Math.max(0, Math.min(1, ((head.x - start.x) * dx + (head.z - start.z) * dz) / lengthSq))
      : 0;
    const projectedX = start.x + dx * t;
    const projectedZ = start.z + dz * t;
    const distanceSq = (head.x - projectedX) ** 2 + (head.z - projectedZ) ** 2;

    // Prefer the newest segment when two candidates are effectively equal.
    if (distanceSq <= bestDistanceSq + 1e-8) {
      bestDistanceSq = distanceSq;
      bestSegment = i;
      bestT = t;
    }
  }

  const result = points.slice(0, bestSegment + 1).map((point) => ({ ...point }));
  const segmentStart = points[bestSegment];
  const segmentEnd = points[bestSegment + 1];
  const projected = {
    x: segmentStart.x + (segmentEnd.x - segmentStart.x) * bestT,
    z: segmentStart.z + (segmentEnd.z - segmentStart.z) * bestT,
  };

  if (distanceBetween(result[result.length - 1], projected) >= MIN_SEGMENT_LENGTH) {
    result.push(projected);
  }
  if (distanceBetween(result[result.length - 1], head) >= MIN_SEGMENT_LENGTH) {
    result.push({ ...head });
  } else {
    result[result.length - 1] = { ...head };
  }
  return result;
}

function isForwardHead(spine: TrailSpinePoint[], head: TrailSpinePoint): boolean {
  if (spine.length < 2) return true;

  const last = spine[spine.length - 1];
  const previous = spine[spine.length - 2];
  const segmentX = last.x - previous.x;
  const segmentZ = last.z - previous.z;
  const segmentLength = Math.hypot(segmentX, segmentZ);
  const headX = head.x - last.x;
  const headZ = head.z - last.z;

  // Large corrections are handled as a reset before this function. For normal
  // motion, hold a stale schema head rather than drawing a reversed segment.
  if (segmentLength < 1e-8) return true;
  return (headX * segmentX + headZ * segmentZ) / segmentLength >= -MIN_SEGMENT_LENGTH;
}

/** Adds immutable visual samples without ever reshaping the committed prefix. */
function appendPresentationSamples(
  spine: TrailSpinePoint[],
  head: TrailSpinePoint
): boolean {
  if (spine.length === 0) {
    spine.push({ ...head });
    return true;
  }
  if (!isForwardHead(spine, head)) return false;

  let last = spine[spine.length - 1];
  let dx = head.x - last.x;
  let dz = head.z - last.z;
  let distance = Math.hypot(dx, dz);

  while (distance >= PRESENTATION_SAMPLE_SPACING) {
    const ratio = PRESENTATION_SAMPLE_SPACING / distance;
    last = {
      x: last.x + dx * ratio,
      z: last.z + dz * ratio,
    };
    spine.push(last);
    dx = head.x - last.x;
    dz = head.z - last.z;
    distance = Math.hypot(dx, dz);
  }
  return true;
}

function nextSpineCapacity(required: number): number {
  let capacity = MIN_DYNAMIC_SPINE_CAPACITY;
  while (capacity < required) capacity *= 2;
  return capacity;
}

function writeVertex(
  positions: Float32Array,
  vertexIndex: number,
  x: number,
  y: number,
  z: number
) {
  const offset = vertexIndex * 3;
  positions[offset] = x;
  positions[offset + 1] = y;
  positions[offset + 2] = z;
}

function createStaticIndices(capacity: number): number[] {
  const indices: number[] = [];

  for (let i = 0; i < capacity - 1; i++) {
    const center = i * 3;
    const left = center + 1;
    const right = center + 2;
    const nextCenter = center + 3;
    const nextLeft = center + 4;
    const nextRight = center + 5;

    indices.push(center, nextCenter, nextLeft, center, nextLeft, left);
    indices.push(center, right, nextRight, center, nextRight, nextCenter);
  }

  const tailBase = capacity * 3;
  const headBase = tailBase + CAP_VERTICES_PER_END;
  for (let i = 0; i < CAP_STEPS; i++) {
    indices.push(tailBase, tailBase + 1 + i, tailBase + 2 + i);
    indices.push(headBase, headBase + 1 + i, headBase + 2 + i);
  }
  return indices;
}

export class TrailRenderer {
  private scene: Scene;
  private trails = new Map<string, TrailData>();
  private materials = new Map<string, StandardMaterial>();

  constructor(scene: Scene) {
    this.scene = scene;
  }

  private getMaterial(colorHex: string): StandardMaterial {
    let material = this.materials.get(colorHex);
    if (!material) {
      material = new StandardMaterial(`trailMat_${colorHex}`, this.scene);
      material.diffuseColor = Color3.FromHexString(colorHex).scale(0.9);
      material.emissiveColor = Color3.FromHexString(colorHex).scale(0.2);
      material.specularColor = new Color3(0, 0, 0);
      material.backFaceCulling = false;
      this.materials.set(colorHex, material);
    }
    return material;
  }

  private createTrailData(color: string): TrailData {
    return {
      mesh: null,
      spineCapacity: 0,
      positions: null,
      tangents: null,
      sideNormals: null,
      presentationSpine: [],
      renderHead: null,
      networkStart: null,
      lastNetworkPointCount: 0,
      color,
    };
  }

  private initializePresentationSpine(
    data: TrailData,
    points: Array<{ x: number; y: number }>,
    head: TrailSpinePoint
  ) {
    const networkPoints: TrailSpinePoint[] = [];
    for (const point of points) {
      const candidate = { x: point.x, z: point.y };
      const previous = networkPoints[networkPoints.length - 1];
      if (!previous || distanceBetween(previous, candidate) >= MIN_SEGMENT_LENGTH) {
        networkPoints.push(candidate);
      }
    }

    const clipped = clipNetworkSnapshotToHead(networkPoints, head);
    const smoothed = smoothOpenSpine(clipped, 2);
    data.presentationSpine = resampleOpenSpine(smoothed, PRESENTATION_SAMPLE_SPACING);
    data.renderHead = { ...head };
  }

  private ensureMesh(
    data: TrailData,
    playerId: string,
    colorHex: string,
    requiredSpinePoints: number
  ) {
    if (
      data.mesh &&
      data.positions &&
      data.tangents &&
      data.sideNormals &&
      data.spineCapacity >= requiredSpinePoints
    ) {
      if (data.color !== colorHex) data.mesh.material = this.getMaterial(colorHex);
      data.color = colorHex;
      return;
    }

    const capacity = nextSpineCapacity(requiredSpinePoints);
    const totalVertices = capacity * 3 + CAP_VERTICES_PER_END * 2;
    const positions = new Float32Array(totalVertices * 3);
    const normals = new Float32Array(totalVertices * 3);
    for (let i = 0; i < totalVertices; i++) normals[i * 3 + 1] = 1;

    if (data.mesh) data.mesh.dispose();

    const mesh = new Mesh(`trail_${playerId}`, this.scene);
    const vertexData = new VertexData();
    vertexData.positions = positions;
    vertexData.normals = normals;
    vertexData.indices = createStaticIndices(capacity);
    vertexData.applyToMesh(mesh, true);
    mesh.material = this.getMaterial(colorHex);
    mesh.isPickable = false;
    // The path moves and expands continuously; skip per-frame bounding-box
    // rebuilds and keep this lightweight presentation mesh active directly.
    mesh.alwaysSelectAsActiveMesh = true;

    data.mesh = mesh;
    data.spineCapacity = capacity;
    data.positions = positions;
    data.tangents = new Float32Array(capacity * 2);
    data.sideNormals = new Float32Array(capacity * 2);
    data.color = colorHex;
  }

  private computeFrames(
    spine: TrailSpinePoint[],
    tangents: Float32Array,
    sideNormals: Float32Array
  ) {
    for (let i = 0; i < spine.length; i++) {
      let before = i;
      let distanceBefore = 0;
      while (before > 0 && distanceBefore < TANGENT_SAMPLE_DISTANCE) {
        distanceBefore += distanceBetween(spine[before], spine[before - 1]);
        before--;
      }

      let after = i;
      let distanceAfter = 0;
      while (after < spine.length - 1 && distanceAfter < TANGENT_SAMPLE_DISTANCE) {
        distanceAfter += distanceBetween(spine[after], spine[after + 1]);
        after++;
      }

      let tangentX = spine[after].x - spine[before].x;
      let tangentZ = spine[after].z - spine[before].z;
      let tangentLength = Math.hypot(tangentX, tangentZ);

      if (tangentLength < 1e-8 && i > 0) {
        tangentX = tangents[(i - 1) * 2];
        tangentZ = tangents[(i - 1) * 2 + 1];
        tangentLength = 1;
      } else if (tangentLength < 1e-8) {
        tangentX = 1;
        tangentZ = 0;
        tangentLength = 1;
      }

      tangentX /= tangentLength;
      tangentZ /= tangentLength;
      let normalX = -tangentZ;
      let normalZ = tangentX;

      if (i > 0) {
        const previousNormalX = sideNormals[(i - 1) * 2];
        const previousNormalZ = sideNormals[(i - 1) * 2 + 1];
        if (normalX * previousNormalX + normalZ * previousNormalZ < 0) {
          normalX = -normalX;
          normalZ = -normalZ;
        }
      }

      tangents[i * 2] = tangentX;
      tangents[i * 2 + 1] = tangentZ;
      sideNormals[i * 2] = normalX;
      sideNormals[i * 2 + 1] = normalZ;
    }
  }

  private writeCap(
    positions: Float32Array,
    baseVertex: number,
    point: TrailSpinePoint,
    tangentX: number,
    tangentZ: number,
    normalX: number,
    normalZ: number,
    isHead: boolean
  ) {
    writeVertex(positions, baseVertex, point.x, ALTITUDE, point.z);

    const orientation = tangentX * normalZ - tangentZ * normalX >= 0 ? 1 : -1;
    const startX = isHead ? -normalX : normalX;
    const startZ = isHead ? -normalZ : normalZ;
    const startAngle = Math.atan2(startZ, startX);

    for (let i = 0; i <= CAP_STEPS; i++) {
      const angle = startAngle + orientation * Math.PI * (i / CAP_STEPS);
      writeVertex(
        positions,
        baseVertex + 1 + i,
        point.x + TRAIL_RADIUS * Math.cos(angle),
        ALTITUDE,
        point.z + TRAIL_RADIUS * Math.sin(angle)
      );
    }
  }

  private updateGeometry(data: TrailData, spine: TrailSpinePoint[]) {
    const { mesh, positions, tangents, sideNormals } = data;
    if (!mesh || !positions || !tangents || !sideNormals || spine.length === 0) return;

    this.computeFrames(spine, tangents, sideNormals);

    for (let i = 0; i < spine.length; i++) {
      const point = spine[i];
      const normalX = sideNormals[i * 2];
      const normalZ = sideNormals[i * 2 + 1];
      const vertex = i * 3;
      writeVertex(positions, vertex, point.x, ALTITUDE, point.z);
      writeVertex(
        positions,
        vertex + 1,
        point.x + normalX * TRAIL_RADIUS,
        ALTITUDE,
        point.z + normalZ * TRAIL_RADIUS
      );
      writeVertex(
        positions,
        vertex + 2,
        point.x - normalX * TRAIL_RADIUS,
        ALTITUDE,
        point.z - normalZ * TRAIL_RADIUS
      );
    }

    // Static indices cover the full capacity. Repeating the active endpoint
    // makes every unused body segment degenerate, so appends need no new mesh.
    const lastBodyOffset = (spine.length - 1) * 9;
    for (let i = spine.length; i < data.spineCapacity; i++) {
      positions.set(positions.subarray(lastBodyOffset, lastBodyOffset + 9), i * 9);
    }

    const tailBase = data.spineCapacity * 3;
    const headBase = tailBase + CAP_VERTICES_PER_END;
    const lastIndex = spine.length - 1;
    this.writeCap(
      positions,
      tailBase,
      spine[0],
      tangents[0],
      tangents[1],
      sideNormals[0],
      sideNormals[1],
      false
    );
    this.writeCap(
      positions,
      headBase,
      spine[lastIndex],
      tangents[lastIndex * 2],
      tangents[lastIndex * 2 + 1],
      sideNormals[lastIndex * 2],
      sideNormals[lastIndex * 2 + 1],
      true
    );

    mesh.updateVerticesData(VertexBuffer.PositionKind, positions, false, false);
  }

  updateTrail(
    playerId: string,
    colorHex: string,
    points: Array<{ x: number; y: number }>,
    currentHeadX: number,
    currentHeadZ: number
  ) {
    if (points.length === 0) {
      this.clearTrail(playerId);
      return;
    }

    let data = this.trails.get(playerId);
    if (!data) {
      data = this.createTrailData(colorHex);
      this.trails.set(playerId, data);
    }

    const head = { x: currentHeadX, z: currentHeadZ };
    const networkStart = { x: points[0].x, z: points[0].y };
    const startChanged = data.networkStart !== null &&
      distanceBetween(data.networkStart, networkStart) > NETWORK_START_RESET_DISTANCE;
    const pointCountRestarted = points.length < data.lastNetworkPointCount;
    const headDiscontinuous = data.renderHead !== null &&
      distanceBetween(data.renderHead, head) > HEAD_DISCONTINUITY_DISTANCE;
    const needsInitialization = data.presentationSpine.length === 0 ||
      startChanged || pointCountRestarted || headDiscontinuous;

    if (needsInitialization) {
      this.initializePresentationSpine(data, points, head);
      data.networkStart = networkStart;
    } else if (appendPresentationSamples(data.presentationSpine, head)) {
      data.renderHead = { ...head };
    }

    data.lastNetworkPointCount = points.length;
    const renderHead = data.renderHead ?? head;
    const spine = data.presentationSpine;
    const appendDynamicHead = distanceBetween(spine[spine.length - 1], renderHead) >= MIN_SEGMENT_LENGTH &&
      isForwardHead(spine, renderHead);
    if (appendDynamicHead) spine.push(renderHead);

    this.ensureMesh(data, playerId, colorHex, spine.length);
    this.updateGeometry(data, spine);

    if (appendDynamicHead) spine.pop();
  }

  clearTrail(playerId: string) {
    const data = this.trails.get(playerId);
    if (!data) return;
    if (data.mesh) data.mesh.dispose();
    this.trails.delete(playerId);
  }

  cleanupRemoved(activePlayers: { has(id: string): boolean }) {
    for (const playerId of this.trails.keys()) {
      if (!activePlayers.has(playerId)) this.clearTrail(playerId);
    }
  }

  removeAll() {
    this.trails.forEach((data) => {
      if (data.mesh) data.mesh.dispose();
    });
    this.trails.clear();
  }
}
