import { afterEach, describe, expect, it, vi } from 'vitest';
import { readPreference, writePreference } from './preferences';

afterEach(() => vi.unstubAllGlobals());

describe('storage-safe preferences', () => {
  it('uses available browser storage', () => {
    const data = new Map<string, string>();
    vi.stubGlobal('window', { localStorage: { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value) } });
    writePreference('normal', 'canvas2d');
    expect(readPreference('normal')).toBe('canvas2d');
    expect(readPreference('absent')).toBeNull();
  });

  it('survives a throwing storage accessor and keeps session identity stable', () => {
    vi.stubGlobal('window', Object.defineProperty({}, 'localStorage', { get() { throw new DOMException('Blocked', 'SecurityError'); } }));
    expect(readPreference('blocked')).toBeNull();
    expect(() => writePreference('identity', 'same-designer')).not.toThrow();
    expect(readPreference('identity')).toBe('same-designer');
  });

  it('uses the latest value if storage quota is exhausted', () => {
    vi.stubGlobal('window', { localStorage: { getItem: () => 'old-value', setItem: () => { throw new DOMException('Full', 'QuotaExceededError'); } } });
    writePreference('quota', 'new-value');
    expect(readPreference('quota')).toBe('new-value');
  });
});
