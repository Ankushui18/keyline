import { setTextMetricsProvider, textCssFont, type TextMetricsProvider } from '../core/text';

/**
 * The browser metrics provider for text (docs/EDITING-AUDIT.md §3.9).
 *
 * The canvas that renders the text also measures it, so a text object's box matches the
 * glyphs the user sees. Node, workers and the test suite keep the deterministic fallback in
 * `core/text.ts`, which is why nothing measured is ever written into a document.
 */
export function canvasTextMetricsProvider(
  context: Pick<CanvasRenderingContext2D, 'font' | 'measureText'>,
): TextMetricsProvider {
  return (line, text) => {
    context.font = textCssFont(text);
    return context.measureText(line).width;
  };
}

/**
 * Installs canvas measurement for the whole app. Safe to call more than once; returns a
 * function that restores the fallback, which is what tests use.
 */
export function installCanvasTextMetrics(): () => void {
  if (typeof document === 'undefined') return () => setTextMetricsProvider(undefined);
  const context = document.createElement('canvas').getContext('2d');
  if (!context) return () => setTextMetricsProvider(undefined);
  setTextMetricsProvider(canvasTextMetricsProvider(context));
  return () => setTextMetricsProvider(undefined);
}
