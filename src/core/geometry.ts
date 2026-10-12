import type { VectorDocument } from './document';
import type { Point, Segment } from './types';

export interface CubicCurve {
  p0: Point;
  p1: Point;
  p2: Point;
  p3: Point;
}

export interface CurveSample {
  t: number;
  point: Point;
}

export interface LineIntersection {
  point: Point;
  tA: number;
  tB: number;
}

export function isNativeArc(segment: Segment): boolean {
  return segment.type === 'arc' &&
    segment.center !== undefined &&
    Number.isFinite(segment.center.x) &&
    Number.isFinite(segment.center.y) &&
    Number.isFinite(segment.radius) &&
    (segment.radius ?? 0) > 0 &&
    Number.isFinite(segment.startAngle) &&
    Number.isFinite(segment.endAngle);
}

export function arcSweep(segment: Segment): number {
  if (!isNativeArc(segment)) return 0;
  let sweep = (segment.endAngle ?? 0) - (segment.startAngle ?? 0);
  if (segment.clockwise && sweep > 0) sweep -= Math.PI * 2;
  if (!segment.clockwise && sweep < 0) sweep += Math.PI * 2;
  return sweep;
}

export function arcPoint(segment: Segment, t: number): Point {
  if (!isNativeArc(segment)) return { x: 0, y: 0 };
  const angle = (segment.startAngle ?? 0) + arcSweep(segment) * clamp(t, 0, 1);
  return {
    x: segment.center!.x + segment.radius! * Math.cos(angle),
    y: segment.center!.y + segment.radius! * Math.sin(angle),
  };
}

export function arcTangent(segment: Segment, t: number): Point {
  const angle = (segment.startAngle ?? 0) + arcSweep(segment) * clamp(t, 0, 1);
  const direction = Math.sign(arcSweep(segment)) || 1;
  return { x: -Math.sin(angle) * direction, y: Math.cos(angle) * direction };
}

export function segmentCurve(document: VectorDocument, segment: Segment): CubicCurve | null {
  const start = document.getNode(segment.startNodeId);
  const end = document.getNode(segment.endNodeId);
  if (!start || !end) return null;
  return {
    p0: { ...start.position },
    p1: segment.type === 'bezier' ? { ...(start.handleOut ?? start.position) } : { ...start.position },
    p2: segment.type === 'bezier' ? { ...(end.handleIn ?? end.position) } : { ...end.position },
    p3: { ...end.position },
  };
}

export function evaluateCubic(curve: CubicCurve, t: number): Point {
  const mt = 1 - t;
  return {
    x: mt ** 3 * curve.p0.x + 3 * mt ** 2 * t * curve.p1.x + 3 * mt * t ** 2 * curve.p2.x + t ** 3 * curve.p3.x,
    y: mt ** 3 * curve.p0.y + 3 * mt ** 2 * t * curve.p1.y + 3 * mt * t ** 2 * curve.p2.y + t ** 3 * curve.p3.y,
  };
}

export function evaluateSegment(document: VectorDocument, segment: Segment, t: number): Point {
  if (isNativeArc(segment)) return arcPoint(segment, t);
  const curve = segmentCurve(document, segment);
  if (!curve) return { x: 0, y: 0 };
  if (segment.type !== 'bezier') return lerp(curve.p0, curve.p3, t);
  return evaluateCubic(curve, t);
}

export function flattenSegment(
  document: VectorDocument,
  segment: Segment,
  forcedSteps?: number,
): CurveSample[] {
  if (isNativeArc(segment)) {
    const steps = forcedSteps ?? clamp(Math.ceil(Math.abs(arcSweep(segment) * segment.radius!) / 8), 8, 144);
    return Array.from({ length: steps + 1 }, (_, index) => {
      const t = index / steps;
      return { t, point: arcPoint(segment, t) };
    });
  }
  const curve = segmentCurve(document, segment);
  if (!curve) return [];
  if (segment.type !== 'bezier') return [{ t: 0, point: curve.p0 }, { t: 1, point: curve.p3 }];

  const controlLength =
    distance(curve.p0, curve.p1) + distance(curve.p1, curve.p2) + distance(curve.p2, curve.p3);
  const steps = forcedSteps ?? clamp(Math.ceil(controlLength / 10), 16, 72);
  return Array.from({ length: steps + 1 }, (_, index) => {
    const t = index / steps;
    return { t, point: evaluateCubic(curve, t) };
  });
}

export function closestPointOnSegment(
  document: VectorDocument,
  segment: Segment,
  point: Point,
): { point: Point; t: number; distance: number } | null {
  const samples = flattenSegment(document, segment, segment.type === 'bezier' ? 64 : undefined);
  if (samples.length < 2) return null;
  let best = { point: samples[0].point, t: 0, distance: distance(point, samples[0].point) };

  for (let index = 0; index < samples.length - 1; index += 1) {
    const a = samples[index];
    const b = samples[index + 1];
    const projection = projectPointToLineSegment(point, a.point, b.point);
    const t = a.t + (b.t - a.t) * projection.t;
    const candidate = evaluateSegment(document, segment, t);
    const candidateDistance = distance(point, candidate);
    if (candidateDistance < best.distance) best = { point: candidate, t, distance: candidateDistance };
  }
  return best;
}

export function intersectSegmentWithLine(
  document: VectorDocument,
  segment: Segment,
  lineStart: Point,
  lineEnd: Point,
): Array<{ point: Point; segmentT: number; lineT: number }> {
  const samples = flattenSegment(document, segment, segment.type === 'bezier' ? 72 : undefined);
  const intersections: Array<{ point: Point; segmentT: number; lineT: number }> = [];
  for (let index = 0; index < samples.length - 1; index += 1) {
    const a = samples[index];
    const b = samples[index + 1];
    const hit = lineSegmentIntersection(a.point, b.point, lineStart, lineEnd);
    if (!hit) continue;
    const segmentT = a.t + (b.t - a.t) * hit.tA;
    if (intersections.some((item) => Math.abs(item.segmentT - segmentT) < 1e-4)) continue;
    intersections.push({
      point: evaluateSegment(document, segment, segmentT),
      segmentT,
      lineT: hit.tB,
    });
  }
  return intersections.sort((a, b) => a.lineT - b.lineT);
}

export function lineSegmentIntersection(a: Point, b: Point, c: Point, d: Point): LineIntersection | null {
  const r = subtract(b, a);
  const s = subtract(d, c);
  const denominator = cross(r, s);
  const cma = subtract(c, a);
  if (Math.abs(denominator) < 1e-9) return null;
  const tA = cross(cma, s) / denominator;
  const tB = cross(cma, r) / denominator;
  if (tA < -1e-7 || tA > 1 + 1e-7 || tB < -1e-7 || tB > 1 + 1e-7) return null;
  return {
    point: { x: a.x + r.x * tA, y: a.y + r.y * tA },
    tA: clamp(tA, 0, 1),
    tB: clamp(tB, 0, 1),
  };
}

export function splitCubic(curve: CubicCurve, t: number): [CubicCurve, CubicCurve] {
  const a = lerp(curve.p0, curve.p1, t);
  const b = lerp(curve.p1, curve.p2, t);
  const c = lerp(curve.p2, curve.p3, t);
  const d = lerp(a, b, t);
  const e = lerp(b, c, t);
  const f = lerp(d, e, t);
  return [
    { p0: curve.p0, p1: a, p2: d, p3: f },
    { p0: f, p1: e, p2: c, p3: curve.p3 },
  ];
}

export function cubicSubcurve(curve: CubicCurve, startT: number, endT: number): CubicCurve {
  const start = clamp(Math.min(startT, endT), 0, 1);
  const end = clamp(Math.max(startT, endT), 0, 1);
  if (start <= 1e-9 && end >= 1 - 1e-9) return cloneCurve(curve);
  const [left] = splitCubic(curve, end);
  if (start <= 1e-9) return left;
  const relative = end <= 1e-9 ? 0 : start / end;
  return splitCubic(left, relative)[1];
}

export function reverseCubic(curve: CubicCurve): CubicCurve {
  return { p0: curve.p3, p1: curve.p2, p2: curve.p1, p3: curve.p0 };
}

export function pointInPolygon(point: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    const intersects = ((a.y > point.y) !== (b.y > point.y)) &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y || Number.EPSILON) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

export function polygonArea(points: Point[]): number {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    area += current.x * next.y - next.x * current.y;
  }
  return area / 2;
}

export function lerp(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function pointKey(point: Point, precision = 1e-4): string {
  return `${Math.round(point.x / precision)},${Math.round(point.y / precision)}`;
}

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

function projectPointToLineSegment(point: Point, start: Point, end: Point): { point: Point; t: number } {
  const delta = subtract(end, start);
  const lengthSquared = delta.x ** 2 + delta.y ** 2;
  const t = lengthSquared === 0
    ? 0
    : clamp(((point.x - start.x) * delta.x + (point.y - start.y) * delta.y) / lengthSquared, 0, 1);
  return { point: { x: start.x + delta.x * t, y: start.y + delta.y * t }, t };
}

function subtract(a: Point, b: Point): Point {
  return { x: a.x - b.x, y: a.y - b.y };
}

function cross(a: Point, b: Point): number {
  return a.x * b.y - a.y * b.x;
}

function cloneCurve(curve: CubicCurve): CubicCurve {
  return { p0: { ...curve.p0 }, p1: { ...curve.p1 }, p2: { ...curve.p2 }, p3: { ...curve.p3 } };
}
