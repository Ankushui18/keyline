import type { VectorDocument } from '../core/document';
import type {
  Constraint,
  ConstraintConflict,
  ConstraintPriority,
  ConstraintSolveResult,
  EntityId,
  Point,
  Segment,
} from '../core/types';

export interface SolveOptions {
  pinnedNodeIds?: Iterable<EntityId>;
  maxIterations?: number;
  tolerance?: number;
}

const PRIORITY_ORDER: Record<ConstraintPriority, number> = { hard: 0, medium: 1, soft: 2 };
const PRIORITY_WEIGHT: Record<ConstraintPriority, number> = { hard: 1, medium: 0.55, soft: 0.25 };

/**
 * Deterministic Gauss-Seidel projection solver. The Rust/Wasm worker mirrors
 * these semantics; this synchronous core is used at the operation boundary so
 * a graph mutation is never visible before hard-constraint validation.
 */
export class DeterministicConstraintSolver {
  readonly defaultTolerance = 1e-6;
  readonly defaultMaxIterations = 100;

  solve(document: VectorDocument, options: SolveOptions = {}): ConstraintSolveResult {
    const positions = new Map<EntityId, Point>(
      [...document.nodes].map(([id, node]) => [id, { ...node.position }]),
    );
    const arcSegments = new Map<EntityId, Segment>(
      [...document.segments]
        .filter(([, segment]) => segment.type === 'arc')
        .map(([id, segment]) => [id, cloneSegment(segment)]),
    );
    const pinned = new Set(options.pinnedNodeIds ?? []);
    const constraints = [...document.constraints.values()].sort((a, b) =>
      PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.id.localeCompare(b.id),
    );
    const structuralConflicts = detectStructuralConflicts(document, constraints);
    if (structuralConflicts.length > 0) {
      return {
        success: false,
        adjustedNodes: positions,
        adjustedSegments: arcSegments,
        error: Math.max(...structuralConflicts.map((item) => item.error)),
        iterations: 0,
        conflicts: structuralConflicts,
      };
    }

    const maxIterations = options.maxIterations ?? this.defaultMaxIterations;
    const globalTolerance = options.tolerance ?? this.defaultTolerance;
    let iterations = 0;
    let maxHardError = Number.POSITIVE_INFINITY;

    for (; iterations < maxIterations; iterations += 1) {
      for (const constraint of constraints) {
        applyConstraint(document, positions, arcSegments, pinned, constraint, PRIORITY_WEIGHT[constraint.priority]);
      }
      maxHardError = 0;
      for (const constraint of constraints) {
        if (constraint.priority !== 'hard') continue;
        maxHardError = Math.max(maxHardError, constraintResidual(document, positions, arcSegments, constraint));
      }
      if (maxHardError <= globalTolerance) {
        iterations += 1;
        break;
      }
    }

    const conflicts: ConstraintConflict[] = [];
    let totalError = 0;
    for (const constraint of constraints) {
      const residual = constraintResidual(document, positions, arcSegments, constraint);
      totalError += residual * PRIORITY_WEIGHT[constraint.priority];
      const tolerance = Math.max(globalTolerance, constraint.tolerance || globalTolerance);
      if (constraint.priority === 'hard' && residual > tolerance) {
        conflicts.push({
          constraintIds: [constraint.id],
          message: `${constraintLabel(constraint.type)} could not converge within ${format(tolerance)} tolerance.`,
          error: residual,
          suggestion: pinned.has(constraint.targetIds[0])
            ? 'Release a fixed point, adjust the parameter, or relax this constraint.'
            : 'Drop a conflicting constraint or relax this constraint to soft.',
        });
      }
    }

    return {
      success: conflicts.length === 0,
      adjustedNodes: positions,
      adjustedSegments: arcSegments,
      error: totalError,
      iterations,
      conflicts,
    };
  }
}

function applyConstraint(
  document: VectorDocument,
  positions: Map<EntityId, Point>,
  arcSegments: Map<EntityId, Segment>,
  pinned: Set<EntityId>,
  constraint: Constraint,
  weight: number,
): void {
  const [aId, bId] = constraint.targetIds;
  switch (constraint.type) {
    case 'horizontal': {
      const segment = document.getSegment(aId);
      if (!segment) return;
      alignAxis(positions, pinned, segment.startNodeId, segment.endNodeId, 'y', weight);
      return;
    }
    case 'vertical': {
      const segment = document.getSegment(aId);
      if (!segment) return;
      alignAxis(positions, pinned, segment.startNodeId, segment.endNodeId, 'x', weight);
      return;
    }
    case 'fixed_distance':
      projectDistance(positions, pinned, aId, bId, constraint.parameters?.distance ?? 0, weight);
      return;
    case 'coincident':
      projectDistance(positions, pinned, aId, bId, 0, weight);
      return;
    case 'parallel':
      alignSegments(document, positions, pinned, aId, bId, 0, weight);
      return;
    case 'perpendicular':
      alignSegments(document, positions, pinned, aId, bId, Math.PI / 2, weight);
      return;
    case 'equal_length':
      equalizeSegments(document, positions, pinned, aId, bId, weight);
      return;
    case 'fixed_angle':
      alignFixedAngle(
        document,
        positions,
        pinned,
        aId,
        bId,
        degreesToRadians(constraint.parameters?.angle ?? 90),
        weight,
      );
      return;
    case 'symmetric':
      projectSymmetry(document, positions, pinned, constraint, weight);
      return;
    case 'tangent':
      projectTangent(document, positions, arcSegments, pinned, constraint, weight);
      return;
    case 'fixed_radius': {
      const segment = arcSegments.get(aId) ?? document.getSegment(aId);
      if (!segment || segment.type !== 'arc') return;
      projectArcRadius(
        positions,
        arcSegments,
        pinned,
        segment,
        Math.max(0, constraint.parameters?.radius ?? segment.radius ?? 0),
        weight,
      );
    }
  }
}

function constraintResidual(
  document: VectorDocument,
  positions: Map<EntityId, Point>,
  arcSegments: Map<EntityId, Segment>,
  constraint: Constraint,
): number {
  const [aId, bId] = constraint.targetIds;
  const segmentA = arcSegments.get(aId) ?? document.getSegment(aId);
  const segmentB = arcSegments.get(bId) ?? document.getSegment(bId);
  switch (constraint.type) {
    case 'horizontal': return segmentA ? Math.abs(point(positions, segmentA.endNodeId).y - point(positions, segmentA.startNodeId).y) : Number.POSITIVE_INFINITY;
    case 'vertical': return segmentA ? Math.abs(point(positions, segmentA.endNodeId).x - point(positions, segmentA.startNodeId).x) : Number.POSITIVE_INFINITY;
    case 'fixed_distance': return Math.abs(distance(point(positions, aId), point(positions, bId)) - (constraint.parameters?.distance ?? 0));
    case 'coincident': return distance(point(positions, aId), point(positions, bId));
    case 'parallel': return segmentA && segmentB ? Math.abs(cross(unitVector(positions, segmentA), unitVector(positions, segmentB))) : Number.POSITIVE_INFINITY;
    case 'perpendicular': return segmentA && segmentB ? Math.abs(dot(unitVector(positions, segmentA), unitVector(positions, segmentB))) : Number.POSITIVE_INFINITY;
    case 'equal_length': return segmentA && segmentB ? Math.abs(segmentLength(positions, segmentA) - segmentLength(positions, segmentB)) : Number.POSITIVE_INFINITY;
    case 'fixed_angle': {
      if (!segmentA || !segmentB) return Number.POSITIVE_INFINITY;
      const shared = sharedSegmentNodeId(segmentA, segmentB);
      const current = shared
        ? signedAngle(rayFromShared(positions, segmentA, shared), rayFromShared(positions, segmentB, shared))
        : signedAngle(unitVector(positions, segmentA), unitVector(positions, segmentB));
      const target = normalizeAngle(degreesToRadians(constraint.parameters?.angle ?? 90));
      if (shared) {
        return Math.min(
          Math.abs(normalizeAngle(current - target)),
          Math.abs(normalizeAngle(current + target)),
        );
      }
      return Math.abs(normalizeAngle(current - target));
    }
    case 'symmetric': return symmetryResidual(document, positions, constraint);
    case 'tangent': return tangentResidual(document, positions, arcSegments, constraint);
    case 'fixed_radius': return segmentA
      ? arcRadiusResidual(positions, segmentA, Math.max(0, constraint.parameters?.radius ?? 0))
      : Number.POSITIVE_INFINITY;
  }
}

function alignAxis(
  positions: Map<EntityId, Point>,
  pinned: Set<EntityId>,
  aId: EntityId,
  bId: EntityId,
  axis: 'x' | 'y',
  weight: number,
): void {
  const a = point(positions, aId);
  const b = point(positions, bId);
  if (pinned.has(aId) && pinned.has(bId)) return;
  if (pinned.has(aId)) setCoordinate(positions, bId, axis, a[axis], weight);
  else if (pinned.has(bId)) setCoordinate(positions, aId, axis, b[axis], weight);
  else {
    const average = (a[axis] + b[axis]) / 2;
    setCoordinate(positions, aId, axis, average, weight);
    setCoordinate(positions, bId, axis, average, weight);
  }
}

function projectDistance(
  positions: Map<EntityId, Point>,
  pinned: Set<EntityId>,
  aId: EntityId,
  bId: EntityId,
  target: number,
  weight: number,
): void {
  if (!positions.has(aId) || !positions.has(bId)) return;
  const a = point(positions, aId);
  const b = point(positions, bId);
  let direction = normalize(subtract(b, a));
  if (magnitude(direction) < 1e-12) direction = { x: 1, y: 0 };
  const safeTarget = Math.max(0, target);
  if (pinned.has(aId) && pinned.has(bId)) return;
  if (pinned.has(aId)) setPoint(positions, bId, add(a, scale(direction, safeTarget)), weight);
  else if (pinned.has(bId)) setPoint(positions, aId, subtract(b, scale(direction, safeTarget)), weight);
  else {
    const midpoint = scale(add(a, b), 0.5);
    const half = scale(direction, safeTarget / 2);
    setPoint(positions, aId, subtract(midpoint, half), weight);
    setPoint(positions, bId, add(midpoint, half), weight);
  }
}

function projectArcRadius(
  positions: Map<EntityId, Point>,
  arcSegments: Map<EntityId, Segment>,
  pinned: Set<EntityId>,
  segment: Segment,
  targetRadius: number,
  weight: number,
): void {
  if (
    segment.type !== 'arc' ||
    !segment.center ||
    !Number.isFinite(segment.startAngle) ||
    !Number.isFinite(segment.endAngle)
  ) return;
  const radius = Math.max(1e-9, (segment.radius ?? targetRadius) + (targetRadius - (segment.radius ?? targetRadius)) * weight);
  const startDirection = { x: Math.cos(segment.startAngle!), y: Math.sin(segment.startAngle!) };
  const endDirection = { x: Math.cos(segment.endAngle!), y: Math.sin(segment.endAngle!) };
  const startPinned = pinned.has(segment.startNodeId);
  const endPinned = pinned.has(segment.endNodeId);
  let center = { ...segment.center };

  if (startPinned) {
    center = subtract(point(positions, segment.startNodeId), scale(startDirection, radius));
  } else if (endPinned) {
    center = subtract(point(positions, segment.endNodeId), scale(endDirection, radius));
  }

  const desiredStart = add(center, scale(startDirection, radius));
  const desiredEnd = add(center, scale(endDirection, radius));
  if (!startPinned) setPoint(positions, segment.startNodeId, desiredStart, weight);
  if (!endPinned) setPoint(positions, segment.endNodeId, desiredEnd, weight);

  arcSegments.set(segment.id, {
    ...segment,
    center,
    radius,
    widthProfile: segment.widthProfile?.map((point) => ({ ...point })),
  });
}

function arcRadiusResidual(
  positions: Map<EntityId, Point>,
  segment: Segment,
  targetRadius: number,
): number {
  if (segment.type !== 'arc' || !segment.center || !Number.isFinite(segment.radius) ||
    !Number.isFinite(segment.startAngle) || !Number.isFinite(segment.endAngle)) {
    return Number.POSITIVE_INFINITY;
  }
  const radius = segment.radius ?? 0;
  const desiredStart = add(segment.center, scale({ x: Math.cos(segment.startAngle!), y: Math.sin(segment.startAngle!) }, radius));
  const desiredEnd = add(segment.center, scale({ x: Math.cos(segment.endAngle!), y: Math.sin(segment.endAngle!) }, radius));
  return Math.max(
    Math.abs(radius - targetRadius),
    distance(point(positions, segment.startNodeId), desiredStart),
    distance(point(positions, segment.endNodeId), desiredEnd),
  );
}

function alignFixedAngle(
  document: VectorDocument,
  positions: Map<EntityId, Point>,
  pinned: Set<EntityId>,
  firstId: EntityId,
  secondId: EntityId,
  angleOffset: number,
  weight: number,
): void {
  const first = document.getSegment(firstId);
  const second = document.getSegment(secondId);
  if (!first || !second) return;
  const shared = sharedSegmentNodeId(first, second);
  if (!shared) {
    alignSegments(document, positions, pinned, firstId, secondId, angleOffset, weight);
    return;
  }

  const firstOther = first.startNodeId === shared ? first.endNodeId : first.startNodeId;
  const secondOther = second.startNodeId === shared ? second.endNodeId : second.startNodeId;
  const firstRay = rayFromShared(positions, first, shared);
  const secondRay = rayFromShared(positions, second, shared);
  const positive = rotate(firstRay, angleOffset);
  const negative = rotate(firstRay, -angleOffset);
  const desiredSecond = dot(positive, secondRay) >= dot(negative, secondRay) ? positive : negative;

  if (!pinned.has(secondOther)) {
    const origin = point(positions, shared);
    setPoint(
      positions,
      secondOther,
      add(origin, scale(desiredSecond, segmentLength(positions, second))),
      weight,
    );
    return;
  }
  if (!pinned.has(firstOther)) {
    const origin = point(positions, shared);
    const positiveFirst = rotate(secondRay, -angleOffset);
    const negativeFirst = rotate(secondRay, angleOffset);
    const desiredFirst = dot(positiveFirst, firstRay) >= dot(negativeFirst, firstRay) ? positiveFirst : negativeFirst;
    setPoint(
      positions,
      firstOther,
      add(origin, scale(desiredFirst, segmentLength(positions, first))),
      weight,
    );
  }
}

function sharedSegmentNodeId(first: Segment, second: Segment): EntityId | undefined {
  return [first.startNodeId, first.endNodeId].find((id) =>
    id === second.startNodeId || id === second.endNodeId);
}

function rayFromShared(
  positions: Map<EntityId, Point>,
  segment: Segment,
  sharedNodeId: EntityId,
): Point {
  const otherId = segment.startNodeId === sharedNodeId ? segment.endNodeId : segment.startNodeId;
  return normalize(subtract(point(positions, otherId), point(positions, sharedNodeId)));
}

function alignSegments(
  document: VectorDocument,
  positions: Map<EntityId, Point>,
  pinned: Set<EntityId>,
  firstId: EntityId,
  secondId: EntityId,
  angleOffset: number,
  weight: number,
): void {
  const first = document.getSegment(firstId);
  const second = document.getSegment(secondId);
  if (!first || !second) return;
  const firstPinned = segmentHasPinned(first, pinned);
  const secondPinned = segmentHasPinned(second, pinned);
  const reference = secondPinned && !firstPinned ? second : first;
  const follower = secondPinned && !firstPinned ? first : second;
  let direction = rotate(unitVector(positions, reference), angleOffset);
  const followerDirection = unitVector(positions, follower);
  if (angleOffset === 0 && dot(direction, followerDirection) < 0) direction = scale(direction, -1);
  if (Math.abs(Math.abs(angleOffset) - Math.PI / 2) < 1e-9 && dot(direction, followerDirection) < 0) {
    direction = scale(direction, -1);
  }
  placeSegmentAlong(positions, pinned, follower, direction, segmentLength(positions, follower), weight);
}

function equalizeSegments(
  document: VectorDocument,
  positions: Map<EntityId, Point>,
  pinned: Set<EntityId>,
  firstId: EntityId,
  secondId: EntityId,
  weight: number,
): void {
  const first = document.getSegment(firstId);
  const second = document.getSegment(secondId);
  if (!first || !second) return;
  const firstPinned = segmentHasPinned(first, pinned);
  const secondPinned = segmentHasPinned(second, pinned);
  const reference = secondPinned && !firstPinned ? second : first;
  const follower = secondPinned && !firstPinned ? first : second;
  placeSegmentAlong(
    positions,
    pinned,
    follower,
    unitVector(positions, follower),
    segmentLength(positions, reference),
    weight,
  );
}

function placeSegmentAlong(
  positions: Map<EntityId, Point>,
  pinned: Set<EntityId>,
  segment: Segment,
  direction: Point,
  length: number,
  weight: number,
): void {
  const start = point(positions, segment.startNodeId);
  const end = point(positions, segment.endNodeId);
  if (pinned.has(segment.startNodeId) && pinned.has(segment.endNodeId)) return;
  if (pinned.has(segment.startNodeId)) {
    setPoint(positions, segment.endNodeId, add(start, scale(direction, length)), weight);
  } else if (pinned.has(segment.endNodeId)) {
    setPoint(positions, segment.startNodeId, subtract(end, scale(direction, length)), weight);
  } else {
    const midpoint = scale(add(start, end), 0.5);
    const half = scale(direction, length / 2);
    setPoint(positions, segment.startNodeId, subtract(midpoint, half), weight);
    setPoint(positions, segment.endNodeId, add(midpoint, half), weight);
  }
}

function projectSymmetry(
  document: VectorDocument,
  positions: Map<EntityId, Point>,
  pinned: Set<EntityId>,
  constraint: Constraint,
  weight: number,
): void {
  const [aId, bId] = constraint.targetIds;
  if (!positions.has(aId) || !positions.has(bId)) return;
  const axis = symmetryAxis(document, positions, constraint);
  if (!axis) return;
  const a = point(positions, aId);
  const b = point(positions, bId);
  if (pinned.has(aId) && pinned.has(bId)) return;
  if (pinned.has(aId)) setPoint(positions, bId, reflectPoint(a, axis.start, axis.end), weight);
  else if (pinned.has(bId)) setPoint(positions, aId, reflectPoint(b, axis.start, axis.end), weight);
  else {
    const desiredA = reflectPoint(b, axis.start, axis.end);
    const projectedA = scale(add(a, desiredA), 0.5);
    setPoint(positions, aId, projectedA, weight);
    setPoint(positions, bId, reflectPoint(projectedA, axis.start, axis.end), weight);
  }
}

function symmetryResidual(document: VectorDocument, positions: Map<EntityId, Point>, constraint: Constraint): number {
  const [aId, bId] = constraint.targetIds;
  const axis = symmetryAxis(document, positions, constraint);
  if (!axis || !positions.has(aId) || !positions.has(bId)) return Number.POSITIVE_INFINITY;
  return distance(reflectPoint(point(positions, aId), axis.start, axis.end), point(positions, bId));
}

function symmetryAxis(
  _document: VectorDocument,
  positions: Map<EntityId, Point>,
  constraint: Constraint,
): { start: Point; end: Point } | null {
  const axisA = constraint.targetIds[2];
  const axisB = constraint.targetIds[3];
  if (axisA && axisB && positions.has(axisA) && positions.has(axisB)) {
    return { start: point(positions, axisA), end: point(positions, axisB) };
  }
  const x = constraint.parameters?.axisX ?? 0;
  const y = constraint.parameters?.axisY ?? 0;
  const angle = degreesToRadians(constraint.parameters?.axisAngle ?? 90);
  return { start: { x, y }, end: { x: x + Math.cos(angle), y: y + Math.sin(angle) } };
}

function projectTangent(
  document: VectorDocument,
  positions: Map<EntityId, Point>,
  arcSegments: Map<EntityId, Segment>,
  pinned: Set<EntityId>,
  constraint: Constraint,
  weight: number,
): void {
  const line = document.getSegment(constraint.targetIds[0]);
  const curve = arcSegments.get(constraint.targetIds[1]) ?? document.getSegment(constraint.targetIds[1]);
  const nodeId = constraint.targetIds[2];
  if (!line || !curve || !nodeId) return;
  const tangent = curveTangentAtNode(document, positions, curve, nodeId);
  if (!tangent) return;
  let direction = tangent;
  if (dot(direction, unitVector(positions, line)) < 0) direction = scale(direction, -1);
  const tangentPinned = new Set(pinned);
  tangentPinned.add(nodeId);
  placeSegmentAlong(positions, tangentPinned, line, direction, segmentLength(positions, line), weight);
}

function tangentResidual(
  document: VectorDocument,
  positions: Map<EntityId, Point>,
  arcSegments: Map<EntityId, Segment>,
  constraint: Constraint,
): number {
  const line = document.getSegment(constraint.targetIds[0]);
  const curve = arcSegments.get(constraint.targetIds[1]) ?? document.getSegment(constraint.targetIds[1]);
  const nodeId = constraint.targetIds[2];
  if (!line || !curve || !nodeId) return Number.POSITIVE_INFINITY;
  const tangent = curveTangentAtNode(document, positions, curve, nodeId);
  return tangent ? Math.abs(cross(unitVector(positions, line), tangent)) : Number.POSITIVE_INFINITY;
}

function curveTangentAtNode(
  document: VectorDocument,
  positions: Map<EntityId, Point>,
  segment: Segment,
  nodeId: EntityId,
): Point | null {
  const node = document.getNode(nodeId);
  if (!node) return null;
  if (segment.type === 'arc' && segment.center) {
    const endpoint = point(positions, nodeId);
    const radial = normalize(subtract(endpoint, segment.center));
    if (magnitude(radial) < 1e-12) return null;
    const direction = segment.clockwise ? -1 : 1;
    return scale({ x: -radial.y, y: radial.x }, direction);
  }
  if (segment.type !== 'bezier') return null;
  const translatedHandle = (handle: Point | undefined): Point | undefined => {
    if (!handle) return undefined;
    const current = point(positions, nodeId);
    return add(handle, subtract(current, node.position));
  };
  if (segment.startNodeId === nodeId) {
    const handle = translatedHandle(node.handleOut);
    return handle ? normalize(subtract(handle, point(positions, nodeId))) : null;
  }
  if (segment.endNodeId === nodeId) {
    const handle = translatedHandle(node.handleIn);
    return handle ? normalize(subtract(point(positions, nodeId), handle)) : null;
  }
  return null;
}

function detectStructuralConflicts(document: VectorDocument, constraints: Constraint[]): ConstraintConflict[] {
  const conflicts: ConstraintConflict[] = [];
  const hard = constraints.filter((item) => item.priority === 'hard');
  for (const constraint of hard) {
    const missing = constraint.targetIds.filter((id) => !document.nodes.has(id) && !document.segments.has(id));
    if (missing.length > 0) {
      conflicts.push({
        constraintIds: [constraint.id],
        message: `${constraintLabel(constraint.type)} references geometry that no longer exists.`,
        error: Number.POSITIVE_INFINITY,
        suggestion: 'Drop this constraint or undo the topology edit.',
      });
    }
  }

  for (let index = 0; index < hard.length; index += 1) {
    for (let otherIndex = index + 1; otherIndex < hard.length; otherIndex += 1) {
      const a = hard[index];
      const b = hard[otherIndex];
      if (sameTargets(a, b) && a.type === 'fixed_distance' && b.type === 'fixed_distance') {
        const difference = Math.abs((a.parameters?.distance ?? 0) - (b.parameters?.distance ?? 0));
        if (difference > Math.max(a.tolerance, b.tolerance, 1e-6)) {
          conflicts.push(conflictPair(a, b, difference, 'Two hard fixed-distance constraints request different dimensions.'));
        }
      }
      if (sameTargets(a, b) && a.type === 'fixed_angle' && b.type === 'fixed_angle') {
        const difference = Math.abs(normalizeAngle(degreesToRadians((a.parameters?.angle ?? 0) - (b.parameters?.angle ?? 0))));
        if (difference > Math.max(a.tolerance, b.tolerance, 1e-6)) {
          conflicts.push(conflictPair(a, b, difference, 'Two hard angle constraints request different angles.'));
        }
      }
      if (sameTargets(a, b) && a.type === 'fixed_radius' && b.type === 'fixed_radius') {
        const difference = Math.abs((a.parameters?.radius ?? 0) - (b.parameters?.radius ?? 0));
        if (difference > Math.max(a.tolerance, b.tolerance, 1e-6)) {
          conflicts.push(conflictPair(a, b, difference, 'Two hard radius constraints request different arc radii.'));
        }
      }
      const horizontalVertical = a.targetIds[0] === b.targetIds[0] &&
        ((a.type === 'horizontal' && b.type === 'vertical') || (a.type === 'vertical' && b.type === 'horizontal'));
      if (horizontalVertical) {
        conflicts.push(conflictPair(a, b, 1, 'A non-degenerate segment cannot be both horizontal and vertical.'));
      }
    }
  }
  return dedupeConflicts(conflicts);
}

function conflictPair(a: Constraint, b: Constraint, error: number, message: string): ConstraintConflict {
  return {
    constraintIds: [a.id, b.id],
    message,
    error,
    suggestion: `Drop ${shortId(b.id)}, change its parameter, or relax it to soft.`,
  };
}

function dedupeConflicts(conflicts: ConstraintConflict[]): ConstraintConflict[] {
  const seen = new Set<string>();
  return conflicts.filter((conflict) => {
    const key = [...conflict.constraintIds].sort().join(':');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sameTargets(a: Constraint, b: Constraint): boolean {
  return [...a.targetIds].sort().join('|') === [...b.targetIds].sort().join('|');
}

function segmentHasPinned(segment: Segment, pinned: Set<EntityId>): boolean {
  return pinned.has(segment.startNodeId) || pinned.has(segment.endNodeId);
}

function unitVector(positions: Map<EntityId, Point>, segment: Segment): Point {
  const vector = subtract(point(positions, segment.endNodeId), point(positions, segment.startNodeId));
  const result = normalize(vector);
  return magnitude(result) < 1e-12 ? { x: 1, y: 0 } : result;
}

function segmentLength(positions: Map<EntityId, Point>, segment: Segment): number {
  return distance(point(positions, segment.startNodeId), point(positions, segment.endNodeId));
}

function setCoordinate(
  positions: Map<EntityId, Point>,
  id: EntityId,
  axis: 'x' | 'y',
  value: number,
  weight: number,
): void {
  const current = point(positions, id);
  positions.set(id, { ...current, [axis]: current[axis] + (value - current[axis]) * weight });
}

function setPoint(positions: Map<EntityId, Point>, id: EntityId, desired: Point, weight: number): void {
  const current = point(positions, id);
  positions.set(id, {
    x: current.x + (desired.x - current.x) * weight,
    y: current.y + (desired.y - current.y) * weight,
  });
}

function point(positions: Map<EntityId, Point>, id: EntityId): Point {
  return positions.get(id) ?? { x: Number.NaN, y: Number.NaN };
}

function reflectPoint(value: Point, axisStart: Point, axisEnd: Point): Point {
  const axis = normalize(subtract(axisEnd, axisStart));
  if (magnitude(axis) < 1e-12) return { ...value };
  const relative = subtract(value, axisStart);
  const projection = scale(axis, dot(relative, axis));
  return add(axisStart, subtract(scale(projection, 2), relative));
}

function constraintLabel(type: Constraint['type']): string {
  return type.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function shortId(id: string): string { return id.slice(-6).toUpperCase(); }
function format(value: number): string { return value.toExponential(1); }
function degreesToRadians(value: number): number { return value * Math.PI / 180; }
function magnitude(value: Point): number { return Math.hypot(value.x, value.y); }
function normalize(value: Point): Point { const length = magnitude(value); return length > 1e-12 ? scale(value, 1 / length) : { x: 0, y: 0 }; }
function add(a: Point, b: Point): Point { return { x: a.x + b.x, y: a.y + b.y }; }
function subtract(a: Point, b: Point): Point { return { x: a.x - b.x, y: a.y - b.y }; }
function scale(value: Point, factor: number): Point { return { x: value.x * factor, y: value.y * factor }; }
function rotate(value: Point, angle: number): Point { const c = Math.cos(angle); const s = Math.sin(angle); return { x: value.x * c - value.y * s, y: value.x * s + value.y * c }; }
function dot(a: Point, b: Point): number { return a.x * b.x + a.y * b.y; }
function cross(a: Point, b: Point): number { return a.x * b.y - a.y * b.x; }
function distance(a: Point, b: Point): number { return magnitude(subtract(a, b)); }
function signedAngle(a: Point, b: Point): number { return Math.atan2(cross(a, b), dot(a, b)); }
function normalizeAngle(value: number): number { let result = value; while (result > Math.PI) result -= Math.PI * 2; while (result < -Math.PI) result += Math.PI * 2; return result; }
function cloneSegment(segment: Segment): Segment {
  return {
    ...segment,
    center: segment.center ? { ...segment.center } : undefined,
    widthProfile: segment.widthProfile?.map((point) => ({ ...point })),
  };
}
