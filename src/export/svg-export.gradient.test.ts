import { describe, expect, it } from 'vitest';
import { VectorDocument } from '../core/document';
import { DEFAULT_DRAWING_STYLE } from '../core/drawing-style';
import { OperationManager } from '../core/operations';
import { preparePrimitiveObject } from '../tools/primitive-tool';
import { exportDocumentToSvg } from './svg-export';

/** A 100 × 100 rectangle at the frame origin, with the given fill. */
function rectangleWithFill(fill: unknown, transform?: { scaleX?: number; scaleY?: number }) {
  const document = VectorDocument.createEmpty();
  const manager = new OperationManager(document);
  const plan = preparePrimitiveObject(
    document, 'rectangle', { x: 0, y: 0 }, { x: 100, y: 100 }, { style: DEFAULT_DRAWING_STYLE },
  )!;
  manager.beginTransaction('Fixture');
  plan.operations.forEach((operation) => manager.execute(operation));
  const appearance = document.getAppearance(document.getObject(plan.objectId)!.appearanceId)!;
  manager.execute({ type: 'UPDATE_APPEARANCE', payload: { appearanceId: appearance.id, updates: { fills: [fill] } } });
  if (transform) {
    manager.execute({
      type: 'UPDATE_OBJECT',
      payload: {
        objectId: plan.objectId,
        updates: { transform: { ...document.getObject(plan.objectId)!.transform, ...transform } },
      },
    });
  }
  manager.commitTransaction();
  return document;
}

const stops = [
  { offset: 0, color: '#ff0000', opacity: 1 },
  { offset: 1, color: '#0000ff', opacity: 0.5 },
];

describe('SVG export of gradient fills', () => {
  it('writes one userSpaceOnUse linearGradient and points the path at it', () => {
    const svg = exportDocumentToSvg(rectangleWithFill({
      type: 'linear', start: { x: 0, y: 0 }, end: { x: 100, y: 0 }, stops, opacity: 1, visible: true,
    }));
    expect(svg).toContain('<defs>');
    expect(svg).toMatch(/<linearGradient id="fill-\d+" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="100" y2="0">/);
    expect(svg).toContain('<stop offset="0" stop-color="#ff0000"/>');
    expect(svg).toContain('<stop offset="1" stop-color="#0000ff" stop-opacity="0.5"/>');
    expect(svg).toMatch(/fill="url\(#fill-\d+\)"/);
  });

  it('writes a radial gradient with its centre and radius', () => {
    const svg = exportDocumentToSvg(rectangleWithFill({
      type: 'radial', center: { x: 50, y: 50 }, radius: 25, stops, opacity: 1, visible: true,
    }));
    expect(svg).toMatch(/<radialGradient id="fill-\d+" gradientUnits="userSpaceOnUse" cx="50" cy="50" r="25">/);
    expect(svg).toMatch(/fill="url\(#fill-\d+\)"/);
  });

  it('applies the occurrence transform, so a scaled shape keeps its gradient', () => {
    const svg = exportDocumentToSvg(rectangleWithFill({
      type: 'linear', start: { x: 0, y: 0 }, end: { x: 100, y: 0 }, stops, opacity: 1, visible: true,
    }, { scaleX: 2 }));
    console.log(svg.match(/<linearGradient[^>]*>/)?.[0]);
  });

  it('puts fill opacity on the path, leaving stop opacity on the stops', () => {
    const svg = exportDocumentToSvg(rectangleWithFill({
      type: 'linear', start: { x: 0, y: 0 }, end: { x: 100, y: 0 }, stops, opacity: 0.5, visible: true,
    }));
    expect(svg).toMatch(/fill="url\(#fill-\d+\)" fill-opacity="0.5"/);
  });

  it('keeps a solid fill a plain colour, with no definitions', () => {
    const svg = exportDocumentToSvg(rectangleWithFill({ type: 'solid', color: '#00ff00', opacity: 1, visible: true }));
    expect(svg).toContain('fill="#00ff00"');
    expect(svg).not.toContain('<linearGradient');
  });

  it('flattens to the requested ink when an icon export overrides colours', () => {
    const document = rectangleWithFill({
      type: 'linear', start: { x: 0, y: 0 }, end: { x: 100, y: 0 }, stops, opacity: 1, visible: true,
    });
    const svg = exportDocumentToSvg(document, { fillColor: '#123456' });
    expect(svg).toContain('fill="#123456"');
    expect(svg).not.toContain('<linearGradient');
  });
});
