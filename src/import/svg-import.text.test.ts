// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { VectorDocument } from '../core/document';
import { OperationManager } from '../core/operations';
import { exportDocumentToSvg } from '../export/svg-export';
import { prepareTextObject } from '../tools/text-tool';
import { parseSvgDocument, type SvgImportResult } from './svg-import';

function parse(source: string): SvgImportResult {
  const document = new DOMParser().parseFromString(source, 'image/svg+xml');
  return parseSvgDocument(document.documentElement as unknown as SVGSVGElement);
}

/** The first imported object, which is the whole payload in most of these fixtures. */
const only = (result: SvgImportResult) => result.payload.objects[0].object;

describe('SVG text import', () => {
  it('reads content, size and anchor into a text object', () => {
    const result = parse(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">
        <text x="10" y="40" font-family="Helvetica, sans-serif" font-size="20" fill="#123456">Hello</text>
      </svg>`);
    const object = only(result);
    expect(object.text).toMatchObject({ content: 'Hello', family: 'sans', size: 20, weight: 400, align: 'left' });
    expect(result.payload.objects[0].appearance.fills[0]).toMatchObject({ type: 'solid', color: '#123456' });
    // The first baseline sits 0.8 of a line box below the box top: 40 - 20 * 1.25 * 0.8.
    expect(object.transform.x).toBeCloseTo(10, 6);
    expect(object.transform.y).toBeCloseTo(20, 6);
    expect(result.warnings).toEqual([]);
  });

  it('turns one tspan per explicit baseline into lines', () => {
    const result = parse(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">
        <text x="0" y="20" font-size="10">
          <tspan x="0" y="20">First</tspan>
          <tspan x="0" y="32">Second</tspan>
        </text>
      </svg>`);
    expect(only(result).text?.content).toBe('First\nSecond');
  });

  it('keeps a single tspan run on one line and maps text-anchor to alignment', () => {
    const result = parse(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">
        <text x="100" y="50" text-anchor="middle" font-size="12">A<tspan>B</tspan>C</text>
      </svg>`);
    expect(only(result).text).toMatchObject({ content: 'ABC', align: 'center' });
    expect(result.warnings).toEqual([]);
  });

  it('decomposes a translate and rotation into the object transform', () => {
    const result = parse(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
        <text x="0" y="0" font-size="10" transform="translate(50 60) rotate(30)">Turned</text>
      </svg>`);
    const object = only(result);
    expect(object.transform.rotation).toBeCloseTo(30, 6);
    expect(object.transform.scaleX).toBeCloseTo(1, 6);
    expect(object.transform.scaleY).toBeCloseTo(1, 6);
    expect(object.transform.x).toBeCloseTo(50, 6);
    expect(object.transform.y).toBeCloseTo(60 - 10 * 1.25 * 0.8, 6);
  });

  it('reports the features text cannot carry instead of dropping them silently', () => {
    const result = parse(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
        <text x="0" y="20" font-size="10" letter-spacing="2" textLength="100" font-family="Comic Neue">
          Outer<tspan fill="#ff0000"> red</tspan>
        </text>
        <path id="curve" d="M0 0 L100 100"/>
        <text x="0" y="40" font-size="10"><textPath href="#curve">On a path</textPath></text>
      </svg>`);
    const codes = result.warnings.map((warning) => warning.code);
    expect(codes).toEqual(expect.arrayContaining([
      'text-letter-spacing', 'text-length', 'text-runs', 'text-family', 'text-path',
    ]));
    // The path and both text elements are still imported; nothing is dropped.
    expect(result.payload.objects).toHaveLength(3);
    expect(result.payload.objects[2].object.text?.content).toContain('On a path');
  });

  it('survives a round trip through export and import', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const plan = prepareTextObject(document, { x: 12, y: 18 }, { text: { content: 'Round\ntrip', size: 16 } });
    manager.beginTransaction('text');
    plan.operations.forEach((operation) => manager.execute(operation));
    manager.commitTransaction();
    const imported = parse(exportDocumentToSvg(document));
    const object = imported.payload.objects.map((item) => item.object).find((item) => item.text);
    expect(object?.text?.content).toBe('Round\ntrip');
    expect(object?.text?.size).toBe(16);
    expect(object?.transform.x).toBeCloseTo(12, 3);
  });
});
