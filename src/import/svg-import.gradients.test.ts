// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { parseSvgDocument, type SvgImportResult } from './svg-import';
import type { LinearGradientFill } from '../core/types';

/** Parse an SVG string the way the app does, through the browser's own XML parser. */
function parse(source: string): SvgImportResult {
  const document = new DOMParser().parseFromString(source, 'image/svg+xml');
  return parseSvgDocument(document.documentElement as unknown as SVGSVGElement);
}

const linearFill = (result: SvgImportResult, index = 0) => {
  const fill = result.payload.objects[index].appearance.fills[0];
  if (fill?.type !== 'linear') throw new Error(`Expected a linear gradient, found ${fill?.type ?? 'nothing'}.`);
  return fill as LinearGradientFill;
};

describe('SVG gradient import', () => {
  it('resolves an objectBoundingBox gradient against the shape’s own box', () => {
    const result = parse(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">
        <defs>
          <linearGradient id="g" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stop-color="#ff0000"/>
            <stop offset="1" stop-color="#0000ff" stop-opacity="0.5"/>
          </linearGradient>
        </defs>
        <rect x="10" y="10" width="100" height="50" fill="url(#g)"/>
      </svg>`);
    const fill = linearFill(result);
    expect(fill.start).toEqual({ x: 10, y: 10 });
    expect(fill.end).toEqual({ x: 110, y: 10 });
    expect(fill.stops).toEqual([
      { offset: 0, color: '#ff0000', opacity: 1 },
      { offset: 1, color: '#0000ff', opacity: 0.5 },
    ]);
    expect(fill.visible).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('keeps userSpaceOnUse coordinates and the fill opacity from the shape', () => {
    const result = parse(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">
        <defs>
          <linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="200" y2="100">
            <stop offset="0%" stop-color="#112233"/>
            <stop offset="100%" stop-color="#445566"/>
          </linearGradient>
        </defs>
        <rect width="200" height="100" fill="url(#g)" fill-opacity="0.4"/>
      </svg>`);
    const fill = linearFill(result);
    expect(fill.start).toEqual({ x: 0, y: 0 });
    expect(fill.end).toEqual({ x: 200, y: 100 });
    expect(fill.opacity).toBeCloseTo(0.4, 6);
  });

  it('inherits geometry and stops through href, as a recoloured copy does', () => {
    const result = parse(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <defs>
          <linearGradient id="base">
            <stop offset="0" stop-color="#000000"/>
            <stop offset="1" stop-color="#ffffff"/>
          </linearGradient>
          <linearGradient id="child" href="#base" x1="0" y1="0" x2="0" y2="1"/>
        </defs>
        <rect width="100" height="100" fill="url(#child)"/>
      </svg>`);
    const fill = linearFill(result);
    expect(fill.start).toEqual({ x: 0, y: 0 });
    expect(fill.end).toEqual({ x: 0, y: 100 });
    expect(fill.stops.map((stop) => stop.color)).toEqual(['#000000', '#ffffff']);
  });

  it('imports a radial gradient and centres it in the shape', () => {
    const result = parse(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <defs>
          <radialGradient id="g">
            <stop offset="0" stop-color="#ffffff"/>
            <stop offset="1" stop-color="#000000"/>
          </radialGradient>
        </defs>
        <rect x="0" y="0" width="80" height="80" fill="url(#g)"/>
      </svg>`);
    const fill = result.payload.objects[0].appearance.fills[0];
    expect(fill?.type).toBe('radial');
    expect(fill?.type === 'radial' ? fill.center : undefined).toEqual({ x: 40, y: 40 });
    expect(fill?.type === 'radial' ? fill.radius : undefined).toBeCloseTo(40, 6);
  });

  it('bakes the element transform into the gradient, so it stays on the shape', () => {
    const result = parse(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
        <defs>
          <linearGradient id="g" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/>
          </linearGradient>
        </defs>
        <rect x="0" y="0" width="50" height="50" transform="translate(100 100)" fill="url(#g)"/>
      </svg>`);
    const fill = linearFill(result);
    expect(fill.start).toEqual({ x: 100, y: 100 });
    expect(fill.end).toEqual({ x: 150, y: 100 });
  });
});

describe('SVG gradient import warnings', () => {
  const codes = (result: SvgImportResult) => result.warnings.map((warning) => warning.code);

  it('reports a pattern fill instead of silently painting nothing', () => {
    const result = parse(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <defs><pattern id="p" width="10" height="10"><rect width="5" height="5" fill="#000000"/></pattern></defs>
        <rect width="100" height="100" fill="url(#p)"/>
      </svg>`);
    expect(codes(result)).toContain('pattern-fill');
    expect(result.payload.objects[0].appearance.fills).toEqual([]);
  });

  it('reports a missing gradient reference', () => {
    const result = parse(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <rect width="100" height="100" fill="url(#nope)"/>
      </svg>`);
    expect(codes(result)).toContain('gradient-missing');
    expect(result.warnings[0].message).toContain('nope');
  });

  it('reports the features a gradient cannot carry: spread, focal point and skew', () => {
    const result = parse(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <defs>
          <linearGradient id="l" spreadMethod="reflect">
            <stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/>
          </linearGradient>
          <radialGradient id="r" fx="0.1" fy="0.1">
            <stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#000000"/>
          </radialGradient>
          <radialGradient id="skewed" gradientTransform="skewX(20)">
            <stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#000000"/>
          </radialGradient>
        </defs>
        <rect width="100" height="100" fill="url(#l)"/>
        <rect width="100" height="100" fill="url(#r)"/>
        <rect width="100" height="100" fill="url(#skewed)"/>
      </svg>`);
    expect(codes(result)).toEqual(expect.arrayContaining(['gradient-spread', 'gradient-focal', 'gradient-transform']));
    // The fills are still imported — a warning is not a silent drop.
    expect(result.payload.objects).toHaveLength(3);
    expect(result.payload.objects.every((object) => object.appearance.fills.length === 1)).toBe(true);
  });

  it('reports a filter, mask or clip path and an open path that asked for a fill', () => {
    const result = parse(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <rect width="100" height="100" fill="#123456" filter="url(#blur)"/>
        <path d="M0 0 L10 10" fill="#ff0000"/>
      </svg>`);
    expect(codes(result)).toEqual(expect.arrayContaining(['filter-dropped', 'open-path-fill']));
  });

  it('reports a radial gradient squeezed by a non-uniform objectBoundingBox', () => {
    const result = parse(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">
        <defs>
          <radialGradient id="g">
            <stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#000000"/>
          </radialGradient>
        </defs>
        <rect width="200" height="50" fill="url(#g)"/>
      </svg>`);
    expect(codes(result)).toContain('gradient-radial');
    const fill = result.payload.objects[0].appearance.fills[0];
    // Same-area circle: sqrt(200 * 50) * 0.5.
    expect(fill?.type === 'radial' ? fill.radius : undefined).toBeCloseTo(Math.sqrt(200 * 50) / 2, 6);
  });
});
