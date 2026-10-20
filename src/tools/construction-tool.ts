import { constrainConstructionLineEndpoint } from '../core/construction-geometry';
import type { VectorDocument } from '../core/document';
import { createEntityId } from '../core/ids';
import type { OperationInput } from '../core/operations';
import type {
  Appearance,
  ConstructionExtent,
  EntityId,
  LayerNode,
  NetworkObject,
  Point,
  Segment,
  VectorNode,
  VectorPath,
} from '../core/types';
import {
  CONSTRUCTION_GUIDE_COLOR,
} from '../design-system/document-defaults';

export interface ConstructionLinePlan {
  objectId: EntityId;
  layerId: EntityId;
  networkId: EntityId;
  pathId: EntityId;
  nodeIds: [EntityId, EntityId];
  segmentId: EntityId;
  operations: OperationInput[];
}

export type ConstructionLinePreparation =
  | { ok: true; plan: ConstructionLinePlan }
  | { ok: false; message: string };

/**
 * Lazily loaded construction authoring. It returns ordinary typed-graph add
 * operations; the caller owns the single transaction that commits them.
 */
export function prepareConstructionLineObject(
  document: VectorDocument,
  start: Point,
  rawEnd: Point,
  options: { extent: ConstructionExtent; constrain?: boolean },
): ConstructionLinePreparation {
  const end = options.constrain ? constrainConstructionLineEndpoint(start, rawEnd) : { ...rawEnd };
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.hypot(dx, dy) < 1e-6) {
    return { ok: false, message: 'Construction line requires a non-zero drag.' };
  }

  const networkId = createEntityId();
  const appearanceId = createEntityId();
  const objectId = createEntityId();
  const layerId = createEntityId();
  const pathId = createEntityId();
  const startNodeId = createEntityId();
  const endNodeId = createEntityId();
  const segmentId = createEntityId();
  const nodes: [VectorNode, VectorNode] = [
    { id: startNodeId, position: { x: 0, y: 0 }, constraintIds: [] },
    { id: endNodeId, position: { x: dx, y: dy }, constraintIds: [] },
  ];
  const path: VectorPath = { id: pathId, segmentIds: [], isClosed: false };
  const segment: Segment = {
    id: segmentId,
    startNodeId,
    endNodeId,
    type: 'line',
    role: 'construction',
    constructionExtent: options.extent,
  };
  const appearance: Appearance = {
    id: appearanceId,
    fills: [],
    stroke: {
      color: CONSTRUCTION_GUIDE_COLOR,
      width: 1.25,
      cap: 'round',
      join: 'round',
      alignment: 'center',
      opacity: 1,
      dash: [],
      visible: true,
    },
    opacity: 1,
  };
  const object: NetworkObject = {
    id: objectId,
    name: 'Construction Line',
    networkId,
    appearanceId,
    transform: { x: start.x, y: start.y, rotation: 0, scaleX: 1, scaleY: 1 },
  };
  const layer: LayerNode = {
    id: layerId,
    kind: 'object',
    name: 'Construction Line',
    artboardId: document.activeArtboardId,
    childIds: [],
    objectId,
    visible: true,
    locked: false,
    expanded: true,
  };
  const operations: OperationInput[] = [
    { type: 'ADD_NETWORK', payload: { network: { id: networkId, nodeIds: [], pathIds: [] } } },
    { type: 'ADD_APPEARANCE', payload: { appearance } },
    { type: 'ADD_OBJECT', payload: { object } },
    { type: 'ADD_LAYER', payload: { layer, index: document.activeArtboard.layerIds.length } },
    { type: 'ADD_NODE', payload: { node: nodes[0], networkId } },
    { type: 'ADD_NODE', payload: { node: nodes[1], networkId } },
    { type: 'ADD_PATH', payload: { path, networkId } },
    { type: 'ADD_SEGMENT', payload: { segment, pathId } },
  ];
  return {
    ok: true,
    plan: {
      objectId,
      layerId,
      networkId,
      pathId,
      nodeIds: [startNodeId, endNodeId],
      segmentId,
      operations,
    },
  };
}
