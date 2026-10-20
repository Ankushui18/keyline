/** Preferences must never prevent drawing when storage is denied or full. */
const fallback = new Map<string, string>();

export function readPreference(key: string): string | null {
  if (fallback.has(key)) return fallback.get(key)!;
  try { return window.localStorage.getItem(key); } catch { return null; }
}

export function writePreference(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
    fallback.delete(key);
  } catch {
    // Keep identity and preferences stable for this tab even without persistence.
    fallback.set(key, value);
  }
}
