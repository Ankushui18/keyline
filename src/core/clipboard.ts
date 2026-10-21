import { cloneFills } from './fills';
import { createEntityId } from './ids';
import type { VectorDocument } from './document';
import type { OperationInput } from './operations';
import { stableRegionId } from './regions';
import type {
  Appearance,
  Constraint,
  EntityId,
  FillStyle,
  LayerNode,
  NetworkObject,
  ParametricGroup,
  Point,
  Segment,
  VectorNetwork,
  VectorNode,
  VectorPath,
} from './types';

export const VECTOR_CLIPBOARD_PREFIX = 'VECTOR_STUDIO_OBJECTS_V2\n';
export const VECTOR_CLIPBOARD_V1_PREFIX = 'VECTOR_STUDIO_OBJECTS_V1\n';

export interface ClipboardObject {
  object: NetworkObject;
  layer: LayerNode;
  appearance: Appearance;
  network: VectorNetwork;
  nodes: VectorNode[];
  paths: VectorPath[];
  segments: Segment[];
}

export interface VectorClipboardPayload {
  kind: 'vector-studio/objects';
  version: 2;
  intent: 'copy' | 'cut';
  objects: ClipboardObject[];
  constraints: Constraint[];
  parametricGroups: ParametricGroup[];
  regionFills: Array<{ boundarySegmentIds: EntityId[]; fill: FillStyle }>;
}

interface LegacyVectorClipboardPayload extends Omit<VectorClipboardPayload, 'version' | 'objects'> {
  version: 1;
  objects: Array<Omit<ClipboardObject, 'segments'> & {
    segments: Array<Omit<Segment, 'role' | 'constructionExtent'> &
      Partial<Pick<Segment, 'role' | 'constructionExtent'>>>;
  }>;
}

export interface PasteObjectsPlan {
  operations: OperationInput[];
  objectIds: EntityId[];
  layerIds: EntityId[];
}

/** Captures only the selected authoritative graph data; unrelated document art never enters the clipboard. */
export function createVectorClipboardPayload(
  document: VectorDocument,
  objectIds: Iterable<EntityId>,
  intent: 'copy' | 'cut' = 'copy',
): VectorClipboardPayload | null {
  const objects: ClipboardObject[] = [];
  const topologyIds = new Set<EntityId>();
  const pathIds = new Set<EntityId>();
  const segmentIds = new Set<EntityId>();

  for (const objectId of new Set(objectIds)) {
    const object = document.getObject(objectId);
    const network = object ? document.getNetwork(object.networkId) : undefined;
    const layer = object ? document.getLayerForObject(object.id) : undefined;
    const appearance = object ? document.getAppearance(object.appearanceId) : undefined;
    if (!object || !network || !layer || !appearance) continue;
    const nodes = network.nodeIds
      .map((id) => document.getNode(id))
      .filter((node): node is VectorNode => Boolean(node))
      .map(cloneNode);
    const paths = network.pathIds
      .map((id) => document.getPath(id))
      .filter((path): path is VectorPath => Boolean(path))
      .map(clonePath);
    const segments = paths.flatMap((path) => path.segmentIds
      .map((id) => document.getSegment(id))
      .filter((segment): segment is Segment => Boolean(segment))
      .map(cloneSegment));
    nodes.forEach((node) => topologyIds.add(node.id));
    paths.forEach((path) => { topologyIds.add(path.id); pathIds.add(path.id); });
    segments.forEach((segment) => { topologyIds.add(segment.id); segmentIds.add(segment.id); });
    objects.push({
      object: cloneObject(object),
      layer: cloneLayer(layer),
      appearance: cloneAppearance(appearance),
      network: cloneNetwork(network),
      nodes,
      paths,
      segments,
    });
  }
  if (objects.length === 0) return null;

  const constraints = [...document.constraints.values()]
    .filter((constraint) => constraint.targetIds.every((id) => topologyIds.has(id)))
    .map(cloneConstraint);
  const parametricGroups = [...document.parametricGroups.values()]
    .filter((group) => group.sourcePathIds.every((id) => pathIds.has(id)))
    .filter((group) => group.transform.type === 'mirror'
      ? !group.transform.axisSegmentId || segmentIds.has(group.transform.axisSegmentId)
      : !group.transform.centerNodeId || topologyIds.has(group.transform.centerNodeId))
    .map(cloneParametricGroup);
  const regionFills = document.regions
    .filter((region) => region.fill && region.boundarySegmentIds.every((id) =>
      segmentIds.has(id) && document.getSegment(id)?.role === 'geometry'))
    .map((region) => ({
      boundarySegmentIds: [...region.boundarySegmentIds],
      fill: { ...region.fill! },
    }));

  return { kind: 'vector-studio/objects', version: 2, intent, objects, constraints, parametricGroups, regionFills };
}

/** Builds an ID-safe, transaction-ready paste plan for the current artboard. */
export function preparePasteObjects(
  document: VectorDocument,
  payload: VectorClipboardPayload,
  options: { offset?: Point; preserveNames?: boolean } = {},
): PasteObjectsPlan | null {
  if (!isVectorClipboardPayload(payload) || payload.objects.length === 0) return null;
  const offset = options.offset ?? { x: 16, y: 16 };
  const objectIds = new Map<EntityId, EntityId>();
  const layerIds = new Map<EntityId, EntityId>();
  const appearanceIds = new Map<EntityId, EntityId>();
  const networkIds = new Map<EntityId, EntityId>();
  const nodeIds = new Map<EntityId, EntityId>();
  const pathIds = new Map<EntityId, EntityId>();
  const segmentIds = new Map<EntityId, EntityId>();
  const operations: OperationInput[] = [];
  const addedAppearanceIds = new Set<EntityId>();
  const usedNames = new Set([...document.objects.values()].map((object) => object.name));
  const baseLayerIndex = document.activeArtboard.layerIds.length;

  payload.objects.forEach((item) => {
    objectIds.set(item.object.id, createEntityId());
    layerIds.set(item.layer.id, createEntityId());
    if (!appearanceIds.has(item.appearance.id)) appearanceIds.set(item.appearance.id, createEntityId());
    networkIds.set(item.network.id, createEntityId());
    item.nodes.forEach((node) => nodeIds.set(node.id, createEntityId()));
    item.paths.forEach((path) => pathIds.set(path.id, createEntityId()));
    item.segments.forEach((segment) => segmentIds.set(segment.id, createEntityId()));
  });

  payload.objects.forEach((item, objectIndex) => {
    const networkId = networkIds.get(item.network.id)!;
    const appearanceId = appearanceIds.get(item.appearance.id)!;
    const objectId = objectIds.get(item.object.id)!;
    const layerId = layerIds.get(item.layer.id)!;
    const name = options.preserveNames
      ? uniqueName(item.object.name, usedNames)
      : duplicateName(item.object.name, usedNames);
    usedNames.add(name);

    operations.push({ type: 'ADD_NETWORK', payload: { network: { id: networkId, nodeIds: [], pathIds: [] } } });
    if (!addedAppearanceIds.has(appearanceId)) {
      operations.push({
        type: 'ADD_APPEARANCE',
        payload: { appearance: { ...cloneAppearance(item.appearance), id: appearanceId } },
      });
      addedAppearanceIds.add(appearanceId);
    }
    operations.push({
      type: 'ADD_OBJECT',
      payload: {
        object: {
          ...cloneObject(item.object),
          id: objectId,
          name,
          networkId,
          appearanceId,
          appearanceRuleId: item.object.appearanceRuleId && document.getAppearanceRule(item.object.appearanceRuleId)
            ? item.object.appearanceRuleId
            : undefined,
          transform: {
            ...item.object.transform,
            x: item.object.transform.x + offset.x,
            y: item.object.transform.y + offset.y,
          },
        },
      },
    });
    operations.push({
      type: 'ADD_LAYER',
      payload: {
        layer: {
          ...cloneLayer(item.layer),
          id: layerId,
          kind: 'object',
          name,
          artboardId: document.activeArtboardId,
          parentId: undefined,
          childIds: [],
          objectId,
        },
        index: baseLayerIndex + objectIndex,
      },
    });
    item.nodes.forEach((node) => operations.push({
      type: 'ADD_NODE',
      payload: {
        node: {
          ...cloneNode(node),
          id: nodeIds.get(node.id)!,
          constraintIds: [],
        },
        networkId,
      },
    }));
    item.paths.forEach((path) => {
      const pathId = pathIds.get(path.id)!;
      operations.push({
        type: 'ADD_PATH',
        payload: { path: { ...clonePath(path), id: pathId, segmentIds: [] }, networkId },
      });
      path.segmentIds.forEach((sourceSegmentId) => {
        const segment = item.segments.find((candidate) => candidate.id === sourceSegmentId);
        if (!segment) return;
        operations.push({
          type: 'ADD_SEGMENT',
          payload: {
            segment: {
              ...cloneSegment(segment),
              id: segmentIds.get(segment.id)!,
              startNodeId: nodeIds.get(segment.startNodeId)!,
              endNodeId: nodeIds.get(segment.endNodeId)!,
              widthProfile: segment.widthProfile?.map((point) => ({ ...point, id: createEntityId() })),
            },
            pathId,
          },
        });
      });
    });
  });

  const mappedTopologyIds = new Map<EntityId, EntityId>([...nodeIds, ...segmentIds, ...pathIds]);
  payload.constraints.forEach((constraint) => {
    if (!constraint.targetIds.every((id) => mappedTopologyIds.has(id))) return;
    operations.push({
      type: 'ADD_CONSTRAINT',
      payload: {
        constraint: {
          ...cloneConstraint(constraint),
          id: createEntityId(),
          targetIds: constraint.targetIds.map((id) => mappedTopologyIds.get(id)!),
        },
      },
    });
  });
  payload.parametricGroups.forEach((group) => {
    if (!group.sourcePathIds.every((id) => pathIds.has(id))) return;
    operations.push({
      type: 'ADD_PARAMETRIC_GROUP',
      payload: {
        group: {
          ...cloneParametricGroup(group),
          id: createEntityId(),
          sourcePathIds: group.sourcePathIds.map((id) => pathIds.get(id)!),
          transform: group.transform.type === 'mirror'
            ? {
                ...group.transform,
                origin: { ...group.transform.origin },
                axisSegmentId: group.transform.axisSegmentId
                  ? segmentIds.get(group.transform.axisSegmentId)
                  : undefined,
              }
            : {
                ...group.transform,
                center: { ...group.transform.center },
                centerNodeId: group.transform.centerNodeId
                  ? nodeIds.get(group.transform.centerNodeId)
                  : undefined,
              },
        },
      },
    });
  });
  const sourceSegments = new Map(payload.objects.flatMap((item) =>
    item.segments.map((segment) => [segment.id, segment] as const)));
  payload.regionFills.forEach((region) => {
    if (!region.boundarySegmentIds.every((id) =>
      segmentIds.has(id) && sourceSegments.get(id)?.role === 'geometry')) return;
    const mappedSegmentIds = region.boundarySegmentIds.map((id) => segmentIds.get(id)!);
    operations.push({
      type: 'SET_REGION_FILL',
      payload: { regionId: stableRegionId(mappedSegmentIds), fill: { ...region.fill } },
    });
  });

  return {
    operations,
    objectIds: [...objectIds.values()],
    layerIds: [...layerIds.values()],
  };
}

export function serializeVectorClipboard(payload: VectorClipboardPayload): string {
  return `${VECTOR_CLIPBOARD_PREFIX}${JSON.stringify(payload)}`;
}

export function parseVectorClipboard(text: string): VectorClipboardPayload | null {
  const version = text.startsWith(VECTOR_CLIPBOARD_PREFIX)
    ? 2
    : text.startsWith(VECTOR_CLIPBOARD_V1_PREFIX)
      ? 1
      : undefined;
  if (!version) return null;
  const prefix = version === 2 ? VECTOR_CLIPBOARD_PREFIX : VECTOR_CLIPBOARD_V1_PREFIX;
  try {
    const value: unknown = JSON.parse(text.slice(prefix.length));
    if (version === 2) return isVectorClipboardPayload(value) ? value : null;
    return isLegacyVectorClipboardPayload(value) ? migrateLegacyClipboardPayload(value) : null;
  } catch {
    return null;
  }
}

export function isVectorClipboardPayload(value: unknown): value is VectorClipboardPayload {
  if (!hasClipboardEnvelope(value, 2)) return false;
  const candidate = value as VectorClipboardPayload;
  return candidate.objects.every((item) => isClipboardObject(item) && item.segments.every((segment) =>
    segment.role === 'geometry'
      ? segment.constructionExtent === undefined
      : segment.role === 'construction' && segment.type === 'line' &&
        (segment.constructionExtent === 'finite' || segment.constructionExtent === 'infinite') &&
        !segment.widthProfile?.length));
}

function isLegacyVectorClipboardPayload(value: unknown): value is LegacyVectorClipboardPayload {
  if (!hasClipboardEnvelope(value, 1)) return false;
  return (value as LegacyVectorClipboardPayload).objects.every(isClipboardObject);
}

function hasClipboardEnvelope(value: unknown, version: 1 | 2): boolean {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<VectorClipboardPayload | LegacyVectorClipboardPayload>;
  return candidate.kind === 'vector-studio/objects' && candidate.version === version &&
    (candidate.intent === 'copy' || candidate.intent === 'cut') && Array.isArray(candidate.objects) &&
    Array.isArray(candidate.constraints) && Array.isArray(candidate.parametricGroups) &&
    Array.isArray(candidate.regionFills);
}

function isClipboardObject(value: unknown): value is ClipboardObject {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ClipboardObject>;
  return Boolean(candidate.object && candidate.layer && candidate.appearance && candidate.network) &&
    Array.isArray(candidate.nodes) && Array.isArray(candidate.paths) && Array.isArray(candidate.segments);
}

function migrateLegacyClipboardPayload(payload: LegacyVectorClipboardPayload): VectorClipboardPayload {
  return {
    ...payload,
    version: 2,
    objects: payload.objects.map((item) => ({
      ...item,
      segments: item.segments.map((segment) => cloneSegment({
        ...segment,
        role: 'geometry',
        constructionExtent: undefined,
      } as Segment)),
    })),
  };
}

function duplicateName(name: string, usedNames: Set<string>): string {
  const baseMatch = name.match(/^(.*) copy(?: (\d+))?$/i);
  const base = baseMatch ? baseMatch[1] : name;
  let candidate = `${base} copy`;
  let index = 2;
  while (usedNames.has(candidate)) candidate = `${base} copy ${index++}`;
  return candidate;
}

function uniqueName(name: string, usedNames: Set<string>): string {
  if (!usedNames.has(name)) return name;
  let index = 2;
  let candidate = `${name} ${index}`;
  while (usedNames.has(candidate)) candidate = `${name} ${++index}`;
  return candidate;
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

function cloneSegment(segment: Segment): Segment {
  return {
    ...segment,
    center: segment.center ? { ...segment.center } : undefined,
    widthProfile: segment.widthProfile?.map((point) => ({ ...point })),
  };
}

function clonePath(path: VectorPath): VectorPath {
  return { ...path, segmentIds: [...path.segmentIds] };
}

function cloneNetwork(network: VectorNetwork): VectorNetwork {
  return { ...network, nodeIds: [...network.nodeIds], pathIds: [...network.pathIds] };
}

function cloneObject(object: NetworkObject): NetworkObject {
  return { ...object, transform: { ...object.transform } };
}

function cloneLayer(layer: LayerNode): LayerNode {
  return { ...layer, childIds: [...layer.childIds] };
}

function cloneAppearance(appearance: Appearance): Appearance {
  return {
    ...appearance,
    fills: cloneFills(appearance.fills),
    stroke: appearance.stroke ? { ...appearance.stroke, dash: [...appearance.stroke.dash] } : undefined,
  };
}

function cloneConstraint(constraint: Constraint): Constraint {
  return {
    ...constraint,
    targetIds: [...constraint.targetIds],
    parameters: constraint.parameters ? { ...constraint.parameters } : undefined,
  };
}

function cloneParametricGroup(group: ParametricGroup): ParametricGroup {
  return {
    ...group,
    sourcePathIds: [...group.sourcePathIds],
    transform: group.transform.type === 'mirror'
      ? { ...group.transform, origin: { ...group.transform.origin } }
      : { ...group.transform, center: { ...group.transform.center } },
  };
}
