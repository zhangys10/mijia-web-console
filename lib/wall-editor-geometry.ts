import type { SpatialPoint, SpatialWall } from "./spatial-layout.ts";

export type WallRenderPath = { id: string; points: SpatialPoint[]; thicknessPixels: number; wallIds: string[] };
export type WallGraphNode = { id: string; point: SpatialPoint; wallIds: string[] };

function distance(left: SpatialPoint, right: SpatialPoint) { return Math.hypot(left.x - right.x, left.y - right.y); }

function endpointKey(point: SpatialPoint, tolerance: number) {
  return `${Math.round(point.x / tolerance)}:${Math.round(point.y / tolerance)}`;
}

function groupEndpoints(entries: Array<{ point: SpatialPoint; wallId: string }>, tolerance: number) {
  const groups: Array<{ points: SpatialPoint[]; wallIds: Set<string>; point: SpatialPoint }> = [];
  for (const entry of entries) {
    const group = groups.find(candidate => distance(candidate.point, entry.point) <= tolerance);
    if (!group) { groups.push({ points: [entry.point], wallIds: new Set([entry.wallId]), point: { ...entry.point } }); continue; }
    group.points.push(entry.point); group.wallIds.add(entry.wallId);
    group.point = {
      x: group.points.reduce((sum, point) => sum + point.x, 0) / group.points.length,
      y: group.points.reduce((sum, point) => sum + point.y, 0) / group.points.length,
    };
  }
  return groups;
}

function graphSegments(walls: SpatialWall[], tolerance: number) {
  return walls.flatMap(wall => {
    const dx = wall.end.x - wall.start.x, dy = wall.end.y - wall.start.y, lengthSquared = dx * dx + dy * dy;
    if (lengthSquared < 1) return [];
    const cuts = [0, 1];
    for (const other of walls) {
      if (other.id === wall.id) continue;
      for (const point of [other.start, other.end]) {
        const ratio = ((point.x - wall.start.x) * dx + (point.y - wall.start.y) * dy) / lengthSquared;
        if (ratio <= 0 || ratio >= 1) continue;
        const projected = { x: wall.start.x + dx * ratio, y: wall.start.y + dy * ratio };
        if (distance(projected, point) <= tolerance) cuts.push(ratio);
      }
      const odx = other.end.x - other.start.x, ody = other.end.y - other.start.y, denominator = dx * ody - dy * odx;
      if (Math.abs(denominator) < 1e-6) continue;
      const ox = other.start.x - wall.start.x, oy = other.start.y - wall.start.y;
      const ratio = (ox * ody - oy * odx) / denominator, otherRatio = (ox * dy - oy * dx) / denominator;
      if (ratio > 0 && ratio < 1 && otherRatio >= 0 && otherRatio <= 1) cuts.push(ratio);
    }
    const ordered = [...new Set(cuts.map(value => Math.round(value * 1e6) / 1e6))].sort((left, right) => left - right);
    return ordered.slice(0, -1).map((from, index) => { const to = ordered[index + 1]; return { ...wall, id: `${wall.id}_graph_${index + 1}`, sourceWallId: wall.id, start: { x: wall.start.x + dx * from, y: wall.start.y + dy * from }, end: { x: wall.start.x + dx * to, y: wall.start.y + dy * to } }; });
  });
}

export function buildWallGraphNodes(walls: SpatialWall[], tolerance = 1.5): WallGraphNode[] {
  const entries = graphSegments(walls, tolerance).flatMap(wall => [wall.start, wall.end].map(point => ({ point, wallId: wall.sourceWallId })));
  return groupEndpoints(entries, tolerance).map((group, index) => ({ id: `node:${index}:${group.point.x.toFixed(3)}:${group.point.y.toFixed(3)}`, point: group.point, wallIds: [...group.wallIds] }));
}

/** Makes nearby corner endpoints one real topology point in the stored wall graph. */
export function weldWallEndpoints(walls: SpatialWall[], tolerance = 1.5): SpatialWall[] {
  const entries = walls.flatMap(wall => ([{ point: wall.start, wallId: `${wall.id}:start` }, { point: wall.end, wallId: `${wall.id}:end` }]));
  const groups = groupEndpoints(entries, tolerance);
  const canonical = new Map(groups.flatMap(group => group.wallIds.size > 1 ? [...group.wallIds].map(id => [id, group.point] as const) : []));
  return walls.map(wall => ({ ...wall, start: canonical.get(`${wall.id}:start`) ?? wall.start, end: canonical.get(`${wall.id}:end`) ?? wall.end }));
}

/** Splits a host wall where another wall ends on it, making a T junction three real edges sharing one point. */
export function materializeWallJunctions(walls: SpatialWall[], tolerance = 1.5): SpatialWall[] {
  const welded = weldWallEndpoints(walls, tolerance);
  const endpointUpdates = new Map<string, SpatialPoint>(), cuts = new Map<string, Array<{ ratio: number; point: SpatialPoint }>>();
  for (const host of welded) {
    const dx = host.end.x - host.start.x, dy = host.end.y - host.start.y, lengthSquared = dx * dx + dy * dy;
    if (lengthSquared < 9) continue;
    for (const other of welded) {
      if (other.id === host.id) continue;
      for (const part of ["start", "end"] as const) {
        const point = other[part], ratio = ((point.x - host.start.x) * dx + (point.y - host.start.y) * dy) / lengthSquared;
        if (ratio <= 0.001 || ratio >= 0.999) continue;
        const projected = { x: host.start.x + dx * ratio, y: host.start.y + dy * ratio };
        if (distance(projected, point) > tolerance) continue;
        endpointUpdates.set(`${other.id}:${part}`, projected);
        const entries = cuts.get(host.id) ?? []; entries.push({ ratio, point: projected }); cuts.set(host.id, entries);
      }
    }
  }
  const updated = welded.map(wall => ({ ...wall, start: endpointUpdates.get(`${wall.id}:start`) ?? wall.start, end: endpointUpdates.get(`${wall.id}:end`) ?? wall.end }));
  const usedIds = new Set(updated.map(wall => wall.id)), result: SpatialWall[] = [];
  for (const wall of updated) {
    const wallCuts = (cuts.get(wall.id) ?? []).sort((left, right) => left.ratio - right.ratio).filter((cut, index, values) => index === 0 || Math.abs(cut.ratio - values[index - 1].ratio) > 0.001);
    if (!wallCuts.length) { result.push(wall); continue; }
    const points = [wall.start, ...wallCuts.map(cut => cut.point), wall.end];
    for (let index = 0; index < points.length - 1; index++) {
      let segmentId = wall.id;
      if (index > 0) {
        segmentId = `${wall.id.slice(0, 72)}_j${index}`;
        for (let suffix = 2; usedIds.has(segmentId); suffix++) segmentId = `${wall.id.slice(0, 68)}_j${index}_${suffix}`;
        usedIds.add(segmentId);
      }
      if (distance(points[index], points[index + 1]) >= 3) result.push({ ...wall, id: segmentId, start: points[index], end: points[index + 1] });
    }
  }
  return weldWallEndpoints(result, Math.min(tolerance, .1));
}

/** Moves every wall endpoint attached to a graph node, preserving a shared corner. */
export function moveWallGraphNode(walls: SpatialWall[], origin: SpatialPoint, next: SpatialPoint, tolerance = 1.5): SpatialWall[] {
  return walls.map(wall => ({
    ...wall,
    start: distance(wall.start, origin) <= tolerance ? { ...next } : wall.start,
    end: distance(wall.end, origin) <= tolerance ? { ...next } : wall.end,
  }));
}

/** Prefers horizontal/vertical incident edges while a shared node is dragged. */
export function alignWallGraphNode(point: SpatialPoint, origin: SpatialPoint, walls: SpatialWall[], wallIds: string[], tolerance: number): SpatialPoint {
  const opposite = walls.filter(wall => wallIds.includes(wall.id)).flatMap(wall => {
    if (distance(wall.start, origin) <= 1.5) return [wall.end];
    if (distance(wall.end, origin) <= 1.5) return [wall.start];
    return [];
  });
  const x = opposite.map(anchor => ({ value: anchor.x, gap: Math.abs(point.x - anchor.x) })).filter(value => value.gap <= tolerance).sort((left, right) => left.gap - right.gap)[0];
  const y = opposite.map(anchor => ({ value: anchor.y, gap: Math.abs(point.y - anchor.y) })).filter(value => value.gap <= tolerance).sort((left, right) => left.gap - right.gap)[0];
  return { x: x?.value ?? point.x, y: y?.value ?? point.y };
}

function signedArea(points: SpatialPoint[]) {
  return points.reduce((sum, point, index) => { const next = points[(index + 1) % points.length]; return sum + point.x * next.y - next.x * point.y; }, 0) / 2;
}

function containsPoint(point: SpatialPoint, polygon: SpatialPoint[]) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const left = polygon[index], right = polygon[previous];
    if ((left.y > point.y) !== (right.y > point.y) && point.x < (right.x - left.x) * (point.y - left.y) / ((right.y - left.y) || Number.EPSILON) + left.x) inside = !inside;
  }
  return inside;
}

/** Finds the smallest bounded half-edge face containing a point. */
export function findEnclosedWallFace(walls: SpatialWall[], point: SpatialPoint, tolerance = 1.5) {
  const segments = graphSegments(walls, tolerance), nodes = buildWallGraphNodes(walls, tolerance);
  const nodeAt = (point: SpatialPoint) => nodes.find(node => distance(node.point, point) <= tolerance);
  const edges = segments.flatMap(wall => { const from = nodeAt(wall.start), to = nodeAt(wall.end); return from && to && from.id !== to.id ? [{ id: wall.id, from: from.id, to: to.id }] : []; });
  const nodeMap = new Map(nodes.map(node => [node.id, node])), adjacency = new Map<string, Array<{ edgeId: string; to: string }>>();
  for (const edge of edges) for (const [from, to] of [[edge.from, edge.to], [edge.to, edge.from]]) { const list = adjacency.get(from) ?? []; list.push({ edgeId: edge.id, to }); adjacency.set(from, list); }
  for (const [nodeId, list] of adjacency) { const origin = nodeMap.get(nodeId)!.point; list.sort((left, right) => { const a = nodeMap.get(left.to)!.point, b = nodeMap.get(right.to)!.point; return Math.atan2(a.y - origin.y, a.x - origin.x) - Math.atan2(b.y - origin.y, b.x - origin.x); }); }
  const visited = new Set<string>(), faces: SpatialPoint[][] = [];
  for (const edge of edges) for (const [startFrom, startTo] of [[edge.from, edge.to], [edge.to, edge.from]]) {
    const startKey = `${edge.id}:${startFrom}`, polygon: SpatialPoint[] = []; if (visited.has(startKey)) continue;
    let edgeId = edge.id, from = startFrom, to = startTo, closed = false;
    for (let guard = 0; guard < edges.length * 2 + 2; guard++) {
      const directedKey = `${edgeId}:${from}`; if (visited.has(directedKey)) { closed = directedKey === startKey; break; }
      visited.add(directedKey); polygon.push(nodeMap.get(from)!.point);
      const outgoing = adjacency.get(to) ?? [], reverseIndex = outgoing.findIndex(candidate => candidate.edgeId === edgeId && candidate.to === from);
      if (reverseIndex < 0 || !outgoing.length) break;
      const next = outgoing[(reverseIndex - 1 + outgoing.length) % outgoing.length]; from = to; to = next.to; edgeId = next.edgeId;
      if (`${edgeId}:${from}` === startKey) { closed = true; break; }
    }
    if (closed && polygon.length >= 3 && signedArea(polygon) > 1) faces.push(polygon);
  }
  return faces.filter(face => containsPoint(point, face)).sort((left, right) => Math.abs(signedArea(left)) - Math.abs(signedArea(right)))[0] ?? null;
}

/**
 * Builds maximal visual paths while leaving the source walls untouched. A path is
 * continued only through a two-wall junction, matching the half-edge approach used
 * by established floor-plan editors: topology stays on centerlines and thickness is
 * applied by the renderer with a miter join.
 */
export function buildWallRenderPaths(walls: SpatialWall[], tolerance = 1.5): WallRenderPath[] {
  const endpoints = new Map<string, Array<{ wall: SpatialWall; atStart: boolean }>>();
  for (const wall of walls) for (const atStart of [true, false]) {
    const point = atStart ? wall.start : wall.end, key = endpointKey(point, tolerance);
    const entries = endpoints.get(key) ?? []; entries.push({ wall, atStart }); endpoints.set(key, entries);
  }
  const used = new Set<string>(), paths: WallRenderPath[] = [];
  const walk = (first: SpatialWall, fromStart: boolean) => {
    const points: SpatialPoint[] = [], wallIds: string[] = [];
    let wall = first, atStart = fromStart;
    while (!used.has(wall.id)) {
      used.add(wall.id); wallIds.push(wall.id);
      const from = atStart ? wall.start : wall.end, to = atStart ? wall.end : wall.start;
      if (!points.length) points.push(from); points.push(to);
      const entries = endpoints.get(endpointKey(to, tolerance)) ?? [];
      if (entries.length !== 2) break;
      const next = entries.find(entry => entry.wall.id !== wall.id);
      if (!next || used.has(next.wall.id) || Math.abs(next.wall.thicknessPixels - wall.thicknessPixels) > Math.max(2, wall.thicknessPixels * .25)) break;
      wall = next.wall; atStart = next.atStart;
    }
    paths.push({ id: `wall-path:${wallIds.join(":")}`, points, thicknessPixels: Math.max(...wallIds.map(id => walls.find(item => item.id === id)!.thicknessPixels)), wallIds });
  };
  for (const wall of walls) {
    if (used.has(wall.id)) continue;
    const startDegree = (endpoints.get(endpointKey(wall.start, tolerance)) ?? []).length;
    const endDegree = (endpoints.get(endpointKey(wall.end, tolerance)) ?? []).length;
    walk(wall, startDegree !== 2 || endDegree === 2);
  }
  return paths;
}

export function projectPointToWall(point: SpatialPoint, wall: SpatialWall): SpatialPoint {
  const dx = wall.end.x - wall.start.x, dy = wall.end.y - wall.start.y, lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return { ...wall.start };
  const ratio = Math.max(0, Math.min(1, ((point.x - wall.start.x) * dx + (point.y - wall.start.y) * dy) / lengthSquared));
  return { x: wall.start.x + dx * ratio, y: wall.start.y + dy * ratio };
}

function lineIntersection(pointA: SpatialPoint, directionA: SpatialPoint, pointB: SpatialPoint, directionB: SpatialPoint) {
  const cross = directionA.x * directionB.y - directionA.y * directionB.x;
  if (Math.abs(cross) < 1e-6) return null;
  const dx = pointB.x - pointA.x, dy = pointB.y - pointA.y;
  const ratio = (dx * directionB.y - dy * directionB.x) / cross;
  return { x: pointA.x + directionA.x * ratio, y: pointA.y + directionA.y * ratio };
}

/** Returns the closed face outline of a constant-width centerline with true miter joins. */
export function miterPolylineOutline(points: SpatialPoint[], halfWidth: number, miterLimit = 4) {
  if (points.length < 2 || halfWidth <= 0) return [];
  const directions = points.slice(0, -1).map((point, index) => { const next = points[index + 1], length = Math.hypot(next.x - point.x, next.y - point.y); return length > 0 ? { x: (next.x - point.x) / length, y: (next.y - point.y) / length } : { x: 1, y: 0 }; });
  const normals = directions.map(direction => ({ x: -direction.y, y: direction.x }));
  const side = (sign: 1 | -1) => points.map((point, index) => {
    if (index === 0) return { x: point.x + normals[0].x * halfWidth * sign, y: point.y + normals[0].y * halfWidth * sign };
    if (index === points.length - 1) { const normal = normals.at(-1)!; return { x: point.x + normal.x * halfWidth * sign, y: point.y + normal.y * halfWidth * sign }; }
    const previous = normals[index - 1], next = normals[index];
    const intersection = lineIntersection({ x: point.x + previous.x * halfWidth * sign, y: point.y + previous.y * halfWidth * sign }, directions[index - 1], { x: point.x + next.x * halfWidth * sign, y: point.y + next.y * halfWidth * sign }, directions[index]);
    if (!intersection || distance(intersection, point) > halfWidth * miterLimit) return { x: point.x + next.x * halfWidth * sign, y: point.y + next.y * halfWidth * sign };
    return intersection;
  });
  return [...side(1), ...side(-1).reverse()];
}

export function snapWallPoint(point: SpatialPoint, anchor: SpatialPoint, walls: SpatialWall[], excludedWallId: string, tolerance: number) {
  let snapped = { ...point };
  if (Math.abs(snapped.x - anchor.x) <= tolerance) snapped.x = anchor.x;
  if (Math.abs(snapped.y - anchor.y) <= tolerance) snapped.y = anchor.y;
  let best = tolerance;
  for (const wall of walls) if (wall.id !== excludedWallId) for (const endpoint of [wall.start, wall.end]) {
    const separation = distance(point, endpoint);
    if (separation < best) { snapped = { ...endpoint }; best = separation; }
  }
  return snapped;
}
