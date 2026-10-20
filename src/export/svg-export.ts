import type { VectorDocument } from '../core/document';
import { arcSweep } from '../core/geometry';
import { parametricGroupsForRegion, parametricInstanceMatrices } from '../core/parametric';
import { regionBoundaryLoops } from '../core/region-geometry';
import { isArtworkFillPath } from '../core/segment-semantics';
import {
  IDENTITY_MATRIX,
  isIdentityMatrix,
  matrixScale,
  multiplyMatrices,
  objectTransformMatrix,
  transformPoint,
  type Matrix2D,
} from '../core/transforms';
import type { EntityId, Point, Region, Segment } from '../core/types';
import { sampleWidthProfile } from '../tools/width-tool';
import {
  DEFAULT_STROKE_COLOR,
} from '../design-system/document-defaults';

export type ExportBoundsMode = 'artboard' | 'artwork';

export interface SvgExportOptions {
  precision?: number;
  padding?: number;
  /** Export a specific artboard without mutating the document's active location. */
  artboardId?: EntityId;
  exportBoundsMode?: ExportBoundsMode;
  strokeColor?: string;
  fillColor?: string;
  strokeWidth?: number;
  backgroundColor?: string;
  includeMetadata?: boolean;
}

export interface ConcreteSegment {
  segment: Segment;
  start: Point;
  end: Point;
  handleOut?: Point;
  handleIn?: Point;
  objectId?: EntityId;
  /** Source-to-document transform, retained so non-uniformly scaled arcs evaluate exactly. */
  transform?: Matrix2D;
  sourceSegment?: Segment;
}

export function constructionLinesExcludedCount(document: VectorDocument): number {
  return [...document.segments.values()].filter((segment) => segment.role === 'construction').length;
}

/** Generates a dependency-free SVG with solved coordinates and concrete group instances. */
export function exportDocumentToSvg(document: VectorDocument, options: SvgExportOptions = {}): string {
  const precision = options.precision ?? 3;
  const padding = options.padding ?? 8;
  const boundsMode = options.exportBoundsMode ?? 'artboard';
  const includeMetadata = options.includeMetadata ?? false;
  const strokeColor = options.strokeColor ?? DEFAULT_STROKE_COLOR;
  const strokeWidth = options.strokeWidth ?? 1.25;
  const artboard = options.artboardId
    ? document.getArtboard(options.artboardId)
    : document.activeArtboard;
  if (!artboard || artboard.isCanvasRoot) throw new Error('Export requires a visible artboard.');
  const artboardObjects = document.objectsForArtboard(artboard.id);
  const activeObjectIds = new Set(artboardObjects.map((object) => object.id));
  const activeNetworkSegmentIds = new Set(artboardObjects
    .flatMap((object) => document.getNetwork(object.networkId)?.pathIds ?? [])
    .flatMap((pathId) => document.getPath(pathId)?.segmentIds ?? []));
  const offset = boundsMode === 'artboard'
    ? { x: -artboard.frame.x, y: -artboard.frame.y }
    : { x: 0, y: 0 };
  const artworkSegments = concreteDocumentSegments(document)
    .filter((item) => item.segment.role === 'geometry')
    .filter((item) => item.objectId ? activeObjectIds.has(item.objectId) : activeNetworkSegmentIds.has(item.segment.id))
    .map((item) => translateConcreteSegment(item, offset));
  const activeRegions = document.regions.filter((region) =>
    isExportableRegion(document, region) && regionBelongsToActiveArtboard(document, region, activeObjectIds, activeNetworkSegmentIds));
  const translatedRegionOccurrences = new Map<EntityId, Point[][][]>();
  for (const region of activeRegions) {
    translatedRegionOccurrences.set(
      region.id,
      regionDocumentLoopOccurrences(document, region)
        .map((loops) => loops.map((loop) => loop.map((point) => ({
          x: point.x + offset.x,
          y: point.y + offset.y,
        })))),
    );
  }

  const boundsPoints: Point[] = [];
  for (const item of artworkSegments) {
    if (item.segment.widthProfile && item.segment.widthProfile.length > 0) {
      boundsPoints.push(...variableWidthOutline(item));
    } else {
      for (let index = 0; index <= 24; index += 1) {
        boundsPoints.push(evaluateConcreteSegment(item, index / 24));
      }
    }
  }
  for (const loops of translatedRegionOccurrences.values()) boundsPoints.push(...loops.flat(2));

  const hasArtworkBounds = boundsPoints.length > 0;
  const bounds = pointBounds(boundsPoints);
  const viewport = boundsMode === 'artboard'
    ? { minX: 0, minY: 0, width: artboard.frame.width, height: artboard.frame.height }
    : {
        minX: hasArtworkBounds ? bounds.minX - padding : 0,
        minY: hasArtworkBounds ? bounds.minY - padding : 0,
        width: hasArtworkBounds ? Math.max(1, bounds.maxX - bounds.minX + padding * 2) : 1,
        height: hasArtworkBounds ? Math.max(1, bounds.maxY - bounds.minY + padding * 2) : 1,
      };
  const format = (value: number) => formatNumber(value, precision);
  const body: string[] = [];
  const definitions: string[] = [];
  let resourceId = 0;
  const alignedStrokeBySegment = new Map<ConcreteSegment, { attribute: string; widthScale: number }>();

  if (options.backgroundColor) {
    body.push(`<rect x="${format(viewport.minX)}" y="${format(viewport.minY)}" width="${format(viewport.width)}" height="${format(viewport.height)}" fill="${escapeAttribute(options.backgroundColor)}"/>`);
  }

  const concreteBySegmentId = new Map<EntityId, ConcreteSegment[]>();
  for (const item of artworkSegments) {
    const occurrences = concreteBySegmentId.get(item.segment.id) ?? [];
    occurrences.push(item);
    concreteBySegmentId.set(item.segment.id, occurrences);
  }
  for (const object of document.objectsForArtboard(artboard.id)) {
    const appearance = document.getAppearance(object.appearanceId);
    const stroke = appearance?.stroke;
    const network = document.getNetwork(object.networkId);
    if (!stroke?.visible || stroke.alignment === 'center' || !network) continue;
    for (const pathId of network.pathIds) {
      const path = document.getPath(pathId);
      if (!path?.isClosed || path.segmentIds.length === 0 || path.segmentIds.some((segmentId) => Boolean(document.getSegment(segmentId)?.widthProfile?.length))) continue;
      const occurrenceCount = Math.min(...path.segmentIds.map((segmentId) => concreteBySegmentId.get(segmentId)?.length ?? 0));
      for (let occurrence = 0; occurrence < occurrenceCount; occurrence += 1) {
        const items = path.segmentIds.map((segmentId) => concreteBySegmentId.get(segmentId)?.[occurrence])
          .filter((item): item is ConcreteSegment => Boolean(item));
        if (items.length !== path.segmentIds.length || items.length === 0) continue;
        const data = `M${format(items[0].start.x)} ${format(items[0].start.y)}${items.map((item) => segmentCommand(item, format)).join('')}Z`;
        const id = `paint-${++resourceId}`;
        if (stroke.alignment === 'inside') {
          definitions.push(`<clipPath id="${id}"><path d="${data}" fill-rule="nonzero"/></clipPath>`);
          items.forEach((item) => alignedStrokeBySegment.set(item, { attribute: ` clip-path="url(#${id})"`, widthScale: 2 }));
        } else {
          definitions.push(`<mask id="${id}" maskUnits="userSpaceOnUse" x="${format(viewport.minX)}" y="${format(viewport.minY)}" width="${format(viewport.width)}" height="${format(viewport.height)}"><rect x="${format(viewport.minX)}" y="${format(viewport.minY)}" width="${format(viewport.width)}" height="${format(viewport.height)}" fill="white"/><path d="${data}" fill="black" fill-rule="nonzero"/></mask>`);
          items.forEach((item) => alignedStrokeBySegment.set(item, { attribute: ` mask="url(#${id})"`, widthScale: 2 }));
        }
      }
    }
  }
  for (const object of document.objectsForArtboard(artboard.id)) {
    const appearance = document.getAppearance(object.appearanceId);
    const fills = appearance?.fills.filter((fill) => fill.visible && fill.opacity > 0) ?? [];
    const network = document.getNetwork(object.networkId);
    if (!appearance || appearance.opacity <= 0 || fills.length === 0 || !network) continue;
    for (const pathId of network.pathIds) {
      const path = document.getPath(pathId);
      if (!path || !isArtworkFillPath(document, path)) continue;
      const occurrenceCount = Math.min(...path.segmentIds.map((segmentId) => concreteBySegmentId.get(segmentId)?.length ?? 0));
      for (let occurrence = 0; occurrence < occurrenceCount; occurrence += 1) {
        const items = path.segmentIds.map((segmentId) => concreteBySegmentId.get(segmentId)?.[occurrence])
          .filter((item): item is ConcreteSegment => Boolean(item));
        if (items.length === 0) continue;
        const data = `M${format(items[0].start.x)} ${format(items[0].start.y)}${items.map((item) => segmentCommand(item, format)).join('')}Z`;
        for (const fill of fills) {
          const opacity = appearance.opacity * fill.opacity;
          const opacityAttribute = opacity < 1 ? ` fill-opacity="${format(opacity)}"` : '';
          const objectAttribute = includeMetadata ? ` data-object-id="${escapeAttribute(object.id)}"` : '';
          body.push(`<path d="${data}" fill="${escapeAttribute(options.fillColor ?? fill.color)}"${opacityAttribute}${objectAttribute}/>`);
        }
      }
    }
  }

  for (const region of activeRegions) {
    if (!region.fill || region.boundarySegmentIds.some((segmentId) => !document.isSegmentVisible(segmentId))) continue;
    const color = options.fillColor ?? region.fill.color;
    for (const [occurrence, loops] of (translatedRegionOccurrences.get(region.id) ?? []).entries()) {
      const data = loops.map((loop) => polygonPath(loop, format)).join('');
      const regionAttributes = includeMetadata
        ? ` data-region-id="${escapeAttribute(region.id)}"${occurrence > 0 ? ` data-parametric-instance="${occurrence}"` : ''}`
        : '';
      body.push(`<path d="${data}" fill="${escapeAttribute(color)}" fill-rule="${region.fillRule === 'evenodd' ? 'evenodd' : 'nonzero'}"${regionAttributes}/>`);
    }
  }

  for (const concrete of artworkSegments) {
    const object = concrete.objectId ? document.getObject(concrete.objectId) : undefined;
    const appearance = object ? document.getAppearance(object.appearanceId) : undefined;
    const objectStroke = appearance?.stroke;
    if (objectStroke && (!objectStroke.visible || objectStroke.opacity <= 0 || appearance!.opacity <= 0)) continue;
    const resolvedColor = options.strokeColor ?? objectStroke?.color ?? strokeColor;
    const strokeScale = concrete.transform
      ? (matrixScale(concrete.transform).x + matrixScale(concrete.transform).y) / 2
      : 1;
    const alignment = alignedStrokeBySegment.get(concrete);
    const resolvedWidth = (options.strokeWidth ?? objectStroke?.width ?? strokeWidth) * strokeScale * (alignment?.widthScale ?? 1);
    const opacity = (appearance?.opacity ?? 1) * (objectStroke?.opacity ?? 1);
    const opacityAttribute = opacity < 1 ? ` stroke-opacity="${format(opacity)}"` : '';
    const segmentAttribute = includeMetadata
      ? ` data-segment-id="${escapeAttribute(concrete.segment.id)}"`
      : '';
    if (concrete.segment.widthProfile && concrete.segment.widthProfile.length > 0) {
      const outline = variableWidthOutline(concrete);
      if (outline.length >= 3) {
        const fillOpacity = opacity < 1 ? ` fill-opacity="${format(opacity)}"` : '';
        body.push(`<path d="${polygonPath(outline, format)}" fill="${escapeAttribute(resolvedColor)}"${fillOpacity}${segmentAttribute}/>`);
      }
      continue;
    }
    const dash = objectStroke?.dash.length
      ? ` stroke-dasharray="${objectStroke.dash.map((value) => format(value * strokeScale)).join(' ')}"`
      : '';
    body.push(`<path d="${segmentPath(concrete, format)}" fill="none" stroke="${escapeAttribute(resolvedColor)}" stroke-width="${format(resolvedWidth)}" stroke-linecap="${objectStroke?.cap === 'butt' || objectStroke?.cap === 'square' ? objectStroke.cap : 'round'}" stroke-linejoin="${objectStroke?.join === 'miter' || objectStroke?.join === 'bevel' ? objectStroke.join : 'round'}"${dash}${opacityAttribute}${alignment?.attribute ?? ''}${segmentAttribute}/>`);
  }

  const metadata = includeMetadata
    ? `<metadata>${escapeText(JSON.stringify({ generator: 'Keyline', documentId: document.id, version: 6 }))}</metadata>`
    : '';
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${format(viewport.minX)} ${format(viewport.minY)} ${format(viewport.width)} ${format(viewport.height)}" width="${format(viewport.width)}" height="${format(viewport.height)}">`,
    metadata,
    definitions.length > 0 ? `<defs>${definitions.join('')}</defs>` : '',
    ...body,
    `</svg>`,
  ].filter(Boolean).join('\n');
}

export function downloadTextFile(content: string, filename: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function concreteDocumentSegments(document: VectorDocument): ConcreteSegment[] {
  const ownedSegmentIds = new Set<EntityId>();
  const visibleObjectBySegment = new Map<EntityId, EntityId>();
  for (const object of document.objects.values()) {
    const network = document.getNetwork(object.networkId);
    if (!network) continue;
    const appearance = document.getAppearance(object.appearanceId);
    const hasVisiblePaint = !appearance || (
      appearance.opacity > 0 && (
        (appearance.stroke?.visible && appearance.stroke.opacity > 0) ||
        appearance.fills.some((fill) => fill.visible && fill.opacity > 0)
      )
    );
    const visible = document.isObjectVisible(object.id) && hasVisiblePaint;
    for (const pathId of network.pathIds) {
      for (const segmentId of document.getPath(pathId)?.segmentIds ?? []) {
        ownedSegmentIds.add(segmentId);
        if (visible) visibleObjectBySegment.set(segmentId, object.id);
      }
    }
  }
  const result = [...document.segments.values()]
    .filter((segment) => !ownedSegmentIds.has(segment.id) || visibleObjectBySegment.has(segment.id))
    .map((segment) => {
      const objectId = visibleObjectBySegment.get(segment.id);
      const object = objectId ? document.getObject(objectId) : undefined;
      return concreteSegment(
        document,
        segment,
        object ? objectTransformMatrix(object.transform) : IDENTITY_MATRIX,
        objectId,
      );
    });
  for (const group of document.parametricGroups.values()) {
    const sourceSegmentIds = new Set(group.sourcePathIds.flatMap((pathId) => document.getPath(pathId)?.segmentIds ?? []));
    for (const matrix of parametricInstanceMatrices(document, group)) {
      for (const segmentId of sourceSegmentIds) {
        const segment = document.getSegment(segmentId);
        if (segment && (!ownedSegmentIds.has(segment.id) || visibleObjectBySegment.has(segment.id))) {
          const objectId = visibleObjectBySegment.get(segment.id);
          const object = objectId ? document.getObject(objectId) : undefined;
          const objectMatrix = object ? objectTransformMatrix(object.transform) : IDENTITY_MATRIX;
          result.push(concreteSegment(
            document,
            segment,
            multiplyMatrices(objectMatrix, matrix),
            objectId,
          ));
        }
      }
    }
  }
  return result;
}

function concreteSegment(
  document: VectorDocument,
  source: Segment,
  matrix: Matrix2D,
  objectId?: EntityId,
): ConcreteSegment {
  const startNode = document.getNode(source.startNodeId);
  const endNode = document.getNode(source.endNodeId);
  const start = transformPoint(startNode?.position ?? { x: 0, y: 0 }, matrix);
  const end = transformPoint(endNode?.position ?? { x: 0, y: 0 }, matrix);
  let segment: Segment = {
    ...source,
    center: source.center ? transformPoint(source.center, matrix) : undefined,
    widthProfile: source.widthProfile?.map((point) => ({ ...point })),
  };
  if (source.type === 'arc' && source.center) {
    const center = transformPoint(source.center, matrix);
    const startAngle = Math.atan2(start.y - center.y, start.x - center.x);
    const endAngle = Math.atan2(end.y - center.y, end.x - center.x);
    const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
    const scale = matrixScale(matrix);
    segment = {
      ...segment,
      center,
      radius: source.radius === undefined ? undefined : source.radius * (scale.x + scale.y) / 2,
      startAngle,
      endAngle,
      clockwise: determinant < 0 ? !source.clockwise : source.clockwise,
    };
  }
  return {
    segment,
    start,
    end,
    handleOut: startNode?.handleOut ? transformPoint(startNode.handleOut, matrix) : undefined,
    handleIn: endNode?.handleIn ? transformPoint(endNode.handleIn, matrix) : undefined,
    objectId,
    transform: isIdentityMatrix(matrix) ? undefined : { ...matrix },
    sourceSegment: isIdentityMatrix(matrix) ? undefined : { ...source, center: source.center ? { ...source.center } : undefined },
  };
}

function translateConcreteSegment(item: ConcreteSegment, offset: Point): ConcreteSegment {
  if (offset.x === 0 && offset.y === 0) return item;
  const translate = (point: Point | undefined) => point
    ? { x: point.x + offset.x, y: point.y + offset.y }
    : undefined;
  return {
    ...item,
    segment: {
      ...item.segment,
      center: translate(item.segment.center),
      widthProfile: item.segment.widthProfile?.map((point) => ({ ...point })),
    },
    start: translate(item.start)!,
    end: translate(item.end)!,
    handleOut: translate(item.handleOut),
    handleIn: translate(item.handleIn),
    transform: item.transform
      ? { ...item.transform, e: item.transform.e + offset.x, f: item.transform.f + offset.y }
      : undefined,
  };
}

function regionBelongsToActiveArtboard(
  document: VectorDocument,
  region: Region,
  activeObjectIds: Set<EntityId>,
  activeNetworkSegmentIds: Set<EntityId>,
): boolean {
  const segmentId = region.boundarySegmentIds[0];
  if (!segmentId) return false;
  const object = document.getObjectForSegment(segmentId);
  return object ? activeObjectIds.has(object.id) : activeNetworkSegmentIds.has(segmentId);
}

function segmentPath(item: ConcreteSegment, format: (value: number) => string): string {
  return `M${format(item.start.x)} ${format(item.start.y)}${segmentCommand(item, format)}`;
}

function segmentCommand(item: ConcreteSegment, format: (value: number) => string): string {
  if (item.segment.type === 'bezier') {
    const out = item.handleOut ?? item.start;
    const inside = item.handleIn ?? item.end;
    return `C${format(out.x)} ${format(out.y)} ${format(inside.x)} ${format(inside.y)} ${format(item.end.x)} ${format(item.end.y)}`;
  }
  if (item.segment.type === 'arc' && item.segment.radius && item.segment.center) {
    if (item.transform) {
      const scale = matrixScale(item.transform);
      if (Math.abs(scale.x - scale.y) > 1e-8) {
        return Array.from({ length: 32 }, (_, index) => {
          const point = evaluateConcreteSegment(item, (index + 1) / 32);
          return `L${format(point.x)} ${format(point.y)}`;
        }).join('');
      }
    }
    const sweep = arcSweep(item.segment);
    const large = Math.abs(sweep) > Math.PI ? 1 : 0;
    const sweepFlag = sweep > 0 ? 1 : 0;
    return `A${format(item.segment.radius)} ${format(item.segment.radius)} 0 ${large} ${sweepFlag} ${format(item.end.x)} ${format(item.end.y)}`;
  }
  return `L${format(item.end.x)} ${format(item.end.y)}`;
}

export function evaluateConcreteSegment(item: ConcreteSegment, t: number): Point {
  const clamped = Math.max(0, Math.min(1, t));
  if (item.segment.type === 'arc' && item.segment.center && item.segment.radius !== undefined) {
    if (item.sourceSegment?.type === 'arc' && item.sourceSegment.center &&
      item.sourceSegment.radius !== undefined && item.transform) {
      const angle = (item.sourceSegment.startAngle ?? 0) + arcSweep(item.sourceSegment) * clamped;
      return transformPoint({
        x: item.sourceSegment.center.x + item.sourceSegment.radius * Math.cos(angle),
        y: item.sourceSegment.center.y + item.sourceSegment.radius * Math.sin(angle),
      }, item.transform);
    }
    const angle = (item.segment.startAngle ?? 0) + arcSweep(item.segment) * clamped;
    return {
      x: item.segment.center.x + item.segment.radius * Math.cos(angle),
      y: item.segment.center.y + item.segment.radius * Math.sin(angle),
    };
  }
  if (item.segment.type === 'bezier') {
    const p1 = item.handleOut ?? item.start;
    const p2 = item.handleIn ?? item.end;
    const mt = 1 - clamped;
    return {
      x: mt ** 3 * item.start.x + 3 * mt ** 2 * clamped * p1.x + 3 * mt * clamped ** 2 * p2.x + clamped ** 3 * item.end.x,
      y: mt ** 3 * item.start.y + 3 * mt ** 2 * clamped * p1.y + 3 * mt * clamped ** 2 * p2.y + clamped ** 3 * item.end.y,
    };
  }
  return {
    x: item.start.x + (item.end.x - item.start.x) * clamped,
    y: item.start.y + (item.end.y - item.start.y) * clamped,
  };
}

export function variableWidthOutline(item: ConcreteSegment, requestedSteps?: number): Point[] {
  const transformScale = item.transform
    ? (matrixScale(item.transform).x + matrixScale(item.transform).y) / 2
    : 1;
  const widthAt = (t: number) => sampleWidthProfile(item.segment.widthProfile, t, 1.25) * transformScale;
  const left: Point[] = [];
  const right: Point[] = [];
  const steps = Math.max(4, Math.round(requestedSteps ?? (item.segment.type === 'line' ? 16 : 64)));
  for (let index = 0; index <= steps; index += 1) {
    const t = index / steps;
    const point = evaluateConcreteSegment(item, t);
    const previous = evaluateConcreteSegment(item, Math.max(0, t - 1e-4));
    const next = evaluateConcreteSegment(item, Math.min(1, t + 1e-4));
    const dx = next.x - previous.x;
    const dy = next.y - previous.y;
    const length = Math.hypot(dx, dy) || 1;
    const normal = { x: -dy / length, y: dx / length };
    const half = widthAt(t) / 2;
    left.push({ x: point.x + normal.x * half, y: point.y + normal.y * half });
    right.push({ x: point.x - normal.x * half, y: point.y - normal.y * half });
  }
  return [...left, ...right.reverse()];
}

function polygonPath(points: Point[], format: (value: number) => string): string {
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'}${format(point.x)} ${format(point.y)}`).join('') + 'Z';
}

function isExportableRegion(document: VectorDocument, region: Region): boolean {
  return Boolean(regionBoundaryLoops(region).length > 0 && region.boundarySegmentIds.length > 0 &&
    region.boundarySegmentIds.every((segmentId) => document.getSegment(segmentId)?.role === 'geometry'));
}

function regionDocumentLoopOccurrences(document: VectorDocument, region: Region): Point[][][] {
  const loops = regionBoundaryLoops(region).map((loop) => loop.outline);
  const object = region.boundarySegmentIds[0]
    ? document.getObjectForSegment(region.boundarySegmentIds[0])
    : undefined;
  const objectMatrix = object ? objectTransformMatrix(object.transform) : IDENTITY_MATRIX;
  const matrices = [objectMatrix];
  for (const group of parametricGroupsForRegion(document, region)) {
    matrices.push(...parametricInstanceMatrices(document, group)
      .map((matrix) => multiplyMatrices(objectMatrix, matrix)));
  }
  return matrices.map((matrix) =>
    loops.map((outline) => outline.map((point) => transformPoint(point, matrix))));
}

function pointBounds(points: Point[]): { minX: number; minY: number; maxX: number; maxY: number } {
  if (points.length === 0) return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  return {
    minX: Math.min(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxX: Math.max(...points.map((point) => point.x)),
    maxY: Math.max(...points.map((point) => point.y)),
  };
}

function formatNumber(value: number, precision: number): string {
  const rounded = Number(value.toFixed(precision));
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}

function escapeText(value: string): string {
  return escapeAttribute(value).replaceAll('>', '&gt;');
}

export function sourcePathIdsForSegments(document: VectorDocument, segmentIds: Iterable<EntityId>): EntityId[] {
  return [...new Set([...segmentIds]
    .map((segmentId) => document.findPathForSegment(segmentId)?.id)
    .filter((pathId): pathId is EntityId => Boolean(pathId)))];
}
