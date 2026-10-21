import { cloneFills } from './fills';
import { createEntityId } from './ids';
import { stableRegionId } from './regions';
import { isUnusedStarterArtboard } from './real-content';
import type { VectorDocument } from './document';
import type { OperationInput, OperationManager } from './operations';
import { prepareDeleteObject } from './object-operations';
import type {
  Appearance,
  Artboard,
  EntityId,
  LayerNode,
  NetworkObject,
  Segment,
  VectorNode,
} from './types';
import {
  DEFAULT_ARTBOARD_BACKGROUND,
  DEFAULT_STROKE_COLOR,
  DEFAULT_STROKE_WIDTH,
  STARTER_ARTBOARD_BACKGROUND,
} from '../design-system/document-defaults';

const ARTBOARD_GAP = 40;

export interface CreateIconArtboardPlan {
  artboard: Artboard;
  operations: OperationInput[];
}

export interface DuplicateArtboardPlan extends CreateIconArtboardPlan {
  objectIds: EntityId[];
  layerIds: EntityId[];
}

/** Builds a blank, immediately drawable icon artboard without introducing a new document model. */
export function prepareCreateIconArtboard(
  document: VectorDocument,
  width: number,
  height: number,
  options: { name?: string } = {},
): CreateIconArtboardPlan {
  assertDimensions(width, height);
  const page = document.activePage;
  const starter = document.activeArtboard;
  // First icon start adopts the existing empty starter instead of leaving a second, oversized board behind.
  if (document.pages.length === 1 && page.artboardIds.length === 1 && isUnusedStarterArtboard(document, starter)) {
    const artboard: Artboard = {
      ...starter,
      name: nextFrameName(document, width, height, options.name),
      frame: { x: 0, y: 0, width, height },
    };
    return {
      artboard,
      operations: [
        { type: 'UPDATE_ARTBOARD', payload: { artboardId: starter.id, updates: { name: artboard.name, frame: artboard.frame } } },
        { type: 'SET_ACTIVE_LOCATION', payload: { pageId: page.id, artboardId: starter.id } },
      ],
    };
  }
  const artboardId = createEntityId();
  const networkId = createEntityId();
  const appearanceId = createEntityId();
  const objectId = createEntityId();
  const layerId = createEntityId();
  const frame = nextAvailableFrame(document, page.id, width, height, document.activeArtboard.frame.y);
  const artboard: Artboard = {
    id: artboardId,
    pageId: page.id,
    name: nextFrameName(document, width, height, options.name),
    frame,
    layerIds: [],
    background: DEFAULT_ARTBOARD_BACKGROUND,
    clipContent: false,
  };
  const appearance: Appearance = {
    id: appearanceId,
    fills: [],
    stroke: {
      color: DEFAULT_STROKE_COLOR, width: DEFAULT_STROKE_WIDTH, cap: 'round', join: 'round', alignment: 'center',
      opacity: 1, dash: [], visible: true,
    },
    opacity: 1,
  };
  const object: NetworkObject = {
    id: objectId,
    name: 'Vector Network 1',
    networkId,
    appearanceId,
    transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
  };
  const layer: LayerNode = {
    id: layerId,
    kind: 'object',
    name: 'Vector Network 1',
    artboardId,
    childIds: [],
    objectId,
    visible: true,
    locked: false,
    expanded: true,
  };
  return {
    artboard,
    operations: [
      { type: 'ADD_ARTBOARD', payload: { artboard, pageId: page.id } },
      { type: 'ADD_NETWORK', payload: { network: { id: networkId, nodeIds: [], pathIds: [] } } },
      { type: 'ADD_APPEARANCE', payload: { appearance } },
      { type: 'ADD_OBJECT', payload: { object } },
      { type: 'ADD_LAYER', payload: { layer } },
      { type: 'SET_ACTIVE_LOCATION', payload: { pageId: page.id, artboardId } },
    ],
  };
}

/** Deeply duplicates one artboard and its authoritative graph-backed content with fresh IDs. */
export function prepareDuplicateArtboard(
  document: VectorDocument,
  sourceArtboardId: EntityId,
): DuplicateArtboardPlan | null {
  const source = document.getArtboard(sourceArtboardId);
  const page = source ? document.getPage(source.pageId) : undefined;
  if (!source || !page || source.isCanvasRoot) return null;

  const artboardId = createEntityId();
  const frame = nextAvailableFrame(document, page.id, source.frame.width, source.frame.height, source.frame.y);
  const offset = { x: frame.x - source.frame.x, y: frame.y - source.frame.y };
  const artboard: Artboard = {
    ...source,
    id: artboardId,
    name: duplicateName(source.name, new Set(page.artboardIds
      .map((id) => document.getArtboard(id)?.name)
      .filter((name): name is string => Boolean(name)))),
    frame,
    layerIds: [],
  };

  const sourceLayers: LayerNode[] = [];
  const visit = (layerId: EntityId) => {
    const layer = document.getLayer(layerId);
    if (!layer) return;
    sourceLayers.push(layer);
    layer.childIds.forEach(visit);
  };
  source.layerIds.forEach(visit);

  const sourceObjects = sourceLayers
    .filter((layer) => layer.kind === 'object' && layer.objectId)
    .map((layer) => document.getObject(layer.objectId!))
    .filter((object): object is NetworkObject => Boolean(object));
  const sourceNetworks = sourceObjects
    .map((object) => document.getNetwork(object.networkId))
    .filter((network) => network !== undefined);

  const layerIds = new Map(sourceLayers.map((layer) => [layer.id, createEntityId()]));
  const objectIds = new Map(sourceObjects.map((object) => [object.id, createEntityId()]));
  const networkIds = new Map(sourceNetworks.map((network) => [network.id, createEntityId()]));
  const appearanceIds = new Map<EntityId, EntityId>();
  const nodeIds = new Map<EntityId, EntityId>();
  const pathIds = new Map<EntityId, EntityId>();
  const segmentIds = new Map<EntityId, EntityId>();

  for (const object of sourceObjects) {
    if (!appearanceIds.has(object.appearanceId)) appearanceIds.set(object.appearanceId, createEntityId());
    const network = document.getNetwork(object.networkId);
    network?.nodeIds.forEach((id) => nodeIds.set(id, createEntityId()));
    network?.pathIds.forEach((pathId) => {
      pathIds.set(pathId, createEntityId());
      document.getPath(pathId)?.segmentIds.forEach((segmentId) => segmentIds.set(segmentId, createEntityId()));
    });
  }

  const operations: OperationInput[] = [
    { type: 'ADD_ARTBOARD', payload: { artboard, pageId: page.id } },
  ];

  for (const [sourceAppearanceId, targetAppearanceId] of appearanceIds) {
    const appearance = document.getAppearance(sourceAppearanceId);
    if (!appearance) continue;
    operations.push({
      type: 'ADD_APPEARANCE',
      payload: { appearance: cloneAppearance(appearance, targetAppearanceId) },
    });
  }

  for (const object of sourceObjects) {
    const network = document.getNetwork(object.networkId);
    const targetNetworkId = networkIds.get(object.networkId);
    const targetObjectId = objectIds.get(object.id);
    const targetAppearanceId = appearanceIds.get(object.appearanceId);
    if (!network || !targetNetworkId || !targetObjectId || !targetAppearanceId) continue;
    operations.push({ type: 'ADD_NETWORK', payload: { network: { id: targetNetworkId, nodeIds: [], pathIds: [] } } });
    operations.push({
      type: 'ADD_OBJECT',
      payload: {
        object: {
          ...object,
          id: targetObjectId,
          networkId: targetNetworkId,
          appearanceId: targetAppearanceId,
          transform: {
            ...object.transform,
            x: object.transform.x + offset.x,
            y: object.transform.y + offset.y,
          },
        },
      },
    });
    for (const sourceNodeId of network.nodeIds) {
      const node = document.getNode(sourceNodeId);
      const targetNodeId = nodeIds.get(sourceNodeId);
      if (!node || !targetNodeId) continue;
      operations.push({
        type: 'ADD_NODE',
        payload: { node: cloneNode(node, targetNodeId), networkId: targetNetworkId },
      });
    }
    for (const sourcePathId of network.pathIds) {
      const path = document.getPath(sourcePathId);
      const targetPathId = pathIds.get(sourcePathId);
      if (!path || !targetPathId) continue;
      operations.push({
        type: 'ADD_PATH',
        payload: { path: { ...path, id: targetPathId, segmentIds: [] }, networkId: targetNetworkId },
      });
      for (const sourceSegmentId of path.segmentIds) {
        const segment = document.getSegment(sourceSegmentId);
        const targetSegmentId = segmentIds.get(sourceSegmentId);
        if (!segment || !targetSegmentId) continue;
        operations.push({
          type: 'ADD_SEGMENT',
          payload: {
            segment: cloneSegment(segment, targetSegmentId, nodeIds),
            pathId: targetPathId,
          },
        });
      }
    }
  }

  for (const layer of sourceLayers) {
    const targetLayerId = layerIds.get(layer.id)!;
    operations.push({
      type: 'ADD_LAYER',
      payload: {
        layer: {
          ...layer,
          id: targetLayerId,
          artboardId,
          parentId: layer.parentId ? layerIds.get(layer.parentId) : undefined,
          childIds: [],
          objectId: layer.objectId ? objectIds.get(layer.objectId) : undefined,
        },
      },
    });
  }

  const topologyIds = new Map<EntityId, EntityId>([...nodeIds, ...segmentIds, ...pathIds]);
  for (const constraint of document.constraints.values()) {
    if (!constraint.targetIds.every((id) => topologyIds.has(id))) continue;
    operations.push({
      type: 'ADD_CONSTRAINT',
      payload: {
        constraint: {
          ...constraint,
          id: createEntityId(),
          targetIds: constraint.targetIds.map((id) => topologyIds.get(id)!),
          parameters: constraint.parameters ? { ...constraint.parameters } : undefined,
        },
      },
    });
  }

  for (const group of document.parametricGroups.values()) {
    if (!group.sourcePathIds.every((id) => pathIds.has(id))) continue;
    const transform = group.transform.type === 'mirror'
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
        };
    operations.push({
      type: 'ADD_PARAMETRIC_GROUP',
      payload: {
        group: {
          ...group,
          id: createEntityId(),
          sourcePathIds: group.sourcePathIds.map((id) => pathIds.get(id)!),
          transform,
        },
      },
    });
  }

  for (const region of document.regions) {
    if (!region.boundarySegmentIds.every((id) => segmentIds.has(id))) continue;
    const mappedSegmentIds = region.boundarySegmentIds.map((id) => segmentIds.get(id)!);
    const regionId = stableRegionId(mappedSegmentIds);
    if (region.fill) {
      operations.push({
        type: 'SET_REGION_FILL',
        payload: { regionId, fill: { ...region.fill } },
      });
    }
    if (region.fillRule !== 'nonzero') {
      operations.push({ type: 'SET_REGION_FILL_RULE', payload: { regionId, fillRule: region.fillRule } });
    }
  }

  operations.push({ type: 'SET_ACTIVE_LOCATION', payload: { pageId: page.id, artboardId } });
  return {
    artboard,
    operations,
    objectIds: [...objectIds.values()],
    layerIds: [...layerIds.values()],
  };
}

export interface ArtboardPlacementPlan {
  artboardId: EntityId;
  setupOperations: OperationInput[];
}

/** Resolves geometric ownership for newly created standalone artwork. */
export function prepareArtboardPlacement(document: VectorDocument, point: { x: number; y: number }): ArtboardPlacementPlan {
  const page = document.activePage;
  const containing = [...page.artboardIds].reverse()
    .map((id) => document.getArtboard(id))
    .find((artboard) => artboard && !artboard.isCanvasRoot &&
      point.x >= artboard.frame.x && point.x <= artboard.frame.x + artboard.frame.width &&
      point.y >= artboard.frame.y && point.y <= artboard.frame.y + artboard.frame.height);
  if (containing) return { artboardId: containing.id, setupOperations: [] };
  const existingRoot = page.artboardIds
    .map((id) => document.getArtboard(id))
    .find((artboard) => artboard?.isCanvasRoot);
  if (existingRoot) return { artboardId: existingRoot.id, setupOperations: [] };
  const canvasRoot: Artboard = {
    id: createEntityId(),
    pageId: page.id,
    name: 'Canvas',
    frame: { x: 0, y: 0, width: 1, height: 1 },
    layerIds: [],
    background: STARTER_ARTBOARD_BACKGROUND,
    clipContent: false,
    isCanvasRoot: true,
  };
  return {
    artboardId: canvasRoot.id,
    setupOperations: [{ type: 'ADD_ARTBOARD', payload: { artboard: canvasRoot, pageId: page.id } }],
  };
}

export interface DeleteArtboardsResult {
  artboardIds: EntityId[];
  names: string[];
  fallbackArtboardId: EntityId;
}

/** Deletes populated artboards as one rollback-safe transaction. Removing the final visible frame creates an invisible page-level Canvas root. */
export function deleteArtboardsTransactional(
  manager: OperationManager,
  requestedIds: Iterable<EntityId>,
): DeleteArtboardsResult | null {
  const document = manager.document;
  const artboards = [...new Set(requestedIds)]
    .map((id) => document.getArtboard(id))
    .filter((artboard): artboard is Artboard => Boolean(artboard) && !artboard?.isCanvasRoot);
  if (artboards.length === 0) return null;
  const removingIds = new Set(artboards.map((artboard) => artboard.id));
  let fallbackPage = document.pages.find((page) => page.artboardIds.some((id) => !removingIds.has(id)));
  let fallbackArtboardId = fallbackPage?.artboardIds.find((id) => !removingIds.has(id));
  const canvasRoot: Artboard | undefined = fallbackPage && fallbackArtboardId
    ? undefined
    : {
        id: createEntityId(),
        pageId: document.activePage.id,
        name: 'Canvas',
        frame: { x: 0, y: 0, width: 1, height: 1 },
        layerIds: [],
        background: STARTER_ARTBOARD_BACKGROUND,
        clipContent: false,
        isCanvasRoot: true,
      };
  if (canvasRoot) {
    fallbackPage = document.activePage;
    fallbackArtboardId = canvasRoot.id;
  }
  if (!fallbackPage || !fallbackArtboardId) return null;

  try {
    manager.beginTransaction(artboards.length > 1 ? 'Delete artboards' : 'Delete artboard');
    if (canvasRoot) manager.execute({ type: 'ADD_ARTBOARD', payload: { artboard: canvasRoot, pageId: fallbackPage.id } });
    manager.execute({ type: 'SET_ACTIVE_LOCATION', payload: { pageId: fallbackPage.id, artboardId: fallbackArtboardId } });
    for (const artboard of artboards) {
      const owningPage = manager.document.pages.find((page) => page.artboardIds.includes(artboard.id));
      if (!owningPage) continue;
      for (const object of [...manager.document.objectsForArtboard(artboard.id)]) {
        const plan = prepareDeleteObject(manager.document, object.id);
        plan?.operations.forEach((operation) => manager.execute(operation));
      }
      const remainingLayers = [...manager.document.layers.values()]
        .filter((layer) => layer.artboardId === artboard.id)
        .sort((left, right) => layerDepth(manager.document, right.id) - layerDepth(manager.document, left.id));
      for (const layer of remainingLayers) {
        const current = manager.document.getLayer(layer.id);
        if (current && current.childIds.length === 0) manager.execute({ type: 'REMOVE_LAYER', payload: { layer: current } });
      }
      const currentArtboard = manager.document.getArtboard(artboard.id);
      if (currentArtboard) manager.execute({
        type: 'REMOVE_ARTBOARD',
        payload: { artboard: currentArtboard, pageId: owningPage.id },
      });
    }
    for (const page of [...manager.document.pages]) {
      if (page.artboardIds.length === 0 && manager.document.pages.length > 1) {
        manager.execute({ type: 'REMOVE_PAGE', payload: { page } });
      }
    }
    manager.commitTransaction();
    return {
      artboardIds: artboards.map((artboard) => artboard.id),
      names: artboards.map((artboard) => artboard.name),
      fallbackArtboardId,
    };
  } catch (error) {
    manager.rollbackTransaction();
    throw error;
  }
}

function layerDepth(document: VectorDocument, layerId: EntityId): number {
  let depth = 0;
  let layer = document.getLayer(layerId);
  while (layer?.parentId) {
    depth += 1;
    layer = document.getLayer(layer.parentId);
  }
  return depth;
}

function nextAvailableFrame(
  document: VectorDocument,
  pageId: EntityId,
  width: number,
  height: number,
  preferredY: number,
): Artboard['frame'] {
  const page = document.getPage(pageId);
  const frames = page?.artboardIds
    .map((id) => document.getArtboard(id))
    .filter((artboard): artboard is Artboard => Boolean(artboard) && !artboard?.isCanvasRoot)
    .map((artboard) => artboard.frame) ?? [];
  if (frames.length === 0) return { x: 0, y: preferredY, width, height };
  const rightEdge = Math.max(...frames.map((frame) => frame.x + frame.width));
  return { x: rightEdge + ARTBOARD_GAP, y: preferredY, width, height };
}

function nextFrameName(
  document: VectorDocument,
  width: number,
  height: number,
  preferred?: string,
): string {
  const used = new Set([...document.artboards.values()].map((artboard) => artboard.name));
  // A preset names its own frame; the icon workflow keeps the `Icon N` naming it has
  // always had, so the icon regression suite keeps testing something real.
  if (preferred) {
    if (!used.has(preferred)) return preferred;
    let suffix = 2;
    while (used.has(`${preferred} ${suffix}`)) suffix += 1;
    return `${preferred} ${suffix}`;
  }
  const widthLabel = Number.isInteger(width) ? String(width) : String(Number(width.toFixed(2)));
  const heightLabel = Number.isInteger(height) ? String(height) : String(Number(height.toFixed(2)));
  const base = width === height ? `Icon ${widthLabel}` : `Icon ${widthLabel}×${heightLabel}`;
  if (!used.has(base)) return base;
  let index = 2;
  while (used.has(`${base} ${index}`)) index += 1;
  return `${base} ${index}`;
}

function duplicateName(name: string, used: Set<string>): string {
  const match = name.match(/^(.*) copy(?: (\d+))?$/i);
  const base = match ? match[1] : name;
  let candidate = `${base} copy`;
  let index = 2;
  while (used.has(candidate)) candidate = `${base} copy ${index++}`;
  return candidate;
}

function assertDimensions(width: number, height: number): void {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('Artboard dimensions must be finite values greater than 0.');
  }
}

function cloneAppearance(appearance: Appearance, id: EntityId): Appearance {
  return {
    ...appearance,
    id,
    fills: cloneFills(appearance.fills),
    stroke: appearance.stroke ? { ...appearance.stroke, dash: [...appearance.stroke.dash] } : undefined,
  };
}

function cloneNode(node: VectorNode, id: EntityId): VectorNode {
  return {
    ...node,
    id,
    position: { ...node.position },
    handleIn: node.handleIn ? { ...node.handleIn } : undefined,
    handleOut: node.handleOut ? { ...node.handleOut } : undefined,
    constraintIds: [],
  };
}

function cloneSegment(segment: Segment, id: EntityId, nodeIds: Map<EntityId, EntityId>): Segment {
  return {
    ...segment,
    id,
    startNodeId: nodeIds.get(segment.startNodeId)!,
    endNodeId: nodeIds.get(segment.endNodeId)!,
    center: segment.center ? { ...segment.center } : undefined,
    widthProfile: segment.widthProfile?.map((point) => ({ ...point, id: createEntityId() })),
  };
}

/** Repair old icon-only files with the exact unused starter left by onboarding. Custom/blank user frames are preserved. */
export function removeLegacyIconStarter(manager: OperationManager): DeleteArtboardsResult | null {
  const document = manager.document;
  if (document.pages.length !== 1) return null;
  const starter = document.getArtboard(`${document.id}:artboard:1`);
  if (!starter || !isUnusedStarterArtboard(document, starter)) return null;
  const siblings = document.activePage.artboardIds
    .filter((id) => id !== starter.id)
    .map((id) => document.getArtboard(id));
  if (siblings.length === 0 || !siblings.every((artboard) => artboard && !artboard.isCanvasRoot &&
    /^Icon \d+(?:\.\d+)?(?:×\d+(?:\.\d+)?)?(?: \d+)?$/.test(artboard.name))) return null;
  return deleteArtboardsTransactional(manager, [starter.id]);
}
