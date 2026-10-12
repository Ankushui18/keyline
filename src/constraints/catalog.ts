import type { VectorDocument } from '../core/document';
import { createEntityId } from '../core/ids';
import type { Constraint, ConstraintType, EntityId, SelectionState } from '../core/types';

export interface ConstraintAction {
  type: ConstraintType;
  label: string;
  symbol: string;
  enabled: boolean;
  reason: string;
  parameter?: 'distance' | 'angle' | 'radius';
}

const DEFINITIONS: Array<Omit<ConstraintAction, 'enabled' | 'reason'>> = [
  { type: 'horizontal', label: 'Horizontal', symbol: 'H' },
  { type: 'vertical', label: 'Vertical', symbol: 'V' },
  { type: 'parallel', label: 'Parallel', symbol: '∥' },
  { type: 'perpendicular', label: 'Perpendicular', symbol: '⊥' },
  { type: 'equal_length', label: 'Equal length', symbol: '=' },
  { type: 'fixed_distance', label: 'Distance', symbol: '↔', parameter: 'distance' },
  { type: 'fixed_angle', label: 'Angle', symbol: '∠', parameter: 'angle' },
  { type: 'symmetric', label: 'Symmetric', symbol: '◇' },
  { type: 'coincident', label: 'Coincident', symbol: '◎' },
  { type: 'tangent', label: 'Tangent', symbol: 'T' },
  { type: 'fixed_radius', label: 'Radius', symbol: 'R', parameter: 'radius' },
];

export function constraintActions(document: VectorDocument, selection: SelectionState): ConstraintAction[] {
  const nodeCount = selection.nodeIds.size;
  const segmentCount = selection.segmentIds.size;
  return DEFINITIONS.map((definition) => {
    let enabled = false;
    let reason = '';
    switch (definition.type) {
      case 'horizontal':
      case 'vertical':
        enabled = segmentCount >= 1;
        reason = 'Select at least one segment';
        break;
      case 'parallel':
      case 'perpendicular':
      case 'equal_length':
      case 'fixed_angle':
        enabled = segmentCount === 2;
        reason = 'Select exactly two segments';
        break;
      case 'fixed_distance':
      case 'symmetric':
      case 'coincident':
        enabled = nodeCount === 2;
        reason = 'Select exactly two nodes';
        break;
      case 'tangent': {
        const segments = [...selection.segmentIds].map((id) => document.getSegment(id));
        enabled = segments.length === 2 &&
          segments.some((segment) => segment?.type === 'line') &&
          segments.some((segment) => segment?.type === 'bezier' || segment?.type === 'arc') &&
          sharedNodeId(segments[0], segments[1]) !== null;
        reason = 'Select a line and curve sharing a node';
        break;
      }
      case 'fixed_radius': {
        const id = [...selection.segmentIds][0];
        enabled = segmentCount === 1 && document.getSegment(id)?.type === 'arc';
        reason = 'Select one native circular arc';
        break;
      }
    }
    return { ...definition, enabled, reason };
  });
}

export function createConstraintsForSelection(
  document: VectorDocument,
  selection: SelectionState,
  type: ConstraintType,
  parameterValue?: number,
): Constraint[] {
  const nodes = [...selection.nodeIds];
  const segments = [...selection.segmentIds];
  const base = (targetIds: EntityId[], parameters?: Record<string, number>): Constraint => ({
    id: createEntityId(),
    type,
    priority: 'hard',
    targetIds,
    parameters,
    tolerance: 1e-6,
  });

  switch (type) {
    case 'horizontal':
    case 'vertical': {
      const inferredSegments = segments.length > 0 || nodes.length !== 2
        ? segments
        : [...document.segments.values()]
            .filter((segment) =>
              (segment.startNodeId === nodes[0] && segment.endNodeId === nodes[1]) ||
              (segment.startNodeId === nodes[1] && segment.endNodeId === nodes[0]),
            )
            .map((segment) => segment.id);
      return inferredSegments.map((segmentId) => base([segmentId]));
    }
    case 'parallel':
    case 'perpendicular':
    case 'equal_length':
      return segments.length === 2 ? [base(segments)] : [];
    case 'fixed_distance': {
      if (nodes.length !== 2) return [];
      const first = document.getNode(nodes[0]);
      const second = document.getNode(nodes[1]);
      const current = first && second
        ? Math.hypot(second.position.x - first.position.x, second.position.y - first.position.y)
        : 0;
      return [base(nodes, { distance: Math.max(0, parameterValue ?? current) })];
    }
    case 'fixed_angle': {
      if (segments.length !== 2) return [];
      const shared = sharedNodeId(document.getSegment(segments[0]), document.getSegment(segments[1]));
      return [base(shared ? [...segments, shared] : segments, { angle: parameterValue ?? 90 })];
    }
    case 'symmetric': {
      if (nodes.length !== 2) return [];
      const first = document.getNode(nodes[0])!;
      const second = document.getNode(nodes[1])!;
      return [base(nodes, {
        axisX: (first.position.x + second.position.x) / 2,
        axisY: (first.position.y + second.position.y) / 2,
        axisAngle: 90,
      })];
    }
    case 'coincident': return nodes.length === 2 ? [base(nodes)] : [];
    case 'tangent': {
      if (segments.length !== 2) return [];
      const first = document.getSegment(segments[0]);
      const second = document.getSegment(segments[1]);
      const shared = sharedNodeId(first, second);
      if (!first || !second || !shared) return [];
      const lineId = first.type === 'line' ? first.id : second.id;
      const curveId = first.type === 'line' ? second.id : first.id;
      return [base([lineId, curveId, shared])];
    }
    case 'fixed_radius': {
      const segment = segments.length === 1 ? document.getSegment(segments[0]) : undefined;
      return segment?.type === 'arc'
        ? [base(segments, { radius: Math.max(0, parameterValue ?? segment.radius ?? 0) })]
        : [];
    }
  }
}

export function constraintsForSelection(document: VectorDocument, selection: SelectionState): Constraint[] {
  const targets = new Set([...selection.nodeIds, ...selection.segmentIds]);
  if (selection.nodeIds.size > 1) {
    for (const segment of document.segments.values()) {
      if (selection.nodeIds.has(segment.startNodeId) && selection.nodeIds.has(segment.endNodeId)) {
        targets.add(segment.id);
      }
    }
  }
  if (targets.size === 0) return [...document.constraints.values()];
  return [...document.constraints.values()].filter((constraint) =>
    constraint.targetIds.some((targetId) => targets.has(targetId)),
  );
}

export function constraintDisplayName(type: ConstraintType): string {
  return type.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function sharedNodeId(a: ReturnType<VectorDocument['getSegment']>, b: ReturnType<VectorDocument['getSegment']>): EntityId | null {
  if (!a || !b) return null;
  for (const id of [a.startNodeId, a.endNodeId]) {
    if (id === b.startNodeId || id === b.endNodeId) return id;
  }
  return null;
}

