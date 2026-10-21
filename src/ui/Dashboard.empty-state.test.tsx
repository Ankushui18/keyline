// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { Dashboard } from './Dashboard';

// The dashboard reads this device's file list; these tests are about the empty state.
vi.mock('../core/store', () => ({
  listDocuments: async () => [],
  renameStoredDocument: async () => {},
  deleteStoredDocument: async () => {},
}));

describe('neutral empty state', () => {
  it('opens on a general-purpose file instead of an icon set', async () => {
    const onStart = vi.fn();
    const view = render(createElement(Dashboard, { onOpen: vi.fn(), onStart }));
    fireEvent.click(view.getByText('New file'));
    expect(onStart).toHaveBeenCalledTimes(1);
    const action = onStart.mock.calls[0][0];
    expect(action.kind).toBe('preset');
    expect(action.presetId).not.toBe('icon-24');
    view.unmount();
  });

  it('offers a general start beside the icon one, and says so when there are no files', async () => {
    const view = render(createElement(Dashboard, { onOpen: vi.fn(), onStart: vi.fn() }));
    expect(view.getByText('Blank canvas')).toBeTruthy();
    expect(view.getByText('Social post')).toBeTruthy();
    // The icon workflow is an option, not the only door in.
    expect(view.getByText('Icon set')).toBeTruthy();
    await waitFor(() => expect(view.getByText(/Start with a blank canvas/)).toBeTruthy());
    expect(view.container.textContent).not.toContain('Start with an icon set');
    view.unmount();
  });
});
