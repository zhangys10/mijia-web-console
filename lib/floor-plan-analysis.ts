import type { SpatialOpening, SpatialPoint, SpatialWall, SpatialZone } from "./spatial-layout.ts";

export type FloorPlanAnalysis = { zones: SpatialZone[]; walls: SpatialWall[]; openings: SpatialOpening[]; confidence: number; notes: string[] };
export type FloorPlanAnalysisOptions = {
  /** Gray value below which a pixel is treated as CAD ink. Omit to use Otsu. */
  darkThreshold?: number;
  /** Minimum solid wall thickness in analysis pixels. */
  minWallThicknessPixels?: number;
  /** Minimum wall span as a fraction of the scan axis. */
  minWallLengthRatio?: number;
  /** Maximum short break that may be joined without classifying an opening. */
  mergeDistancePixels?: number;
  /** Detect four-rail gaps, including a close middle pair, as windows. */
  detectOpenings?: boolean;
};

type Axis = "horizontal" | "vertical";
type Run = { at: number; from: number; to: number };
type Band = Run & { startAt: number; endAt: number };
type WallCandidate = { axis: Axis; center: number; from: number; to: number; thickness: number };

function otsuThreshold(values: Uint8Array) {
  const histogram = new Uint32Array(256);
  let sum = 0;
  for (const value of values) { histogram[value]++; sum += value; }
  let backgroundWeight = 0, backgroundSum = 0, threshold = 128, bestVariance = -1;
  for (let candidate = 0; candidate < 256; candidate++) {
    backgroundWeight += histogram[candidate];
    if (!backgroundWeight) continue;
    const foregroundWeight = values.length - backgroundWeight;
    if (!foregroundWeight) break;
    backgroundSum += candidate * histogram[candidate];
    const backgroundMean = backgroundSum / backgroundWeight;
    const foregroundMean = (sum - backgroundSum) / foregroundWeight;
    const variance = backgroundWeight * foregroundWeight * (backgroundMean - foregroundMean) ** 2;
    if (variance > bestVariance) { bestVariance = variance; threshold = candidate; }
  }
  return threshold;
}

/** Keep only ink with a solid run across the wall. Long, thin CAD strokes fail this test. */
function buildThicknessCore(dark: Uint8Array, width: number, height: number, axis: Axis, minimumThickness: number) {
  const core = new Uint8Array(width * height);
  if (axis === "horizontal") {
    for (let x = 0; x < width; x++) {
      let from = -1;
      for (let y = 0; y <= height; y++) {
        const hit = y < height && dark[y * width + x] === 1;
        if (hit && from < 0) from = y;
        if (!hit && from >= 0) {
          if (y - from >= minimumThickness) for (let fill = from; fill < y; fill++) core[fill * width + x] = 1;
          from = -1;
        }
      }
    }
  } else {
    for (let y = 0; y < height; y++) {
      let from = -1;
      for (let x = 0; x <= width; x++) {
        const hit = x < width && dark[y * width + x] === 1;
        if (hit && from < 0) from = x;
        if (!hit && from >= 0) {
          if (x - from >= minimumThickness) for (let fill = from; fill < x; fill++) core[y * width + fill] = 1;
          from = -1;
        }
      }
    }
  }
  return core;
}

function scanCoreRuns(core: Uint8Array, width: number, height: number, axis: Axis, minimumLength: number) {
  const outer = axis === "horizontal" ? height : width;
  const inner = axis === "horizontal" ? width : height;
  const runs: Run[] = [];
  for (let at = 0; at < outer; at++) {
    let from = -1;
    for (let along = 0; along <= inner; along++) {
      const index = axis === "horizontal" ? at * width + along : along * width + at;
      const hit = along < inner && core[index] === 1;
      if (hit && from < 0) from = along;
      if (!hit && from >= 0) {
        if (along - from >= minimumLength) runs.push({ at, from, to: along - 1 });
        from = -1;
      }
    }
  }
  return runs;
}

function clusterAdjacentRuns(runs: Run[], maximumRowGap: number) {
  const bands: Band[] = [];
  for (const run of runs) {
    let match: Band | undefined;
    let bestOverlap = -1;
    for (let index = bands.length - 1; index >= 0; index--) {
      const band = bands[index];
      if (run.at - band.endAt > maximumRowGap) break;
      const overlap = Math.min(run.to, band.to) - Math.max(run.from, band.from) + 1;
      const shorter = Math.min(run.to - run.from + 1, band.to - band.from + 1);
      if (overlap >= shorter * .65 && overlap > bestOverlap) { match = band; bestOverlap = overlap; }
    }
    if (!match) bands.push({ ...run, startAt: run.at, endAt: run.at });
    else {
      match.from = Math.min(match.from, run.from);
      match.to = Math.max(match.to, run.to);
      match.endAt = run.at;
      match.at = (match.startAt + match.endAt) / 2;
    }
  }
  return bands;
}

function mergeShortBreaks(candidates: WallCandidate[], distance: number) {
  const result = candidates.map(candidate => ({ ...candidate }));
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let first = 0; first < result.length; first++) for (let second = first + 1; second < result.length; second++) {
      const a = result[first], b = result[second];
      if (a.axis !== b.axis) continue;
      if (Math.abs(a.center - b.center) > Math.max(2, Math.min(a.thickness, b.thickness) * .35)) continue;
      const gap = Math.max(a.from, b.from) - Math.min(a.to, b.to) - 1;
      if (gap > Math.max(distance, Math.min(a.thickness, b.thickness) * 1.25)) continue;
      const aLength = a.to - a.from + 1, bLength = b.to - b.from + 1;
      a.center = (a.center * aLength + b.center * bLength) / (aLength + bLength);
      a.from = Math.min(a.from, b.from);
      a.to = Math.max(a.to, b.to);
      a.thickness = Math.max(a.thickness, b.thickness);
      result.splice(second, 1);
      changed = true;
      break outer;
    }
  }
  return result;
}

function lineCoverage(dark: Uint8Array, width: number, height: number, axis: Axis, cross: number, from: number, to: number) {
  const low = Math.max(0, Math.ceil(from));
  const high = Math.min(axis === "horizontal" ? width - 1 : height - 1, Math.floor(to));
  if (high < low) return 0;
  let hits = 0;
  for (let along = low; along <= high; along++) {
    const x = axis === "horizontal" ? along : cross;
    const y = axis === "horizontal" ? cross : along;
    if (x >= 0 && y >= 0 && x < width && y < height && dark[y * width + x]) hits++;
  }
  return hits / (high - low + 1);
}

function railGroups(ink: Uint8Array, width: number, height: number, axis: Axis, center: number, from: number, to: number, thickness: number) {
  const radius = Math.max(4, Math.ceil(thickness * .65));
  center = Math.round(center);
  const crossLimit = axis === "horizontal" ? height : width;
  const occupied: number[] = [];
  for (let cross = Math.max(0, center - radius); cross <= Math.min(crossLimit - 1, center + radius); cross++) {
    if (lineCoverage(ink, width, height, axis, cross, from, to) >= .58) occupied.push(cross);
  }
  const groups: Array<{ from: number; to: number; center: number; width: number }> = [];
  for (const cross of occupied) {
    const previous = groups.at(-1);
    if (!previous || cross > previous.to + 1) groups.push({ from: cross, to: cross, center: cross, width: 1 });
    else { previous.to = cross; previous.center = (previous.from + previous.to) / 2; previous.width = previous.to - previous.from + 1; }
  }
  return groups;
}

function fourRailWindowEvidence(ink: Uint8Array, width: number, height: number, axis: Axis, center: number, from: number, to: number, thickness: number) {
  const groups = railGroups(ink, width, height, axis, center, from, to, thickness);
  if (groups.length !== 4 || groups.some(group => group.width > Math.max(4, Math.ceil(thickness * .2)))) return false;
  const firstGap = groups[1].center - groups[0].center, middleGap = groups[2].center - groups[1].center, lastGap = groups[3].center - groups[2].center;
  return middleGap <= Math.min(firstGap, lastGap) * .55 && Math.max(firstGap, lastGap) <= Math.min(firstGap, lastGap) * 1.8;
}

function hollowWindowEvidence(ink: Uint8Array, width: number, height: number, a: WallCandidate, b: WallCandidate) {
  const gapFrom = Math.min(a.to, b.to) + 2, gapTo = Math.max(a.from, b.from) - 2;
  return gapTo > gapFrom && fourRailWindowEvidence(ink, width, height, a.axis, (a.center + b.center) / 2, gapFrom, gapTo, Math.max(a.thickness, b.thickness));
}

function candidatePoint(candidate: WallCandidate, atEnd: boolean): SpatialPoint {
  const along = atEnd ? candidate.to : candidate.from;
  return candidate.axis === "horizontal" ? { x: along, y: candidate.center } : { x: candidate.center, y: along };
}

function pointToCandidateDistance(point: SpatialPoint, candidate: WallCandidate) {
  const start = candidatePoint(candidate, false), end = candidatePoint(candidate, true);
  const dx = end.x - start.x, dy = end.y - start.y, lengthSquared = dx * dx + dy * dy;
  const ratio = lengthSquared ? Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared)) : 0;
  return Math.hypot(point.x - start.x - dx * ratio, point.y - start.y - dy * ratio);
}

function outlineWallCandidates(ink: Uint8Array, width: number, height: number, solidWalls: WallCandidate[], minimumRatio: number) {
  if (!solidWalls.length) return [];
  const thicknesses = solidWalls.map(wall => wall.thickness).sort((a, b) => a - b);
  const expectedThickness = thicknesses[Math.floor(thicknesses.length / 2)];
  const thinLimit = Math.max(4, Math.ceil(expectedThickness * .25));
  const strokes = (axis: Axis) => clusterAdjacentRuns(scanCoreRuns(ink, width, height, axis, Math.max(18, (axis === "horizontal" ? width : height) * minimumRatio)), 2).filter(band => band.endAt - band.startAt + 1 <= thinLimit);
  const proposed: WallCandidate[] = [];
  for (const axis of ["horizontal", "vertical"] as const) {
    const lines = strokes(axis);
    for (let first = 0; first < lines.length; first++) for (let second = first + 1; second < lines.length; second++) {
      const a = lines[first], b = lines[second], separation = Math.abs(a.at - b.at);
      if (separation < expectedThickness * .65 || separation > expectedThickness * 1.35) continue;
      const from = Math.max(a.from, b.from), to = Math.min(a.to, b.to), overlap = to - from + 1;
      const shorter = Math.min(a.to - a.from + 1, b.to - b.from + 1);
      if (overlap < Math.max(18, (axis === "horizontal" ? width : height) * minimumRatio) || overlap < shorter * .7) continue;
      const candidate = { axis, center: (a.at + b.at) / 2, from, to, thickness: separation };
      if (!fourRailWindowEvidence(ink, width, height, axis, candidate.center, from, to, separation)) proposed.push(candidate);
    }
  }
  const minX = Math.min(...solidWalls.flatMap(wall => [candidatePoint(wall, false).x, candidatePoint(wall, true).x]));
  const maxX = Math.max(...solidWalls.flatMap(wall => [candidatePoint(wall, false).x, candidatePoint(wall, true).x]));
  const minY = Math.min(...solidWalls.flatMap(wall => [candidatePoint(wall, false).y, candidatePoint(wall, true).y]));
  const maxY = Math.max(...solidWalls.flatMap(wall => [candidatePoint(wall, false).y, candidatePoint(wall, true).y]));
  const bounded = proposed.filter(candidate => {
    const start = candidatePoint(candidate, false), end = candidatePoint(candidate, true);
    if (Math.max(start.x, end.x) < minX - expectedThickness || Math.min(start.x, end.x) > maxX + expectedThickness || Math.max(start.y, end.y) < minY - expectedThickness || Math.min(start.y, end.y) > maxY + expectedThickness) return false;
    return !solidWalls.some(wall => {
      if (wall.axis !== candidate.axis || Math.abs(wall.center - candidate.center) >= expectedThickness * 1.2) return false;
      const overlap = Math.min(wall.to, candidate.to) - Math.max(wall.from, candidate.from) + 1;
      return overlap >= (candidate.to - candidate.from + 1) * .5;
    });
  }).sort((a, b) => Math.abs(a.thickness - expectedThickness) - Math.abs(b.thickness - expectedThickness) || b.to - b.from - (a.to - a.from));
  const deduped: WallCandidate[] = [];
  for (const candidate of bounded) {
    if (deduped.some(existing => existing.axis === candidate.axis && Math.abs(existing.center - candidate.center) <= expectedThickness * .3 && Math.min(existing.to, candidate.to) - Math.max(existing.from, candidate.from) >= Math.min(existing.to - existing.from, candidate.to - candidate.from) * .65)) continue;
    deduped.push(candidate);
  }
  const accepted: WallCandidate[] = [], pending: WallCandidate[] = [], tightDistance = expectedThickness * .85, seedDistance = expectedThickness * 1.65;
  const shadowsAcceptedWall = (candidate: WallCandidate) => accepted.some(wall => {
    if (wall.axis !== candidate.axis || Math.abs(wall.center - candidate.center) >= expectedThickness * 1.25) return false;
    const overlap = Math.min(wall.to, candidate.to) - Math.max(wall.from, candidate.from) + 1;
    return overlap >= (candidate.to - candidate.from + 1) * .5;
  });
  for (const candidate of deduped) {
    if (shadowsAcceptedWall(candidate)) continue;
    const start = candidatePoint(candidate, false), end = candidatePoint(candidate, true);
    const startTight = solidWalls.some(wall => pointToCandidateDistance(start, wall) <= tightDistance), endTight = solidWalls.some(wall => pointToCandidateDistance(end, wall) <= tightDistance);
    const startSeed = solidWalls.some(wall => pointToCandidateDistance(start, wall) <= seedDistance), endSeed = solidWalls.some(wall => pointToCandidateDistance(end, wall) <= seedDistance);
    const longEnoughToSeed = candidate.to - candidate.from >= (candidate.axis === "horizontal" ? width : height) * .16;
    if (startTight && endTight || longEnoughToSeed && (startSeed || endSeed)) accepted.push(candidate); else pending.push(candidate);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (let index = pending.length - 1; index >= 0; index--) {
      const candidate = pending[index], network = [...solidWalls, ...accepted];
      if (shadowsAcceptedWall(candidate)) { pending.splice(index, 1); continue; }
      const startConnected = network.some(wall => pointToCandidateDistance(candidatePoint(candidate, false), wall) <= tightDistance);
      const endConnected = network.some(wall => pointToCandidateDistance(candidatePoint(candidate, true), wall) <= tightDistance);
      if (startConnected && endConnected) { accepted.push(candidate); pending.splice(index, 1); changed = true; }
    }
  }
  return accepted;
}

function trimCornerOverhangs(candidates: WallCandidate[]) {
  const trimmed = candidates.map(candidate => ({ ...candidate }));
  for (const wall of trimmed) {
    for (const endpoint of ["from", "to"] as const) {
      const current = wall[endpoint];
      let nearest: { at: number; distance: number } | null = null;
      for (const crossing of trimmed) {
        if (crossing === wall || crossing.axis === wall.axis) continue;
        const intersectionAlong = crossing.center, intersectionCross = wall.center;
        const tolerance = Math.max(wall.thickness, crossing.thickness) * .8;
        if (intersectionCross < crossing.from - tolerance || intersectionCross > crossing.to + tolerance) continue;
        const distance = Math.abs(current - intersectionAlong);
        if (distance <= tolerance && (!nearest || distance < nearest.distance)) nearest = { at: intersectionAlong, distance };
      }
      if (nearest) wall[endpoint] = nearest.at;
    }
    if (wall.from > wall.to) [wall.from, wall.to] = [wall.to, wall.from];
  }
  return trimmed.filter(wall => wall.to - wall.from >= 2);
}

function bridgeHollowWindows(candidates: WallCandidate[], dark: Uint8Array, width: number, height: number) {
  const walls = candidates.map(candidate => ({ ...candidate }));
  const windows: Array<{ wall: WallCandidate; from: number; to: number }> = [];
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let first = 0; first < walls.length; first++) for (let second = first + 1; second < walls.length; second++) {
      const a = walls[first], b = walls[second];
      if (a.axis !== b.axis) continue;
      const left = a.from <= b.from ? a : b, right = left === a ? b : a;
      const gap = right.from - left.to - 1;
      const axisLength = a.axis === "horizontal" ? width : height;
      if (gap < Math.max(5, Math.min(a.thickness, b.thickness) * .55) || gap > Math.min(axisLength * .16, Math.max(a.thickness, b.thickness) * 18)) continue;
      if (Math.abs(a.center - b.center) > Math.max(3, Math.min(a.thickness, b.thickness) * .55)) continue;
      if (!hollowWindowEvidence(dark, width, height, left, right)) continue;
      const leftLength = left.to - left.from + 1, rightLength = right.to - right.from + 1;
      const merged: WallCandidate = { axis: left.axis, center: (left.center * leftLength + right.center * rightLength) / (leftLength + rightLength), from: left.from, to: right.to, thickness: Math.max(left.thickness, right.thickness) };
      walls[first] = merged;
      walls.splice(second, 1);
      windows.push({ wall: merged, from: left.to + 1, to: right.from - 1 });
      changed = true;
      break outer;
    }
  }
  return { walls, windows };
}

function pointFor(candidate: WallCandidate, along: number): SpatialPoint {
  return candidate.axis === "horizontal" ? { x: along, y: candidate.center } : { x: candidate.center, y: along };
}

export function analyzeFloorPlanPixels(rgba: Uint8ClampedArray, width: number, height: number, options: FloorPlanAnalysisOptions = {}): FloorPlanAnalysis {
  if (rgba.length !== width * height * 4 || width < 40 || height < 40) throw new Error("SPATIAL_ANALYSIS_IMAGE_INVALID");
  const gray = new Uint8Array(width * height);
  for (let pixel = 0; pixel < gray.length; pixel++) {
    const index = pixel * 4, alpha = rgba[index + 3] / 255;
    gray[pixel] = Math.round((rgba[index] * .299 + rgba[index + 1] * .587 + rgba[index + 2] * .114) * alpha + 255 * (1 - alpha));
  }
  const threshold = Math.max(35, Math.min(180, options.darkThreshold ?? otsuThreshold(gray) + 6));
  const dark = new Uint8Array(gray.length), lineInk = new Uint8Array(gray.length);
  for (let index = 0; index < gray.length; index++) { dark[index] = gray[index] < threshold ? 1 : 0; lineInk[index] = gray[index] < Math.max(210, threshold) ? 1 : 0; }

  const minimumThickness = Math.max(2, Math.min(48, Math.round(options.minWallThicknessPixels ?? Math.min(width, height) * .011)));
  const minimumRatio = Math.max(.02, Math.min(.4, options.minWallLengthRatio ?? .045));
  const horizontalCore = buildThicknessCore(dark, width, height, "horizontal", minimumThickness);
  const verticalCore = buildThicknessCore(dark, width, height, "vertical", minimumThickness);
  const horizontalBands = clusterAdjacentRuns(scanCoreRuns(horizontalCore, width, height, "horizontal", Math.max(18, width * minimumRatio)), Math.max(1, Math.floor(minimumThickness * .2)));
  const verticalBands = clusterAdjacentRuns(scanCoreRuns(verticalCore, width, height, "vertical", Math.max(18, height * minimumRatio)), Math.max(1, Math.floor(minimumThickness * .2)));
  const raw: WallCandidate[] = [
    ...horizontalBands.map(band => ({ axis: "horizontal" as const, center: (band.startAt + band.endAt) / 2, from: band.from, to: band.to, thickness: band.endAt - band.startAt + 1 })),
    ...verticalBands.map(band => ({ axis: "vertical" as const, center: (band.startAt + band.endAt) / 2, from: band.from, to: band.to, thickness: band.endAt - band.startAt + 1 })),
  ].filter(candidate => candidate.thickness >= minimumThickness && candidate.to - candidate.from + 1 >= Math.max(18, (candidate.axis === "horizontal" ? width : height) * minimumRatio));
  const outlines = outlineWallCandidates(lineInk, width, height, raw, minimumRatio);
  const joined = trimCornerOverhangs(mergeShortBreaks([...raw, ...outlines], Math.max(2, options.mergeDistancePixels ?? minimumThickness * .6)));
  const bridged = bridgeHollowWindows(joined, lineInk, width, height);
  const detected = options.detectOpenings === false ? { walls: bridged.walls, windows: [] } : bridged;
  if (!detected.walls.length) throw new Error("SPATIAL_ANALYSIS_NO_WALLS");

  const ordered = detected.walls.sort((a, b) => a.axis.localeCompare(b.axis) || a.center - b.center || a.from - b.from).slice(0, 180);
  const walls: SpatialWall[] = ordered.map((candidate, index) => ({ id: `auto_wall_${index + 1}`, start: pointFor(candidate, candidate.from), end: pointFor(candidate, candidate.to), thicknessPixels: candidate.thickness, confidence: .9 }));
  const openings: SpatialOpening[] = [];
  if (options.detectOpenings !== false) for (const window of detected.windows) {
    const wallIndex = ordered.findIndex(candidate => candidate.axis === window.wall.axis && Math.abs(candidate.center - window.wall.center) <= Math.max(3, candidate.thickness * .55) && window.from >= candidate.from && window.to <= candidate.to);
    if (wallIndex < 0) continue;
    const wall = walls[wallIndex], candidate = ordered[wallIndex], length = candidate.to - candidate.from;
    openings.push({ id: `auto_opening_${openings.length + 1}`, zoneId: null, wallId: wall.id, edge: 0, kind: "window", offset: ((window.from + window.to) / 2 - candidate.from) / Math.max(1, length), width: window.to - window.from + 1, height: 1.2, sill: .9, confidence: .86 });
  }
  return {
    zones: [], walls, openings, confidence: Math.min(.97, .58 + walls.length / 160),
    notes: ["实心黑带按墙厚核心生成中心线；两条边界线围成的白芯也作为空心墙。", "细标注、文字和家具轮廓必须接入墙网，不能仅因线段较长而成为墙。", options.detectOpenings === false ? "门窗位置只用于保持墙图连续，不生成门窗对象；请拆分墙边后手动转换。" : "墙段之间的四轨图例（含中间一对平行线）识别为窗洞；门洞和特殊图例仍需手动修正。"],
  };
}

export async function analyzeFloorPlanImage(image: HTMLImageElement, maxDimension = 1600, options: FloorPlanAnalysisOptions = {}) {
  const ratio = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(40, Math.round(image.naturalWidth * ratio)), height = Math.max(40, Math.round(image.naturalHeight * ratio));
  const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("SPATIAL_ANALYSIS_UNAVAILABLE");
  context.drawImage(image, 0, 0, width, height);
  const result = analyzeFloorPlanPixels(context.getImageData(0, 0, width, height).data, width, height, options);
  const sx = image.naturalWidth / width, sy = image.naturalHeight / height, scale = (sx + sy) / 2;
  return {
    ...result,
    walls: result.walls.map(wall => ({ ...wall, start: { x: wall.start.x * sx, y: wall.start.y * sy }, end: { x: wall.end.x * sx, y: wall.end.y * sy }, thicknessPixels: wall.thicknessPixels * scale })),
    openings: result.openings.map(opening => ({ ...opening, width: opening.width * scale })),
  };
}
