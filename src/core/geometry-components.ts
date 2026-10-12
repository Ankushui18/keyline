import { createEntityId } from './ids';
import type { VectorDocument } from './document';
import { prepareDuplicateObject, type DuplicateObjectPlan } from './object-operations';
import type { OperationInput } from './operations';
import type {
  EntityId,
  GeometryComponent,
  GeometryVariantLink,
  NetworkObject,
  Segment,
  VectorNetwork,
  VectorNode,
} from './types';

export type GeometryMemberState =
  | 'source'
  | 'inherited'
  | 'overridden'
  | 'skipped'
  | 'conflicting';

export interface GeometryVariantImpact {
  variantId: EntityId;
  objectId: EntityId;
  objectName: string;
  layerName: string;
  state: GeometryMemberState;
  included: boolean;
  locked: boolean;
  hidden: boolean;
  inheritedNodeCount: number;
  overriddenNodeCount: number;
  inheritedSegmentCount: number;
  overriddenSegmentCount: number;
  changedNodeCount: number;
  changedSegmentCount: number;
  changedPathCount: number;
  topologyOverrideCount: number;
  canMapCompatibleTopology: boolean;
  conflicts: string[];
}

export type GeometryConflictResolution = 'skip' | 'replace' | 'keep-local' | 'map' | 'detach';

export interface GeometryTopologyReconciliationPlan {
  componentId: EntityId;
  variantId: EntityId;
  objectId: EntityId;
  operations: OperationInput[];
}

export interface GeometryPropagationPreview {
  component: GeometryComponent;
  sourceObject: NetworkObject;
  sourceLayerName: string;
  variants: GeometryVariantImpact[];
  includedCount: number;
  skippedCount: number;
  conflictCount: number;
  overriddenNodeCount: number;
  overriddenSegmentCount: number;
}

export interface CreateGeometryVariantPlan extends DuplicateObjectPlan {
  componentId: EntityId;
  variantId: EntityId;
}

export interface GeometryPropagationPlan {
  preview: GeometryPropagationPreview;
  operations: OperationInput[];
}

/**
 * Duplicates a source and records stable source-to-variant topology IDs. A
 * source can own many variants; a variant can belong to only one component.
 */
export function prepareCreateGeometryVariant(
  document: VectorDocument,
  sourceObjectId: EntityId,
  componentName?: string,
  now = Date.now(),
): CreateGeometryVariantPlan | null {
  const sourceObject = document.getObject(sourceObjectId);
  if (!sourceObject || document.isObjectLocked(sourceObjectId)) return null;
  const existingVariant = document.geometryVariantForObject(sourceObjectId);
  if (existingVariant) return null;
  const existingComponent = document.geometryComponentForObject(sourceObjectId);
  if (existingComponent && existingComponent.sourceObjectId !== sourceObjectId) return null;

  const duplicate = prepareDuplicateObject(document, sourceObjectId);
  if (!duplicate) return null;
  const componentId = existingComponent?.id ?? createEntityId();
  const variantId = createEntityId();
  const variantName = `${sourceObject.name} variant ${(existingComponent?.variants.length ?? 0) + 1}`;
  const variant: GeometryVariantLink = {
    id: variantId,
    objectId: duplicate.objectId,
    nodeMap: { ...duplicate.topologyMap.nodeMap },
    segmentMap: { ...duplicate.topologyMap.segmentMap },
    pathMap: { ...duplicate.topologyMap.pathMap },
    overriddenNodeIds: [],
    overriddenSegmentIds: [],
    omittedSourceNodeIds: [],
    omittedSourceSegmentIds: [],
    omittedSourcePathIds: [],
    localNodeIds: [],
    localSegmentIds: [],
    localPathIds: [],
    createdAt: now,
    lastSyncedAt: now,
  };
  const component: GeometryComponent = existingComponent
    ? { ...existingComponent, variants: [...existingComponent.variants, variant] }
    : {
        id: componentId,
        name: componentName?.trim() || `${sourceObject.name} family`,
        kind: 'geometry',
        sourceObjectId,
        variants: [variant],
        createdAt: now,
      };
  const componentOperation: OperationInput = existingComponent
    ? {
        type: 'UPDATE_GEOMETRY_COMPONENT',
        payload: { componentId, updates: { variants: component.variants } },
      }
    : { type: 'ADD_GEOMETRY_COMPONENT', payload: { component } };

  return {
    ...duplicate,
    componentId,
    variantId,
    operations: [
      ...duplicate.operations,
      { type: 'UPDATE_OBJECT', payload: { objectId: duplicate.objectId, updates: { name: variantName } } },
      { type: 'UPDATE_LAYER', payload: { layerId: duplicate.layerId, updates: { name: variantName } } },
      componentOperation,
    ],
  };
}

export function previewGeometryPropagation(
  document: VectorDocument,
  componentId: EntityId,
  requestedObjectIds?: ReadonlySet<EntityId>,
): GeometryPropagationPreview | null {
  const component = document.getGeometryComponent(componentId);
  const sourceObject = component ? document.getObject(component.sourceObjectId) : undefined;
  if (!component || !sourceObject) return null;
  const sourceLayer = document.getLayerForObject(sourceObject.id);
  const variants = component.variants.flatMap((variant) => {
    const object = document.getObject(variant.objectId);
    if (!object) return [];
    const layer = document.getLayerForObject(object.id);
    const locked = document.isObjectLocked(object.id);
    const requested = requestedObjectIds ? requestedObjectIds.has(object.id) : true;
    const included = locked || requested;
    const analysis = analyzeVariant(document, sourceObject, variant);
    const state: GeometryMemberState = !included
      ? 'skipped'
      : analysis.conflicts.length > 0
        ? 'conflicting'
        : variant.overriddenNodeIds.length > 0 ||
            variant.overriddenSegmentIds.length > 0 ||
            topologyOverrideCount(variant) > 0
          ? 'overridden'
          : 'inherited';
    return [{
      variantId: variant.id,
      objectId: object.id,
      objectName: object.name,
      layerName: layer?.name ?? 'Unlayered',
      state,
      included,
      locked,
      hidden: !document.isObjectVisible(object.id),
      inheritedNodeCount: Math.max(0, Object.keys(variant.nodeMap).length - variant.overriddenNodeIds.length),
      overriddenNodeCount: variant.overriddenNodeIds.length,
      inheritedSegmentCount: Math.max(0, Object.keys(variant.segmentMap).length - variant.overriddenSegmentIds.length),
      overriddenSegmentCount: variant.overriddenSegmentIds.length,
      changedNodeCount: analysis.changedNodeIds.length,
      changedSegmentCount: analysis.changedSegmentIds.length,
      changedPathCount: analysis.changedPathIds.length,
      topologyOverrideCount: topologyOverrideCount(variant),
      canMapCompatibleTopology: analysis.conflicts.length > 0 &&
        Boolean(buildCompatibleTopologyLink(document, sourceObject, variant)),
      conflicts: analysis.conflicts,
    } satisfies GeometryVariantImpact];
  });

  return {
    component,
    sourceObject,
    sourceLayerName: sourceLayer?.name ?? 'Unlayered',
    variants,
    includedCount: variants.filter((variant) => variant.included).length,
    skippedCount: variants.filter((variant) => variant.state === 'skipped').length,
    conflictCount: variants.filter((variant) => variant.state === 'conflicting').length,
    overriddenNodeCount: variants.reduce((sum, variant) => sum + variant.overriddenNodeCount, 0),
    overriddenSegmentCount: variants.reduce((sum, variant) => sum + variant.overriddenSegmentCount, 0),
  };
}

/**
 * Builds one atomic propagation payload. Excluded editable variants detach and
 * preserve their local geometry. Locked variants remain included. A topology
 * conflict is retained and reported, but never partially rewritten.
 */
export function prepareGeometryPropagation(
  document: VectorDocument,
  componentId: EntityId,
  requestedObjectIds?: ReadonlySet<EntityId>,
  now = Date.now(),
): GeometryPropagationPlan | null {
  const preview = previewGeometryPropagation(document, componentId, requestedObjectIds);
  if (!preview) return null;
  const operations: OperationInput[] = [];
  const retainedVariants: GeometryVariantLink[] = [];

  for (const variant of preview.component.variants) {
    const impact = preview.variants.find((candidate) => candidate.variantId === variant.id);
    if (!impact) continue;
    if (!impact.included) continue;
    retainedVariants.push({ ...variant, lastSyncedAt: impact.state === 'conflicting' ? variant.lastSyncedAt : now });
    if (impact.state === 'conflicting') continue;
    operations.push(...operationsForVariant(document, preview.sourceObject, variant));
  }

  const variantsChanged = retainedVariants.length !== preview.component.variants.length ||
    retainedVariants.some((variant, index) =>
      variant.objectId !== preview.component.variants[index]?.objectId ||
      variant.lastSyncedAt !== preview.component.variants[index]?.lastSyncedAt,
    );
  if (variantsChanged) {
    operations.push({
      type: 'UPDATE_GEOMETRY_COMPONENT',
      payload: { componentId, updates: { variants: retainedVariants } },
    });
  }
  return { preview, operations };
}

/** Marks mapped variant topology as an explicit local exception, or resumes inheritance. */
export function prepareSetGeometryOverrides(
  document: VectorDocument,
  variantObjectId: EntityId,
  targetNodeIds: Iterable<EntityId>,
  targetSegmentIds: Iterable<EntityId>,
  overridden: boolean,
): OperationInput | null {
  const result = document.geometryVariantForObject(variantObjectId);
  if (!result || document.isObjectLocked(variantObjectId)) return null;
  const { component, variant } = result;
  const sourceNodeIds = reverseMappedIds(variant.nodeMap, targetNodeIds);
  const sourceSegmentIds = reverseMappedIds(variant.segmentMap, targetSegmentIds);
  if (sourceNodeIds.length === 0 && sourceSegmentIds.length === 0) return null;
  const nextNodes = updateOverrideIds(variant.overriddenNodeIds, sourceNodeIds, overridden);
  const nextSegments = updateOverrideIds(variant.overriddenSegmentIds, sourceSegmentIds, overridden);
  const variants = component.variants.map((candidate) => candidate.id === variant.id
    ? { ...candidate, overriddenNodeIds: nextNodes, overriddenSegmentIds: nextSegments }
    : candidate);
  return {
    type: 'UPDATE_GEOMETRY_COMPONENT',
    payload: { componentId: component.id, updates: { variants } },
  };
}

export function prepareDetachGeometryVariant(
  document: VectorDocument,
  variantObjectId: EntityId,
): OperationInput | null {
  const result = document.geometryVariantForObject(variantObjectId);
  if (!result || document.isObjectLocked(variantObjectId)) return null;
  return {
    type: 'UPDATE_GEOMETRY_COMPONENT',
    payload: {
      componentId: result.component.id,
      updates: {
        variants: result.component.variants.filter((variant) => variant.objectId !== variantObjectId),
      },
    },
  };
}

export function prepareKeepLocalTopology(
  document: VectorDocument,
  variantObjectId: EntityId,
): OperationInput | null {
  const result = document.geometryVariantForObject(variantObjectId);
  if (!result || document.isObjectLocked(variantObjectId)) return null;
  const sourceObject = document.getObject(result.component.sourceObjectId);
  if (!sourceObject) return null;
  const next = buildLocalTopologyLink(document, sourceObject, result.variant);
  if (!next) return null;
  return updateVariantOperation(result.component, next);
}

export function prepareMapCompatibleTopology(
  document: VectorDocument,
  variantObjectId: EntityId,
): OperationInput | null {
  const result = document.geometryVariantForObject(variantObjectId);
  if (!result || document.isObjectLocked(variantObjectId)) return null;
  const sourceObject = document.getObject(result.component.sourceObjectId);
  if (!sourceObject) return null;
  const next = buildCompatibleTopologyLink(document, sourceObject, result.variant);
  if (!next) return null;
  return updateVariantOperation(result.component, next);
}

/**
 * Rebuilds one conflicting variant from the source while retaining all still-
 * mapped target IDs and explicit node/segment geometry overrides.
 */
export function prepareReplaceVariantTopology(
  document: VectorDocument,
  variantObjectId: EntityId,
  now = Date.now(),
): GeometryTopologyReconciliationPlan | null {
  const result = document.geometryVariantForObject(variantObjectId);
  if (!result || document.isObjectLocked(variantObjectId)) return null;
  const { component, variant } = result;
  const sourceObject = document.getObject(component.sourceObjectId);
  const targetObject = document.getObject(variant.objectId);
  const sourceNetwork = sourceObject ? document.getNetwork(sourceObject.networkId) : undefined;
  const targetNetwork = targetObject ? document.getNetwork(targetObject.networkId) : undefined;
  if (!sourceObject || !targetObject || !sourceNetwork || !targetNetwork) return null;

  const sourceSegmentIds = segmentIdsForNetwork(document, sourceNetwork);
  const targetSegmentIds = segmentIdsForNetwork(document, targetNetwork);
  const targetNodeSet = new Set(targetNetwork.nodeIds);
  const targetSegmentSet = new Set(targetSegmentIds);
  const targetPathSet = new Set(targetNetwork.pathIds);
  const nodeMap = stableReplacementMap(sourceNetwork.nodeIds, variant.nodeMap, targetNodeSet);
  const segmentMap = stableReplacementMap(sourceSegmentIds, variant.segmentMap, targetSegmentSet);
  const pathMap = stableReplacementMap(sourceNetwork.pathIds, variant.pathMap, targetPathSet);
  const operations: OperationInput[] = [];
  const targetTopologyIds = new Set<EntityId>([
    ...targetNetwork.nodeIds,
    ...targetSegmentIds,
    ...targetNetwork.pathIds,
  ]);

  for (const constraint of document.constraints.values()) {
    if (constraint.targetIds.some((id) => targetTopologyIds.has(id))) {
      operations.push({ type: 'REMOVE_CONSTRAINT', payload: { constraintId: constraint.id } });
    }
  }
  for (const group of document.parametricGroups.values()) {
    const removesSource = group.sourcePathIds.some((id) => targetPathSet.has(id));
    const removesReference = group.transform.type === 'mirror'
      ? Boolean(group.transform.axisSegmentId && targetSegmentSet.has(group.transform.axisSegmentId))
      : Boolean(group.transform.centerNodeId && targetNodeSet.has(group.transform.centerNodeId));
    if (removesSource || removesReference) {
      operations.push({ type: 'REMOVE_PARAMETRIC_GROUP', payload: { group } });
    }
  }
  for (const targetPathId of targetNetwork.pathIds) {
    const path = document.getPath(targetPathId);
    for (const segmentId of path?.segmentIds ?? []) {
      const segment = document.getSegment(segmentId);
      if (segment) {
        operations.push({
          type: 'REMOVE_SEGMENT',
          payload: { segment, pathId: targetPathId, index: path!.segmentIds.indexOf(segmentId) },
        });
      }
    }
  }
  for (const pathId of targetNetwork.pathIds) {
    const path = document.getPath(pathId);
    if (path) {
      operations.push({
        type: 'REMOVE_PATH',
        payload: { path, networkId: targetNetwork.id, index: targetNetwork.pathIds.indexOf(pathId) },
      });
    }
  }
  for (const nodeId of targetNetwork.nodeIds) {
    const node = document.getNode(nodeId);
    if (node) {
      operations.push({
        type: 'REMOVE_NODE',
        payload: { node, networkId: targetNetwork.id, index: targetNetwork.nodeIds.indexOf(nodeId) },
      });
    }
  }

  const overriddenNodes = new Set(variant.overriddenNodeIds);
  for (const sourceNodeId of sourceNetwork.nodeIds) {
    const source = document.getNode(sourceNodeId);
    if (!source) continue;
    const oldTargetId = variant.nodeMap[sourceNodeId];
    const local = overriddenNodes.has(sourceNodeId) && oldTargetId
      ? document.getNode(oldTargetId)
      : undefined;
    const geometry = local ?? source;
    operations.push({
      type: 'ADD_NODE',
      payload: {
        node: {
          ...geometry,
          id: nodeMap[sourceNodeId],
          position: { ...geometry.position },
          handleIn: geometry.handleIn ? { ...geometry.handleIn } : undefined,
          handleOut: geometry.handleOut ? { ...geometry.handleOut } : undefined,
          constraintIds: [],
        },
        networkId: targetNetwork.id,
      },
    });
  }

  const overriddenSegments = new Set(variant.overriddenSegmentIds);
  for (const sourcePathId of sourceNetwork.pathIds) {
    const sourcePath = document.getPath(sourcePathId);
    if (!sourcePath) continue;
    const targetPathId = pathMap[sourcePathId];
    operations.push({
      type: 'ADD_PATH',
      payload: {
        path: { ...sourcePath, id: targetPathId, segmentIds: [] },
        networkId: targetNetwork.id,
      },
    });
    for (const sourceSegmentId of sourcePath.segmentIds) {
      const source = document.getSegment(sourceSegmentId);
      if (!source) continue;
      const oldTargetId = variant.segmentMap[sourceSegmentId];
      const local = overriddenSegments.has(sourceSegmentId) && oldTargetId
        ? document.getSegment(oldTargetId)
        : undefined;
      const geometry = local ?? source;
      const existingWidthProfile = oldTargetId
        ? document.getSegment(oldTargetId)?.widthProfile
        : undefined;
      operations.push({
        type: 'ADD_SEGMENT',
        payload: {
          segment: {
            ...geometry,
            id: segmentMap[sourceSegmentId],
            startNodeId: nodeMap[source.startNodeId],
            endNodeId: nodeMap[source.endNodeId],
            center: geometry.center ? { ...geometry.center } : undefined,
            widthProfile: geometry.widthProfile?.map((point, index) => ({
              ...point,
              id: existingWidthProfile?.[index]?.id ?? createEntityId(),
            })),
          },
          pathId: targetPathId,
        },
      });
    }
  }

  const sourceTopologyMap = new Map<EntityId, EntityId>([
    ...Object.entries(nodeMap),
    ...Object.entries(segmentMap),
    ...Object.entries(pathMap),
  ]);
  for (const constraint of document.constraints.values()) {
    if (!constraint.targetIds.every((id) => sourceTopologyMap.has(id))) continue;
    operations.push({
      type: 'ADD_CONSTRAINT',
      payload: {
        constraint: {
          ...constraint,
          id: createEntityId(),
          targetIds: constraint.targetIds.map((id) => sourceTopologyMap.get(id)!),
          parameters: constraint.parameters ? { ...constraint.parameters } : undefined,
        },
      },
    });
  }
  for (const group of document.parametricGroups.values()) {
    if (!group.sourcePathIds.every((id) => sourceNetwork.pathIds.includes(id))) continue;
    operations.push({
      type: 'ADD_PARAMETRIC_GROUP',
      payload: {
        group: {
          ...group,
          id: createEntityId(),
          sourcePathIds: group.sourcePathIds.map((id) => pathMap[id]),
          transform: group.transform.type === 'mirror'
            ? {
                ...group.transform,
                origin: { ...group.transform.origin },
                axisSegmentId: group.transform.axisSegmentId
                  ? segmentMap[group.transform.axisSegmentId] ?? group.transform.axisSegmentId
                  : undefined,
              }
            : {
                ...group.transform,
                center: { ...group.transform.center },
                centerNodeId: group.transform.centerNodeId
                  ? nodeMap[group.transform.centerNodeId] ?? group.transform.centerNodeId
                  : undefined,
              },
        },
      },
    });
  }

  const nextVariant: GeometryVariantLink = {
    ...variant,
    nodeMap,
    segmentMap,
    pathMap,
    overriddenNodeIds: variant.overriddenNodeIds.filter((id) => id in nodeMap),
    overriddenSegmentIds: variant.overriddenSegmentIds.filter((id) => id in segmentMap),
    omittedSourceNodeIds: [],
    omittedSourceSegmentIds: [],
    omittedSourcePathIds: [],
    localNodeIds: [],
    localSegmentIds: [],
    localPathIds: [],
    lastSyncedAt: now,
  };
  operations.push(updateVariantOperation(component, nextVariant));
  return { componentId: component.id, variantId: variant.id, objectId: variant.objectId, operations };
}

interface VariantAnalysis {
  changedNodeIds: EntityId[];
  changedSegmentIds: EntityId[];
  changedPathIds: EntityId[];
  conflicts: string[];
}

function analyzeVariant(
  document: VectorDocument,
  sourceObject: NetworkObject,
  variant: GeometryVariantLink,
): VariantAnalysis {
  const sourceNetwork = document.getNetwork(sourceObject.networkId);
  const variantObject = document.getObject(variant.objectId);
  const targetNetwork = variantObject ? document.getNetwork(variantObject.networkId) : undefined;
  if (!sourceNetwork || !targetNetwork) {
    return { changedNodeIds: [], changedSegmentIds: [], changedPathIds: [], conflicts: ['Network is missing.'] };
  }
  const conflicts: string[] = [];
  compareTopologySet(
    'node',
    sourceNetwork.nodeIds,
    targetNetwork.nodeIds,
    variant.nodeMap,
    variant.omittedSourceNodeIds ?? [],
    variant.localNodeIds ?? [],
    conflicts,
  );
  compareTopologySet(
    'segment',
    segmentIdsForNetwork(document, sourceNetwork),
    segmentIdsForNetwork(document, targetNetwork),
    variant.segmentMap,
    variant.omittedSourceSegmentIds ?? [],
    variant.localSegmentIds ?? [],
    conflicts,
  );
  compareTopologySet(
    'path',
    sourceNetwork.pathIds,
    targetNetwork.pathIds,
    variant.pathMap,
    variant.omittedSourcePathIds ?? [],
    variant.localPathIds ?? [],
    conflicts,
  );

  const overriddenNodes = new Set(variant.overriddenNodeIds);
  const overriddenSegments = new Set(variant.overriddenSegmentIds);
  const changedNodeIds = sourceNetwork.nodeIds.filter((sourceId) => {
    if (overriddenNodes.has(sourceId)) return false;
    const targetId = variant.nodeMap[sourceId];
    const source = document.getNode(sourceId);
    const target = targetId ? document.getNode(targetId) : undefined;
    return Boolean(source && target && !nodeGeometryEqual(source, target));
  });
  const changedSegmentIds = segmentIdsForNetwork(document, sourceNetwork).filter((sourceId) => {
    if (overriddenSegments.has(sourceId)) return false;
    const targetId = variant.segmentMap[sourceId];
    const source = document.getSegment(sourceId);
    const target = targetId ? document.getSegment(targetId) : undefined;
    return Boolean(source && target && !segmentGeometryEqual(source, target, variant));
  });
  const changedPathIds = sourceNetwork.pathIds.filter((sourceId) => {
    const source = document.getPath(sourceId);
    const targetId = variant.pathMap[sourceId];
    const target = targetId ? document.getPath(targetId) : undefined;
    return Boolean(source && target && source.isClosed !== target.isClosed);
  });
  return { changedNodeIds, changedSegmentIds, changedPathIds, conflicts };
}

function operationsForVariant(
  document: VectorDocument,
  sourceObject: NetworkObject,
  variant: GeometryVariantLink,
): OperationInput[] {
  const sourceNetwork = document.getNetwork(sourceObject.networkId);
  if (!sourceNetwork) return [];
  const operations: OperationInput[] = [];
  const overriddenNodes = new Set(variant.overriddenNodeIds);
  const inheritedNodes = sourceNetwork.nodeIds.flatMap((sourceId) => {
    if (overriddenNodes.has(sourceId)) return [];
    const source = document.getNode(sourceId);
    const targetId = variant.nodeMap[sourceId];
    return source && targetId ? [{ source, targetId }] : [];
  });
  if (inheritedNodes.length > 0) {
    operations.push({
      type: 'SET_NODE_POSITIONS',
      payload: {
        positions: inheritedNodes.map(({ source, targetId }) => ({
          nodeId: targetId,
          position: { ...source.position },
        })),
      },
    });
    operations.push({
      type: 'RESTORE_BEND_STATE',
      payload: {
        nodes: inheritedNodes.map(({ source, targetId }) => ({
          nodeId: targetId,
          state: {
            handleIn: source.handleIn ? { ...source.handleIn } : null,
            handleOut: source.handleOut ? { ...source.handleOut } : null,
          },
        })),
        segments: [],
      },
    });
    operations.push({
      type: 'SET_NODE_MODES',
      payload: {
        modes: inheritedNodes.map(({ source, targetId }) => ({
          nodeId: targetId,
          mode: source.handleMode,
        })),
      },
    });
  }

  const overriddenSegments = new Set(variant.overriddenSegmentIds);
  const segments: Segment[] = [];
  for (const sourceId of segmentIdsForNetwork(document, sourceNetwork)) {
    if (overriddenSegments.has(sourceId)) continue;
    const source = document.getSegment(sourceId);
    const targetId = variant.segmentMap[sourceId];
    const target = targetId ? document.getSegment(targetId) : undefined;
    if (!source || !target) continue;
    segments.push({
      ...source,
      id: targetId,
      startNodeId: variant.nodeMap[source.startNodeId],
      endNodeId: variant.nodeMap[source.endNodeId],
      center: source.center ? { ...source.center } : undefined,
      widthProfile: source.widthProfile?.map((point, index) => ({
        ...point,
        id: target.widthProfile?.[index]?.id ?? createEntityId(),
      })),
    });
  }
  if (segments.length > 0) {
    operations.push({ type: 'SET_SEGMENT_GEOMETRIES', payload: { segments } });
  }
  for (const sourcePathId of sourceNetwork.pathIds) {
    const sourcePath = document.getPath(sourcePathId);
    const targetPathId = variant.pathMap[sourcePathId];
    const targetPath = targetPathId ? document.getPath(targetPathId) : undefined;
    if (sourcePath && targetPath && sourcePath.isClosed !== targetPath.isClosed) {
      operations.push({
        type: 'SET_PATH_CLOSED',
        payload: { pathId: targetPathId, isClosed: sourcePath.isClosed },
      });
    }
  }
  return operations;
}

function compareTopologySet(
  label: string,
  sourceIds: EntityId[],
  targetIds: EntityId[],
  map: Record<EntityId, EntityId>,
  omittedSourceIds: EntityId[],
  localTargetIds: EntityId[],
  conflicts: string[],
): void {
  const source = new Set(sourceIds);
  const target = new Set(targetIds);
  const coveredSources = new Set([...Object.keys(map), ...omittedSourceIds]);
  const coveredTargets = new Set([...Object.values(map), ...localTargetIds]);
  if (
    source.size !== coveredSources.size ||
    [...coveredSources].some((id) => !source.has(id))
  ) {
    conflicts.push(`Source ${label} topology changed.`);
  }
  if (
    target.size !== coveredTargets.size ||
    [...coveredTargets].some((id) => !target.has(id))
  ) {
    conflicts.push(`Variant ${label} topology changed.`);
  }
}

function topologyOverrideCount(variant: GeometryVariantLink): number {
  return (variant.omittedSourceNodeIds?.length ?? 0) +
    (variant.omittedSourceSegmentIds?.length ?? 0) +
    (variant.omittedSourcePathIds?.length ?? 0) +
    (variant.localNodeIds?.length ?? 0) +
    (variant.localSegmentIds?.length ?? 0) +
    (variant.localPathIds?.length ?? 0);
}

function updateVariantOperation(
  component: GeometryComponent,
  nextVariant: GeometryVariantLink,
): OperationInput {
  return {
    type: 'UPDATE_GEOMETRY_COMPONENT',
    payload: {
      componentId: component.id,
      updates: {
        variants: component.variants.map((variant) =>
          variant.id === nextVariant.id ? nextVariant : variant),
      },
    },
  };
}

function buildLocalTopologyLink(
  document: VectorDocument,
  sourceObject: NetworkObject,
  variant: GeometryVariantLink,
): GeometryVariantLink | null {
  const sourceNetwork = document.getNetwork(sourceObject.networkId);
  const targetObject = document.getObject(variant.objectId);
  const targetNetwork = targetObject ? document.getNetwork(targetObject.networkId) : undefined;
  if (!sourceNetwork || !targetNetwork) return null;
  const sourceSegments = segmentIdsForNetwork(document, sourceNetwork);
  const targetSegments = segmentIdsForNetwork(document, targetNetwork);
  const nodeMap = validTopologyMap(variant.nodeMap, sourceNetwork.nodeIds, targetNetwork.nodeIds);
  const segmentMap = validTopologyMap(variant.segmentMap, sourceSegments, targetSegments);
  const pathMap = validTopologyMap(variant.pathMap, sourceNetwork.pathIds, targetNetwork.pathIds);
  return {
    ...variant,
    nodeMap,
    segmentMap,
    pathMap,
    overriddenNodeIds: variant.overriddenNodeIds.filter((id) => id in nodeMap),
    overriddenSegmentIds: variant.overriddenSegmentIds.filter((id) => id in segmentMap),
    omittedSourceNodeIds: sourceNetwork.nodeIds.filter((id) => !(id in nodeMap)),
    omittedSourceSegmentIds: sourceSegments.filter((id) => !(id in segmentMap)),
    omittedSourcePathIds: sourceNetwork.pathIds.filter((id) => !(id in pathMap)),
    localNodeIds: targetNetwork.nodeIds.filter((id) => !Object.values(nodeMap).includes(id)),
    localSegmentIds: targetSegments.filter((id) => !Object.values(segmentMap).includes(id)),
    localPathIds: targetNetwork.pathIds.filter((id) => !Object.values(pathMap).includes(id)),
  };
}

function buildCompatibleTopologyLink(
  document: VectorDocument,
  sourceObject: NetworkObject,
  variant: GeometryVariantLink,
): GeometryVariantLink | null {
  const sourceNetwork = document.getNetwork(sourceObject.networkId);
  const targetObject = document.getObject(variant.objectId);
  const targetNetwork = targetObject ? document.getNetwork(targetObject.networkId) : undefined;
  if (!sourceNetwork || !targetNetwork) return null;
  const sourceSegments = segmentIdsForNetwork(document, sourceNetwork);
  const targetSegments = segmentIdsForNetwork(document, targetNetwork);
  const nodeMap = validTopologyMap(variant.nodeMap, sourceNetwork.nodeIds, targetNetwork.nodeIds);
  const segmentMap = validTopologyMap(variant.segmentMap, sourceSegments, targetSegments);
  const pathMap = validTopologyMap(variant.pathMap, sourceNetwork.pathIds, targetNetwork.pathIds);

  const freeSourceNodes = sourceNetwork.nodeIds.filter((id) => !(id in nodeMap));
  const mappedTargetNodes = new Set(Object.values(nodeMap));
  const freeTargetNodes = targetNetwork.nodeIds.filter((id) => !mappedTargetNodes.has(id));
  if (freeSourceNodes.length !== freeTargetNodes.length) return null;
  const remainingTargetNodes = new Set(freeTargetNodes);
  for (const sourceId of freeSourceNodes) {
    const source = document.getNode(sourceId);
    if (!source) return null;
    let bestTargetId: EntityId | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const targetId of remainingTargetNodes) {
      const target = document.getNode(targetId);
      if (!target) continue;
      const distance = (source.position.x - target.position.x) ** 2 +
        (source.position.y - target.position.y) ** 2;
      if (distance < bestDistance) {
        bestTargetId = targetId;
        bestDistance = distance;
      }
    }
    if (!bestTargetId) return null;
    nodeMap[sourceId] = bestTargetId;
    remainingTargetNodes.delete(bestTargetId);
  }

  const freeSourceSegments = sourceSegments.filter((id) => !(id in segmentMap));
  const mappedTargetSegments = new Set(Object.values(segmentMap));
  const remainingTargetSegments = new Set(targetSegments.filter((id) => !mappedTargetSegments.has(id)));
  if (freeSourceSegments.length !== remainingTargetSegments.size) return null;
  for (const sourceId of freeSourceSegments) {
    const source = document.getSegment(sourceId);
    if (!source) return null;
    const mappedStart = nodeMap[source.startNodeId];
    const mappedEnd = nodeMap[source.endNodeId];
    const targetId = [...remainingTargetSegments].find((candidateId) => {
      const candidate = document.getSegment(candidateId);
      if (!candidate || candidate.type !== source.type) return false;
      return (candidate.startNodeId === mappedStart && candidate.endNodeId === mappedEnd) ||
        (candidate.startNodeId === mappedEnd && candidate.endNodeId === mappedStart);
    });
    if (!targetId) return null;
    segmentMap[sourceId] = targetId;
    remainingTargetSegments.delete(targetId);
  }

  const freeSourcePaths = sourceNetwork.pathIds.filter((id) => !(id in pathMap));
  const mappedTargetPaths = new Set(Object.values(pathMap));
  const remainingTargetPaths = new Set(targetNetwork.pathIds.filter((id) => !mappedTargetPaths.has(id)));
  if (freeSourcePaths.length !== remainingTargetPaths.size) return null;
  for (const sourceId of freeSourcePaths) {
    const source = document.getPath(sourceId);
    if (!source) return null;
    const mappedSegments = new Set(source.segmentIds.map((id) => segmentMap[id]));
    const targetId = [...remainingTargetPaths].find((candidateId) => {
      const candidate = document.getPath(candidateId);
      if (!candidate || candidate.isClosed !== source.isClosed || candidate.segmentIds.length !== mappedSegments.size) {
        return false;
      }
      return candidate.segmentIds.every((id) => mappedSegments.has(id));
    });
    if (!targetId) return null;
    pathMap[sourceId] = targetId;
    remainingTargetPaths.delete(targetId);
  }

  if (
    Object.keys(nodeMap).length !== sourceNetwork.nodeIds.length ||
    Object.keys(segmentMap).length !== sourceSegments.length ||
    Object.keys(pathMap).length !== sourceNetwork.pathIds.length
  ) return null;
  return {
    ...variant,
    nodeMap,
    segmentMap,
    pathMap,
    overriddenNodeIds: variant.overriddenNodeIds.filter((id) => id in nodeMap),
    overriddenSegmentIds: variant.overriddenSegmentIds.filter((id) => id in segmentMap),
    omittedSourceNodeIds: [],
    omittedSourceSegmentIds: [],
    omittedSourcePathIds: [],
    localNodeIds: [],
    localSegmentIds: [],
    localPathIds: [],
  };
}

function validTopologyMap(
  map: Record<EntityId, EntityId>,
  sourceIds: EntityId[],
  targetIds: EntityId[],
): Record<EntityId, EntityId> {
  const source = new Set(sourceIds);
  const target = new Set(targetIds);
  const usedTargets = new Set<EntityId>();
  return Object.fromEntries(Object.entries(map).filter(([sourceId, targetId]) => {
    if (!source.has(sourceId) || !target.has(targetId) || usedTargets.has(targetId)) return false;
    usedTargets.add(targetId);
    return true;
  }));
}

function stableReplacementMap(
  sourceIds: EntityId[],
  currentMap: Record<EntityId, EntityId>,
  existingTargetIds: ReadonlySet<EntityId>,
): Record<EntityId, EntityId> {
  const used = new Set<EntityId>();
  return Object.fromEntries(sourceIds.map((sourceId) => {
    const current = currentMap[sourceId];
    const targetId = current && existingTargetIds.has(current) && !used.has(current)
      ? current
      : createEntityId();
    used.add(targetId);
    return [sourceId, targetId];
  }));
}

function segmentIdsForNetwork(document: VectorDocument, network: VectorNetwork): EntityId[] {
  return network.pathIds.flatMap((pathId) => document.getPath(pathId)?.segmentIds ?? []);
}

function nodeGeometryEqual(source: VectorNode, target: VectorNode): boolean {
  return source.position.x === target.position.x && source.position.y === target.position.y &&
    source.handleMode === target.handleMode &&
    pointEqual(source.handleIn, target.handleIn) && pointEqual(source.handleOut, target.handleOut);
}

function segmentGeometryEqual(
  source: Segment,
  target: Segment,
  variant: GeometryVariantLink,
): boolean {
  return source.type === target.type &&
    variant.nodeMap[source.startNodeId] === target.startNodeId &&
    variant.nodeMap[source.endNodeId] === target.endNodeId &&
    source.role === target.role &&
    source.constructionExtent === target.constructionExtent &&
    pointEqual(source.center, target.center) &&
    source.radius === target.radius &&
    source.startAngle === target.startAngle &&
    source.endAngle === target.endAngle &&
    source.clockwise === target.clockwise &&
    widthProfilesEqual(source.widthProfile, target.widthProfile);
}

function widthProfilesEqual(
  source: Segment['widthProfile'],
  target: Segment['widthProfile'],
): boolean {
  if ((source?.length ?? 0) !== (target?.length ?? 0)) return false;
  return (source ?? []).every((point, index) => {
    const candidate = target?.[index];
    return Boolean(candidate &&
      point.t === candidate.t &&
      point.width === candidate.width);
  });
}

function pointEqual(
  a: { x: number; y: number } | undefined,
  b: { x: number; y: number } | undefined,
): boolean {
  return a === b || Boolean(a && b && a.x === b.x && a.y === b.y);
}

function reverseMappedIds(
  map: Record<EntityId, EntityId>,
  targetIds: Iterable<EntityId>,
): EntityId[] {
  const targets = new Set(targetIds);
  return Object.entries(map)
    .filter(([, targetId]) => targets.has(targetId))
    .map(([sourceId]) => sourceId);
}

function updateOverrideIds(
  current: EntityId[],
  changed: EntityId[],
  overridden: boolean,
): EntityId[] {
  const next = new Set(current);
  for (const id of changed) {
    if (overridden) next.add(id);
    else next.delete(id);
  }
  return [...next];
}
