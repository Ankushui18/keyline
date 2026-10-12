import type { VectorDocument } from '../core/document';
import { createEntityId } from '../core/ids';
import type { GraphPatch, OperationInput } from '../core/operations';
import type { EntityId, Segment } from '../core/types';

export interface DeletePointPlan {
  patch: GraphPatch;
  constraintIds: EntityId[];
  replacementSegmentId?: EntityId;
  /** Deleting either endpoint of the object's last one-segment path removes the object. */
  deleteObjectId?: EntityId;
}


export function connectedSelection(document: VectorDocument, seedSegmentIds: Iterable<EntityId>): { nodeIds: EntityId[]; segmentIds: EntityId[] } {
  const pending = [...seedSegmentIds];
  const segments = new Set<EntityId>();
  const nodes = new Set<EntityId>();
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (segments.has(id)) continue;
    const segment = document.getSegment(id);
    if (!segment) continue;
    segments.add(id);
    nodes.add(segment.startNodeId);
    nodes.add(segment.endNodeId);
    for (const candidate of document.segments.values()) {
      if (!segments.has(candidate.id) && (
        candidate.startNodeId === segment.startNodeId || candidate.endNodeId === segment.startNodeId ||
        candidate.startNodeId === segment.endNodeId || candidate.endNodeId === segment.endNodeId
      )) pending.push(candidate.id);
    }
  }
  return { nodeIds: [...nodes], segmentIds: [...segments] };
}

export function prepareClosePath(document: VectorDocument, pathId: EntityId): OperationInput[] | null {
  const path = document.getPath(pathId);
  if (!path || path.isClosed || path.segmentIds.length === 0) return null;
  const first = document.getSegment(path.segmentIds[0]);
  const last = document.getSegment(path.segmentIds[path.segmentIds.length - 1]);
  if (!first || !last) return null;
  const operations: OperationInput[] = [];
  if (last.endNodeId !== first.startNodeId) {
    operations.push({
      type: 'ADD_SEGMENT',
      payload: {
        segment: { id: createEntityId(), startNodeId: last.endNodeId, endNodeId: first.startNodeId, type: 'line', role: 'geometry' },
        pathId,
      },
    });
  }
  operations.push({ type: 'SET_PATH_CLOSED', payload: { pathId, isClosed: true } });
  return operations;
}

export function prepareDeletePoint(document: VectorDocument, nodeId: EntityId): DeletePointPlan | null {
  const node = document.getNode(nodeId);
  const network = document.networks.find((item) => item.nodeIds.includes(nodeId));
  const connected = document.connectedSegments(nodeId);
  const path = connected[0] ? document.findPathForSegment(connected[0].id) : undefined;
  if (!node || !network || !path || path.isClosed && connected.length < 2 || connected.length < 1 || connected.length > 2) return null;
  if (!connected.every((segment) => path.segmentIds.includes(segment.id))) return null;
  const removesOnlySegment = connected.length === 1 && path.segmentIds.length === 1;
  const oppositeNodeId = removesOnlySegment
    ? (connected[0].startNodeId === nodeId ? connected[0].endNodeId : connected[0].startNodeId)
    : undefined;
  const oppositeNode = oppositeNodeId ? document.getNode(oppositeNodeId) : undefined;
  const oppositeBecomesOrphan = Boolean(
    oppositeNode && document.connectedSegments(oppositeNode.id).every((segment) => segment.id === connected[0].id),
  );
  const patch: GraphPatch = {
    addNodes: [],
    addPaths: [],
    removePaths: removesOnlySegment
      ? [{ path, networkId: network.id, index: network.pathIds.indexOf(path.id) }]
      : [],
    removeSegments: connected.map((segment) => ({ segment, pathId: path.id, index: path.segmentIds.indexOf(segment.id) })),
    removeNodes: [
      { node, networkId: network.id, index: network.nodeIds.indexOf(node.id) },
      ...(oppositeBecomesOrphan && oppositeNode
        ? [{ node: oppositeNode, networkId: network.id, index: network.nodeIds.indexOf(oppositeNode.id) }]
        : []),
    ],
    addSegments: [],
  };
  let replacementSegmentId: EntityId | undefined;
  if (connected.length === 2) {
    const other = (segment: Segment) => segment.startNodeId === nodeId ? segment.endNodeId : segment.startNodeId;
    const firstIndex = Math.min(...connected.map((segment) => path.segmentIds.indexOf(segment.id)));
    const replacement: Segment = {
      id: createEntityId(), startNodeId: other(connected[0]), endNodeId: other(connected[1]),
      type: connected.every((segment) => segment.type === 'line') ? 'line' : 'bezier',
      role: 'geometry',
    };
    replacementSegmentId = replacement.id;
    patch.addSegments.push({ segment: replacement, pathId: path.id, index: firstIndex });
  }
  const topologyIds = new Set<EntityId>([
    nodeId,
    ...connected.map((segment) => segment.id),
    ...(removesOnlySegment ? [path.id] : []),
    ...(oppositeBecomesOrphan && oppositeNodeId ? [oppositeNodeId] : []),
  ]);
  const constraintIds = [...document.constraints.values()]
    .filter((constraint) => constraint.targetIds.some((id) => topologyIds.has(id)))
    .map((constraint) => constraint.id);
  const object = document.getObjectForNode(nodeId);
  const deleteObjectId = removesOnlySegment && network.pathIds.length === 1 && object?.networkId === network.id
    ? object.id
    : undefined;
  return { patch, constraintIds, replacementSegmentId, deleteObjectId };
}

export function prepareJoinEndpoints(document: VectorDocument, firstNodeId: EntityId, secondNodeId: EntityId): OperationInput[] | null {
  if (firstNodeId === secondNodeId) return null;
  const firstInfo = endpointInfo(document, firstNodeId);
  const secondInfo = endpointInfo(document, secondNodeId);
  if (!firstInfo || !secondInfo || firstInfo.networkId !== secondInfo.networkId) return null;
  if (firstInfo.path.id === secondInfo.path.id) {
    return prepareClosePath(document, firstInfo.path.id);
  }
  const orient = (info: ReturnType<typeof endpointInfo>, selectedAtEnd: boolean) => {
    if (!info) return [] as Segment[];
    const source = info.path.segmentIds.map((id) => document.getSegment(id)!).filter(Boolean);
    const currentlyAtEnd = source.at(-1)?.endNodeId === info.nodeId;
    return currentlyAtEnd === selectedAtEnd ? source : [...source].reverse().map(reverseSegment);
  };
  const firstSegments = orient(firstInfo, true);
  const secondSegments = orient(secondInfo, false);
  const connector: Segment = { id: createEntityId(), startNodeId: firstNodeId, endNodeId: secondNodeId, type: 'line', role: 'geometry' };
  const patch: GraphPatch = {
    addNodes: [], removeNodes: [], addPaths: [],
    removeSegments: [
      ...firstInfo.path.segmentIds.map((id, index) => ({ segment: document.getSegment(id)!, pathId: firstInfo.path.id, index })),
      ...secondInfo.path.segmentIds.map((id, index) => ({ segment: document.getSegment(id)!, pathId: secondInfo.path.id, index })),
    ],
    removePaths: [{ path: secondInfo.path, networkId: secondInfo.networkId, index: document.getNetwork(secondInfo.networkId)?.pathIds.indexOf(secondInfo.path.id) }],
    addSegments: [...firstSegments, connector, ...secondSegments].map((segment, index) => ({ segment, pathId: firstInfo.path.id, index })),
  };
  return [{ type: 'APPLY_GRAPH_PATCH', payload: patch }];
}

export function prepareReversePath(document: VectorDocument, pathId: EntityId): GraphPatch | null {
  const path = document.getPath(pathId);
  const network = document.findNetworkForPath(pathId);
  if (!path || !network || path.segmentIds.length === 0) return null;
  const originals = path.segmentIds.map((id) => document.getSegment(id)).filter((segment): segment is Segment => Boolean(segment));
  if (originals.length !== path.segmentIds.length) return null;
  const reversed = [...originals].reverse().map(reverseSegment);
  return {
    addNodes: [], addPaths: [], removePaths: [], removeNodes: [],
    removeSegments: originals.map((segment, index) => ({ segment, pathId, index })),
    addSegments: reversed.map((segment, index) => ({ segment, pathId, index })),
  };
}

function endpointInfo(document: VectorDocument, nodeId: EntityId) {
  const candidates = [...document.paths.values()].filter((path) => {
    if (path.isClosed || path.segmentIds.length === 0) return false;
    const first = document.getSegment(path.segmentIds[0]);
    const last = document.getSegment(path.segmentIds.at(-1)!);
    return first?.startNodeId === nodeId || last?.endNodeId === nodeId;
  });
  const path = candidates[0];
  const network = path ? document.findNetworkForPath(path.id) : undefined;
  return path && network ? { nodeId, path, networkId: network.id } : null;
}

function reverseSegment(segment: Segment): Segment {
  return {
    ...segment,
    startNodeId: segment.endNodeId,
    endNodeId: segment.startNodeId,
    startAngle: segment.endAngle,
    endAngle: segment.startAngle,
    clockwise: segment.type === 'arc' ? !segment.clockwise : segment.clockwise,
  };
}
