import { describe, expect, it } from 'vitest';
import {
  commitTextDraft, textDraftChanged, textEditingKeyAction, textEditingLabel, textEditorPlacement,
} from './text-edit';
import { DEFAULT_TEXT } from './text';
import type { AppearanceFill, TextContent } from './types';

const text = (overrides: Partial<TextContent> = {}): TextContent => ({ ...DEFAULT_TEXT, ...overrides });
const solid = (color: string): AppearanceFill => ({ type: 'solid', color, opacity: 1, visible: true });
const viewport = { offsetX: 0, offsetY: 0, scale: 1 };
const identity = { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 };

describe('text editor placement', () => {
  it('puts the field in the object’s own space through one matrix', () => {
    const placement = textEditorPlacement({
      viewport: { offsetX: 100, offsetY: 50, scale: 2 },
      transform: { x: 10, y: 20, rotation: 0, scaleX: 1, scaleY: 1 },
      text: text({ content: 'aa', family: 'mono', size: 10 }),
      fills: [solid('#123456')],
    });
    // local → document → screen: scale 2 applied to both the object transform and the offset.
    expect(placement.transform).toBe('matrix(2, 0, 0, 2, 120, 90)');
    expect(placement.width).toBeCloseTo(12, 6);
    expect(placement.height).toBeCloseTo(12.5, 6);
    expect(placement.color).toBe('#123456');
    expect(placement.caretColor).toBe('#123456');
  });

  it('carries rotation and the object’s scale into the matrix', () => {
    const placement = textEditorPlacement({
      viewport,
      transform: { x: 0, y: 0, rotation: 90, scaleX: 2, scaleY: 3 },
      text: text({ content: 'a' }),
      fills: [solid('#000000')],
    });
    // 90° turns the local x axis onto screen y; the scales stay on their own axes.
    expect(placement.transform).toBe('matrix(0, 2, -3, 0, 0, 0)');
  });

  it('matches the painted font, line box and alignment', () => {
    const placement = textEditorPlacement({
      viewport,
      transform: identity,
      text: text({ content: 'x', family: 'serif', size: 18, weight: 600, lineHeight: 1.5, align: 'right' }),
      fills: [solid('#000000')],
    });
    expect(placement.font).toContain('600 18px');
    expect(placement.font).toContain('Georgia');
    expect(placement.lineHeight).toBe('27px');
    expect(placement.textAlign).toBe('right');
  });

  it('edits gradient text against its first stop', () => {
    const placement = textEditorPlacement({
      viewport,
      transform: identity,
      text: text(),
      fills: [{
        type: 'linear', start: { x: 0, y: 0 }, end: { x: 10, y: 0 },
        stops: [{ offset: 0, color: '#ff0000', opacity: 1 }, { offset: 1, color: '#0000ff', opacity: 1 }],
        opacity: 1, visible: true,
      }],
    });
    expect(placement.color).toBe('#ff0000');
  });

  it('falls back to a visible ink and a positive box when the fill or text is empty', () => {
    const placement = textEditorPlacement({
      viewport, transform: identity, text: text({ content: '' }), fills: [],
    });
    expect(placement.color).toBeTruthy();
    expect(placement.width).toBeGreaterThan(0);
    expect(placement.height).toBeGreaterThan(0);
  });
});

describe('text editing keys', () => {
  it('commits on Escape, ⌘/Ctrl+Enter and forward Tab, and passes everything else', () => {
    expect(textEditingKeyAction({ key: 'Escape' })).toBe('commit');
    expect(textEditingKeyAction({ key: 'Enter', metaKey: true })).toBe('commit');
    expect(textEditingKeyAction({ key: 'Enter', ctrlKey: true })).toBe('commit');
    expect(textEditingKeyAction({ key: 'Tab' })).toBe('commit');
    expect(textEditingKeyAction({ key: 'Tab', shiftKey: true })).toBe('pass');
    expect(textEditingKeyAction({ key: 'Enter' })).toBe('pass');
    expect(textEditingKeyAction({ key: 'a' })).toBe('pass');
    expect(textEditingKeyAction({ key: 'Escape', metaKey: true })).toBe('commit');
  });
});

describe('text editing commits', () => {
  it('changes content and keeps everything else', () => {
    const before = text({ content: 'one', size: 22 });
    expect(commitTextDraft(before, 'two')).toEqual({ ...before, content: 'two' });
    expect(textDraftChanged(before, 'two')).toBe(true);
  });

  it('keeps trailing whitespace, because it is content someone typed', () => {
    expect(commitTextDraft(text({ content: 'a' }), 'a  ').content).toBe('a  ');
  });

  it('returns the same object when nothing changed', () => {
    const before = text({ content: 'same' });
    expect(commitTextDraft(before, 'same')).toBe(before);
    expect(textDraftChanged(before, 'same')).toBe(false);
  });

  it('names the history entry after the text, without newlines', () => {
    expect(textEditingLabel('Hello\nthere')).toBe('Edit text: Hello');
    expect(textEditingLabel('   ')).toBe('Edit text');
    expect(textEditingLabel('x'.repeat(40))).toBe(`Edit text: ${'x'.repeat(23)}…`);
  });
});
