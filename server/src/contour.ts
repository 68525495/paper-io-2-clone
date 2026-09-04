export interface Point2D {
  x: number;
  y: number;
}

export interface ContourExtractionOptions {
  gridSize?: number;
  simplifyTolerance?: number;
  chaikinIterations?: number;
  maxDeviation?: number;
}

/**
 * Extracts smoothed isocontours for playerIdx from the 256x256 authoritative grid
 * using Marching Squares + constrained Chaikin smoothing.
 */
export function extractSmoothedPlayerContours(
  rawGrid: Uint8Array | number[],
  playerIdx: number,
  options: ContourExtractionOptions = {}
): Point2D[][] {
  const gridSize = options.gridSize ?? 256;
  const simplifyTolerance = options.simplifyTolerance ?? 0;
  const chaikinIterations = options.chaikinIterations ?? 2;
  const maxDeviation = options.maxDeviation ?? 0.5;

  // 1. Find bounding box of playerIdx
  let minX = gridSize;
  let maxX = -1;
  let minY = gridSize;
  let maxY = -1;

  for (let gy = 0; gy < gridSize; gy++) {
    const rowOffset = gy * gridSize;
    for (let gx = 0; gx < gridSize; gx++) {
      if (rawGrid[rowOffset + gx] === playerIdx) {
        if (gx < minX) minX = gx;
        if (gx > maxX) maxX = gx;
        if (gy < minY) minY = gy;
        if (gy > maxY) maxY = gy;
      }
    }
  }

  if (maxX < 0) return []; // No territory for this player

  // Pad bounding box by 1 cell on each side so the domain is surrounded by 0
  const fromX = Math.max(-1, minX - 1);
  const toX = Math.min(gridSize - 1, maxX + 1);
  const fromY = Math.max(-1, minY - 1);
  const toY = Math.min(gridSize - 1, maxY + 1);

  const isPlayer = (x: number, y: number): number => {
    if (x < 0 || x >= gridSize || y < 0 || y >= gridSize) return 0;
    return rawGrid[y * gridSize + x] === playerIdx ? 1 : 0;
  };

  // Stride for unique edge key generation
  const stride = (gridSize + 4) * 2;

  const getEdgePt = (edge: number, cx: number, cy: number): Point2D => {
    switch (edge) {
      case 0: return { x: cx + 0.5, y: cy };
      case 1: return { x: cx + 1.0, y: cy + 0.5 };
      case 2: return { x: cx + 0.5, y: cy + 1.0 };
      case 3: return { x: cx, y: cy + 0.5 };
      default: return { x: cx, y: cy };
    }
  };

  const getEdgeKey = (edge: number, cx: number, cy: number): number => {
    let ix = 0;
    let iy = 0;
    switch (edge) {
      case 0: ix = 2 * cx + 1; iy = 2 * cy; break;
      case 1: ix = 2 * cx + 2; iy = 2 * cy + 1; break;
      case 2: ix = 2 * cx + 1; iy = 2 * cy + 2; break;
      case 3: ix = 2 * cx;     iy = 2 * cy + 1; break;
    }
    return (iy + 4) * stride + (ix + 4);
  };

  // Map startKey -> { pt, nextKey, nextPt }
  const edges = new Map<number, { pt: Point2D; nextKey: number; nextPt: Point2D }>();

  const addSegment = (fromEdge: number, toEdge: number, cx: number, cy: number) => {
    const startKey = getEdgeKey(fromEdge, cx, cy);
    const endKey = getEdgeKey(toEdge, cx, cy);
    const pt = getEdgePt(fromEdge, cx, cy);
    const nextPt = getEdgePt(toEdge, cx, cy);
    edges.set(startKey, { pt, nextKey: endKey, nextPt });
  };

  // 2. Marching Squares over padded region
  for (let cy = fromY; cy <= toY; cy++) {
    for (let cx = fromX; cx <= toX; cx++) {
      const v0 = isPlayer(cx, cy);         // BL
      const v1 = isPlayer(cx + 1, cy);     // BR
      const v2 = isPlayer(cx + 1, cy + 1); // TR
      const v3 = isPlayer(cx, cy + 1);     // TL

      const mask = v0 | (v1 << 1) | (v2 << 2) | (v3 << 3);
      if (mask === 0 || mask === 15) continue;

      switch (mask) {
        case 1:  addSegment(3, 0, cx, cy); break;
        case 2:  addSegment(0, 1, cx, cy); break;
        case 3:  addSegment(3, 1, cx, cy); break;
        case 4:  addSegment(1, 2, cx, cy); break;
        case 5:
          addSegment(3, 0, cx, cy);
          addSegment(1, 2, cx, cy);
          break;
        case 6:  addSegment(0, 2, cx, cy); break;
        case 7:  addSegment(3, 2, cx, cy); break;
        case 8:  addSegment(2, 3, cx, cy); break;
        case 9:  addSegment(2, 0, cx, cy); break;
        case 10:
          addSegment(0, 1, cx, cy);
          addSegment(2, 3, cx, cy);
          break;
        case 11: addSegment(2, 1, cx, cy); break;
        case 12: addSegment(1, 3, cx, cy); break;
        case 13: addSegment(1, 0, cx, cy); break;
        case 14: addSegment(0, 3, cx, cy); break;
      }
    }
  }

  // 3. Chain segments into closed loops
  const visited = new Set<number>();
  const rawLoops: Point2D[][] = [];

  for (const [startKey, edge] of edges) {
    if (visited.has(startKey)) continue;

    const loop: Point2D[] = [];
    let currKey = startKey;
    let closed = false;

    let safety = 0;
    while (!visited.has(currKey) && safety++ <= edges.size + 1) {
      visited.add(currKey);
      const currEdge = edges.get(currKey);
      if (!currEdge) break;

      loop.push(currEdge.pt);
      if (currEdge.nextKey === startKey) {
        closed = true;
        break;
      }
      currKey = currEdge.nextKey;
    }

    if (closed && loop.length >= 3) {
      rawLoops.push(loop);
    }
  }

  // 4. Remove sub-cell raster stair steps before rounding the remaining
  // corners. Chaikin alone rounds every stair instead of recovering the
  // continuous curve that produced the rasterized boundary.
  return rawLoops.map((loop) => {
    const simplified =
      simplifyTolerance > 0
        ? simplifyClosedLoop(loop, simplifyTolerance)
        : loop;
    return smoothClosedLoop(
      simplified,
      chaikinIterations,
      maxDeviation,
      loop
    );
  });
}

/**
 * Ramer-Douglas-Peucker simplification for a closed loop. The loop is split at
 * two far-apart vertices first so the artificial array seam cannot flatten a
 * real section of the boundary.
 */
export function simplifyClosedLoop(
  loop: Point2D[],
  tolerance: number
): Point2D[] {
  if (loop.length < 4 || tolerance <= 0) return loop;

  const points: Point2D[] = [];
  for (const point of loop) {
    const previous = points[points.length - 1];
    if (!previous || point.x !== previous.x || point.y !== previous.y) {
      points.push(point);
    }
  }
  if (points.length > 1) {
    const first = points[0];
    const last = points[points.length - 1];
    if (first.x === last.x && first.y === last.y) points.pop();
  }
  if (points.length < 4) return points;

  const farthestFrom = (index: number): number => {
    const origin = points[index];
    let farthestIndex = index;
    let farthestDistanceSq = -1;
    for (let i = 0; i < points.length; i++) {
      const dx = points[i].x - origin.x;
      const dy = points[i].y - origin.y;
      const distanceSq = dx * dx + dy * dy;
      if (distanceSq > farthestDistanceSq) {
        farthestDistanceSq = distanceSq;
        farthestIndex = i;
      }
    }
    return farthestIndex;
  };

  const firstSplit = farthestFrom(0);
  const secondSplit = farthestFrom(firstSplit);

  const collectArc = (from: number, to: number): Point2D[] => {
    const arc: Point2D[] = [points[from]];
    let index = from;
    while (index !== to) {
      index = (index + 1) % points.length;
      arc.push(points[index]);
    }
    return arc;
  };

  const firstArc = simplifyOpenPolyline(
    collectArc(firstSplit, secondSplit),
    tolerance
  );
  const secondArc = simplifyOpenPolyline(
    collectArc(secondSplit, firstSplit),
    tolerance
  );

  const simplified = [
    ...firstArc.slice(0, -1),
    ...secondArc.slice(0, -1),
  ];
  return simplified.length >= 3 ? simplified : points;
}

function simplifyOpenPolyline(
  points: Point2D[],
  tolerance: number
): Point2D[] {
  if (points.length <= 2) return points;

  const toleranceSq = tolerance * tolerance;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  const spans: Array<[number, number]> = [[0, points.length - 1]];
  while (spans.length > 0) {
    const [start, end] = spans.pop()!;
    let farthestIndex = -1;
    let farthestDistanceSq = toleranceSq;

    for (let i = start + 1; i < end; i++) {
      const distanceSq = pointToSegmentDistanceSq(
        points[i],
        points[start],
        points[end]
      );
      if (distanceSq > farthestDistanceSq) {
        farthestDistanceSq = distanceSq;
        farthestIndex = i;
      }
    }

    if (farthestIndex >= 0) {
      keep[farthestIndex] = 1;
      spans.push([start, farthestIndex], [farthestIndex, end]);
    }
  }

  return points.filter((_, index) => keep[index] === 1);
}

function pointToSegmentDistanceSq(
  point: Point2D,
  start: Point2D,
  end: Point2D
): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq <= 1e-12) {
    const px = point.x - start.x;
    const py = point.y - start.y;
    return px * px + py * py;
  }

  const projection = Math.max(
    0,
    Math.min(
      1,
      ((point.x - start.x) * dx + (point.y - start.y) * dy) /
        lengthSq
    )
  );
  const closestX = start.x + projection * dx;
  const closestY = start.y + projection * dy;
  const px = point.x - closestX;
  const py = point.y - closestY;
  return px * px + py * py;
}

/**
 * Constrained Chaikin smoothing on a closed polygon loop.
 * Clamps all smoothed points within maxDeviation grid units of the original polygon.
 */
export function smoothClosedLoop(
  loop: Point2D[],
  iterations: number = 2,
  maxDeviation: number = 0.5,
  constraintLoop: Point2D[] = loop
): Point2D[] {
  if (loop.length < 3) return loop;

  const original = constraintLoop.map((p) => ({ x: p.x, y: p.y }));
  let current = loop;

  for (let iter = 0; iter < iterations; iter++) {
    const next: Point2D[] = [];
    const n = current.length;

    for (let i = 0; i < n; i++) {
      const p0 = current[i];
      const p1 = current[(i + 1) % n];

      // Standard Chaikin corner cut: Q = 0.75 P0 + 0.25 P1, R = 0.25 P0 + 0.75 P1
      const qx = 0.75 * p0.x + 0.25 * p1.x;
      const qy = 0.75 * p0.y + 0.25 * p1.y;

      const rx = 0.25 * p0.x + 0.75 * p1.x;
      const ry = 0.25 * p0.y + 0.75 * p1.y;

      next.push(constrainPointToOriginal(qx, qy, original, maxDeviation));
      next.push(constrainPointToOriginal(rx, ry, original, maxDeviation));
    }

    current = next;
  }

  return current;
}

/**
 * Ensures point (px, py) is within maxDeviation perpendicular distance from original loop.
 */
function constrainPointToOriginal(
  px: number,
  py: number,
  original: Point2D[],
  maxDeviation: number
): Point2D {
  let minDistSq = Infinity;
  let closestX = px;
  let closestY = py;

  const n = original.length;
  for (let i = 0; i < n; i++) {
    const p0 = original[i];
    const p1 = original[(i + 1) % n];

    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    const l2 = dx * dx + dy * dy;

    let t = 0;
    if (l2 > 1e-8) {
      t = Math.max(0, Math.min(1, ((px - p0.x) * dx + (py - p0.y) * dy) / l2));
    }
    const projX = p0.x + t * dx;
    const projY = p0.y + t * dy;

    const distSq = (px - projX) * (px - projX) + (py - projY) * (py - projY);
    if (distSq < minDistSq) {
      minDistSq = distSq;
      closestX = projX;
      closestY = projY;
    }
  }

  const dist = Math.sqrt(minDistSq);
  if (dist <= maxDeviation || dist < 1e-6) {
    return { x: px, y: py };
  }

  const ratio = maxDeviation / dist;
  return {
    x: closestX + (px - closestX) * ratio,
    y: closestY + (py - closestY) * ratio,
  };
}
