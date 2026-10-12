import type { VectorDocument } from '../core/document';
import { createEntityId } from '../core/ids';
import { emptyGraphPatch, type GraphPatch } from '../core/operations';
import { closestPointOnSegment, evaluateSegment } from '../core/geometry';
import type { EntityId, ParametricGroup, Point, Segment } from '../core/types';

export interface ErasePlan {
  patch: GraphPatch;
  removedConstraintIds: EntityId[];
  removedParametricGroups: ParametricGroup[];
  gapNodeIds: [EntityId, EntityId];
}

export interface HealGapPlan {
  patch: GraphPatch;
  segment: Segment;
}

export interface LocalEraseSpan {
  startT: number;
  endT: number;
}

/**
 * Maps a screen-sized eraser radius to a stable local span on any supported
 * segment type. The actual topology edit is composed from semantic split and
 * graph-patch operations so Undo restores the original segment exactly.
 */
export function localEraseSpan(
  document: VectorDocument,
  segmentId: EntityId,
  point: Point,
  radius: number,
): LocalEraseSpan | null {
  const segment = document.getSegment(segmentId);
  if (!segment || segment.role === 'construction' || !Number.isFinite(radius) || radius <= 0) return null;
  const closest = closestPointOnSegment(document, segment, point);
  if (!closest) return null;
  let length = 0;
  let previous = evaluateSegment(document, segment, 0);
  for (let index = 1; index <= 32; index += 1) {
    const next = evaluateSegment(document, segment, index / 32);
    length += Math.hypot(next.x - previous.x, next.y - previous.y);
    previous = next;
  }
  if (length <= 1e-6) return null;
  const halfSpan = Math.min(0.18, Math.max(0.015, radius / length));
  return {
    startT: Math.max(0, closest.t - halfSpan),
    endT: Math.min(1, closest.t + halfSpan),
  };
}

export function prepareEraseSegment(
  document: VectorDocument,
  segmentId: EntityId,
  pruneOrphans = false,
): ErasePlan | null {
  const segment = document.getSegment(segmentId);
  const path = document.findPathForSegment(segmentId);
  if (!segment || !path) return null;
  const patch = emptyGraphPatch();
  patch.removeSegments.push({
    segment: cloneSegment(segment),
    pathId: path.id,
    index: path.segmentIds.indexOf(segment.id),
  });
  const removedNodeIds = pruneOrphans
    ? [segment.startNodeId, segment.endNodeId].filter((nodeId) =>
        document.connectedSegments(nodeId).every((candidate) => candidate.id === segment.id))
    : [];
  for (const nodeId of removedNodeIds) {
    const node = document.getNode(nodeId);
    const network = document.networks.find((candidate) => candidate.nodeIds.includes(nodeId));
    if (node && network) {
      patch.removeNodes.push({ node, networkId: network.id, index: network.nodeIds.indexOf(nodeId) });
    }
  }
  const removedTopologyIds = new Set<EntityId>([segment.id, ...removedNodeIds]);
  return {
    patch,
    removedConstraintIds: [...document.constraints.values()]
      .filter((constraint) => constraint.targetIds.some((id) => removedTopologyIds.has(id)))
      .map((constraint) => constraint.id),
    removedParametricGroups: [...document.parametricGroups.values()]
      .filter((group) => group.transform.type === 'mirror'
        ? group.transform.axisSegmentId === segment.id
        : Boolean(group.transform.centerNodeId && removedTopologyIds.has(group.transform.centerNodeId))),
    gapNodeIds: [segment.startNodeId, segment.endNodeId],
  };
}

export function prepareHealGap(
  document: VectorDocument,
  startNodeId: EntityId,
  endNodeId: EntityId,
  type: 'line' | 'arc',
): HealGapPlan | null {
  if (startNodeId === endNodeId) return null;
  const start = document.getNode(startNodeId);
  const end = document.getNode(endNodeId);
  if (!start || !end || document.connectedSegments(startNodeId).some((segment) =>
    segment.startNodeId === endNodeId || segment.endNodeId === endNodeId)) return null;

  const candidates = [...document.paths.values()].filter((path) => path.segmentIds.some((segmentId) => {
    const segment = document.getSegment(segmentId);
    return segment?.startNodeId === startNodeId || segment?.endNodeId === startNodeId ||
      segment?.startNodeId === endNodeId || segment?.endNodeId === endNodeId;
  }));
  const path = candidates[0];
  if (!path) return null;
  const beforeIndex = path.segmentIds.findIndex((segmentId) => document.getSegment(segmentId)?.endNodeId === startNodeId);
  const afterIndex = path.segmentIds.findIndex((segmentId) => document.getSegment(segmentId)?.startNodeId === endNodeId);
  const insertionIndex = beforeIndex >= 0 ? beforeIndex + 1 : afterIndex >= 0 ? afterIndex : path.segmentIds.length;

  let segment: Segment;
  if (type === 'arc') {
    const center = {
      x: (start.position.x + end.position.x) / 2,
      y: (start.position.y + end.position.y) / 2,
    };
    const radius = Math.hypot(end.position.x - start.position.x, end.position.y - start.position.y) / 2;
    if (radius < 1e-6) return null;
    segment = {
      id: createEntityId(),
      startNodeId,
      endNodeId,
      type: 'arc',
      role: 'geometry',
      center,
      radius,
      startAngle: Math.atan2(start.position.y - center.y, start.position.x - center.x),
      endAngle: Math.atan2(end.position.y - center.y, end.position.x - center.x),
      clockwise: false,
    };
  } else {
    segment = { id: createEntityId(), startNodeId, endNodeId, type: 'line', role: 'geometry' };
  }
  const patch = emptyGraphPatch();
  patch.addSegments.push({ segment, pathId: path.id, index: insertionIndex });
  return { patch, segment };
}

function cloneSegment(segment: Segment): Segment {
  return {
    ...segment,
    center: segment.center ? { ...segment.center } : undefined,
    widthProfile: segment.widthProfile?.map((point) => ({ ...point })),
  };
}
