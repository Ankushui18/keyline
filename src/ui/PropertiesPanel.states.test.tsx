import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { VectorDocument } from '../core/document';
import { DEFAULT_DRAWING_STYLE } from '../core/drawing-style';
import { OperationManager } from '../core/operations';
import type { EntityId } from '../core/types';
import { preparePrimitiveObject } from '../tools/primitive-tool';
import { PropertiesPanel } from './PropertiesPanel';

// The panel reads two browser stores through useSyncExternalStore without a server
// snapshot; the reported value is all this renderer needs to lay the inspector out.
vi.mock('react', async (importOriginal) => {
  const mod = await importOriginal<typeof import('react')>();
  return { ...mod, useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot() };
});

interface Harness {
  document: VectorDocument;
  manager: OperationManager;
  draw: (x: number, y: number, size?: number) => EntityId;
}

/** Rendering only needs the document; the draw helper exists for the fixtures. */
type PanelInput = Pick<Harness, 'document' | 'manager'>;

/** An active 400 × 300 frame, plus rectangle fixtures drawn straight into it. */
function harness(frame = { x: 0, y: 0, width: 400, height: 300 }): Harness {
  const document = VectorDocument.createEmpty();
  const manager = new OperationManager(document);
  manager.execute({ type: 'UPDATE_ARTBOARD', payload: { artboardId: document.activeArtboardId, updates: { frame } } });
  const draw = (x: number, y: number, size = 40) => {
    const plan = preparePrimitiveObject(
      document, 'rectangle', { x, y }, { x: x + size, y: y + size }, { style: DEFAULT_DRAWING_STYLE },
    )!;
    manager.beginTransaction('Draw fixture rectangle');
    plan.operations.forEach((operation) => manager.execute(operation));
    manager.commitTransaction();
    return plan.objectId;
  };
  return { document, manager, draw };
}

const EMPTY_SELECTION = {
  mode: 'object' as const, objectIds: new Set<EntityId>(), nodeIds: new Set<EntityId>(), segmentIds: new Set<EntityId>(),
};
const objectsSelected = (...ids: EntityId[]) => ({
  mode: 'object' as const, objectIds: new Set(ids), nodeIds: new Set<EntityId>(), segmentIds: new Set<EntityId>(),
});

function renderPanel({ document, manager }: PanelInput, selection: unknown): string {
  const noop = () => {};
  const props: Record<string, unknown> = {
    document, manager, selection,
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

/** Every control the browser would show greyed out, with the tooltip that explains it. */
function disabledControls(html: string) {
  return [...html.matchAll(/<(button|input|select)([^>]*)>/g)]
    .filter((match) => /\sdisabled(?:="")?[\s/>]/.test(`${match[2]} `))
    .map((match) => ({
      label: /aria-label="([^"]*)"/.exec(match[2])?.[1] ?? '',
      title: /title="([^"]*)"/.exec(match[2])?.[1] ?? '',
    }));
}

function controlByLabel(html: string, label: string) {
  const match = new RegExp(`<(?:button|input)([^>]*aria-label="${label}"[^>]*)>`).exec(html);
  if (!match) throw new Error(`No control labelled "${label}".`);
  return {
    disabled: /\sdisabled(?:="")?[\s/>]/.test(`${match[1]} `),
    title: /title="([^"]*)"/.exec(match[1])?.[1] ?? '',
  };
}

const ALIGN_LABELS = ['Align left', 'Align right', 'Align top', 'Align bottom', 'Align horizontal centers', 'Align vertical centers'];

describe('right panel availability', () => {
  it('explains every disabled control instead of leaving it looking broken', () => {
    const empty = harness();
    const withObject = harness();
    const objectId = withObject.draw(20, 20);
    const twoObjects = harness();
    const first = twoObjects.draw(20, 20);
    const second = twoObjects.draw(120, 80);

    const views: Array<[string, string]> = [
      ['frame with no contents', renderPanel(empty, EMPTY_SELECTION)],
      ['frame with one shape', renderPanel(withObject, objectsSelected(objectId))],
      ['two selected shapes', renderPanel(twoObjects, objectsSelected(first, second))],
    ];
    for (const [name, html] of views) {
      const controls = disabledControls(html);
      expect(controls.length, `${name}: expected some unavailable controls`).toBeGreaterThan(0);
      for (const control of controls) {
        expect(control.label, `${name}: a disabled control must have an accessible name`).not.toBe('');
        expect(control.title, `${name}: "${control.label}" is disabled without a reason`).toContain('—');
      }
    }
  });

  it('aligns the single shape inside a frame instead of greying the row out', () => {
    const { document, manager, draw } = harness();
    const objectId = draw(20, 20);
    const html = renderPanel({ document, manager }, objectsSelected(objectId));
    for (const label of ALIGN_LABELS) expect(controlByLabel(html, label).disabled, label).toBe(false);
  });

  it('disables frame alignment with a reason when the frame is empty', () => {
    const html = renderPanel(harness(), EMPTY_SELECTION);
    const align = controlByLabel(html, 'Align left');
    expect(align.disabled).toBe(true);
    expect(align.title).toBe('Align left — this frame has no visible, unlocked shapes to align');
    expect(controlByLabel(html, 'Distribute vertically').title).toContain('3 or more');
    expect(controlByLabel(html, 'Arrange in a grid').title).toContain('2 or more');
  });

  it('keeps distribution unavailable, and explained, for two selected shapes', () => {
    const { document, manager, draw } = harness();
    const first = draw(20, 20);
    const second = draw(120, 80);
    const html = renderPanel({ document, manager }, objectsSelected(first, second));
    expect(controlByLabel(html, 'Align left').disabled).toBe(false);
    const distribute = controlByLabel(html, 'Distribute vertically');
    expect(distribute.disabled).toBe(true);
    expect(distribute.title).toContain('3 or more');
  });

  it('states that artwork outside every frame has nothing to align to', () => {
    const { document, manager } = harness({ x: 0, y: 0, width: 40, height: 40 });
    const plan = preparePrimitiveObject(
      document, 'rectangle', { x: 200, y: 200 }, { x: 260, y: 240 }, { style: DEFAULT_DRAWING_STYLE },
    )!;
    manager.beginTransaction('Draw outside the frame');
    plan.operations.forEach((operation) => manager.execute(operation));
    manager.commitTransaction();
    const html = renderPanel({ document, manager }, objectsSelected(plan.objectId));
    const align = controlByLabel(html, 'Align left');
    expect(align.disabled).toBe(true);
    expect(align.title).toContain('outside every frame');
  });
});
