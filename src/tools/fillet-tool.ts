import type { VectorDocument } from '../core/document';
import { createEntityId } from '../core/ids';
import { emptyGraphPatch, type GraphPatch } from '../core/operations';
import type { Constraint, EntityId, Point, Segment, VectorNode, VectorPath } from '../core/types';

export interface FilletPlan {
  cornerNodeId: EntityId;
  tangentNodeId: EntityId;
  arcSegmentId: EntityId;
  radius: number;
  patch: GraphPatch;
  constraints: Constraint[];
}

export type FilletValidation =
  | { valid: true; maximumRadius: number }
  | { valid: false; message: string };

type FilletContext = {
  corner: VectorNode;
  path: VectorPath;
  networkId: EntityId;
  cornerIndex: number;
  incoming: Segment;
  outgoing: Segment;
  incomingIndex: number;
  outgoingIndex: number;
  incomingStart: VectorNode;
  firstDirection: Point;
  secondDirection: Point;
  angle: number;
  tangentFactor: number;
  maximumRadius: number;
};

type FilletInspection =
  | { valid: true; context: FilletContext }
  | { valid: false; message: string };

export function validateFillet(
  document: VectorDocument,
  cornerNodeId: EntityId,
  requestedRadius: number,
): FilletValidation {
  const result = inspectFillet(document, cornerNodeId, requestedRadius);
  return result.valid
    ? { valid: true, maximumRadius: result.context.maximumRadius }
    : result;
}

function inspectFillet(
  document: VectorDocument,
  cornerNodeId: EntityId,
  requestedRadius: number,
): FilletInspection {
  const reject = (message: string): FilletInspection => ({ valid: false, message });
  const corner = document.getNode(cornerNodeId);
  if (!corner) return reject('Fillet requires a valid corner node.');
  if (!Number.isFinite(requestedRadius) || requestedRadius <= 0) {
    return reject('Fillet radius must be greater than 0.');
  }
  const connected = document.connectedSegments(cornerNodeId);
  if (connected.length !== 2) return reject('Fillet requires exactly two adjacent segments.');
  if (connected.some((segment) => segment.role === 'construction')) {
    return reject('Fillet is unavailable for construction segments.');
  }
  if (connected.some((segment) => segment.type !== 'line')) {
    return reject('Fillet currently requires two adjacent line segments.');
  }
  const path = [...document.paths.values()].find((candidate) =>
    connected.every((segment) => candidate.segmentIds.includes(segment.id)),
  );
  if (!path) return reject('Fillet requires two adjacent segments in one path.');
  const network = document.findNetworkForPath(path.id);
  if (!network) return reject('Fillet requires a path owned by a network.');
  const cornerIndex = network.nodeIds.indexOf(cornerNodeId);
  if (cornerIndex < 0) return reject('Fillet corner is not owned by the path network.');
  const incoming = connected.find((segment) => segment.endNodeId === cornerNodeId);
  const outgoing = connected.find((segment) => segment.startNodeId === cornerNodeId);
  if (!incoming || !outgoing) return reject('Fillet requires two directionally adjacent segments.');
  const incomingIndex = path.segmentIds.indexOf(incoming.id);
  const outgoingIndex = path.segmentIds.indexOf(outgoing.id);
  if (!(outgoingIndex === incomingIndex + 1 ||
    (path.isClosed && incomingIndex === path.segmentIds.length - 1 && outgoingIndex === 0))) {
    return reject('Fillet requires two directionally adjacent segments.');
  }
  const incomingStart = document.getNode(incoming.startNodeId);
  const outgoingEnd = document.getNode(outgoing.endNodeId);
  if (!incomingStart || !outgoingEnd) {
    return reject('Fillet could not resolve the neighboring segment endpoints.');
  }
  const firstLength = distance(incomingStart.position, corner.position);
  const secondLength = distance(outgoingEnd.position, corner.position);
  if (firstLength < 1e-6 || secondLength < 1e-6) {
    return reject('Fillet requires two non-zero-length segments.');
  }
  const firstDirection = normalize(subtract(incomingStart.position, corner.position));
  const secondDirection = normalize(subtract(outgoingEnd.position, corner.position));
  const angle = Math.acos(clamp(dot(firstDirection, secondDirection), -1, 1));
  if (angle < 1e-3 || Math.PI - angle < 1e-3) {
    return reject('Fillet is unavailable for parallel or collinear segments.');
  }
  const tangentFactor = 1 / Math.tan(angle / 2);
  const maximumRadius = Math.min(firstLength, secondLength) * 0.48 / tangentFactor;
  if (!Number.isFinite(maximumRadius) || maximumRadius < 1e-4) {
    return reject('Radius is too large for this corner.');
  }
  if (requestedRadius > maximumRadius + 1e-9) {
    return reject(`Radius is too large for this corner. Use ${Number(maximumRadius.toFixed(2))} px or less.`);
  }
  return {
    valid: true,
    context: {
      corner,
      path,
      networkId: network.id,
      cornerIndex,
      incoming,
      outgoing,
      incomingIndex,
      outgoingIndex,
      incomingStart,
      firstDirection,
      secondDirection,
      angle,
      tangentFactor,
      maximumRadius,
    },
  };
}

/**
 * Prepares a true circular fillet for a simple path corner. Existing line and
 * corner IDs are retained; only the second tangent node and arc receive new IDs.
 */
export function prepareFillet(
  document: VectorDocument,
  cornerNodeId: EntityId,
  requestedRadius = 24,
): FilletPlan | null {
  const inspection = inspectFillet(document, cornerNodeId, requestedRadius);
  if (!inspection.valid) return null;
  const {
    corner,
    path,
    networkId,
    cornerIndex,
    incoming,
    outgoing,
    incomingIndex,
    outgoingIndex,
    incomingStart,
    firstDirection,
    secondDirection,
    angle,
    tangentFactor,
  } = inspection.context;
  const tangentDistance = requestedRadius * tangentFactor;
  const radius = requestedRadius;

  const firstTangent = add(corner.position, scale(firstDirection, tangentDistance));
  const secondTangent = add(corner.position, scale(secondDirection, tangentDistance));
  const bisector = normalize(add(firstDirection, secondDirection));
  const centerDistance = radius / Math.sin(angle / 2);
  const center = add(corner.position, scale(bisector, centerDistance));
  const startAngle = Math.atan2(firstTangent.y - center.y, firstTangent.x - center.x);
  const endAngle = Math.atan2(secondTangent.y - center.y, secondTangent.x - center.x);
  const incomingDirection = normalize(subtract(firstTangent, incomingStart.position));
  const radial = normalize(subtract(firstTangent, center));
  const increasingTangent = { x: -radial.y, y: radial.x };
  const clockwise = dot(increasingTangent, incomingDirection) < 0;

  const tangentNode: VectorNode = {
    id: createEntityId(),
    position: secondTangent,
    constraintIds: [],
  };
  const movedCorner: VectorNode = {
    ...corner,
    position: firstTangent,
    handleIn: corner.handleIn ? { ...corner.handleIn } : undefined,
    handleOut: corner.handleOut ? { ...corner.handleOut } : undefined,
    constraintIds: [...corner.constraintIds],
  };
  const trimmedIncoming = cloneSegment(incoming);
  const trimmedOutgoing = { ...cloneSegment(outgoing), startNodeId: tangentNode.id };
  const arc: Segment = {
    id: createEntityId(),
    startNodeId: corner.id,
    endNodeId: tangentNode.id,
    type: 'arc',
    role: 'geometry',
    center,
    radius,
    startAngle,
    endAngle,
    clockwise,
  };

  const patch = emptyGraphPatch();
  patch.removeSegments.push(
    { segment: cloneSegment(incoming), pathId: path.id, index: incomingIndex },
    { segment: cloneSegment(outgoing), pathId: path.id, index: outgoingIndex },
  );
  patch.removeNodes.push({
    node: cloneNode(corner),
    networkId,
    index: cornerIndex,
  });
  patch.addNodes.push(
    { node: movedCorner, networkId, index: cornerIndex },
    { node: tangentNode, networkId },
  );
  patch.addSegments.push(
    { segment: trimmedIncoming, pathId: path.id, index: incomingIndex },
    { segment: trimmedOutgoing, pathId: path.id, index: outgoingIndex },
    { segment: arc, pathId: path.id, index: outgoingIndex },
  );

  const fixedRadius: Constraint = {
    id: createEntityId(),
    type: 'fixed_radius',
    priority: 'hard',
    targetIds: [arc.id],
    parameters: { radius },
    tolerance: 1e-6,
  };
  const tangentIncoming: Constraint = {
    id: createEntityId(),
    type: 'tangent',
    priority: 'hard',
    targetIds: [incoming.id, arc.id, corner.id],
    tolerance: 1e-6,
  };
  const tangentOutgoing: Constraint = {
    id: createEntityId(),
    type: 'tangent',
    priority: 'hard',
    targetIds: [outgoing.id, arc.id, tangentNode.id],
    tolerance: 1e-6,
  };

  return {
    cornerNodeId: corner.id,
    tangentNodeId: tangentNode.id,
    arcSegmentId: arc.id,
    radius,
    patch,
    constraints: [fixedRadius, tangentIncoming, tangentOutgoing],
  };
}

function cloneNode(node: VectorNode): VectorNode {
  return {
    ...node,
    position: { ...node.position },
    handleIn: node.handleIn ? { ...node.handleIn } : undefined,
    handleOut: node.handleOut ? { ...node.handleOut } : undefined,
    constraintIds: [...node.constraintIds],
  };
}

function cloneSegment(segment: Segment): Segment {
  return {
    ...segment,
    center: segment.center ? { ...segment.center } : undefined,
    widthProfile: segment.widthProfile?.map((point) => ({ ...point })),
  };
}

function add(a: Point, b: Point): Point { return { x: a.x + b.x, y: a.y + b.y }; }
function subtract(a: Point, b: Point): Point { return { x: a.x - b.x, y: a.y - b.y }; }
function scale(point: Point, factor: number): Point { return { x: point.x * factor, y: point.y * factor }; }
function dot(a: Point, b: Point): number { return a.x * b.x + a.y * b.y; }
function distance(a: Point, b: Point): number { return Math.hypot(a.x - b.x, a.y - b.y); }
function normalize(point: Point): Point {
  const length = Math.hypot(point.x, point.y);
  return length > 1e-12 ? scale(point, 1 / length) : { x: 0, y: 0 };
}
function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
