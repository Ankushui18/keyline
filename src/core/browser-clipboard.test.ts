import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyTextToClipboard } from './browser-clipboard';

afterEach(() => vi.unstubAllGlobals());
describe('optional clipboard access', () => {
  it('reports success only after text is written', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    expect(await copyTextToClipboard('share link')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('share link');
  });
  it('handles browsers without the Clipboard API', async () => {
    vi.stubGlobal('navigator', {});
    expect(await copyTextToClipboard('share link')).toBe(false);
  });
  it('handles denied permissions without an unhandled rejection', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('Denied')) } });
    expect(await copyTextToClipboard('share link')).toBe(false);
  });
});
