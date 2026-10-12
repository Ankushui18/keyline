import { createEntityId } from './ids';
import { assertValidParametricGroup } from './parametric';
import { signedPolygonArea } from './region-geometry';
import type {
  Appearance,
  AppearanceRule,
  Artboard,
  Constraint,
  ConstructionExtent,
  DocumentExportMetadata,
  DocumentPage,
  DocumentSnapshot,
  EntityId,
  ExportVariable,
  FillRule,
  GeometryComponent,
  GeometryVariantLink,
  LayerNode,
  NetworkObject,
  ParametricGroup,
  Region,
  Segment,
  SegmentRole,
  StoredSegment,
  VectorDocumentData,
  VectorNetwork,
  VectorNode,
  VectorPath,
} from './types';

/** Rejects malformed segment states before they can enter the authoritative graph. */
export function validateSegmentGeometry(segment: Segment): void {
  if (segment.role !== 'geometry' && segment.role !== 'construction') {
    throw new Error(`Segment ${segment.id} requires a valid geometry or construction role.`);
  }
  if (segment.role === 'construction') {
    if (segment.type !== 'line') {
      throw new Error(`Construction segment ${segment.id} must be a straight line.`);
    }
    if (segment.constructionExtent !== 'finite' && segment.constructionExtent !== 'infinite') {
      throw new Error(`Construction segment ${segment.id} requires a finite or infinite extent.`);
    }
    if (segment.widthProfile !== undefined) {
      throw new Error(`Construction segment ${segment.id} cannot contain a width profile.`);
    }
  } else if (segment.constructionExtent !== undefined) {
    throw new Error(`Geometry segment ${segment.id} cannot contain construction extent data.`);
  }

  const arcFields = [segment.center, segment.radius, segment.startAngle, segment.endAngle, segment.clockwise];
  if (segment.type !== 'arc') {
    if (arcFields.some((value) => value !== undefined)) {
      throw new Error(`${segment.type === 'line' ? 'Line' : 'Bézier'} segment ${segment.id} cannot contain native arc geometry.`);
    }
    return;
  }
  if (!segment.center || !Number.isFinite(segment.center.x) || !Number.isFinite(segment.center.y)) {
    throw new Error(`Native arc ${segment.id} requires a finite center.`);
  }
  if (!Number.isFinite(segment.radius) || (segment.radius ?? 0) <= 0) {
    throw new Error(`Native arc ${segment.id} requires a finite radius greater than 0.`);
  }
  if (!Number.isFinite(segment.startAngle) || !Number.isFinite(segment.endAngle)) {
    throw new Error(`Native arc ${segment.id} requires finite start and end angles.`);
  }
  if (segment.clockwise !== undefined && typeof segment.clockwise !== 'boolean') {
    throw new Error(`Native arc ${segment.id} has an invalid clockwise direction.`);
  }
}

/**
 * In-memory typed graph. UI code receives read access to this model; mutation is
 * centralized in OperationManager through the internal mutation methods below.
 */
export class VectorDocument implements VectorDocumentData {
  id: EntityId;
  networks: VectorNetwork[];
  nodes: Map<EntityId, VectorNode>;
  segments: Map<EntityId, Segment>;
  paths: Map<EntityId, VectorPath>;
  regions: Region[];
  constraints: Map<EntityId, Constraint>;
  parametricGroups: Map<EntityId, ParametricGroup>;
  exportVariables: Map<EntityId, ExportVariable>;
  exportMetadata: DocumentExportMetadata;
  appearanceRules: Map<EntityId, AppearanceRule>;
  geometryComponents: Map<EntityId, GeometryComponent>;
  variables: Map<string, number>;
  pages: DocumentPage[];
  artboards: Map<EntityId, Artboard>;
  layers: Map<EntityId, LayerNode>;
  objects: Map<EntityId, NetworkObject>;
  appearances: Map<EntityId, Appearance>;
  activePageId: EntityId;
  activeArtboardId: EntityId;
  isolatedLayerId?: EntityId;

  constructor(snapshot?: DocumentSnapshot) {
    this.id = snapshot?.id ?? createEntityId();
    this.networks = snapshot?.networks.map(cloneNetwork) ?? [];
    this.nodes = new Map(snapshot?.nodes.map(([id, node]) => [id, cloneNode(node)]) ?? []);
    this.segments = new Map(snapshot?.segments.map(([id, segment]) => [
      id,
      migrateStoredSegment(segment, snapshot.version),
    ]) ?? []);
    for (const segment of this.segments.values()) {
      if (segment.role === 'construction') {
        validateConstructionAnchors(segment, this.nodes.get(segment.startNodeId), this.nodes.get(segment.endNodeId));
      }
    }
    this.paths = new Map(snapshot?.paths.map(([id, path]) => [id, clonePath(path)]) ?? []);
    this.regions = snapshot?.regions.map(cloneRegion) ?? [];
    this.constraints = new Map(
      snapshot?.constraints?.map(([id, constraint]) => [id, cloneConstraint(constraint)]) ?? [],
    );
    this.parametricGroups = new Map(
      snapshot?.parametricGroups?.map(([id, group]) => [id, cloneParametricGroup(group)]) ?? [],
    );
    this.exportVariables = new Map(
      snapshot?.exportVariables?.map(([id, variable]) => [id, { ...variable }]) ?? [],
    );
    this.exportMetadata = cloneExportMetadata(snapshot?.exportMetadata ?? { presets: [] });
    this.appearanceRules = new Map(
      snapshot?.appearanceRules?.map(([id, rule]) => [id, cloneAppearanceRule(rule)]) ?? [],
    );
    this.geometryComponents = new Map(
      snapshot?.geometryComponents?.map(([id, component]) => [id, cloneGeometryComponent(component)]) ?? [],
    );
    this.variables = new Map(snapshot?.variables ?? []);

    const structure = snapshot?.pages && snapshot.artboards && snapshot.layers &&
      snapshot.objects && snapshot.appearances && snapshot.activePageId && snapshot.activeArtboardId
      ? {
          pages: snapshot.pages.map(clonePage),
          artboards: new Map(snapshot.artboards.map(([id, item]) => [id, cloneArtboard(item)])),
          layers: new Map(snapshot.layers.map(([id, item]) => [id, cloneLayer(item)])),
          objects: new Map(snapshot.objects.map(([id, item]) => [id, cloneObject(item)])),
          appearances: new Map(snapshot.appearances.map(([id, item]) => [id, cloneAppearance(item)])),
          activePageId: snapshot.activePageId,
          activeArtboardId: snapshot.activeArtboardId,
        }
      : createMigratedStructure(this.id, this.networks);
    this.pages = structure.pages;
    this.artboards = structure.artboards;
    this.layers = structure.layers;
    this.objects = structure.objects;
    this.appearances = structure.appearances;
    for (const object of this.objects.values()) {
      if (!object.appearanceRuleId) continue;
      const rule = this.appearanceRules.get(object.appearanceRuleId);
      const appearance = this.appearances.get(object.appearanceId);
      if (!rule || !appearance) {
        object.appearanceRuleId = undefined;
        continue;
      }
      this.appearances.set(appearance.id, appearanceFromRule(appearance.id, rule));
    }
    for (const [componentId, component] of this.geometryComponents) {
      if (!this.objects.has(component.sourceObjectId)) {
        this.geometryComponents.delete(componentId);
        continue;
      }
      component.variants = component.variants.filter((variant) => this.objects.has(variant.objectId));
    }
    this.activePageId = structure.activePageId;
    this.activeArtboardId = structure.activeArtboardId;
    for (const group of this.parametricGroups.values()) assertValidParametricGroup(this, group);
  }

  static createEmpty(): VectorDocument {
    const network: VectorNetwork = { id: createEntityId(), nodeIds: [], pathIds: [] };
    const document = new VectorDocument({
      version: 6,
      id: createEntityId(),
      networks: [network],
      nodes: [],
      segments: [],
      paths: [],
      regions: [],
      variables: [],
    });
    return document;
  }

  _replaceFromSnapshot(snapshot: DocumentSnapshot): void {
    const replacement = new VectorDocument(snapshot);
    this.id = replacement.id;
    this.networks = replacement.networks;
    this.nodes = replacement.nodes;
    this.segments = replacement.segments;
    this.paths = replacement.paths;
    this.regions = replacement.regions;
    this.constraints = replacement.constraints;
    this.parametricGroups = replacement.parametricGroups;
    this.exportVariables = replacement.exportVariables;
    this.exportMetadata = replacement.exportMetadata;
    this.appearanceRules = replacement.appearanceRules;
    this.geometryComponents = replacement.geometryComponents;
    this.variables = replacement.variables;
    this.pages = replacement.pages;
    this.artboards = replacement.artboards;
    this.layers = replacement.layers;
    this.objects = replacement.objects;
    this.appearances = replacement.appearances;
    this.activePageId = replacement.activePageId;
    this.activeArtboardId = replacement.activeArtboardId;
    this.isolatedLayerId = undefined;
  }

  get activePage(): DocumentPage {
    const page = this.pages.find((item) => item.id === this.activePageId) ?? this.pages[0];
    if (!page) throw new Error('Document does not contain a page.');
    return page;
  }

  get activeArtboard(): Artboard {
    const artboard = this.artboards.get(this.activeArtboardId) ??
      this.artboards.get(this.activePage.artboardIds[0]);
    if (!artboard) throw new Error('Document does not contain an artboard.');
    return artboard;
  }

  get activeNetwork(): VectorNetwork {
    const activeObject = this.objectsForArtboard(this.activeArtboard.id)[0];
    const network = activeObject ? this.getNetwork(activeObject.networkId) : this.networks[0];
    if (!network) throw new Error('Document does not contain a vector network.');
    return network;
  }

  getNode(id: EntityId): VectorNode | undefined { return this.nodes.get(id); }
  getSegment(id: EntityId): Segment | undefined { return this.segments.get(id); }
  getPath(id: EntityId): VectorPath | undefined { return this.paths.get(id); }
  getNetwork(id: EntityId): VectorNetwork | undefined { return this.networks.find((item) => item.id === id); }
  getPage(id: EntityId): DocumentPage | undefined { return this.pages.find((item) => item.id === id); }
  getArtboard(id: EntityId): Artboard | undefined { return this.artboards.get(id); }
  getLayer(id: EntityId): LayerNode | undefined { return this.layers.get(id); }
  getObject(id: EntityId): NetworkObject | undefined { return this.objects.get(id); }
  getAppearance(id: EntityId): Appearance | undefined { return this.appearances.get(id); }
  getAppearanceRule(id: EntityId): AppearanceRule | undefined { return this.appearanceRules.get(id); }
  getGeometryComponent(id: EntityId): GeometryComponent | undefined {
    const component = this.geometryComponents.get(id);
    return component ? cloneGeometryComponent(component) : undefined;
  }

  geometryComponentForObject(objectId: EntityId): GeometryComponent | undefined {
    for (const component of this.geometryComponents.values()) {
      if (
        component.sourceObjectId === objectId ||
        component.variants.some((variant) => variant.objectId === objectId)
      ) {
        return cloneGeometryComponent(component);
      }
    }
    return undefined;
  }

  geometryVariantForObject(
    objectId: EntityId,
  ): { component: GeometryComponent; variant: GeometryVariantLink } | undefined {
    for (const component of this.geometryComponents.values()) {
      const variant = component.variants.find((candidate) => candidate.objectId === objectId);
      if (variant) {
        return {
          component: cloneGeometryComponent(component),
          variant: cloneGeometryVariantLink(variant),
        };
      }
    }
    return undefined;
  }

  objectsForAppearanceRule(ruleId: EntityId): NetworkObject[] {
    return [...this.objects.values()].filter((object) => object.appearanceRuleId === ruleId);
  }

  getObjectForNetwork(networkId: EntityId): NetworkObject | undefined {
    return [...this.objects.values()].find((item) => item.networkId === networkId);
  }

  getObjectForSegment(segmentId: EntityId): NetworkObject | undefined {
    const path = this.findPathForSegment(segmentId);
    const network = path ? this.findNetworkForPath(path.id) : undefined;
    return network ? this.getObjectForNetwork(network.id) : undefined;
  }

  getObjectForNode(nodeId: EntityId): NetworkObject | undefined {
    const network = this.networks.find((item) => item.nodeIds.includes(nodeId));
    return network ? this.getObjectForNetwork(network.id) : undefined;
  }

  getLayerForObject(objectId: EntityId): LayerNode | undefined {
    return [...this.layers.values()].find((item) => item.kind === 'object' && item.objectId === objectId);
  }

  objectsForArtboard(artboardId: EntityId): NetworkObject[] {
    const result: NetworkObject[] = [];
    const artboard = this.artboards.get(artboardId);
    const visit = (layerId: EntityId, ancestorsVisible: boolean) => {
      const layer = this.layers.get(layerId);
      if (!layer || !ancestorsVisible || !layer.visible) return;
      if (layer.kind === 'object' && layer.objectId) {
        const object = this.objects.get(layer.objectId);
        if (object && this.isObjectVisible(object.id)) result.push(object);
      }
      for (const childId of layer.childIds) visit(childId, true);
    };
    for (const layerId of artboard?.layerIds ?? []) visit(layerId, true);
    return result;
  }

  isObjectVisible(objectId: EntityId): boolean {
    let layer = this.getLayerForObject(objectId);
    if (!layer) return false;
    let withinIsolation = !this.isolatedLayerId;
    while (layer) {
      if (!layer.visible) return false;
      if (layer.id === this.isolatedLayerId) withinIsolation = true;
      layer = layer.parentId ? this.layers.get(layer.parentId) : undefined;
    }
    return withinIsolation;
  }

  isObjectLocked(objectId: EntityId): boolean {
    let layer = this.getLayerForObject(objectId);
    if (!layer) return true;
    while (layer) {
      if (layer.locked) return true;
      layer = layer.parentId ? this.layers.get(layer.parentId) : undefined;
    }
    return false;
  }

  visibleNetworkIds(): Set<EntityId> {
    const result = new Set(this.networks.map((network) => network.id));
    for (const object of this.objects.values()) {
      if (!this.isObjectVisible(object.id)) result.delete(object.networkId);
    }
    return result;
  }

  visibleNodeIds(): Set<EntityId> {
    const visibleNetworks = this.visibleNetworkIds();
    return new Set(this.networks
      .filter((network) => visibleNetworks.has(network.id))
      .flatMap((network) => network.nodeIds));
  }

  visibleSegmentIds(): Set<EntityId> {
    const visibleNetworks = this.visibleNetworkIds();
    const result = new Set<EntityId>();
    for (const network of this.networks) {
      if (!visibleNetworks.has(network.id)) continue;
      for (const pathId of network.pathIds) {
        for (const segmentId of this.paths.get(pathId)?.segmentIds ?? []) result.add(segmentId);
      }
    }
    return result;
  }

  isNetworkVisible(networkId: EntityId): boolean {
    const object = this.getObjectForNetwork(networkId);
    return object ? this.isObjectVisible(object.id) : true;
  }

  isNetworkLocked(networkId: EntityId): boolean {
    const object = this.getObjectForNetwork(networkId);
    return object ? this.isObjectLocked(object.id) : false;
  }

  isSegmentVisible(segmentId: EntityId): boolean {
    const path = this.findPathForSegment(segmentId);
    const network = path ? this.findNetworkForPath(path.id) : undefined;
    return network ? this.isNetworkVisible(network.id) : true;
  }

  isSegmentLocked(segmentId: EntityId): boolean {
    const path = this.findPathForSegment(segmentId);
    const network = path ? this.findNetworkForPath(path.id) : undefined;
    return network ? this.isNetworkLocked(network.id) : false;
  }

  isNodeVisible(nodeId: EntityId): boolean {
    const network = this.networks.find((item) => item.nodeIds.includes(nodeId));
    return network ? this.isNetworkVisible(network.id) : true;
  }

  isNodeLocked(nodeId: EntityId): boolean {
    const network = this.networks.find((item) => item.nodeIds.includes(nodeId));
    return network ? this.isNetworkLocked(network.id) : false;
  }

  findPathForSegment(segmentId: EntityId): VectorPath | undefined {
    return [...this.paths.values()].find((path) => path.segmentIds.includes(segmentId));
  }

  findNetworkForPath(pathId: EntityId): VectorNetwork | undefined {
    return this.networks.find((network) => network.pathIds.includes(pathId));
  }

  connectedSegments(nodeId: EntityId): Segment[] {
    return [...this.segments.values()].filter(
      (segment) => segment.startNodeId === nodeId || segment.endNodeId === nodeId,
    );
  }

  toSnapshot(): DocumentSnapshot {
    return {
      version: 6,
      id: this.id,
      networks: this.networks.map(cloneNetwork),
      nodes: [...this.nodes].map(([id, node]) => [id, cloneNode(node)]),
      segments: [...this.segments].map(([id, segment]) => [id, cloneSegment(segment)]),
      paths: [...this.paths].map(([id, path]) => [id, clonePath(path)]),
      regions: this.regions.map(cloneRegion),
      constraints: [...this.constraints].map(([id, constraint]) => [id, cloneConstraint(constraint)]),
      parametricGroups: [...this.parametricGroups].map(([id, group]) => [id, cloneParametricGroup(group)]),
      exportVariables: [...this.exportVariables].map(([id, variable]) => [id, { ...variable }]),
      exportMetadata: cloneExportMetadata(this.exportMetadata),
      appearanceRules: [...this.appearanceRules].map(([id, rule]) => [id, cloneAppearanceRule(rule)]),
      geometryComponents: [...this.geometryComponents].map(([id, component]) => [
        id,
        cloneGeometryComponent(component),
      ]),
      variables: [...this.variables],
      pages: this.pages.map(clonePage),
      artboards: [...this.artboards].map(([id, item]) => [id, cloneArtboard(item)]),
      layers: [...this.layers].map(([id, item]) => [id, cloneLayer(item)]),
      objects: [...this.objects].map(([id, item]) => [id, cloneObject(item)]),
      appearances: [...this.appearances].map(([id, item]) => [id, cloneAppearance(item)]),
      activePageId: this.activePageId,
      activeArtboardId: this.activeArtboardId,
    };
  }

  // These methods are intentionally prefixed internal: OperationManager is the
  // only production caller, keeping every graph mutation transactional.
  _addNetwork(network: VectorNetwork, index?: number): void {
    if (this.getNetwork(network.id)) throw new Error(`Network ${network.id} already exists.`);
    if (network.nodeIds.length > 0 || network.pathIds.length > 0) {
      throw new Error('Add a network before attaching graph entities.');
    }
    insertAt(this.networks, cloneNetwork(network), index);
  }

  _removeNetwork(networkId: EntityId): void {
    const network = this.getNetwork(networkId);
    if (!network) throw new Error(`Unknown network ${networkId}.`);
    if (network.nodeIds.length > 0 || network.pathIds.length > 0) {
      throw new Error(`Cannot remove non-empty network ${networkId}.`);
    }
    if (this.getObjectForNetwork(networkId)) {
      throw new Error(`Cannot remove network ${networkId} while it belongs to an object.`);
    }
    removeValue(this.networks, network);
  }

  _addNode(node: VectorNode, networkId: EntityId, index?: number): void {
    if (this.nodes.has(node.id)) throw new Error(`Node ${node.id} already exists.`);
    const network = this.requireNetwork(networkId);
    this.nodes.set(node.id, cloneNode(node));
    insertAt(network.nodeIds, node.id, index);
  }

  _removeNode(nodeId: EntityId, networkId: EntityId): void {
    for (const segment of this.segments.values()) {
      if (segment.startNodeId === nodeId || segment.endNodeId === nodeId) {
        throw new Error(`Cannot remove connected node ${nodeId}.`);
      }
    }
    this.nodes.delete(nodeId);
    removeValue(this.requireNetwork(networkId).nodeIds, nodeId);
  }

  _moveNode(nodeId: EntityId, delta: { x: number; y: number }): void {
    const node = this.requireNode(nodeId);
    node.position.x += delta.x;
    node.position.y += delta.y;
    if (node.handleIn) {
      node.handleIn.x += delta.x;
      node.handleIn.y += delta.y;
    }
    if (node.handleOut) {
      node.handleOut.x += delta.x;
      node.handleOut.y += delta.y;
    }
  }

  _setNodeMode(nodeId: EntityId, mode: VectorNode['handleMode']): void {
    const node = this.requireNode(nodeId);
    node.handleMode = mode;
  }

  _addPath(path: VectorPath, networkId: EntityId, index?: number): void {
    if (this.paths.has(path.id)) throw new Error(`Path ${path.id} already exists.`);
    this.paths.set(path.id, clonePath(path));
    insertAt(this.requireNetwork(networkId).pathIds, path.id, index);
  }

  _removePath(pathId: EntityId, networkId: EntityId): void {
    const path = this.requirePath(pathId);
    if (path.segmentIds.length > 0) throw new Error(`Cannot remove non-empty path ${pathId}.`);
    this.paths.delete(pathId);
    removeValue(this.requireNetwork(networkId).pathIds, pathId);
  }

  _addSegment(segment: Segment, pathId: EntityId, index?: number): void {
    if (this.segments.has(segment.id)) throw new Error(`Segment ${segment.id} already exists.`);
    validateSegmentGeometry(segment);
    const start = this.requireNode(segment.startNodeId);
    const end = this.requireNode(segment.endNodeId);
    if (segment.role === 'construction') validateConstructionAnchors(segment, start, end);
    const path = this.requirePath(pathId);
    this.segments.set(segment.id, cloneSegment(segment));
    insertAt(path.segmentIds, segment.id, index);
  }

  _removeSegment(segmentId: EntityId, pathId: EntityId): void {
    this.segments.delete(segmentId);
    removeValue(this.requirePath(pathId).segmentIds, segmentId);
  }

  _setPathClosed(pathId: EntityId, isClosed: boolean): void {
    this.requirePath(pathId).isClosed = isClosed;
  }

  _setNodeHandles(
    nodeId: EntityId,
    handles: { handleIn?: { x: number; y: number } | null; handleOut?: { x: number; y: number } | null },
  ): void {
    const node = this.requireNode(nodeId);
    if (handles.handleIn !== undefined) node.handleIn = handles.handleIn ? { ...handles.handleIn } : undefined;
    if (handles.handleOut !== undefined) node.handleOut = handles.handleOut ? { ...handles.handleOut } : undefined;
  }

  _setSegmentType(segmentId: EntityId, type: Segment['type']): void {
    const segment = this.segments.get(segmentId);
    if (!segment) throw new Error(`Unknown segment ${segmentId}.`);
    const geometry: Segment = { ...segment, type };
    if (type !== 'arc') {
      geometry.center = undefined;
      geometry.radius = undefined;
      geometry.startAngle = undefined;
      geometry.endAngle = undefined;
      geometry.clockwise = undefined;
    }
    validateSegmentGeometry(geometry);
    this.segments.set(segmentId, cloneSegment(geometry));
  }

  _setSegmentGeometry(segmentId: EntityId, geometry: Segment): void {
    const segment = this.segments.get(segmentId);
    if (!segment) throw new Error(`Unknown segment ${segmentId}.`);
    if (geometry.id !== segmentId) throw new Error('Segment geometry cannot change its entity ID.');
    validateSegmentGeometry(geometry);
    const start = this.requireNode(geometry.startNodeId);
    const end = this.requireNode(geometry.endNodeId);
    if (geometry.role === 'construction') validateConstructionAnchors(geometry, start, end);
    this.segments.set(segmentId, cloneSegment(geometry));
  }

  _setSegmentRoles(updates: Array<{
    segmentId: EntityId;
    role: SegmentRole;
    constructionExtent?: ConstructionExtent;
  }>): void {
    const ids = new Set<EntityId>();
    const replacements = updates.map((update) => {
      if (ids.has(update.segmentId)) throw new Error(`Segment role update repeats ${update.segmentId}.`);
      ids.add(update.segmentId);
      const current = this.segments.get(update.segmentId);
      if (!current) throw new Error(`Unknown segment ${update.segmentId}.`);
      const replacement: Segment = {
        ...current,
        role: update.role,
        constructionExtent: update.role === 'construction' ? update.constructionExtent : undefined,
      };
      validateSegmentGeometry(replacement);
      if (replacement.role === 'construction') {
        validateConstructionAnchors(
          replacement,
          this.nodes.get(replacement.startNodeId),
          this.nodes.get(replacement.endNodeId),
        );
        const path = this.findPathForSegment(replacement.id);
        if (path && [...this.parametricGroups.values()].some((group) => group.sourcePathIds.includes(path.id))) {
          throw new Error('Construction paths cannot be used as Parametric Group sources.');
        }
      }
      return replacement;
    });
    for (const replacement of replacements) this.segments.set(replacement.id, cloneSegment(replacement));
  }

  _setSegmentWidthProfile(segmentId: EntityId, widthProfile: Segment['widthProfile']): void {
    const segment = this.segments.get(segmentId);
    if (!segment) throw new Error(`Unknown segment ${segmentId}.`);
    const geometry: Segment = {
      ...segment,
      widthProfile: widthProfile?.map((point) => ({ ...point })),
    };
    validateSegmentGeometry(geometry);
    this.segments.set(segmentId, cloneSegment(geometry));
  }

  _addParametricGroup(group: ParametricGroup): void {
    if (this.parametricGroups.has(group.id)) throw new Error(`Parametric group ${group.id} already exists.`);
    assertValidParametricGroup(this, group);
    this.parametricGroups.set(group.id, cloneParametricGroup(group));
  }

  _removeParametricGroup(groupId: EntityId): void {
    this.parametricGroups.delete(groupId);
  }

  _setParametricGroup(groupId: EntityId, group: ParametricGroup): void {
    if (!this.parametricGroups.has(groupId)) throw new Error(`Unknown parametric group ${groupId}.`);
    if (group.id !== groupId) throw new Error('Parametric group cannot change its entity ID.');
    assertValidParametricGroup(this, group);
    this.parametricGroups.set(groupId, cloneParametricGroup(group));
  }

  _addExportVariable(variable: ExportVariable): void {
    if (this.exportVariables.has(variable.id)) throw new Error(`Export variable ${variable.id} already exists.`);
    this.exportVariables.set(variable.id, { ...variable });
  }

  _updateExportVariable(variableId: EntityId, variable: ExportVariable): void {
    if (!this.exportVariables.has(variableId)) throw new Error(`Unknown export variable ${variableId}.`);
    this.exportVariables.set(variableId, { ...variable, id: variableId });
  }

  _removeExportVariable(variableId: EntityId): void {
    this.exportVariables.delete(variableId);
  }

  _setExportMetadata(metadata: DocumentExportMetadata): void {
    this.exportMetadata = cloneExportMetadata(metadata);
  }

  _addAppearanceRule(rule: AppearanceRule): void {
    if (this.appearanceRules.has(rule.id)) throw new Error(`Appearance rule ${rule.id} already exists.`);
    this.appearanceRules.set(rule.id, cloneAppearanceRule(rule));
  }

  _removeAppearanceRule(ruleId: EntityId): void {
    if (this.objectsForAppearanceRule(ruleId).length > 0) {
      throw new Error(`Cannot remove appearance rule ${ruleId} while objects still use it.`);
    }
    if (!this.appearanceRules.delete(ruleId)) throw new Error(`Unknown appearance rule ${ruleId}.`);
  }

  _setAppearanceRule(ruleId: EntityId, rule: AppearanceRule): void {
    if (!this.appearanceRules.has(ruleId)) throw new Error(`Unknown appearance rule ${ruleId}.`);
    if (rule.id !== ruleId) throw new Error('Appearance rule cannot change its entity ID.');
    const next = cloneAppearanceRule(rule);
    this.appearanceRules.set(ruleId, next);
    for (const object of this.objectsForAppearanceRule(ruleId)) {
      if (!this.appearances.has(object.appearanceId)) continue;
      this.appearances.set(object.appearanceId, appearanceFromRule(object.appearanceId, next));
    }
  }

  _addGeometryComponent(component: GeometryComponent): void {
    if (this.geometryComponents.has(component.id)) {
      throw new Error(`Geometry component ${component.id} already exists.`);
    }
    assertValidGeometryComponent(this, component);
    this.geometryComponents.set(component.id, cloneGeometryComponent(component));
  }

  _setGeometryComponent(componentId: EntityId, component: GeometryComponent): void {
    if (!this.geometryComponents.has(componentId)) {
      throw new Error(`Unknown geometry component ${componentId}.`);
    }
    if (component.id !== componentId) {
      throw new Error('Geometry component cannot change its entity ID.');
    }
    assertValidGeometryComponent(this, component, componentId);
    this.geometryComponents.set(componentId, cloneGeometryComponent(component));
  }

  _removeGeometryComponent(componentId: EntityId): void {
    if (!this.geometryComponents.delete(componentId)) {
      throw new Error(`Unknown geometry component ${componentId}.`);
    }
  }

  _setNodePosition(nodeId: EntityId, position: { x: number; y: number }): void {
    const node = this.requireNode(nodeId);
    this._moveNode(nodeId, {
      x: position.x - node.position.x,
      y: position.y - node.position.y,
    });
  }

  _addConstraint(constraint: Constraint): void {
    if (this.constraints.has(constraint.id)) throw new Error(`Constraint ${constraint.id} already exists.`);
    this.constraints.set(constraint.id, cloneConstraint(constraint));
    this.attachConstraint(constraint);
  }

  _removeConstraint(constraintId: EntityId): void {
    this.constraints.delete(constraintId);
    for (const node of this.nodes.values()) {
      removeValue(node.constraintIds, constraintId);
    }
  }

  _updateConstraint(constraintId: EntityId, constraint: Constraint): void {
    if (!this.constraints.has(constraintId)) throw new Error(`Unknown constraint ${constraintId}.`);
    this._removeConstraint(constraintId);
    this.constraints.set(constraintId, cloneConstraint(constraint));
    this.attachConstraint(constraint);
  }

  _setRegions(regions: Region[]): void {
    this.regions = regions;
  }

  _rebuildConstraintAttachments(): void {
    for (const node of this.nodes.values()) node.constraintIds = [];
    for (const constraint of this.constraints.values()) this.attachConstraint(constraint);
  }

  _setRegionFill(regionId: EntityId, fill: Region['fill']): void {
    const region = this.regions.find((item) => item.id === regionId);
    if (!region) throw new Error(`Unknown region ${regionId}.`);
    if (fill && (fill.type !== 'solid' || typeof fill.color !== 'string' || fill.color.length === 0)) {
      throw new Error('Smart Fill supports a solid color only in Gate C.');
    }
    region.fill = fill ? { ...fill } : undefined;
  }

  _setRegionFillRule(regionId: EntityId, fillRule: FillRule): void {
    const region = this.regions.find((item) => item.id === regionId);
    if (!region) throw new Error(`Unknown region ${regionId}.`);
    if (fillRule !== 'nonzero' && fillRule !== 'evenodd') {
      throw new Error(`Region ${regionId} requires a nonzero or evenodd fill rule.`);
    }
    region.fillRule = fillRule;
  }

  _addPage(page: DocumentPage, index?: number): void {
    if (this.getPage(page.id)) throw new Error(`Page ${page.id} already exists.`);
    if (page.artboardIds.length > 0) throw new Error('Add a page before attaching artboards.');
    insertAt(this.pages, clonePage(page), index);
  }

  _removePage(pageId: EntityId): void {
    const page = this.getPage(pageId);
    if (!page) throw new Error(`Unknown page ${pageId}.`);
    if (page.artboardIds.length > 0) throw new Error(`Cannot remove non-empty page ${pageId}.`);
    if (this.pages.length <= 1) throw new Error('A document must contain at least one page.');
    removeValue(this.pages, page);
    if (this.activePageId === pageId) this.activePageId = this.pages[0].id;
  }

  _setPage(pageId: EntityId, page: DocumentPage): void {
    const index = this.pages.findIndex((item) => item.id === pageId);
    if (index < 0) throw new Error(`Unknown page ${pageId}.`);
    if (page.id !== pageId) throw new Error('Page cannot change its entity ID.');
    this.pages[index] = clonePage(page);
  }

  _movePage(pageId: EntityId, index: number): void {
    const current = this.pages.findIndex((item) => item.id === pageId);
    if (current < 0) throw new Error(`Unknown page ${pageId}.`);
    const [page] = this.pages.splice(current, 1);
    this.pages.splice(Math.max(0, Math.min(index, this.pages.length)), 0, page);
  }

  _addArtboard(artboard: Artboard, pageId: EntityId, index?: number): void {
    if (this.artboards.has(artboard.id)) throw new Error(`Artboard ${artboard.id} already exists.`);
    if (artboard.layerIds.length > 0) throw new Error('Add an artboard before attaching layers.');
    const page = this.getPage(pageId);
    if (!page) throw new Error(`Unknown page ${pageId}.`);
    this.artboards.set(artboard.id, cloneArtboard({ ...artboard, pageId }));
    insertAt(page.artboardIds, artboard.id, index);
  }

  _removeArtboard(artboardId: EntityId, pageId: EntityId): void {
    const artboard = this.artboards.get(artboardId);
    if (!artboard) throw new Error(`Unknown artboard ${artboardId}.`);
    if (artboard.layerIds.length > 0) throw new Error(`Cannot remove non-empty artboard ${artboardId}.`);
    const page = this.getPage(pageId);
    if (!page) throw new Error(`Unknown page ${pageId}.`);
    if (this.artboards.size <= 1) throw new Error('A document must contain at least one artboard.');
    this.artboards.delete(artboardId);
    removeValue(page.artboardIds, artboardId);
    if (this.activeArtboardId === artboardId) {
      this.activeArtboardId = this.artboards.get(this.activePage.artboardIds[0])?.id ?? [...this.artboards.keys()][0];
    }
  }

  _setArtboard(artboardId: EntityId, artboard: Artboard): void {
    if (!this.artboards.has(artboardId)) throw new Error(`Unknown artboard ${artboardId}.`);
    if (artboard.id !== artboardId) throw new Error('Artboard cannot change its entity ID.');
    this.artboards.set(artboardId, cloneArtboard(artboard));
  }

  _moveArtboard(artboardId: EntityId, pageId: EntityId, index: number): void {
    const page = this.getPage(pageId);
    const artboard = this.getArtboard(artboardId);
    if (!page || !artboard || artboard.pageId !== pageId) throw new Error('Artboard must belong to the page.');
    const current = page.artboardIds.indexOf(artboardId);
    if (current < 0) throw new Error(`Page does not contain artboard ${artboardId}.`);
    page.artboardIds.splice(current, 1);
    page.artboardIds.splice(Math.max(0, Math.min(index, page.artboardIds.length)), 0, artboardId);
  }

  _addLayer(layer: LayerNode, index?: number): void {
    if (this.layers.has(layer.id)) throw new Error(`Layer ${layer.id} already exists.`);
    if (layer.childIds.length > 0) throw new Error('Add a layer before attaching child layers.');
    if (layer.kind === 'object') {
      if (!layer.objectId || !this.objects.has(layer.objectId)) throw new Error('Object layers require a valid object.');
    } else if (layer.objectId) {
      throw new Error('Only object layers may reference an object.');
    }
    this.layers.set(layer.id, cloneLayer(layer));
    const target = this.layerContainer(layer.parentId, layer.artboardId);
    insertAt(target, layer.id, index);
  }

  _removeLayer(layerId: EntityId): void {
    const layer = this.layers.get(layerId);
    if (!layer) throw new Error(`Unknown layer ${layerId}.`);
    if (layer.childIds.length > 0) throw new Error(`Cannot remove non-empty layer ${layerId}.`);
    removeValue(this.layerContainer(layer.parentId, layer.artboardId), layerId);
    this.layers.delete(layerId);
  }

  _setLayer(layerId: EntityId, layer: LayerNode): void {
    const current = this.layers.get(layerId);
    if (!current) throw new Error(`Unknown layer ${layerId}.`);
    if (layer.id !== layerId) throw new Error('Layer cannot change its entity ID.');
    if (current.parentId !== layer.parentId || current.artboardId !== layer.artboardId) {
      throw new Error('Use MOVE_LAYER to change hierarchy.');
    }
    this.layers.set(layerId, cloneLayer(layer));
  }

  _moveLayer(layerId: EntityId, parentId: EntityId | undefined, artboardId: EntityId, index?: number): void {
    const layer = this.layers.get(layerId);
    if (!layer) throw new Error(`Unknown layer ${layerId}.`);
    if (parentId === layerId || (parentId && this.layerContains(layerId, parentId))) {
      throw new Error('A layer cannot be moved inside itself or its descendants.');
    }
    removeValue(this.layerContainer(layer.parentId, layer.artboardId), layerId);
    const target = this.layerContainer(parentId, artboardId);
    insertAt(target, layerId, index);
    layer.parentId = parentId;
    layer.artboardId = artboardId;
    this.updateDescendantArtboard(layer, artboardId);
  }

  _addObject(object: NetworkObject): void {
    if (this.objects.has(object.id)) throw new Error(`Object ${object.id} already exists.`);
    if (!this.getNetwork(object.networkId)) throw new Error(`Unknown network ${object.networkId}.`);
    if (!this.appearances.has(object.appearanceId)) throw new Error(`Unknown appearance ${object.appearanceId}.`);
    if (object.appearanceRuleId && !this.appearanceRules.has(object.appearanceRuleId)) {
      throw new Error(`Unknown appearance rule ${object.appearanceRuleId}.`);
    }
    if (this.getObjectForNetwork(object.networkId)) throw new Error(`Network ${object.networkId} already belongs to an object.`);
    this.objects.set(object.id, cloneObject(object));
  }

  _removeObject(objectId: EntityId): void {
    if (this.getLayerForObject(objectId)) throw new Error(`Cannot remove object ${objectId} while it is in the layer tree.`);
    if (this.geometryComponentForObject(objectId)) {
      throw new Error(`Cannot remove object ${objectId} while it belongs to a geometry component.`);
    }
    this.objects.delete(objectId);
  }

  _setObject(objectId: EntityId, object: NetworkObject): void {
    if (!this.objects.has(objectId)) throw new Error(`Unknown object ${objectId}.`);
    if (object.id !== objectId) throw new Error('Object cannot change its entity ID.');
    if (!this.getNetwork(object.networkId)) throw new Error(`Unknown network ${object.networkId}.`);
    if (!this.appearances.has(object.appearanceId)) throw new Error(`Unknown appearance ${object.appearanceId}.`);
    if (object.appearanceRuleId && !this.appearanceRules.has(object.appearanceRuleId)) {
      throw new Error(`Unknown appearance rule ${object.appearanceRuleId}.`);
    }
    this.objects.set(objectId, cloneObject(object));
  }

  _addAppearance(appearance: Appearance): void {
    if (this.appearances.has(appearance.id)) throw new Error(`Appearance ${appearance.id} already exists.`);
    this.appearances.set(appearance.id, cloneAppearance(appearance));
  }

  _removeAppearance(appearanceId: EntityId): void {
    if ([...this.objects.values()].some((item) => item.appearanceId === appearanceId)) {
      throw new Error(`Cannot remove appearance ${appearanceId} while it is in use.`);
    }
    this.appearances.delete(appearanceId);
  }

  _setAppearance(appearanceId: EntityId, appearance: Appearance): void {
    if (!this.appearances.has(appearanceId)) throw new Error(`Unknown appearance ${appearanceId}.`);
    if (appearance.id !== appearanceId) throw new Error('Appearance cannot change its entity ID.');
    this.appearances.set(appearanceId, cloneAppearance(appearance));
  }

  _setLayerIsolation(layerId?: EntityId): void {
    if (layerId && !this.layers.has(layerId)) throw new Error(`Unknown layer ${layerId}.`);
    this.isolatedLayerId = layerId;
  }

  _setActiveLocation(pageId: EntityId, artboardId: EntityId): void {
    const page = this.getPage(pageId);
    const artboard = this.artboards.get(artboardId);
    if (!page || !artboard || artboard.pageId !== pageId || !page.artboardIds.includes(artboardId)) {
      throw new Error('Active artboard must belong to the active page.');
    }
    this.activePageId = pageId;
    this.activeArtboardId = artboardId;
  }

  private layerContainer(parentId: EntityId | undefined, artboardId: EntityId): EntityId[] {
    if (parentId) {
      const parent = this.layers.get(parentId);
      if (!parent) throw new Error(`Unknown parent layer ${parentId}.`);
      if (parent.kind === 'object') throw new Error('Object layers cannot contain children.');
      return parent.childIds;
    }
    const artboard = this.artboards.get(artboardId);
    if (!artboard) throw new Error(`Unknown artboard ${artboardId}.`);
    return artboard.layerIds;
  }

  private layerContains(layerId: EntityId, candidateId: EntityId): boolean {
    const layer = this.layers.get(layerId);
    if (!layer) return false;
    return layer.childIds.some((childId) => childId === candidateId || this.layerContains(childId, candidateId));
  }

  private updateDescendantArtboard(layer: LayerNode, artboardId: EntityId): void {
    for (const childId of layer.childIds) {
      const child = this.layers.get(childId);
      if (!child) continue;
      child.artboardId = artboardId;
      this.updateDescendantArtboard(child, artboardId);
    }
  }

  private attachConstraint(constraint: Constraint): void {
    const nodeIds = new Set<EntityId>();
    for (const targetId of constraint.targetIds) {
      if (this.nodes.has(targetId)) nodeIds.add(targetId);
      const segment = this.segments.get(targetId);
      if (segment) {
        nodeIds.add(segment.startNodeId);
        nodeIds.add(segment.endNodeId);
      }
    }
    for (const nodeId of nodeIds) {
      const node = this.nodes.get(nodeId);
      if (node && !node.constraintIds.includes(constraint.id)) node.constraintIds.push(constraint.id);
    }
  }

  private requireNode(id: EntityId): VectorNode {
    const node = this.nodes.get(id);
    if (!node) throw new Error(`Unknown node ${id}.`);
    return node;
  }

  private requirePath(id: EntityId): VectorPath {
    const path = this.paths.get(id);
    if (!path) throw new Error(`Unknown path ${id}.`);
    return path;
  }

  private requireNetwork(id: EntityId): VectorNetwork {
    const network = this.getNetwork(id);
    if (!network) throw new Error(`Unknown network ${id}.`);
    return network;
  }
}

function insertAt<T>(items: T[], value: T, index?: number): void {
  if (index === undefined || index < 0 || index > items.length) items.push(value);
  else items.splice(index, 0, value);
}

function removeValue<T>(items: T[], value: T): void {
  const index = items.indexOf(value);
  if (index >= 0) items.splice(index, 1);
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

function migrateStoredSegment(segment: StoredSegment, version: DocumentSnapshot['version']): Segment {
  const migrated = {
    ...segment,
    role: version <= 5 ? 'geometry' : segment.role,
    constructionExtent: version <= 5 ? undefined : segment.constructionExtent,
    center: segment.center ? { ...segment.center } : undefined,
    widthProfile: segment.widthProfile?.map((point) => ({ ...point })),
  } as Segment;
  validateSegmentGeometry(migrated);
  return cloneSegment(migrated);
}

function validateConstructionAnchors(
  segment: Segment,
  start: VectorNode | undefined,
  end: VectorNode | undefined,
): void {
  if (!start || !end) {
    throw new Error(`Construction segment ${segment.id} requires valid endpoint nodes.`);
  }
  if (Math.hypot(end.position.x - start.position.x, end.position.y - start.position.y) < 1e-6) {
    throw new Error(`Construction segment ${segment.id} requires two distinct anchor nodes.`);
  }
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
    transform:
      group.transform.type === 'mirror'
        ? { ...group.transform, origin: { ...group.transform.origin } }
        : { ...group.transform, center: { ...group.transform.center } },
  };
}

function cloneRegion(region: Region): Region {
  const legacyOutline = region.outline?.map((point) => ({ ...point })) ?? [];
  const legacyEdges = region.boundaryEdges?.map((edge) => ({
    ...edge,
    start: { ...edge.start },
    end: { ...edge.end },
  })) ?? [];
  const outerLoop = region.outerLoop
    ? {
        boundarySegmentIds: [...region.outerLoop.boundarySegmentIds],
        boundaryEdges: region.outerLoop.boundaryEdges.map((edge) => ({
          ...edge, start: { ...edge.start }, end: { ...edge.end },
        })),
        outline: region.outerLoop.outline.map((point) => ({ ...point })),
        signedArea: region.outerLoop.signedArea,
      }
    : {
        boundarySegmentIds: [...region.boundarySegmentIds],
        boundaryEdges: legacyEdges.map((edge) => ({
          ...edge, start: { ...edge.start }, end: { ...edge.end },
        })),
        outline: legacyOutline.map((point) => ({ ...point })),
        signedArea: signedPolygonArea(legacyOutline),
      };
  const innerLoops = (region.innerLoops ?? []).map((loop) => ({
    boundarySegmentIds: [...loop.boundarySegmentIds],
    boundaryEdges: loop.boundaryEdges.map((edge) => ({
      ...edge, start: { ...edge.start }, end: { ...edge.end },
    })),
    outline: loop.outline.map((point) => ({ ...point })),
    signedArea: loop.signedArea,
  }));
  return {
    ...region,
    boundarySegmentIds: [...region.boundarySegmentIds],
    fillRule: region.fillRule === 'evenodd' ? 'evenodd' : 'nonzero',
    outerLoop,
    innerLoops,
    boundaryEdges: legacyEdges.length > 0
      ? legacyEdges
      : [outerLoop, ...innerLoops].flatMap((loop) => loop.boundaryEdges.map((edge) => ({
          ...edge, start: { ...edge.start }, end: { ...edge.end },
        }))),
    outline: legacyOutline.length > 0 ? legacyOutline : outerLoop.outline.map((point) => ({ ...point })),
    // The pre-Gate-C union advertised gradients without a gradient model. Migrate
    // any such stored record deterministically to the implemented solid color.
    fill: region.fill
      ? { type: 'solid', color: typeof region.fill.color === 'string' ? region.fill.color : '#8b6cf6' }
      : undefined,
  };
}

function cloneExportMetadata(metadata: DocumentExportMetadata): DocumentExportMetadata {
  const cloneSettings = (settings: NonNullable<DocumentExportMetadata['lastUsed']>) => ({
    ...settings,
    formats: [...settings.formats],
    pngScales: [...settings.pngScales],
    customSize: settings.customSize ? { ...settings.customSize } : undefined,
  });
  return {
    lastUsed: metadata.lastUsed ? cloneSettings(metadata.lastUsed) : undefined,
    presets: (metadata.presets ?? []).map((preset) => ({
      ...preset,
      settings: cloneSettings(preset.settings),
    })),
  };
}

function clonePage(page: DocumentPage): DocumentPage {
  return { ...page, artboardIds: [...page.artboardIds] };
}

function cloneArtboard(artboard: Artboard): Artboard {
  return { ...artboard, frame: { ...artboard.frame }, layerIds: [...artboard.layerIds] };
}

function cloneLayer(layer: LayerNode): LayerNode {
  return { ...layer, childIds: [...layer.childIds] };
}

function cloneObject(object: NetworkObject): NetworkObject {
  return { ...object, transform: { ...object.transform } };
}

function cloneAppearance(appearance: Appearance): Appearance {
  return {
    ...appearance,
    fills: appearance.fills.map((fill) => ({ ...fill })),
    stroke: appearance.stroke ? { ...appearance.stroke, dash: [...appearance.stroke.dash] } : undefined,
  };
}

function cloneAppearanceRule(rule: AppearanceRule): AppearanceRule {
  return {
    ...rule,
    appearance: {
      fills: rule.appearance.fills.map((fill) => ({ ...fill })),
      stroke: rule.appearance.stroke
        ? { ...rule.appearance.stroke, dash: [...rule.appearance.stroke.dash] }
        : undefined,
      opacity: rule.appearance.opacity,
    },
  };
}

function cloneGeometryVariantLink(variant: GeometryVariantLink): GeometryVariantLink {
  return {
    ...variant,
    nodeMap: { ...variant.nodeMap },
    segmentMap: { ...variant.segmentMap },
    pathMap: { ...variant.pathMap },
    overriddenNodeIds: [...variant.overriddenNodeIds],
    overriddenSegmentIds: [...variant.overriddenSegmentIds],
    omittedSourceNodeIds: [...(variant.omittedSourceNodeIds ?? [])],
    omittedSourceSegmentIds: [...(variant.omittedSourceSegmentIds ?? [])],
    omittedSourcePathIds: [...(variant.omittedSourcePathIds ?? [])],
    localNodeIds: [...(variant.localNodeIds ?? [])],
    localSegmentIds: [...(variant.localSegmentIds ?? [])],
    localPathIds: [...(variant.localPathIds ?? [])],
  };
}

function cloneGeometryComponent(component: GeometryComponent): GeometryComponent {
  return {
    ...component,
    variants: component.variants.map(cloneGeometryVariantLink),
    lastQa: component.lastQa
      ? { ...component.lastQa, appliedFixes: [...component.lastQa.appliedFixes] }
      : undefined,
  };
}

function assertValidGeometryComponent(
  document: VectorDocument,
  component: GeometryComponent,
  replacementId?: EntityId,
): void {
  if (!component.name.trim()) throw new Error('Geometry component requires a name.');
  const sourceObject = document.getObject(component.sourceObjectId);
  if (!sourceObject) throw new Error(`Unknown geometry source object ${component.sourceObjectId}.`);
  if (component.lastQa) {
    if (!Number.isFinite(component.lastQa.checkedAt) || component.lastQa.checkedAt < 0) {
      throw new Error('Geometry component QA timestamp must be finite and non-negative.');
    }
    if (!Number.isInteger(component.lastQa.remainingIssueCount) || component.lastQa.remainingIssueCount < 0) {
      throw new Error('Geometry component QA issue count must be a non-negative integer.');
    }
    if (component.lastQa.appliedFixes.some((summary) => !summary.trim())) {
      throw new Error('Geometry component QA fix summaries cannot be blank.');
    }
  }

  const memberObjectIds = new Set<EntityId>([component.sourceObjectId]);
  const variantIds = new Set<EntityId>();
  for (const variant of component.variants) {
    if (variantIds.has(variant.id)) throw new Error(`Duplicate geometry variant ${variant.id}.`);
    variantIds.add(variant.id);
    if (!document.getObject(variant.objectId)) {
      throw new Error(`Unknown geometry variant object ${variant.objectId}.`);
    }
    if (memberObjectIds.has(variant.objectId)) {
      throw new Error(`Object ${variant.objectId} cannot occur twice in a geometry component.`);
    }
    memberObjectIds.add(variant.objectId);
    if (new Set(Object.values(variant.nodeMap)).size !== Object.keys(variant.nodeMap).length) {
      throw new Error(`Geometry variant ${variant.id} has an ambiguous node map.`);
    }
    if (new Set(Object.values(variant.segmentMap)).size !== Object.keys(variant.segmentMap).length) {
      throw new Error(`Geometry variant ${variant.id} has an ambiguous segment map.`);
    }
    if (new Set(Object.values(variant.pathMap)).size !== Object.keys(variant.pathMap).length) {
      throw new Error(`Geometry variant ${variant.id} has an ambiguous path map.`);
    }
    for (const nodeId of variant.overriddenNodeIds) {
      if (!(nodeId in variant.nodeMap)) {
        throw new Error(`Override node ${nodeId} is not mapped by geometry variant ${variant.id}.`);
      }
    }
    for (const segmentId of variant.overriddenSegmentIds) {
      if (!(segmentId in variant.segmentMap)) {
        throw new Error(`Override segment ${segmentId} is not mapped by geometry variant ${variant.id}.`);
      }
    }
    assertDisjointTopologyIds(
      Object.keys(variant.nodeMap),
      variant.omittedSourceNodeIds ?? [],
      `source node records in geometry variant ${variant.id}`,
    );
    assertDisjointTopologyIds(
      Object.keys(variant.segmentMap),
      variant.omittedSourceSegmentIds ?? [],
      `source segment records in geometry variant ${variant.id}`,
    );
    assertDisjointTopologyIds(
      Object.keys(variant.pathMap),
      variant.omittedSourcePathIds ?? [],
      `source path records in geometry variant ${variant.id}`,
    );
    assertDisjointTopologyIds(
      Object.values(variant.nodeMap),
      variant.localNodeIds ?? [],
      `variant node records in geometry variant ${variant.id}`,
    );
    assertDisjointTopologyIds(
      Object.values(variant.segmentMap),
      variant.localSegmentIds ?? [],
      `variant segment records in geometry variant ${variant.id}`,
    );
    assertDisjointTopologyIds(
      Object.values(variant.pathMap),
      variant.localPathIds ?? [],
      `variant path records in geometry variant ${variant.id}`,
    );
  }

  for (const existing of document.geometryComponents.values()) {
    if (existing.id === replacementId) continue;
    const existingObjectIds = new Set([
      existing.sourceObjectId,
      ...existing.variants.map((variant) => variant.objectId),
    ]);
    for (const objectId of memberObjectIds) {
      if (existingObjectIds.has(objectId)) {
        throw new Error(`Object ${objectId} already belongs to geometry component ${existing.id}.`);
      }
    }
  }
}

function assertDisjointTopologyIds(
  inheritedIds: EntityId[],
  localIds: EntityId[],
  label: string,
): void {
  if (new Set(localIds).size !== localIds.length) {
    throw new Error(`Duplicate ${label}.`);
  }
  const inherited = new Set(inheritedIds);
  if (localIds.some((id) => inherited.has(id))) {
    throw new Error(`Inherited and local ${label} must be disjoint.`);
  }
}

function appearanceFromRule(appearanceId: EntityId, rule: AppearanceRule): Appearance {
  return cloneAppearance({ ...rule.appearance, id: appearanceId });
}

function createMigratedStructure(documentId: EntityId, networks: VectorNetwork[]): {
  pages: DocumentPage[];
  artboards: Map<EntityId, Artboard>;
  layers: Map<EntityId, LayerNode>;
  objects: Map<EntityId, NetworkObject>;
  appearances: Map<EntityId, Appearance>;
  activePageId: EntityId;
  activeArtboardId: EntityId;
} {
  // IDs are derived rather than random so all clients migrate an old snapshot identically.
  const pageId = `${documentId}:page:1`;
  const artboardId = `${documentId}:artboard:1`;
  const rootLayerId = `${documentId}:layer:1`;
  const pages: DocumentPage[] = [{ id: pageId, name: 'Page 1', artboardIds: [artboardId] }];
  const objectLayerIds: EntityId[] = [];
  const layers = new Map<EntityId, LayerNode>();
  const objects = new Map<EntityId, NetworkObject>();
  const appearances = new Map<EntityId, Appearance>();

  networks.forEach((network, index) => {
    const objectId = `${network.id}:object`;
    const layerId = `${network.id}:object-layer`;
    const appearanceId = `${network.id}:appearance`;
    objectLayerIds.push(layerId);
    appearances.set(appearanceId, {
      id: appearanceId,
      fills: [],
      stroke: {
        color: '#c8ced9',
        width: 1.25,
        cap: 'round',
        join: 'round',
        alignment: 'center',
        opacity: 1,
        dash: [],
        visible: true,
      },
      opacity: 1,
    });
    objects.set(objectId, {
      id: objectId,
      name: `Vector Network ${index + 1}`,
      networkId: network.id,
      appearanceId,
      transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
    });
    layers.set(layerId, {
      id: layerId,
      kind: 'object',
      name: `Vector Network ${index + 1}`,
      artboardId,
      parentId: rootLayerId,
      childIds: [],
      objectId,
      visible: true,
      locked: false,
      expanded: true,
    });
  });

  layers.set(rootLayerId, {
    id: rootLayerId,
    kind: 'layer',
    name: 'Layer 1',
    artboardId,
    childIds: objectLayerIds,
    visible: true,
    locked: false,
    expanded: true,
  });
  const artboards = new Map<EntityId, Artboard>([[artboardId, {
    id: artboardId,
    pageId,
    name: 'Artboard 1',
    frame: { x: -512, y: -384, width: 1024, height: 768 },
    layerIds: [rootLayerId],
    background: '#ffffff',
    clipContent: false,
  }]]);
  return {
    pages,
    artboards,
    layers,
    objects,
    appearances,
    activePageId: pageId,
    activeArtboardId: artboardId,
  };
}
