// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { createElement } from 'react';
import { TextEditor } from './TextEditor';
import type { TextEditorPlacement } from '../core/text-edit';

// The repo's jsdom tests do not run testing-library's automatic cleanup.
afterEach(cleanup);

const placement: TextEditorPlacement = {
  transform: 'matrix(1, 0, 0, 1, 40, 50)',
  left: 0,
  top: 0,
  width: 120,
  height: 30,
  font: '400 24px Inter, sans-serif',
  lineHeight: '30px',
  textAlign: 'left',
  color: '#123456',
  caretColor: '#123456',
};

function mount(overrides: Partial<Parameters<typeof TextEditor>[0]> = {}) {
  const onChange = vi.fn();
  const onCommit = vi.fn();
  const view = render(createElement(TextEditor, {
    placement, label: 'Big words', content: 'Hello', onChange, onCommit, ...overrides,
  }));
  return { ...view, onChange, onCommit };
}

describe('on-canvas text field', () => {
  it('is a real, labelled, focused text field over the object', () => {
    const { getByLabelText } = mount();
    const field = getByLabelText('Edit text: Big words') as HTMLTextAreaElement;
    expect(field.tagName).toBe('TEXTAREA');
    expect(field.value).toBe('Hello');
    expect(document.activeElement).toBe(field);
    // Caret at the end of the existing content, ready to continue typing.
    expect(field.selectionStart).toBe(5);
    expect(field.getAttribute('spellcheck')).toBe('false');
  });

  it('paints the field exactly where and how the canvas paints the text', () => {
    const { getByLabelText } = mount();
    const style = (getByLabelText('Edit text: Big words') as HTMLTextAreaElement).style;
    expect(style.transform).toBe('matrix(1, 0, 0, 1, 40, 50)');
    expect(style.transformOrigin).toBe('0 0');
    expect(style.width).toBe('120px');
    expect(style.height).toBe('30px');
    expect(style.font).toContain('24px');
    expect(style.lineHeight).toBe('30px');
    // jsdom normalises hex to rgb(); the value is the same ink.
    expect(style.color).toBe('rgb(18, 52, 86)');
    expect(style.background === 'transparent' || style.background === '').toBe(true);
    expect(style.border).toBe('0px');
  });

  it('reports every keystroke and commits on Escape', () => {
    const { getByLabelText, onChange, onCommit } = mount();
    const field = getByLabelText('Edit text: Big words') as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: 'Hello there' } });
    expect(onChange).toHaveBeenCalledWith('Hello there');
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('commits once, even if Escape is followed by blur', () => {
    const { getByLabelText, onCommit } = mount();
    const field = getByLabelText('Edit text: Big words') as HTMLTextAreaElement;
    fireEvent.keyDown(field, { key: 'Escape' });
    fireEvent.blur(field);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('commits on ⌘Enter and on Tab, but lets Enter make a new line', () => {
    const meta = mount({ label: 'Meta field' });
    fireEvent.keyDown(meta.getByLabelText('Edit text: Meta field'), { key: 'Enter', metaKey: true });
    expect(meta.onCommit).toHaveBeenCalledTimes(1);
    meta.unmount();

    const tab = mount({ label: 'Tab field' });
    // Tab commits and is *not* cancelled, so focus can leave and the field is not a trap.
    expect(fireEvent.keyDown(tab.getByLabelText('Edit text: Tab field'), { key: 'Tab' })).toBe(true);
    expect(tab.onCommit).toHaveBeenCalledTimes(1);
    tab.unmount();

    const escape = mount({ label: 'Escape field' });
    expect(fireEvent.keyDown(escape.getByLabelText('Edit text: Escape field'), { key: 'Escape' })).toBe(false);
    escape.unmount();

    const newline = mount({ label: 'Newline field' });
    fireEvent.keyDown(newline.getByLabelText('Edit text: Newline field'), { key: 'Enter' });
    expect(newline.onCommit).not.toHaveBeenCalled();
  });

  it('commits when focus leaves the field, which is what clicking the canvas does', () => {
    const { getByLabelText, onCommit } = mount();
    fireEvent.blur(getByLabelText('Edit text: Big words'));
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('does not wrap, so a long line does not silently become several', () => {
    const { getByLabelText } = mount();
    const field = getByLabelText('Edit text: Big words') as HTMLTextAreaElement;
    expect(field.getAttribute('wrap')).toBe('off');
    expect(field.style.whiteSpace).toBe('pre');
  });
});
