import { isPixelGridVisible } from './view-settings';
import type { CollaboratorPresence } from '../collaboration/session';
import {
  CONSTRUCTION_VISUAL_STYLE,
  constrainConstructionLineEndpoint,
  constructionLineSpan,
  constructionStrokePlan,
  type ConstructionLineGeometry,
  type ConstructionStrokePlan,
  type DocumentBounds,
} from '../core/construction-geometry';
import type { VectorDocument } from '../core/document';
import { arcSweep, evaluateSegment, isNativeArc } from '../core/geometry';
import type { CubicCurve } from '../core/geometry';
import { INTERACTION_BOUNDS_POLICY, objectBounds } from '../core/object-geometry';
import {
  parametricGroupsForRegion,
  parametricInstanceMatrices,
  parametricSourceObjectId,
  resolveParametricTransform,
} from '../core/parametric';
import { regionBoundaryLoops } from '../core/region-geometry';
import { isArtworkFillPath } from '../core/segment-semantics';
import {
  matrixScale,
  objectTransformMatrix,
  transformPoint,
  type Matrix2D,
} from '../core/transforms';
import type { ConstructionExtent, Constraint, EntityId, Point, Region, Segment, SelectionState } from '../core/types';
import type { Viewport } from './viewport';
import type { PrimitiveKind } from '../tools/primitive-tool';
import type { SnapResult } from '../tools/snapping';
import { sampleWidthProfile, widthHandlesForSegment } from '../tools/width-tool';

export type PenPreview =
  | { kind: 'handles'; anchor: Point; cursor: Point }
  | { kind: 'target'; point: Point; targetKind: 'node' | 'segment' }
  | { kind: 'continuation'; start: Point; cursor: Point; controlOut?: Point; closeTarget?: Point; willClose: boolean; targetKind?: 'node' | 'segment' };

export interface StrokeRenderWidths {
  artwork: number;
  selection: number;
}

/** Artwork lives in document space; selection feedback stays constant on screen. */
export function canvasStrokeRenderWidths(strokeWidth: number, viewportScale: number): StrokeRenderWidths {
  return {
    artwork: Math.max(0, strokeWidth),
    selection: 1.5 / Math.max(viewportScale, 1e-9),
  };
}

export interface FreehandPreview {
  points: Point[];
  widths?: number[];
  color: string;
  width: number;
}

export type BendPreview =
  | { kind: 'handles'; anchor: Point; cursor: Point }
  | { kind: 'curve'; curve: CubicCurve };

export interface PrimitivePreview {
  kind: PrimitiveKind;
  start: Point;
  end: Point;
  constrain: boolean;
  fromCenter: boolean;
}

export interface ConstructionLinePreview {
  start: Point;
  end: Point;
  constrain: boolean;
  extent: ConstructionExtent;
}

export interface MarqueePreview {
  start: Point;
  end: Point;
  mode: 'contain' | 'intersect';
}

export interface EraserPreview {
  point: Point;
  radius: number;
  shape: 'round' | 'square';
}

interface RenderOptions {
  width: number;
  height: number;
  dpr: number;
  document: VectorDocument;
  viewport: Viewport;
  selection: SelectionState;
  selectedArtboardIds?: Set<EntityId>;
  impactObjectIds?: ReadonlySet<EntityId>;
  penPreview?: PenPreview;
  freehandPreview?: FreehandPreview;
  bendPreview?: BendPreview;
  cutPreview?: { start: Point; end: Point };
  lassoPreview?: Point[];
  marqueePreview?: MarqueePreview;
  eraserPreview?: EraserPreview;
  primitivePreview?: PrimitivePreview;
  constructionLinePreview?: ConstructionLinePreview;
  snapPreview?: SnapResult;
  hoveredRegionId?: EntityId;
  paintRegionHover?: boolean;
  builderRegionIds?: Set<EntityId>;
  subtractRegion?: boolean;
  hoveredNodeId?: EntityId;
  hoveredSegmentId?: EntityId;
  hoveredHandle?: { nodeId: EntityId; handleType: 'in' | 'out' };
  widthToolActive?: boolean;
  remotePresence?: CollaboratorPresence[];
  overlayOnly?: boolean;
}

const COLORS = {
  canvas: '#e4e4e0',
  minorGrid: '#efefec',
  majorGrid: '#deded9',
  axis: '#b9b9b9',
  segment: '#6d737d',
  selected: '#0d99ff',
  node: '#ffffff',
  nodeCore: '#ffffff',
  handle: '#0d99ff',
};

export function renderVectorScene(context: CanvasRenderingContext2D, options: RenderOptions): void {
  const {
    width,
    height,
    dpr,
    document,
    viewport,
    selection,
    selectedArtboardIds = new Set<EntityId>(),
    impactObjectIds = new Set<EntityId>(),
    penPreview,
    freehandPreview,
    bendPreview,
    cutPreview,
    lassoPreview,
    marqueePreview,
    eraserPreview,
    primitivePreview,
    constructionLinePreview,
    snapPreview,
    hoveredRegionId,
    paintRegionHover,
    builderRegionIds,
    subtractRegion,
    hoveredNodeId,
    hoveredSegmentId,
    hoveredHandle,
    widthToolActive,
    remotePresence,
    overlayOnly = false,
  } = options;

  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);
  if (!overlayOnly) {
    context.fillStyle = COLORS.canvas;
    context.fillRect(0, 0, width, height);
  }

  const visibleSegmentIds = document.visibleSegmentIds();
  const visibleNodeIds = document.visibleNodeIds();

  context.save();
  context.setTransform(
    dpr * viewport.scale,
    0,
    0,
    dpr * viewport.scale,
    dpr * viewport.offsetX,
    dpr * viewport.offsetY,
  );

  if (!overlayOnly) {
    drawArtboards(context, document, viewport.scale, true, selectedArtboardIds);
    drawObjectFills(context, document);
  }

  drawRegionOverlays(
    context,
    document,
    viewport.scale,
    hoveredRegionId,
    builderRegionIds ?? new Set(),
    subtractRegion ?? false,
    paintRegionHover ?? false,
    overlayOnly,
  );

  const viewportBounds = documentViewportBounds(viewport, width, height);

  if (overlayOnly) {
    drawArtboards(context, document, viewport.scale, false, selectedArtboardIds);
    const hoveredSegment = hoveredSegmentId ? document.getSegment(hoveredSegmentId) : undefined;
    if (hoveredSegment && hoveredSegment.role !== 'construction') {
      const start = document.getNode(hoveredSegment.startNodeId);
      const end = document.getNode(hoveredSegment.endNodeId);
      if (start && end) {
        context.save();
        const object = document.getObjectForSegment(hoveredSegment.id);
        if (object) {
          const matrix = objectTransformMatrix(object.transform);
          context.transform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
        }
        context.strokeStyle = alpha(COLORS.selected, 0.9);
        context.lineWidth = 1.5 / viewport.scale;
        strokeSegment(context, hoveredSegment, start.position, end.position, start.handleOut, end.handleIn);
        context.restore();
      }
    }
    drawConstructionOverlays(
      context,
      document,
      viewport.scale,
      viewportBounds,
      selection.segmentIds,
      hoveredSegmentId,
    );
    drawGeometryImpactHighlights(context, document, viewport.scale, impactObjectIds);
    if (selection.mode === 'object') drawObjectSelection(context, document, viewport.scale, selection.objectIds);
    drawParametricControls(context, document, viewport.scale, selection);
    if (remotePresence?.length) drawRemotePresence(context, document, viewport.scale, remotePresence);
    if (widthToolActive) drawWidthHandles(context, document, viewport.scale);
    drawNetworkPathSkeleton(context, document, viewport.scale, selection, visibleSegmentIds, hoveredSegmentId);
    drawSelectedHandles(context, document, viewport.scale, selection, hoveredHandle);
    drawNetworkNodes(context, document, viewport.scale, selection, visibleNodeIds, hoveredNodeId);
    drawConstraintIndicators(context, document, viewport.scale);
    drawLocalToolPreviews(
      context, document, selection, viewport.scale,
      penPreview, freehandPreview, bendPreview, cutPreview, lassoPreview, marqueePreview, eraserPreview,
    );
    if (primitivePreview) drawPrimitivePreview(context, primitivePreview, viewport.scale);
    if (constructionLinePreview) {
      drawConstructionLinePreview(context, constructionLinePreview, viewport.scale, viewportBounds);
    }
    if (snapPreview) drawSnapPreview(context, snapPreview, viewport.scale);
    context.restore();
    return;
  }

  drawConstructionLines(context, document, viewport.scale, viewportBounds, visibleSegmentIds);
  drawParametricInstances(context, document, viewport.scale);
  const alignedStrokeSegmentIds = drawAlignedObjectStrokes(context, document);

  for (const segment of document.segments.values()) {
    if (!visibleSegmentIds.has(segment.id) || segment.role === 'construction') continue;
    const start = document.getNode(segment.startNodeId);
    const end = document.getNode(segment.endNodeId);
    if (!start || !end) continue;

    const object = document.getObjectForSegment(segment.id);
    const appearance = object ? document.getAppearance(object.appearanceId) : undefined;
    const stroke = appearance?.stroke;
    if (stroke && (!stroke.visible || stroke.opacity <= 0 || appearance!.opacity <= 0)) continue;
    context.save();
    if (object) {
      const matrix = objectTransformMatrix(object.transform);
      context.transform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
    }
    const selected = selection.segmentIds.has(segment.id);
    const hovered = hoveredSegmentId === segment.id;
    const renderWidths = canvasStrokeRenderWidths(stroke?.width ?? 1.25, viewport.scale);
    const alignedStrokeHandled = alignedStrokeSegmentIds.has(segment.id);
    context.lineCap = stroke?.cap ?? 'round';
    context.lineJoin = stroke?.join ?? 'round';

    // Artwork stroke widths and dash lengths live in document space, so the
    // viewport transform must scale them naturally as users zoom. Interaction
    // overlays remain screen-space below.
    if (!alignedStrokeHandled) {
      context.globalAlpha = (appearance?.opacity ?? 1) * (stroke?.opacity ?? 1);
      context.strokeStyle = stroke?.color ?? COLORS.segment;
      context.lineWidth = renderWidths.artwork;
      context.setLineDash(stroke?.dash ?? []);
      if (segment.widthProfile && segment.widthProfile.length > 0) {
        strokeVariableWidthSegment(context, document, segment, viewport.scale);
      } else {
        strokeSegment(context, segment, start.position, end.position, start.handleOut, end.handleIn);
      }
    }

    if (selected || hovered) {
      context.globalAlpha = 1;
      context.setLineDash([]);
      context.strokeStyle = hovered ? alpha(COLORS.selected, 0.9) : COLORS.selected;
      context.lineWidth = hovered ? 1.5 / viewport.scale : renderWidths.selection;
      strokeSegment(context, segment, start.position, end.position, start.handleOut, end.handleIn);
    }
    context.restore();
  }

  drawConstructionOverlays(
    context,
    document,
    viewport.scale,
    viewportBounds,
    selection.segmentIds,
    hoveredSegmentId,
  );
  drawNetworkPathSkeleton(context, document, viewport.scale, selection, visibleSegmentIds, hoveredSegmentId);
  drawGeometryImpactHighlights(context, document, viewport.scale, impactObjectIds);
  if (selection.mode === 'object') drawObjectSelection(context, document, viewport.scale, selection.objectIds);
  drawParametricControls(context, document, viewport.scale, selection);
  if (remotePresence && remotePresence.length > 0) drawRemotePresence(context, document, viewport.scale, remotePresence);
  if (widthToolActive) drawWidthHandles(context, document, viewport.scale);
  drawSelectedHandles(context, document, viewport.scale, selection, hoveredHandle);

  drawNetworkNodes(context, document, viewport.scale, selection, visibleNodeIds, hoveredNodeId);

  drawConstraintIndicators(context, document, viewport.scale);

  drawLocalToolPreviews(
    context, document, selection, viewport.scale,
    penPreview, freehandPreview, bendPreview, cutPreview, lassoPreview, marqueePreview, eraserPreview,
  );
  if (primitivePreview) drawPrimitivePreview(context, primitivePreview, viewport.scale);
  if (constructionLinePreview) {
    drawConstructionLinePreview(context, constructionLinePreview, viewport.scale, viewportBounds);
  }
  if (snapPreview) drawSnapPreview(context, snapPreview, viewport.scale);
  context.restore();
}

export function networkPathSkeletonSegmentIds(
  document: VectorDocument,
  selection: SelectionState,
  visibleSegmentIds: Set<EntityId> = document.visibleSegmentIds(),
  hoveredSegmentId?: EntityId,
): EntityId[] {
  if (selection.mode !== 'network') return [];
  return [...visibleSegmentIds].filter((segmentId) => {
    if (selection.segmentIds.has(segmentId) || hoveredSegmentId === segmentId) return false;
    const segment = document.getSegment(segmentId);
    if (!segment || segment.role === 'construction') return false;
    const object = document.getObjectForSegment(segmentId);
    return !selection.editingObjectId || object?.id === selection.editingObjectId;
  });
}

function drawNetworkPathSkeleton(
  context: CanvasRenderingContext2D,
  document: VectorDocument,
  scale: number,
  selection: SelectionState,
  visibleSegmentIds: Set<EntityId>,
  hoveredSegmentId?: EntityId,
): void {
  const segmentIds = networkPathSkeletonSegmentIds(
    document,
    selection,
    visibleSegmentIds,
    hoveredSegmentId,
  );
  if (segmentIds.length === 0) return;

  context.save();
  context.strokeStyle = '#aab0ba';
  context.lineWidth = 1 / scale;
  context.lineCap = 'butt';
  context.lineJoin = 'round';
  context.setLineDash([]);
  for (const segmentId of segmentIds) {
    const segment = document.getSegment(segmentId);
    const start = segment ? document.getNode(segment.startNodeId) : undefined;
    const end = segment ? document.getNode(segment.endNodeId) : undefined;
    if (!segment || !start || !end) continue;
    const object = document.getObjectForSegment(segmentId);
    const matrix = object ? objectTransformMatrix(object.transform) : undefined;
    const worldPoint = (point: Point) => matrix ? transformPoint(point, matrix) : point;
    const startPoint = worldPoint(start.position);
    const endPoint = worldPoint(end.position);

    context.beginPath();
    context.moveTo(startPoint.x, startPoint.y);
    if (segment.type === 'line') {
      context.lineTo(endPoint.x, endPoint.y);
    } else if (segment.type === 'bezier') {
      const controlOut = worldPoint(start.handleOut ?? start.position);
      const controlIn = worldPoint(end.handleIn ?? end.position);
      context.bezierCurveTo(
        controlOut.x,
        controlOut.y,
        controlIn.x,
        controlIn.y,
        endPoint.x,
        endPoint.y,
      );
    } else {
      // Sampling in world space preserves a constant screen-space hairline even
      // when the owning object has a non-uniform transform.
      for (let index = 1; index <= 128; index += 1) {
        const point = worldPoint(evaluateSegment(document, segment, index / 128));
        context.lineTo(point.x, point.y);
      }
    }
    context.stroke();
  }
  context.restore();
}

function drawNetworkNodes(
  context: CanvasRenderingContext2D,
  document: VectorDocument,
  scale: number,
  selection: SelectionState,
  visibleNodeIds: Set<EntityId>,
  hoveredNodeId?: EntityId,
): void {
  if (selection.mode !== 'network') return;
  const selectedWorldPositions = [...selection.nodeIds]
    .map((nodeId) => {
      const node = document.getNode(nodeId);
      const object = node ? document.getObjectForNode(node.id) : undefined;
      if (!node) return undefined;
      return object ? transformPoint(node.position, objectTransformMatrix(object.transform)) : node.position;
    })
    .filter((point): point is Point => Boolean(point));
  if (selectedWorldPositions.length === 2 && Math.abs(selectedWorldPositions[0].x - selectedWorldPositions[1].x) * scale <= 4) {
    const x = (selectedWorldPositions[0].x + selectedWorldPositions[1].x) / 2;
    const minY = Math.min(selectedWorldPositions[0].y, selectedWorldPositions[1].y) - 2;
    const maxY = Math.max(selectedWorldPositions[0].y, selectedWorldPositions[1].y) + 2;
    context.save();
    context.beginPath();
    context.moveTo(x, minY);
    context.lineTo(x, maxY);
    context.strokeStyle = COLORS.selected;
    context.lineWidth = 1 / scale;
    context.setLineDash([4 / scale, 4 / scale]);
    context.stroke();
    context.setLineDash([]);

    const midpointY = (selectedWorldPositions[0].y + selectedWorldPositions[1].y) / 2;
    const badgeX = x + 12 / scale;
    const badgeY = midpointY - 9 / scale;
    context.beginPath();
    context.roundRect(badgeX, badgeY, 19 / scale, 19 / scale, 4 / scale);
    context.fillStyle = '#1F2023';
    context.fill();
    context.fillStyle = '#FFFFFF';
    context.font = `600 ${11 / scale}px Geist, system-ui, sans-serif`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText('V', badgeX + 9.5 / scale, badgeY + 9.8 / scale);
    context.restore();
  }
  for (const node of document.nodes.values()) {
    if (!visibleNodeIds.has(node.id)) continue;
    const object = document.getObjectForNode(node.id);
    if (selection.editingObjectId && object?.id !== selection.editingObjectId) continue;
    const selected = selection.nodeIds.has(node.id);
    const hovered = hoveredNodeId === node.id;
    const size = hovered ? 15 : selected ? 14 : 12;
    const position = object
      ? transformPoint(node.position, objectTransformMatrix(object.transform))
      : node.position;
    context.beginPath();
    context.rect(position.x - size / 2 / scale, position.y - size / 2 / scale, size / scale, size / scale);
    context.fillStyle = selected ? COLORS.selected : '#ffffff';
    context.fill();
    context.lineWidth = (hovered ? 1.75 : 1.5) / scale;
    context.strokeStyle = selected ? '#0A6FC2' : COLORS.selected;
    context.stroke();
  }
}

function documentViewportBounds(viewport: Viewport, width: number, height: number): DocumentBounds {
  const topLeft = viewport.screenToWorld({ x: 0, y: 0 });
  const bottomRight = viewport.screenToWorld({ x: width, y: height });
  return {
    minX: Math.min(topLeft.x, bottomRight.x),
    minY: Math.min(topLeft.y, bottomRight.y),
    maxX: Math.max(topLeft.x, bottomRight.x),
    maxY: Math.max(topLeft.y, bottomRight.y),
  };
}

/** Pure Canvas-side plan used to verify renderer parity without owning geometry. */
export function canvasConstructionStrokePlan(
  document: VectorDocument,
  segmentOrId: Segment | EntityId,
  viewportBounds: DocumentBounds,
): ConstructionStrokePlan | null {
  return constructionStrokePlan(document, segmentOrId, viewportBounds);
}

function drawConstructionLines(
  context: CanvasRenderingContext2D,
  document: VectorDocument,
  scale: number,
  viewportBounds: DocumentBounds,
  visibleSegmentIds: Set<EntityId>,
): void {
  context.save();
  const style = CONSTRUCTION_VISUAL_STYLE.base;
  context.strokeStyle = style.color;
  context.globalAlpha = style.opacity;
  context.lineWidth = style.widthPx / scale;
  context.lineCap = style.cap;
  context.setLineDash(style.dashPx.map((value) => value / scale));
  for (const segment of document.segments.values()) {
    if (segment.role !== 'construction' || !visibleSegmentIds.has(segment.id)) continue;
    const plan = canvasConstructionStrokePlan(document, segment, viewportBounds);
    if (!plan) continue;
    context.beginPath();
    context.moveTo(plan.start.x, plan.start.y);
    context.lineTo(plan.end.x, plan.end.y);
    context.stroke();
  }
  context.restore();
}

function drawConstructionOverlays(
  context: CanvasRenderingContext2D,
  document: VectorDocument,
  scale: number,
  viewportBounds: DocumentBounds,
  selectedSegmentIds: Set<EntityId>,
  hoveredSegmentId?: EntityId,
): void {
  context.save();
  for (const segment of document.segments.values()) {
    if (segment.role !== 'construction' || !document.isSegmentVisible(segment.id)) continue;
    const selected = selectedSegmentIds.has(segment.id);
    const hovered = hoveredSegmentId === segment.id;
    if (!selected && !hovered) continue;
    const plan = canvasConstructionStrokePlan(document, segment, viewportBounds);
    if (!plan) continue;
    const style = hovered ? CONSTRUCTION_VISUAL_STYLE.hover : CONSTRUCTION_VISUAL_STYLE.selected;
    context.lineCap = style.cap;
    context.beginPath();
    context.moveTo(plan.start.x, plan.start.y);
    context.lineTo(plan.end.x, plan.end.y);
    context.strokeStyle = alpha(style.haloColor, style.haloOpacity);
    context.lineWidth = style.haloWidthPx / scale;
    context.setLineDash([]);
    context.stroke();
    context.beginPath();
    context.moveTo(plan.start.x, plan.start.y);
    context.lineTo(plan.end.x, plan.end.y);
    context.strokeStyle = style.color;
    context.lineWidth = style.widthPx / scale;
    context.setLineDash(style.dashPx.map((value) => value / scale));
    context.stroke();
  }
  context.restore();
}

function drawArtboardPixelGrid(
  context: CanvasRenderingContext2D,
  frame: { x: number; y: number; width: number; height: number },
  scale: number,
): void {
  // The document-pixel grid belongs to the production frame, not to the
  // pasteboard around it. This matches the supplied Phase 1 editor reference.
  if (scale < 4 || !isPixelGridVisible()) return;
  context.save();
  context.beginPath();
  context.rect(frame.x, frame.y, frame.width, frame.height);
  context.clip();
  const drawLines = (spacing: number, color: string) => {
    context.beginPath();
    const firstX = Math.ceil(frame.x / spacing) * spacing;
    const firstY = Math.ceil(frame.y / spacing) * spacing;
    // A half-device-pixel offset keeps the one-pixel grid crisp at integer
    // zoom levels, matching the CSS grid in the supplied Keyline board.
    const crispOffset = 0.5 / scale;
    for (let x = firstX; x <= frame.x + frame.width; x += spacing) {
      context.moveTo(x + crispOffset, frame.y);
      context.lineTo(x + crispOffset, frame.y + frame.height);
    }
    for (let y = firstY; y <= frame.y + frame.height; y += spacing) {
      context.moveTo(frame.x, y + crispOffset);
      context.lineTo(frame.x + frame.width, y + crispOffset);
    }
    context.strokeStyle = color;
    context.lineWidth = 1 / scale;
    context.stroke();
  };
  drawLines(1, COLORS.minorGrid);
  context.restore();
}

function drawArtboards(
  context: CanvasRenderingContext2D,
  document: VectorDocument,
  scale: number,
  fillBackground = true,
  selectedArtboardIds: Set<EntityId> = new Set(),
): void {
  context.save();
  for (const artboardId of document.activePage.artboardIds) {
    const artboard = document.getArtboard(artboardId);
    if (!artboard || artboard.isCanvasRoot) continue;
    const { x, y, width, height } = artboard.frame;
    const active = artboard.id === document.activeArtboardId;
    const selected = selectedArtboardIds.has(artboard.id);
    if (fillBackground) {
      context.save();
      context.fillStyle = artboard.background;
      context.globalAlpha = 1;
      context.fillRect(x, y, width, height);
      context.restore();
      drawArtboardPixelGrid(context, artboard.frame, scale);
    }
    // The active production frame is defined by its white fill and pixel grid;
    // it has no resting outline in the supplied composition. Selection remains
    // explicit, while inactive artboards retain a quiet dashed boundary.
    if (selected || !active) {
      context.strokeStyle = selected ? COLORS.selected : '#a5aab2';
      context.lineWidth = (selected ? 1.5 : 1) / scale;
      context.setLineDash(selected ? [] : [5 / scale, 4 / scale]);
      context.strokeRect(x, y, width, height);
      context.setLineDash([]);
    }
    context.fillStyle = selected ? COLORS.selected : active ? '#4a4d55' : '#747a84';
    context.font = `600 ${11 / scale}px Geist, system-ui, sans-serif`;
    context.textAlign = 'left';
    context.textBaseline = 'bottom';
    const clipLabel = artboard.clipContent ? ' · Clip' : '';
    context.fillText(`${artboard.name}${clipLabel}`, x, y - 8 / scale);
    if (selected) {
      const handles = [
        { x, y, edgeMiddle: false },
        { x: x + width / 2, y, edgeMiddle: true },
        { x: x + width, y, edgeMiddle: false },
        { x: x + width, y: y + height / 2, edgeMiddle: true },
        { x: x + width, y: y + height, edgeMiddle: false },
        { x: x + width / 2, y: y + height, edgeMiddle: true },
        { x, y: y + height, edgeMiddle: false },
        { x, y: y + height / 2, edgeMiddle: true },
      ];
      for (const point of handles) {
        // Edge-middle controls are deliberately larger than corners: width/height
        // resizing must remain immediately discoverable on a quiet canvas.
        const radius = (point.edgeMiddle ? 4.75 : 4) / scale;
        context.beginPath();
        context.rect(point.x - radius, point.y - radius, radius * 2, radius * 2);
        context.fillStyle = '#ffffff';
        context.fill();
        context.lineWidth = 2.75 / scale;
        context.strokeStyle = '#ffffff';
        context.stroke();
        context.lineWidth = 1.35 / scale;
        context.strokeStyle = COLORS.selected;
        context.stroke();
      }
    }
  }
  context.restore();
}

function drawRemotePresence(
  context: CanvasRenderingContext2D,
  document: VectorDocument,
  scale: number,
  presence: CollaboratorPresence[],
): void {
  context.save();
  for (const collaborator of presence) {
    const color = collaborator.user.color;
    context.strokeStyle = alpha(color, 0.9);
    context.fillStyle = alpha(color, 0.18);
    context.lineWidth = 3 / scale;
    for (const objectId of collaborator.selection?.objectIds ?? []) {
      const bounds = objectBounds(document, objectId, INTERACTION_BOUNDS_POLICY);
      context.strokeRect(bounds.minX, bounds.minY, bounds.width, bounds.height);
    }
    for (const segmentId of collaborator.selection?.segmentIds ?? []) {
      const segment = document.getSegment(segmentId);
      if (!segment) continue;
      const start = document.getNode(segment.startNodeId);
      const end = document.getNode(segment.endNodeId);
      if (start && end) {
        const object = document.getObjectForSegment(segment.id);
        context.save();
        if (object) {
          const matrix = objectTransformMatrix(object.transform);
          context.transform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
        }
        strokeSegment(context, segment, start.position, end.position, start.handleOut, end.handleIn);
        context.restore();
      }
    }
    for (const nodeId of collaborator.selection?.nodeIds ?? []) {
      const node = document.getNode(nodeId);
      if (!node) continue;
      const object = document.getObjectForNode(nodeId);
      const position = object
        ? transformPoint(node.position, objectTransformMatrix(object.transform))
        : node.position;
      context.beginPath();
      context.arc(position.x, position.y, 7 / scale, 0, Math.PI * 2);
      context.fill();
      context.stroke();
    }
    if (collaborator.cursor) {
      const cursor = collaborator.cursor;
      context.beginPath();
      context.moveTo(cursor.x, cursor.y);
      context.lineTo(cursor.x + 4 / scale, cursor.y + 13 / scale);
      context.lineTo(cursor.x + 7 / scale, cursor.y + 8 / scale);
      context.lineTo(cursor.x + 13 / scale, cursor.y + 7 / scale);
      context.closePath();
      context.fillStyle = color;
      context.fill();
      context.font = `600 ${10 / scale}px Geist, system-ui, sans-serif`;
      const label = collaborator.user.name;
      const width = context.measureText(label).width + 10 / scale;
      context.fillRect(cursor.x + 9 / scale, cursor.y + 9 / scale, width, 18 / scale);
      context.fillStyle = '#ffffff';
      context.textAlign = 'left';
      context.textBaseline = 'middle';
      context.fillText(label, cursor.x + 14 / scale, cursor.y + 18 / scale);
    }
  }
  context.restore();
}

function activePageObjects(document: VectorDocument) {
  return document.activePage.artboardIds.flatMap((artboardId) => document.objectsForArtboard(artboardId));
}

function drawObjectFills(context: CanvasRenderingContext2D, document: VectorDocument): void {
  for (const object of activePageObjects(document)) {
    const appearance = document.getAppearance(object.appearanceId);
    const fills = appearance?.fills.filter((fill) => fill.visible && fill.opacity > 0) ?? [];
    if (!appearance || appearance.opacity <= 0 || fills.length === 0) continue;
    const network = document.getNetwork(object.networkId);
    if (!network) continue;
    const objectMatrix = objectTransformMatrix(object.transform);
    const fillPath = (pathId: EntityId, instanceMatrix?: Matrix2D) => {
      const path = document.getPath(pathId);
      if (!path || !isArtworkFillPath(document, path)) return;
      context.save();
      context.transform(objectMatrix.a, objectMatrix.b, objectMatrix.c, objectMatrix.d, objectMatrix.e, objectMatrix.f);
      if (instanceMatrix) {
        context.transform(
          instanceMatrix.a, instanceMatrix.b, instanceMatrix.c,
          instanceMatrix.d, instanceMatrix.e, instanceMatrix.f,
        );
      }
      context.beginPath();
      let started = false;
      for (const segmentId of path.segmentIds) {
        const segment = document.getSegment(segmentId);
        if (!segment) continue;
        const start = document.getNode(segment.startNodeId);
        const end = document.getNode(segment.endNodeId);
        if (!start || !end) continue;
        if (!started) {
          context.moveTo(start.position.x, start.position.y);
          started = true;
        }
        appendSegmentPath(context, segment, start.position, end.position, start.handleOut, end.handleIn);
      }
      if (started) {
        context.closePath();
        for (const fill of fills) {
          context.globalAlpha = appearance.opacity * fill.opacity;
          context.fillStyle = fill.color;
          context.fill('nonzero');
        }
      }
      context.restore();
    };
    for (const pathId of network.pathIds) {
      fillPath(pathId);
      for (const group of document.parametricGroups.values()) {
        if (!group.sourcePathIds.includes(pathId)) continue;
        for (const matrix of parametricInstanceMatrices(document, group)) fillPath(pathId, matrix);
      }
    }
  }
}

function drawAlignedObjectStrokes(
  context: CanvasRenderingContext2D,
  document: VectorDocument,
): Set<EntityId> {
  const handled = new Set<EntityId>();
  for (const object of activePageObjects(document)) {
    const appearance = document.getAppearance(object.appearanceId);
    const stroke = appearance?.stroke;
    const network = document.getNetwork(object.networkId);
    if (!appearance || !stroke || !network || !stroke.visible || stroke.opacity <= 0 || appearance.opacity <= 0 || stroke.alignment === 'center') continue;
    const objectMatrix = objectTransformMatrix(object.transform);
    for (const pathId of network.pathIds) {
      const path = document.getPath(pathId);
      if (!path?.isClosed || !isArtworkFillPath(document, path) ||
        path.segmentIds.some((segmentId) => Boolean(document.getSegment(segmentId)?.widthProfile?.length))) continue;
      const trace = (includeOuterRect = false) => {
        context.beginPath();
        if (includeOuterRect) context.rect(-1e7, -1e7, 2e7, 2e7);
        let started = false;
        for (const segmentId of path.segmentIds) {
          const segment = document.getSegment(segmentId);
          if (!segment) continue;
          const start = document.getNode(segment.startNodeId);
          const end = document.getNode(segment.endNodeId);
          if (!start || !end) continue;
          if (!started) {
            context.moveTo(start.position.x, start.position.y);
            started = true;
          }
          appendSegmentPath(context, segment, start.position, end.position, start.handleOut, end.handleIn);
        }
        if (started) context.closePath();
        return started;
      };
      const drawOccurrence = (instanceMatrix?: Matrix2D) => {
        context.save();
        context.transform(objectMatrix.a, objectMatrix.b, objectMatrix.c, objectMatrix.d, objectMatrix.e, objectMatrix.f);
        if (instanceMatrix) {
          context.transform(
            instanceMatrix.a, instanceMatrix.b, instanceMatrix.c,
            instanceMatrix.d, instanceMatrix.e, instanceMatrix.f,
          );
        }
        if (stroke.alignment === 'inside') {
          if (!trace()) { context.restore(); return; }
          context.clip('nonzero');
        } else {
          if (!trace(true)) { context.restore(); return; }
          context.clip('evenodd');
        }
        trace();
        context.globalAlpha = appearance.opacity * stroke.opacity;
        context.strokeStyle = stroke.color;
        context.lineWidth = stroke.width * 2;
        context.lineCap = stroke.cap;
        context.lineJoin = stroke.join;
        context.setLineDash(stroke.dash);
        context.stroke();
        context.restore();
      };
      drawOccurrence();
      for (const group of document.parametricGroups.values()) {
        if (!group.sourcePathIds.includes(pathId)) continue;
        for (const matrix of parametricInstanceMatrices(document, group)) drawOccurrence(matrix);
      }
      path.segmentIds.forEach((segmentId) => handled.add(segmentId));
    }
  }
  return handled;
}

function drawParametricInstances(
  context: CanvasRenderingContext2D,
  document: VectorDocument,
  scale: number,
): void {
  const drawSources = (pathIds: EntityId[], instanceMatrix: Matrix2D) => {
    for (const pathId of pathIds) {
      const path = document.getPath(pathId);
      const network = document.findNetworkForPath(pathId);
      if (!path || (network && !document.isNetworkVisible(network.id))) continue;
      const object = network ? document.getObjectForNetwork(network.id) : undefined;
      const appearance = object ? document.getAppearance(object.appearanceId) : undefined;
      const stroke = appearance?.stroke;
      if (appearance && (appearance.opacity <= 0 || !stroke?.visible || stroke.opacity <= 0)) continue;
      if (stroke && stroke.alignment !== 'center' && path.isClosed && isArtworkFillPath(document, path) &&
        path.segmentIds.every((segmentId) => !document.getSegment(segmentId)?.widthProfile?.length)) continue;
      context.save();
      if (object) {
        const objectMatrix = objectTransformMatrix(object.transform);
        context.transform(
          objectMatrix.a, objectMatrix.b, objectMatrix.c,
          objectMatrix.d, objectMatrix.e, objectMatrix.f,
        );
      }
      context.transform(
        instanceMatrix.a, instanceMatrix.b, instanceMatrix.c,
        instanceMatrix.d, instanceMatrix.e, instanceMatrix.f,
      );
      context.globalAlpha = (appearance?.opacity ?? 1) * (stroke?.opacity ?? 1);
      context.strokeStyle = stroke?.color ?? alpha('#8da0c8', 0.72);
      context.lineCap = stroke?.cap ?? 'round';
      context.lineJoin = stroke?.join ?? 'round';
      context.setLineDash(stroke?.dash ?? [5 / scale, 3 / scale]);
      for (const segmentId of path.segmentIds) {
        const segment = document.getSegment(segmentId);
        if (!segment) continue;
        const start = document.getNode(segment.startNodeId);
        const end = document.getNode(segment.endNodeId);
        if (!start || !end) continue;
        context.lineWidth = stroke?.width ?? 1.15 / scale;
        if (segment.widthProfile && segment.widthProfile.length > 0) {
          strokeVariableWidthSegment(context, document, segment, scale);
        } else {
          strokeSegment(context, segment, start.position, end.position, start.handleOut, end.handleIn);
        }
      }
      context.restore();
    }
  };

  for (const group of document.parametricGroups.values()) {
    for (const matrix of parametricInstanceMatrices(document, group)) {
      drawSources(group.sourcePathIds, matrix);
    }
  }
}

function drawParametricControls(
  context: CanvasRenderingContext2D,
  document: VectorDocument,
  scale: number,
  selection: SelectionState,
): void {
  const selectedObjectIds = new Set(selection.objectIds);
  if (selection.editingObjectId) selectedObjectIds.add(selection.editingObjectId);
  if (selectedObjectIds.size === 0) return;
  context.save();
  context.lineWidth = 1.25 / scale;
  context.strokeStyle = '#a78bfa';
  context.fillStyle = '#191622';
  context.setLineDash([4 / scale, 3 / scale]);
  for (const group of document.parametricGroups.values()) {
    const objectId = parametricSourceObjectId(document, group);
    if (!objectId || !selectedObjectIds.has(objectId)) continue;
    const object = document.getObject(objectId);
    const resolved = resolveParametricTransform(document, group);
    if (!object || !resolved) continue;
    const objectMatrix = objectTransformMatrix(object.transform);
    const controlPoint = transformPoint(
      resolved.type === 'mirror' ? resolved.origin : resolved.center,
      objectMatrix,
    );
    if (resolved.type === 'mirror') {
      const span = 42 / scale;
      const localSpan = span / Math.max(0.0001, matrixScale(objectMatrix).x);
      const start = transformPoint({
        x: resolved.origin.x - Math.cos(resolved.angle) * localSpan,
        y: resolved.origin.y - Math.sin(resolved.angle) * localSpan,
      }, objectMatrix);
      const end = transformPoint({
        x: resolved.origin.x + Math.cos(resolved.angle) * localSpan,
        y: resolved.origin.y + Math.sin(resolved.angle) * localSpan,
      }, objectMatrix);
      context.beginPath();
      context.moveTo(start.x, start.y);
      context.lineTo(end.x, end.y);
      context.stroke();
    } else {
      context.beginPath();
      context.arc(controlPoint.x, controlPoint.y, 22 / scale, 0, Math.PI * 2);
      context.stroke();
      const startAngle = (resolved.startAngle + (resolved.clockwise ? 1 : -1) * resolved.sweepAngle) * Math.PI / 180;
      context.beginPath();
      context.moveTo(controlPoint.x, controlPoint.y);
      context.lineTo(
        controlPoint.x + Math.cos(startAngle) * 22 / scale,
        controlPoint.y + Math.sin(startAngle) * 22 / scale,
      );
      context.stroke();
    }
    context.setLineDash([]);
    const radius = 5 / scale;
    context.beginPath();
    context.rect(controlPoint.x - radius, controlPoint.y - radius, radius * 2, radius * 2);
    context.fill();
    context.stroke();
    context.setLineDash([4 / scale, 3 / scale]);
  }
  context.restore();
}

function drawWidthHandles(
  context: CanvasRenderingContext2D,
  document: VectorDocument,
  scale: number,
): void {
  context.save();
  context.strokeStyle = '#b28cff';
  context.fillStyle = '#1b1824';
  context.lineWidth = 1.25 / scale;
  for (const segment of document.segments.values()) {
    if (!document.isSegmentVisible(segment.id) || document.isSegmentLocked(segment.id)) continue;
    const object = document.getObjectForSegment(segment.id);
    context.save();
    if (object) {
      const matrix = objectTransformMatrix(object.transform);
      context.transform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
    }
    const handles = widthHandlesForSegment(document, segment);
    const grouped = new Map<EntityId, typeof handles>();
    for (const handle of handles) {
      const group = grouped.get(handle.pointId) ?? [];
      group.push(handle);
      grouped.set(handle.pointId, group);
    }
    for (const group of grouped.values()) {
      const sizes = group.filter((handle) => handle.kind === 'size');
      const center = group.find((handle) => handle.kind === 'position');
      if (sizes.length === 2) {
        context.beginPath();
        context.moveTo(sizes[0].position.x, sizes[0].position.y);
        context.lineTo(sizes[1].position.x, sizes[1].position.y);
        context.stroke();
      }
      if (center) {
        context.beginPath();
        context.arc(center.position.x, center.position.y, 3 / scale, 0, Math.PI * 2);
        context.fill();
        context.stroke();
      }
      for (const handle of sizes) {
        const size = 5 / scale;
        context.fillRect(handle.position.x - size / 2, handle.position.y - size / 2, size, size);
        context.strokeRect(handle.position.x - size / 2, handle.position.y - size / 2, size, size);
      }
    }
    context.restore();
  }
  context.restore();
}

export function straightLineSelectionPoints(
  document: VectorDocument,
  objectId: EntityId,
): { start: Point; end: Point } | null {
  const object = document.getObject(objectId);
  const network = object ? document.getNetwork(object.networkId) : undefined;
  if (!object || !network || network.pathIds.length !== 1) return null;
  if ([...document.parametricGroups.values()].some((group) =>
    parametricSourceObjectId(document, group) === objectId)) return null;
  const path = document.getPath(network.pathIds[0]);
  if (!path || path.isClosed || path.segmentIds.length !== 1) return null;
  const segment = document.getSegment(path.segmentIds[0]);
  if (!segment || segment.type !== 'line' || segment.role !== 'geometry') return null;
  const start = document.getNode(segment.startNodeId);
  const end = document.getNode(segment.endNodeId);
  if (!start || !end) return null;
  const matrix = objectTransformMatrix(object.transform);
  return {
    start: transformPoint(start.position, matrix),
    end: transformPoint(end.position, matrix),
  };
}

function drawGeometryImpactHighlights(
  context: CanvasRenderingContext2D,
  document: VectorDocument,
  scale: number,
  objectIds: ReadonlySet<EntityId>,
): void {
  if (objectIds.size === 0) return;
  context.save();
  context.strokeStyle = '#c8892f';
  context.fillStyle = alpha('#c8892f', 0.08);
  context.lineWidth = 2 / scale;
  context.setLineDash([6 / scale, 4 / scale]);
  for (const objectId of objectIds) {
    const bounds = objectBounds(document, objectId, INTERACTION_BOUNDS_POLICY);
    if (bounds.width <= 0 && bounds.height <= 0) continue;
    const inset = 4 / scale;
    context.fillRect(
      bounds.minX - inset,
      bounds.minY - inset,
      bounds.width + inset * 2,
      bounds.height + inset * 2,
    );
    context.strokeRect(
      bounds.minX - inset,
      bounds.minY - inset,
      bounds.width + inset * 2,
      bounds.height + inset * 2,
    );
  }
  context.restore();
}

function drawObjectSelection(
  context: CanvasRenderingContext2D,
  document: VectorDocument,
  scale: number,
  objectIds: Set<EntityId>,
): void {
  context.save();
  context.strokeStyle = COLORS.selected;
  context.lineWidth = 1 / scale;
  context.lineCap = 'butt';
  context.setLineDash([]);
  for (const objectId of objectIds) {
    const line = straightLineSelectionPoints(document, objectId);
    if (line) {
      // A one-segment open line has no useful area to box. Trace its actual
      // path so diagonal lines do not receive an axis-aligned rectangle.
      context.beginPath();
      context.moveTo(line.start.x, line.start.y);
      context.lineTo(line.end.x, line.end.y);
      context.stroke();
      continue;
    }
    const bounds = objectBounds(document, objectId, INTERACTION_BOUNDS_POLICY);
    if (bounds.width <= 0 && bounds.height <= 0) continue;
    context.strokeRect(bounds.minX, bounds.minY, bounds.width, bounds.height);
  }
  context.restore();
}

function drawSelectedHandles(
  context: CanvasRenderingContext2D,
  document: VectorDocument,
  scale: number,
  selection: SelectionState,
  hoveredHandle?: { nodeId: EntityId; handleType: 'in' | 'out' },
): void {
  if (selection.mode !== 'network') return;
  context.save();

  for (const nodeId of selection.nodeIds) {
    const node = document.getNode(nodeId);
    if (!node || !document.isNodeVisible(nodeId)) continue;
    const object = document.getObjectForNode(nodeId);
    const matrix = object ? objectTransformMatrix(object.transform) : undefined;
    const anchor = matrix ? transformPoint(node.position, matrix) : node.position;
    const handles = [
      { type: 'in' as const, point: node.handleIn ? (matrix ? transformPoint(node.handleIn, matrix) : node.handleIn) : undefined },
      { type: 'out' as const, point: node.handleOut ? (matrix ? transformPoint(node.handleOut, matrix) : node.handleOut) : undefined },
    ];
    for (const handle of handles) {
      if (!handle.point) continue;
      const isHovered = hoveredHandle?.nodeId === node.id && hoveredHandle.handleType === handle.type;
      context.beginPath();
      context.moveTo(anchor.x, anchor.y);
      context.lineTo(handle.point.x, handle.point.y);
      context.lineWidth = 1 / scale;
      context.strokeStyle = isHovered ? COLORS.selected : alpha(COLORS.handle, 0.9);
      context.stroke();

      // Diamond controls distinguish Bézier handles from circular path nodes.
      const radius = (isHovered ? 4.25 : 3.25) / scale;
      context.beginPath();
      context.moveTo(handle.point.x, handle.point.y - radius);
      context.lineTo(handle.point.x + radius, handle.point.y);
      context.lineTo(handle.point.x, handle.point.y + radius);
      context.lineTo(handle.point.x - radius, handle.point.y);
      context.closePath();
      context.fillStyle = COLORS.handle;
      context.fill();
    }
  }
  context.restore();
}

function drawLocalToolPreviews(
  context: CanvasRenderingContext2D,
  document: VectorDocument,
  selection: SelectionState,
  scale: number,
  penPreview?: PenPreview,
  freehandPreview?: FreehandPreview,
  bendPreview?: BendPreview,
  cutPreview?: { start: Point; end: Point },
  lassoPreview?: Point[],
  marqueePreview?: MarqueePreview,
  eraserPreview?: EraserPreview,
): void {
  context.save();
  if (penPreview) drawPenPreview(context, penPreview, scale);
  const object = selection.editingObjectId ? document.getObject(selection.editingObjectId) : undefined;
  if (object) {
    const matrix = objectTransformMatrix(object.transform);
    context.transform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
  }
  if (freehandPreview && freehandPreview.points.length > 1) drawFreehandPreview(context, freehandPreview, scale);
  if (bendPreview) drawBendPreview(context, bendPreview, scale);
  if (cutPreview) drawCutPreview(context, cutPreview, scale);
  if (lassoPreview && lassoPreview.length > 1) drawLassoPreview(context, lassoPreview, scale);
  if (marqueePreview) drawMarqueePreview(context, marqueePreview, scale);
  if (eraserPreview) drawEraserPreview(context, eraserPreview, scale);
  context.restore();
}

function drawPenPreview(context: CanvasRenderingContext2D, preview: PenPreview, scale: number): void {
  if (preview.kind === 'target') {
    context.save();
    context.beginPath();
    context.arc(preview.point.x, preview.point.y, 5 / scale, 0, Math.PI * 2);
    context.fillStyle = '#ffffff';
    context.fill();
    context.strokeStyle = COLORS.selected;
    context.lineWidth = 1.5 / scale;
    context.stroke();
    if (preview.targetKind === 'segment') {
      context.beginPath();
      context.moveTo(preview.point.x - 2.5 / scale, preview.point.y);
      context.lineTo(preview.point.x + 2.5 / scale, preview.point.y);
      context.moveTo(preview.point.x, preview.point.y - 2.5 / scale);
      context.lineTo(preview.point.x, preview.point.y + 2.5 / scale);
      context.stroke();
    }
    context.restore();
    return;
  }
  if (preview.kind === 'continuation') {
    context.save();
    context.beginPath();
    context.moveTo(preview.start.x, preview.start.y);
    if (preview.controlOut) {
      context.bezierCurveTo(
        preview.controlOut.x, preview.controlOut.y,
        preview.cursor.x, preview.cursor.y,
        preview.cursor.x, preview.cursor.y,
      );
    } else {
      context.lineTo(preview.cursor.x, preview.cursor.y);
    }
    context.strokeStyle = alpha(COLORS.selected, 0.82);
    context.lineWidth = 1.25 / scale;
    context.setLineDash([4 / scale, 3 / scale]);
    context.stroke();
    context.setLineDash([]);

    context.beginPath();
    context.arc(preview.cursor.x, preview.cursor.y, (preview.targetKind ? 5 : 3.5) / scale, 0, Math.PI * 2);
    context.fillStyle = '#ffffff';
    context.fill();
    context.strokeStyle = preview.willClose ? '#2da44e' : COLORS.selected;
    context.lineWidth = (preview.targetKind ? 1.5 : 1.25) / scale;
    context.stroke();
    if (preview.targetKind === 'segment') {
      context.beginPath();
      context.moveTo(preview.cursor.x - 2.5 / scale, preview.cursor.y);
      context.lineTo(preview.cursor.x + 2.5 / scale, preview.cursor.y);
      context.moveTo(preview.cursor.x, preview.cursor.y - 2.5 / scale);
      context.lineTo(preview.cursor.x, preview.cursor.y + 2.5 / scale);
      context.stroke();
    }

    if (preview.closeTarget) {
      context.beginPath();
      context.arc(preview.closeTarget.x, preview.closeTarget.y, (preview.willClose ? 7 : 4.5) / scale, 0, Math.PI * 2);
      context.strokeStyle = preview.willClose ? '#2da44e' : alpha(COLORS.selected, 0.65);
      context.lineWidth = (preview.willClose ? 2 : 1) / scale;
      context.stroke();
    }
    context.restore();
    return;
  }

  const dx = preview.cursor.x - preview.anchor.x;
  const dy = preview.cursor.y - preview.anchor.y;
  const opposite = { x: preview.anchor.x - dx, y: preview.anchor.y - dy };
  context.beginPath();
  context.moveTo(opposite.x, opposite.y);
  context.lineTo(preview.cursor.x, preview.cursor.y);
  context.strokeStyle = alpha(COLORS.handle, 0.7);
  context.lineWidth = 1 / scale;
  context.stroke();

  for (const point of [opposite, preview.cursor]) {
    context.beginPath();
    context.arc(point.x, point.y, 3 / scale, 0, Math.PI * 2);
    context.fillStyle = COLORS.canvas;
    context.fill();
    context.strokeStyle = COLORS.handle;
    context.lineWidth = 1.5 / scale;
    context.stroke();
  }
}

function drawFreehandPreview(context: CanvasRenderingContext2D, preview: FreehandPreview, scale: number): void {
  context.save();
  context.strokeStyle = preview.color;
  context.globalAlpha = 0.82;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  if (preview.widths?.length === preview.points.length) {
    for (let index = 0; index + 1 < preview.points.length; index += 1) {
      context.beginPath();
      context.moveTo(preview.points[index].x, preview.points[index].y);
      context.lineTo(preview.points[index + 1].x, preview.points[index + 1].y);
      context.lineWidth = Math.max((preview.widths[index] + preview.widths[index + 1]) / 2, 1 / scale);
      context.stroke();
    }
  } else {
    context.beginPath();
    context.moveTo(preview.points[0].x, preview.points[0].y);
    for (const point of preview.points.slice(1)) context.lineTo(point.x, point.y);
    context.lineWidth = Math.max(preview.width, 1 / scale);
    context.stroke();
  }
  context.restore();
}

function drawConstraintIndicators(
  context: CanvasRenderingContext2D,
  document: VectorDocument,
  scale: number,
): void {
  const cyan = '#57c8d4';
  const lineWidth = 1 / scale;
  const fontSize = 9 / scale;
  context.save();
  context.strokeStyle = alpha(cyan, 0.82);
  context.fillStyle = alpha(cyan, 0.92);
  context.lineWidth = lineWidth;
  context.font = `600 ${fontSize}px Geist, system-ui, sans-serif`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';

  const segmentMidpoint = (id: EntityId): Point | null => {
    const segment = document.getSegment(id);
    if (!segment) return null;
    const start = document.getNode(segment.startNodeId);
    const end = document.getNode(segment.endNodeId);
    return start && end ? evaluateSegment(document, segment, 0.5) : null;
  };

  const drawIndicator = (constraint: Constraint, indicatorScale: number) => {
    const offset = 11 / indicatorScale;
    if (constraint.type === 'fixed_distance') {
      const start = document.getNode(constraint.targetIds[0])?.position;
      const end = document.getNode(constraint.targetIds[1])?.position;
      if (!start || !end) return;
      context.save();
      context.setLineDash([3 / indicatorScale, 3 / indicatorScale]);
      context.beginPath();
      context.moveTo(start.x, start.y);
      context.lineTo(end.x, end.y);
      context.stroke();
      context.setLineDash([]);
      const midpoint = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
      const value = constraint.parameters?.distance ?? Math.hypot(end.x - start.x, end.y - start.y);
      context.fillStyle = '#162126';
      context.fillRect(midpoint.x - 17 / indicatorScale, midpoint.y - 7 / indicatorScale, 34 / indicatorScale, 14 / indicatorScale);
      context.fillStyle = cyan;
      context.fillText(formatIndicator(value), midpoint.x, midpoint.y);
      context.restore();
      return;
    }
    if (constraint.type === 'symmetric') {
      const axisX = constraint.parameters?.axisX;
      const axisY = constraint.parameters?.axisY;
      const angle = (constraint.parameters?.axisAngle ?? 90) * Math.PI / 180;
      if (axisX === undefined || axisY === undefined) return;
      const direction = { x: Math.cos(angle), y: Math.sin(angle) };
      context.save();
      context.setLineDash([5 / indicatorScale, 4 / indicatorScale]);
      context.beginPath();
      context.moveTo(axisX - direction.x * 80 / indicatorScale, axisY - direction.y * 80 / indicatorScale);
      context.lineTo(axisX + direction.x * 80 / indicatorScale, axisY + direction.y * 80 / indicatorScale);
      context.stroke();
      context.restore();
      return;
    }
    if (constraint.type === 'coincident') {
      const node = document.getNode(constraint.targetIds[0]);
      if (!node) return;
      context.beginPath();
      context.arc(node.position.x, node.position.y, 8 / indicatorScale, 0, Math.PI * 2);
      context.stroke();
      context.beginPath();
      context.arc(node.position.x, node.position.y, 5 / indicatorScale, 0, Math.PI * 2);
      context.stroke();
      return;
    }
    if (constraint.type === 'perpendicular') {
      const first = document.getSegment(constraint.targetIds[0]);
      const second = document.getSegment(constraint.targetIds[1]);
      if (!first || !second) return;
      const sharedId = [first.startNodeId, first.endNodeId].find(
        (id) => id === second.startNodeId || id === second.endNodeId,
      );
      const center = sharedId ? document.getNode(sharedId)?.position : segmentMidpoint(first.id);
      if (!center) return;
      const size = 7 / indicatorScale;
      context.strokeRect(center.x + 3 / indicatorScale, center.y + 3 / indicatorScale, size, size);
      return;
    }
    if (constraint.type === 'equal_length') {
      for (const targetId of constraint.targetIds.slice(0, 2)) {
        const segment = document.getSegment(targetId);
        const midpoint = segmentMidpoint(targetId);
        if (!segment || !midpoint) continue;
        const start = document.getNode(segment.startNodeId)!;
        const end = document.getNode(segment.endNodeId)!;
        const length = Math.hypot(end.position.x - start.position.x, end.position.y - start.position.y) || 1;
        const normal = {
          x: -(end.position.y - start.position.y) / length,
          y: (end.position.x - start.position.x) / length,
        };
        context.beginPath();
        context.moveTo(midpoint.x - normal.x * 5 / indicatorScale, midpoint.y - normal.y * 5 / indicatorScale);
        context.lineTo(midpoint.x + normal.x * 5 / indicatorScale, midpoint.y + normal.y * 5 / indicatorScale);
        context.stroke();
      }
      return;
    }

    const symbol = constraintSymbol(constraint.type);
    const targets = constraint.type === 'parallel'
      ? constraint.targetIds.slice(0, 2)
      : constraint.targetIds.slice(0, 1);
    for (const targetId of targets) {
      const midpoint = segmentMidpoint(targetId);
      if (!midpoint) continue;
      context.beginPath();
      context.arc(midpoint.x, midpoint.y - offset, 7 / indicatorScale, 0, Math.PI * 2);
      context.fillStyle = alpha('#13262b', 0.94);
      context.fill();
      context.strokeStyle = alpha(cyan, 0.72);
      context.stroke();
      context.fillStyle = cyan;
      context.fillText(symbol, midpoint.x, midpoint.y - offset + 0.2 / indicatorScale);
    }
  };

  for (const constraint of document.constraints.values()) {
    const targetId = constraint.targetIds[0];
    const object = document.getObjectForNode(targetId) ?? document.getObjectForSegment(targetId);
    context.save();
    let indicatorScale = scale;
    if (object) {
      const matrix = objectTransformMatrix(object.transform);
      const objectScale = matrixScale(matrix);
      indicatorScale *= Math.max(1e-6, (objectScale.x + objectScale.y) / 2);
      context.transform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
    }
    context.lineWidth = 1 / indicatorScale;
    context.font = `600 ${9 / indicatorScale}px Geist, system-ui, sans-serif`;
    drawIndicator(constraint, indicatorScale);
    context.restore();
  }
  context.restore();
}

function constraintSymbol(type: string): string {
  const symbols: Record<string, string> = {
    parallel: '∥', perpendicular: '⊥', tangent: 'T', equal_length: '=', fixed_angle: '∠',
    fixed_radius: 'R', horizontal: 'H', vertical: 'V', symmetric: '◇', coincident: '◎',
  };
  return symbols[type] ?? '•';
}

function formatIndicator(value: number): string {
  return Number(value.toFixed(2)).toString();
}

function drawRegionOverlays(
  context: CanvasRenderingContext2D,
  document: VectorDocument,
  scale: number,
  hoveredRegionId: EntityId | undefined,
  selectedRegionIds: Set<EntityId>,
  subtract: boolean,
  paintHover: boolean,
  skipStoredFills = false,
): void {
  for (const region of document.regions) {
    const loops = regionBoundaryLoops(region);
    if (loops.length === 0 ||
      region.boundarySegmentIds.some((segmentId) => !document.isSegmentVisible(segmentId))) continue;
    const selected = selectedRegionIds.has(region.id);
    const hovered = hoveredRegionId === region.id;
    if (!selected && !hovered && !region.fill) continue;
    const object = region.boundarySegmentIds[0]
      ? document.getObjectForSegment(region.boundarySegmentIds[0])
      : undefined;
    context.save();
    if (object) {
      const matrix = objectTransformMatrix(object.transform);
      context.transform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
    }
    appendRegionPath(context, region);
    if (!skipStoredFills && region.fill) {
      context.fillStyle = region.fill.color;
      context.fill(region.fillRule);
      for (const group of parametricGroupsForRegion(document, region)) {
        for (const instanceMatrix of parametricInstanceMatrices(document, group)) {
          context.save();
          context.transform(
            instanceMatrix.a, instanceMatrix.b, instanceMatrix.c,
            instanceMatrix.d, instanceMatrix.e, instanceMatrix.f,
          );
          appendRegionPath(context, region);
          context.fill(region.fillRule);
          context.restore();
        }
      }
      appendRegionPath(context, region);
    }
    if (hovered && paintHover) {
      const outline = loops[0].outline;
      const xs = outline.map((point) => point.x);
      const ys = outline.map((point) => point.y);
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      const spacing = 9 / scale;
      context.save();
      context.clip(region.fillRule);
      context.strokeStyle = alpha('#82aaff', 0.72);
      context.lineWidth = 1.5 / scale;
      context.beginPath();
      for (let offset = minX - (maxY - minY); offset <= maxX; offset += spacing) {
        context.moveTo(offset, maxY);
        context.lineTo(offset + (maxY - minY), minY);
      }
      context.stroke();
      context.restore();
      appendRegionPath(context, region);
    }
    if (selected || hovered) {
      const color = hovered && subtract ? '#ef6b72' : hovered ? '#68a0ff' : '#8b6cf6';
      context.fillStyle = alpha(color, hovered ? (paintHover ? 0.1 : 0.27) : 0.16);
      context.fill(region.fillRule);
      context.strokeStyle = alpha(color, 0.92);
      context.lineWidth = (hovered ? 2 : 1.25) / scale;
      context.stroke();
    }
    context.restore();
  }
}

function appendRegionPath(context: CanvasRenderingContext2D, region: Region): void {
  context.beginPath();
  for (const loop of regionBoundaryLoops(region)) {
    if (loop.outline.length < 3) continue;
    context.moveTo(loop.outline[0].x, loop.outline[0].y);
    for (let index = 1; index < loop.outline.length; index += 1) {
      context.lineTo(loop.outline[index].x, loop.outline[index].y);
    }
    context.closePath();
  }
}

function drawSnapPreview(context: CanvasRenderingContext2D, snap: SnapResult, scale: number): void {
  if (snap.matches.length === 0) return;
  context.save();
  context.strokeStyle = alpha('#57c8d4', 0.82);
  context.fillStyle = '#0e0e0e';
  context.lineWidth = 1 / scale;
  context.setLineDash([4 / scale, 3 / scale]);
  if (snap.guideX !== undefined) {
    context.beginPath();
    context.moveTo(snap.guideX, snap.point.y - 100000 / scale);
    context.lineTo(snap.guideX, snap.point.y + 100000 / scale);
    context.stroke();
  }
  if (snap.guideY !== undefined) {
    context.beginPath();
    context.moveTo(snap.point.x - 100000 / scale, snap.guideY);
    context.lineTo(snap.point.x + 100000 / scale, snap.guideY);
    context.stroke();
  }
  context.setLineDash([]);
  context.beginPath();
  context.rect(snap.point.x - 4 / scale, snap.point.y - 4 / scale, 8 / scale, 8 / scale);
  context.fill();
  context.stroke();
  context.restore();
}

function drawConstructionLinePreview(
  context: CanvasRenderingContext2D,
  preview: ConstructionLinePreview,
  scale: number,
  viewportBounds: DocumentBounds,
): void {
  const end = preview.constrain
    ? constrainConstructionLineEndpoint(preview.start, preview.end)
    : preview.end;
  const geometry: ConstructionLineGeometry = {
    segmentId: 'construction-preview',
    extent: preview.extent,
    start: preview.start,
    end,
  };
  const span = constructionLineSpan(geometry, viewportBounds);
  context.save();
  context.strokeStyle = CONSTRUCTION_VISUAL_STYLE.base.color;
  context.globalAlpha = CONSTRUCTION_VISUAL_STYLE.base.opacity;
  context.lineWidth = CONSTRUCTION_VISUAL_STYLE.base.widthPx / scale;
  context.setLineDash(CONSTRUCTION_VISUAL_STYLE.base.dashPx.map((value) => value / scale));
  if (span) {
    context.beginPath();
    context.moveTo(span.start.x, span.start.y);
    context.lineTo(span.end.x, span.end.y);
    context.stroke();
  }
  context.setLineDash([]);
  context.fillStyle = '#c8c8c8';
  for (const point of [preview.start, end]) {
    context.beginPath();
    context.arc(point.x, point.y, 3 / scale, 0, Math.PI * 2);
    context.fill();
  }
  context.restore();
}

function drawPrimitivePreview(context: CanvasRenderingContext2D, preview: PrimitivePreview, scale: number): void {
  let dx = preview.end.x - preview.start.x;
  let dy = preview.end.y - preview.start.y;
  if (preview.constrain) {
    const size = Math.max(Math.abs(dx), Math.abs(dy));
    dx = (dx < 0 ? -1 : 1) * size;
    dy = (dy < 0 ? -1 : 1) * size;
  }
  const first = preview.fromCenter
    ? { x: preview.start.x - dx, y: preview.start.y - dy }
    : preview.start;
  const second = { x: preview.start.x + dx, y: preview.start.y + dy };
  const x = Math.min(first.x, second.x);
  const y = Math.min(first.y, second.y);
  const width = Math.abs(second.x - first.x);
  const height = Math.abs(second.y - first.y);
  context.save();
  context.fillStyle = alpha('#8b6cf6', 0.16);
  context.strokeStyle = '#b99cff';
  context.lineWidth = 1.25 / scale;
  context.setLineDash([5 / scale, 3 / scale]);
  context.beginPath();
  if (preview.kind === 'line') {
    context.moveTo(preview.start.x, preview.start.y);
    context.lineTo(preview.end.x, preview.end.y);
  } else if (preview.kind === 'ellipse') {
    context.ellipse(x + width / 2, y + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
  } else if (preview.kind === 'arc') {
    const radius = Math.min(width, height) / 2;
    context.arc(x + width / 2, y + height / 2, radius, Math.PI, Math.PI * 2);
  } else if (preview.kind === 'rounded-rectangle') {
    context.roundRect(x, y, width, height, Math.min(16, width / 2, height / 2));
  } else if (preview.kind === 'polygon' || preview.kind === 'star') {
    const count = preview.kind === 'star' ? 10 : 6;
    for (let index = 0; index < count; index += 1) {
      const angle = -Math.PI / 2 + index * Math.PI * 2 / count;
      const ratio = preview.kind === 'star' && index % 2 === 1 ? 0.48 : 1;
      const point = { x: x + width / 2 + Math.cos(angle) * width / 2 * ratio, y: y + height / 2 + Math.sin(angle) * height / 2 * ratio };
      if (index === 0) context.moveTo(point.x, point.y); else context.lineTo(point.x, point.y);
    }
    context.closePath();
  } else context.rect(x, y, width, height);
  if (preview.kind !== 'line' && preview.kind !== 'arc') context.fill();
  context.stroke();
  context.restore();
}

function drawLassoPreview(context: CanvasRenderingContext2D, points: Point[], scale: number): void {
  context.save();
  context.beginPath();
  context.moveTo(points[0].x, points[0].y);
  for (const point of points.slice(1)) context.lineTo(point.x, point.y);
  context.closePath();
  context.fillStyle = alpha('#6f9cff', 0.1);
  context.fill();
  context.strokeStyle = '#78a2ff';
  context.lineWidth = 1.25 / scale;
  context.setLineDash([5 / scale, 4 / scale]);
  context.stroke();
  context.restore();
}

function drawMarqueePreview(context: CanvasRenderingContext2D, preview: MarqueePreview, scale: number): void {
  const x = Math.min(preview.start.x, preview.end.x);
  const y = Math.min(preview.start.y, preview.end.y);
  const width = Math.abs(preview.end.x - preview.start.x);
  const height = Math.abs(preview.end.y - preview.start.y);
  context.save();
  context.fillStyle = alpha('#d7d7d7', preview.mode === 'contain' ? 0.09 : 0.14);
  context.strokeStyle = '#d8d8d8';
  context.lineWidth = 1 / scale;
  context.setLineDash(preview.mode === 'contain' ? [] : [4 / scale, 3 / scale]);
  context.fillRect(x, y, width, height);
  context.strokeRect(x, y, width, height);
  context.restore();
}

function drawEraserPreview(context: CanvasRenderingContext2D, preview: EraserPreview, scale: number): void {
  context.save();
  context.beginPath();
  if (preview.shape === 'square') {
    context.rect(
      preview.point.x - preview.radius / scale,
      preview.point.y - preview.radius / scale,
      preview.radius * 2 / scale,
      preview.radius * 2 / scale,
    );
  } else {
    context.arc(preview.point.x, preview.point.y, preview.radius / scale, 0, Math.PI * 2);
  }
  context.fillStyle = alpha('#ffffff', 0.16);
  context.fill();
  context.strokeStyle = '#1f6feb';
  context.lineWidth = 1 / scale;
  context.setLineDash([]);
  context.stroke();
  context.restore();
}

function drawCutPreview(
  context: CanvasRenderingContext2D,
  preview: { start: Point; end: Point },
  scale: number,
): void {
  context.save();
  context.beginPath();
  context.moveTo(preview.start.x, preview.start.y);
  context.lineTo(preview.end.x, preview.end.y);
  context.strokeStyle = '#f0b35b';
  context.lineWidth = 1.5 / scale;
  context.setLineDash([6 / scale, 4 / scale]);
  context.stroke();
  context.setLineDash([]);
  for (const point of [preview.start, preview.end]) {
    context.beginPath();
    context.arc(point.x, point.y, 3 / scale, 0, Math.PI * 2);
    context.fillStyle = '#f0b35b';
    context.fill();
  }
  context.restore();
}

function drawBendPreview(context: CanvasRenderingContext2D, preview: BendPreview, scale: number): void {
  if (preview.kind === 'handles') {
    drawPenPreview(context, { kind: 'handles', anchor: preview.anchor, cursor: preview.cursor }, scale);
    return;
  }
  const { curve } = preview;
  context.beginPath();
  context.moveTo(curve.p0.x, curve.p0.y);
  context.bezierCurveTo(curve.p1.x, curve.p1.y, curve.p2.x, curve.p2.y, curve.p3.x, curve.p3.y);
  context.strokeStyle = '#74a0ff';
  context.lineWidth = 2 / scale;
  context.stroke();
  context.beginPath();
  context.moveTo(curve.p0.x, curve.p0.y);
  context.lineTo(curve.p1.x, curve.p1.y);
  context.moveTo(curve.p3.x, curve.p3.y);
  context.lineTo(curve.p2.x, curve.p2.y);
  context.strokeStyle = alpha('#74a0ff', 0.6);
  context.lineWidth = 1 / scale;
  context.stroke();
}

function strokeSegment(
  context: CanvasRenderingContext2D,
  segment: Segment,
  start: Point,
  end: Point,
  handleOut?: Point,
  handleIn?: Point,
): void {
  context.beginPath();
  context.moveTo(start.x, start.y);
  appendSegmentPath(context, segment, start, end, handleOut, handleIn);
  context.stroke();
}

function appendSegmentPath(
  context: CanvasRenderingContext2D,
  segment: Segment,
  start: Point,
  end: Point,
  handleOut?: Point,
  handleIn?: Point,
): void {
  if (isNativeArc(segment)) {
    context.arc(
      segment.center!.x,
      segment.center!.y,
      segment.radius!,
      segment.startAngle!,
      segment.startAngle! + arcSweep(segment),
      arcSweep(segment) < 0,
    );
  } else if (segment.type === 'bezier') {
    const control1 = handleOut ?? start;
    const control2 = handleIn ?? end;
    context.bezierCurveTo(control1.x, control1.y, control2.x, control2.y, end.x, end.y);
  } else {
    context.lineTo(end.x, end.y);
  }
}

function strokeVariableWidthSegment(
  context: CanvasRenderingContext2D,
  document: VectorDocument,
  segment: Segment,
  scale: number,
): void {
  const widthAt = (t: number): number => sampleWidthProfile(segment.widthProfile, t, 1.25);
  const steps = segment.type === 'line' ? 16 : 64;
  context.save();
  context.lineCap = 'round';
  for (let index = 0; index < steps; index += 1) {
    const startT = index / steps;
    const endT = (index + 1) / steps;
    const start = evaluateSegment(document, segment, startT);
    const end = evaluateSegment(document, segment, endT);
    context.beginPath();
    context.moveTo(start.x, start.y);
    context.lineTo(end.x, end.y);
    context.lineWidth = Math.max(0.25 / scale, widthAt((startT + endT) / 2));
    context.stroke();
  }
  context.restore();
}


function alpha(hex: string, opacity: number): string {
  const value = hex.replace('#', '');
  const number = Number.parseInt(value, 16);
  return `rgba(${(number >> 16) & 255}, ${(number >> 8) & 255}, ${number & 255}, ${opacity})`;
}
