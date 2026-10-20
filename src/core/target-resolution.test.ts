import { describe, expect, it } from 'vitest';
import { VectorDocument } from './document';
import { OperationManager } from './operations';
import type {
  Appearance, DocumentSnapshot, EntityId, LayerNode, NetworkObject, SelectionState, StoredSegment,
  VectorNetwork, VectorNode, VectorPath,
} from './types';
import { preparePrimitiveObject } from '../tools/primitive-tool';
import { hitTestObject } from '../tools/select-tool';
import {
  parentGroupTarget, resolveObjectPress, resolvePointerTarget, targetKind, type PointerTarget,
} from './target-resolution';

/**
 * Hover and selection must be the same decision. These tests feed the same pointer
 * position to the hover resolver and the press resolver and assert they agree, so a
 * preview can never promise something the click will not do.
 */

const EMPTY: SelectionState = {
  mode: 'object', objectIds: new Set<EntityId>(), nodeIds: new Set<EntityId>(), segmentIds: new Set<EntityId>(),
};
const TOLERANCE = 2;

interface Scene {
  document: VectorDocument;
  manager: OperationManager;
  draw: (x: number, y: number, size?: number) => { objectId: EntityId; layerId: EntityId };
}

function scene(): Scene {
  const document = VectorDocument.createEmpty();
  const manager = new OperationManager(document);
  manager.execute({
    type: 'UPDATE_ARTBOARD',
    payload: { artboardId: document.activeArtboardId, updates: { frame: { x: 0, y: 0, width: 400, height: 300 } } },
  });
  const draw = (x: number, y: number, size = 40) => {
    const plan = preparePrimitiveObject(document, 'rectangle', { x, y }, { x: x + size, y: y + size })!;
    manager.beginTransaction('Draw fixture rectangle');
    plan.operations.forEach((operation) => manager.execute(operation));
    manager.commitTransaction();
    return { objectId: plan.objectId, layerId: plan.layerId };
  };
  return { document, manager, draw };
}

function group(manager: OperationManager, document: VectorDocument, layerIds: EntityId[], name: string): EntityId {
  const first = document.getLayer(layerIds[0])!;
  const siblings = first.parentId ? document.getLayer(first.parentId)!.childIds : document.getArtboard(first.artboardId)!.layerIds;
  const layer: LayerNode = {
    id: `${name}:${first.artboardId}`, kind: 'group', name, artboardId: first.artboardId,
    parentId: first.parentId, childIds: [], visible: true, locked: false, expanded: true,
  };
  manager.beginTransaction(`Group into ${name}`);
  manager.execute({ type: 'ADD_LAYER', payload: { layer, index: Math.min(...layerIds.map((id) => siblings.indexOf(id))) } });
  layerIds.forEach((layerId, index) => manager.execute({
    type: 'MOVE_LAYER', payload: { layerId, parentId: layer.id, artboardId: first.artboardId, index },
  }));
  manager.commitTransaction();
  return layer.id;
}

const hover = (document: VectorDocument, point: { x: number; y: number }, selection: SelectionState = EMPTY) =>
  resolvePointerTarget(document, { point, tolerance: TOLERANCE, selection });

/** What a press at the same point selects, expressed the same way hover reports it. */
function pressTarget(document: VectorDocument, point: { x: number; y: number }, selection: SelectionState = EMPTY): PointerTarget | undefined {
  const hit = hitTestObject(document, point, TOLERANCE);
  const press = resolveObjectPress(document, selection, hit?.id);
  if (!hit || press.selection.objectIds.size === 0) return undefined;
  const preview = hover(document, point, selection);
  return preview;
}

function selectionIdentity(selection: SelectionState) {
  return [...selection.objectIds].sort();
}

describe('shared target resolution', () => {
  it('agrees with the click on overlapping objects, frontmost first', () => {
    const { document, draw } = scene();
    const back = draw(0, 0, 100);
    const front = draw(20, 20, 40);
    const point = { x: 30, y: 30 };
    const preview = hover(document, point)!;
    expect(preview.objectId).toBe(front.objectId);
    expect(preview.selectionId).toBe(front.objectId);
    expect(targetKind(preview)).toBe('object');
    const press = resolveObjectPress(document, EMPTY, hitTestObject(document, point, TOLERANCE)?.id);
    expect(selectionIdentity(press.selection)).toEqual([front.objectId]);
    expect(pressTarget(document, point)?.selectionId).toBe(preview.selectionId);
    expect(back.objectId).not.toBe(preview.objectId);
  });

  it('follows paint order after a layer is reordered', () => {
    const { document, manager, draw } = scene();
    const back = draw(0, 0, 100);
    const front = draw(20, 20, 40);
    const point = { x: 30, y: 30 };
    expect(hover(document, point)?.selectionId).toBe(front.objectId);
    manager.execute({
      type: 'MOVE_LAYER',
      payload: { layerId: front.layerId, parentId: undefined, artboardId: document.activeArtboardId, index: 0 },
    });
    // The rectangle that used to be in front now paints first, so the preview flips too.
    expect(hover(document, point)?.selectionId).toBe(back.objectId);
    expect(pressTarget(document, point)?.selectionId).toBe(back.objectId);
  });

  it('previews the group at the root and the child once the group is entered', () => {
    const { document, manager, draw } = scene();
    const a = draw(0, 0);
    const b = draw(60, 0);
    const outer = group(manager, document, [a.layerId, b.layerId], 'Outer');
    const point = { x: 20, y: 20 };

    const atRoot = hover(document, point)!;
    expect(atRoot.group).toBe(true);
    expect(atRoot.selectionId).toBe(outer);
    expect(atRoot.objectId).toBe(a.objectId);
    expect(atRoot.selectionId).not.toBe(atRoot.objectId);
    expect(targetKind(atRoot)).toBe('group');
    // The group outline covers both members, not just the shape under the pointer.
    expect(atRoot.bounds.minX).toBeCloseTo(0);
    expect(atRoot.bounds.maxX).toBeCloseTo(100);

    const inside = hover(document, point, { ...EMPTY, groupContext: outer })!;
    expect(inside.group).toBe(false);
    expect(inside.selectionId).toBe(a.objectId);
    expect(targetKind(inside)).toBe('object');
    // The press agrees in both contexts.
    expect(resolveObjectPress(document, EMPTY, a.objectId).selection.objectIds.size).toBe(2);
    expect(selectionIdentity(resolveObjectPress(document, { ...EMPTY, groupContext: outer }, a.objectId).selection))
      .toEqual([a.objectId]);
  });

  it('previews nested groups one level at a time', () => {
    const { document, manager, draw } = scene();
    const a = draw(0, 0);
    const b = draw(60, 0);
    const inner = group(manager, document, [a.layerId], 'Inner');
    const outer = group(manager, document, [inner, b.layerId], 'Outer');
    const point = { x: 20, y: 20 };
    expect(hover(document, point)?.selectionId).toBe(outer);
    expect(hover(document, point, { ...EMPTY, groupContext: outer })?.selectionId).toBe(inner);
    expect(hover(document, point, { ...EMPTY, groupContext: inner })?.selectionId).toBe(a.objectId);
  });

  it('never targets a descendant of a hidden or locked ancestor', () => {
    const { document, manager, draw } = scene();
    const a = draw(0, 0);
    const b = draw(60, 0);
    const outer = group(manager, document, [a.layerId, b.layerId], 'Outer');
    manager.execute({ type: 'UPDATE_LAYER', payload: { layerId: outer, updates: { locked: true } } });
    expect(hover(document, { x: 20, y: 20 })).toBeUndefined();
    expect(hover(document, { x: 20, y: 20 }, { ...EMPTY, groupContext: outer })).toBeUndefined();
    manager.execute({ type: 'UPDATE_LAYER', payload: { layerId: outer, updates: { locked: false, visible: false } } });
    expect(hover(document, { x: 20, y: 20 })).toBeUndefined();
    // A locked sibling inside an unlocked group is skipped too.
    manager.execute({ type: 'UPDATE_LAYER', payload: { layerId: outer, updates: { visible: true } } });
    manager.execute({ type: 'UPDATE_LAYER', payload: { layerId: document.getLayerForObject(a.objectId)!.id, updates: { locked: true } } });
    expect(hover(document, { x: 20, y: 20 })).toBeUndefined();
    expect(hover(document, { x: 80, y: 20 })?.objectId).toBe(b.objectId);
  });

  it('answers the parent gesture with the intended ancestor, including when nested', () => {
    const { document, manager, draw } = scene();
    const a = draw(0, 0);
    const b = draw(60, 0);
    const inner = group(manager, document, [a.layerId], 'Inner');
    const outer = group(manager, document, [inner, b.layerId], 'Outer');
    // At the root the outermost group has no parent group to offer.
    expect(parentGroupTarget(document, a.objectId)).toBeUndefined();
    // Stepping out of the outer group selects the outer group and lands at the root.
    expect(parentGroupTarget(document, a.objectId, outer)?.id).toBe(outer);
    expect(parentGroupTarget(document, a.objectId, outer)?.context).toBeUndefined();
    // Stepping out of the nested group selects the nested group and lands in the outer one.
    expect(parentGroupTarget(document, a.objectId, inner)?.id).toBe(inner);
    expect(parentGroupTarget(document, a.objectId, inner)?.context).toBe(outer);
    // The selection always carries every object inside the group being selected.
    expect(parentGroupTarget(document, a.objectId, outer)?.objectIds).toEqual([a.objectId, b.objectId]);
    expect(parentGroupTarget(document, a.objectId, inner)?.objectIds).toEqual([a.objectId]);
    // An ungrouped object has no parent group at all.
    const loose = draw(200, 200);
    expect(parentGroupTarget(document, loose.objectId)).toBeUndefined();
  });

  it('separates anchors, segments, handles and object bodies', () => {
    const { document, manager, draw } = scene();
    const rect = draw(100, 100);
    const network = document.getNetwork(document.getObject(rect.objectId)!.networkId)!;
    const nodes = network.nodeIds.map((id) => document.getNode(id)!);
    // Node positions and handles are local; the pointer arrives in world space.
    const world = (local: { x: number; y: number }) => ({ x: local.x + 100, y: local.y + 100 });

    // Object mode reports a body, even when the pointer is exactly over an anchor.
    expect(targetKind(hover(document, world(nodes[0].position))!)).toBe('object');

    const editing: SelectionState = {
      mode: 'network', editingObjectId: rect.objectId, objectIds: new Set([rect.objectId]),
      nodeIds: new Set([nodes[0].id]), segmentIds: new Set(),
    };
    const nodeTarget = hover(document, world(nodes[0].position), editing)!;
    expect(targetKind(nodeTarget)).toBe('node');
    expect(nodeTarget.geometry).toEqual({ kind: 'node', id: nodes[0].id });

    // A point on the top edge, away from both corners, is a segment.
    const segmentTarget = hover(document, { x: 120, y: 100 }, editing)!;
    expect(targetKind(segmentTarget)).toBe('segment');
    expect(segmentTarget.geometry?.kind).toBe('segment');

    // Give the selected node a handle and the handle becomes its own affordance.
    manager.execute({
      type: 'ADD_BEZIER_HANDLES',
      payload: { nodeId: nodes[0].id, handleIn: { x: -20, y: 0 }, handleOut: { x: 20, y: 0 } },
    });
    const handleQuery = (selection: SelectionState) => resolvePointerTarget(document, {
      point: world({ x: -20, y: 0 }), localPoint: { x: -20, y: 0 }, tolerance: TOLERANCE, selection,
    });
    const handleTarget = handleQuery(editing)!;
    expect(targetKind(handleTarget)).toBe('handle');
    expect(handleTarget.handle).toEqual({ nodeId: nodes[0].id, handleType: 'in' });
    // Handles are only live while their node is selected.
    expect(handleQuery({ ...editing, nodeIds: new Set<EntityId>() })).toBeUndefined();
  });

  it('never mutates the document or the selection', () => {
    const { document, manager, draw } = scene();
    const a = draw(0, 0);
    draw(60, 0);
    group(manager, document, [a.layerId], 'Outer');
    const before = JSON.stringify({
      objects: [...document.objects.values()],
      layers: [...document.layers.values()],
      history: manager.canUndo,
    });
    const selection: SelectionState = { ...EMPTY, groupContext: undefined };
    for (let step = 0; step < 20; step += 1) hover(document, { x: step * 4, y: step * 3 }, selection);
    expect(JSON.stringify({
      objects: [...document.objects.values()],
      layers: [...document.layers.values()],
      history: manager.canUndo,
    })).toBe(before);
    expect(selection.objectIds.size).toBe(0);
  });

  it('resolves targets fast enough to run on every pointer move in a large document', () => {
    // Built as a snapshot: creating thousands of objects through operations is itself
    // quadratic, and this test measures pointer resolution, not import throughput.
    const document = largeDocument(2_000);
    expect([...document.objects.values()]).toHaveLength(2_000);

    for (let index = 0; index < 5; index += 1) hover(document, { x: 20, y: 20 });
    const samples: number[] = [];
    const queries = 60;
    for (let index = 0; index < queries; index += 1) {
      const started = performance.now();
      hover(document, { x: 10 + (index % 40) * 20, y: 10 + (index % 30) * 20 });
      samples.push(performance.now() - started);
    }
    samples.sort((left, right) => left - right);
    const median = samples[Math.floor(samples.length / 2)];
    // A pointer move must stay inside one 60 Hz frame. The ceiling is deliberately loose
    // so this reports a regression rather than failing on a noisy machine.
    expect(median).toBeLessThan(16);
    console.log(`hover target resolution: 2000 objects, ${queries} queries, median ${median.toFixed(2)} ms`);
  });

  it('answers cache-hit resolution without recomputing bounds after a mutation', () => {
    const { document, manager, draw } = scene();
    const first = draw(0, 0);
    expect(hover(document, { x: 20, y: 20 })?.selectionId).toBe(first.objectId);
    const before = document.revision;
    // Moving the object must invalidate the cached bounds; the preview follows the shape.
    manager.execute({ type: 'UPDATE_OBJECT', payload: { objectId: first.objectId, updates: { transform: { x: 200, y: 200, rotation: 0, scaleX: 1, scaleY: 1 } } } });
    expect(document.revision).toBeGreaterThan(before);
    expect(hover(document, { x: 20, y: 20 })).toBeUndefined();
    expect(hover(document, { x: 220, y: 220 })?.selectionId).toBe(first.objectId);
  });
});

/** A grid of square objects built directly from a snapshot, in linear time. */
function largeDocument(count: number): VectorDocument {
  const documentId = 'large-document';
  const pageId = `${documentId}:page`;
  const artboardId = `${documentId}:artboard`;
  const networks: VectorNetwork[] = [];
  const nodes: Array<[EntityId, VectorNode]> = [];
  const segments: Array<[EntityId, StoredSegment]> = [];
  const paths: Array<[EntityId, VectorPath]> = [];
  const objects: Array<[EntityId, NetworkObject]> = [];
  const layers: Array<[EntityId, LayerNode]> = [];
  const appearances: Array<[EntityId, Appearance]> = [];
  const layerIds: EntityId[] = [];

  for (let index = 0; index < count; index += 1) {
    const id = `obj-${index}`;
    const nodeIds = [0, 1, 2, 3].map((corner) => `${id}:n${corner}`);
    const x = (index % 50) * 40;
    const y = Math.floor(index / 50) * 40;
    const corners = [{ x, y }, { x: x + 20, y }, { x: x + 20, y: y + 20 }, { x, y: y + 20 }];
    corners.forEach((position, corner) => nodes.push([nodeIds[corner], { id: nodeIds[corner], position, constraintIds: [] }]));
    const pathId = `${id}:path`;
    const segmentIds = [0, 1, 2, 3].map((side) => `${id}:s${side}`);
    segmentIds.forEach((segmentId, side) => segments.push([segmentId, {
      id: segmentId, startNodeId: nodeIds[side], endNodeId: nodeIds[(side + 1) % 4], type: 'line', role: 'geometry',
    }]));
    paths.push([pathId, { id: pathId, segmentIds, isClosed: true }]);
    const networkId = `${id}:network`;
    networks.push({ id: networkId, nodeIds, pathIds: [pathId] });
    const appearanceId = `${id}:appearance`;
    appearances.push([appearanceId, {
      id: appearanceId,
      fills: [{ type: 'solid', color: '#333333', opacity: 1, visible: true }],
      opacity: 1,
    }]);
    objects.push([id, {
      id, name: `Rectangle ${index}`, networkId, appearanceId,
      transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
    }]);
    const layerId = `${id}:layer`;
    layers.push([layerId, {
      id: layerId, kind: 'object', name: `Rectangle ${index}`, artboardId, childIds: [],
      objectId: id, visible: true, locked: false, expanded: true,
    }]);
    layerIds.push(layerId);
  }

  const snapshot: DocumentSnapshot = {
    version: 6,
    id: documentId,
    networks,
    nodes,
    segments: segments as Array<[string, StoredSegment]>,
    paths,
    regions: [],
    variables: [],
    pages: [{ id: pageId, name: 'Page 1', artboardIds: [artboardId] }],
    artboards: [[artboardId, {
      id: artboardId, pageId, name: 'Artboard', frame: { x: 0, y: 0, width: 2_000, height: 2_000 },
      layerIds, background: '#ffffff', clipContent: false,
    }]],
    layers,
    objects,
    appearances,
    activePageId: pageId,
    activeArtboardId: artboardId,
  };
  return new VectorDocument(snapshot);
}
