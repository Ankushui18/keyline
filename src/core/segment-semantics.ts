import type { VectorDocument } from './document';
import type { ConstructionLineSegment, EntityId, Segment, SelectionState, VectorPath } from './types';

export function isConstructionSegment(segment: Segment): segment is ConstructionLineSegment {
  return segment.role === 'construction';
}

export function isGeometrySegment(segment: Segment): boolean {
  return segment.role === 'geometry';
}

export type ObjectConstructionComposition = 'empty' | 'artwork' | 'construction-only' | 'mixed';

/** Classifies ordinary network objects without introducing a parallel guide tree. */
export function objectConstructionComposition(
  document: VectorDocument,
  objectId: EntityId,
): ObjectConstructionComposition {
  const object = document.getObject(objectId);
  const network = object ? document.getNetwork(object.networkId) : undefined;
  if (!network) return 'empty';
  const segments = network.pathIds.flatMap((pathId) =>
    document.getPath(pathId)?.segmentIds.map((segmentId) => document.getSegment(segmentId)).filter((segment): segment is Segment => Boolean(segment)) ?? [],
  );
  if (segments.length === 0) return 'empty';
  const constructionCount = segments.filter(isConstructionSegment).length;
  if (constructionCount === 0) return 'artwork';
  if (constructionCount === segments.length) return 'construction-only';
  return 'mixed';
}

export function selectionIsConstructionOnly(
  document: VectorDocument,
  selection: SelectionState,
): boolean {
  if (selection.mode === 'object') {
    return selection.objectIds.size > 0 && [...selection.objectIds].every(
      (objectId) => objectConstructionComposition(document, objectId) === 'construction-only',
    );
  }
  if (selection.segmentIds.size > 0) {
    return [...selection.segmentIds].every((segmentId) => document.getSegment(segmentId)?.role === 'construction');
  }
  if (selection.nodeIds.size > 0) {
    const connected = [...new Map(
      [...selection.nodeIds]
        .flatMap((nodeId) => document.connectedSegments(nodeId))
        .map((segment) => [segment.id, segment] as const),
    ).values()];
    return connected.length > 0 && connected.every((segment) => segment.role === 'construction');
  }
  return false;
}

export function pathHasConstruction(
  document: VectorDocument,
  pathOrId: VectorPath | EntityId,
): boolean {
  const path = typeof pathOrId === 'string' ? document.getPath(pathOrId) : pathOrId;
  return Boolean(path?.segmentIds.some((segmentId) => {
    const segment = document.getSegment(segmentId);
    return segment ? isConstructionSegment(segment) : false;
  }));
}

/** True only when a closed path is a complete, geometry-only artwork boundary. */
export function isArtworkFillPath(
  document: VectorDocument,
  pathOrId: VectorPath | EntityId,
): boolean {
  const path = typeof pathOrId === 'string' ? document.getPath(pathOrId) : pathOrId;
  return Boolean(path?.isClosed && path.segmentIds.length > 0 && path.segmentIds.every((segmentId) => {
    const segment = document.getSegment(segmentId);
    return segment?.role === 'geometry';
  }));
}
