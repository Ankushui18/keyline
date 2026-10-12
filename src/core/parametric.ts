import type { VectorDocument } from './document';
import {
  IDENTITY_MATRIX,
  inverseMatrix,
  multiplyMatrices,
  objectTransformMatrix,
  reflectionMatrix,
  rotationMatrix,
  transformPoint,
  type Matrix2D,
} from './transforms';
import type { EntityId, ParametricGroup, Point, Region } from './types';

export type ResolvedParametricTransform =
  | { type: 'mirror'; origin: Point; angle: number; referenced: boolean }
  | {
      type: 'radial';
      center: Point;
      count: number;
      sweepAngle: number;
      startAngle: number;
      clockwise: boolean;
      referenced: boolean;
    };

export interface ParametricGroupValidation {
  valid: boolean;
  message?: string;
  sourceNetworkId?: EntityId;
}

export function validateParametricGroup(
  document: VectorDocument,
  group: ParametricGroup,
): ParametricGroupValidation {
  if (group.sourcePathIds.length === 0) {
    return { valid: false, message: 'Parametric Group requires at least one source path.' };
  }
  const sourceNetworks = new Set<EntityId>();
  for (const pathId of group.sourcePathIds) {
    const path = document.getPath(pathId);
    if (!path) return { valid: false, message: `Parametric Group source path ${pathId} does not exist.` };
    if (path.segmentIds.some((segmentId) => document.getSegment(segmentId)?.role === 'construction')) {
      return { valid: false, message: 'Construction paths cannot be used as Parametric Group sources.' };
    }
    const network = document.findNetworkForPath(pathId);
    if (!network) return { valid: false, message: `Parametric Group source path ${pathId} has no owning network.` };
    sourceNetworks.add(network.id);
  }
  if (sourceNetworks.size !== 1) {
    return { valid: false, message: 'Parametric Group source paths must belong to one compatible network.' };
  }
  const sourceNetworkId = [...sourceNetworks][0];
  const sourceObject = objectForNetwork(document, sourceNetworkId);

  if (group.transform.type === 'mirror') {
    const angle = group.transform.angle ?? (group.transform.axis === 'x' ? 0 : 90);
    if (!finitePoint(group.transform.origin) || !Number.isFinite(angle)) {
      return { valid: false, message: 'Mirror requires a finite origin and angle.' };
    }
    if (group.transform.axisSegmentId) {
      const segment = document.getSegment(group.transform.axisSegmentId);
      if (!segment) {
        return { valid: false, message: `Mirror reference ${group.transform.axisSegmentId} is broken.` };
      }
      if (segment.role !== 'construction' || segment.type !== 'line') {
        return { valid: false, message: 'Mirror reference must be a straight construction segment.' };
      }
      const start = document.getNode(segment.startNodeId)?.position;
      const end = document.getNode(segment.endNodeId)?.position;
      if (!start || !end || !finitePoint(start) || !finitePoint(end) ||
        Math.hypot(end.x - start.x, end.y - start.y) < 1e-9) {
        return { valid: false, message: 'Mirror reference is broken or has a degenerate axis.' };
      }
      const referenceObject = document.getObjectForSegment(segment.id);
      if (!compatibleArtboards(document, sourceObject?.id, referenceObject?.id)) {
        return { valid: false, message: 'Mirror reference must share the source object artboard.' };
      }
    }
  } else {
    if (!finitePoint(group.transform.center) || !Number.isFinite(group.transform.count) ||
      !Number.isFinite(group.transform.sweepAngle) ||
      (group.transform.startAngle !== undefined && !Number.isFinite(group.transform.startAngle))) {
      return { valid: false, message: 'Radial Repeat requires finite center, count, sweep, and start values.' };
    }
    if (group.transform.count < 2 || group.transform.count > 64) {
      return { valid: false, message: 'Radial Repeat count must be between 2 and 64.' };
    }
    if (group.transform.centerNodeId) {
      const node = document.getNode(group.transform.centerNodeId);
      if (!node) {
        return { valid: false, message: `Radial center reference ${group.transform.centerNodeId} is broken.` };
      }
      const constructionOwner = document.connectedSegments(node.id)
        .find((segment) => segment.role === 'construction');
      if (!constructionOwner) {
        return { valid: false, message: 'Radial center reference must be a construction anchor node.' };
      }
      const referenceObject = document.getObjectForNode(node.id);
      if (!compatibleArtboards(document, sourceObject?.id, referenceObject?.id)) {
        return { valid: false, message: 'Radial center reference must share the source object artboard.' };
      }
    }
  }
  return { valid: true, sourceNetworkId };
}

export function assertValidParametricGroup(document: VectorDocument, group: ParametricGroup): void {
  const validation = validateParametricGroup(document, group);
  if (!validation.valid) throw new Error(validation.message);
}

/** Resolves live references into the source network's local coordinate space. */
export function resolveParametricTransform(
  document: VectorDocument,
  group: ParametricGroup,
): ResolvedParametricTransform | undefined {
  const validation = validateParametricGroup(document, group);
  if (!validation.valid || !validation.sourceNetworkId) return undefined;
  const sourceObject = objectForNetwork(document, validation.sourceNetworkId);
  const sourceInverse = sourceObject
    ? inverseMatrix(objectTransformMatrix(sourceObject.transform))
    : IDENTITY_MATRIX;
  if (!sourceInverse) return undefined;

  if (group.transform.type === 'mirror') {
    if (!group.transform.axisSegmentId) {
      return {
        type: 'mirror',
        origin: { ...group.transform.origin },
        angle: (group.transform.angle ?? (group.transform.axis === 'x' ? 0 : 90)) * Math.PI / 180,
        referenced: false,
      };
    }
    const segment = document.getSegment(group.transform.axisSegmentId);
    if (!segment) return undefined;
    const startNode = document.getNode(segment.startNodeId);
    const endNode = document.getNode(segment.endNodeId);
    if (!startNode || !endNode) return undefined;
    const referenceObject = document.getObjectForSegment(segment.id);
    const referenceMatrix = referenceObject
      ? objectTransformMatrix(referenceObject.transform)
      : IDENTITY_MATRIX;
    const start = transformPoint(transformPoint(startNode.position, referenceMatrix), sourceInverse);
    const end = transformPoint(transformPoint(endNode.position, referenceMatrix), sourceInverse);
    if (Math.hypot(end.x - start.x, end.y - start.y) < 1e-9) return undefined;
    return {
      type: 'mirror',
      origin: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 },
      angle: Math.atan2(end.y - start.y, end.x - start.x),
      referenced: true,
    };
  }

  let center = { ...group.transform.center };
  if (group.transform.centerNodeId) {
    const node = document.getNode(group.transform.centerNodeId);
    if (!node) return undefined;
    const referenceObject = document.getObjectForNode(node.id);
    const referenceMatrix = referenceObject
      ? objectTransformMatrix(referenceObject.transform)
      : IDENTITY_MATRIX;
    center = transformPoint(transformPoint(node.position, referenceMatrix), sourceInverse);
  }
  return {
    type: 'radial',
    center,
    count: Math.min(64, Math.max(2, Math.round(group.transform.count))),
    sweepAngle: group.transform.sweepAngle,
    startAngle: group.transform.startAngle ?? 0,
    clockwise: group.transform.clockwise ?? true,
    referenced: Boolean(group.transform.centerNodeId),
  };
}

export function parametricInstanceMatrices(
  document: VectorDocument,
  group: ParametricGroup,
): Matrix2D[] {
  const transform = resolveParametricTransform(document, group);
  if (!transform) return [];
  if (transform.type === 'mirror') return [reflectionMatrix(transform.angle, transform.origin)];
  const direction = transform.clockwise ? 1 : -1;
  const matrices: Matrix2D[] = [];
  for (let index = 1; index < transform.count; index += 1) {
    const angle = (transform.startAngle + direction * transform.sweepAngle * index / transform.count) * Math.PI / 180;
    matrices.push(rotationMatrix(angle, transform.center));
  }
  return matrices;
}

export function parametricSourceObjectId(
  document: VectorDocument,
  group: ParametricGroup,
): EntityId | undefined {
  const path = document.getPath(group.sourcePathIds[0]);
  const network = path ? document.findNetworkForPath(path.id) : undefined;
  return network ? objectForNetwork(document, network.id)?.id : undefined;
}

export function parametricGroupsForRegion(
  document: VectorDocument,
  region: Region,
): ParametricGroup[] {
  const boundaryPathIds = new Set(region.boundarySegmentIds
    .map((segmentId) => document.findPathForSegment(segmentId)?.id)
    .filter((pathId): pathId is EntityId => Boolean(pathId)));
  return [...document.parametricGroups.values()].filter((group) =>
    boundaryPathIds.size > 0 &&
    [...boundaryPathIds].every((pathId) => group.sourcePathIds.includes(pathId)) &&
    parametricInstanceMatrices(document, group).length > 0);
}

export function parametricDocumentMatrices(
  document: VectorDocument,
  group: ParametricGroup,
): Matrix2D[] {
  const objectId = parametricSourceObjectId(document, group);
  const object = objectId ? document.getObject(objectId) : undefined;
  const objectMatrix = object ? objectTransformMatrix(object.transform) : IDENTITY_MATRIX;
  return parametricInstanceMatrices(document, group).map((matrix) => multiplyMatrices(objectMatrix, matrix));
}

function objectForNetwork(document: VectorDocument, networkId: EntityId) {
  return [...document.objects.values()].find((object) => object.networkId === networkId);
}

function compatibleArtboards(
  document: VectorDocument,
  sourceObjectId: EntityId | undefined,
  referenceObjectId: EntityId | undefined,
): boolean {
  if (!sourceObjectId || !referenceObjectId) return sourceObjectId === referenceObjectId;
  return document.getLayerForObject(sourceObjectId)?.artboardId === document.getLayerForObject(referenceObjectId)?.artboardId;
}

function finitePoint(point: Point): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}
