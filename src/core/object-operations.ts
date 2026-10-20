import { createEntityId } from './ids';
import type { VectorDocument } from './document';
import { INTERACTION_BOUNDS_POLICY, objectBounds } from './object-geometry';
import type { OperationInput } from './operations';
import type { EntityId, LayerNode, NetworkObject, Point } from './types';

export interface DuplicateTopologyMap {
  nodeMap: Record<EntityId, EntityId>;
  segmentMap: Record<EntityId, EntityId>;
  pathMap: Record<EntityId, EntityId>;
}

export interface DuplicateObjectPlan {
  objectId: EntityId;
  layerId: EntityId;
  /** Stable source IDs mapped to the fresh IDs used by the duplicate. */
  topologyMap: DuplicateTopologyMap;
  operations: OperationInput[];
}

export interface DeleteObjectPlan {
  fallbackLayerId?: EntityId;
  operations: OperationInput[];
}

export interface FlipObjectsPlan {
  axis: 'horizontal' | 'vertical';
  objectIds: EntityId[];
  operations: OperationInput[];
}

/** Creates a deep, ID-safe duplicate plan while leaving the source network authoritative and untouched. */
export function prepareDuplicateObject(document: VectorDocument, objectId: EntityId): DuplicateObjectPlan | null {
  const sourceObject = document.getObject(objectId);
  const sourceNetwork = sourceObject ? document.getNetwork(sourceObject.networkId) : undefined;
  const sourceLayer = sourceObject ? document.getLayerForObject(sourceObject.id) : undefined;
  const sourceAppearance = sourceObject ? document.getAppearance(sourceObject.appearanceId) : undefined;
  if (!sourceObject || !sourceNetwork || !sourceLayer || !sourceAppearance) return null;

  const networkId = createEntityId();
  const appearanceId = createEntityId();
  const duplicateObjectId = createEntityId();
  const layerId = createEntityId();
  const nodeIds = new Map(sourceNetwork.nodeIds.map((id) => [id, createEntityId()]));
  const pathIds = new Map(sourceNetwork.pathIds.map((id) => [id, createEntityId()]));
  const sourceSegmentIds = sourceNetwork.pathIds.flatMap((pathId) => document.getPath(pathId)?.segmentIds ?? []);
  const segmentIds = new Map(sourceSegmentIds.map((id) => [id, createEntityId()]));
  const operations: OperationInput[] = [];

  operations.push({ type: 'ADD_NETWORK', payload: { network: { id: networkId, nodeIds: [], pathIds: [] } } });
  operations.push({
    type: 'ADD_APPEARANCE',
    payload: {
      appearance: {
        ...sourceAppearance,
        id: appearanceId,
        fills: sourceAppearance.fills.map((fill) => ({ ...fill })),
        stroke: sourceAppearance.stroke
          ? { ...sourceAppearance.stroke, dash: [...sourceAppearance.stroke.dash] }
          : undefined,
      },
    },
  });
  const object: NetworkObject = {
    ...sourceObject,
    id: duplicateObjectId,
    name: duplicateName(sourceObject.name),
    networkId,
    appearanceId,
    transform: {
      ...sourceObject.transform,
      x: sourceObject.transform.x + 16,
      y: sourceObject.transform.y + 16,
    },
  };
  operations.push({ type: 'ADD_OBJECT', payload: { object } });
  const layer: LayerNode = {
    ...sourceLayer,
    id: layerId,
    name: object.name,
    childIds: [],
    objectId: duplicateObjectId,
  };
  const siblingIds = sourceLayer.parentId
    ? document.getLayer(sourceLayer.parentId)?.childIds
    : document.getArtboard(sourceLayer.artboardId)?.layerIds;
  operations.push({
    type: 'ADD_LAYER',
    payload: { layer, index: Math.max(0, (siblingIds?.indexOf(sourceLayer.id) ?? -1) + 1) },
  });

  for (const sourceNodeId of sourceNetwork.nodeIds) {
    const source = document.getNode(sourceNodeId);
    if (!source) continue;
    operations.push({
      type: 'ADD_NODE',
      payload: {
        node: {
          ...source,
          id: nodeIds.get(sourceNodeId)!,
          position: { ...source.position },
          handleIn: source.handleIn ? { ...source.handleIn } : undefined,
          handleOut: source.handleOut ? { ...source.handleOut } : undefined,
          constraintIds: [],
        },
        networkId,
      },
    });
  }
  for (const sourcePathId of sourceNetwork.pathIds) {
    const source = document.getPath(sourcePathId);
    if (!source) continue;
    const pathId = pathIds.get(sourcePathId)!;
    operations.push({
      type: 'ADD_PATH',
      payload: { path: { ...source, id: pathId, segmentIds: [] }, networkId },
    });
    for (const sourceSegmentId of source.segmentIds) {
      const segment = document.getSegment(sourceSegmentId);
      if (!segment) continue;
      operations.push({
        type: 'ADD_SEGMENT',
        payload: {
          segment: {
            ...segment,
            id: segmentIds.get(sourceSegmentId)!,
            startNodeId: nodeIds.get(segment.startNodeId)!,
            endNodeId: nodeIds.get(segment.endNodeId)!,
            center: segment.center ? { ...segment.center } : undefined,
            widthProfile: segment.widthProfile?.map((point) => ({ ...point, id: createEntityId() })),
          },
          pathId,
        },
      });
    }
  }

  const mappedIds = new Map<EntityId, EntityId>([...nodeIds, ...segmentIds, ...pathIds]);
  for (const constraint of document.constraints.values()) {
    if (!constraint.targetIds.every((id) => mappedIds.has(id))) continue;
    operations.push({
      type: 'ADD_CONSTRAINT',
      payload: {
        constraint: {
          ...constraint,
          id: createEntityId(),
          targetIds: constraint.targetIds.map((id) => mappedIds.get(id)!),
          parameters: constraint.parameters ? { ...constraint.parameters } : undefined,
        },
      },
    });
  }
  for (const group of document.parametricGroups.values()) {
    if (!group.sourcePathIds.every((id) => pathIds.has(id))) continue;
    operations.push({
      type: 'ADD_PARAMETRIC_GROUP',
      payload: {
        group: {
          ...group,
          id: createEntityId(),
          sourcePathIds: group.sourcePathIds.map((id) => pathIds.get(id)!),
          transform: group.transform.type === 'mirror'
            ? {
                ...group.transform,
                origin: { ...group.transform.origin },
                axisSegmentId: group.transform.axisSegmentId
                  ? segmentIds.get(group.transform.axisSegmentId) ?? group.transform.axisSegmentId
                  : undefined,
              }
            : {
                ...group.transform,
                center: { ...group.transform.center },
                centerNodeId: group.transform.centerNodeId
                  ? nodeIds.get(group.transform.centerNodeId) ?? group.transform.centerNodeId
                  : undefined,
              },
        },
      },
    });
  }

  return {
    objectId: duplicateObjectId,
    layerId,
    topologyMap: {
      nodeMap: Object.fromEntries(nodeIds),
      segmentMap: Object.fromEntries(segmentIds),
      pathMap: Object.fromEntries(pathIds),
    },
    operations,
  };
}

/**
 * Reflects one object around its own visual center, or several objects around
 * their shared selection center. The world-space reflection is represented as
 * normal object transforms, so topology and parametric references stay stable.
 */
export function prepareFlipObjects(
  document: VectorDocument,
  objectIds: EntityId[],
  axis: 'horizontal' | 'vertical',
): FlipObjectsPlan | null {
  const objects = [...new Set(objectIds)]
    .map((id) => document.getObject(id))
    .filter((object): object is NetworkObject => Boolean(object));
  if (objects.length === 0 || objects.length !== new Set(objectIds).size) return null;
  if (objects.some((object) => document.isObjectLocked(object.id))) return null;

  const bounds = objects.map((object) => objectBounds(document, object.id, INTERACTION_BOUNDS_POLICY));
  const minX = Math.min(...bounds.map((item) => item.minX));
  const maxX = Math.max(...bounds.map((item) => item.maxX));
  const minY = Math.min(...bounds.map((item) => item.minY));
  const maxY = Math.max(...bounds.map((item) => item.maxY));
  const center = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  const operations: OperationInput[] = objects.map((object) => ({
    type: 'UPDATE_OBJECT',
    payload: {
      objectId: object.id,
      updates: {
        transform: axis === 'horizontal'
          ? {
              ...object.transform,
              x: 2 * center.x - object.transform.x,
              rotation: -object.transform.rotation,
              scaleX: -object.transform.scaleX,
            }
          : {
              ...object.transform,
              y: 2 * center.y - object.transform.y,
              rotation: -object.transform.rotation,
              scaleY: -object.transform.scaleY,
            },
      },
    },
  }));
  return { axis, objectIds: objects.map((object) => object.id), operations };
}

export interface NudgeObjectsPlan {
  delta: Point;
  objectIds: EntityId[];
  operations: OperationInput[];
}

/**
 * Arrow-key nudge. Moving an object is an ordinary transform update, so the same
 * operation is reused here as for a pointer drag; the caller wraps the returned
 * operations in one transaction, which keeps a burst of key presses individually
 * undoable. Returns null when nothing can move, so the caller can let the key
 * press through instead of swallowing it.
 */
export function prepareNudgeObjects(
  document: VectorDocument,
  objectIds: Iterable<EntityId>,
  delta: Point,
): NudgeObjectsPlan | null {
  if (delta.x === 0 && delta.y === 0) return null;
  const objects = [...new Set(objectIds)]
    .map((id) => document.getObject(id))
    .filter((object): object is NetworkObject => Boolean(object))
    .filter((object) => !document.isObjectLocked(object.id));
  if (objects.length === 0) return null;
  return {
    delta,
    objectIds: objects.map((object) => object.id),
    operations: objects.map((object) => ({
      type: 'UPDATE_OBJECT',
      payload: {
        objectId: object.id,
        updates: {
          transform: {
            ...object.transform,
            x: object.transform.x + delta.x,
            y: object.transform.y + delta.y,
          },
        },
      },
    })),
  };
}

export function prepareDeleteObject(document: VectorDocument, objectId: EntityId): DeleteObjectPlan | null {
  const object = document.getObject(objectId);
  const network = object ? document.getNetwork(object.networkId) : undefined;
  const layer = object ? document.getLayerForObject(object.id) : undefined;
  if (!object || !network || !layer) return null;
  const pathIds = new Set(network.pathIds);
  const segmentIds = new Set(network.pathIds.flatMap((pathId) => document.getPath(pathId)?.segmentIds ?? []));
  const nodeIds = new Set(network.nodeIds);
  const topologyIds = new Set<EntityId>([...pathIds, ...segmentIds, ...nodeIds]);
  const operations: OperationInput[] = [];

  const geometryComponent = document.geometryComponentForObject(object.id);
  if (geometryComponent?.sourceObjectId === object.id) {
    // Removing a source releases every variant as ordinary independent artwork.
    operations.push({
      type: 'REMOVE_GEOMETRY_COMPONENT',
      payload: { component: geometryComponent },
    });
  } else if (geometryComponent) {
    operations.push({
      type: 'UPDATE_GEOMETRY_COMPONENT',
      payload: {
        componentId: geometryComponent.id,
        updates: {
          variants: geometryComponent.variants.filter((variant) => variant.objectId !== object.id),
        },
      },
    });
  }

  for (const constraint of document.constraints.values()) {
    if (constraint.targetIds.some((id) => topologyIds.has(id))) {
      operations.push({ type: 'REMOVE_CONSTRAINT', payload: { constraintId: constraint.id } });
    }
  }
  for (const group of document.parametricGroups.values()) {
    const removesSource = group.sourcePathIds.some((id) => pathIds.has(id));
    const removesReference = group.transform.type === 'mirror'
      ? Boolean(group.transform.axisSegmentId && segmentIds.has(group.transform.axisSegmentId))
      : Boolean(group.transform.centerNodeId && nodeIds.has(group.transform.centerNodeId));
    if (removesSource || removesReference) {
      operations.push({ type: 'REMOVE_PARAMETRIC_GROUP', payload: { group } });
    }
  }
  for (const pathId of network.pathIds) {
    const path = document.getPath(pathId);
    for (const segmentId of path?.segmentIds ?? []) {
      const segment = document.getSegment(segmentId);
      if (segment) operations.push({ type: 'REMOVE_SEGMENT', payload: { segment, pathId } });
    }
  }
  for (const pathId of network.pathIds) {
    const path = document.getPath(pathId);
    if (path) operations.push({ type: 'REMOVE_PATH', payload: { path, networkId: network.id } });
  }
  for (const nodeId of network.nodeIds) {
    const node = document.getNode(nodeId);
    if (node) operations.push({ type: 'REMOVE_NODE', payload: { node, networkId: network.id } });
  }
  operations.push({ type: 'REMOVE_LAYER', payload: { layer } });
  operations.push({ type: 'REMOVE_OBJECT', payload: { object } });
  if (![...document.objects.values()].some((item) => item.id !== object.id && item.appearanceId === object.appearanceId)) {
    const appearance = document.getAppearance(object.appearanceId);
    if (appearance) operations.push({ type: 'REMOVE_APPEARANCE', payload: { appearance } });
  }
  operations.push({ type: 'REMOVE_NETWORK', payload: { network } });

  const siblings = layer.parentId
    ? document.getLayer(layer.parentId)?.childIds
    : document.getArtboard(layer.artboardId)?.layerIds;
  const index = siblings?.indexOf(layer.id) ?? -1;
  return { fallbackLayerId: index > 0 ? siblings?.[index - 1] : siblings?.[index + 1], operations };
}

function duplicateName(name: string): string {
  const match = name.match(/^(.*) copy(?: (\d+))?$/i);
  if (!match) return `${name} copy`;
  return `${match[1]} copy ${Number(match[2] ?? 1) + 1}`;
}
