import type { FillRule, Point, Region, RegionBoundaryLoop } from './types';

const EPSILON = 1e-9;

/** Returns compound loops while retaining compatibility with pre-Gate-C snapshots. */
export function regionBoundaryLoops(region: Region): RegionBoundaryLoop[] {
  if (region.outerLoop?.outline.length >= 3) return [region.outerLoop, ...(region.innerLoops ?? [])];
  const outline = region.outline ?? [];
  if (outline.length < 3) return [];
  return [{
    boundarySegmentIds: [...region.boundarySegmentIds],
    boundaryEdges: region.boundaryEdges?.map(cloneEdge) ?? [],
    outline: outline.map(clonePoint),
    signedArea: signedPolygonArea(outline),
  }];
}

/** Region hit testing uses exactly the same explicit rule as every renderer. */
export function regionContainsPoint(region: Region, point: Point): boolean {
  const loops = regionBoundaryLoops(region);
  if (loops.length === 0) return false;
  if ((region.fillRule ?? 'nonzero') === 'evenodd') {
    let inside = false;
    for (const loop of loops) {
      if (pointOnPolygon(point, loop.outline)) return true;
      if (windingNumber(point, loop.outline) !== 0) inside = !inside;
    }
    return inside;
  }
  let winding = 0;
  for (const loop of loops) {
    if (pointOnPolygon(point, loop.outline)) return true;
    winding += windingNumber(point, loop.outline);
  }
  return winding !== 0;
}

/**
 * Deterministic scan-band tessellation for simple compound polygons. It handles
 * concavity and arbitrarily nested hole rings without introducing authoritative
 * topology or relying on browser-specific tessellators.
 */
export function triangulateRegionLoops(
  loops: ReadonlyArray<ReadonlyArray<Point>>,
  fillRule: FillRule,
): Point[] {
  const cleanLoops = loops.map(cleanPolygon).filter((loop) => loop.length >= 3);
  const yLevels = [...new Set(cleanLoops.flatMap((loop) => loop.map((point) => point.y)))]
    .sort((a, b) => a - b);
  const triangles: Point[] = [];

  for (let band = 0; band < yLevels.length - 1; band += 1) {
    const top = yLevels[band];
    const bottom = yLevels[band + 1];
    if (bottom - top <= EPSILON) continue;
    const middle = (top + bottom) / 2;
    const events: ScanEvent[] = [];

    for (const loop of cleanLoops) {
      for (let index = 0; index < loop.length; index += 1) {
        const start = loop[index];
        const end = loop[(index + 1) % loop.length];
        if (Math.abs(end.y - start.y) <= EPSILON) continue;
        const minY = Math.min(start.y, end.y);
        const maxY = Math.max(start.y, end.y);
        if (middle <= minY || middle >= maxY) continue;
        events.push({
          start,
          end,
          xMiddle: edgeXAtY(start, end, middle),
          winding: end.y > start.y ? 1 : -1,
        });
      }
    }
    events.sort((a, b) => a.xMiddle - b.xMiddle || a.winding - b.winding);

    let parity = 0;
    let winding = 0;
    for (let index = 0; index < events.length - 1; index += 1) {
      const event = events[index];
      parity ^= 1;
      winding += event.winding;
      const filled = fillRule === 'evenodd' ? parity === 1 : winding !== 0;
      if (!filled) continue;
      const next = events[index + 1];
      if (next.xMiddle - event.xMiddle <= EPSILON) continue;

      const leftTop = { x: edgeXAtY(event.start, event.end, top), y: top };
      const leftBottom = { x: edgeXAtY(event.start, event.end, bottom), y: bottom };
      const rightTop = { x: edgeXAtY(next.start, next.end, top), y: top };
      const rightBottom = { x: edgeXAtY(next.start, next.end, bottom), y: bottom };
      appendTriangle(triangles, leftTop, rightTop, rightBottom);
      appendTriangle(triangles, leftTop, rightBottom, leftBottom);
    }
  }
  return triangles;
}

export function signedPolygonArea(points: ReadonlyArray<Point>): number {
  let sum = 0;
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    const next = points[(index + 1) % points.length];
    sum += point.x * next.y - next.x * point.y;
  }
  return sum / 2;
}

export function polygonInteriorPoint(points: ReadonlyArray<Point>): Point {
  const polygon = cleanPolygon(points);
  if (polygon.length < 3) return polygon[0] ? clonePoint(polygon[0]) : { x: 0, y: 0 };
  const orientation = signedPolygonArea(polygon) >= 0 ? 1 : -1;
  const scale = Math.max(
    1,
    Math.max(...polygon.map((point) => point.x)) - Math.min(...polygon.map((point) => point.x)),
    Math.max(...polygon.map((point) => point.y)) - Math.min(...polygon.map((point) => point.y)),
  );
  for (let index = 0; index < polygon.length; index += 1) {
    const start = polygon[index];
    const end = polygon[(index + 1) % polygon.length];
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.hypot(dx, dy);
    if (length <= EPSILON) continue;
    // Positive canvas-coordinate area is clockwise, whose interior is the right normal.
    const normal = orientation > 0
      ? { x: -dy / length, y: dx / length }
      : { x: dy / length, y: -dx / length };
    const candidate = {
      x: (start.x + end.x) / 2 + normal.x * scale * 1e-6,
      y: (start.y + end.y) / 2 + normal.y * scale * 1e-6,
    };
    if (windingNumber(candidate, polygon) !== 0) return candidate;
  }
  return clonePoint(polygon[0]);
}

export function windingNumber(point: Point, polygon: ReadonlyArray<Point>): number {
  let winding = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const start = polygon[index];
    const end = polygon[(index + 1) % polygon.length];
    if (start.y <= point.y) {
      if (end.y > point.y && cross(start, end, point) > EPSILON) winding += 1;
    } else if (end.y <= point.y && cross(start, end, point) < -EPSILON) {
      winding -= 1;
    }
  }
  return winding;
}

interface ScanEvent {
  start: Point;
  end: Point;
  xMiddle: number;
  winding: number;
}

function edgeXAtY(start: Point, end: Point, y: number): number {
  if (Math.abs(end.y - start.y) <= EPSILON) return Math.min(start.x, end.x);
  const t = (y - start.y) / (end.y - start.y);
  return start.x + (end.x - start.x) * Math.max(0, Math.min(1, t));
}

function appendTriangle(output: Point[], a: Point, b: Point, c: Point): void {
  if (Math.abs(cross(a, b, c)) <= EPSILON) return;
  output.push(a, b, c);
}

function pointOnPolygon(point: Point, polygon: ReadonlyArray<Point>): boolean {
  for (let index = 0; index < polygon.length; index += 1) {
    const start = polygon[index];
    const end = polygon[(index + 1) % polygon.length];
    const area = Math.abs(cross(start, end, point));
    const scale = Math.max(1, Math.hypot(end.x - start.x, end.y - start.y));
    if (area > 1e-8 * scale) continue;
    if (point.x >= Math.min(start.x, end.x) - 1e-8 && point.x <= Math.max(start.x, end.x) + 1e-8 &&
      point.y >= Math.min(start.y, end.y) - 1e-8 && point.y <= Math.max(start.y, end.y) + 1e-8) return true;
  }
  return false;
}

function cleanPolygon(points: ReadonlyArray<Point>): Point[] {
  const result = points.map(clonePoint);
  if (result.length > 1 && samePoint(result[0], result.at(-1)!)) result.pop();
  return result;
}

function cross(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function samePoint(a: Point, b: Point): boolean {
  return Math.abs(a.x - b.x) <= EPSILON && Math.abs(a.y - b.y) <= EPSILON;
}

function clonePoint(point: Point): Point {
  return { x: point.x, y: point.y };
}

function cloneEdge<T extends { start: Point; end: Point }>(edge: T): T {
  return { ...edge, start: clonePoint(edge.start), end: clonePoint(edge.end) };
}
