import type { VectorDocument } from '../core/document';
import { evaluateSegment } from '../core/geometry';
import { createEntityId } from '../core/ids';
import { emptyGraphPatch, type GraphPatch } from '../core/operations';
import type { EntityId, Point, Segment, VectorNode, VectorPath } from '../core/types';

export interface OffsetPlan {
  sourcePathId: EntityId;
  resultPathId: EntityId;
  resultSegmentIds: EntityId[];
  patch: GraphPatch;
}

/** Creates a typed-graph path offset. Curves retain their native segment kind. */
export function preparePathOffset(
  document: VectorDocument,
  pathId: EntityId,
  distance: number,
): OffsetPlan | null {
  const path = document.getPath(pathId);
  const network = document.findNetworkForPath(pathId);
  if (!path || !network || path.segmentIds.length === 0 || !Number.isFinite(distance) || Math.abs(distance) < 1e-6) return null;
  const segments = path.segmentIds.map((id) => document.getSegment(id)).filter((segment): segment is Segment => Boolean(segment));
  if (segments.length !== path.segmentIds.length) return null;
  if (segments.some((segment) => segment.role === 'construction')) {
    throw new Error('Offset is unavailable for construction segments.');
  }

  const nodeIds = [...new Set(segments.flatMap((segment) => [segment.startNodeId, segment.endNodeId]))];
  const mappedNodes = new Map<EntityId, VectorNode>();
  for (const nodeId of nodeIds) {
    const node = document.getNode(nodeId);
    if (!node) return null;
    const incident = segments.filter((segment) => segment.startNodeId === nodeId || segment.endNodeId === nodeId);
    const normals = incident.map((segment) => normalAtNode(document, segment, nodeId));
    let offset: Point;
    if (normals.length === 1) {
      offset = scale(normals[0], distance);
    } else {
      const average = normalize(normals.reduce(add, { x: 0, y: 0 }));
      const denominator = Math.max(0.2, Math.abs(dot(average, normals[0])));
      offset = scale(average, Math.max(-Math.abs(distance) * 4, Math.min(Math.abs(distance) * 4, distance / denominator)));
    }
    mappedNodes.set(nodeId, {
      id: createEntityId(),
      position: add(node.position, offset),
      handleIn: node.handleIn ? add(node.handleIn, offset) : undefined,
      handleOut: node.handleOut ? add(node.handleOut, offset) : undefined,
      constraintIds: [],
    });
  }

  const resultPath: VectorPath = { id: createEntityId(), segmentIds: [], isClosed: path.isClosed };
  const resultSegments = segments.map((segment): Segment => {
    const radius = segment.type === 'arc'
      ? (segment.radius ?? 0) + (segment.clockwise ? distance : -distance)
      : segment.radius;
    if (segment.type === 'arc' && (radius ?? 0) <= 1e-6) {
      throw new Error('Offset collapses the circular arc radius.');
    }
    return {
      ...segment,
      id: createEntityId(),
      startNodeId: mappedNodes.get(segment.startNodeId)!.id,
      endNodeId: mappedNodes.get(segment.endNodeId)!.id,
      center: segment.center ? { ...segment.center } : undefined,
      radius,
      widthProfile: segment.widthProfile?.map((point) => ({ ...point, id: createEntityId() })),
    };
  });
  for (const segment of resultSegments) {
    if (segment.type !== 'arc' || !segment.center || !segment.radius ||
      segment.startAngle === undefined || segment.endAngle === undefined) continue;
    const startNode = [...mappedNodes.values()].find((node) => node.id === segment.startNodeId);
    const endNode = [...mappedNodes.values()].find((node) => node.id === segment.endNodeId);
    if (startNode) moveNodeTo(startNode, {
      x: segment.center.x + segment.radius * Math.cos(segment.startAngle),
      y: segment.center.y + segment.radius * Math.sin(segment.startAngle),
    });
    if (endNode) moveNodeTo(endNode, {
      x: segment.center.x + segment.radius * Math.cos(segment.endAngle),
      y: segment.center.y + segment.radius * Math.sin(segment.endAngle),
    });
  }
  const resultSegmentIds = resultSegments.map((segment) => segment.id);

  const patch = emptyGraphPatch();
  for (const node of mappedNodes.values()) patch.addNodes.push({ node, networkId: network.id });
  patch.addPaths.push({ path: resultPath, networkId: network.id });
  resultSegments.forEach((segment, index) => patch.addSegments.push({ segment, pathId: resultPath.id, index }));
  return {
    sourcePathId: path.id,
    resultPathId: resultPath.id,
    resultSegmentIds,
    patch,
  };
}

function moveNodeTo(node: VectorNode, position: Point): void {
  const delta = subtract(position, node.position);
  node.position = { ...position };
  if (node.handleIn) node.handleIn = add(node.handleIn, delta);
  if (node.handleOut) node.handleOut = add(node.handleOut, delta);
}

function normalAtNode(document: VectorDocument, segment: Segment, nodeId: EntityId): Point {
  const epsilon = 1e-4;
  const atStart = segment.startNodeId === nodeId;
  const a = evaluateSegment(document, segment, atStart ? 0 : 1 - epsilon);
  const b = evaluateSegment(document, segment, atStart ? epsilon : 1);
  const tangent = normalize(subtract(b, a));
  return { x: -tangent.y, y: tangent.x };
}

function add(a: Point, b: Point): Point { return { x: a.x + b.x, y: a.y + b.y }; }
function subtract(a: Point, b: Point): Point { return { x: a.x - b.x, y: a.y - b.y }; }
function scale(point: Point, factor: number): Point { return { x: point.x * factor, y: point.y * factor }; }
function dot(a: Point, b: Point): number { return a.x * b.x + a.y * b.y; }
function normalize(point: Point): Point {
  const length = Math.hypot(point.x, point.y);
  return length > 1e-12 ? scale(point, 1 / length) : { x: 0, y: 0 };
}
