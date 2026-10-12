import { describe, expect, it } from 'vitest';
import { VectorDocument } from './document';
import {
  prepareCreateGeometryVariant,
  prepareGeometryPropagation,
  prepareKeepLocalTopology,
  prepareMapCompatibleTopology,
  prepareReplaceVariantTopology,
  prepareSetGeometryOverrides,
  previewGeometryPropagation,
} from './geometry-components';
import { prepareDeleteObject, prepareDuplicateObject } from './object-operations';
import { auditGeometryComponent } from './family-qa';
import { analyzeFamilyCollection } from './family-collection';
import { commitFamilyQaFixes } from './geometry-family-actions';
import { exportFamilyChangeManifest } from '../export/family-manifest';
import { OperationManager, type OperationInput } from './operations';
import type { Segment, VectorNode, VectorPath } from './types';

function executeTransaction(manager: OperationManager, label: string, operations: OperationInput[]): void {
  manager.beginTransaction(label);
  try {
    for (const operation of operations) manager.execute(operation);
    manager.commitTransaction();
  } catch (error) {
    manager.rollbackTransaction();
    throw error;
  }
}

function familyFixture() {
  const document = VectorDocument.createEmpty();
  const manager = new OperationManager(document);
  const network = document.activeNetwork;
  const sourceObject = document.getObjectForNetwork(network.id)!;
  const first: VectorNode = {
    id: 'family-source-node-a',
    position: { x: 0, y: 0 },
    constraintIds: [],
  };
  const second: VectorNode = {
    id: 'family-source-node-b',
    position: { x: 40, y: 0 },
    constraintIds: [],
  };
  const path: VectorPath = { id: 'family-source-path', segmentIds: [], isClosed: false };
  const segment: Segment = {
    id: 'family-source-segment',
    startNodeId: first.id,
    endNodeId: second.id,
    type: 'line',
    role: 'geometry',
  };
  executeTransaction(manager, 'Create source', [
    { type: 'ADD_NODE', payload: { node: first, networkId: network.id } },
    { type: 'ADD_NODE', payload: { node: second, networkId: network.id } },
    { type: 'ADD_PATH', payload: { path, networkId: network.id } },
    { type: 'ADD_SEGMENT', payload: { segment, pathId: path.id } },
  ]);
  return { document, manager, sourceObject, first, second, path, segment };
}

function addLineBranch(
  manager: OperationManager,
  networkId: string,
  prefix: string,
  y: number,
): { first: VectorNode; second: VectorNode; path: VectorPath; segment: Segment } {
  const first: VectorNode = { id: `${prefix}-a`, position: { x: 0, y }, constraintIds: [] };
  const second: VectorNode = { id: `${prefix}-b`, position: { x: 40, y }, constraintIds: [] };
  const path: VectorPath = { id: `${prefix}-path`, segmentIds: [], isClosed: false };
  const segment: Segment = {
    id: `${prefix}-segment`,
    startNodeId: first.id,
    endNodeId: second.id,
    type: 'line',
    role: 'geometry',
  };
  executeTransaction(manager, `Add ${prefix}`, [
    { type: 'ADD_NODE', payload: { node: first, networkId } },
    { type: 'ADD_NODE', payload: { node: second, networkId } },
    { type: 'ADD_PATH', payload: { path, networkId } },
    { type: 'ADD_SEGMENT', payload: { segment, pathId: path.id } },
  ]);
  return { first, second, path, segment };
}

describe('reusable geometry components', () => {
  it('creates a linked variant with stable topology maps and persists it backward-compatibly', () => {
    const { document, manager, sourceObject, first, segment } = familyFixture();
    const plan = prepareCreateGeometryVariant(document, sourceObject.id, 'Arrow family', 100);
    expect(plan).not.toBeNull();
    executeTransaction(manager, 'Create linked variant', plan!.operations);

    const component = document.getGeometryComponent(plan!.componentId)!;
    const variant = component.variants[0];
    expect(component.name).toBe('Arrow family');
    expect(component.sourceObjectId).toBe(sourceObject.id);
    expect(variant.objectId).toBe(plan!.objectId);
    expect(variant.nodeMap[first.id]).toBe(plan!.topologyMap.nodeMap[first.id]);
    expect(variant.segmentMap[segment.id]).toBe(plan!.topologyMap.segmentMap[segment.id]);
    expect(document.getNode(variant.nodeMap[first.id])?.position).toEqual(first.position);

    const restored = new VectorDocument(document.toSnapshot());
    expect(restored.getGeometryComponent(component.id)).toEqual(component);
    const legacySnapshot = document.toSnapshot();
    delete legacySnapshot.geometryComponents;
    expect(new VectorDocument(legacySnapshot).geometryComponents.size).toBe(0);

    expect(manager.undo()).toBe(true);
    expect(document.getGeometryComponent(component.id)).toBeUndefined();
    expect(document.getObject(plan!.objectId)).toBeUndefined();
    expect(manager.redo()).toBe(true);
    expect(document.geometryVariantForObject(plan!.objectId)?.component.id).toBe(component.id);
  });

  it('propagates inherited geometry, preserves explicit node overrides, and rolls back in one step', () => {
    const { document, manager, sourceObject, first, second } = familyFixture();
    const creation = prepareCreateGeometryVariant(document, sourceObject.id, undefined, 100)!;
    executeTransaction(manager, 'Create linked variant', creation.operations);
    const component = document.getGeometryComponent(creation.componentId)!;
    const variant = component.variants[0];
    const targetFirstId = variant.nodeMap[first.id];
    const targetSecondId = variant.nodeMap[second.id];

    manager.execute({
      type: 'SET_NODE_POSITIONS',
      payload: { positions: [{ nodeId: targetSecondId, position: { x: 64, y: 12 } }] },
    });
    const override = prepareSetGeometryOverrides(
      document,
      variant.objectId,
      [targetSecondId],
      [],
      true,
    );
    expect(override).not.toBeNull();
    manager.execute(override!);
    manager.execute({
      type: 'SET_NODE_POSITIONS',
      payload: {
        positions: [
          { nodeId: first.id, position: { x: 8, y: 4 } },
          { nodeId: second.id, position: { x: 52, y: 6 } },
        ],
      },
    });

    const preview = previewGeometryPropagation(document, component.id)!;
    expect(preview.variants[0]).toMatchObject({
      state: 'overridden',
      overriddenNodeCount: 1,
      inheritedNodeCount: 1,
    });
    const beforePropagation = document.toSnapshot();
    const propagation = prepareGeometryPropagation(document, component.id, undefined, 200)!;
    executeTransaction(manager, 'Update geometry family', propagation.operations);

    expect(document.getNode(targetFirstId)?.position).toEqual({ x: 8, y: 4 });
    expect(document.getNode(targetSecondId)?.position).toEqual({ x: 64, y: 12 });
    expect(document.getGeometryComponent(component.id)?.variants[0].lastSyncedAt).toBe(200);

    expect(manager.undo()).toBe(true);
    expect(document.toSnapshot()).toEqual(beforePropagation);
    expect(document.getNode(targetSecondId)?.position).toEqual({ x: 64, y: 12 });
  });

  it('preserves explicit segment overrides and can deliberately resume inheritance', () => {
    const { document, manager, sourceObject, segment } = familyFixture();
    const creation = prepareCreateGeometryVariant(document, sourceObject.id, undefined, 100)!;
    executeTransaction(manager, 'Create linked variant', creation.operations);
    const variant = document.getGeometryComponent(creation.componentId)!.variants[0];
    const targetSegmentId = variant.segmentMap[segment.id];
    const override = prepareSetGeometryOverrides(
      document,
      variant.objectId,
      [],
      [targetSegmentId],
      true,
    );
    manager.execute(override!);
    manager.execute({
      type: 'SET_SEGMENT_WIDTH_PROFILE',
      payload: { segmentId: segment.id, widthProfile: [{ id: 'source-width', t: 0.5, width: 8 }] },
    });

    let propagation = prepareGeometryPropagation(document, creation.componentId, undefined, 200)!;
    expect(propagation.preview.variants[0]).toMatchObject({
      state: 'overridden',
      overriddenSegmentCount: 1,
    });
    executeTransaction(manager, 'Keep local segment', propagation.operations);
    expect(document.getSegment(targetSegmentId)?.widthProfile).toBeUndefined();

    const resume = prepareSetGeometryOverrides(
      document,
      variant.objectId,
      [],
      [targetSegmentId],
      false,
    );
    manager.execute(resume!);
    propagation = prepareGeometryPropagation(document, creation.componentId, undefined, 300)!;
    executeTransaction(manager, 'Resume inherited segment', propagation.operations);
    expect(document.getSegment(targetSegmentId)?.widthProfile?.map(({ t, width }) => ({ t, width }))).toEqual([
      { t: 0.5, width: 8 },
    ]);
    expect(document.getGeometryComponent(creation.componentId)?.variants[0].overriddenSegmentIds).toEqual([]);
  });

  it('detaches excluded editable variants and retains locked variants during scoped propagation', () => {
    const { document, manager, sourceObject } = familyFixture();
    const first = prepareCreateGeometryVariant(document, sourceObject.id, undefined, 100)!;
    executeTransaction(manager, 'Create first variant', first.operations);
    const second = prepareCreateGeometryVariant(document, sourceObject.id, undefined, 101)!;
    executeTransaction(manager, 'Create second variant', second.operations);
    const secondLayer = document.getLayerForObject(second.objectId)!;
    manager.execute({
      type: 'UPDATE_LAYER',
      payload: { layerId: secondLayer.id, updates: { locked: true } },
    });

    const propagation = prepareGeometryPropagation(
      document,
      first.componentId,
      new Set(),
      200,
    )!;
    expect(propagation.preview.variants.find((item) => item.objectId === first.objectId)?.state).toBe('skipped');
    expect(propagation.preview.variants.find((item) => item.objectId === second.objectId)).toMatchObject({
      state: 'inherited',
      included: true,
      locked: true,
    });
    executeTransaction(manager, 'Scoped geometry update', propagation.operations);

    expect(document.geometryVariantForObject(first.objectId)).toBeUndefined();
    expect(document.geometryVariantForObject(second.objectId)?.component.id).toBe(first.componentId);
    expect(manager.undo()).toBe(true);
    expect(document.getGeometryComponent(first.componentId)?.variants).toHaveLength(2);
  });

  it('can acknowledge source divergence as an explicit local-topology override', () => {
    const { document, manager, sourceObject, first } = familyFixture();
    const creation = prepareCreateGeometryVariant(document, sourceObject.id, undefined, 100)!;
    executeTransaction(manager, 'Create variant', creation.operations);
    const variant = document.getGeometryComponent(creation.componentId)!.variants[0];
    const targetFirstId = variant.nodeMap[first.id];
    const extraNode: VectorNode = {
      id: 'source-intentional-extra',
      position: { x: 20, y: 24 },
      constraintIds: [],
    };
    manager.execute({ type: 'ADD_NODE', payload: { node: extraNode, networkId: sourceObject.networkId } });
    expect(previewGeometryPropagation(document, creation.componentId)?.variants[0].state).toBe('conflicting');

    const keepLocal = prepareKeepLocalTopology(document, creation.objectId);
    expect(keepLocal).not.toBeNull();
    manager.execute(keepLocal!);
    expect(previewGeometryPropagation(document, creation.componentId)?.variants[0]).toMatchObject({
      state: 'overridden',
      topologyOverrideCount: 1,
      conflicts: [],
    });
    expect(document.getGeometryComponent(creation.componentId)?.variants[0].omittedSourceNodeIds).toEqual([
      extraNode.id,
    ]);

    manager.execute({
      type: 'SET_NODE_POSITIONS',
      payload: { positions: [{ nodeId: first.id, position: { x: 9, y: 3 } }] },
    });
    const propagation = prepareGeometryPropagation(document, creation.componentId, undefined, 200)!;
    executeTransaction(manager, 'Propagate retained relationship', propagation.operations);
    expect(document.getNode(targetFirstId)?.position).toEqual({ x: 9, y: 3 });
    expect(document.getNode(extraNode.id)).toBeDefined();
  });

  it('replaces conflicting variant topology while preserving stable mapped IDs and one-step rollback', () => {
    const { document, manager, sourceObject, first } = familyFixture();
    const creation = prepareCreateGeometryVariant(document, sourceObject.id, undefined, 100)!;
    executeTransaction(manager, 'Create variant', creation.operations);
    const beforeVariant = document.getGeometryComponent(creation.componentId)!.variants[0];
    const stableTargetNodeId = beforeVariant.nodeMap[first.id];
    const branch = addLineBranch(manager, sourceObject.networkId, 'source-new-branch', 60);
    const beforeResolution = document.toSnapshot();
    expect(previewGeometryPropagation(document, creation.componentId)?.variants[0].state).toBe('conflicting');

    const replacement = prepareReplaceVariantTopology(document, creation.objectId, 300);
    expect(replacement).not.toBeNull();
    executeTransaction(manager, 'Replace variant topology', replacement!.operations);
    const next = document.getGeometryComponent(creation.componentId)!.variants[0];
    const targetObject = document.getObject(creation.objectId)!;
    const targetNetwork = document.getNetwork(targetObject.networkId)!;
    expect(next.nodeMap[first.id]).toBe(stableTargetNodeId);
    expect(next.nodeMap[branch.first.id]).toBeDefined();
    expect(next.segmentMap[branch.segment.id]).toBeDefined();
    expect(next.pathMap[branch.path.id]).toBeDefined();
    expect(targetNetwork.nodeIds).toHaveLength(4);
    expect(previewGeometryPropagation(document, creation.componentId)?.variants[0].state).toBe('inherited');

    expect(manager.undo()).toBe(true);
    const restored = document.getGeometryComponent(creation.componentId)!.variants[0];
    const restoredTarget = document.getNetwork(targetObject.networkId)!;
    expect(restored).toEqual(beforeVariant);
    expect(restoredTarget.nodeIds).toEqual(
      beforeResolution.networks.find((network) => network.id === targetObject.networkId)?.nodeIds,
    );
    expect(restoredTarget.pathIds).toEqual(
      beforeResolution.networks.find((network) => network.id === targetObject.networkId)?.pathIds,
    );
    expect(previewGeometryPropagation(document, creation.componentId)?.variants[0].state).toBe('conflicting');
  });

  it('maps independently-created compatible nodes, segments, and paths without replacing target IDs', () => {
    const { document, manager, sourceObject } = familyFixture();
    const creation = prepareCreateGeometryVariant(document, sourceObject.id, undefined, 100)!;
    executeTransaction(manager, 'Create variant', creation.operations);
    const targetObject = document.getObject(creation.objectId)!;
    const sourceBranch = addLineBranch(manager, sourceObject.networkId, 'source-compatible', 72);
    const targetBranch = addLineBranch(manager, targetObject.networkId, 'target-compatible', 72);
    const conflict = previewGeometryPropagation(document, creation.componentId)!.variants[0];
    expect(conflict).toMatchObject({ state: 'conflicting', canMapCompatibleTopology: true });

    const mapOperation = prepareMapCompatibleTopology(document, creation.objectId);
    expect(mapOperation).not.toBeNull();
    manager.execute(mapOperation!);
    const mapped = document.getGeometryComponent(creation.componentId)!.variants[0];
    expect(mapped.nodeMap[sourceBranch.first.id]).toBe(targetBranch.first.id);
    expect(mapped.nodeMap[sourceBranch.second.id]).toBe(targetBranch.second.id);
    expect(mapped.segmentMap[sourceBranch.segment.id]).toBe(targetBranch.segment.id);
    expect(mapped.pathMap[sourceBranch.path.id]).toBe(targetBranch.path.id);
    expect(previewGeometryPropagation(document, creation.componentId)?.variants[0].state).toBe('inherited');

    manager.execute({
      type: 'SET_NODE_POSITIONS',
      payload: { positions: [{ nodeId: sourceBranch.first.id, position: { x: -12, y: 70 } }] },
    });
    const propagation = prepareGeometryPropagation(document, creation.componentId, undefined, 400)!;
    executeTransaction(manager, 'Propagate mapped branch', propagation.operations);
    expect(document.getNode(targetBranch.first.id)?.position).toEqual({ x: -12, y: 70 });
  });

  it('reports topology conflicts without partially rewriting a variant', () => {
    const { document, manager, sourceObject } = familyFixture();
    const creation = prepareCreateGeometryVariant(document, sourceObject.id, undefined, 100)!;
    executeTransaction(manager, 'Create variant', creation.operations);
    const extraNode: VectorNode = {
      id: 'family-source-extra-node',
      position: { x: 20, y: 20 },
      constraintIds: [],
    };
    manager.execute({
      type: 'ADD_NODE',
      payload: { node: extraNode, networkId: sourceObject.networkId },
    });

    const preview = previewGeometryPropagation(document, creation.componentId)!;
    expect(preview.variants[0].state).toBe('conflicting');
    expect(preview.variants[0].conflicts).toContain('Source node topology changed.');
    const before = document.toSnapshot();
    const propagation = prepareGeometryPropagation(document, creation.componentId, undefined, 200)!;
    expect(propagation.operations).toHaveLength(0);
    expect(document.toSnapshot()).toEqual(before);
  });

  it('audits family consistency and applies only selected safe fixes in one undo step', () => {
    const { document, manager, sourceObject } = familyFixture();
    const creation = prepareCreateGeometryVariant(document, sourceObject.id, 'Arrow family', 100)!;
    executeTransaction(manager, 'Create variant', creation.operations);
    const variantObject = document.getObject(creation.objectId)!;
    const variantAppearance = document.getAppearance(variantObject.appearanceId)!;
    manager.execute({
      type: 'UPDATE_OBJECT',
      payload: { objectId: variantObject.id, updates: { name: '' } },
    });
    expect(auditGeometryComponent(document, creation.componentId)?.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ title: 'Blank family member name' })]),
    );
    manager.execute({
      type: 'UPDATE_OBJECT',
      payload: {
        objectId: variantObject.id,
        updates: {
          name: sourceObject.name,
          transform: { ...variantObject.transform, x: 900, scaleX: 2 },
        },
      },
    });
    manager.execute({
      type: 'UPDATE_APPEARANCE',
      payload: {
        appearanceId: variantAppearance.id,
        updates: { stroke: { ...variantAppearance.stroke!, width: 5 } },
      },
    });

    const report = auditGeometryComponent(document, creation.componentId)!;
    expect(new Set(report.issues.map((issue) => issue.category))).toEqual(
      new Set(['naming', 'size', 'stroke', 'bounds']),
    );
    expect(report.issues.every((issue) => Boolean(issue.fix))).toBe(true);
    const beforeFixes = document.toSnapshot();
    const result = commitFamilyQaFixes(
      document,
      manager,
      creation.componentId,
      report.issues.map((issue) => issue.id),
      500,
    );
    expect(result).toMatchObject({ appliedCount: 4, remainingIssueCount: 0 });
    expect(auditGeometryComponent(document, creation.componentId)?.passed).toBe(true);
    expect(document.getGeometryComponent(creation.componentId)?.lastQa).toMatchObject({
      checkedAt: 500,
      remainingIssueCount: 0,
    });
    expect(document.geometryVariantForObject(creation.objectId)?.component.id).toBe(creation.componentId);

    expect(manager.undo()).toBe(true);
    expect(document.toSnapshot()).toEqual(beforeFixes);

    const variantLayer = document.getLayerForObject(creation.objectId)!;
    manager.execute({
      type: 'UPDATE_LAYER',
      payload: { layerId: variantLayer.id, updates: { locked: true } },
    });
    const lockedSnapshot = document.toSnapshot();
    const lockedIssue = auditGeometryComponent(document, creation.componentId)!.issues.find((issue) => issue.fix);
    expect(() => commitFamilyQaFixes(
      document,
      manager,
      creation.componentId,
      [lockedIssue!.id],
      600,
    )).toThrow(/can no longer be fixed automatically/);
    expect(document.toSnapshot()).toEqual(lockedSnapshot);
  });

  it('routes unresolved topology conflicts to deliberate review and reports them in a clean manifest', () => {
    const { document, manager, sourceObject } = familyFixture();
    const creation = prepareCreateGeometryVariant(document, sourceObject.id, 'Arrow family', 100)!;
    executeTransaction(manager, 'Create variant', creation.operations);
    const extraNode: VectorNode = {
      id: 'manifest-source-extra-node',
      position: { x: 20, y: 20 },
      constraintIds: [],
    };
    manager.execute({
      type: 'ADD_NODE',
      payload: { node: extraNode, networkId: sourceObject.networkId },
    });

    const report = auditGeometryComponent(document, creation.componentId)!;
    const topology = report.issues.find((issue) => issue.category === 'topology');
    expect(topology).toMatchObject({
      severity: 'error',
      requiresTopologyReview: true,
    });
    expect(topology?.fix).toBeUndefined();
    const manifest = exportFamilyChangeManifest(document, { generatedAt: 1_000 });
    expect(manifest).toContain('# Family Delivery Change Manifest');
    expect(manifest).toContain('## Arrow family');
    expect(manifest).toContain('Unresolved topology conflicts: 1');
    expect(manifest).toContain('ERROR · Topology');
    expect(manifest).not.toContain(creation.componentId);
    expect(manifest).not.toContain(creation.objectId);
  });

  it('summarizes ready, review, blocked, and unlinked library states without mutation', () => {
    const { document, manager, sourceObject, second } = familyFixture();
    const creation = prepareCreateGeometryVariant(document, sourceObject.id, 'Arrow family', 100)!;
    executeTransaction(manager, 'Create variant', creation.operations);
    const duplicate = prepareDuplicateObject(document, sourceObject.id)!;
    executeTransaction(manager, 'Create unlinked asset', duplicate.operations);
    const beforeAudit = document.toSnapshot();

    let collection = analyzeFamilyCollection(document);
    expect(collection).toMatchObject({
      blockedCount: 0,
      reviewCount: 0,
      readyCount: 1,
      issueCount: 0,
    });
    expect(collection.unlinkedAssets.map((asset) => asset.objectId)).toEqual([duplicate.objectId]);
    expect(document.toSnapshot()).toEqual(beforeAudit);

    manager.execute({
      type: 'SET_NODE_POSITIONS',
      payload: { positions: [{ nodeId: second.id, position: { x: 58, y: 0 } }] },
    });
    collection = analyzeFamilyCollection(document);
    expect(collection.families[0]).toMatchObject({ status: 'review', pendingVariantCount: 1 });
    expect(collection.reviewCount).toBe(1);

    manager.execute({
      type: 'ADD_NODE',
      payload: {
        node: { id: 'collection-conflict-node', position: { x: 20, y: 20 }, constraintIds: [] },
        networkId: sourceObject.networkId,
      },
    });
    collection = analyzeFamilyCollection(document);
    expect(collection.families[0]).toMatchObject({ status: 'blocked' });
    expect(collection.blockedCount).toBe(1);
    expect(collection.families[0].issueCategories).toContain('topology');
  });

  it('cleans up variant and source relationships transactionally during object deletion', () => {
    const { document, manager, sourceObject } = familyFixture();
    const creation = prepareCreateGeometryVariant(document, sourceObject.id, undefined, 100)!;
    executeTransaction(manager, 'Create variant', creation.operations);

    const deleteVariant = prepareDeleteObject(document, creation.objectId)!;
    executeTransaction(manager, 'Delete variant', deleteVariant.operations);
    expect(document.getObject(creation.objectId)).toBeUndefined();
    expect(document.getGeometryComponent(creation.componentId)?.variants).toHaveLength(0);
    expect(manager.undo()).toBe(true);
    expect(document.geometryVariantForObject(creation.objectId)).toBeDefined();

    const deleteSource = prepareDeleteObject(document, sourceObject.id)!;
    executeTransaction(manager, 'Delete source', deleteSource.operations);
    expect(document.getGeometryComponent(creation.componentId)).toBeUndefined();
    expect(document.getObject(creation.objectId)).toBeDefined();
    expect(manager.undo()).toBe(true);
    expect(document.getGeometryComponent(creation.componentId)?.sourceObjectId).toBe(sourceObject.id);
  });
});
