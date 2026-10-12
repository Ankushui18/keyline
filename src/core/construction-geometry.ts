import type { VectorDocument } from './document';
import { objectTransformMatrix, transformPoint } from './transforms';
import type { EntityId, Point, Segment } from './types';

export interface DocumentBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface ConstructionLineGeometry {
  segmentId: EntityId;
  extent: 'finite' | 'infinite';
  start: Point;
  end: Point;
}

export interface ConstructionProjection {
  point: Point;
  /** Anchor parameter: finite lines clamp this to [0, 1], infinite lines do not. */
  t: number;
  distance: number;
}

/** Shared screen-space styling consumed by both Canvas 2D and WebGL. */
export const CONSTRUCTION_VISUAL_STYLE = {
  base: {
    color: '#777777',
    opacity: 0.82,
    widthPx: 1,
    dashPx: [4, 4] as const,
    cap: 'butt' as const,
  },
  hover: {
    color: '#f2b968',
    haloColor: '#f0b35b',
    haloOpacity: 0.3,
    widthPx: 1.75,
    haloWidthPx: 7,
    dashPx: [4, 4] as const,
    cap: 'butt' as const,
  },
  selected: {
    color: '#ffffff',
    haloColor: '#ffffff',
    haloOpacity: 0.3,
    widthPx: 1.75,
    haloWidthPx: 7,
    dashPx: [4, 4] as const,
    cap: 'butt' as const,
  },
} as const;

export interface ConstructionStrokePlan {
  segmentId: EntityId;
  extent: 'finite' | 'infinite';
  start: Point;
  end: Point;
  bounds: DocumentBounds;
  style: typeof CONSTRUCTION_VISUAL_STYLE.base;
}

/** Returns a 45°-increment endpoint while preserving drag length. */
export function constrainConstructionLineEndpoint(start: Point, end: Point): Point {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-12) return { ...start };
  const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI / 4;
  return {
    x: start.x + Math.cos(angle) * length,
    y: start.y + Math.sin(angle) * length,
  };
}

/**
 * Resolves authoritative construction anchors into document space. This is
 * derived geometry only: it never adds or mutates graph entities.
 */
export function constructionLineGeometry(
  document: VectorDocument,
  segmentOrId: Segment | EntityId,
): ConstructionLineGeometry | null {
  const segment = typeof segmentOrId === 'string'
    ? document.getSegment(segmentOrId)
    : segmentOrId;
  if (!segment || segment.role !== 'construction' || segment.type !== 'line') return null;
  const startNode = document.getNode(segment.startNodeId);
  const endNode = document.getNode(segment.endNodeId);
  if (!startNode || !endNode || !segment.constructionExtent) return null;
  const object = document.getObjectForSegment(segment.id);
  const matrix = object ? objectTransformMatrix(object.transform) : undefined;
  const start = matrix ? transformPoint(startNode.position, matrix) : { ...startNode.position };
  const end = matrix ? transformPoint(endNode.position, matrix) : { ...endNode.position };
  if (![start.x, start.y, end.x, end.y].every(Number.isFinite) ||
    Math.hypot(end.x - start.x, end.y - start.y) < 1e-9) return null;
  return {
    segmentId: segment.id,
    extent: segment.constructionExtent,
    start,
    end,
  };
}

/** Projects a document-space point onto a finite segment or unbounded line. */
export function projectPointToConstructionLine(
  line: ConstructionLineGeometry,
  point: Point,
): ConstructionProjection {
  const dx = line.end.x - line.start.x;
  const dy = line.end.y - line.start.y;
  const lengthSquared = dx * dx + dy * dy;
  const rawT = lengthSquared > 1e-18
    ? ((point.x - line.start.x) * dx + (point.y - line.start.y) * dy) / lengthSquared
    : 0;
  const t = line.extent === 'finite' ? Math.max(0, Math.min(1, rawT)) : rawT;
  const projected = {
    x: line.start.x + dx * t,
    y: line.start.y + dy * t,
  };
  return {
    point: projected,
    t,
    distance: Math.hypot(point.x - projected.x, point.y - projected.y),
  };
}

/** Returns the finite anchors or the infinite line clipped to document bounds. */
export function constructionLineSpan(
  line: ConstructionLineGeometry,
  bounds: DocumentBounds,
): { start: Point; end: Point } | null {
  if (line.extent === 'finite') {
    return { start: { ...line.start }, end: { ...line.end } };
  }
  return clipInfiniteLineToBounds(line.start, line.end, bounds);
}

/** Shared finite render plan used by Canvas 2D and WebGL parity fixtures. */
export function constructionStrokePlan(
  document: VectorDocument,
  segmentOrId: Segment | EntityId,
  bounds: DocumentBounds,
): ConstructionStrokePlan | null {
  const line = constructionLineGeometry(document, segmentOrId);
  const span = line ? constructionLineSpan(line, bounds) : null;
  if (!line || !span || ![
    span.start.x, span.start.y, span.end.x, span.end.y,
  ].every(Number.isFinite)) return null;
  return {
    segmentId: line.segmentId,
    extent: line.extent,
    start: span.start,
    end: span.end,
    bounds: {
      minX: Math.min(span.start.x, span.end.x),
      minY: Math.min(span.start.y, span.end.y),
      maxX: Math.max(span.start.x, span.end.x),
      maxY: Math.max(span.start.y, span.end.y),
    },
    style: CONSTRUCTION_VISUAL_STYLE.base,
  };
}

/** Deterministic slab clipping for an unbounded mathematical line. */
export function clipInfiniteLineToBounds(
  start: Point,
  end: Point,
  bounds: DocumentBounds,
): { start: Point; end: Point } | null {
  if (![start.x, start.y, end.x, end.y, bounds.minX, bounds.minY, bounds.maxX, bounds.maxY]
    .every(Number.isFinite)) return null;
  if (bounds.maxX < bounds.minX || bounds.maxY < bounds.minY) return null;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (Math.hypot(dx, dy) < 1e-12) return null;

  let tMin = Number.NEGATIVE_INFINITY;
  let tMax = Number.POSITIVE_INFINITY;
  const clipAxis = (origin: number, delta: number, min: number, max: number): boolean => {
    if (Math.abs(delta) < 1e-12) return origin >= min - 1e-9 && origin <= max + 1e-9;
    const first = (min - origin) / delta;
    const second = (max - origin) / delta;
    tMin = Math.max(tMin, Math.min(first, second));
    tMax = Math.min(tMax, Math.max(first, second));
    return tMin <= tMax + 1e-12;
  };
  if (!clipAxis(start.x, dx, bounds.minX, bounds.maxX) ||
    !clipAxis(start.y, dy, bounds.minY, bounds.maxY) ||
    !Number.isFinite(tMin) || !Number.isFinite(tMax)) return null;
  return {
    start: { x: start.x + dx * tMin, y: start.y + dy * tMin },
    end: { x: start.x + dx * tMax, y: start.y + dy * tMax },
  };
}
