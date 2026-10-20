import { createRequire } from 'node:module';
import ts from 'typescript';
import type { CSSProperties, ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { VectorDocument } from '../core/document';
import { createEntityId } from '../core/ids';
import { OperationManager } from '../core/operations';
import type { ExportVariable, Segment, VectorNode, VectorPath } from '../core/types';
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


type GeneratedAsset = (props: Record<string, unknown>) => ReactElement<{ style: CSSProperties; dangerouslySetInnerHTML: { __html: string } }>;
function compileAsset(code: string): GeneratedAsset {
  const result = ts.transpileModule(code, {
    fileName: 'AuditAsset.tsx', reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  });
  expect(result.diagnostics).toEqual([]);
  const exports: Record<string, unknown> = {};
  new Function('require', 'exports', result.outputText)(createRequire(import.meta.url), exports);
  return exports.AuditAsset as GeneratedAsset;
}
function expose(document: VectorDocument, overrides: Partial<ExportVariable>): ExportVariable {
  const variable: ExportVariable = {
    id: createEntityId(), name: 'assetColor', label: 'Color', type: 'color', binding: 'fillColor', value: '#123456', ...overrides,
  };
  document.exportVariables.set(variable.id, variable);
  return variable;
}

describe('safe generated source code', () => {
  it('escapes title and color props instead of creating executable SVG attributes', () => {
    const { document } = fixture();
    expose(document, {});
    const Asset = compileAsset(exportReactComponent(document, { componentName: 'AuditAsset' }));
    const html = Asset({ title: '\"><img src=x onerror=alert(1)>', assetColor: '\" onload=\"alert(2)' }).props.dangerouslySetInnerHTML.__html;
    expect(html).not.toContain('<img');
    expect(html).not.toContain(' onload="');
    expect(html).toContain('aria-label="&quot;&gt;&lt;img');
    expect(html).toContain('stroke="&quot; onload=&quot;alert(2)"');
  });

  it('does not interpret dollar signs as replacement directives', () => {
    const { document } = fixture();
    expose(document, {});
    const Asset = compileAsset(exportReactComponent(document, { componentName: 'AuditAsset' }));
    const html = Asset({ assetColor: '$&', title: '$&' }).props.dangerouslySetInnerHTML.__html;
    expect(html).toContain('stroke="$&amp;"');
    expect(html).toContain('aria-label="$&amp;"');
    expect(html).not.toContain('__VS_STROKE_COLOR__');
  });

  it('supports reserved words and disambiguates sanitized and built-in prop names', () => {
    const { document } = fixture();
    for (const name of ['default', 'class', 'title', 'icon-color', 'icon color']) expose(document, { name });
    const code = exportReactComponent(document, { componentName: 'AuditAsset' });
    expect(code).toContain('title2?: string;');
    expect(code).toContain('iconColor2?: string;');
    expect(() => compileAsset(code)({})).not.toThrow();
  });

  it('clamps exposed numeric props and safely handles NaN and Infinity', () => {
    const { document } = fixture();
    expose(document, { name: 'weight', type: 'number', binding: 'strokeWidth', value: 2, min: 0.5, max: 12 });
    expose(document, { name: 'alpha', type: 'number', binding: 'opacity', value: 0.8, min: 0, max: 1 });
    const Asset = compileAsset(exportReactComponent(document, { componentName: 'AuditAsset' }));
    expect(Asset({ weight: 1000, alpha: -1 }).props.dangerouslySetInnerHTML.__html).toContain('stroke-width="12"');
    expect(Asset({ weight: 1000, alpha: -1 }).props.style.opacity).toBe(0);
    expect(Asset({ weight: NaN, alpha: Infinity }).props.dangerouslySetInnerHTML.__html).toContain('stroke-width="2"');
    expect(Asset({ weight: NaN, alpha: Infinity }).props.style.opacity).toBe(0.8);
  });

  it('rejects CSS declaration injection in stored export colors', () => {
    const { document } = fixture();
    expose(document, { value: 'red; } body { display:none } /*' });
    const css = exportCssVariables(document);
    expect(css).toContain('--asset-color: currentColor;');
    expect(css).not.toContain('display:none');
  });
});
