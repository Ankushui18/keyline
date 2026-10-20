import { createEntityId } from '../core/ids';
import type { ClipboardObject, VectorClipboardPayload } from '../core/clipboard';
import type {
  Appearance,
  Point,
  Segment,
  StrokeStyle,
  VectorNode,
  VectorPath,
} from '../core/types';
import {
  DEFAULT_IMPORT_INK,
} from '../design-system/document-defaults';

type Matrix = [number, number, number, number, number, number];
interface TempNode { position: Point; handleIn?: Point; handleOut?: Point }
interface TempSegment { start: number; end: number; type: 'line' | 'bezier' }
export interface ParsedSubpath { nodes: TempNode[]; segments: TempSegment[]; isClosed: boolean }

interface CssRule { selectors: string[]; declarations: Map<string, string> }
interface SvgStyle {
  fill: string;
  stroke: string;
  color: string;
  strokeWidth: number;
  strokeLinecap: StrokeStyle['cap'];
  strokeLinejoin: StrokeStyle['join'];
  strokeDasharray: number[];
  fillOpacity: number;
  strokeOpacity: number;
  opacity: number;
  display: string;
  visibility: string;
}

export interface SvgImportResult {
  viewport: { minX: number; minY: number; width: number; height: number };
  payload: VectorClipboardPayload;
  importedElementCount: number;
  skippedElementCount: number;
}

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const DEFAULT_STYLE: SvgStyle = {
  fill: DEFAULT_IMPORT_INK, stroke: 'none', color: DEFAULT_IMPORT_INK, strokeWidth: 1,
  strokeLinecap: 'butt', strokeLinejoin: 'miter', strokeDasharray: [],
  fillOpacity: 1, strokeOpacity: 1, opacity: 1, display: 'inline', visibility: 'visible',
};
const SHAPE_TAGS = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon']);
const CONTAINER_TAGS = new Set(['svg', 'g', 'a', 'symbol']);
const SKIP_SUBTREES = new Set(['defs', 'clipPath', 'mask', 'pattern', 'linearGradient', 'radialGradient', 'filter', 'metadata', 'title', 'desc', 'style', 'script']);

/** Converts common SVG geometry into operation-ready Keyline graph objects. */
export function parseSvgDocument(root: SVGSVGElement): SvgImportResult {
  const items: Array<{ name: string; paths: ParsedSubpath[]; style: SvgStyle; matrix: Matrix }> = [];
  const cssRules = parseCssRules(root);
  let skippedElementCount = 0;
  const useStack = new Set<Element>();

  const visit = (element: Element, parentMatrix: Matrix, parentStyle: SvgStyle, fromUse = false) => {
    const tag = element.localName;
    if (SKIP_SUBTREES.has(tag) && !fromUse) return;
    const style = resolveStyle(element, parentStyle, cssRules);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return;
    const localMatrix = multiply(parentMatrix, parseTransform(element.getAttribute('transform')));

    if (tag === 'use') {
      const href = element.getAttribute('href') ?? element.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
      const target = href?.startsWith('#') ? root.ownerDocument.getElementById(href.slice(1)) : null;
      if (!target || useStack.has(target)) { skippedElementCount += 1; return; }
      const x = length(element.getAttribute('x')) ?? 0;
      const y = length(element.getAttribute('y')) ?? 0;
      useStack.add(target);
      visit(target, multiply(localMatrix, [1, 0, 0, 1, x, y]), style, true);
      useStack.delete(target);
      return;
    }

    if (SHAPE_TAGS.has(tag)) {
      try {
        const paths = pathsForElement(element).filter((path) => path.segments.length > 0);
        if (paths.length > 0) items.push({ name: elementName(element, items.length + 1), paths, style, matrix: localMatrix });
        else skippedElementCount += 1;
      } catch {
        skippedElementCount += 1;
      }
      return;
    }

    if (CONTAINER_TAGS.has(tag) || (fromUse && tag === 'defs')) {
      [...element.children].forEach((child) => visit(child, localMatrix, style));
      return;
    }

    if (!SKIP_SUBTREES.has(tag)) skippedElementCount += 1;
  };

  visit(root, IDENTITY, DEFAULT_STYLE);
  const transformed = items.map((item) => ({
    ...item,
    paths: item.paths.map((path) => transformSubpath(path, item.matrix)),
  }));
  const viewport = svgViewport(root, transformed.flatMap((item) => item.paths));
  const objects = transformed.map((item) => clipboardObject(item.name, item.paths, item.style, item.matrix));
  return {
    viewport,
    payload: {
      kind: 'vector-studio/objects', version: 2, intent: 'copy', objects,
      constraints: [], parametricGroups: [], regionFills: [],
    },
    importedElementCount: objects.length,
    skippedElementCount,
  };
}

function clipboardObject(name: string, paths: ParsedSubpath[], style: SvgStyle, matrix: Matrix): ClipboardObject {
  const networkId = createEntityId();
  const appearanceId = createEntityId();
  const objectId = createEntityId();
  const layerId = createEntityId();
  const nodes: VectorNode[] = [];
  const vectorPaths: VectorPath[] = [];
  const segments: Segment[] = [];

  paths.forEach((sourcePath) => {
    const nodeIds = sourcePath.nodes.map(() => createEntityId());
    sourcePath.nodes.forEach((node, index) => nodes.push({
      id: nodeIds[index], position: node.position,
      handleIn: node.handleIn, handleOut: node.handleOut,
      handleMode: node.handleIn && node.handleOut ? 'corner' : undefined,
      constraintIds: [],
    }));
    const pathId = createEntityId();
    const pathSegments = sourcePath.segments.map((segment) => {
      const id = createEntityId();
      segments.push({
        id, startNodeId: nodeIds[segment.start], endNodeId: nodeIds[segment.end],
        type: segment.type, role: 'geometry',
      });
      return id;
    });
    vectorPaths.push({ id: pathId, segmentIds: pathSegments, isClosed: sourcePath.isClosed });
  });

  const hasClosedPath = paths.some((path) => path.isClosed);
  const fill = paint(style.fill, style.color);
  const stroke = paint(style.stroke, style.color);
  const strokeScale = Math.sqrt(Math.abs(matrix[0] * matrix[3] - matrix[1] * matrix[2])) || 1;
  const appearance: Appearance = {
    id: appearanceId,
    fills: fill && hasClosedPath ? [{ type: 'solid', color: fill, opacity: clamp01(style.fillOpacity), visible: true }] : [],
    stroke: {
      color: stroke ?? DEFAULT_IMPORT_INK, width: Math.max(0, style.strokeWidth * strokeScale),
      cap: style.strokeLinecap, join: style.strokeLinejoin, alignment: 'center',
      opacity: clamp01(style.strokeOpacity), dash: style.strokeDasharray.map((value) => value * strokeScale),
      visible: Boolean(stroke) && style.strokeWidth > 0,
    },
    opacity: clamp01(style.opacity),
  };
  return {
    object: { id: objectId, name, networkId, appearanceId, transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 } },
    layer: { id: layerId, kind: 'object', name, artboardId: '', childIds: [], objectId, visible: true, locked: false, expanded: true },
    appearance,
    network: { id: networkId, nodeIds: nodes.map((node) => node.id), pathIds: vectorPaths.map((path) => path.id) },
    nodes, paths: vectorPaths, segments,
  };
}

function pathsForElement(element: Element): ParsedSubpath[] {
  const tag = element.localName;
  if (tag === 'path') return parseSvgPathData(element.getAttribute('d') ?? '');
  if (tag === 'line') {
    return parseSvgPathData(`M ${numberAttr(element, 'x1')} ${numberAttr(element, 'y1')} L ${numberAttr(element, 'x2')} ${numberAttr(element, 'y2')}`);
  }
  if (tag === 'polyline' || tag === 'polygon') {
    const points = numbers(element.getAttribute('points') ?? '');
    if (points.length < 4) return [];
    let data = `M ${points[0]} ${points[1]}`;
    for (let index = 2; index + 1 < points.length; index += 2) data += ` L ${points[index]} ${points[index + 1]}`;
    if (tag === 'polygon') data += ' Z';
    return parseSvgPathData(data);
  }
  if (tag === 'rect') {
    const x = numberAttr(element, 'x'); const y = numberAttr(element, 'y');
    const width = Math.max(0, numberAttr(element, 'width')); const height = Math.max(0, numberAttr(element, 'height'));
    if (width <= 0 || height <= 0) return [];
    const requestedRx = length(element.getAttribute('rx'));
    const requestedRy = length(element.getAttribute('ry'));
    const rx = Math.min(width / 2, Math.max(0, requestedRx ?? requestedRy ?? 0));
    const ry = Math.min(height / 2, Math.max(0, requestedRy ?? requestedRx ?? 0));
    if (rx <= 0 || ry <= 0) return parseSvgPathData(`M ${x} ${y} H ${x + width} V ${y + height} H ${x} Z`);
    return parseSvgPathData(`M ${x + rx} ${y} H ${x + width - rx} A ${rx} ${ry} 0 0 1 ${x + width} ${y + ry} V ${y + height - ry} A ${rx} ${ry} 0 0 1 ${x + width - rx} ${y + height} H ${x + rx} A ${rx} ${ry} 0 0 1 ${x} ${y + height - ry} V ${y + ry} A ${rx} ${ry} 0 0 1 ${x + rx} ${y} Z`);
  }
  if (tag === 'circle' || tag === 'ellipse') {
    const cx = numberAttr(element, 'cx'); const cy = numberAttr(element, 'cy');
    const rx = tag === 'circle' ? numberAttr(element, 'r') : numberAttr(element, 'rx');
    const ry = tag === 'circle' ? rx : numberAttr(element, 'ry');
    if (rx <= 0 || ry <= 0) return [];
    return parseSvgPathData(`M ${cx - rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx + rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx - rx} ${cy} Z`);
  }
  return [];
}

/** Parses M/L/H/V/C/S/Q/T/A/Z, absolute or relative, and converts SVG arcs to editable cubic Béziers. */
export function parseSvgPathData(data: string): ParsedSubpath[] {
  const tokens = data.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) ?? [];
  const output: ParsedSubpath[] = [];
  let index = 0;
  let command = '';
  let current: Point = { x: 0, y: 0 };
  let currentPath: ParsedSubpath | null = null;
  let lastCubic: Point | undefined;
  let lastQuadratic: Point | undefined;

  const isCommand = (token: string | undefined) => Boolean(token && /^[a-zA-Z]$/.test(token));
  const hasNumber = () => index < tokens.length && !isCommand(tokens[index]);
  const read = () => {
    if (!hasNumber()) throw new Error('Malformed SVG path data.');
    const value = Number(tokens[index++]);
    if (!Number.isFinite(value)) throw new Error('SVG path contains a non-finite value.');
    return value;
  };
  const point = (relative: boolean): Point => {
    const value = { x: read(), y: read() };
    return relative ? { x: current.x + value.x, y: current.y + value.y } : value;
  };
  const ensurePath = () => {
    if (!currentPath || currentPath.isClosed) {
      currentPath = { nodes: [{ position: { ...current } }], segments: [], isClosed: false };
      output.push(currentPath);
    }
    return currentPath;
  };
  const moveTo = (end: Point) => {
    current = end;
    currentPath = { nodes: [{ position: { ...end } }], segments: [], isClosed: false };
    output.push(currentPath);
  };
  const lineTo = (end: Point) => {
    const path = ensurePath();
    const start = path.nodes.length - 1;
    path.nodes.push({ position: { ...end } });
    path.segments.push({ start, end: start + 1, type: 'line' });
    current = end;
  };
  const cubicTo = (control1: Point, control2: Point, end: Point) => {
    const path = ensurePath();
    const start = path.nodes.length - 1;
    path.nodes[start].handleOut = { ...control1 };
    path.nodes.push({ position: { ...end }, handleIn: { ...control2 } });
    path.segments.push({ start, end: start + 1, type: 'bezier' });
    current = end;
    lastCubic = control2;
  };
  const closePath = () => {
    if (!currentPath || currentPath.nodes.length < 2) return;
    const end = currentPath.nodes.length - 1;
    if (!samePoint(currentPath.nodes[end].position, currentPath.nodes[0].position)) {
      currentPath.segments.push({ start: end, end: 0, type: 'line' });
    } else {
      const duplicate = currentPath.nodes.pop()!;
      const previous = currentPath.nodes.length - 1;
      currentPath.nodes[0].handleIn = duplicate.handleIn;
      const finalSegment = currentPath.segments[currentPath.segments.length - 1];
      if (finalSegment?.end === previous + 1) finalSegment.end = 0;
    }
    currentPath.isClosed = true;
    current = { ...currentPath.nodes[0].position };
  };

  while (index < tokens.length) {
    if (isCommand(tokens[index])) command = tokens[index++];
    else if (!command) throw new Error('SVG path must begin with a command.');
    const upper = command.toUpperCase();
    const relative = command !== upper;
    const before = index;

    if (upper === 'M') {
      const end = point(relative); moveTo(end);
      command = relative ? 'l' : 'L';
      while (hasNumber()) lineTo(point(relative));
    } else if (upper === 'L') {
      while (hasNumber()) lineTo(point(relative));
    } else if (upper === 'H') {
      while (hasNumber()) { const value = read(); lineTo({ x: relative ? current.x + value : value, y: current.y }); }
    } else if (upper === 'V') {
      while (hasNumber()) { const value = read(); lineTo({ x: current.x, y: relative ? current.y + value : value }); }
    } else if (upper === 'C') {
      while (hasNumber()) { const c1 = point(relative); const c2 = point(relative); const end = point(relative); cubicTo(c1, c2, end); }
    } else if (upper === 'S') {
      while (hasNumber()) {
        const c1 = lastCubic ? reflect(lastCubic, current) : { ...current };
        const c2 = point(relative); const end = point(relative); cubicTo(c1, c2, end);
      }
    } else if (upper === 'Q') {
      while (hasNumber()) {
        const control = point(relative); const end = point(relative);
        const c1 = lerp(current, control, 2 / 3); const c2 = lerp(end, control, 2 / 3);
        cubicTo(c1, c2, end); lastQuadratic = control; lastCubic = undefined;
      }
    } else if (upper === 'T') {
      while (hasNumber()) {
        const control = lastQuadratic ? reflect(lastQuadratic, current) : { ...current };
        const end = point(relative); const c1 = lerp(current, control, 2 / 3); const c2 = lerp(end, control, 2 / 3);
        cubicTo(c1, c2, end); lastQuadratic = control; lastCubic = undefined;
      }
    } else if (upper === 'A') {
      while (hasNumber()) {
        const rx = read(); const ry = read(); const rotation = read(); const largeArc = read() !== 0; const sweep = read() !== 0;
        const end = point(relative);
        const curves = arcToCubics(current, end, rx, ry, rotation, largeArc, sweep);
        if (curves.length === 0) lineTo(end);
        else curves.forEach((curve) => cubicTo(curve.c1, curve.c2, curve.end));
      }
    } else if (upper === 'Z') {
      closePath(); command = '';
    } else {
      throw new Error(`Unsupported SVG path command ${command}.`);
    }

    if (upper === 'C' || upper === 'S') lastQuadratic = undefined;
    else if (upper === 'Q' || upper === 'T') lastCubic = undefined;
    else { lastCubic = undefined; lastQuadratic = undefined; }
    if (index === before && upper !== 'Z') throw new Error(`SVG command ${command} is missing parameters.`);
  }
  return output.filter((path) => path.segments.length > 0);
}

function arcToCubics(start: Point, end: Point, requestedRx: number, requestedRy: number, rotation: number, largeArc: boolean, sweep: boolean) {
  let rx = Math.abs(requestedRx); let ry = Math.abs(requestedRy);
  if (rx < 1e-9 || ry < 1e-9 || samePoint(start, end)) return [];
  const phi = rotation * Math.PI / 180; const cos = Math.cos(phi); const sin = Math.sin(phi);
  const dx = (start.x - end.x) / 2; const dy = (start.y - end.y) / 2;
  const x1 = cos * dx + sin * dy; const y1 = -sin * dx + cos * dy;
  const lambda = x1 * x1 / (rx * rx) + y1 * y1 / (ry * ry);
  if (lambda > 1) { const scale = Math.sqrt(lambda); rx *= scale; ry *= scale; }
  const rx2 = rx * rx; const ry2 = ry * ry;
  const denominator = rx2 * y1 * y1 + ry2 * x1 * x1;
  const factor = denominator <= 1e-12 ? 0 : (largeArc === sweep ? -1 : 1) * Math.sqrt(Math.max(0, (rx2 * ry2 - denominator) / denominator));
  const cx1 = factor * rx * y1 / ry; const cy1 = factor * -ry * x1 / rx;
  const cx = cos * cx1 - sin * cy1 + (start.x + end.x) / 2;
  const cy = sin * cx1 + cos * cy1 + (start.y + end.y) / 2;
  const ux = (x1 - cx1) / rx; const uy = (y1 - cy1) / ry;
  const vx = (-x1 - cx1) / rx; const vy = (-y1 - cy1) / ry;
  let theta = vectorAngle(1, 0, ux, uy);
  let delta = vectorAngle(ux, uy, vx, vy);
  if (!sweep && delta > 0) delta -= Math.PI * 2;
  if (sweep && delta < 0) delta += Math.PI * 2;
  const count = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2)));
  const step = delta / count;
  const pointAt = (angle: number): Point => ({ x: cx + rx * Math.cos(angle) * cos - ry * Math.sin(angle) * sin, y: cy + rx * Math.cos(angle) * sin + ry * Math.sin(angle) * cos });
  const tangentAt = (angle: number): Point => ({ x: -rx * Math.sin(angle) * cos - ry * Math.cos(angle) * sin, y: -rx * Math.sin(angle) * sin + ry * Math.cos(angle) * cos });
  const curves: Array<{ c1: Point; c2: Point; end: Point }> = [];
  for (let part = 0; part < count; part += 1) {
    const a = theta + part * step; const b = a + step; const alpha = 4 / 3 * Math.tan((b - a) / 4);
    const p1 = pointAt(a); const p2 = part === count - 1 ? end : pointAt(b); const t1 = tangentAt(a); const t2 = tangentAt(b);
    curves.push({ c1: { x: p1.x + alpha * t1.x, y: p1.y + alpha * t1.y }, c2: { x: p2.x - alpha * t2.x, y: p2.y - alpha * t2.y }, end: { ...p2 } });
  }
  return curves;
}

function parseCssRules(root: SVGSVGElement): CssRule[] {
  const rules: CssRule[] = [];
  root.querySelectorAll('style').forEach((style) => {
    const source = (style.textContent ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
    const pattern = /([^{}]+)\{([^{}]+)\}/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source))) {
      const selectors = match[1].split(',').map((selector) => selector.trim()).filter((selector) => selector && !selector.startsWith('@'));
      if (selectors.length > 0) rules.push({ selectors, declarations: parseDeclarations(match[2]) });
    }
  });
  return rules;
}

function parseDeclarations(source: string) {
  const declarations = new Map<string, string>();
  source.split(';').forEach((entry) => {
    const separator = entry.indexOf(':');
    if (separator <= 0) return;
    declarations.set(entry.slice(0, separator).trim(), entry.slice(separator + 1).trim().replace(/\s*!important\s*$/, ''));
  });
  return declarations;
}

function safeMatches(element: Element, selector: string) {
  try { return element.matches(selector); } catch { return false; }
}

function resolveStyle(element: Element, parent: SvgStyle, cssRules: CssRule[]): SvgStyle {
  const declarations = new Map<string, string>();
  ['fill', 'stroke', 'color', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'fill-opacity', 'stroke-opacity', 'opacity', 'display', 'visibility']
    .forEach((name) => { const value = element.getAttribute(name); if (value !== null) declarations.set(name, value.trim()); });
  cssRules.forEach((rule) => {
    if (!rule.selectors.some((selector) => safeMatches(element, selector))) return;
    rule.declarations.forEach((value, name) => declarations.set(name, value));
  });
  parseDeclarations(element.getAttribute('style') ?? '').forEach((value, name) => declarations.set(name, value));
  const localOpacity = numeric(declarations.get('opacity') ?? element.getAttribute('opacity'), 1);
  const dashText = declarations.get('stroke-dasharray');
  return {
    fill: declarations.get('fill') ?? parent.fill,
    stroke: declarations.get('stroke') ?? parent.stroke,
    color: declarations.get('color') ?? parent.color,
    strokeWidth: numeric(declarations.get('stroke-width'), parent.strokeWidth),
    strokeLinecap: cap(declarations.get('stroke-linecap') ?? parent.strokeLinecap),
    strokeLinejoin: join(declarations.get('stroke-linejoin') ?? parent.strokeLinejoin),
    strokeDasharray: dashText === undefined ? parent.strokeDasharray : dashText === 'none' ? [] : numbers(dashText).filter((value) => value >= 0),
    fillOpacity: clamp01(numeric(declarations.get('fill-opacity'), parent.fillOpacity)),
    strokeOpacity: clamp01(numeric(declarations.get('stroke-opacity'), parent.strokeOpacity)),
    opacity: clamp01(parent.opacity * localOpacity),
    display: declarations.get('display') ?? parent.display,
    visibility: declarations.get('visibility') ?? parent.visibility,
  };
}

function parseTransform(source: string | null): Matrix {
  if (!source) return IDENTITY;
  let result: Matrix = IDENTITY;
  const pattern = /([a-zA-Z]+)\s*\(([^)]*)\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    const values = numbers(match[2]); const name = match[1].toLowerCase(); let next: Matrix = IDENTITY;
    if (name === 'matrix' && values.length >= 6) next = values.slice(0, 6) as Matrix;
    else if (name === 'translate') next = [1, 0, 0, 1, values[0] ?? 0, values[1] ?? 0];
    else if (name === 'scale') next = [values[0] ?? 1, 0, 0, values[1] ?? values[0] ?? 1, 0, 0];
    else if (name === 'rotate') {
      const angle = (values[0] ?? 0) * Math.PI / 180; const cos = Math.cos(angle); const sin = Math.sin(angle);
      const rotation: Matrix = [cos, sin, -sin, cos, 0, 0];
      next = values.length >= 3 ? multiply(multiply([1, 0, 0, 1, values[1], values[2]], rotation), [1, 0, 0, 1, -values[1], -values[2]]) : rotation;
    } else if (name === 'skewx') next = [1, 0, Math.tan((values[0] ?? 0) * Math.PI / 180), 1, 0, 0];
    else if (name === 'skewy') next = [1, Math.tan((values[0] ?? 0) * Math.PI / 180), 0, 1, 0, 0];
    result = multiply(result, next);
  }
  return result;
}

function transformSubpath(path: ParsedSubpath, matrix: Matrix): ParsedSubpath {
  return {
    ...path,
    nodes: path.nodes.map((node) => ({
      position: apply(matrix, node.position),
      handleIn: node.handleIn ? apply(matrix, node.handleIn) : undefined,
      handleOut: node.handleOut ? apply(matrix, node.handleOut) : undefined,
    })),
    segments: path.segments.map((segment) => ({ ...segment })),
  };
}

function svgViewport(root: SVGSVGElement, paths: ParsedSubpath[]) {
  const viewBox = numbers(root.getAttribute('viewBox') ?? '');
  if (viewBox.length === 4 && viewBox.every(Number.isFinite) && viewBox[2] > 0 && viewBox[3] > 0) {
    return { minX: viewBox[0], minY: viewBox[1], width: viewBox[2], height: viewBox[3] };
  }
  const width = length(root.getAttribute('width')); const height = length(root.getAttribute('height'));
  if (width && height && width > 0 && height > 0) return { minX: 0, minY: 0, width, height };
  const points = paths.flatMap((path) => path.nodes.flatMap((node) => [node.position, ...(node.handleIn ? [node.handleIn] : []), ...(node.handleOut ? [node.handleOut] : [])]));
  if (points.length === 0) return { minX: 0, minY: 0, width: 24, height: 24 };
  const minX = Math.min(...points.map((point) => point.x)); const minY = Math.min(...points.map((point) => point.y));
  const maxX = Math.max(...points.map((point) => point.x)); const maxY = Math.max(...points.map((point) => point.y));
  return { minX, minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
}

function multiply(left: Matrix, right: Matrix): Matrix {
  return [
    left[0] * right[0] + left[2] * right[1], left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3], left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4], left[1] * right[4] + left[3] * right[5] + left[5],
  ];
}
function apply(matrix: Matrix, point: Point): Point { return { x: matrix[0] * point.x + matrix[2] * point.y + matrix[4], y: matrix[1] * point.x + matrix[3] * point.y + matrix[5] }; }
function numbers(value: string) { return (value.match(/[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) ?? []).map(Number).filter(Number.isFinite); }
function length(value: string | null) { if (!value || /%$/.test(value.trim())) return undefined; const result = Number.parseFloat(value); return Number.isFinite(result) ? result : undefined; }
function numeric(value: string | null | undefined, fallback: number) { const result = value === undefined || value === null ? NaN : Number.parseFloat(value); return Number.isFinite(result) ? result : fallback; }
function numberAttr(element: Element, name: string) { return length(element.getAttribute(name)) ?? 0; }
function clamp01(value: number) { return Math.max(0, Math.min(1, value)); }
function cap(value: string): StrokeStyle['cap'] { return value === 'round' || value === 'square' ? value : 'butt'; }
function join(value: string): StrokeStyle['join'] { return value === 'round' || value === 'bevel' ? value : 'miter'; }
function paint(value: string, currentColor: string) { const result = value.trim(); return result === 'none' || result.startsWith('url(') ? null : result === 'currentColor' ? currentColor : result; }
function elementName(element: Element, fallback: number) { const source = element.getAttribute('aria-label') || element.getAttribute('id') || element.localName; return `${source.charAt(0).toUpperCase()}${source.slice(1)}` || `Imported shape ${fallback}`; }
function samePoint(left: Point, right: Point) { return Math.abs(left.x - right.x) < 1e-9 && Math.abs(left.y - right.y) < 1e-9; }
function reflect(control: Point, around: Point): Point { return { x: around.x * 2 - control.x, y: around.y * 2 - control.y }; }
function lerp(start: Point, end: Point, amount: number): Point { return { x: start.x + (end.x - start.x) * amount, y: start.y + (end.y - start.y) * amount }; }
function vectorAngle(ux: number, uy: number, vx: number, vy: number) { return Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy); }
