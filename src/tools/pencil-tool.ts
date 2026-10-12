import type { VectorDocument } from '../core/document';
import { prepareArtboardPlacement } from '../core/artboard-operations';
import { appearanceFromDrawingStyle } from '../core/drawing-style';
import { createEntityId } from '../core/ids';
import type { OperationInput } from '../core/operations';
import type { DrawingStyle, EntityId, LayerNode, NetworkObject, Point, Segment, VectorNode, VectorPath } from '../core/types';

export interface PencilPlan {
  objectId: EntityId;
  layerId: EntityId;
  networkId: EntityId;
  pathId: EntityId;
  nodeIds: EntityId[];
  segmentIds: EntityId[];
  operations: OperationInput[];
}

export interface FreehandObjectOptions {
  namePrefix?: 'Pencil' | 'Brush';
  widths?: number[];
}

/** Builds one smoothed, standalone graph-backed object from a freehand gesture. */
export function preparePencilObject(
  document: VectorDocument,
  points: Point[],
  style: DrawingStyle,
  options: FreehandObjectOptions = {},
): PencilPlan | null {
  const compact = deduplicate(points, Math.max(0.2, style.strokeWidth * 0.08));
  if (compact.length < 2) return null;
  const simplified = simplify(compact, Math.max(0.35, style.strokeWidth * 0.12));
  if (simplified.length < 2) return null;

  const origin = simplified[0];
  const local = simplified.map((point) => ({ x: point.x - origin.x, y: point.y - origin.y }));
  const nodes = smoothNodes(local);
  const widthAt = (ratio: number) => {
    const widths = options.widths;
    if (!widths?.length) return undefined;
    const position = Math.max(0, Math.min(widths.length - 1, ratio * (widths.length - 1)));
    const left = Math.floor(position);
    const right = Math.min(widths.length - 1, left + 1);
    const blend = position - left;
    return Math.max(0.5, widths[left] + (widths[right] - widths[left]) * blend);
  };
  const segments: Segment[] = nodes.slice(0, -1).map((node, index) => {
    const denominator = Math.max(1, nodes.length - 1);
    const startWidth = widthAt(index / denominator);
    const endWidth = widthAt((index + 1) / denominator);
    return {
      id: createEntityId(),
      startNodeId: node.id,
      endNodeId: nodes[index + 1].id,
      type: 'bezier',
      role: 'geometry',
      widthProfile: startWidth === undefined || endWidth === undefined ? undefined : [
        { id: createEntityId(), t: 0, width: startWidth },
        { id: createEntityId(), t: 1, width: endWidth },
      ],
    };
  });

  const networkId = createEntityId();
  const appearanceId = createEntityId();
  const objectId = createEntityId();
  const layerId = createEntityId();
  const pathId = createEntityId();
  const name = nextFreehandName(document, options.namePrefix ?? 'Pencil');
  const path: VectorPath = { id: pathId, segmentIds: [], isClosed: false };
  const object: NetworkObject = {
    id: objectId,
    name,
    networkId,
    appearanceId,
    transform: { x: origin.x, y: origin.y, rotation: 0, scaleX: 1, scaleY: 1 },
  };
  const center = simplified.reduce(
    (sum, point) => ({ x: sum.x + point.x / simplified.length, y: sum.y + point.y / simplified.length }),
    { x: 0, y: 0 },
  );
  const placement = prepareArtboardPlacement(document, center);
  const targetArtboard = document.getArtboard(placement.artboardId);
  const layer: LayerNode = {
    id: layerId,
    kind: 'object',
    name,
    artboardId: placement.artboardId,
    childIds: [],
    objectId,
    visible: true,
    locked: false,
    expanded: true,
  };
  const operations: OperationInput[] = [
    ...placement.setupOperations,
    { type: 'ADD_NETWORK', payload: { network: { id: networkId, nodeIds: [], pathIds: [] } } },
    { type: 'ADD_APPEARANCE', payload: { appearance: appearanceFromDrawingStyle(appearanceId, { ...style, fillEnabled: false }) } },
    { type: 'ADD_OBJECT', payload: { object } },
    { type: 'ADD_LAYER', payload: { layer, index: targetArtboard?.layerIds.length ?? 0 } },
    ...nodes.map((node): OperationInput => ({ type: 'ADD_NODE', payload: { node, networkId } })),
    { type: 'ADD_PATH', payload: { path, networkId } },
    ...segments.map((segment): OperationInput => ({ type: 'ADD_SEGMENT', payload: { segment, pathId } })),
    ...(placement.artboardId === document.activeArtboardId ? [] : [{
      type: 'SET_ACTIVE_LOCATION' as const,
      payload: { pageId: document.activePageId, artboardId: placement.artboardId },
    }]),
  ];
  return {
    objectId,
    layerId,
    networkId,
    pathId,
    nodeIds: nodes.map((node) => node.id),
    segmentIds: segments.map((segment) => segment.id),
    operations,
  };
}

function smoothNodes(points: Point[]): VectorNode[] {
  const tension = 0.82;
  return points.map((position, index) => {
    const previous = points[Math.max(0, index - 1)];
    const next = points[Math.min(points.length - 1, index + 1)];
    const tangent = {
      x: (next.x - previous.x) * tension / 6,
      y: (next.y - previous.y) * tension / 6,
    };
    return {
      id: createEntityId(),
      position: { ...position },
      handleIn: index > 0 ? { x: position.x - tangent.x, y: position.y - tangent.y } : undefined,
      handleOut: index < points.length - 1 ? { x: position.x + tangent.x, y: position.y + tangent.y } : undefined,
      handleMode: 'smooth',
      constraintIds: [],
    };
  });
}

function deduplicate(points: Point[], minimumDistance: number): Point[] {
  const output: Point[] = [];
  for (const point of points) {
    const previous = output.at(-1);
    if (!previous || Math.hypot(point.x - previous.x, point.y - previous.y) >= minimumDistance) {
      output.push({ ...point });
    }
  }
  const last = points.at(-1);
  if (last && output.length > 0) {
    const tail = output.at(-1)!;
    if (tail.x !== last.x || tail.y !== last.y) output.push({ ...last });
  }
  return output;
}

function simplify(points: Point[], tolerance: number): Point[] {
  if (points.length <= 2) return points.map((point) => ({ ...point }));
  const first = points[0];
  const last = points.at(-1)!;
  let furthest = 0;
  let index = 0;
  for (let cursor = 1; cursor < points.length - 1; cursor += 1) {
    const distance = pointLineDistance(points[cursor], first, last);
    if (distance > furthest) {
      furthest = distance;
      index = cursor;
    }
  }
  if (furthest <= tolerance) return [{ ...first }, { ...last }];
  const before = simplify(points.slice(0, index + 1), tolerance);
  const after = simplify(points.slice(index), tolerance);
  return [...before.slice(0, -1), ...after];
}

function pointLineDistance(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const denominator = dx * dx + dy * dy;
  if (denominator < 1e-12) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / denominator));
  return Math.hypot(point.x - (start.x + dx * t), point.y - (start.y + dy * t));
}

function nextFreehandName(document: VectorDocument, prefix: 'Pencil' | 'Brush'): string {
  const expression = new RegExp(`^${prefix}(?:\\s|$)`);
  const count = document.objectsForArtboard(document.activeArtboardId)
    .filter((object) => expression.test(object.name)).length;
  return `${prefix} ${count + 1}`;
}
