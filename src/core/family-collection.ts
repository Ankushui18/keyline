import type { VectorDocument } from './document';
import { auditGeometryComponent, type FamilyQaCategory, type FamilyQaReport } from './family-qa';
import { previewGeometryPropagation } from './geometry-components';
import { ARTWORK_BOUNDS_POLICY, objectBounds } from './object-geometry';
import type { EntityId, NetworkObject } from './types';

export type FamilyDeliveryStatus = 'blocked' | 'review' | 'ready';

export interface FamilyCollectionEntry {
  componentId: EntityId;
  name: string;
  sourceObjectId: EntityId;
  sourceName: string;
  memberNames: string[];
  locations: string[];
  memberCount: number;
  variantCount: number;
  status: FamilyDeliveryStatus;
  report: FamilyQaReport;
  pendingVariantCount: number;
  overriddenVariantCount: number;
  issueCategories: FamilyQaCategory[];
  lastQaCheckedAt?: number;
}

export interface UnlinkedAssetEntry {
  objectId: EntityId;
  name: string;
  artboardName: string;
  layerName: string;
  locked: boolean;
  hidden: boolean;
  width: number;
  height: number;
}

export interface FamilyCollectionReport {
  families: FamilyCollectionEntry[];
  unlinkedAssets: UnlinkedAssetEntry[];
  blockedCount: number;
  reviewCount: number;
  readyCount: number;
  issueCount: number;
}

/** Builds a live library-level preflight without mutating or caching document state. */
export function analyzeFamilyCollection(document: VectorDocument): FamilyCollectionReport {
  const families = [...document.geometryComponents.values()].flatMap((component) => {
    const report = auditGeometryComponent(document, component.id);
    const preview = previewGeometryPropagation(document, component.id);
    if (!report || !preview) return [];
    const pendingVariantCount = preview.variants.filter((variant) =>
      variant.state !== 'conflicting' &&
      variant.changedNodeCount + variant.changedSegmentCount + variant.changedPathCount > 0).length;
    const overriddenVariantCount = preview.variants.filter((variant) =>
      variant.state === 'overridden').length;
    const status: FamilyDeliveryStatus = report.errorCount > 0
      ? 'blocked'
      : report.warningCount > 0 || pendingVariantCount > 0
        ? 'review'
        : 'ready';
    const memberIds = [component.sourceObjectId, ...component.variants.map((variant) => variant.objectId)];
    const members = memberIds
      .map((objectId) => document.getObject(objectId))
      .filter((object): object is NetworkObject => Boolean(object));
    return [{
      componentId: component.id,
      name: component.name,
      sourceObjectId: component.sourceObjectId,
      sourceName: report.sourceObject.name,
      memberNames: members.map((member) => member.name),
      locations: [...new Set(members.map((member) => objectLocation(document, member.id)))],
      memberCount: report.memberCount,
      variantCount: component.variants.length,
      status,
      report,
      pendingVariantCount,
      overriddenVariantCount,
      issueCategories: [...new Set(report.issues.map((issue) => issue.category))],
      lastQaCheckedAt: component.lastQa?.checkedAt,
    } satisfies FamilyCollectionEntry];
  }).sort((a, b) => statusRank(a.status) - statusRank(b.status) || a.name.localeCompare(b.name));

  const linkedObjectIds = new Set<EntityId>(families.flatMap((family) => [
    family.sourceObjectId,
    ...document.getGeometryComponent(family.componentId)!.variants.map((variant) => variant.objectId),
  ]));
  const unlinkedAssets = [...document.objects.values()]
    .filter((object) => !linkedObjectIds.has(object.id) && hasProductionGeometry(document, object))
    .map((object) => {
      const layer = document.getLayerForObject(object.id);
      const artboard = layer ? document.getArtboard(layer.artboardId) : undefined;
      const bounds = objectBounds(document, object.id, ARTWORK_BOUNDS_POLICY);
      return {
        objectId: object.id,
        name: object.name,
        artboardName: artboard?.isCanvasRoot ? 'Canvas' : artboard?.name ?? 'Unknown frame',
        layerName: layer?.name ?? object.name,
        locked: document.isObjectLocked(object.id),
        hidden: !document.isObjectVisible(object.id),
        width: bounds.width,
        height: bounds.height,
      } satisfies UnlinkedAssetEntry;
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    families,
    unlinkedAssets,
    blockedCount: families.filter((family) => family.status === 'blocked').length,
    reviewCount: families.filter((family) => family.status === 'review').length,
    readyCount: families.filter((family) => family.status === 'ready').length,
    issueCount: families.reduce((sum, family) => sum + family.report.issues.length, 0),
  };
}

function hasProductionGeometry(document: VectorDocument, object: NetworkObject): boolean {
  const network = document.getNetwork(object.networkId);
  return Boolean(network?.pathIds.some((pathId) =>
    document.getPath(pathId)?.segmentIds.some((segmentId) =>
      document.getSegment(segmentId)?.role === 'geometry')));
}

function objectLocation(document: VectorDocument, objectId: EntityId): string {
  const layer = document.getLayerForObject(objectId);
  const artboard = layer ? document.getArtboard(layer.artboardId) : undefined;
  return artboard?.isCanvasRoot ? 'Canvas' : artboard?.name ?? 'Unknown frame';
}

function statusRank(status: FamilyDeliveryStatus): number {
  return status === 'blocked' ? 0 : status === 'review' ? 1 : 2;
}
