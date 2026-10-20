/** Small view-only setting: whether the pixel grid shows inside frames. It never changes the drawing. */
const KEY = 'keyline-pixel-grid';
const listeners = new Set<() => void>();
let visible = true;
try { visible = window.localStorage.getItem(KEY) !== 'off'; } catch { visible = true; }

export const isPixelGridVisible = () => visible;
export function setPixelGridVisible(next: boolean): void {
  visible = next;
  try { window.localStorage.setItem(KEY, next ? 'on' : 'off'); } catch { /* storage may be unavailable */ }
  listeners.forEach((listener) => listener());
}
export function subscribePixelGrid(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
