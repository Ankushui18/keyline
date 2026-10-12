import { createEntityId } from '../core/ids';
import { arcSweep, cubicSubcurve, pointKey, reverseCubic, segmentCurve } from '../core/geometry';
import { regionBoundaryLoops, regionContainsPoint } from '../core/region-geometry';
import { inverseMatrix, objectTransformMatrix, transformPoint } from '../core/transforms';
import {
  emptyGraphPatch,
  type GraphPatch,
  type OperationType,
  type ShapeBuilderPayload,
} from '../core/operations';
import type { VectorDocument } from '../core/document';
import type { EntityId, Point, Region, RegionBoundaryEdge, Segment, VectorNode, VectorPath } from '../core/types';

export interface ShapeBuilderResult {
  type: Extract<OperationType, 'MERGE_REGIONS' | 'EXTRACT_REGION' | 'SUBTRACT_REGION'>;
  payload: ShapeBuilderPayload;
  selectedRegionIds: EntityId[];
  resultPathIds: EntityId[];
}

export class ShapeBuilderPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShapeBuilderPlanError';
  }
}

function isArtworkRegion(document: VectorDocument, region: Region): boolean {
  return region.boundarySegmentIds.length > 0 && region.boundarySegmentIds.every((segmentId) =>
    document.getSegment(segmentId)?.role === 'geometry',
  );
}

export function regionAtPoint(document: VectorDocument, point: Point): Region | null {
  const candidates = document.regions.filter((region) => {
    if (!isArtworkRegion(document, region) || regionBoundaryLoops(region).length === 0 ||
      region.boundarySegmentIds.some((segmentId) => !document.isSegmentVisible(segmentId))) return false;
    const object = region.boundarySegmentIds[0]
      ? document.getObjectForSegment(region.boundarySegmentIds[0])
      : undefined;
    const inverse = object ? inverseMatrix(objectTransformMatrix(object.transform)) : undefined;
    const localPoint = inverse ? transformPoint(point, inverse) : point;
    return regionContainsPoint(region, localPoint);
  });
  candidates.sort((a, b) => (a.area ?? Number.POSITIVE_INFINITY) - (b.area ?? Number.POSITIVE_INFINITY));
  return candidates[0] ?? null;
}

export function buildShapeBuilderResult(
  document: VectorDocument,
  currentRegionIds: EntityId[],
  previousResultPathIds: EntityId[],
  clickedRegionId: EntityId,
  subtract: boolean,
): ShapeBuilderResult | null {
  const nextIds = subtract
    ? currentRegionIds.filter((id) => id !== clickedRegionId)
    : [...new Set([...currentRegionIds, clickedRegionId])];
  if (subtract && nextIds.length === currentRegionIds.length) return null;

  const regions = nextIds
    .map((id) => document.regions.find((region) => region.id === id))
    .filter((region): region is Region => Boolean(
      region?.boundaryEdges?.length && isArtworkRegion(document, region),
    ));
  if (regions.length !== nextIds.length) {
    throw new ShapeBuilderPlanError('Shape Builder selection contains a region that is no longer available.');
  }
  const clickedRegion = document.regions.find((region) => region.id === clickedRegionId);
  if (!clickedRegion?.boundaryEdges?.length || !isArtworkRegion(document, clickedRegion)) {
    throw new ShapeBuilderPlanError('Shape Builder requires a valid closed region.');
  }
  const networkId = resolveShapeBuilderNetwork(document, regions.length > 0 ? regions : [clickedRegion]);
  for (const pathId of previousResultPathIds) {
    const pathNetworkId = document.findNetworkForPath(pathId)?.id;
    if (pathNetworkId && pathNetworkId !== networkId) {
      throw new ShapeBuilderPlanError('Shape Builder requires regions from a single network.');
    }
  }
  const removePatch = graphRemovalPatchForPaths(document, previousResultPathIds);
  const addResult = materializeRegions(document, regions, networkId);
  const patch = mergePatches(removePatch, addResult.patch);
  const type = subtract
    ? 'SUBTRACT_REGION'
    : currentRegionIds.length === 0
      ? 'EXTRACT_REGION'
      : 'MERGE_REGIONS';
  const resultPathId = addResult.pathIds[0] ?? '';

  return {
    type,
    payload: {
      networkId,
      regionIds: nextIds,
      regionId: clickedRegionId,
      targetPathId: previousResultPathIds[0],
      resultPathId,
      resultPathIds: addResult.pathIds,
      patch,
    },
    selectedRegionIds: nextIds,
    resultPathIds: addResult.pathIds,
  };
}

export function resolveShapeBuilderNetwork(document: VectorDocument, regions: Region[]): EntityId {
  const networkIds = new Set<EntityId>();
  for (const region of regions) {
    if (!region.boundarySegmentIds.length) {
      throw new ShapeBuilderPlanError('Shape Builder requires a valid closed region.');
    }
    for (const segmentId of region.boundarySegmentIds) {
      const path = document.findPathForSegment(segmentId);
      const network = path ? document.findNetworkForPath(path.id) : undefined;
      if (!network) {
        throw new ShapeBuilderPlanError('Shape Builder could not resolve the region network.');
      }
      networkIds.add(network.id);
    }
  }
  if (networkIds.size !== 1) {
    throw new ShapeBuilderPlanError('Shape Builder requires regions from a single network.');
  }
  return [...networkIds][0];
}

export function materializeRegions(
  document: VectorDocument,
  regions: Region[],
  networkId: EntityId,
): { patch: GraphPatch; pathIds: EntityId[] } {
  const patch = emptyGraphPatch();
  if (regions.length === 0) return { patch, pathIds: [] };
  if (!document.getNetwork(networkId)) {
    throw new ShapeBuilderPlanError('Shape Builder could not resolve the target network.');
  }
  const pathIds: EntityId[] = [];
  const loops = unionBoundaryLoops(regions);

  for (const loop of loops) {
    if (loop.length < 2) continue;
    const nodes: VectorNode[] = loop.map((edge) => ({
      id: createEntityId(),
      position: { ...edge.start },
      constraintIds: [],
    }));
    const path: VectorPath = { id: createEntityId(), segmentIds: [], isClosed: true };
    const segments: Segment[] = [];

    loop.forEach((edge, index) => {
      const source = document.getSegment(edge.segmentId);
      if (!source) return;
      const startNode = nodes[index];
      const endNode = nodes[(index + 1) % nodes.length];
      if (source.type === 'bezier') {
        const sourceCurve = segmentCurve(document, source);
        if (sourceCurve) {
          let curve = cubicSubcurve(sourceCurve, edge.tStart, edge.tEnd);
          if (edge.reversed) curve = reverseCubic(curve);
          startNode.handleOut = { ...curve.p1 };
          endNode.handleIn = { ...curve.p2 };
        }
      }
      const arcGeometry = source.type === 'arc' && source.center
        ? {
            center: { ...source.center },
            radius: source.radius,
            startAngle: (source.startAngle ?? 0) + arcSweep(source) * (edge.reversed ? edge.tEnd : edge.tStart),
            endAngle: (source.startAngle ?? 0) + arcSweep(source) * (edge.reversed ? edge.tStart : edge.tEnd),
            clockwise: edge.reversed ? !source.clockwise : source.clockwise,
          }
        : {};
      segments.push({
        id: createEntityId(),
        startNodeId: startNode.id,
        endNodeId: endNode.id,
        type: source.type,
        role: source.role,
        constructionExtent: source.constructionExtent,
        ...arcGeometry,
      });
    });

    patch.addNodes.push(...nodes.map((node) => ({ node, networkId })));
    patch.addPaths.push({ path, networkId });
    patch.addSegments.push(...segments.map((segment, index) => ({ segment, pathId: path.id, index })));
    pathIds.push(path.id);
  }
  return { patch, pathIds };
}

export function unionBoundaryLoops(regions: Region[]): RegionBoundaryEdge[][] {
  const unmatched = new Map<string, RegionBoundaryEdge>();
  for (const region of regions) {
    for (const edge of region.boundaryEdges ?? []) {
      const key = fragmentKey(edge);
      if (unmatched.has(key)) unmatched.delete(key);
      else unmatched.set(key, cloneEdge(edge));
    }
  }

  const remaining = [...unmatched.values()];
  const byStart = new Map<string, RegionBoundaryEdge[]>();
  for (const edge of remaining) {
    const key = pointKey(edge.start);
    const list = byStart.get(key) ?? [];
    list.push(edge);
    byStart.set(key, list);
  }

  const used = new Set<RegionBoundaryEdge>();
  const loops: RegionBoundaryEdge[][] = [];
  for (const initial of remaining) {
    if (used.has(initial)) continue;
    const loop: RegionBoundaryEdge[] = [];
    let current: RegionBoundaryEdge | undefined = initial;
    for (let guard = 0; current && guard <= remaining.length; guard += 1) {
      if (used.has(current)) break;
      used.add(current);
      loop.push(current);
      const candidates: RegionBoundaryEdge[] = byStart.get(pointKey(current.end)) ?? [];
      current = candidates.find((candidate: RegionBoundaryEdge) => !used.has(candidate));
      if (!current && pointKey(loop.at(-1)!.end) === pointKey(loop[0].start)) break;
    }
    if (loop.length > 1 && pointKey(loop.at(-1)!.end) === pointKey(loop[0].start)) loops.push(loop);
  }
  return loops;
}

export function graphRemovalPatchForPaths(document: VectorDocument, pathIds: EntityId[]): GraphPatch {
  const patch = emptyGraphPatch();
  const targetPaths = pathIds
    .map((id) => document.getPath(id))
    .filter((path): path is VectorPath => Boolean(path));
  const removedSegmentIds = new Set(targetPaths.flatMap((path) => path.segmentIds));
  const possibleNodeIds = new Set<EntityId>();

  for (const path of targetPaths) {
    const network = document.findNetworkForPath(path.id);
    if (!network) continue;
    path.segmentIds.forEach((segmentId, index) => {
      const segment = document.getSegment(segmentId);
      if (!segment) return;
      patch.removeSegments.push({ segment: { ...segment }, pathId: path.id, index });
      possibleNodeIds.add(segment.startNodeId);
      possibleNodeIds.add(segment.endNodeId);
    });
    patch.removePaths.push({
      path: { ...path, segmentIds: [...path.segmentIds] },
      networkId: network.id,
      index: network.pathIds.indexOf(path.id),
    });
  }

  for (const nodeId of possibleNodeIds) {
    const stillUsed = [...document.segments.values()].some((segment) =>
      !removedSegmentIds.has(segment.id) && (segment.startNodeId === nodeId || segment.endNodeId === nodeId),
    );
    const node = document.getNode(nodeId);
    const network = document.networks.find((item) => item.nodeIds.includes(nodeId));
    if (!stillUsed && node && network) {
      patch.removeNodes.push({
        node: cloneNode(node),
        networkId: network.id,
        index: network.nodeIds.indexOf(nodeId),
      });
    }
  }
  return patch;
}

function mergePatches(first: GraphPatch, second: GraphPatch): GraphPatch {
  return {
    addNodes: [...first.addNodes, ...second.addNodes],
    addPaths: [...first.addPaths, ...second.addPaths],
    addSegments: [...first.addSegments, ...second.addSegments],
    removeSegments: [...first.removeSegments, ...second.removeSegments],
    removePaths: [...first.removePaths, ...second.removePaths],
    removeNodes: [...first.removeNodes, ...second.removeNodes],
  };
}

function fragmentKey(edge: RegionBoundaryEdge): string {
  const start = Math.round(Math.min(edge.tStart, edge.tEnd) * 1e6);
  const end = Math.round(Math.max(edge.tStart, edge.tEnd) * 1e6);
  return `${edge.segmentId}:${start}:${end}`;
}

function cloneEdge(edge: RegionBoundaryEdge): RegionBoundaryEdge {
  return { ...edge, start: { ...edge.start }, end: { ...edge.end } };
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
