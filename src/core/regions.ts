import type { VectorDocument } from './document';
import {
  cubicSubcurve,
  distance,
  evaluateCubic,
  evaluateSegment,
  flattenSegment,
  lineSegmentIntersection,
  pointKey,
  polygonArea,
  reverseCubic,
  segmentCurve,
} from './geometry';
import { polygonInteriorPoint, signedPolygonArea, windingNumber } from './region-geometry';
import type {
  EntityId,
  Point,
  Region,
  RegionBoundaryEdge,
  RegionBoundaryLoop,
  Segment,
} from './types';

const INTERSECTION_TOLERANCE = 1e-7;
const OVERLAP_TOLERANCE = 1e-5;

interface SegmentCut {
  t: number;
  point: Point;
}

interface FlatPiece {
  segment: Segment;
  start: { t: number; point: Point };
  end: { t: number; point: Point };
  networkId: EntityId;
  pathId?: EntityId;
  bounds: PieceBounds;
}

interface PieceBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface Vertex {
  key: string;
  point: Point;
  outgoing: number[];
}

interface HalfEdge {
  index: number;
  from: string;
  to: string;
  twin: number;
  angle: number;
  boundary: RegionBoundaryEdge;
}

interface DetectedRing {
  networkId: EntityId;
  loop: RegionBoundaryLoop;
  area: number;
}

export type RegionDiagnosticCode = 'ambiguous-overlap' | 'self-intersection' | 'invalid-boundary';

export interface RegionDiagnostic {
  code: RegionDiagnosticCode;
  severity: 'warning' | 'error';
  message: string;
  segmentIds: EntityId[];
  point?: Point;
}

export interface RegionDetectionStats {
  sourceSegments: number;
  flattenedPieces: number;
  theoreticalPairs: number;
  candidatePairs: number;
  exactIntersectionTests: number;
}

export interface RegionDetectionResult {
  regions: Region[];
  diagnostics: RegionDiagnostic[];
  stats: RegionDetectionStats;
}

/** Compatibility entry point used by existing callers. */
export function detectRegions(document: VectorDocument): Region[] {
  return detectRegionsDetailed(document).regions;
}

/**
 * Builds a planar half-edge arrangement from line, Bézier, and circular-arc
 * fragments, then walks bounded rings and associates immediate nested rings as
 * holes. Regions remain derived data: source topology is never changed here.
 */
export function detectRegionsDetailed(document: VectorDocument): RegionDetectionResult {
  if (document.segments.size === 0) {
    return {
      regions: [],
      diagnostics: [],
      stats: { sourceSegments: 0, flattenedPieces: 0, theoreticalPairs: 0, candidatePairs: 0, exactIntersectionTests: 0 },
    };
  }

  const networkBySegmentId = new Map<EntityId, EntityId>();
  const pathBySegmentId = new Map<EntityId, EntityId>();
  for (const network of document.networks) {
    for (const pathId of network.pathIds) {
      for (const segmentId of document.getPath(pathId)?.segmentIds ?? []) {
        networkBySegmentId.set(segmentId, network.id);
        pathBySegmentId.set(segmentId, pathId);
      }
    }
  }

  const cuts = new Map<EntityId, SegmentCut[]>();
  const pieces: FlatPiece[] = [];
  let sourceSegments = 0;
  for (const segment of document.segments.values()) {
    // Construction filtering occurs before flattening and broad-phase work.
    if (segment.role === 'construction') continue;
    sourceSegments += 1;
    const samples = flattenSegment(document, segment);
    if (samples.length < 2) continue;
    cuts.set(segment.id, [
      { t: 0, point: { ...samples[0].point } },
      { t: 1, point: { ...samples.at(-1)!.point } },
    ]);
    const networkId = networkBySegmentId.get(segment.id) ?? 'unowned';
    const pathId = pathBySegmentId.get(segment.id);
    for (let index = 0; index < samples.length - 1; index += 1) {
      const start = samples[index];
      const end = samples[index + 1];
      pieces.push({
        segment,
        start,
        end,
        networkId,
        pathId,
        bounds: pieceBounds(start.point, end.point),
      });
    }
  }

  const diagnosticMap = new Map<string, RegionDiagnostic>();
  const candidatePairs = broadPhasePairs(pieces);
  let exactIntersectionTests = 0;
  for (const [aIndex, bIndex] of candidatePairs) {
    const a = pieces[aIndex];
    const b = pieces[bIndex];
    if (a.segment.id === b.segment.id || a.networkId !== b.networkId) continue;
    exactIntersectionTests += 1;

    if (collinearOverlap(a.start.point, a.end.point, b.start.point, b.end.point)) {
      addDiagnostic(diagnosticMap, {
        code: 'ambiguous-overlap',
        severity: 'error',
        message: 'Ambiguous overlapping boundaries cannot define a stable Smart Fill region.',
        segmentIds: [a.segment.id, b.segment.id].sort(),
      });
      continue;
    }

    const hit = lineSegmentIntersection(a.start.point, a.end.point, b.start.point, b.end.point);
    if (!hit) continue;
    const aT = a.start.t + (a.end.t - a.start.t) * hit.tA;
    const bT = b.start.t + (b.end.t - b.start.t) * hit.tB;
    addCut(cuts.get(a.segment.id)!, { t: aT, point: hit.point });
    addCut(cuts.get(b.segment.id)!, { t: bT, point: hit.point });

    if (a.pathId && a.pathId === b.pathId &&
      aT > INTERSECTION_TOLERANCE && aT < 1 - INTERSECTION_TOLERANCE &&
      bT > INTERSECTION_TOLERANCE && bT < 1 - INTERSECTION_TOLERANCE) {
      addDiagnostic(diagnosticMap, {
        code: 'self-intersection',
        severity: 'warning',
        message: 'Self-intersecting boundary detected; Smart Fill produced atomic faces where the path crosses itself.',
        segmentIds: [a.segment.id, b.segment.id].sort(),
        point: { ...hit.point },
      });
    }
  }

  const vertices = new Map<string, Vertex>();
  const halfEdges: HalfEdge[] = [];
  const geometricFragments = new Map<string, Point[]>();

  for (const segment of document.segments.values()) {
    if (segment.role === 'construction') continue;
    const segmentCuts = normalizeCuts(cuts.get(segment.id) ?? []);
    for (let index = 0; index < segmentCuts.length - 1; index += 1) {
      const start = segmentCuts[index];
      const end = segmentCuts[index + 1];
      if (end.t - start.t < INTERSECTION_TOLERANCE || distance(start.point, end.point) < 1e-6) continue;

      const midpoint = evaluateSegment(document, segment, (start.t + end.t) / 2);
      const endpointKeys = [pointKey(start.point), pointKey(end.point)].sort();
      const networkId = networkBySegmentId.get(segment.id) ?? 'unowned';
      const geometryKey = `${networkId}:${endpointKeys.join('|')}`;
      const matchingMidpoints = geometricFragments.get(geometryKey) ?? [];
      if (matchingMidpoints.some((point) => distance(point, midpoint) < 0.35)) continue;
      matchingMidpoints.push(midpoint);
      geometricFragments.set(geometryKey, matchingMidpoints);

      const from = ensureVertex(vertices, start.point, networkId);
      const to = ensureVertex(vertices, end.point, networkId);
      const forwardIndex = halfEdges.length;
      const reverseIndex = forwardIndex + 1;
      const common = { segmentId: segment.id, tStart: start.t, tEnd: end.t };
      halfEdges.push({
        index: forwardIndex,
        from: from.key,
        to: to.key,
        twin: reverseIndex,
        angle: Math.atan2(to.point.y - from.point.y, to.point.x - from.point.x),
        boundary: { ...common, reversed: false, start: { ...from.point }, end: { ...to.point } },
      });
      halfEdges.push({
        index: reverseIndex,
        from: to.key,
        to: from.key,
        twin: forwardIndex,
        angle: Math.atan2(from.point.y - to.point.y, from.point.x - to.point.x),
        boundary: { ...common, reversed: true, start: { ...to.point }, end: { ...from.point } },
      });
      from.outgoing.push(forwardIndex);
      to.outgoing.push(reverseIndex);
    }
  }

  for (const vertex of vertices.values()) {
    vertex.outgoing.sort((a, b) => halfEdges[a].angle - halfEdges[b].angle);
  }

  const visited = new Set<number>();
  const rings: DetectedRing[] = [];
  for (const initial of halfEdges) {
    if (visited.has(initial.index)) continue;
    const cycle: HalfEdge[] = [];
    let current = initial;
    let closed = false;

    for (let guard = 0; guard <= halfEdges.length + 1; guard += 1) {
      if (visited.has(current.index)) {
        closed = current.index === initial.index;
        break;
      }
      visited.add(current.index);
      cycle.push(current);
      const destination = vertices.get(current.to)!;
      const twinPosition = destination.outgoing.indexOf(current.twin);
      if (twinPosition < 0 || destination.outgoing.length < 2) break;
      const nextPosition = (twinPosition - 1 + destination.outgoing.length) % destination.outgoing.length;
      current = halfEdges[destination.outgoing[nextPosition]];
      if (current.index === initial.index) {
        closed = true;
        break;
      }
    }

    if (!closed || cycle.length < 2) continue;
    const boundaries = cycle.map((edge) => edge.boundary);
    const outline = outlineForBoundaries(document, boundaries);
    const area = polygonArea(outline);
    // Canvas coordinates point down, so clockwise bounded faces have positive area.
    if (area <= 1e-3) continue;
    const networkId = networkBySegmentId.get(boundaries[0].segmentId) ?? 'unowned';
    rings.push({
      networkId,
      area,
      loop: {
        boundarySegmentIds: boundaries.map((boundary) => boundary.segmentId),
        boundaryEdges: boundaries.map(cloneBoundary),
        outline: outline.map((point) => ({ ...point })),
        signedArea: signedPolygonArea(outline),
      },
    });
  }

  const previousState = new Map(document.regions.map((region) => [region.id, {
    fill: region.fill ? { ...region.fill } : undefined,
    fillRule: region.fillRule ?? 'nonzero' as const,
  }]));
  const parentIndexes = rings.map((ring, childIndex) => {
    const sample = polygonInteriorPoint(ring.loop.outline);
    let parentIndex = -1;
    let parentArea = Number.POSITIVE_INFINITY;
    for (let candidateIndex = 0; candidateIndex < rings.length; candidateIndex += 1) {
      if (candidateIndex === childIndex) continue;
      const candidate = rings[candidateIndex];
      if (candidate.networkId !== ring.networkId || candidate.area <= ring.area + 1e-6 || candidate.area >= parentArea) continue;
      if (windingNumber(sample, candidate.loop.outline) === 0) continue;
      parentIndex = candidateIndex;
      parentArea = candidate.area;
    }
    return parentIndex;
  });

  const childIndexes = new Map<number, number[]>();
  parentIndexes.forEach((parentIndex, childIndex) => {
    if (parentIndex < 0) return;
    const children = childIndexes.get(parentIndex) ?? [];
    children.push(childIndex);
    childIndexes.set(parentIndex, children);
  });

  const regions: Region[] = [];
  const usedIds = new Set<string>();
  rings.forEach((ring, ringIndex) => {
    const innerLoops = (childIndexes.get(ringIndex) ?? [])
      .map((index) => reverseBoundaryLoop(rings[index].loop))
      .sort((a, b) => Math.abs(b.signedArea) - Math.abs(a.signedArea));
    const allSegmentIds = [
      ...ring.loop.boundarySegmentIds,
      ...innerLoops.flatMap((loop) => loop.boundarySegmentIds),
    ];
    let id = stableRegionId(allSegmentIds);
    if (usedIds.has(id)) {
      const ordered = canonicalCycle(allSegmentIds);
      id = `${id}_${hashString(ordered.join(','))}`;
    }
    usedIds.add(id);
    const previous = previousState.get(id);
    const boundaryEdges = [ring.loop, ...innerLoops].flatMap((loop) => loop.boundaryEdges.map(cloneBoundary));
    regions.push({
      id,
      boundarySegmentIds: [...new Set(allSegmentIds)],
      fill: previous?.fill,
      fillRule: previous?.fillRule ?? 'nonzero',
      outerLoop: cloneBoundaryLoop(ring.loop),
      innerLoops: innerLoops.map(cloneBoundaryLoop),
      boundaryEdges,
      outline: ring.loop.outline.map((point) => ({ ...point })),
      area: Math.max(0, ring.area - innerLoops.reduce((sum, loop) => sum + Math.abs(loop.signedArea), 0)),
    });
  });

  for (const [vertexKey, vertex] of vertices) {
    if (vertex.outgoing.length !== 1) continue;
    const edge = halfEdges[vertex.outgoing[0]];
    const pathId = pathBySegmentId.get(edge.boundary.segmentId);
    // Ordinary open paths are valid artwork. Diagnose only a path explicitly
    // marked closed whose arrangement nevertheless has a dangling endpoint.
    if (!pathId || !document.getPath(pathId)?.isClosed) continue;
    addDiagnostic(diagnosticMap, {
      code: 'invalid-boundary',
      severity: 'warning',
      message: 'Invalid closed boundary has a dangling endpoint and cannot define a stable Smart Fill region.',
      segmentIds: [edge.boundary.segmentId],
      point: { ...vertex.point },
    }, vertexKey);
  }

  const theoreticalPairs = theoreticalPairCountByNetwork(pieces);
  return {
    regions: regions.sort((a, b) => (b.area ?? 0) - (a.area ?? 0) || a.id.localeCompare(b.id)),
    diagnostics: [...diagnosticMap.values()].sort((a, b) =>
      a.code.localeCompare(b.code) || a.segmentIds.join(',').localeCompare(b.segmentIds.join(','))),
    stats: {
      sourceSegments,
      flattenedPieces: pieces.length,
      theoreticalPairs,
      candidatePairs: candidatePairs.length,
      exactIntersectionTests,
    },
  };
}

export function stableRegionId(segmentIds: EntityId[]): EntityId {
  return `region_${hashString([...segmentIds].sort().join(','))}`;
}

/** Sweep-and-prune broad phase: exact tests run only for overlapping piece AABBs in one network. */
function broadPhasePairs(pieces: FlatPiece[]): Array<[number, number]> {
  const byNetwork = new Map<EntityId, number[]>();
  pieces.forEach((piece, index) => {
    const indexes = byNetwork.get(piece.networkId) ?? [];
    indexes.push(index);
    byNetwork.set(piece.networkId, indexes);
  });
  const pairs: Array<[number, number]> = [];
  for (const indexes of byNetwork.values()) {
    indexes.sort((a, b) => pieces[a].bounds.minX - pieces[b].bounds.minX || a - b);
    const active: number[] = [];
    for (const index of indexes) {
      const current = pieces[index];
      for (let activeIndex = active.length - 1; activeIndex >= 0; activeIndex -= 1) {
        if (pieces[active[activeIndex]].bounds.maxX < current.bounds.minX - OVERLAP_TOLERANCE) {
          active.splice(activeIndex, 1);
        }
      }
      for (const candidate of active) {
        if (!boundsOverlap(pieces[candidate].bounds, current.bounds)) continue;
        pairs.push(candidate < index ? [candidate, index] : [index, candidate]);
      }
      active.push(index);
    }
  }
  pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return pairs;
}

function outlineForBoundaries(document: VectorDocument, boundaries: RegionBoundaryEdge[]): Point[] {
  const points: Point[] = [];
  for (const boundary of boundaries) {
    const segment = document.getSegment(boundary.segmentId);
    if (!segment) continue;
    if (segment.type === 'line') {
      if (points.length === 0) points.push({ ...boundary.start });
      points.push({ ...boundary.end });
      continue;
    }
    if (segment.type === 'bezier') {
      const curve = segmentCurve(document, segment);
      if (!curve) continue;
      let subcurve = cubicSubcurve(curve, boundary.tStart, boundary.tEnd);
      if (boundary.reversed) subcurve = reverseCubic(subcurve);
      const steps = Math.max(4, Math.ceil(12 * (boundary.tEnd - boundary.tStart)));
      for (let index = points.length === 0 ? 0 : 1; index <= steps; index += 1) {
        points.push(evaluateCubic(subcurve, index / steps));
      }
      continue;
    }
    const steps = Math.max(4, Math.ceil(24 * Math.abs(boundary.tEnd - boundary.tStart)));
    for (let index = points.length === 0 ? 0 : 1; index <= steps; index += 1) {
      const fraction = index / steps;
      const forwardT = boundary.tStart + (boundary.tEnd - boundary.tStart) * fraction;
      const reverseT = boundary.tEnd - (boundary.tEnd - boundary.tStart) * fraction;
      points.push(evaluateSegment(document, segment, boundary.reversed ? reverseT : forwardT));
    }
  }
  if (points.length > 1 && distance(points[0], points.at(-1)!) < 1e-5) points.pop();
  return points;
}

function reverseBoundaryLoop(loop: RegionBoundaryLoop): RegionBoundaryLoop {
  const boundaryEdges = [...loop.boundaryEdges].reverse().map((edge) => ({
    ...edge,
    reversed: !edge.reversed,
    start: { ...edge.end },
    end: { ...edge.start },
  }));
  const outline = [...loop.outline].reverse().map((point) => ({ ...point }));
  return {
    boundarySegmentIds: boundaryEdges.map((edge) => edge.segmentId),
    boundaryEdges,
    outline,
    signedArea: signedPolygonArea(outline),
  };
}

function cloneBoundaryLoop(loop: RegionBoundaryLoop): RegionBoundaryLoop {
  return {
    boundarySegmentIds: [...loop.boundarySegmentIds],
    boundaryEdges: loop.boundaryEdges.map(cloneBoundary),
    outline: loop.outline.map((point) => ({ ...point })),
    signedArea: loop.signedArea,
  };
}

function addCut(cuts: SegmentCut[], cut: SegmentCut): void {
  const existing = cuts.find((item) => Math.abs(item.t - cut.t) < 1e-5);
  if (existing) {
    if (cut.t > 1e-6 && cut.t < 1 - 1e-6) existing.point = { ...cut.point };
    return;
  }
  cuts.push({ t: Math.max(0, Math.min(1, cut.t)), point: { ...cut.point } });
}

function normalizeCuts(cuts: SegmentCut[]): SegmentCut[] {
  const sorted = [...cuts].sort((a, b) => a.t - b.t);
  const normalized: SegmentCut[] = [];
  for (const cut of sorted) {
    const previous = normalized.at(-1);
    if (previous && Math.abs(previous.t - cut.t) < 1e-5) continue;
    normalized.push(cut);
  }
  return normalized;
}

function ensureVertex(vertices: Map<string, Vertex>, point: Point, networkId: EntityId): Vertex {
  const key = `${networkId}:${pointKey(point)}`;
  let vertex = vertices.get(key);
  if (!vertex) {
    vertex = { key, point: { ...point }, outgoing: [] };
    vertices.set(key, vertex);
  }
  return vertex;
}

function cloneBoundary(boundary: RegionBoundaryEdge): RegionBoundaryEdge {
  return { ...boundary, start: { ...boundary.start }, end: { ...boundary.end } };
}

function pieceBounds(start: Point, end: Point): PieceBounds {
  return {
    minX: Math.min(start.x, end.x),
    minY: Math.min(start.y, end.y),
    maxX: Math.max(start.x, end.x),
    maxY: Math.max(start.y, end.y),
  };
}

function boundsOverlap(a: PieceBounds, b: PieceBounds): boolean {
  return a.minX <= b.maxX + OVERLAP_TOLERANCE && a.maxX + OVERLAP_TOLERANCE >= b.minX &&
    a.minY <= b.maxY + OVERLAP_TOLERANCE && a.maxY + OVERLAP_TOLERANCE >= b.minY;
}

function collinearOverlap(aStart: Point, aEnd: Point, bStart: Point, bEnd: Point): boolean {
  const ax = aEnd.x - aStart.x;
  const ay = aEnd.y - aStart.y;
  const length = Math.hypot(ax, ay);
  if (length <= OVERLAP_TOLERANCE) return false;
  const distanceToLine = (point: Point) => Math.abs(ax * (point.y - aStart.y) - ay * (point.x - aStart.x)) / length;
  if (distanceToLine(bStart) > OVERLAP_TOLERANCE || distanceToLine(bEnd) > OVERLAP_TOLERANCE) return false;
  const dominantX = Math.abs(ax) >= Math.abs(ay);
  const a0 = dominantX ? aStart.x : aStart.y;
  const a1 = dominantX ? aEnd.x : aEnd.y;
  const b0 = dominantX ? bStart.x : bStart.y;
  const b1 = dominantX ? bEnd.x : bEnd.y;
  const overlap = Math.min(Math.max(a0, a1), Math.max(b0, b1)) - Math.max(Math.min(a0, a1), Math.min(b0, b1));
  return overlap > OVERLAP_TOLERANCE;
}

function addDiagnostic(
  diagnostics: Map<string, RegionDiagnostic>,
  diagnostic: RegionDiagnostic,
  suffix = '',
): void {
  const key = `${diagnostic.code}:${diagnostic.segmentIds.join(',')}:${suffix}`;
  if (!diagnostics.has(key)) diagnostics.set(key, diagnostic);
}

function theoreticalPairCountByNetwork(pieces: FlatPiece[]): number {
  const counts = new Map<EntityId, number>();
  for (const piece of pieces) counts.set(piece.networkId, (counts.get(piece.networkId) ?? 0) + 1);
  return [...counts.values()].reduce((sum, count) => sum + count * (count - 1) / 2, 0);
}

function canonicalCycle(ids: string[]): string[] {
  if (ids.length === 0) return [];
  const variants: string[][] = [];
  for (const source of [ids, [...ids].reverse()]) {
    for (let index = 0; index < source.length; index += 1) {
      variants.push([...source.slice(index), ...source.slice(0, index)]);
    }
  }
  variants.sort((a, b) => a.join(',').localeCompare(b.join(',')));
  return variants[0];
}

/** 64-bit FNV-1a rendered as a deterministic compact hexadecimal string. */
function hashString(value: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * prime);
  }
  return hash.toString(16).padStart(16, '0');
}
