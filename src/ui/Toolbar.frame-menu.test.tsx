// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { createElement } from 'react';
import { FRAME_PRESETS, framePresetSize } from '../core/frame-presets';
import { Toolbar } from './Toolbar';

/**
 * The frame menu is generated from `core/frame-presets.ts`, so this test is what keeps
 * the toolbar honest: every preset exists in the menu, in its own group, with its size
 * spelled the same way, and choosing one creates exactly that frame.
 */
function renderToolbar() {
  const onAddFrame = vi.fn();
  const onAddText = vi.fn();
  const noop = () => {};
  const toolbar = render(createElement(Toolbar, {
    canUndo: false, canRedo: false, documentName: 'Untitled', onRenameDocument: noop,
    isEmpty: false, saveStatus: 'saved', constraintCount: 0, constraintsOpen: false,
    solverStatus: 'ready', collaborationStatus: null, collaborators: [],
    onHome: noop, onShare: noop, onOpenSettings: noop, onOpenCommand: noop,
    onOpenMotion: noop, onOpenCheck: noop, onOpenSet: noop,
    onAddFrame, onAddText, onToggleConstraints: noop, onExport: noop, onUndo: noop, onRedo: noop,
  } as never));
  fireEvent.click(toolbar.getByLabelText('More'));
  return { ...toolbar, onAddFrame, onAddText };
}

describe('frame menu', () => {
  it('offers Add text and calls back once, closing the menu', () => {
    const { container, getByLabelText, unmount, onAddText } = renderToolbar();
    const item = container.querySelector('button[aria-label="Add text"]') as HTMLButtonElement;
    expect(item).toBeTruthy();
    fireEvent.click(item);
    expect(onAddText).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.topbar-more-menu')).toBeNull();
    expect(getByLabelText('More').getAttribute('aria-expanded')).toBe('false');
    unmount();
  });

  it('lists every preset from the shared list, grouped, with its size', () => {
    const { container, unmount } = renderToolbar();
    for (const preset of FRAME_PRESETS) {
      const label = `New ${preset.label} frame ${framePresetSize(preset)}`;
      const button = container.querySelector(`button[aria-label="${label}"]`);
      expect(button, label).toBeTruthy();
      expect(button!.textContent).toContain(framePresetSize(preset));
    }
    const groups = [...container.querySelectorAll('.topbar-frame-group')]
      .map((group) => group.getAttribute('aria-label'));
    expect(groups).toEqual(['Interface frames', 'Web frames', 'Device frames', 'Social frames', 'Print frames', 'Artwork frames']);
    unmount();
  });

  it('creates the frame the menu item promises, with the preset name', () => {
    const { container, onAddFrame, unmount } = renderToolbar();
    fireEvent.click(container.querySelector<HTMLButtonElement>('button[aria-label="New Social post frame 1080 × 1080"]')!);
    expect(onAddFrame).toHaveBeenCalledWith(1080, 1080, 'Social post');
    unmount();
  });

  it('keeps icon presets unnamed so the icon workflow names its own frames', () => {
    const { container, onAddFrame, unmount } = renderToolbar();
    fireEvent.click(container.querySelector<HTMLButtonElement>('button[aria-label="New Interface icon frame 24 × 24"]')!);
    expect(onAddFrame).toHaveBeenCalledWith(24, 24, undefined);
    unmount();
  });
});
