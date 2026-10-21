import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { VectorDocument } from '../core/document';
import { DEFAULT_DRAWING_STYLE } from '../core/drawing-style';
import { defaultLinearGradient, defaultRadialGradient } from '../core/fills';
import { OperationManager } from '../core/operations';
import type { AppearanceFill, EntityId } from '../core/types';
import { preparePrimitiveObject } from '../tools/primitive-tool';
import { PropertiesPanel } from './PropertiesPanel';

// The panel reads browser stores without a server snapshot; the snapshot is all a
// static render needs.
vi.mock('react', async (importOriginal) => {
  const mod = await importOriginal<typeof import('react')>();
  return { ...mod, useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot() };
});

function harness(fill?: (document: VectorDocument, objectId: EntityId) => AppearanceFill) {
  const document = VectorDocument.createEmpty();
  const manager = new OperationManager(document);
  manager.execute({
    type: 'UPDATE_ARTBOARD',
    payload: { artboardId: document.activeArtboardId, updates: { frame: { x: 0, y: 0, width: 400, height: 300 } } },
  });
  const plan = preparePrimitiveObject(
    document, 'rectangle', { x: 40, y: 40 }, { x: 160, y: 120 }, { style: DEFAULT_DRAWING_STYLE },
  )!;
  manager.beginTransaction('Fixture');
  plan.operations.forEach((operation) => manager.execute(operation));
  const appearance = document.getAppearance(document.getObject(plan.objectId)!.appearanceId)!;
  if (fill) {
    manager.execute({
      type: 'UPDATE_APPEARANCE',
      payload: { appearanceId: appearance.id, updates: { fills: [fill(document, plan.objectId)] } },
    });
  }
  manager.commitTransaction();
  return { document, manager, objectId: plan.objectId as EntityId };
}

/** The pattern of the panel that renders the object's fills. */
function renderFills(objectId: EntityId, fixture: ReturnType<typeof harness>) {
  const noop = () => {};
  const props: Record<string, unknown> = {
    document: fixture.document, manager: fixture.manager,
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

/** The option marked as chosen inside a labelled select, since `selected` lives there. */
function chosenOption(html: string, label: string) {
  const start = html.indexOf(`aria-label="${label}"`);
  const end = html.indexOf('</select>', start);
  const block = html.slice(start, end);
  const match = /value="([^"]*)" selected/.exec(block);
  return match?.[1];
}

function control(html: string, label: string) {
  const match = new RegExp(`<(?:button|input|select)([^>]*aria-label="${label}"[^>]*)>`).exec(html);
  if (!match) throw new Error(`No control labelled "${label}".`);
  return {
    html: match[1],
    disabled: /\sdisabled(?:="")?[\s/>]/.test(`${match[1]} `),
    value: /value="([^"]*)"/.exec(match[1])?.[1],
  };
}

describe('gradient fill inspector', () => {
  it('offers a type switch on a solid fill, so a gradient is one choice away', () => {
    const fixture = harness(() => ({ type: 'solid', color: '#123456', opacity: 1, visible: true }));
    const html = renderFills(fixture.objectId, fixture);
    expect(chosenOption(html, 'Fill type')).toBe('solid');
    expect(html).toContain('<option value="linear">Linear</option>');
    expect(html).toContain('<option value="radial">Radial</option>');
    expect(control(html, 'Fill type').html).toContain('paint-type');
  });

  it('shows a linear gradient’s angle, stops and preview instead of a hex field', () => {
    const fixture = harness((document, objectId) => defaultLinearGradient(document, objectId, 90));
    const html = renderFills(fixture.objectId, fixture);
    expect(chosenOption(html, 'Fill type')).toBe('linear');
    expect(control(html, 'Fill gradient angle').value).toBe('90');
    expect(control(html, 'Fill stop 1 position').value).toBe('0');
    expect(control(html, 'Fill stop 2 position').value).toBe('100');
    expect(html).toContain('background:linear-gradient(90deg');
    expect(html).toContain('aria-label="Add fill stop"');
    // Two stops are the minimum, so removing one is refused with a reason.
    for (const stop of [1, 2]) {
      const remove = control(html, `Remove Fill stop ${stop}`);
      expect(remove.disabled).toBe(true);
      expect(remove.html).toContain('at least two stops');
    }
  });

  it('shows a radius for a radial gradient and no angle field', () => {
    const fixture = harness((document, objectId) => defaultRadialGradient(document, objectId));
    const html = renderFills(fixture.objectId, fixture);
    expect(chosenOption(html, 'Fill type')).toBe('radial');
    expect(control(html, 'Fill gradient radius').value).toBeTruthy();
    expect(html).not.toContain('aria-label="Fill gradient angle"');
    expect(html).toContain('background:radial-gradient(circle at 50% 50%');
  });

  it('keeps the eye, opacity and remove controls on a gradient row', () => {
    const fixture = harness((document, objectId) => defaultLinearGradient(document, objectId));
    const html = renderFills(fixture.objectId, fixture);
    expect(control(html, 'Hide Fill').disabled).toBe(false);
    expect(control(html, 'Remove Fill').disabled).toBe(false);
    expect(control(html, 'Fill opacity').value).toBe('100');
  });
});
