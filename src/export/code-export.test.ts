import { describe, expect, it } from 'vitest';
import { VectorDocument } from '../core/document';
import { createEntityId } from '../core/ids';
import { OperationManager } from '../core/operations';
import type { Segment, VectorNode, VectorPath } from '../core/types';
import { exportCssVariables, exportReactComponent } from './code-export';

function fixture() {
  const document = VectorDocument.createEmpty();
  const manager = new OperationManager(document);
  const networkId = document.activeNetwork.id;
  const start: VectorNode = { id: createEntityId(), position: { x: 0, y: 0 }, constraintIds: [] };
  const end: VectorNode = { id: createEntityId(), position: { x: 24, y: 0 }, constraintIds: [] };
  const path: VectorPath = { id: createEntityId(), segmentIds: [], isClosed: false };
  const segment: Segment = { id: createEntityId(), startNodeId: start.id, endNodeId: end.id, type: 'line', role: 'geometry' };
  manager.beginTransaction('Fixture');
  manager.execute({ type: 'ADD_NODE', payload: { node: start, networkId } });
  manager.execute({ type: 'ADD_NODE', payload: { node: end, networkId } });
  manager.execute({ type: 'ADD_PATH', payload: { path, networkId } });
  manager.execute({ type: 'ADD_SEGMENT', payload: { segment, pathId: path.id } });
  manager.commitTransaction();
  return { document, manager, segment };
}

describe('parametric code export', () => {
  it('generates a typed solver-free React component from explicit variables', () => {
    const { document, manager } = fixture();
    const stroke = { id: createEntityId(), name: 'strokeWidth', label: 'Stroke width', type: 'number' as const, binding: 'strokeWidth' as const, value: 2, min: 0.5, max: 12 };
    const color = { id: createEntityId(), name: 'assetColor', label: 'Asset color', type: 'color' as const, binding: 'fillColor' as const, value: '#3366ff' };
    manager.execute({ type: 'ADD_EXPORT_VARIABLE', payload: { variable: stroke } });
    manager.execute({ type: 'ADD_EXPORT_VARIABLE', payload: { variable: color } });
    const code = exportReactComponent(document, { componentName: 'status icon', variableIds: [stroke.id, color.id] });
    expect(code).toContain('export interface StatusIconProps');
    expect(code).toContain('strokeWidth?: number;');
    expect(code).toContain('assetColor?: string;');
    expect(code).toContain('Geometry is solved and contains no runtime constraint engine');
    expect(code).not.toContain('wasm');
    expect(code).not.toContain('ConstraintSolver');
  });

  it('delegates geometry to SVG export without construction or solver metadata', () => {
    const { document, manager } = fixture();
    const networkId = document.activeNetwork.id;
    const start: VectorNode = { id: createEntityId(), position: { x: 1000, y: 1000 }, constraintIds: [] };
    const end: VectorNode = { id: createEntityId(), position: { x: 1200, y: 1000 }, constraintIds: [] };
    const path: VectorPath = { id: createEntityId(), segmentIds: [], isClosed: false };
    const guide: Segment = {
      id: createEntityId(), startNodeId: start.id, endNodeId: end.id, type: 'line',
      role: 'construction', constructionExtent: 'infinite',
    };
    manager.beginTransaction('Construction fixture');
    manager.execute({ type: 'ADD_NODE', payload: { node: start, networkId } });
    manager.execute({ type: 'ADD_NODE', payload: { node: end, networkId } });
    manager.execute({ type: 'ADD_PATH', payload: { path, networkId } });
    manager.execute({ type: 'ADD_SEGMENT', payload: { segment: guide, pathId: path.id } });
    manager.commitTransaction();

    const code = exportReactComponent(document, { componentName: 'Guide Safe' });
    expect(code).toContain('viewBox=\\"-8 -8 40 16\\"');
    expect(code).not.toContain('1000');
    expect(code).not.toContain(guide.id);
    expect(code).not.toContain('constructionExtent');
    expect(code).not.toContain('role:');
    expect(code).not.toContain('ConstraintSolver');
    expect(code).not.toContain('.wasm');
  });

  it('exports selected values as CSS custom properties and persists them', () => {
    const { document, manager } = fixture();
    const opacity = { id: createEntityId(), name: 'iconOpacity', label: 'Opacity', type: 'number' as const, binding: 'opacity' as const, value: 0.8, min: 0, max: 1 };
    manager.execute({ type: 'ADD_EXPORT_VARIABLE', payload: { variable: opacity } });
    expect(exportCssVariables(document)).toContain('--icon-opacity: 0.8;');
    expect(new VectorDocument(document.toSnapshot()).exportVariables.get(opacity.id)).toEqual(opacity);
    manager.undo();
    expect(document.exportVariables.has(opacity.id)).toBe(false);
  });
});
