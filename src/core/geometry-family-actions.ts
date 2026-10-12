import type { VectorDocument } from './document';
import type { OperationManager } from './operations';
import type { EntityId } from './types';
import { auditGeometryComponent, prepareFamilyQaFix } from './family-qa';
import {
  prepareCreateGeometryVariant,
  prepareDetachGeometryVariant,
  prepareGeometryPropagation,
  prepareKeepLocalTopology,
  prepareMapCompatibleTopology,
  prepareReplaceVariantTopology,
  prepareSetGeometryOverrides,
  type CreateGeometryVariantPlan,
  type GeometryConflictResolution,
} from './geometry-components';

export function commitCreateGeometryVariant(
  document: VectorDocument,
  manager: OperationManager,
  sourceObjectId: EntityId,
): CreateGeometryVariantPlan | null {
  const plan = prepareCreateGeometryVariant(document, sourceObjectId);
  if (!plan) return null;
  manager.beginTransaction('Create linked geometry variant');
  try {
    for (const operation of plan.operations) manager.execute(operation);
    manager.commitTransaction();
    return plan;
  } catch (error) {
    manager.rollbackTransaction();
    throw error;
  }
}

export interface GeometryFamilyImpactResult {
  operationCount: number;
  resolvedCount: number;
  detachedCount: number;
  conflictCount: number;
}

export function commitGeometryFamilyImpact(
  document: VectorDocument,
  manager: OperationManager,
  componentId: EntityId,
  includedObjectIds: EntityId[],
  resolutions: Array<{ objectId: EntityId; resolution: GeometryConflictResolution }>,
): GeometryFamilyImpactResult {
  const included = new Set(includedObjectIds);
  const beforeCount = document.getGeometryComponent(componentId)?.variants.length ?? 0;
  let operationCount = 0;
  let resolvedCount = 0;
  let conflictCount = 0;
  manager.beginTransaction('Apply geometry family impact');
  try {
    for (const { objectId, resolution } of resolutions) {
      if (resolution === 'skip' || !included.has(objectId)) continue;
      if (resolution === 'detach') {
        const operation = prepareDetachGeometryVariant(document, objectId);
        if (!operation) throw new Error('The conflicting variant could not be detached.');
        manager.execute(operation);
        included.delete(objectId);
        operationCount += 1;
        continue;
      }
      if (resolution === 'replace') {
        const replacement = prepareReplaceVariantTopology(document, objectId);
        if (!replacement) throw new Error('The variant topology could not be updated from its source.');
        for (const operation of replacement.operations) manager.execute(operation);
        operationCount += replacement.operations.length;
        resolvedCount += 1;
        continue;
      }
      const operation = resolution === 'map'
        ? prepareMapCompatibleTopology(document, objectId)
        : prepareKeepLocalTopology(document, objectId);
      if (!operation) throw new Error('The selected topology resolution is not available.');
      manager.execute(operation);
      operationCount += 1;
      resolvedCount += 1;
    }
    const plan = prepareGeometryPropagation(document, componentId, included);
    if (!plan) throw new Error('The geometry family no longer exists.');
    conflictCount = plan.preview.conflictCount;
    for (const operation of plan.operations) manager.execute(operation);
    operationCount += plan.operations.length;
    manager.commitTransaction();
  } catch (error) {
    manager.rollbackTransaction();
    throw error;
  }
  const afterCount = document.getGeometryComponent(componentId)?.variants.length ?? 0;
  return {
    operationCount,
    resolvedCount,
    detachedCount: Math.max(0, beforeCount - afterCount),
    conflictCount,
  };
}

export function commitGeometryOverrides(
  document: VectorDocument,
  manager: OperationManager,
  variantObjectId: EntityId,
  nodeIds: EntityId[],
  segmentIds: EntityId[],
  overridden: boolean,
): boolean {
  const operation = prepareSetGeometryOverrides(
    document,
    variantObjectId,
    nodeIds,
    segmentIds,
    overridden,
  );
  if (!operation) return false;
  manager.execute(operation);
  return true;
}

export function commitDetachGeometryVariant(
  document: VectorDocument,
  manager: OperationManager,
  variantObjectId: EntityId,
): boolean {
  const operation = prepareDetachGeometryVariant(document, variantObjectId);
  if (!operation) return false;
  manager.execute(operation);
  return true;
}

export interface FamilyQaFixResult {
  appliedCount: number;
  remainingIssueCount: number;
  summaries: string[];
}

export function commitFamilyQaFixes(
  document: VectorDocument,
  manager: OperationManager,
  componentId: EntityId,
  issueIds: string[],
  now = Date.now(),
): FamilyQaFixResult {
  const report = auditGeometryComponent(document, componentId);
  if (!report) throw new Error('The geometry family no longer exists.');
  const selected = new Set(issueIds);
  const issues = report.issues.filter((issue) => selected.has(issue.id) && issue.fix);
  if (issues.length === 0) return {
    appliedCount: 0,
    remainingIssueCount: report.issues.length,
    summaries: [],
  };
  const summaries: string[] = [];
  manager.beginTransaction('Apply family QA fixes');
  try {
    for (const issue of issues) {
      const prepared = prepareFamilyQaFix(document, issue.fix!);
      if (!prepared) throw new Error(`“${issue.title}” can no longer be fixed automatically.`);
      for (const operation of prepared.operations) manager.execute(operation);
      summaries.push(prepared.summary);
    }
    const remainingIssueCount = auditGeometryComponent(document, componentId)?.issues.length ?? 0;
    manager.execute({
      type: 'UPDATE_GEOMETRY_COMPONENT',
      payload: {
        componentId,
        updates: {
          lastQa: {
            checkedAt: now,
            appliedFixes: summaries,
            remainingIssueCount,
          },
        },
      },
    });
    manager.commitTransaction();
    return { appliedCount: summaries.length, remainingIssueCount, summaries };
  } catch (error) {
    manager.rollbackTransaction();
    throw error;
  }
}
