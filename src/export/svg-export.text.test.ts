import { describe, expect, it } from 'vitest';
import { VectorDocument } from '../core/document';
import { OperationManager } from '../core/operations';
import type { TextContent } from '../core/types';
import { prepareTextObject } from '../tools/text-tool';
import { exportDocumentToSvg } from './svg-export';

function documentWithText(text: Partial<TextContent>, origin = { x: 20, y: 30 }) {
  const document = VectorDocument.createEmpty();
  const manager = new OperationManager(document);
  const plan = prepareTextObject(document, origin, { text });
  manager.beginTransaction('Add text');
  plan.operations.forEach((operation) => manager.execute(operation));
  manager.commitTransaction();
  return { document, manager, objectId: plan.objectId };
}

describe('SVG export of text', () => {
  it('writes one text element with a tspan per line and the object’s transform', () => {
    const { document } = documentWithText({
      content: 'Hello\nWorld', family: 'sans', size: 24, weight: 400, lineHeight: 1.25, align: 'left',
    });
    const svg = exportDocumentToSvg(document);
    expect(svg).toMatch(/<text transform="matrix\(1 0 0 1 20 30\)" font-family="Inter[^"]*" font-size="24" font-weight="400" text-anchor="start"/);
    expect(svg).toContain('<tspan x="0" y="24">Hello</tspan>');
    expect(svg).toContain('<tspan x="0" y="54">World</tspan>');
    expect(svg).not.toContain('<path');
  });

  it('anchors centred and right-aligned text at the box edge', () => {
    const centre = exportDocumentToSvg(documentWithText({ content: 'aa', family: 'mono', size: 10, align: 'center' }).document);
    expect(centre).toContain('text-anchor="middle"');
    expect(centre).toContain('<tspan x="6" y="10">aa</tspan>');
    const right = exportDocumentToSvg(documentWithText({ content: 'aa', family: 'mono', size: 10, align: 'right' }).document);
    expect(right).toContain('text-anchor="end"');
    expect(right).toContain('<tspan x="12" y="10">aa</tspan>');
  });

  it('escapes characters instead of emitting broken XML', () => {
    const svg = exportDocumentToSvg(documentWithText({ content: 'a < b & "c"' }).document);
    expect(svg).toContain('a &lt; b &amp; &quot;c&quot;');
  });

  it('carries a gradient fill through <defs> like any other object', () => {
    const { document, manager, objectId } = documentWithText({ content: 'Gradient' });
    const appearance = document.getAppearance(document.getObject(objectId)!.appearanceId)!;
    manager.execute({
      type: 'UPDATE_APPEARANCE',
      payload: {
        appearanceId: appearance.id,
        updates: {
          fills: [{
            type: 'linear', start: { x: 0, y: 0 }, end: { x: 100, y: 0 },
            stops: [{ offset: 0, color: '#ff0000', opacity: 1 }, { offset: 1, color: '#0000ff', opacity: 1 }],
            opacity: 1, visible: true,
          }],
        },
      },
    });
    const svg = exportDocumentToSvg(document);
    expect(svg).toMatch(/<linearGradient id="fill-\d+" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="100" y2="0">/);
    expect(svg).toMatch(/fill="url\(#fill-\d+\)"/);
  });

  it('flattens to the requested ink when an icon export overrides colours', () => {
    const svg = exportDocumentToSvg(documentWithText({ content: 'Ink' }).document, { fillColor: '#123456' });
    expect(svg).toContain('fill="#123456"');
  });
});
