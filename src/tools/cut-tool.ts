import { createEntityId } from '../core/ids';
import {
  arcSweep,
  closestPointOnSegment,
  evaluateSegment,
  intersectSegmentWithLine,
  segmentCurve,
  splitCubic,
} from '../core/geometry';
import { nodeHandleState, type CutPathsPayload, type SplitSegmentPayload } from '../core/operations';
import type { VectorDocument } from '../core/document';
import type { EntityId, Point, Segment, VectorNode, WidthPoint } from '../core/types';

export function prepareSplitSegment(
  document: VectorDocument,
  segmentId: EntityId,
  t: number,
): SplitSegmentPayload | null {
  const segment = document.getSegment(segmentId);
  const path = document.findPathForSegment(segmentId);
  if (!segment || !path || t <= 1e-3 || t >= 1 - 1e-3) return null;
  if (segment.role === 'construction' && segment.constructionExtent === 'infinite') {
    throw new Error('Infinite construction lines cannot be split.');
  }
  const network = document.findNetworkForPath(path.id);
  const start = document.getNode(segment.startNodeId);
  const end = document.getNode(segment.endNodeId);
  if (!network || !start || !end) return null;

  const startBefore = nodeHandleState(start);
  const endBefore = nodeHandleState(end);
  const startAfter = nodeHandleState(start);
  const endAfter = nodeHandleState(end);
  let splitPoint: Point;
  let newNode: VectorNode;

  if (segment.type === 'bezier') {
    const curve = segmentCurve(document, segment);
    if (!curve) return null;
    const [left, right] = splitCubic(curve, t);
    splitPoint = { ...left.p3 };
    startAfter.handleOut = { ...left.p1 };
    endAfter.handleIn = { ...right.p2 };
    newNode = {
      id: createEntityId(),
      position: splitPoint,
      handleIn: { ...left.p2 },
      handleOut: { ...right.p1 },
      constraintIds: [],
    };
  } else {
    splitPoint = segment.type === 'arc'
      ? evaluateSegment(document, segment, t)
      : {
          x: start.position.x + (end.position.x - start.position.x) * t,
          y: start.position.y + (end.position.y - start.position.y) * t,
        };
    newNode = { id: createEntityId(), position: splitPoint, constraintIds: [] };
  }

  const [firstWidthProfile, secondWidthProfile] = splitWidthProfile(segment.widthProfile, t);
  const splitAngle = segment.type === 'arc'
    ? (segment.startAngle ?? 0) + arcSweep(segment) * t
    : undefined;
  const normalizedEndAngle = segment.type === 'arc'
    ? (segment.startAngle ?? 0) + arcSweep(segment)
    : undefined;
  const newSegment1: Segment = {
    id: createEntityId(),
    startNodeId: segment.startNodeId,
    endNodeId: newNode.id,
    type: segment.type,
    role: segment.role,
    constructionExtent: segment.constructionExtent,
    center: segment.center ? { ...segment.center } : undefined,
    radius: segment.radius,
    startAngle: segment.startAngle,
    endAngle: splitAngle,
    clockwise: segment.clockwise,
    widthProfile: firstWidthProfile,
  };
  const newSegment2: Segment = {
    id: createEntityId(),
    startNodeId: newNode.id,
    endNodeId: segment.endNodeId,
    type: segment.type,
    role: segment.role,
    constructionExtent: segment.constructionExtent,
    center: segment.center ? { ...segment.center } : undefined,
    radius: segment.radius,
    startAngle: splitAngle,
    endAngle: normalizedEndAngle,
    clockwise: segment.clockwise,
    widthProfile: secondWidthProfile,
  };

  return {
    segmentId: segment.id,
    splitPoint,
    newNodeId: newNode.id,
    newSegment1Id: newSegment1.id,
    newSegment2Id: newSegment2.id,
    t,
    pathId: path.id,
    networkId: network.id,
    originalIndex: path.segmentIds.indexOf(segment.id),
    originalSegment: {
      ...segment,
      center: segment.center ? { ...segment.center } : undefined,
      widthProfile: segment.widthProfile?.map((point) => ({ ...point })),
    },
    newNode,
    newSegment1,
    newSegment2,
    startBefore,
    startAfter,
    endBefore,
    endAfter,
  };
}

export function prepareSplitAtPoint(
  document: VectorDocument,
  segmentId: EntityId,
  point: Point,
): SplitSegmentPayload | null {
  const segment = document.getSegment(segmentId);
  if (!segment) return null;
  const closest = closestPointOnSegment(document, segment, point);
  return closest ? prepareSplitSegment(document, segmentId, closest.t) : null;
}

function splitWidthProfile(
  profile: WidthPoint[] | undefined,
  t: number,
): [WidthPoint[] | undefined, WidthPoint[] | undefined] {
  if (!profile || profile.length === 0) return [undefined, undefined];
  const first = profile
    .filter((point) => point.t < t)
    .map((point) => ({ ...point, t: point.t / t }));
  const second = profile
    .filter((point) => point.t > t)
    .map((point) => ({ ...point, t: (point.t - t) / (1 - t) }));
  const exact = profile.find((point) => Math.abs(point.t - t) < 1e-9);
  if (exact) {
    first.push({ ...exact, id: createEntityId(), t: 1 });
    second.unshift({ ...exact, id: createEntityId(), t: 0 });
  }
  return [first.length > 0 ? first : undefined, second.length > 0 ? second : undefined];
}

export function prepareCutPaths(
  document: VectorDocument,
  start: Point,
  end: Point,
): CutPathsPayload | null {
  const candidates: Array<{ segmentId: EntityId; t: number; lineT: number }> = [];
  for (const segment of document.segments.values()) {
    const intersections = intersectSegmentWithLine(document, segment, start, end);
    for (const intersection of intersections) {
      if (intersection.segmentT <= 1e-3 || intersection.segmentT >= 1 - 1e-3) continue;
      candidates.push({ segmentId: segment.id, t: intersection.segmentT, lineT: intersection.lineT });
    }
  }
  candidates.sort((a, b) => a.lineT - b.lineT);

  // One split per original segment keeps the payload deterministic. A second
  // crossing of a self-intersecting cubic can be cut in a subsequent gesture.
  const seen = new Set<EntityId>();
  const splits = candidates
    .filter((candidate) => {
      if (seen.has(candidate.segmentId)) return false;
      seen.add(candidate.segmentId);
      return true;
    })
    .map((candidate) => prepareSplitSegment(document, candidate.segmentId, candidate.t))
    .filter((split): split is SplitSegmentPayload => Boolean(split));
  if (splits.length === 0) return null;

  return {
    cutLine: { start: { ...start }, end: { ...end } },
    affectedSegmentIds: splits.map((split) => split.segmentId),
    newNodes: splits.map((split) => split.newNode),
    newSegments: splits.flatMap((split) => [split.newSegment1, split.newSegment2]),
    splits,
  };
}
