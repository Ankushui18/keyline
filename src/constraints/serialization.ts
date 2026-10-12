import type { VectorDocument } from '../core/document';
import type { ConstraintConflict, ConstraintSolveResult, EntityId, Segment } from '../core/types';

export interface SerializedSolverInput {
  nodes: Array<{ id: EntityId; x: number; y: number }>;
  segments: Array<{
    id: EntityId;
    startNodeId: EntityId;
    endNodeId: EntityId;
    segmentType: 'line' | 'bezier' | 'arc';
    role: Segment['role'];
    constructionExtent?: Segment['constructionExtent'];
    center?: { x: number; y: number };
    radius?: number;
    startAngle?: number;
    endAngle?: number;
    clockwise?: boolean;
  }>;
  constraints: Array<{
    id: EntityId;
    type: string;
    priority: string;
    targetIds: EntityId[];
    parameters: Record<string, number>;
    tolerance: number;
  }>;
  pinnedNodeIds: EntityId[];
  tolerance: number;
  maxIterations: number;
}

export interface SerializedSolverOutput {
  success: boolean;
  adjustedNodes: Array<{ id: EntityId; x: number; y: number }>;
  adjustedSegments?: Segment[];
  error: number;
  iterations: number;
  conflicts: ConstraintConflict[];
}

export function serializeSolverInput(
  document: VectorDocument,
  pinnedNodeIds: Iterable<EntityId> = [],
): SerializedSolverInput {
  return {
    nodes: [...document.nodes.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((node) => ({ id: node.id, x: node.position.x, y: node.position.y })),
    segments: [...document.segments.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((segment) => ({
        id: segment.id,
        startNodeId: segment.startNodeId,
        endNodeId: segment.endNodeId,
        segmentType: segment.type,
        role: segment.role,
        constructionExtent: segment.constructionExtent,
        center: segment.center ? { ...segment.center } : undefined,
        radius: segment.radius,
        startAngle: segment.startAngle,
        endAngle: segment.endAngle,
        clockwise: segment.clockwise,
      })),
    constraints: [...document.constraints.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((constraint) => ({
        id: constraint.id,
        type: constraint.type,
        priority: constraint.priority,
        targetIds: [...constraint.targetIds],
        parameters: { ...(constraint.parameters ?? {}) },
        tolerance: constraint.tolerance,
      })),
    pinnedNodeIds: [...pinnedNodeIds].sort(),
    tolerance: 1e-6,
    maxIterations: 100,
  };
}

export function deserializeSolverOutput(
  output: SerializedSolverOutput,
  authoritativeDocument?: VectorDocument,
): ConstraintSolveResult {
  return {
    success: output.success,
    adjustedNodes: new Map(output.adjustedNodes.map((node) => [node.id, { x: node.x, y: node.y }])),
    adjustedSegments: new Map((output.adjustedSegments ?? []).map((segment) => {
      const authoritative = authoritativeDocument?.getSegment(segment.id);
      const merged: Segment = {
        ...authoritative,
        ...segment,
        // Solver output owns numeric geometry only. Semantic role data always
        // comes from the authoritative typed graph when it is available.
        role: authoritative ? authoritative.role : segment.role ?? 'geometry',
        constructionExtent: authoritative ? authoritative.constructionExtent : segment.constructionExtent,
        center: segment.center ? { ...segment.center } : authoritative?.center ? { ...authoritative.center } : undefined,
        widthProfile: (segment.widthProfile ?? authoritative?.widthProfile)?.map((point) => ({ ...point })),
      };
      return [segment.id, merged];
    })),
    error: output.error,
    iterations: output.iterations,
    conflicts: output.conflicts,
  };
}
