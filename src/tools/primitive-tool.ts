import type { VectorDocument } from '../core/document';
import { prepareArtboardPlacement } from '../core/artboard-operations';
import { DEFAULT_DRAWING_STYLE, appearanceFromDrawingStyle } from '../core/drawing-style';
import { createEntityId } from '../core/ids';
import type { OperationInput } from '../core/operations';
import type { Appearance, DrawingStyle, EntityId, LayerNode, NetworkObject, Point, Segment, VectorNode, VectorPath } from '../core/types';

export type PrimitiveKind = 'rectangle' | 'rounded-rectangle' | 'ellipse' | 'polygon' | 'star' | 'line' | 'arc';

export interface PrimitivePlan {
  kind: PrimitiveKind; name: string; objectId: EntityId; layerId: EntityId; networkId: EntityId;
  pathId: EntityId; nodeIds: EntityId[]; segmentIds: EntityId[]; operations: OperationInput[];
}
export interface PrimitiveOptions {
  /** The person's current line and fill defaults. Without it the legacy tinted-fill look is used. */
  style?: DrawingStyle;
  constrain?: boolean; fromCenter?: boolean; cornerRadius?: number; sides?: number; starInnerRatio?: number;
}
interface Geometry { nodes: VectorNode[]; segments: Segment[]; isClosed: boolean; origin: Point }

/** Converts a disposable drag preview into authoritative, operation-backed network geometry. */
export function preparePrimitiveObject(
  document: VectorDocument, kind: PrimitiveKind, start: Point, end: Point, options: PrimitiveOptions = {},
): PrimitivePlan | null {
  const geometry = kind === 'line'
    ? lineGeometry(start, end, options.constrain)
    : boundedGeometry(kind, start, end, options);
  if (!geometry) return null;
  const networkId = createEntityId();
  const appearanceId = createEntityId();
  const objectId = createEntityId();
  const layerId = createEntityId();
  const pathId = createEntityId();
  const name = primitiveName(kind);
  const path: VectorPath = { id: pathId, segmentIds: [], isClosed: geometry.isClosed };
  const appearance: Appearance = options.style
    ? { ...appearanceFromDrawingStyle(appearanceId, options.style), fills: geometry.isClosed ? appearanceFromDrawingStyle(appearanceId, options.style).fills : [] }
    : {
        id: appearanceId,
        fills: geometry.isClosed ? [{ type: 'solid', color: '#8b6cf6', opacity: 0.18, visible: true }] : [],
        stroke: {
          color: DEFAULT_DRAWING_STYLE.strokeColor,
          width: DEFAULT_DRAWING_STYLE.strokeWidth,
          cap: DEFAULT_DRAWING_STYLE.strokeCap,
          join: DEFAULT_DRAWING_STYLE.strokeJoin,
          alignment: DEFAULT_DRAWING_STYLE.strokeAlignment,
          opacity: 1,
          dash: [],
          visible: DEFAULT_DRAWING_STYLE.strokeEnabled,
        },
        opacity: 1,
      };
  const object: NetworkObject = {
    id: objectId, name, networkId, appearanceId,
    transform: { x: geometry.origin.x, y: geometry.origin.y, rotation: 0, scaleX: 1, scaleY: 1 },
  };
  const center = geometry.nodes.reduce(
    (sum, node) => ({ x: sum.x + node.position.x / geometry.nodes.length, y: sum.y + node.position.y / geometry.nodes.length }),
    { ...geometry.origin },
  );
  const placement = prepareArtboardPlacement(document, center);
  const targetArtboard = document.getArtboard(placement.artboardId);
  const layer: LayerNode = {
    id: layerId, kind: 'object', name, artboardId: placement.artboardId, childIds: [], objectId,
    visible: true, locked: false, expanded: true,
  };
  const operations: OperationInput[] = [
    ...placement.setupOperations,
    { type: 'ADD_NETWORK', payload: { network: { id: networkId, nodeIds: [], pathIds: [] } } },
    { type: 'ADD_APPEARANCE', payload: { appearance } },
    { type: 'ADD_OBJECT', payload: { object } },
    { type: 'ADD_LAYER', payload: { layer, index: targetArtboard?.layerIds.length ?? 0 } },
    ...geometry.nodes.map((node): OperationInput => ({ type: 'ADD_NODE', payload: { node, networkId } })),
    { type: 'ADD_PATH', payload: { path, networkId } },
    ...geometry.segments.map((segment): OperationInput => ({ type: 'ADD_SEGMENT', payload: { segment, pathId } })),
    ...(placement.artboardId === document.activeArtboardId ? [] : [{
      type: 'SET_ACTIVE_LOCATION' as const,
      payload: { pageId: document.activePageId, artboardId: placement.artboardId },
    }]),
  ];
  return {
    kind, name, objectId, layerId, networkId, pathId,
    nodeIds: geometry.nodes.map((node) => node.id), segmentIds: geometry.segments.map((segment) => segment.id), operations,
  };
}

function boundedGeometry(kind: Exclude<PrimitiveKind, 'line'>, start: Point, end: Point, options: PrimitiveOptions): Geometry | null {
  const bounds = primitiveBounds(start, end, options);
  if (bounds.width < 1e-6 || bounds.height < 1e-6) return null;
  let data: Omit<Geometry, 'origin'>;
  if (kind === 'rectangle') data = rectangleGeometry(bounds.width, bounds.height);
  else if (kind === 'rounded-rectangle') data = roundedRectangleGeometry(bounds.width, bounds.height, options.cornerRadius ?? 16);
  else if (kind === 'ellipse') data = ellipseGeometry(bounds.width, bounds.height);
  else if (kind === 'polygon') data = radialGeometry(bounds.width, bounds.height, Math.max(3, Math.round(options.sides ?? 6)), 1);
  else if (kind === 'star') data = radialGeometry(bounds.width, bounds.height, Math.max(3, Math.round(options.sides ?? 5)), clamp(options.starInnerRatio ?? 0.48, 0.05, 0.95));
  else data = arcGeometry(bounds.width, bounds.height);
  return { ...data, origin: { x: bounds.x, y: bounds.y } };
}

function primitiveBounds(start: Point, end: Point, options: PrimitiveOptions) {
  let dx = end.x - start.x;
  let dy = end.y - start.y;
  if (options.constrain) {
    const size = Math.max(Math.abs(dx), Math.abs(dy));
    dx = (dx < 0 ? -1 : 1) * size;
    dy = (dy < 0 ? -1 : 1) * size;
  }
  const first = options.fromCenter ? { x: start.x - dx, y: start.y - dy } : start;
  const second = { x: start.x + dx, y: start.y + dy };
  return { x: Math.min(first.x, second.x), y: Math.min(first.y, second.y), width: Math.abs(second.x - first.x), height: Math.abs(second.y - first.y) };
}

function lineGeometry(start: Point, end: Point, constrain = false): Geometry | null {
  let dx = end.x - start.x;
  let dy = end.y - start.y;
  if (constrain) {
    const length = Math.hypot(dx, dy);
    const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI / 4;
    dx = Math.cos(angle) * length; dy = Math.sin(angle) * length;
  }
  if (Math.hypot(dx, dy) < 1e-6) return null;
  const nodes = nodesFor([{ x: 0, y: 0 }, { x: dx, y: dy }]);
  return { nodes, segments: [line(nodes[0], nodes[1])], isClosed: false, origin: { ...start } };
}

function rectangleGeometry(width: number, height: number): Omit<Geometry, 'origin'> {
  return closedLines([{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }]);
}

function roundedRectangleGeometry(width: number, height: number, requested: number): Omit<Geometry, 'origin'> {
  const r = clamp(requested, 0, Math.min(width, height) / 2);
  if (r < 1e-6) return rectangleGeometry(width, height);
  const nodes = nodesFor([{ x: r, y: 0 }, { x: width - r, y: 0 }, { x: width, y: r }, { x: width, y: height - r }, { x: width - r, y: height }, { x: r, y: height }, { x: 0, y: height - r }, { x: 0, y: r }]);
  const segments: Segment[] = [];
  const centers = [{ x: width - r, y: r }, { x: width - r, y: height - r }, { x: r, y: height - r }, { x: r, y: r }];
  for (let corner = 0; corner < 4; corner += 1) {
    const lineStart = nodes[corner * 2];
    const lineEnd = nodes[corner * 2 + 1];
    const arcEnd = nodes[(corner * 2 + 2) % 8];
    segments.push(line(lineStart, lineEnd));
    segments.push({
      id: createEntityId(), startNodeId: lineEnd.id, endNodeId: arcEnd.id, type: 'arc', role: 'geometry', center: centers[corner], radius: r,
      startAngle: -Math.PI / 2 + corner * Math.PI / 2, endAngle: corner * Math.PI / 2,
    });
  }
  return { nodes, segments, isClosed: true };
}

function ellipseGeometry(width: number, height: number): Omit<Geometry, 'origin'> {
  const rx = width / 2, ry = height / 2, k = 0.5522847498307936;
  const nodes: VectorNode[] = [
    node({ x: rx, y: 0 }, { x: rx - k * rx, y: 0 }, { x: rx + k * rx, y: 0 }),
    node({ x: width, y: ry }, { x: width, y: ry - k * ry }, { x: width, y: ry + k * ry }),
    node({ x: rx, y: height }, { x: rx + k * rx, y: height }, { x: rx - k * rx, y: height }),
    node({ x: 0, y: ry }, { x: 0, y: ry + k * ry }, { x: 0, y: ry - k * ry }),
  ];
  return { nodes, segments: nodes.map((item, i) => ({ id: createEntityId(), startNodeId: item.id, endNodeId: nodes[(i + 1) % 4].id, type: 'bezier', role: 'geometry' })), isClosed: true };
}

function radialGeometry(width: number, height: number, sides: number, innerRatio: number): Omit<Geometry, 'origin'> {
  const count = innerRatio < 1 ? sides * 2 : sides;
  const points = Array.from({ length: count }, (_, index) => {
    const angle = -Math.PI / 2 + index * Math.PI * 2 / count;
    const ratio = innerRatio < 1 && index % 2 === 1 ? innerRatio : 1;
    return { x: width / 2 + Math.cos(angle) * width / 2 * ratio, y: height / 2 + Math.sin(angle) * height / 2 * ratio };
  });
  return closedLines(points);
}

function arcGeometry(width: number, height: number): Omit<Geometry, 'origin'> {
  const radius = Math.min(width, height) / 2;
  const center = { x: width / 2, y: height / 2 };
  const nodes = nodesFor([{ x: center.x - radius, y: center.y }, { x: center.x + radius, y: center.y }]);
  return { nodes, segments: [{ id: createEntityId(), startNodeId: nodes[0].id, endNodeId: nodes[1].id, type: 'arc', role: 'geometry', center, radius, startAngle: Math.PI, endAngle: Math.PI * 2 }], isClosed: false };
}

function closedLines(points: Point[]): Omit<Geometry, 'origin'> {
  const nodes = nodesFor(points);
  return { nodes, segments: nodes.map((item, i) => line(item, nodes[(i + 1) % nodes.length])), isClosed: true };
}
function nodesFor(points: Point[]) { return points.map((position) => node(position)); }
function node(position: Point, handleIn?: Point, handleOut?: Point): VectorNode { return { id: createEntityId(), position, handleIn, handleOut, constraintIds: [] }; }
function line(start: VectorNode, end: VectorNode): Segment { return { id: createEntityId(), startNodeId: start.id, endNodeId: end.id, type: 'line', role: 'geometry' }; }
function primitiveName(kind: PrimitiveKind) { return kind.split('-').map((word) => word[0].toUpperCase() + word.slice(1)).join(' '); }
function clamp(value: number, min: number, max: number) { return Math.max(min, Math.min(max, value)); }
