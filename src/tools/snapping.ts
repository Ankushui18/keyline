import {
  constructionLineGeometry,
  projectPointToConstructionLine,
} from '../core/construction-geometry';
import type { VectorDocument } from '../core/document';
import { evaluateSegment } from '../core/geometry';
import { objectTransformMatrix, transformPoint } from '../core/transforms';
import type { EntityId, Point, Segment } from '../core/types';

export type SnapKind =
  | 'grid'
  | 'node'
  | 'intersection'
  | 'construction-line'
  | 'midpoint'
  | 'alignment-x'
  | 'alignment-y';

export interface SnapMatch {
  kind: SnapKind;
  point: Point;
  targetId?: EntityId;
}

export interface SnapResult {
  point: Point;
  matches: SnapMatch[];
  guideX?: number;
  guideY?: number;
}

export interface SnapOptions {
  scale: number;
  tolerancePixels?: number;
  gridSize?: number;
  grid?: boolean;
  nodes?: boolean;
  constructionLines?: boolean;
  midpoints?: boolean;
  intersections?: boolean;
  alignment?: boolean;
  excludeNodeIds?: Set<EntityId>;
  /** Excludes owning segments while dragging endpoints, without hiding other guides. */
  excludeSegmentIds?: Set<EntityId>;
}

interface Candidate { kind: SnapKind; point: Point; targetId?: EntityId }

interface IntersectionPrimitive {
  start: Point;
  end: Point;
  unbounded: boolean;
}

interface IntersectionSource {
  segmentId: EntityId;
  construction: boolean;
  segmentType: Segment['type'];
  primitives: IntersectionPrimitive[];
}

/** Shared, non-mutating snapping query. Topology changes only when a caller explicitly commits one. */
export function snapPoint(document: VectorDocument, input: Point, options: SnapOptions): SnapResult {
  const tolerance = (options.tolerancePixels ?? 8) / Math.max(options.scale, 1e-9);
  const candidates: Candidate[] = [];
  const nodeCandidates: Candidate[] = [];
  if (options.nodes !== false || options.alignment !== false) {
    for (const node of document.nodes.values()) {
      if (options.excludeNodeIds?.has(node.id) || !document.isNodeVisible(node.id)) continue;
      const object = document.getObjectForNode(node.id);
      const point = object ? transformPoint(node.position, objectTransformMatrix(object.transform)) : node.position;
      nodeCandidates.push({ kind: 'node', point, targetId: node.id });
    }
    if (options.nodes !== false) candidates.push(...nodeCandidates);
  }

  if (options.intersections !== false) {
    candidates.push(...intersectionCandidates(document, input, tolerance, options.excludeSegmentIds));
  }

  if (options.constructionLines !== false) {
    for (const segment of document.segments.values()) {
      if (segment.role !== 'construction' ||
        options.excludeSegmentIds?.has(segment.id) ||
        !document.isSegmentVisible(segment.id)) continue;
      const line = constructionLineGeometry(document, segment);
      if (!line) continue;
      const projection = projectPointToConstructionLine(line, input);
      if (projection.distance <= tolerance) {
        candidates.push({ kind: 'construction-line', point: projection.point, targetId: segment.id });
      }
    }
  }

  if (options.midpoints !== false) {
    for (const segment of document.segments.values()) {
      if (options.excludeSegmentIds?.has(segment.id) || !document.isSegmentVisible(segment.id)) continue;
      const local = evaluateSegment(document, segment, 0.5);
      const object = document.getObjectForSegment(segment.id);
      const point = object ? transformPoint(local, objectTransformMatrix(object.transform)) : local;
      candidates.push({ kind: 'midpoint', point, targetId: segment.id });
    }
  }

  if (options.grid !== false) {
    const grid = Math.max(1e-6, options.gridSize ?? 10);
    candidates.push({
      kind: 'grid',
      point: { x: Math.round(input.x / grid) * grid, y: Math.round(input.y / grid) * grid },
    });
  }

  let resultPoint = { ...input };
  const matches: SnapMatch[] = [];
  const nearest = candidates
    .map((candidate) => ({ candidate, distance: Math.hypot(candidate.point.x - input.x, candidate.point.y - input.y) }))
    .filter((item) => item.distance <= tolerance)
    .sort((a, b) =>
      snapPriority(a.candidate.kind) - snapPriority(b.candidate.kind) ||
      a.distance - b.distance ||
      (a.candidate.targetId ?? '').localeCompare(b.candidate.targetId ?? ''))[0];
  if (nearest) {
    resultPoint = { ...nearest.candidate.point };
    matches.push(nearest.candidate);
  }

  let guideX: number | undefined;
  let guideY: number | undefined;
  if (!nearest && options.alignment !== false) {
    const xMatch = nodeCandidates
      .map((candidate) => ({ candidate, distance: Math.abs(candidate.point.x - input.x) }))
      .filter((item) => item.distance <= tolerance)
      .sort((a, b) => a.distance - b.distance ||
        (a.candidate.targetId ?? '').localeCompare(b.candidate.targetId ?? ''))[0];
    const yMatch = nodeCandidates
      .map((candidate) => ({ candidate, distance: Math.abs(candidate.point.y - input.y) }))
      .filter((item) => item.distance <= tolerance)
      .sort((a, b) => a.distance - b.distance ||
        (a.candidate.targetId ?? '').localeCompare(b.candidate.targetId ?? ''))[0];
    if (xMatch) {
      resultPoint.x = xMatch.candidate.point.x;
      guideX = resultPoint.x;
      matches.push({ kind: 'alignment-x', point: { x: resultPoint.x, y: input.y }, targetId: xMatch.candidate.targetId });
    }
    if (yMatch) {
      resultPoint.y = yMatch.candidate.point.y;
      guideY = resultPoint.y;
      matches.push({ kind: 'alignment-y', point: { x: input.x, y: resultPoint.y }, targetId: yMatch.candidate.targetId });
    }
  }
  return { point: resultPoint, matches, guideX, guideY };
}

/**
 * Builds document-space intersections. Infinite construction primitives have an
 * unbounded parameter; every other primitive enforces t in [0, 1]. Curves and
 * native arcs use deterministic evaluateSegment sampling before transforms.
 */
function intersectionCandidates(
  document: VectorDocument,
  input: Point,
  tolerance: number,
  excluded?: Set<EntityId>,
): Candidate[] {
  const sources = [...document.segments.values()]
    .filter((segment) => !excluded?.has(segment.id) && document.isSegmentVisible(segment.id))
    .map((segment) => intersectionSource(document, segment))
    .filter((source): source is IntersectionSource => Boolean(source))
    .filter((source) => sourceNearPoint(source, input, tolerance));
  const construction = sources.filter((source) => source.construction);
  const geometry = sources.filter((source) => !source.construction);
  const result: Candidate[] = [];
  const seen = new Set<string>();

  const addPair = (first: IntersectionSource, second: IntersectionSource) => {
    for (const firstPrimitive of first.primitives) {
      for (const secondPrimitive of second.primitives) {
        const point = lineIntersection(firstPrimitive, secondPrimitive);
        if (!point || Math.hypot(point.x - input.x, point.y - input.y) > tolerance) continue;
        const key = `${Math.round(point.x * 1e7)}:${Math.round(point.y * 1e7)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push({
          kind: 'intersection',
          point,
          targetId: first.construction ? first.segmentId : second.construction ? second.segmentId : undefined,
        });
      }
    }
  };

  // Every visible construction line is paired with document-space geometry and
  // with later construction sources exactly once.
  for (let index = 0; index < construction.length; index += 1) {
    for (const other of geometry) addPair(construction[index], other);
    for (let other = index + 1; other < construction.length; other += 1) {
      addPair(construction[index], construction[other]);
    }
  }

  // Preserve the pre-construction geometry-line intersection behavior.
  const geometryLines = geometry.filter((source) => source.segmentType === 'line').slice(0, 500);
  for (let first = 0; first < geometryLines.length; first += 1) {
    for (let second = first + 1; second < geometryLines.length; second += 1) {
      addPair(geometryLines[first], geometryLines[second]);
    }
  }
  return result;
}

function intersectionSource(document: VectorDocument, segment: Segment): IntersectionSource | null {
  if (segment.role === 'construction') {
    const line = constructionLineGeometry(document, segment);
    if (!line) return null;
    return {
      segmentId: segment.id,
      construction: true,
      segmentType: 'line',
      primitives: [{ start: line.start, end: line.end, unbounded: line.extent === 'infinite' }],
    };
  }

  const object = document.getObjectForSegment(segment.id);
  const matrix = object ? objectTransformMatrix(object.transform) : undefined;
  const documentPoint = (t: number): Point => {
    const local = evaluateSegment(document, segment, t);
    return matrix ? transformPoint(local, matrix) : local;
  };
  if (segment.type === 'line') {
    const start = documentPoint(0);
    const end = documentPoint(1);
    if (!finitePrimitive(start, end)) return null;
    return {
      segmentId: segment.id,
      construction: false,
      segmentType: segment.type,
      primitives: [{ start, end, unbounded: false }],
    };
  }

  const steps = 64;
  const points = Array.from({ length: steps + 1 }, (_, index) => documentPoint(index / steps));
  const primitives = points.slice(0, -1)
    .map((start, index) => ({ start, end: points[index + 1], unbounded: false }))
    .filter((primitive) => finitePrimitive(primitive.start, primitive.end));
  if (primitives.length === 0) return null;
  return {
    segmentId: segment.id,
    construction: false,
    segmentType: segment.type,
    primitives,
  };
}

function sourceNearPoint(source: IntersectionSource, point: Point, tolerance: number): boolean {
  return source.primitives.some((primitive) =>
    pointToPrimitiveDistance(point, primitive) <= tolerance + 1e-9);
}

function pointToPrimitiveDistance(point: Point, primitive: IntersectionPrimitive): number {
  const dx = primitive.end.x - primitive.start.x;
  const dy = primitive.end.y - primitive.start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= 1e-18) return Math.hypot(point.x - primitive.start.x, point.y - primitive.start.y);
  const rawT = ((point.x - primitive.start.x) * dx + (point.y - primitive.start.y) * dy) / lengthSquared;
  const t = primitive.unbounded ? rawT : Math.max(0, Math.min(1, rawT));
  return Math.hypot(
    point.x - (primitive.start.x + dx * t),
    point.y - (primitive.start.y + dy * t),
  );
}

function lineIntersection(first: IntersectionPrimitive, second: IntersectionPrimitive): Point | null {
  const r = { x: first.end.x - first.start.x, y: first.end.y - first.start.y };
  const s = { x: second.end.x - second.start.x, y: second.end.y - second.start.y };
  const denominator = r.x * s.y - r.y * s.x;
  if (Math.abs(denominator) < 1e-10) return null;
  const offset = { x: second.start.x - first.start.x, y: second.start.y - first.start.y };
  const t = (offset.x * s.y - offset.y * s.x) / denominator;
  const u = (offset.x * r.y - offset.y * r.x) / denominator;
  if ((!first.unbounded && !insideFiniteDomain(t)) ||
    (!second.unbounded && !insideFiniteDomain(u))) return null;
  return { x: first.start.x + t * r.x, y: first.start.y + t * r.y };
}

function insideFiniteDomain(parameter: number): boolean {
  return parameter >= -1e-9 && parameter <= 1 + 1e-9;
}

function finitePrimitive(start: Point, end: Point): boolean {
  return [start.x, start.y, end.x, end.y].every(Number.isFinite) &&
    Math.hypot(end.x - start.x, end.y - start.y) > 1e-12;
}

function snapPriority(kind: SnapKind): number {
  if (kind === 'node') return 0;
  if (kind === 'intersection') return 1;
  if (kind === 'construction-line') return 2;
  if (kind === 'midpoint') return 3;
  return 4;
}
