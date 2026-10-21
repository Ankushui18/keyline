import { palette } from '../design-system/tokens';
import type { VectorDocument } from './document';
import type { AppearanceFill, EntityId, GradientStop, Point } from './types';

/**
 * Gradient fills — the helpers that keep the model honest (§3.8 of docs/EDITING-AUDIT.md).
 *
 * Every gradient carries at least two stops, sorted and clamped. `normalizeStops` is the
 * only place that is enforced, so the renderer, the exporter and the inspector can trust
 * the invariant instead of re-checking it. Coordinates are object-local, exactly like node
 * positions, which is why rendering and export need no extra conversion beyond the matrix
 * they already hold.
 */

export const MIN_GRADIENT_STOPS = 2;

/** The two inks a new gradient runs between, taken from the palette rather than typed in. */
const GRADIENT_START = palette.white;
const GRADIENT_END = palette.graphite950;
const GRADIENT_FALLBACK = palette.black;

/** The colour used wherever a single ink is needed (fallbacks, legends, tests). */
export function fillColor(fill: AppearanceFill): string {
  if (fill.type === 'solid') return fill.color;
  return normalizeStops(fill.stops)[0].color;
}

export function isGradientFill(fill: AppearanceFill): fill is Extract<AppearanceFill, { type: 'linear' | 'radial' }> {
  return fill.type !== 'solid';
}

/** Sorted, clamped, at least two stops, opaque-by-default. Never returns an empty list. */
export function normalizeStops(stops: readonly Partial<GradientStop>[] | undefined): GradientStop[] {
  const cleaned = (stops ?? [])
    .filter((stop): stop is Partial<GradientStop> => Boolean(stop))
    .map((stop) => ({
      offset: clamp01(typeof stop.offset === 'number' && Number.isFinite(stop.offset) ? stop.offset : 0),
      color: typeof stop.color === 'string' && stop.color.trim() ? stop.color : GRADIENT_FALLBACK,
      opacity: clamp01(typeof stop.opacity === 'number' && Number.isFinite(stop.opacity) ? stop.opacity : 1),
    }))
    .sort((left, right) => left.offset - right.offset);
  if (cleaned.length >= MIN_GRADIENT_STOPS) return cleaned;
  if (cleaned.length === 1) {
    // Pad towards the side that leaves a visible span, so a lone stop at 100% still shows.
    const stop = cleaned[0];
    return stop.offset >= 0.5 ? [{ ...stop, offset: 0 }, stop] : [stop, { ...stop, offset: 1 }];
  }
  return [
    { offset: 0, color: GRADIENT_FALLBACK, opacity: 1 },
    { offset: 1, color: GRADIENT_START, opacity: 1 },
  ];
}

/**
 * Fills carry a stops array, so a shallow `{ ...fill }` would alias it between an
 * appearance and its copy. Every clone site goes through here instead.
 */
export function cloneFill(fill: AppearanceFill): AppearanceFill {
  if (fill.type === 'solid') return { ...fill };
  // Cloning is also the normalisation point: every write path goes through a clone, so a
  // gradient can never reach the document with unsorted, out-of-range or single stops.
  const stops = normalizeStops(fill.stops);
  return fill.type === 'linear'
    ? { ...fill, start: { ...fill.start }, end: { ...fill.end }, stops }
    : { ...fill, center: { ...fill.center }, stops };
}

export function cloneFills(fills: readonly AppearanceFill[]): AppearanceFill[] {
  return fills.map(cloneFill);
}

/** The colour a gradient shows at `t`, used by previews and by the canvas fallback. */
export function gradientColorAt(fill: AppearanceFill, t: number): string {
  if (fill.type === 'solid') return fill.color;
  const stops = normalizeStops(fill.stops);
  const offset = clamp01(t);
  for (let index = 0; index < stops.length - 1; index += 1) {
    const left = stops[index];
    const right = stops[index + 1];
    if (offset < left.offset || offset > right.offset) continue;
    const span = right.offset - left.offset;
    const local = span <= 1e-9 ? 0 : (offset - left.offset) / span;
    return mixHex(left.color, right.color, local);
  }
  return offset <= stops[0].offset ? stops[0].color : stops[stops.length - 1].color;
}

/**
 * The object's bounding box **without** its transform, from anchor positions. This is the
 * box gradients are seeded into and the box `objectBoundingBox` import units are multiplied
 * by. It never influences geometry, and it deliberately ignores handles: a control point
 * beyond the path should not move a gradient that was already placed.
 */
export function objectLocalBounds(
  document: VectorDocument,
  objectId: EntityId,
): { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number } | undefined {
  const object = document.getObject(objectId);
  const network = object ? document.getNetwork(object.networkId) : undefined;
  if (!network) return undefined;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const nodeId of network.nodeIds) {
    const node = document.getNode(nodeId);
    if (!node) continue;
    minX = Math.min(minX, node.position.x);
    minY = Math.min(minY, node.position.y);
    maxX = Math.max(maxX, node.position.x);
    maxY = Math.max(maxY, node.position.y);
  }
  if (!Number.isFinite(minX)) return undefined;
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/** A new linear gradient across the object, at `angle` degrees clockwise from +x. */
export function defaultLinearGradient(
  document: VectorDocument,
  objectId: EntityId,
  angle = 90,
  colors: { from: string; to: string } = { from: GRADIENT_START, to: GRADIENT_END },
  opacity = 1,
): Extract<AppearanceFill, { type: 'linear' }> {
  const bounds = objectLocalBounds(document, objectId) ?? { minX: 0, minY: 0, maxX: 1, maxY: 1, width: 1, height: 1 };
  const radians = angle * Math.PI / 180;
  // The span is half the box diagonal so either angle covers the shape from edge to edge.
  const half = Math.max(1e-6, Math.hypot(bounds.width, bounds.height) / 2);
  const center = { x: bounds.minX + bounds.width / 2, y: bounds.minY + bounds.height / 2 };
  const vector = { x: Math.cos(radians) * half, y: Math.sin(radians) * half };
  return {
    type: 'linear',
    start: { x: center.x - vector.x, y: center.y - vector.y },
    end: { x: center.x + vector.x, y: center.y + vector.y },
    stops: [{ offset: 0, color: colors.from, opacity: 1 }, { offset: 1, color: colors.to, opacity: 1 }],
    opacity,
    visible: true,
  };
}

export function defaultRadialGradient(
  document: VectorDocument,
  objectId: EntityId,
  colors: { from: string; to: string } = { from: GRADIENT_START, to: GRADIENT_END },
  opacity = 1,
): Extract<AppearanceFill, { type: 'radial' }> {
  const bounds = objectLocalBounds(document, objectId) ?? { minX: 0, minY: 0, maxX: 1, maxY: 1, width: 1, height: 1 };
  return {
    type: 'radial',
    center: { x: bounds.minX + bounds.width / 2, y: bounds.minY + bounds.height / 2 },
    radius: Math.max(1e-6, Math.hypot(bounds.width, bounds.height) / 2),
    stops: [{ offset: 0, color: colors.from, opacity: 1 }, { offset: 1, color: colors.to, opacity: 1 }],
    opacity,
    visible: true,
  };
}

/** The angle of a linear gradient, for the inspector's degree field. */
export function linearGradientAngle(fill: AppearanceFill): number {
  if (fill.type !== 'linear') return 0;
  const degrees = Math.atan2(fill.end.y - fill.start.y, fill.end.x - fill.start.x) * 180 / Math.PI;
  return Math.round(((degrees % 360) + 360) % 360);
}

/** Rotates a linear gradient about its own midpoint, keeping its span. */
export function rotateLinearGradient(
  fill: Extract<AppearanceFill, { type: 'linear' }>,
  angle: number,
): Extract<AppearanceFill, { type: 'linear' }> {
  const center = { x: (fill.start.x + fill.end.x) / 2, y: (fill.start.y + fill.end.y) / 2 };
  const half = Math.max(1e-6, Math.hypot(fill.end.x - fill.start.x, fill.end.y - fill.start.y) / 2);
  const radians = angle * Math.PI / 180;
  const vector = { x: Math.cos(radians) * half, y: Math.sin(radians) * half };
  return {
    ...fill,
    start: { x: center.x - vector.x, y: center.y - vector.y },
    end: { x: center.x + vector.x, y: center.y + vector.y },
  };
}

/**
 * The CSS `background` value for the inspector swatch: one string the browser and the
 * tests agree on, so a test can assert what the user actually sees.
 */
export function fillPreviewStyle(fill: AppearanceFill): string {
  if (fill.type === 'solid') return fill.color;
  const stops = normalizeStops(fill.stops)
    .map((stop) => `${withOpacity(stop.color, stop.opacity)} ${Math.round(stop.offset * 100)}%`)
    .join(', ');
  return fill.type === 'linear'
    ? `linear-gradient(${linearGradientAngle(fill)}deg, ${stops})`
    : `radial-gradient(circle at 50% 50%, ${stops})`;
}

function withOpacity(color: string, opacity: number): string {
  if (opacity >= 1) return color;
  const match = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (!match) return color;
  const value = Number.parseInt(match[1], 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${Number(opacity.toFixed(3))})`;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function mixHex(from: string, to: string, amount: number): string {
  const left = parseHex(from);
  const right = parseHex(to);
  if (!left || !right) return from;
  const channel = (a: number, b: number) => Math.round(a + (b - a) * amount);
  return `#${[channel(left[0], right[0]), channel(left[1], right[1]), channel(left[2], right[2])]
    .map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

function parseHex(color: string): [number, number, number] | undefined {
  const match = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (!match) return undefined;
  const value = Number.parseInt(match[1], 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/** World-space endpoints for export, given the source→document matrix of one occurrence. */
export function transformedGradientPoints(
  fill: AppearanceFill,
  matrix: { a: number; b: number; c: number; d: number; e: number; f: number },
): { start?: Point; end?: Point; center?: Point; radius?: number } {
  const apply = (point: Point) => ({
    x: matrix.a * point.x + matrix.c * point.y + matrix.e,
    y: matrix.b * point.x + matrix.d * point.y + matrix.f,
  });
  if (fill.type === 'linear') return { start: apply(fill.start), end: apply(fill.end) };
  if (fill.type === 'radial') {
    return { center: apply(fill.center), radius: fill.radius * Math.sqrt(Math.abs(matrix.a * matrix.d - matrix.b * matrix.c)) || fill.radius };
  }
  return {};
}
