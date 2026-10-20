import type { VectorDocument } from './document';
import { invertGraphPatch, type GraphPatch, type OperationManager } from './operations';
import type { Constraint } from './types';
import type { EntityId } from './types';
import { prepareFillet, validateFillet } from '../tools/fillet-tool';

export interface CornerInfo {
  nodeId: EntityId;
  /** Position label in reading order for a four-corner shape. */
  slot: 'top-left' | 'top-right' | 'bottom-right' | 'bottom-left' | number;
}

export interface CornerReport {
  /** Sharp corners that can still be rounded, ordered TL, TR, BR, BL when there are four. */
  sharp: CornerInfo[];
  /** Radii of corners that are already rounded (true arc segments). */
  roundedRadii: number[];
  /** True when the object has at least one closed path made of lines/arcs. */
  closed: boolean;
}

export function inspectCorners(document: VectorDocument, objectId: EntityId): CornerReport {
  const object = document.getObject(objectId);
  const network = object ? document.getNetwork(object.networkId) : undefined;
  if (!network) return { sharp: [], roundedRadii: [], closed: false };
  const roundedRadii: number[] = [];
  let closed = false;
  for (const pathId of network.pathIds) {
    const path = document.getPath(pathId);
    if (!path) continue;
    if (path.isClosed) closed = true;
    for (const segmentId of path.segmentIds) {
      const segment = document.getSegment(segmentId);
      if (segment?.type === 'arc' && segment.role !== 'construction' && 'radius' in segment) {
        roundedRadii.push(Number(segment.radius));
      }
    }
  }
  const sharpNodes = network.nodeIds
    .map((id) => document.getNode(id))
    .filter((node): node is NonNullable<typeof node> => Boolean(node))
    .filter((node) => validateFillet(document, node.id, 0.01).valid);
  if (sharpNodes.length === 4) {
    const cx = sharpNodes.reduce((sum, node) => sum + node.position.x, 0) / 4;
    const cy = sharpNodes.reduce((sum, node) => sum + node.position.y, 0) / 4;
    const pick = (right: boolean, bottom: boolean) =>
      sharpNodes.find((node) => (node.position.x >= cx) === right && (node.position.y >= cy) === bottom);
    const tl = pick(false, false); const tr = pick(true, false); const br = pick(true, true); const bl = pick(false, true);
    if (tl && tr && br && bl) {
      return {
        sharp: [
          { nodeId: tl.id, slot: 'top-left' }, { nodeId: tr.id, slot: 'top-right' },
          { nodeId: br.id, slot: 'bottom-right' }, { nodeId: bl.id, slot: 'bottom-left' },
        ],
        roundedRadii, closed,
      };
    }
  }
  return { sharp: sharpNodes.map((node, index) => ({ nodeId: node.id, slot: index })), roundedRadii, closed };
}

/** Rounds the given corners with true arc fillets in one undo step. Returns how many were applied. */
const lastRadii = new Map<EntityId, number[]>();
const lastPlans = new Map<EntityId, { patch: GraphPatch; constraints: Constraint[] }[]>();
export function currentRadii(objectId: EntityId): number[] | undefined { return lastRadii.get(objectId); }

export function applyCornerRadii(
  manager: OperationManager,
  objectId: EntityId,
  radii: (number | undefined)[],
): { applied: number; skipped: number; clamped: number } {
  const previous = lastRadii.get(objectId);
  const previousPlans = lastPlans.get(objectId) ?? [];
  let applied = 0; let skipped = 0; let clamped = 0;
  const newPlans: { patch: GraphPatch; constraints: Constraint[] }[] = [];
  manager.beginTransaction('Round corners');
  try {
    if (previous && previousPlans.length) {
      for (const plan of [...previousPlans].reverse()) {
        for (const constraint of plan.constraints) manager.execute({ type: 'REMOVE_CONSTRAINT', payload: { constraintId: constraint.id } });
        manager.execute({ type: 'APPLY_GRAPH_PATCH', payload: invertGraphPatch(plan.patch) });
      }
      radii = radii.map((value, index) => value ?? previous[index]);
    }
    const report = inspectCorners(manager.document, objectId);
    const stored = radii.map((value) => value ?? 0);
    report.sharp.forEach((corner, index) => {
      const wanted = radii[index];
      if (!wanted || wanted <= 0) return;
      const doc = manager.document;
      const limit = validateFillet(doc, corner.nodeId, 0.01);
      if (!limit.valid) { skipped += 1; return; }
      const radius = Math.min(wanted, Math.floor(limit.maximumRadius * 100) / 100);
      if (radius < wanted) clamped += 1;
      if (radius <= 0) { skipped += 1; return; }
      stored[index] = radius;
      const validation = validateFillet(doc, corner.nodeId, radius);
      const plan = validation.valid ? prepareFillet(doc, corner.nodeId, radius) : null;
      if (!plan) { skipped += 1; return; }
      manager.execute({ type: 'APPLY_GRAPH_PATCH', payload: plan.patch });
      for (const constraint of plan.constraints) manager.execute({ type: 'ADD_CONSTRAINT', payload: { constraint } });
      newPlans.push({ patch: plan.patch, constraints: plan.constraints });
      applied += 1;
    });
    if (applied === 0 && previousPlans.length === 0) { manager.rollbackTransaction(); }
    else {
      manager.commitTransaction();
      if (applied === 0) { lastRadii.delete(objectId); lastPlans.delete(objectId); }
      else { lastRadii.set(objectId, stored); lastPlans.set(objectId, newPlans); }
    }
  } catch (error) {
    manager.rollbackTransaction();
    throw error;
  }
  return { applied, skipped, clamped };
}
