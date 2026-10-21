import { describe, expect, it } from 'vitest';
import { VectorDocument } from './document';
import { objectBounds } from './object-geometry';
import { OperationManager } from './operations';
import {
  DEFAULT_TEXT, clampLineHeight, clampTextSize, clampTextWeight, fallbackTextWidth, layoutText,
  normalizeTextContent, setTextMetricsProvider, textBoxCorners, textCssFont, textLines, textLocalBounds,
} from './text';
import { prepareDuplicateObject } from './object-operations';
import { prepareTextObject, textName } from '../tools/text-tool';
import { hitTestObject } from '../tools/select-tool';
import type { TextContent } from './types';

function textHarness(content = 'Hello', origin = { x: 10, y: 20 }, overrides: Partial<TextContent> = {}) {
  const document = VectorDocument.createEmpty();
  const manager = new OperationManager(document);
  const plan = prepareTextObject(document, origin, { text: { content, ...overrides } });
  manager.beginTransaction('Add text');
  plan.operations.forEach((operation) => manager.execute(operation));
  manager.commitTransaction();
  return { document, manager, objectId: plan.objectId };
}

const text = (overrides: Partial<TextContent> = {}): TextContent => ({ ...DEFAULT_TEXT, ...overrides });

describe('text content', () => {
  it('keeps explicit newlines and normalizes every style field', () => {
    expect(textLines('a\r\nb\nc')).toEqual(['a', 'b', 'c']);
    expect(normalizeTextContent({ content: 'x', size: 10_000, lineHeight: 0, weight: 650 as unknown as TextContent['weight'], align: 'center' }))
      .toEqual({ content: 'x', family: 'sans', size: 512, lineHeight: 0.5, weight: 600, align: 'center' });
    expect(normalizeTextContent(undefined)).toBeUndefined();
  });

  it('clamps between the documented limits', () => {
    expect(clampTextSize(1)).toBe(4);
    expect(clampTextSize(Number.NaN)).toBe(DEFAULT_TEXT.size);
    expect(clampLineHeight(9)).toBe(4);
    expect(clampTextWeight(420)).toBe(400);
    expect(clampTextWeight(560)).toBe(600);
  });

  it('names a new text object after its first words, so Layers stays readable', () => {
    expect(textName(text({ content: '  Hello world  ' }))).toBe('Hello world');
    expect(textName(text({ content: '   \n second line' }))).toBe('second line');
    expect(textName(text({ content: '' }))).toBe('Text');
    expect(textName(text({ content: 'x'.repeat(40) })).endsWith('…')).toBe(true);
  });
});

describe('text layout', () => {
  it('measures with the deterministic fallback when no provider is installed', () => {
    // 'mono' is a flat 0.6em per character: five characters at 20px.
    expect(fallbackTextWidth('Hello', text({ family: 'mono', size: 20 }))).toBeCloseTo(5 * 0.6 * 20, 6);
    expect(fallbackTextWidth('', text())).toBe(0);
  });

  it('builds a box from the widest line and the line count', () => {
    const layout = layoutText(text({ content: 'one\nthree', family: 'mono', size: 10, lineHeight: 1.5 }));
    expect(layout.lines).toHaveLength(2);
    expect(layout.width).toBeCloseTo(5 * 0.6 * 10, 6);
    expect(layout.height).toBeCloseTo(2 * 10 * 1.5, 6);
    expect(layout.baseline(0)).toBeCloseTo(15 * 0.8, 6);
    expect(layout.baseline(1)).toBeCloseTo(15 + 15 * 0.8, 6);
  });

  it('keeps a caret-width box for empty content so it stays selectable', () => {
    const layout = layoutText(text({ content: '', size: 20 }));
    expect(layout.lines).toHaveLength(1);
    expect(layout.width).toBeCloseTo(12, 6);
    expect(layout.height).toBeCloseTo(20 * DEFAULT_TEXT.lineHeight, 6);
  });

  it('positions lines inside the box according to alignment', () => {
    const left = layoutText(text({ content: 'aa\nb', family: 'mono', size: 10, align: 'left' }));
    expect(left.lineLeft(left.lines[1])).toBe(0);
    const center = layoutText(text({ content: 'aa\nb', family: 'mono', size: 10, align: 'center' }));
    expect(center.lineLeft(center.lines[1])).toBeCloseTo((12 - 6) / 2, 6);
    const right = layoutText(text({ content: 'aa\nb', family: 'mono', size: 10, align: 'right' }));
    expect(right.lineLeft(right.lines[1])).toBeCloseTo(6, 6);
  });

  it('uses an installed provider and restores the fallback afterwards', () => {
    setTextMetricsProvider(() => 100);
    expect(layoutText(text({ content: 'anything' })).width).toBe(100);
    setTextMetricsProvider(undefined);
    expect(layoutText(text({ content: 'Hello' })).width).not.toBe(100);
  });

  it('describes the same font shorthand everywhere', () => {
    expect(textCssFont(text({ family: 'serif', size: 18, weight: 600 }))).toContain('600 18px');
    expect(textCssFont(text({ family: 'serif' }))).toContain('Georgia');
  });

  it('reports the box corners in local space', () => {
    const bounds = textLocalBounds(text({ content: 'aa', family: 'mono', size: 10 }));
    expect(bounds).toMatchObject({ minX: 0, minY: 0 });
    expect(bounds.width).toBeCloseTo(12, 6);
    expect(textBoxCorners(text({ content: 'aa', family: 'mono', size: 10 }))).toEqual([
      { x: 0, y: 0 }, { x: 12, y: 0 }, { x: 12, y: 12.5 }, { x: 0, y: 12.5 },
    ]);
  });
});

describe('text objects in a document', () => {
  it('is created as an ordinary object with an empty network and a text field', () => {
    const { document, objectId } = textHarness();
    const object = document.getObject(objectId)!;
    expect(object.text?.content).toBe('Hello');
    expect(document.getNetwork(object.networkId)).toMatchObject({ nodeIds: [], pathIds: [] });
    expect(document.getAppearance(object.appearanceId)!.fills).toHaveLength(1);
    expect(document.getLayerForObject(objectId)?.kind).toBe('object');
  });

  it('takes its bounds from the measured box, placed by the object transform', () => {
    const { document, objectId } = textHarness('aa', { x: 100, y: 50 }, { family: 'mono', size: 10 });
    const bounds = objectBounds(document, objectId);
    expect(bounds.minX).toBeCloseTo(100, 6);
    expect(bounds.minY).toBeCloseTo(50, 6);
    expect(bounds.width).toBeCloseTo(12, 6);
    expect(bounds.height).toBeCloseTo(12.5, 6);
  });

  it('is selectable and draggable from its box, and not from outside it', () => {
    const { document, objectId } = textHarness('aa', { x: 100, y: 50 }, { family: 'mono', size: 10 });
    expect(hitTestObject(document, { x: 106, y: 56 }, 0)?.id).toBe(objectId);
    expect(hitTestObject(document, { x: 100, y: 50 }, 0)?.id).toBe(objectId);
    expect(hitTestObject(document, { x: 200, y: 200 }, 0)).toBeNull();
  });

  it('moves, rotates and scales through the existing object transform', () => {
    const { document, manager, objectId } = textHarness('aa', { x: 100, y: 50 }, { family: 'mono', size: 10 });
    const transform = { ...document.getObject(objectId)!.transform, x: 200, y: 150, scaleX: 2, scaleY: 2 };
    manager.execute({ type: 'UPDATE_OBJECT', payload: { objectId, updates: { transform } } });
    const bounds = objectBounds(document, objectId);
    expect(bounds.minX).toBeCloseTo(200, 6);
    expect(bounds.width).toBeCloseTo(24, 6);
    expect(bounds.height).toBeCloseTo(25, 6);
  });

  it('survives save and reload, and copies do not share content', () => {
    const { document, objectId } = textHarness('Saved text');
    const snapshot = JSON.parse(JSON.stringify(document.toSnapshot()));
    const reopened = new VectorDocument(snapshot);
    expect(reopened.getObject(objectId)?.text?.content).toBe('Saved text');
    const original = document.getObject(objectId)!;
    const copy = JSON.parse(JSON.stringify(original));
    copy.text.content = 'Changed';
    expect(original.text?.content).toBe('Saved text');
  });

  it('duplicates through the shared object path, with its own text', () => {
    const { document, manager, objectId } = textHarness('Copy me');
    const plan = prepareDuplicateObject(document, objectId)!;
    manager.beginTransaction('Duplicate');
    plan.operations.forEach((operation) => manager.execute(operation));
    manager.commitTransaction();
    const copy = document.getObject(plan.objectId)!;
    expect(copy.text?.content).toBe('Copy me');
    expect(copy.text).not.toBe(document.getObject(objectId)!.text);
    expect(copy.transform.x).toBeGreaterThan(document.getObject(objectId)!.transform.x);
  });

  it('edits through one UPDATE_OBJECT per change, so Undo has one step to restore', () => {
    const { document, manager, objectId } = textHarness('First');
    const before = document.getObject(objectId)!.text!;
    manager.beginTransaction('Edit text');
    manager.execute({
      type: 'UPDATE_OBJECT',
      payload: { objectId, updates: { text: { ...before, content: 'Second' } } },
    });
    manager.commitTransaction();
    expect(document.getObject(objectId)?.text?.content).toBe('Second');
    manager.undo();
    expect(document.getObject(objectId)?.text?.content).toBe('First');
    manager.redo();
    expect(document.getObject(objectId)?.text?.content).toBe('Second');
  });
});
