// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { createElement } from 'react';
import { VectorDocument } from '../core/document';
import { DEFAULT_DRAWING_STYLE } from '../core/drawing-style';
import { editableInspectorObjects } from '../app/inspector-actions';
import { alignmentUpdates } from '../core/inspector-layout';
import { prepareFlipObjects } from '../core/object-operations';
import { OperationManager } from '../core/operations';
import type { EntityId } from '../core/types';
import { preparePrimitiveObject } from '../tools/primitive-tool';
import { PropertiesPanel } from './PropertiesPanel';

/**
 * The right panel's side of the bargain: a control that is enabled must reach the
 * document. These tests click and type into every enabled control and fail if nothing
 * happens — neither a document mutation nor a callback with a payload.
 *
 * Callbacks are wired to the same operations the app calls, so a control that quietly
 * stops being connected cannot hide behind a spy that is always satisfied.
 */
function harness() {
  const document = VectorDocument.createEmpty();
  const manager = new OperationManager(document);
  manager.execute({ type: 'UPDATE_ARTBOARD', payload: { artboardId: document.activeArtboardId, updates: { frame: { x: 0, y: 0, width: 400, height: 300 } } } });
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

type Fixture = ReturnType<typeof harness>;

function panel(fixture: Fixture, selection: unknown, activeTool = 'select') {
  const { document, manager } = fixture;
  const calls: string[] = [];
  const spy = (name: string) => vi.fn((...args: unknown[]) => {
    // A callback that fires with an undefined payload is as dead as one that never fires.
    // Zero-argument callbacks are fine: several props are pure "commit now" signals.
    const empty = args.some((argument) => argument === undefined);
    calls.push(`${name}(${args.length})${empty ? ' [empty]' : ''}`);
  });
  const props: Record<string, unknown> = {
    document, manager, selection,
    activeTool, constructionExtent: 'finite', bendMode: 'independent',
    paintColor: '#101010', drawingStyle: DEFAULT_DRAWING_STYLE,
    offsetDistance: 8, filletRadius: 4,
    eraserSettings: { weight: 8, shape: 'round' },
    primitiveSettings: { cornerRadius: 4, polygonSides: 6, starPoints: 5, starInnerRatio: 0.5 },
    // Document-changing handlers run the real operations, exactly as App.tsx does.
    // These mirror App.tsx, including its editability rule, so a control that App would
    // silently drop cannot pass by being wired to a permissive stand-in.
    onUpdateObject: (objectId: EntityId, updates: Record<string, unknown>) => {
      if (!editableInspectorObjects(document, [objectId]).length) return;
      calls.push('onUpdateObject');
      manager.execute({ type: 'UPDATE_OBJECT', payload: { objectId, updates: updates as never } });
    },
    onUpdateAppearance: (appearanceId: EntityId, updates: Record<string, unknown>) => {
      calls.push('onUpdateAppearance');
      manager.execute({ type: 'UPDATE_APPEARANCE', payload: { appearanceId, updates: updates as never } });
    },
    onUpdateObjects: (objectIds: EntityId[], updates: Record<string, unknown>) => {
      if (!editableInspectorObjects(document, objectIds).length) return;
      calls.push('onUpdateObjects');
      manager.beginTransaction('Update objects');
      for (const objectId of objectIds) {
        const object = document.getObject(objectId);
        if (object) manager.execute({ type: 'UPDATE_OBJECT', payload: { objectId, updates: { transform: { ...object.transform, ...updates } as never } } });
      }
      manager.commitTransaction();
    },
    onUpdateObjectAppearances: (objectIds: EntityId[], updates: { opacity?: number }) => {
      calls.push('onUpdateObjectAppearances');
      for (const objectId of objectIds) {
        const object = document.getObject(objectId);
        const appearance = object ? document.getAppearance(object.appearanceId) : undefined;
        if (!appearance) continue;
        manager.execute({
          type: 'UPDATE_APPEARANCE',
          payload: { appearanceId: appearance.id, updates: { opacity: updates.opacity ?? appearance.opacity } },
        });
      }
    },
    onAlignObjects: (objectIds: EntityId[], alignment: Parameters<typeof alignmentUpdates>[2]) => {
      calls.push('onAlignObjects');
      manager.beginTransaction('Align objects');
      for (const { objectId, transform } of alignmentUpdates(document, objectIds, alignment)) {
        manager.execute({ type: 'UPDATE_OBJECT', payload: { objectId, updates: { transform } } });
      }
      manager.commitTransaction();
    },
    onFlipObjects: (objectIds: EntityId[], axis: 'horizontal' | 'vertical') => {
      calls.push('onFlipObjects');
      const plan = prepareFlipObjects(document, objectIds, axis);
      if (!plan) return;
      manager.beginTransaction('Flip');
      plan.operations.forEach((operation) => manager.execute(operation));
      manager.commitTransaction();
    },
    onSetObjectLayerState: (objectIds: EntityId[], updates: { locked?: boolean; visible?: boolean }) => {
      calls.push('onSetObjectLayerState');
      manager.beginTransaction('Layer state');
      for (const objectId of objectIds) {
        const layer = document.getLayerForObject(objectId);
        if (layer) manager.execute({ type: 'UPDATE_LAYER', payload: { layerId: layer.id, updates } });
      }
      manager.commitTransaction();
    },
  };
  for (const name of [
    'onDuplicateArtboard', 'onDeleteArtboard', 'onPrimitiveSettingsChange', 'onConstructionExtentChange',
    'onSetSegmentRoles', 'onBendModeChange', 'onPaintColorChange', 'onDrawingStyleChange',
    'onOffsetDistanceChange', 'onFilletRadiusChange', 'onEraserSettingsChange', 'onCreateMirror',
    'onCreateRadialRepeat', 'onRemoveParametricGroup', 'onUpdateParametricTransform',
    'onUpdateParametricSources', 'onBulkNodeAction', 'onApplyConstraint', 'onUpdateConstraint',
    'onBulkConstraintParameter', 'onRemoveConstraint', 'onSetNodeMode', 'onPathCommand',
    'onBeginContinuousEdit', 'onCommitContinuousEdit', 'onRollbackContinuousEdit',
    'onCreateAppearanceRule', 'onApplyAppearanceRule', 'onApplyAppearanceRuleImpact',
    'onDetachAppearanceRule', 'onRenameAppearanceRule', 'onDeleteAppearanceRule',
    'onCreateGeometryVariant', 'onApplyGeometryPropagation', 'onGeometryImpactObjectsChange',
    'onSetGeometryOverrides', 'onDetachGeometryVariant', 'onApplyFamilyQaFixes',
    'onGeometryReviewOpened', 'onRenameGeometryComponent', 'onEnterNetworkEdit', 'onExitNetworkEdit',
  ]) props[name] = spy(name);

  const result = render(createElement(PropertiesPanel, props as never));
  return { ...result, calls };
}

/** Controls that only open local UI (menus, aspect lock) have nothing to commit. */
const LOCAL_ONLY = new Set([
  'Frame actions', 'Lock aspect ratio', 'Constrain proportions', 'Constrain frame proportions',
  'Edit points', 'Independent corners',
]);

function accessibleName(element: Element) {
  const labelled = element.getAttribute('aria-label');
  if (labelled) return labelled;
  // The older fields are wrapped in a <label>, which is their accessible name.
  const wrapper = element.closest('label');
  return wrapper?.querySelector('span')?.textContent?.trim() ?? element.textContent?.trim() ?? '';
}

/** A value the field will accept: inside its own bounds, and never the current one. */
function probeValue(field: HTMLInputElement) {
  // `getAttribute` returns null for an absent bound, and Number(null) is 0 — treat it as absent.
  const bound = (name: string, fallback: number) => {
    const raw = field.getAttribute(name);
    const parsed = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const low = bound('min', 0);
  const high = bound('max', 1e6);
  const pick = (preferred: number) => String(Math.min(Math.max(preferred, low), high));
  const candidate = pick(37);
  return Number(candidate) === Number(field.value) ? pick(29) : candidate;
}

function enabledButtons(container: HTMLElement) {
  return [...container.querySelectorAll('button')]
    .filter((button) => !button.hasAttribute('disabled'))
    .filter((button) => !LOCAL_ONLY.has(accessibleName(button)));
}

const empty = { mode: 'object' as const, objectIds: new Set<EntityId>(), nodeIds: new Set<EntityId>(), segmentIds: new Set<EntityId>() };
const selected = (...ids: EntityId[]) => ({ mode: 'object' as const, objectIds: new Set(ids), nodeIds: new Set<EntityId>(), segmentIds: new Set<EntityId>() });

/**
 * Each control is probed on a fresh document: a control that already held its target
 * position would otherwise look dead simply because there was nothing left to change.
 */
function auditButtons(build: () => { fixture: Fixture; selection: unknown }) {
  const probe = build();
  const probeView = panel(probe.fixture, probe.selection);
  const names = enabledButtons(probeView.container).map(accessibleName);
  probeView.unmount();
  const dead: string[] = [];
  for (const name of names) {
    const fresh = build();
    const view = panel(fresh.fixture, fresh.selection);
    const target = enabledButtons(view.container).find((candidate) => accessibleName(candidate) === name);
    if (!target) { view.unmount(); continue; }
    const before = fresh.fixture.document.revision;
    fireEvent.click(target);
    const emptied = view.calls.filter((call) => call.endsWith(' [empty]'));
    if (emptied.length) dead.push(`${name} → ${emptied.join(', ')}`);
    else if (!view.calls.length && fresh.fixture.document.revision === before) dead.push(name);
    view.unmount();
  }
  return dead;
}

const EDITABLE_FIELDS = 'input[role="spinbutton"]:not([disabled]), input[type="number"]:not([disabled])';

function auditFields(build: () => { fixture: Fixture; selection: unknown }) {
  const probe = build();
  const probeView = panel(probe.fixture, probe.selection);
  const names = [...probeView.container.querySelectorAll<HTMLInputElement>(EDITABLE_FIELDS)].map(accessibleName);
  probeView.unmount();
  const dead: string[] = [];
  for (const name of names) {
    const fresh = build();
    const view = panel(fresh.fixture, fresh.selection);
    const target = [...view.container.querySelectorAll<HTMLInputElement>(EDITABLE_FIELDS)]
      .find((candidate) => accessibleName(candidate) === name);
    if (!target) { view.unmount(); continue; }
    const before = fresh.fixture.document.revision;
    fireEvent.focus(target);
    fireEvent.change(target, { target: { value: probeValue(target) } });
    fireEvent.blur(target);
    const emptied = view.calls.filter((call) => call.endsWith(' [empty]'));
    if (emptied.length) dead.push(`${name} → ${emptied.join(', ')}`);
    else if (!view.calls.length && fresh.fixture.document.revision === before) dead.push(name);
    view.unmount();
  }
  return dead;
}

const objectView = () => {
  const fixture = harness();
  const objectId = fixture.draw(60, 80);
  return { fixture, selection: selected(objectId) };
};

const multiView = () => {
  const fixture = harness();
  const first = fixture.draw(60, 80);
  const second = fixture.draw(200, 120);
  return { fixture, selection: selected(first, second) };
};

const networkView = () => {
  const fixture = harness();
  const objectId = fixture.draw(60, 80);
  const object = fixture.document.getObject(objectId)!;
  const network = fixture.document.getNetwork(object.networkId)!;
  return {
    fixture,
    selection: {
      mode: 'network' as const,
      editingObjectId: objectId,
      objectIds: new Set([objectId]),
      nodeIds: new Set(network.nodeIds),
      segmentIds: new Set(network.pathIds.flatMap((pathId) => fixture.document.getPath(pathId)?.segmentIds ?? [])),
    },
  };
};

/** Hiding is a view state: the inspector must keep working on a hidden shape. */
const hiddenView = () => {
  const fixture = harness();
  const objectId = fixture.draw(60, 80);
  fixture.manager.execute({
    type: 'UPDATE_LAYER',
    payload: { layerId: fixture.document.getLayerForObject(objectId)!.id, updates: { visible: false } },
  });
  return { fixture, selection: selected(objectId) };
};

const frameView = () => {
  const fixture = harness();
  fixture.draw(60, 80);
  fixture.draw(200, 120);
  return { fixture, selection: empty };
};

describe('right panel controls reach the document', () => {
  it('every enabled button in the object inspector does something', () => {
    expect(auditButtons(objectView), 'enabled buttons that changed nothing').toEqual([]);
  });

  it('every enabled numeric field in the object inspector commits a change', () => {
    expect(auditFields(objectView), 'enabled fields that committed nothing').toEqual([]);
  });

  it('every enabled button in the multi-selection inspector does something', () => {
    expect(auditButtons(multiView), 'enabled buttons that changed nothing').toEqual([]);
  });

  it('every enabled numeric field in the multi-selection inspector commits a change', () => {
    expect(auditFields(multiView), 'enabled fields that committed nothing').toEqual([]);
  });

  it('every enabled button in the frame inspector does something', () => {
    expect(auditButtons(frameView), 'enabled buttons that changed nothing').toEqual([]);
  });

  it('every enabled numeric field in the frame inspector commits a change', () => {
    expect(auditFields(frameView), 'enabled fields that committed nothing').toEqual([]);
  });

  it('keeps the inspector working on a hidden shape', () => {
    expect(auditButtons(hiddenView), 'enabled buttons that changed nothing').toEqual([]);
    expect(auditFields(hiddenView), 'enabled fields that committed nothing').toEqual([]);
  });

  it('every enabled button in point editing does something', () => {
    expect(auditButtons(networkView), 'enabled buttons that changed nothing').toEqual([]);
  });

  it('every enabled numeric field in point editing commits a change', () => {
    expect(auditFields(networkView), 'enabled fields that committed nothing').toEqual([]);
  });

  it.each(['pen', 'pencil', 'brush', 'rectangle', 'rounded-rectangle', 'ellipse', 'polygon', 'star', 'line', 'arc', 'bend', 'fillet', 'offset', 'width', 'eraser', 'paint', 'cut'])(
    'every enabled control in the %s tool section does something',
    (activeTool) => {
      const build = () => {
        const fixture = harness();
        return { fixture, selection: empty, activeTool };
      };
      // The probe render needs the tool id; `panel` reads it from the closure above.
      const probe = build();
      const probeView = panel(probe.fixture, probe.selection, activeTool);
      const names = enabledButtons(probeView.container).map(accessibleName);
      probeView.unmount();
      const dead: string[] = [];
      for (const name of names) {
        const fresh = build();
        const view = panel(fresh.fixture, fresh.selection, activeTool);
        const target = enabledButtons(view.container).find((candidate) => accessibleName(candidate) === name);
        if (!target) { view.unmount(); continue; }
        const before = fresh.fixture.document.revision;
        fireEvent.click(target);
        const emptied = view.calls.filter((call) => call.endsWith(' [empty]'));
    if (emptied.length) dead.push(`${name} → ${emptied.join(', ')}`);
    else if (!view.calls.length && fresh.fixture.document.revision === before) dead.push(name);
        view.unmount();
      }
      expect(dead, `${activeTool}: enabled buttons that changed nothing`).toEqual([]);
    },
  );
});
