import type { VectorDocument } from './document';
import { evaluateSegment } from './geometry';
import { parametricInstanceMatrices, parametricSourceObjectId } from './parametric';
import { objectTransformMatrix, transformPoint } from './transforms';
import type { EntityId, NetworkObject, Point, Segment } from './types';

export interface GeometryBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}

export interface ObjectBoundsPolicy {
  transformed: boolean;
  includeConstruction: boolean;
  includeParametricInstances: boolean;
  /** Infinite construction lines always remain finite in bounds calculations. */
  infinitePolicy: 'anchors';
}

/** Normal artwork/layout/export policy: guides do not affect visual bounds. */
export const ARTWORK_BOUNDS_POLICY: ObjectBoundsPolicy = {
  transformed: true,
  includeConstruction: false,
  includeParametricInstances: true,
  infinitePolicy: 'anchors',
};

/** Selection and Layers framing policy: include guide anchors, never extensions. */
export const INTERACTION_BOUNDS_POLICY: ObjectBoundsPolicy = {
  transformed: true,
  includeConstruction: true,
  includeParametricInstances: true,
  infinitePolicy: 'anchors',
};

export function objectLocalPoints(
  document: VectorDocument,
  objectId: EntityId,
  policy: ObjectBoundsPolicy = ARTWORK_BOUNDS_POLICY,
): Point[] {
  const object = document.getObject(objectId);
  const network = object ? document.getNetwork(object.networkId) : undefined;
  if (!network) return [];

  const segments = network.pathIds
    .flatMap((pathId) => document.getPath(pathId)?.segmentIds ?? [])
    .map((segmentId) => document.getSegment(segmentId))
    .filter((segment): segment is Segment => Boolean(segment))
    .filter((segment) => policy.includeConstruction || segment.role === 'geometry');
  const points: Point[] = [];
  const includedNodeIds = new Set<EntityId>();
  for (const segment of segments) {
    includedNodeIds.add(segment.startNodeId);
    includedNodeIds.add(segment.endNodeId);
  }
  // Interaction bounds retain standalone edit anchors. Artwork bounds only use
  // nodes that belong to geometry segments, so construction-only paths vanish.
  if (policy.includeConstruction) {
    for (const nodeId of network.nodeIds) includedNodeIds.add(nodeId);
  }
  for (const nodeId of includedNodeIds) {
    const point = document.getNode(nodeId)?.position;
    if (point) points.push({ ...point });
  }

  for (const segment of segments) {
    if (segment.role === 'construction' &&
      segment.constructionExtent === 'infinite' &&
      policy.infinitePolicy === 'anchors') {
      continue;
    }
    const steps = segment.type === 'line' ? 1 : 32;
    for (let index = 0; index <= steps; index += 1) {
      points.push(evaluateSegment(document, segment, index / steps));
    }
  }
  return points;
}

export function objectBounds(
  document: VectorDocument,
  objectId: EntityId,
  policy: ObjectBoundsPolicy = ARTWORK_BOUNDS_POLICY,
): GeometryBounds {
  const object = document.getObject(objectId);
  return objectBoundsForTransform(document, objectId, object?.transform, policy);
}

/** Computes the same authoritative object bounds for a proposed transform without mutating the graph. */
export function objectBoundsForTransform(
  document: VectorDocument,
  objectId: EntityId,
  transform: NetworkObject['transform'] | undefined,
  policy: ObjectBoundsPolicy = ARTWORK_BOUNDS_POLICY,
): GeometryBounds {
  const matrix = transform ? objectTransformMatrix(transform) : undefined;
  const localPoints = objectLocalPoints(document, objectId, policy);
  if (policy.includeParametricInstances) {
    for (const group of document.parametricGroups.values()) {
      if (parametricSourceObjectId(document, group) !== objectId) continue;
      const sourcePoints = group.sourcePathIds.flatMap((pathId) =>
        (document.getPath(pathId)?.segmentIds ?? []).flatMap((segmentId) => {
          const segment = document.getSegment(segmentId);
          if (!segment || segment.role !== 'geometry') return [];
          const steps = segment.type === 'line' ? 1 : 32;
          return Array.from({ length: steps + 1 }, (_, index) =>
            evaluateSegment(document, segment, index / steps));
        }));
      for (const instanceMatrix of parametricInstanceMatrices(document, group)) {
        localPoints.push(...sourcePoints.map((point) => transformPoint(point, instanceMatrix)));
      }
    }
  }
  const points = localPoints
    .map((point) => policy.transformed && matrix ? transformPoint(point, matrix) : point);
  return boundsForPoints(points);
}

export function boundsForPoints(points: Point[]): GeometryBounds {
  if (points.length === 0) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
  }
  const minX = Math.min(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxX = Math.max(...points.map((point) => point.x));
  const maxY = Math.max(...points.map((point) => point.y));
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}
