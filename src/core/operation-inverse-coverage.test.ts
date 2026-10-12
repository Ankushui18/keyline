import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { VectorDocument } from './document';
import { OperationManager, type OperationInput, type OperationType } from './operations';
import type {
  Appearance,
  Artboard,
  Constraint,
  DocumentPage,
  ExportVariable,
  LayerNode,
  NetworkObject,
  ParametricGroup,
  Segment,
  VectorNetwork,
  VectorNode,
  VectorPath,
} from './types';

const declaredOperationTypes = [
  'ADD_NETWORK', 'REMOVE_NETWORK', 'ADD_NODE', 'REMOVE_NODE', 'MOVE_NODE', 'SET_NODE_MODES',
  'ADD_PATH', 'REMOVE_PATH', 'ADD_SEGMENT', 'REMOVE_SEGMENT', 'SET_PATH_CLOSED',
  'APPLY_GRAPH_PATCH', 'MERGE_REGIONS', 'EXTRACT_REGION', 'SUBTRACT_REGION',
  'SPLIT_SEGMENT', 'RESTORE_SPLIT_SEGMENT', 'CUT_PATHS', 'RESTORE_CUT_PATHS',
  'ADD_BEZIER_HANDLES', 'CONVERT_TO_BEZIER', 'ADJUST_HANDLE', 'RESTORE_BEND_STATE',
  'ADD_CONSTRAINT', 'REMOVE_CONSTRAINT', 'UPDATE_CONSTRAINT', 'SET_NODE_POSITIONS',
  'SET_SEGMENT_GEOMETRIES', 'SET_SEGMENT_ROLES', 'SET_SEGMENT_WIDTH_PROFILE',
  'ADD_PARAMETRIC_GROUP', 'REMOVE_PARAMETRIC_GROUP', 'UPDATE_PARAMETRIC_GROUP',
  'ADD_EXPORT_VARIABLE', 'UPDATE_EXPORT_VARIABLE', 'REMOVE_EXPORT_VARIABLE', 'UPDATE_EXPORT_METADATA',
  'ADD_APPEARANCE_RULE', 'REMOVE_APPEARANCE_RULE', 'UPDATE_APPEARANCE_RULE',
  'ADD_GEOMETRY_COMPONENT', 'REMOVE_GEOMETRY_COMPONENT', 'UPDATE_GEOMETRY_COMPONENT',
  'SET_REGION_FILL', 'SET_REGION_FILL_RULE',
  'ADD_PAGE', 'REMOVE_PAGE', 'UPDATE_PAGE', 'MOVE_PAGE',
  'ADD_ARTBOARD', 'REMOVE_ARTBOARD', 'UPDATE_ARTBOARD', 'UPDATE_ARTBOARD_DIMENSIONS', 'MOVE_ARTBOARD',
  'ADD_LAYER', 'REMOVE_LAYER', 'UPDATE_LAYER', 'MOVE_LAYER',
  'ADD_OBJECT', 'REMOVE_OBJECT', 'UPDATE_OBJECT',
  'ADD_APPEARANCE', 'REMOVE_APPEARANCE', 'UPDATE_APPEARANCE',
  'SET_LAYER_ISOLATION', 'SET_ACTIVE_LOCATION', 'BATCH',
] as const satisfies readonly OperationType[];

function expectRoundTrip(manager: OperationManager, operation: OperationInput): void {
  const before = manager.document.toSnapshot();
  manager.execute(operation);
  const after = manager.document.toSnapshot();
  expect(after).not.toEqual(before);
  expect(manager.undo()).toBe(true);
  expect(manager.document.toSnapshot()).toEqual(before);
  expect(manager.redo()).toBe(true);
  expect(manager.document.toSnapshot()).toEqual(after);
}

function lineFixture() {
  const document = VectorDocument.createEmpty();
  const manager = new OperationManager(document);
  const networkId = document.activeNetwork.id;
  const first: VectorNode = { id: 'coverage-node-a', position: { x: 0, y: 0 }, constraintIds: [] };
  const second: VectorNode = { id: 'coverage-node-b', position: { x: 40, y: 0 }, constraintIds: [] };
  const path: VectorPath = { id: 'coverage-path', segmentIds: [], isClosed: false };
  const segment: Segment = {
    id: 'coverage-segment', startNodeId: first.id, endNodeId: second.id,
    type: 'line', role: 'geometry',
  };
  manager.beginTransaction('Coverage line');
  manager.execute({ type: 'ADD_NODE', payload: { node: first, networkId } });
  manager.execute({ type: 'ADD_NODE', payload: { node: second, networkId } });
  manager.execute({ type: 'ADD_PATH', payload: { path, networkId } });
  manager.execute({ type: 'ADD_SEGMENT', payload: { segment, pathId: path.id } });
  manager.commitTransaction();
  return { document, manager, networkId, first, second, path, segment };
}

describe('Gate E operation and inverse coverage', () => {
  it('keeps inverse generation and apply dispatch exhaustive for every declared operation', () => {
    const source = readFileSync(new URL('./operations.ts', import.meta.url), 'utf8');
    const unionStart = source.indexOf('export type OperationType =');
    const unionEnd = source.indexOf(';', unionStart);
    const unionTypes = [...source.slice(unionStart, unionEnd).matchAll(/'([A-Z_]+)'/g)].map((match) => match[1]);
    expect(new Set(unionTypes)).toEqual(new Set(declaredOperationTypes));

    const inverseStart = source.indexOf('private createInverse(');
    const applyStart = source.indexOf('private apply(', inverseStart);
    const inverseSource = source.slice(inverseStart, applyStart);
    const applySource = source.slice(applyStart, source.indexOf('private applyGraphPatch(', applyStart));
    for (const type of declaredOperationTypes) {
      expect(inverseSource, `missing inverse dispatch for ${type}`).toContain(`case '${type}'`);
      expect(applySource, `missing apply dispatch for ${type}`).toContain(`case '${type}'`);
    }
  });

  it('round-trips direct graph removal and path-state operations', () => {
    {
      const document = VectorDocument.createEmpty();
      const manager = new OperationManager(document);
      const network: VectorNetwork = { id: 'coverage-network', nodeIds: [], pathIds: [] };
      manager.execute({ type: 'ADD_NETWORK', payload: { network } });
      expectRoundTrip(manager, { type: 'REMOVE_NETWORK', payload: { network } });
    }
    {
      const document = VectorDocument.createEmpty();
      const manager = new OperationManager(document);
      const networkId = document.activeNetwork.id;
      const node: VectorNode = { id: 'coverage-standalone', position: { x: 2, y: 3 }, constraintIds: [] };
      manager.execute({ type: 'ADD_NODE', payload: { node, networkId } });
      expectRoundTrip(manager, { type: 'REMOVE_NODE', payload: { node, networkId, index: 0 } });
    }
    {
      const document = VectorDocument.createEmpty();
      const manager = new OperationManager(document);
      const networkId = document.activeNetwork.id;
      const path: VectorPath = { id: 'coverage-empty-path', segmentIds: [], isClosed: false };
      manager.execute({ type: 'ADD_PATH', payload: { path, networkId } });
      expectRoundTrip(manager, { type: 'SET_PATH_CLOSED', payload: { pathId: path.id, isClosed: true } });
      expectRoundTrip(manager, {
        type: 'REMOVE_PATH', payload: { path: document.getPath(path.id)!, networkId, index: 0 },
      });
    }
    {
      const { document, manager, path, segment } = lineFixture();
      expectRoundTrip(manager, {
        type: 'REMOVE_SEGMENT', payload: { segment: document.getSegment(segment.id)!, pathId: path.id, index: 0 },
      });
    }
  });

  it('round-trips constraint, Parametric Group, and export-variable update/removal inverses', () => {
    const { document, manager, path, segment } = lineFixture();
    const constraint: Constraint = {
      id: 'coverage-constraint', type: 'horizontal', priority: 'hard',
      targetIds: [segment.id], tolerance: 1e-6,
    };
    manager.execute({ type: 'ADD_CONSTRAINT', payload: { constraint } });
    expectRoundTrip(manager, {
      type: 'UPDATE_CONSTRAINT', payload: { constraintId: constraint.id, updates: { tolerance: 1e-5 } },
    });
    expectRoundTrip(manager, { type: 'REMOVE_CONSTRAINT', payload: { constraintId: constraint.id } });

    const group: ParametricGroup = {
      id: 'coverage-parametric', sourcePathIds: [path.id],
      transform: { type: 'mirror', axis: 'y', origin: { x: 20, y: 0 }, angle: 90 },
    };
    manager.execute({ type: 'ADD_PARAMETRIC_GROUP', payload: { group } });
    expectRoundTrip(manager, {
      type: 'UPDATE_PARAMETRIC_GROUP',
      payload: { groupId: group.id, updates: { transform: { ...group.transform, angle: 37 } } },
    });
    expectRoundTrip(manager, {
      type: 'REMOVE_PARAMETRIC_GROUP', payload: { group: document.parametricGroups.get(group.id)! },
    });

    const variable: ExportVariable = {
      id: 'coverage-variable', name: '--coverage-opacity', label: 'Coverage opacity',
      type: 'number', binding: 'opacity', value: 0.5, min: 0, max: 1,
    };
    manager.execute({ type: 'ADD_EXPORT_VARIABLE', payload: { variable } });
    expectRoundTrip(manager, {
      type: 'UPDATE_EXPORT_VARIABLE', payload: { variableId: variable.id, updates: { value: 0.75 } },
    });
    expectRoundTrip(manager, { type: 'REMOVE_EXPORT_VARIABLE', payload: { variableId: variable.id } });
  });

  it('updates artboard dimensions transactionally with undo and redo', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const artboardId = document.activeArtboardId;
    const originalFrame = { ...document.activeArtboard.frame };

    manager.execute({
      type: 'UPDATE_ARTBOARD_DIMENSIONS',
      payload: { artboardId, width: 24, height: 24 },
    });
    expect(document.activeArtboard.frame).toEqual({ ...originalFrame, width: 24, height: 24 });
    expect(manager.undo()).toBe(true);
    expect(document.activeArtboard.frame).toEqual(originalFrame);
    expect(manager.redo()).toBe(true);
    expect(document.activeArtboard.frame).toEqual({ ...originalFrame, width: 24, height: 24 });
    expect(() => manager.execute({
      type: 'UPDATE_ARTBOARD_DIMENSIONS',
      payload: { artboardId, width: 0, height: 24 },
    })).toThrow('Artboard dimensions must be finite values greater than 0.');
  });

  it('round-trips direct hierarchy, object, and appearance removals', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);

    const page: DocumentPage = { id: 'coverage-page', name: 'Coverage', artboardIds: [] };
    manager.execute({ type: 'ADD_PAGE', payload: { page } });
    expectRoundTrip(manager, { type: 'REMOVE_PAGE', payload: { page } });

    const artboard: Artboard = {
      id: 'coverage-artboard', pageId: document.activePageId, name: 'Coverage artboard',
      frame: { x: 0, y: 0, width: 200, height: 120 }, background: '#ffffff',
      clipContent: true, layerIds: [],
    };
    manager.execute({ type: 'ADD_ARTBOARD', payload: { artboard, pageId: document.activePageId } });
    expectRoundTrip(manager, {
      type: 'REMOVE_ARTBOARD', payload: { artboard, pageId: document.activePageId },
    });

    const layer: LayerNode = {
      id: 'coverage-layer', kind: 'group', name: 'Coverage group', artboardId: document.activeArtboardId,
      childIds: [], visible: true, locked: false, expanded: true,
    };
    manager.execute({ type: 'ADD_LAYER', payload: { layer } });
    manager.execute({ type: 'SET_LAYER_ISOLATION', payload: { layerId: layer.id } });
    expect(document.isolatedLayerId).toBe(layer.id);
    expect(manager.undo()).toBe(true);
    expect(document.isolatedLayerId).toBeUndefined();
    expect(manager.redo()).toBe(true);
    expect(document.isolatedLayerId).toBe(layer.id);
    manager.execute({ type: 'SET_LAYER_ISOLATION', payload: { layerId: undefined } });
    expectRoundTrip(manager, { type: 'REMOVE_LAYER', payload: { layer: document.getLayer(layer.id)! } });

    const network: VectorNetwork = { id: 'coverage-object-network', nodeIds: [], pathIds: [] };
    const appearance: Appearance = { id: 'coverage-appearance', fills: [], opacity: 1 };
    const object: NetworkObject = {
      id: 'coverage-object', name: 'Coverage object', networkId: network.id, appearanceId: appearance.id,
      transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
    };
    manager.execute({ type: 'ADD_NETWORK', payload: { network } });
    manager.execute({ type: 'ADD_APPEARANCE', payload: { appearance } });
    manager.execute({ type: 'ADD_OBJECT', payload: { object } });
    expectRoundTrip(manager, { type: 'REMOVE_OBJECT', payload: { object } });
    expectRoundTrip(manager, { type: 'REMOVE_APPEARANCE', payload: { appearance } });
  });
});
