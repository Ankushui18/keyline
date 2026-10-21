import { describe, expect, it } from 'vitest';
import { drawTextObject } from './renderer';
import { DEFAULT_TEXT } from '../core/text';
import type { AppearanceFill, TextContent } from '../core/types';

/** Records the calls `drawTextObject` would make on a real 2D context. */
function recordingContext() {
  const calls: Array<{ text: string; x: number; y: number }> = [];
  const gradients: Array<{ stops: Array<[number, string]> }> = [];
  const context = {
    font: '',
    fillStyle: '' as string | object,
    globalAlpha: 1,
    textBaseline: 'alphabetic',
    textAlign: 'left',
    transforms: [] as number[],
    calls,
    gradients,
    save() {},
    restore() {},
    transform(...values: number[]) {
      this.transforms.push(...values);
    },
    fillText(text: string, x: number, y: number) {
      calls.push({ text, x, y });
    },
    createLinearGradient() {
      const gradient = {
        stops: [] as Array<[number, string]>,
        addColorStop(offset: number, color: string) {
          this.stops.push([offset, color]);
        },
      };
      gradients.push(gradient);
      return gradient;
    },
    createRadialGradient() {
      throw new Error('not used here');
    },
  };
  return context;
}

const solid = (): AppearanceFill => ({ type: 'solid', color: '#112233', opacity: 1, visible: true });
const text = (overrides: Partial<TextContent> = {}): TextContent => ({ ...DEFAULT_TEXT, ...overrides });
const identity = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

describe('text rendering', () => {
  it('paints one line per row at the documented baselines', () => {
    const context = recordingContext();
    drawTextObject(
      context as unknown as CanvasRenderingContext2D,
      identity,
      text({ content: 'One\nTwo', family: 'mono', size: 10, lineHeight: 1.5 }),
      1,
      [solid()],
    );
    expect(context.calls.map((call) => call.text)).toEqual(['One', 'Two']);
    expect(context.calls[0].y).toBeCloseTo(15 * 0.8, 6);
    expect(context.calls[1].y).toBeCloseTo(15 + 15 * 0.8, 6);
    expect(context.font).toContain('10px');
    expect(context.fillStyle).toBe('#112233');
  });

  it('offsets lines inside the box for centring and right alignment', () => {
    const centre = recordingContext();
    drawTextObject(centre as unknown as CanvasRenderingContext2D, identity,
      text({ content: 'aa\nb', family: 'mono', size: 10, align: 'center' }), 1, [solid()]);
    expect(centre.calls[1].x).toBeCloseTo((12 - 6) / 2, 6);
    const right = recordingContext();
    drawTextObject(right as unknown as CanvasRenderingContext2D, identity,
      text({ content: 'aa\nb', family: 'mono', size: 10, align: 'right' }), 1, [solid()]);
    expect(right.calls[1].x).toBeCloseTo(6, 6);
  });

  it('applies the object transform and the object opacity', () => {
    const context = recordingContext();
    drawTextObject(context as unknown as CanvasRenderingContext2D, { a: 2, b: 0, c: 0, d: 2, e: 30, f: 40 },
      text({ content: 'Scaled' }), 0.5, [solid()]);
    expect(context.transforms).toEqual([2, 0, 0, 2, 30, 40]);
    expect(context.globalAlpha).toBeCloseTo(0.5, 6);
  });

  it('paints with a gradient in object-local space', () => {
    const context = recordingContext();
    drawTextObject(context as unknown as CanvasRenderingContext2D, identity, text({ content: 'Gradient' }), 1, [{
      type: 'linear', start: { x: 0, y: 0 }, end: { x: 100, y: 0 },
      stops: [{ offset: 0, color: '#ff0000', opacity: 1 }, { offset: 1, color: '#0000ff', opacity: 0.5 }],
      opacity: 1, visible: true,
    }]);
    expect(context.gradients).toHaveLength(1);
    expect(context.gradients[0].stops).toEqual([[0, '#ff0000'], [1, 'rgba(0, 0, 255, 0.5)']]);
  });

  it('draws nothing without a visible fill, and skips empty lines', () => {
    const hidden = recordingContext();
    drawTextObject(hidden as unknown as CanvasRenderingContext2D, identity, text(), 1,
      [{ type: 'solid', color: '#112233', opacity: 1, visible: false }]);
    expect(hidden.calls).toHaveLength(0);
    const blank = recordingContext();
    drawTextObject(blank as unknown as CanvasRenderingContext2D, identity, text({ content: 'a\n\nb' }), 1, [solid()]);
    expect(blank.calls.map((call) => call.text)).toEqual(['a', 'b']);
  });
});
