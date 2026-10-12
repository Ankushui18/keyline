import type { VectorDocument } from '../core/document';
import { closestPointOnSegment, evaluateSegment } from '../core/geometry';
import { createEntityId } from '../core/ids';
import type { EntityId, Point, Segment, WidthPoint } from '../core/types';

export interface WidthHandle {
  segmentId: EntityId;
  pointId: EntityId;
  kind: 'position' | 'size';
  side: -1 | 1;
  position: Point;
}

export function addWidthPoint(
  document: VectorDocument,
  segment: Segment,
  position: Point,
  defaultWidth?: number,
): WidthPoint | null {
  const closest = closestPointOnSegment(document, segment, position);
  if (!closest) return null;
  const t = clamp(closest.t, 0, 1);
  return {
    id: createEntityId(),
    t,
    // Sampling the current profile prevents a newly inserted point from changing
    // the stroke before the designer intentionally drags it.
    width: Math.max(0.5, defaultWidth ?? (segment.widthProfile?.length ? sampleWidthProfile(segment.widthProfile, t) : 12)),
  };
}

/** Smooth interpolation shared by Canvas and export so width editing is visually stable. */
export function sampleWidthProfile(
  widthProfile: WidthPoint[] | undefined,
  t: number,
  baselineWidth = 1.25,
): number {
  const profile = (widthProfile ?? [])
    .map((point) => ({ t: clamp(point.t, 0, 1), width: Math.max(0.5, point.width) }))
    .sort((a, b) => a.t - b.t);
  if (!profile.some((point) => point.t <= 1e-9)) profile.unshift({ t: 0, width: baselineWidth });
  if (!profile.some((point) => point.t >= 1 - 1e-9)) profile.push({ t: 1, width: baselineWidth });
  const clampedT = clamp(t, 0, 1);
  const rightIndex = profile.findIndex((point) => point.t >= clampedT);
  if (rightIndex <= 0) return profile[0]?.width ?? baselineWidth;
  if (rightIndex < 0) return profile.at(-1)?.width ?? baselineWidth;
  const left = profile[rightIndex - 1];
  const right = profile[rightIndex];
  if (Math.abs(right.t - left.t) < 1e-12) return right.width;
  const linear = (clampedT - left.t) / (right.t - left.t);
  const smooth = linear * linear * (3 - 2 * linear);
  return left.width + (right.width - left.width) * smooth;
}

export function widthHandlesForSegment(document: VectorDocument, segment: Segment): WidthHandle[] {
  return (segment.widthProfile ?? []).flatMap((widthPoint) => {
    const center = evaluateSegment(document, segment, widthPoint.t);
    const normal = segmentNormal(document, segment, widthPoint.t);
    const half = widthPoint.width / 2;
    return [
      { segmentId: segment.id, pointId: widthPoint.id, kind: 'position', side: 1, position: center },
      { segmentId: segment.id, pointId: widthPoint.id, kind: 'size', side: 1, position: add(center, scale(normal, half)) },
      { segmentId: segment.id, pointId: widthPoint.id, kind: 'size', side: -1, position: add(center, scale(normal, -half)) },
    ];
  });
}

export function hitTestWidthHandle(
  document: VectorDocument,
  point: Point,
  tolerance: number,
): WidthHandle | null {
  let best: { handle: WidthHandle; distance: number } | null = null;
  for (const segment of document.segments.values()) {
    for (const handle of widthHandlesForSegment(document, segment)) {
      const candidateDistance = distance(handle.position, point);
      if (candidateDistance <= tolerance && (!best || candidateDistance < best.distance)) {
        best = { handle, distance: candidateDistance };
      }
    }
  }
  return best?.handle ?? null;
}

export function updateWidthPoint(
  document: VectorDocument,
  segment: Segment,
  pointId: EntityId,
  kind: 'position' | 'size',
  side: -1 | 1,
  cursor: Point,
): WidthPoint[] {
  const profile = (segment.widthProfile ?? []).map((point) => ({ ...point }));
  const index = profile.findIndex((point) => point.id === pointId);
  if (index < 0) return profile;
  const current = profile[index];
  if (kind === 'position') {
    const closest = closestPointOnSegment(document, segment, cursor);
    if (closest) current.t = clamp(closest.t, 0, 1);
  } else {
    const center = evaluateSegment(document, segment, current.t);
    const normal = segmentNormal(document, segment, current.t);
    current.width = Math.max(0.5, 2 * Math.abs(dot(subtract(cursor, center), scale(normal, side))));
  }
  return profile.sort((a, b) => a.t - b.t || a.id.localeCompare(b.id));
}

export function segmentNormal(document: VectorDocument, segment: Segment, t: number): Point {
  const epsilon = 1e-4;
  const before = evaluateSegment(document, segment, Math.max(0, t - epsilon));
  const after = evaluateSegment(document, segment, Math.min(1, t + epsilon));
  const tangent = normalize(subtract(after, before));
  return { x: -tangent.y, y: tangent.x };
}

function add(a: Point, b: Point): Point { return { x: a.x + b.x, y: a.y + b.y }; }
function subtract(a: Point, b: Point): Point { return { x: a.x - b.x, y: a.y - b.y }; }
function scale(point: Point, factor: number): Point { return { x: point.x * factor, y: point.y * factor }; }
function dot(a: Point, b: Point): number { return a.x * b.x + a.y * b.y; }
function distance(a: Point, b: Point): number { return Math.hypot(a.x - b.x, a.y - b.y); }
function normalize(point: Point): Point {
  const length = Math.hypot(point.x, point.y);
  return length > 1e-12 ? scale(point, 1 / length) : { x: 1, y: 0 };
}
function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
