import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { VectorDocument } from '../core/document';
import { DEFAULT_DRAWING_STYLE } from '../core/drawing-style';
import { OperationManager } from '../core/operations';
import { DEFAULT_TEXT } from '../core/text';
import type { EntityId, TextContent } from '../core/types';
import { preparePrimitiveObject } from '../tools/primitive-tool';
import { prepareTextObject } from '../tools/text-tool';
import { PropertiesPanel } from './PropertiesPanel';

// The panel reads browser stores without a server snapshot; the snapshot is all a static
// render needs.
vi.mock('react', async (importOriginal) => {
  const mod = await importOriginal<typeof import('react')>();
  return { ...mod, useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot() };
});

function harness(options: { text?: Partial<TextContent>; shape?: boolean } = {}) {
  const document = VectorDocument.createEmpty();
  const manager = new OperationManager(document);
  manager.execute({
    type: 'UPDATE_ARTBOARD',
    payload: { artboardId: document.activeArtboardId, updates: { frame: { x: 0, y: 0, width: 400, height: 300 } } },
  });
  manager.beginTransaction('Fixture');
  if (options.shape) {
    const plan = preparePrimitiveObject(
      document, 'rectangle', { x: 40, y: 40 }, { x: 160, y: 120 }, { style: DEFAULT_DRAWING_STYLE },
    )!;
    plan.operations.forEach((operation) => manager.execute(operation));
    manager.commitTransaction();
    return { document, manager, objectId: plan.objectId as EntityId };
  }
  const plan = prepareTextObject(document, { x: 40, y: 40 }, { text: { ...DEFAULT_TEXT, ...options.text } });
  plan.operations.forEach((operation) => manager.execute(operation));
  manager.commitTransaction();
  return { document, manager, objectId: plan.objectId as EntityId };
}

function render({ document, manager }: ReturnType<typeof harness>, objectId: EntityId) {
  const noop = () => {};
  const props: Record<string, unknown> = {
    document, manager,
    selection: { mode: 'object', objectIds: new Set([objectId]), nodeIds: new Set(), segmentIds: new Set() },
    onDuplicateArtboard: noop, onDeleteArtboard: noop,
    activeTool: 'select', constructionExtent: 'finite', bendMode: 'independent',
    paintColor: '#000000', drawingStyle: DEFAULT_DRAWING_STYLE,
    offsetDistance: 8, filletRadius: 4,
    eraserSettings: { weight: 8, shape: 'round' },
    primitiveSettings: { cornerRadius: 4, polygonSides: 6, starPoints: 5, starInnerRatio: 0.5 },
    geometryReviewComponentId: undefined,
  };
  for (const name of [
    'onPrimitiveSettingsChange', 'onConstructionExtentChange', 'onSetSegmentRoles', 'onBendModeChange',
    'onPaintColorChange', 'onDrawingStyleChange', 'onOffsetDistanceChange', 'onFilletRadiusChange',
    'onEraserSettingsChange', 'onCreateMirror', 'onCreateRadialRepeat', 'onRemoveParametricGroup',
    'onUpdateParametricTransform', 'onUpdateParametricSources', 'onBulkNodeAction', 'onApplyConstraint',
    'onUpdateConstraint', 'onBulkConstraintParameter', 'onRemoveConstraint', 'onSetNodeMode', 'onPathCommand',
    'onUpdateObject', 'onUpdateAppearance', 'onBeginContinuousEdit', 'onCommitContinuousEdit',
    'onRollbackContinuousEdit', 'onUpdateObjects', 'onUpdateObjectAppearances', 'onCreateAppearanceRule',
    'onApplyAppearanceRule', 'onApplyAppearanceRuleImpact', 'onDetachAppearanceRule', 'onRenameAppearanceRule',
    'onDeleteAppearanceRule', 'onCreateGeometryVariant', 'onApplyGeometryPropagation',
    'onGeometryImpactObjectsChange', 'onSetGeometryOverrides', 'onDetachGeometryVariant',
    'onApplyFamilyQaFixes', 'onGeometryReviewOpened', 'onRenameGeometryComponent', 'onAlignObjects',
    'onFlipObjects', 'onSetObjectLayerState', 'onEnterNetworkEdit', 'onExitNetworkEdit',
  ]) props[name] = noop;
  return renderToStaticMarkup(createElement(PropertiesPanel, props as never));
}

function control(html: string, label: string) {
  const match = new RegExp(`<(?:button|input|select|textarea)([^>]*aria-label="${label}"[^>]*)>`).exec(html);
  if (!match) throw new Error(`No control labelled "${label}".`);
  return { html: match[1], disabled: /\sdisabled(?:="")?[\s/>]/.test(`${match[1]} `) };
}

describe('text inspector', () => {
  it('shows the text controls for a text object', () => {
    const fixture = harness({ text: { content: 'Hello', size: 32 } });
    const html = render(fixture, fixture.objectId);
    expect(html).toContain('>Text</h3>');
    expect(control(html, 'Text content').html).toContain('spellcheck="false"');
    expect(html).toContain('>Hello</textarea>');
    expect(html).toContain('aria-label="Text family"');
    expect(html).toContain('aria-label="Text weight"');
    expect(control(html, 'Text size').html).toContain('value="32"');
    expect(control(html, 'Text line height').html).toContain('value="1.25"');
    for (const align of ['left', 'center', 'right']) expect(html).toContain(`aria-label="Align text ${align}"`);
  });

  it('marks the active alignment and offers the three families', () => {
    const fixture = harness({ text: { align: 'center', family: 'serif' } });
    const html = render(fixture, fixture.objectId);
    expect(html).toMatch(/aria-label="Align text center"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*aria-label="Align text center"/);
    expect(html).toContain('<option value="serif" selected="">Serif</option>');
  });

  it('explains that text has no points to edit', () => {
    const fixture = harness();
    const html = render(fixture, fixture.objectId);
    const edit = control(html, 'Edit points');
    expect(edit.disabled).toBe(true);
    expect(edit.html).toContain('text has no points to edit');
  });

  it('leaves a shape’s inspector without any text controls', () => {
    const fixture = harness({ shape: true });
    const html = render(fixture, fixture.objectId);
    expect(html).not.toContain('aria-label="Text content"');
    expect(html).not.toContain('>Text</h3>');
    expect(control(html, 'Edit points').disabled).toBe(false);
  });

  it('reports the measured box, which is the size a text object will occupy', () => {
    const fixture = harness({ text: { content: 'aa', family: 'mono', size: 10 } });
    const html = render(fixture, fixture.objectId);
    expect(html).toContain('1 line');
    expect(html).toContain('12 × 13 px');
    expect(html).toContain('no wrapping');
  });
});
