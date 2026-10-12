import { describe, expect, it } from 'vitest';
import { VectorDocument } from './document';
import { OperationManager } from './operations';
import { isConstructionSegment, isGeometrySegment, pathHasConstruction } from './segment-semantics';
import type { Appearance, DocumentSnapshot, LayerNode, NetworkObject, Segment } from './types';

describe('snapshot v6 professional document foundation', () => {
  it('migrates a v1–5 snapshot deterministically without changing graph identities', () => {
    const source = VectorDocument.createEmpty();
    const manager = new OperationManager(source);
    manager.execute({
      type: 'ADD_NODE',
      payload: {
        node: { id: 'legacy-node', position: { x: 14, y: 9 }, constraintIds: [] },
        networkId: source.activeNetwork.id,
      },
    });
    const current = source.toSnapshot();
    const legacy: DocumentSnapshot = {
      version: 4,
      id: current.id,
      networks: current.networks,
      nodes: current.nodes,
      segments: current.segments,
      paths: current.paths,
      regions: current.regions,
      constraints: current.constraints,
      parametricGroups: current.parametricGroups,
      exportVariables: current.exportVariables,
      variables: current.variables,
    };

    const first = new VectorDocument(legacy);
    const second = new VectorDocument(legacy);
    expect(first.toSnapshot()).toEqual(second.toSnapshot());
    expect(first.toSnapshot().version).toBe(6);
    expect(first.getNode('legacy-node')?.position).toEqual({ x: 14, y: 9 });
    expect(first.activePage.name).toBe('Page 1');
    expect(first.activeArtboard.name).toBe('Artboard 1');
    expect(first.objects.size).toBe(1);
    expect(first.appearances.size).toBe(1);
    expect(first.getObjectForNetwork(first.activeNetwork.id)?.name).toBe('Vector Network 1');
  });

  it('defaults every v1–v5 stored segment to geometry and emits v6', () => {
    const source = VectorDocument.createEmpty();
    const manager = new OperationManager(source);
    const networkId = source.activeNetwork.id;
    manager.beginTransaction('Legacy line fixture');
    manager.execute({
      type: 'ADD_NODE',
      payload: { node: { id: 'legacy-a', position: { x: 0, y: 0 }, constraintIds: [] }, networkId },
    });
    manager.execute({
      type: 'ADD_NODE',
      payload: { node: { id: 'legacy-b', position: { x: 40, y: 0 }, constraintIds: [] }, networkId },
    });
    manager.execute({
      type: 'ADD_PATH',
      payload: { path: { id: 'legacy-path', segmentIds: [], isClosed: false }, networkId },
    });
    manager.execute({
      type: 'ADD_SEGMENT',
      payload: {
        segment: {
          id: 'legacy-segment', startNodeId: 'legacy-a', endNodeId: 'legacy-b',
          type: 'line', role: 'geometry',
        },
        pathId: 'legacy-path',
      },
    });
    manager.commitTransaction();
    const current = source.toSnapshot();
    const legacySegments = current.segments.map(([id, segment]) => {
      const { role: _role, constructionExtent: _extent, ...legacy } = segment;
      return [id, legacy] as DocumentSnapshot['segments'][number];
    });

    for (const version of [1, 2, 3, 4, 5] as const) {
      const restored = new VectorDocument({ ...current, version, segments: legacySegments });
      expect(restored.getSegment('legacy-segment')).toMatchObject({
        id: 'legacy-segment',
        role: 'geometry',
        constructionExtent: undefined,
      });
      expect(restored.toSnapshot().version).toBe(6);
      expect(restored.toSnapshot().segments[0][1].role).toBe('geometry');
    }
  });

  it('round-trips finite and infinite v6 construction lines', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const networkId = document.activeNetwork.id;
    manager.beginTransaction('Construction fixtures');
    for (const node of [
      { id: 'finite-a', position: { x: 0, y: 0 }, constraintIds: [] },
      { id: 'finite-b', position: { x: 40, y: 0 }, constraintIds: [] },
      { id: 'infinite-a', position: { x: 10, y: 20 }, constraintIds: [] },
      { id: 'infinite-b', position: { x: 30, y: 50 }, constraintIds: [] },
    ]) manager.execute({ type: 'ADD_NODE', payload: { node, networkId } });
    manager.execute({
      type: 'ADD_PATH',
      payload: { path: { id: 'construction-path', segmentIds: [], isClosed: false }, networkId },
    });
    const segments: Segment[] = [
      {
        id: 'finite-guide', startNodeId: 'finite-a', endNodeId: 'finite-b',
        type: 'line', role: 'construction', constructionExtent: 'finite',
      },
      {
        id: 'infinite-guide', startNodeId: 'infinite-a', endNodeId: 'infinite-b',
        type: 'line', role: 'construction', constructionExtent: 'infinite',
      },
    ];
    for (const segment of segments) {
      manager.execute({ type: 'ADD_SEGMENT', payload: { segment, pathId: 'construction-path' } });
    }
    manager.commitTransaction();

    const snapshot = document.toSnapshot();
    const restored = new VectorDocument(snapshot);
    expect(snapshot.version).toBe(6);
    expect(restored.getSegment('finite-guide')).toMatchObject({
      role: 'construction', constructionExtent: 'finite',
    });
    expect(restored.getSegment('infinite-guide')).toMatchObject({
      role: 'construction', constructionExtent: 'infinite',
    });
    expect(isConstructionSegment(restored.getSegment('finite-guide')!)).toBe(true);
    expect(isGeometrySegment(restored.getSegment('finite-guide')!)).toBe(false);
    expect(pathHasConstruction(restored, 'construction-path')).toBe(true);
    expect(restored.toSnapshot()).toEqual(snapshot);
  });

  it('rejects malformed v6 construction records during migration', () => {
    const base = VectorDocument.createEmpty().toSnapshot();
    base.nodes.push(
      ['guide-a', { id: 'guide-a', position: { x: 0, y: 0 }, constraintIds: [] }],
      ['guide-b', { id: 'guide-b', position: { x: 20, y: 0 }, constraintIds: [] }],
    );
    base.networks[0].nodeIds.push('guide-a', 'guide-b');

    const valid = {
      id: 'guide', startNodeId: 'guide-a', endNodeId: 'guide-b',
      type: 'line' as const, role: 'construction' as const, constructionExtent: 'infinite' as const,
    };
    expect(() => new VectorDocument({
      ...base,
      segments: [['guide', { ...valid, role: undefined }]],
    })).toThrow('requires a valid geometry or construction role');
    expect(() => new VectorDocument({
      ...base,
      segments: [['guide', { ...valid, constructionExtent: undefined }]],
    })).toThrow('requires a finite or infinite extent');
    expect(() => new VectorDocument({
      ...base,
      segments: [['guide', { ...valid, type: 'arc' }]],
    })).toThrow('must be a straight line');
    expect(() => new VectorDocument({
      ...base,
      nodes: base.nodes.map(([id, node]) => id === 'guide-b'
        ? [id, { ...node, position: { x: 0, y: 0 } }]
        : [id, node]),
      segments: [['guide', valid]],
    })).toThrow('requires two distinct anchor nodes');
  });

  it('round-trips independent hierarchy and appearance records without shared references', () => {
    const document = VectorDocument.createEmpty();
    const snapshot = document.toSnapshot();
    const restored = new VectorDocument(snapshot);
    const object = [...restored.objects.values()][0];
    const appearance = restored.getAppearance(object.appearanceId)!;
    const layer = restored.getLayerForObject(object.id)!;

    appearance.stroke!.dash.push(4);
    layer.name = 'Changed after restore';
    object.transform.x = 40;

    expect(snapshot.appearances?.[0][1].stroke?.dash).toEqual([]);
    expect(snapshot.layers?.find(([id]) => id === layer.id)?.[1].name).not.toBe(layer.name);
    expect(snapshot.objects?.[0][1].transform.x).toBe(0);
  });

  it('undoes and redoes hierarchy, object, transform, and appearance operations', () => {
    const document = VectorDocument.createEmpty();
    const root = document.getLayer(document.activeArtboard.layerIds[0])!;
    const appearance: Appearance = {
      id: 'appearance-new',
      fills: [{ type: 'solid', color: '#ff3366', opacity: 1, visible: true }],
      stroke: {
        color: '#111111', width: 2, cap: 'square', join: 'bevel', alignment: 'center',
        opacity: 0.8, dash: [4, 2], visible: true,
      },
      opacity: 0.75,
    };
    const secondNetwork = { id: 'network-new', nodeIds: [], pathIds: [] };
    // Network creation remains a graph concern; use a v6 fixture to isolate document operations.
    const seeded = document.toSnapshot();
    seeded.networks.push(secondNetwork);
    const seededDocument = new VectorDocument(seeded);
    const seededManager = new OperationManager(seededDocument);
    const object: NetworkObject = {
      id: 'object-new', name: 'Logo mark', networkId: secondNetwork.id, appearanceId: appearance.id,
      transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
    };
    const layer: LayerNode = {
      id: 'layer-new', kind: 'object', name: 'Logo mark', artboardId: seededDocument.activeArtboardId,
      parentId: root.id, childIds: [], objectId: object.id, visible: true, locked: false, expanded: true,
    };

    seededManager.beginTransaction('Create styled object');
    seededManager.execute({ type: 'ADD_APPEARANCE', payload: { appearance } });
    seededManager.execute({ type: 'ADD_OBJECT', payload: { object } });
    seededManager.execute({ type: 'ADD_LAYER', payload: { layer } });
    seededManager.execute({
      type: 'UPDATE_OBJECT',
      payload: { objectId: object.id, updates: { transform: { ...object.transform, x: 120, y: -30 } } },
    });
    seededManager.commitTransaction();

    expect(seededDocument.getObject(object.id)?.transform).toMatchObject({ x: 120, y: -30 });
    expect(seededDocument.getAppearance(appearance.id)?.stroke?.dash).toEqual([4, 2]);
    expect(seededDocument.getLayer(root.id)?.childIds).toContain(layer.id);

    expect(seededManager.undo()).toBe(true);
    expect(seededDocument.getLayer(layer.id)).toBeUndefined();
    expect(seededDocument.getObject(object.id)).toBeUndefined();
    expect(seededDocument.getAppearance(appearance.id)).toBeUndefined();

    expect(seededManager.redo()).toBe(true);
    expect(seededDocument.getObject(object.id)?.name).toBe('Logo mark');
    expect(seededDocument.getObject(object.id)?.transform.x).toBe(120);
  });

  it('moves and updates layers through serializable operations and restores ordering on undo', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const artboard = document.activeArtboard;
    const root = document.getLayer(artboard.layerIds[0])!;
    const group: LayerNode = {
      id: 'group-a', kind: 'group', name: 'Marks', artboardId: artboard.id,
      childIds: [], visible: true, locked: false, expanded: true,
    };
    manager.execute({ type: 'ADD_LAYER', payload: { layer: group, index: 0 } });
    manager.execute({ type: 'MOVE_LAYER', payload: { layerId: root.id, parentId: group.id, artboardId: artboard.id } });
    manager.execute({ type: 'UPDATE_LAYER', payload: { layerId: group.id, updates: { name: 'Primary marks', locked: true } } });

    expect(document.getLayer(group.id)?.childIds).toEqual([root.id]);
    expect(document.activeArtboard.layerIds).toEqual([group.id]);
    expect(document.getLayer(group.id)).toMatchObject({ name: 'Primary marks', locked: true });

    manager.undo();
    manager.undo();
    expect(document.activeArtboard.layerIds).toEqual([group.id, root.id]);
    expect(document.getLayer(root.id)?.parentId).toBeUndefined();
  });

  it('creates, renames, reorders, activates, and removes pages and artboards through operations', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const originalPage = document.activePage;
    const page = { id: 'page-two', name: 'Page 2', artboardIds: [] };
    const first = {
      id: 'artboard-two-a', pageId: page.id, name: 'Front',
      frame: { x: 0, y: 0, width: 800, height: 600 }, background: '#ffffff', clipContent: true, layerIds: [],
    };
    const second = { ...first, id: 'artboard-two-b', name: 'Back', frame: { ...first.frame, x: 40 } };
    manager.beginTransaction('Create page and artboards');
    manager.execute({ type: 'ADD_PAGE', payload: { page } });
    manager.execute({ type: 'ADD_ARTBOARD', payload: { artboard: first, pageId: page.id } });
    manager.execute({ type: 'ADD_ARTBOARD', payload: { artboard: second, pageId: page.id } });
    manager.execute({ type: 'SET_ACTIVE_LOCATION', payload: { pageId: page.id, artboardId: first.id } });
    manager.commitTransaction();
    manager.execute({ type: 'UPDATE_PAGE', payload: { pageId: page.id, updates: { name: 'Brand system' } } });
    manager.execute({ type: 'UPDATE_ARTBOARD', payload: { artboardId: first.id, updates: { name: 'Primary front' } } });
    manager.execute({ type: 'MOVE_PAGE', payload: { pageId: page.id, index: 0 } });
    manager.execute({ type: 'MOVE_ARTBOARD', payload: { artboardId: second.id, pageId: page.id, index: 0 } });

    expect(document.pages.map((item) => item.id)).toEqual([page.id, originalPage.id]);
    expect(document.activePage.name).toBe('Brand system');
    expect(document.activePage.artboardIds).toEqual([second.id, first.id]);
    expect(document.getArtboard(first.id)?.name).toBe('Primary front');
    manager.undo();
    expect(document.activePage.artboardIds).toEqual([first.id, second.id]);
    manager.redo();
    expect(document.activePage.artboardIds[0]).toBe(second.id);
  });
});
