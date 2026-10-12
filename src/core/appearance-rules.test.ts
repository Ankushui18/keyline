import { describe, expect, it } from 'vitest';
import { preparePrimitiveObject } from '../tools/primitive-tool';
import { VectorDocument } from './document';
import { createEntityId } from './ids';
import { OperationManager } from './operations';
import type { Appearance, AppearanceRule, EntityId } from './types';

function commitPrimitive(document: VectorDocument, manager: OperationManager, x: number) {
  const plan = preparePrimitiveObject(document, 'rectangle', { x, y: 0 }, { x: x + 24, y: 24 })!;
  manager.beginTransaction('Create fixture');
  for (const operation of plan.operations) manager.execute(operation);
  manager.commitTransaction();
  return document.getObject(plan.objectId)!;
}

function ruleValue(appearance: Appearance): AppearanceRule['appearance'] {
  return {
    fills: appearance.fills.map((fill) => ({ ...fill })),
    stroke: appearance.stroke ? { ...appearance.stroke, dash: [...appearance.stroke.dash] } : undefined,
    opacity: appearance.opacity,
  };
}

function applyRule(
  document: VectorDocument,
  manager: OperationManager,
  rule: AppearanceRule,
  objectIds: EntityId[],
) {
  manager.beginTransaction('Create shared style');
  manager.execute({ type: 'ADD_APPEARANCE_RULE', payload: { rule } });
  for (const objectId of objectIds) {
    const object = document.getObject(objectId)!;
    manager.execute({
      type: 'UPDATE_APPEARANCE',
      payload: { appearanceId: object.appearanceId, updates: rule.appearance },
    });
    manager.execute({
      type: 'UPDATE_OBJECT',
      payload: { objectId, updates: { appearanceRuleId: rule.id } },
    });
  }
  manager.commitTransaction();
}

describe('shared appearance rules', () => {
  it('propagates one rule update, persists links, and undoes atomically', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const first = commitPrimitive(document, manager, 0);
    const second = commitPrimitive(document, manager, 40);
    const firstAppearance = document.getAppearance(first.appearanceId)!;
    manager.execute({
      type: 'UPDATE_APPEARANCE',
      payload: {
        appearanceId: second.appearanceId,
        updates: { stroke: { ...document.getAppearance(second.appearanceId)!.stroke!, width: 7 } },
      },
    });
    const rule: AppearanceRule = {
      id: createEntityId(),
      name: 'Outline / 24',
      kind: 'appearance',
      appearance: ruleValue(firstAppearance),
    };

    applyRule(document, manager, rule, [first.id, second.id]);
    expect(document.objectsForAppearanceRule(rule.id).map((object) => object.id).sort())
      .toEqual([first.id, second.id].sort());
    expect(document.getAppearance(second.appearanceId)?.stroke?.width).toBe(firstAppearance.stroke?.width);

    manager.execute({
      type: 'UPDATE_APPEARANCE_RULE',
      payload: {
        ruleId: rule.id,
        updates: {
          appearance: {
            ...rule.appearance,
            stroke: { ...rule.appearance.stroke!, width: 4, dash: [] },
          },
        },
      },
    });
    expect(document.getAppearance(first.appearanceId)?.stroke?.width).toBe(4);
    expect(document.getAppearance(second.appearanceId)?.stroke?.width).toBe(4);

    manager.undo();
    expect(document.getAppearance(first.appearanceId)?.stroke?.width).toBe(rule.appearance.stroke?.width);
    expect(document.getAppearance(second.appearanceId)?.stroke?.width).toBe(rule.appearance.stroke?.width);

    const restored = new VectorDocument(document.toSnapshot());
    expect(restored.getAppearanceRule(rule.id)?.name).toBe('Outline / 24');
    expect(restored.getObject(first.id)?.appearanceRuleId).toBe(rule.id);
    expect(restored.getAppearance(first.appearanceId)?.stroke?.width).toBe(rule.appearance.stroke?.width);
  });

  it('keeps detached geometry and appearance independent and protects in-use rules', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const first = commitPrimitive(document, manager, 0);
    const second = commitPrimitive(document, manager, 40);
    const rule: AppearanceRule = {
      id: createEntityId(),
      name: 'System stroke',
      kind: 'appearance',
      appearance: ruleValue(document.getAppearance(first.appearanceId)!),
    };
    applyRule(document, manager, rule, [first.id, second.id]);

    manager.execute({
      type: 'UPDATE_OBJECT',
      payload: { objectId: second.id, updates: { appearanceRuleId: undefined } },
    });
    const detachedWidth = document.getAppearance(second.appearanceId)!.stroke!.width;
    manager.execute({
      type: 'UPDATE_APPEARANCE_RULE',
      payload: {
        ruleId: rule.id,
        updates: {
          appearance: {
            ...rule.appearance,
            stroke: { ...rule.appearance.stroke!, width: 6, dash: [] },
          },
        },
      },
    });
    expect(document.getAppearance(first.appearanceId)?.stroke?.width).toBe(6);
    expect(document.getAppearance(second.appearanceId)?.stroke?.width).toBe(detachedWidth);
    expect(() => manager.execute({ type: 'REMOVE_APPEARANCE_RULE', payload: { rule } })).toThrow(/still use/i);
  });
});
