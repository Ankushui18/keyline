import {
  constructionLineGeometry,
  constructionStrokePlan,
  type ConstructionStrokePlan,
  type DocumentBounds,
} from '../core/construction-geometry';
import type { VectorDocument } from '../core/document';
import { evaluateSegment, pointInPolygon } from '../core/geometry';
import { parametricGroupsForRegion, parametricInstanceMatrices } from '../core/parametric';
import { regionBoundaryLoops, triangulateRegionLoops } from '../core/region-geometry';
import { isArtworkFillPath } from '../core/segment-semantics';
import { IDENTITY_MATRIX, matrixScale, multiplyMatrices, objectTransformMatrix, transformPoint } from '../core/transforms';
import type { EntityId, Point, Region, SelectionState } from '../core/types';
import {
  concreteDocumentSegments,
  evaluateConcreteSegment,
  variableWidthOutline,
  type ConcreteSegment,
} from '../export/svg-export';
import { SpatialIndex, type Bounds } from './spatial-index';
import type { Viewport } from './viewport';

export interface WebGLRenderOptions {
  document: VectorDocument;
  viewport: Viewport;
  selection: SelectionState;
  width: number;
  height: number;
  dpr: number;
  revision: number;
}

export function webGLStrokeRenderWidths(
  strokeWidth: number,
  transformScale: number,
  viewportScale: number,
): { artwork: number; selection: number } {
  return {
    artwork: Math.max(0, strokeWidth) * Math.max(0, transformScale),
    selection: 1.5 / Math.max(viewportScale, 1e-9),
  };
}

interface IndexedGeometry {
  revision: number;
  /** Artwork only. Construction has independent finite/infinite culling. */
  segments: ConcreteSegment[];
  segmentIndex: SpatialIndex<number>;
  finiteConstructionIndex: SpatialIndex<EntityId>;
  infiniteConstructionSegmentIds: EntityId[];
  nodeIndex: SpatialIndex<EntityId>;
}

export interface WebGLConstructionIndexEntry {
  segmentId: EntityId;
  bounds: Bounds;
}

export interface WebGLConstructionIndexData {
  finite: WebGLConstructionIndexEntry[];
  /** Infinite lines are deliberately never inserted in a spatial index. */
  infiniteSegmentIds: EntityId[];
}

export interface WebGLConstructionStrokePlan extends ConstructionStrokePlan {
  /** Interleaved x, y, r, g, b, a triangles from the normal dash pipeline. */
  vertexData: number[];
}

interface GLState {
  gl: WebGL2RenderingContext;
  geometryProgram: WebGLProgram;
  nodeProgram: WebGLProgram;
  geometryBuffer: WebGLBuffer;
  quadBuffer: WebGLBuffer;
  instanceBuffer: WebGLBuffer;
  indexed?: IndexedGeometry;
}

const states = new WeakMap<HTMLCanvasElement, GLState>();

/** Batched WebGL2 scene renderer. Returns false when WebGL2 is unavailable. */
export function renderWebGLScene(canvas: HTMLCanvasElement, options: WebGLRenderOptions): boolean {
  const state = stateFor(canvas);
  if (!state) return false;
  const { gl } = state;
  if (!state.indexed || state.indexed.revision !== options.revision) {
    state.indexed = indexDocument(options.document, options.revision);
  }
  const indexed = state.indexed;
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(0.894, 0.894, 0.878, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.disable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  const view = visibleBounds(options.viewport, options.width, options.height);
  const constructionViewport = exactViewportBounds(options.viewport, options.width, options.height);
  const segmentIndexes = indexed.segmentIndex.query(view);
  const finiteConstructionIds = indexed.finiteConstructionIndex.query(view);
  const nodeIds = indexed.nodeIndex.query(view);
  const triangles: number[] = [];
  const lines: number[] = [];
  appendArtboards(triangles, lines, options.document);
  appendGrid(lines, view, options.viewport.scale);
  appendObjectFillTriangles(triangles, options.document, indexed.segments);
  appendRegionTriangles(triangles, options.document);
  appendWebGLConstructionStrokes(
    triangles,
    options.document,
    finiteConstructionIds,
    indexed.infiniteConstructionSegmentIds,
    constructionViewport,
    options.viewport.scale,
  );

  const selectedSegments = options.selection.segmentIds;
  for (const index of segmentIndexes) {
    const item = indexed.segments[index];
    if (!item) continue;
    const selected = selectedSegments.has(item.segment.id);
    const object = item.objectId ? options.document.getObject(item.objectId) : undefined;
    const appearance = object ? options.document.getAppearance(object.appearanceId) : undefined;
    const stroke = appearance?.stroke;
    const lineColor = stroke?.color ?? '#6d737d';
    const opacity = (appearance?.opacity ?? 1) * (stroke?.opacity ?? 0.88);
    const artworkVisible = !appearance || Boolean(stroke?.visible && opacity > 0);
    if (!artworkVisible && !selected) continue;
    const transformScale = item.transform
      ? (matrixScale(item.transform).x + matrixScale(item.transform).y) / 2
      : 1;
    const renderWidths = webGLStrokeRenderWidths(stroke?.width ?? 1.25, transformScale, options.viewport.scale);
    const selectionWidth = renderWidths.selection;

    if (item.segment.widthProfile?.length) {
      if (artworkVisible) {
        const outlineSteps = options.viewport.scale < 0.2 ? 8 : options.viewport.scale < 0.7 ? 24 : 64;
        const polygon = variableWidthOutline(item, outlineSteps);
        appendPolygonTriangles(triangles, polygon, lineColor, opacity);
      }
      if (selected) {
        appendStrokeTriangles(
          triangles,
          item,
          '#0d99ff',
          1,
          selectionWidth,
          'round',
          [],
          options.viewport.scale,
        );
      }
    } else {
      const baseWidth = renderWidths.artwork;
      const alignedPolygon = stroke && stroke.alignment !== 'center'
        ? closedPathPolygon(options.document, item)
        : undefined;
      if (artworkVisible && alignedPolygon && stroke && stroke.alignment !== 'center') {
        const alignedTriangles: number[] = [];
        appendStrokeTriangles(
          alignedTriangles,
          item,
          stroke.color,
          opacity,
          baseWidth * 2,
          stroke.cap,
          stroke.dash.map((value) => value * transformScale),
          options.viewport.scale,
        );
        appendTrianglesForAlignment(triangles, alignedTriangles, alignedPolygon, stroke.alignment);
      } else if (artworkVisible) {
        appendStrokeTriangles(
          triangles,
          item,
          lineColor,
          opacity,
          baseWidth,
          stroke?.cap ?? 'round',
          stroke?.dash.map((value) => value * transformScale) ?? [],
          options.viewport.scale,
        );
      }
      if (selected) {
        appendStrokeTriangles(
          triangles,
          item,
          '#0d99ff',
          1,
          selectionWidth,
          stroke?.cap ?? 'round',
          [],
          options.viewport.scale,
        );
      }
    }
  }
  drawGeometry(state, triangles, gl.TRIANGLES, options);
  drawGeometry(state, lines, gl.LINES, options);
  if (options.selection.mode === 'network') drawNodes(state, nodeIds, options);
  return true;
}

function stateFor(canvas: HTMLCanvasElement): GLState | undefined {
  const existing = states.get(canvas);
  if (existing) return existing;
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: true });
  if (!gl) return undefined;
  const geometryProgram = createProgram(gl, GEOMETRY_VERTEX, GEOMETRY_FRAGMENT);
  const nodeProgram = createProgram(gl, NODE_VERTEX, NODE_FRAGMENT);
  const geometryBuffer = gl.createBuffer();
  const quadBuffer = gl.createBuffer();
  const instanceBuffer = gl.createBuffer();
  if (!geometryProgram || !nodeProgram || !geometryBuffer || !quadBuffer || !instanceBuffer) return undefined;
  const state: GLState = { gl, geometryProgram, nodeProgram, geometryBuffer, quadBuffer, instanceBuffer };
  states.set(canvas, state);
  return state;
}

/**
 * Produces the only construction bounds allowed into the WebGL quadtree.
 * Infinite lines are retained as IDs and clipped against the viewport per frame.
 */
export function prepareWebGLConstructionIndex(document: VectorDocument): WebGLConstructionIndexData {
  const finite: WebGLConstructionIndexEntry[] = [];
  const infiniteSegmentIds: EntityId[] = [];
  for (const segment of document.segments.values()) {
    if (segment.role !== 'construction' || !document.isSegmentVisible(segment.id)) continue;
    const line = constructionLineGeometry(document, segment);
    if (!line) continue;
    if (line.extent === 'infinite') {
      infiniteSegmentIds.push(segment.id);
      continue;
    }
    const bounds = {
      minX: Math.min(line.start.x, line.end.x),
      minY: Math.min(line.start.y, line.end.y),
      maxX: Math.max(line.start.x, line.end.x),
      maxY: Math.max(line.start.y, line.end.y),
    };
    if (finiteBounds(bounds)) finite.push({ segmentId: segment.id, bounds });
  }
  return { finite, infiniteSegmentIds };
}

function indexDocument(document: VectorDocument, revision: number): IndexedGeometry {
  const segments = concreteDocumentSegments(document)
    .filter((item) => item.segment.role !== 'construction');
  const construction = prepareWebGLConstructionIndex(document);
  const allPoints: Point[] = [];
  const segmentBounds = segments.map((item) => {
    const bounds = concreteSegmentBounds(item);
    allPoints.push(
      { x: bounds.minX, y: bounds.minY },
      { x: bounds.maxX, y: bounds.maxY },
    );
    return bounds;
  });
  for (const entry of construction.finite) {
    allPoints.push(
      { x: entry.bounds.minX, y: entry.bounds.minY },
      { x: entry.bounds.maxX, y: entry.bounds.maxY },
    );
  }
  const visibleNodeIds = document.visibleNodeIds();
  for (const node of document.nodes.values()) {
    if (!visibleNodeIds.has(node.id)) continue;
    const object = document.getObjectForNode(node.id);
    allPoints.push(object
      ? transformPoint(node.position, objectTransformMatrix(object.transform))
      : node.position);
  }
  const root = expandBounds(boundsOf(allPoints), 1);
  const segmentIndex = new SpatialIndex<number>(root);
  segmentBounds.forEach((bounds, index) => segmentIndex.insert({ ...bounds, value: index }));
  const finiteConstructionIndex = new SpatialIndex<EntityId>(root);
  for (const entry of construction.finite) {
    finiteConstructionIndex.insert({ ...entry.bounds, value: entry.segmentId });
  }
  const nodeIndex = new SpatialIndex<EntityId>(root);
  for (const node of document.nodes.values()) {
    if (!visibleNodeIds.has(node.id)) continue;
    const object = document.getObjectForNode(node.id);
    const position = object
      ? transformPoint(node.position, objectTransformMatrix(object.transform))
      : node.position;
    nodeIndex.insert({ minX: position.x, minY: position.y, maxX: position.x, maxY: position.y, value: node.id });
  }
  return {
    revision,
    segments,
    segmentIndex,
    finiteConstructionIndex,
    infiniteConstructionSegmentIds: construction.infiniteSegmentIds,
    nodeIndex,
  };
}

export function webGLConstructionStrokePlan(
  document: VectorDocument,
  segmentId: EntityId,
  viewportBounds: DocumentBounds,
  scale: number,
): WebGLConstructionStrokePlan | null {
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const plan = constructionStrokePlan(document, segmentId, viewportBounds);
  const segment = document.getSegment(segmentId);
  if (!plan || !segment) return null;
  const item: ConcreteSegment = {
    segment,
    start: plan.start,
    end: plan.end,
  };
  const vertexData: number[] = [];
  appendStrokeTriangles(
    vertexData,
    item,
    plan.style.color,
    plan.style.opacity,
    plan.style.widthPx / scale,
    plan.style.cap,
    plan.style.dashPx.map((value) => value / scale),
    scale,
  );
  if (!vertexData.every(Number.isFinite)) return null;
  return { ...plan, vertexData };
}

/** Per-frame construction preparation shared by the renderer and performance tests. */
export function prepareWebGLConstructionFrame(
  document: VectorDocument,
  finiteSegmentIds: readonly EntityId[],
  infiniteSegmentIds: readonly EntityId[],
  viewportBounds: DocumentBounds,
  scale: number,
): WebGLConstructionStrokePlan[] {
  const plans: WebGLConstructionStrokePlan[] = [];
  for (const segmentId of [...finiteSegmentIds, ...infiniteSegmentIds]) {
    const plan = webGLConstructionStrokePlan(document, segmentId, viewportBounds, scale);
    if (plan) plans.push(plan);
  }
  return plans;
}

function appendWebGLConstructionStrokes(
  output: number[],
  document: VectorDocument,
  finiteSegmentIds: readonly EntityId[],
  infiniteSegmentIds: readonly EntityId[],
  viewportBounds: DocumentBounds,
  scale: number,
): void {
  for (const plan of prepareWebGLConstructionFrame(
    document,
    finiteSegmentIds,
    infiniteSegmentIds,
    viewportBounds,
    scale,
  )) output.push(...plan.vertexData);
}

function drawGeometry(state: GLState, values: number[], mode: number, options: WebGLRenderOptions): void {
  if (values.length === 0) return;
  const { gl, geometryProgram, geometryBuffer } = state;
  gl.useProgram(geometryProgram);
  setViewportUniforms(gl, geometryProgram, options);
  gl.bindBuffer(gl.ARRAY_BUFFER, geometryBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(values), gl.DYNAMIC_DRAW);
  const position = gl.getAttribLocation(geometryProgram, 'a_position');
  const color = gl.getAttribLocation(geometryProgram, 'a_color');
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 24, 0);
  gl.enableVertexAttribArray(color);
  gl.vertexAttribPointer(color, 4, gl.FLOAT, false, 24, 8);
  gl.drawArrays(mode, 0, values.length / 6);
}

function drawNodes(state: GLState, nodeIds: EntityId[], options: WebGLRenderOptions): void {
  if (nodeIds.length === 0) return;
  const { gl, nodeProgram, quadBuffer, instanceBuffer } = state;
  const instances: number[] = [];
  for (const nodeId of nodeIds) {
    const node = options.document.getNode(nodeId);
    if (!node) continue;
    const object = options.document.getObjectForNode(nodeId);
    if (options.selection.editingObjectId && object?.id !== options.selection.editingObjectId) continue;
    const position = object
      ? transformPoint(node.position, objectTransformMatrix(object.transform))
      : node.position;
    const selected = options.selection.nodeIds.has(nodeId);
    const [r, g, b] = rgb('#ffffff');
    instances.push(position.x, position.y, r, g, b, 1, selected ? 3.5 : 3);
  }
  gl.useProgram(nodeProgram);
  setViewportUniforms(gl, nodeProgram, options);
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1, 1, -1, 1, 1,
    -1, -1, 1, 1, -1, 1,
  ]), gl.STATIC_DRAW);
  const corner = gl.getAttribLocation(nodeProgram, 'a_corner');
  gl.enableVertexAttribArray(corner);
  gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 8, 0);
  gl.vertexAttribDivisor(corner, 0);

  gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(instances), gl.DYNAMIC_DRAW);
  const center = gl.getAttribLocation(nodeProgram, 'a_center');
  const color = gl.getAttribLocation(nodeProgram, 'a_color');
  const radius = gl.getAttribLocation(nodeProgram, 'a_radius');
  gl.enableVertexAttribArray(center);
  gl.vertexAttribPointer(center, 2, gl.FLOAT, false, 28, 0);
  gl.vertexAttribDivisor(center, 1);
  gl.enableVertexAttribArray(color);
  gl.vertexAttribPointer(color, 4, gl.FLOAT, false, 28, 8);
  gl.vertexAttribDivisor(color, 1);
  gl.enableVertexAttribArray(radius);
  gl.vertexAttribPointer(radius, 1, gl.FLOAT, false, 28, 24);
  gl.vertexAttribDivisor(radius, 1);
  gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, instances.length / 7);
  gl.vertexAttribDivisor(center, 0);
  gl.vertexAttribDivisor(color, 0);
  gl.vertexAttribDivisor(radius, 0);
}

function setViewportUniforms(gl: WebGL2RenderingContext, program: WebGLProgram, options: WebGLRenderOptions): void {
  gl.uniform2f(gl.getUniformLocation(program, 'u_resolution'), options.width, options.height);
  gl.uniform2f(gl.getUniformLocation(program, 'u_offset'), options.viewport.offsetX, options.viewport.offsetY);
  gl.uniform1f(gl.getUniformLocation(program, 'u_scale'), options.viewport.scale);
}

function appendGrid(output: number[], view: Bounds, scale: number): void {
  if (scale < 4) return;
  const firstX = Math.floor(view.minX);
  const firstY = Math.floor(view.minY);
  for (let x = firstX; x <= view.maxX; x += 1) {
    appendLine(output, { x, y: view.minY }, { x, y: view.maxY }, x % 10 === 0 ? '#c9c9c9' : '#d9d9d9', 1);
  }
  for (let y = firstY; y <= view.maxY; y += 1) {
    appendLine(output, { x: view.minX, y }, { x: view.maxX, y }, y % 10 === 0 ? '#c9c9c9' : '#d9d9d9', 1);
  }
}

function appendArtboards(triangles: number[], lines: number[], document: VectorDocument): void {
  for (const artboardId of document.activePage.artboardIds) {
    const artboard = document.getArtboard(artboardId);
    if (!artboard || artboard.isCanvasRoot) continue;
    const { x, y, width, height } = artboard.frame;
    const points = [
      { x, y },
      { x: x + width, y },
      { x: x + width, y: y + height },
      { x, y: y + height },
    ];
    const active = artboard.id === document.activeArtboardId;
    for (const point of [points[0], points[1], points[2], points[0], points[2], points[3]]) {
      appendVertex(triangles, point, artboard.background, 1);
    }
    const border = active ? '#777d86' : '#a5aab2';
    for (let index = 0; index < points.length; index += 1) {
      appendLine(lines, points[index], points[(index + 1) % points.length], border, 1);
    }
  }
}

function appendObjectFillTriangles(
  output: number[],
  document: VectorDocument,
  concreteSegments: ConcreteSegment[],
): void {
  const concreteBySegmentId = new Map<EntityId, ConcreteSegment[]>();
  for (const item of concreteSegments) {
    const occurrences = concreteBySegmentId.get(item.segment.id) ?? [];
    occurrences.push(item);
    concreteBySegmentId.set(item.segment.id, occurrences);
  }
  for (const object of document.activePage.artboardIds.flatMap((artboardId) => document.objectsForArtboard(artboardId))) {
    const appearance = document.getAppearance(object.appearanceId);
    const fills = appearance?.fills.filter((fill) => fill.visible && fill.opacity > 0) ?? [];
    const network = document.getNetwork(object.networkId);
    if (!appearance || appearance.opacity <= 0 || fills.length === 0 || !network) continue;
    for (const pathId of network.pathIds) {
      const path = document.getPath(pathId);
      if (!path || !isArtworkFillPath(document, path)) continue;
      const occurrenceCount = Math.min(...path.segmentIds.map((segmentId) => concreteBySegmentId.get(segmentId)?.length ?? 0));
      for (let occurrence = 0; occurrence < occurrenceCount; occurrence += 1) {
        const points: Point[] = [];
        for (const segmentId of path.segmentIds) {
          const item = concreteBySegmentId.get(segmentId)?.[occurrence];
          if (!item) continue;
          const steps = item.segment.type === 'line' ? 1 : 24;
          for (let index = points.length === 0 ? 0 : 1; index <= steps; index += 1) {
            points.push(evaluateConcreteSegment(item, index / steps));
          }
        }
        if (points.length < 3) continue;
        for (const fill of fills) {
          appendPolygonTriangles(output, points, fill.color, appearance.opacity * fill.opacity);
        }
      }
    }
  }
}

function appendRegionTriangles(output: number[], document: VectorDocument): void {
  for (const region of document.regions.values()) {
    if (!region.fill || regionBoundaryLoops(region).length === 0 ||
      region.boundarySegmentIds.some((segmentId) => !document.isSegmentVisible(segmentId))) continue;
    output.push(...regionFillVertexData(document, region));
  }
}

/** Interleaved WebGL vertices for the same compound loops and fill rule Canvas/SVG consume. */
export function regionFillVertexData(document: VectorDocument, region: Region): number[] {
  if (!region.fill) return [];
  const object = region.boundarySegmentIds[0]
    ? document.getObjectForSegment(region.boundarySegmentIds[0])
    : undefined;
  const objectMatrix = object ? objectTransformMatrix(object.transform) : IDENTITY_MATRIX;
  const loops = regionBoundaryLoops(region).map((loop) => loop.outline);
  const triangles = triangulateRegionLoops(loops, region.fillRule);
  const matrices = [objectMatrix];
  for (const group of parametricGroupsForRegion(document, region)) {
    matrices.push(...parametricInstanceMatrices(document, group)
      .map((matrix) => multiplyMatrices(objectMatrix, matrix)));
  }
  const output: number[] = [];
  for (const matrix of matrices) {
    for (const point of triangles) {
      appendVertex(output, transformPoint(point, matrix), region.fill.color, 1);
    }
  }
  return output;
}

function appendPolygonTriangles(output: number[], polygon: Point[], color: string, alpha: number): void {
  const clean = polygon.length > 1 && samePoint(polygon[0], polygon[polygon.length - 1]) ? polygon.slice(0, -1) : polygon;
  const triangles = triangulate(clean);
  for (const index of triangles) appendVertex(output, clean[index], color, alpha);
}

export function webGLStrokeVertexData(
  item: ConcreteSegment,
  width: number,
  cap: 'butt' | 'round' | 'square' = 'round',
  dash: number[] = [],
  scale = 1,
): number[] {
  const output: number[] = [];
  appendStrokeTriangles(output, item, '#ffffff', 1, width, cap, dash, scale);
  return output;
}

export function webGLAlignedStrokeVertexData(
  document: VectorDocument,
  item: ConcreteSegment,
  width: number,
  alignment: 'inside' | 'outside',
  cap: 'butt' | 'round' | 'square' = 'round',
  dash: number[] = [],
  scale = 1,
): number[] {
  const centered = webGLStrokeVertexData(item, width * 2, cap, dash, scale);
  const polygon = closedPathPolygon(document, item);
  if (!polygon) return webGLStrokeVertexData(item, width, cap, dash, scale);
  const output: number[] = [];
  appendTrianglesForAlignment(output, centered, polygon, alignment);
  return output;
}

function closedPathPolygon(document: VectorDocument, item: ConcreteSegment): Point[] | undefined {
  const path = document.findPathForSegment(item.segment.id);
  if (!path?.isClosed || path.segmentIds.some((segmentId) => Boolean(document.getSegment(segmentId)?.widthProfile?.length))) return undefined;
  const polygon: Point[] = [];
  for (const segmentId of path.segmentIds) {
    const segment = document.getSegment(segmentId);
    if (!segment || segment.role !== 'geometry') return undefined;
    const steps = segment.type === 'line' ? 1 : 24;
    for (let index = 0; index < steps; index += 1) {
      const point = evaluateSegment(document, segment, index / steps);
      polygon.push(item.transform ? transformPoint(point, item.transform) : point);
    }
  }
  return polygon.length >= 3 ? polygon : undefined;
}

function appendTrianglesForAlignment(
  output: number[],
  triangles: number[],
  polygon: Point[],
  alignment: 'inside' | 'outside',
): void {
  const vertexStride = 6;
  const triangleStride = vertexStride * 3;
  const keepInside = alignment === 'inside';
  for (let index = 0; index + triangleStride <= triangles.length; index += triangleStride) {
    const vertices = [0, 1, 2].map((vertex) => ({
      point: {
        x: triangles[index + vertex * vertexStride],
        y: triangles[index + vertex * vertexStride + 1],
      },
      attributes: triangles.slice(index + vertex * vertexStride + 2, index + vertex * vertexStride + vertexStride),
    }));
    const clipped: typeof vertices = [];
    for (let vertex = 0; vertex < vertices.length; vertex += 1) {
      const current = vertices[vertex];
      const previous = vertices[(vertex + vertices.length - 1) % vertices.length];
      const currentKept = pointInPolygon(current.point, polygon) === keepInside;
      const previousKept = pointInPolygon(previous.point, polygon) === keepInside;
      if (currentKept !== previousKept) {
        let previousSide = previous.point;
        let currentSide = current.point;
        const previousInside = pointInPolygon(previousSide, polygon);
        for (let step = 0; step < 14; step += 1) {
          const midpoint = { x: (previousSide.x + currentSide.x) / 2, y: (previousSide.y + currentSide.y) / 2 };
          if (pointInPolygon(midpoint, polygon) === previousInside) previousSide = midpoint;
          else currentSide = midpoint;
        }
        clipped.push({
          point: { x: (previousSide.x + currentSide.x) / 2, y: (previousSide.y + currentSide.y) / 2 },
          attributes: current.attributes,
        });
      }
      if (currentKept) clipped.push(current);
    }
    for (let vertex = 1; vertex + 1 < clipped.length; vertex += 1) {
      for (const item of [clipped[0], clipped[vertex], clipped[vertex + 1]]) {
        output.push(item.point.x, item.point.y, ...item.attributes);
      }
    }
  }
}

function appendStrokeTriangles(
  output: number[],
  item: ConcreteSegment,
  color: string,
  alpha: number,
  width: number,
  cap: 'butt' | 'round' | 'square',
  dash: number[],
  scale: number,
): void {
  if (width <= 0 || alpha <= 0) return;
  const steps = item.segment.type === 'line' ? 1 : scale < 0.2 ? 4 : scale < 0.7 ? 12 : 32;
  const points = Array.from({ length: steps + 1 }, (_, index) => evaluateConcreteSegment(item, index / steps));
  const normalizedDash = dash.filter((value) => value > 1e-6);
  if (normalizedDash.length === 0) {
    const firstDirection = unitDirection(points[0], points[1]);
    const lastDirection = unitDirection(points[points.length - 2], points[points.length - 1]);
    points.forEach((point, index) => {
      if (index === points.length - 1) return;
      const start = index === 0 && cap === 'square'
        ? { x: point.x - firstDirection.x * width / 2, y: point.y - firstDirection.y * width / 2 }
        : point;
      const rawEnd = points[index + 1];
      const end = index === points.length - 2 && cap === 'square'
        ? { x: rawEnd.x + lastDirection.x * width / 2, y: rawEnd.y + lastDirection.y * width / 2 }
        : rawEnd;
      appendThickLine(output, start, end, width, color, alpha);
    });
    if (cap === 'round') {
      appendDisc(output, points[0], width / 2, color, alpha);
      appendDisc(output, points[points.length - 1], width / 2, color, alpha);
    }
    for (let index = 1; index < points.length - 1; index += 1) {
      appendDisc(output, points[index], width / 2, color, alpha, 8);
    }
    return;
  }

  const pattern = normalizedDash.length % 2 === 0 ? normalizedDash : [...normalizedDash, ...normalizedDash];
  let patternIndex = 0;
  let remaining = pattern[0];
  let drawing = true;
  let runStart = true;
  for (let edge = 0; edge < points.length - 1; edge += 1) {
    const start = points[edge];
    const end = points[edge + 1];
    const distance = Math.hypot(end.x - start.x, end.y - start.y);
    if (distance <= 1e-12) continue;
    let consumed = 0;
    while (consumed < distance - 1e-10) {
      const take = Math.min(remaining, distance - consumed);
      const fromT = consumed / distance;
      const toT = (consumed + take) / distance;
      const from = lerpPoint(start, end, fromT);
      const to = lerpPoint(start, end, toT);
      const completesPatternPart = take >= remaining - 1e-10;
      if (drawing) {
        const direction = unitDirection(from, to);
        const cappedFrom = runStart && cap === 'square'
          ? { x: from.x - direction.x * width / 2, y: from.y - direction.y * width / 2 }
          : from;
        const cappedTo = completesPatternPart && cap === 'square'
          ? { x: to.x + direction.x * width / 2, y: to.y + direction.y * width / 2 }
          : to;
        appendThickLine(output, cappedFrom, cappedTo, width, color, alpha);
        if (runStart && cap === 'round') appendDisc(output, from, width / 2, color, alpha);
        if (completesPatternPart && cap === 'round') appendDisc(output, to, width / 2, color, alpha);
      }
      consumed += take;
      remaining -= take;
      if (remaining <= 1e-10) {
        patternIndex = (patternIndex + 1) % pattern.length;
        remaining = pattern[patternIndex];
        drawing = patternIndex % 2 === 0;
        runStart = drawing;
      } else {
        runStart = false;
      }
    }
  }
}

function appendThickLine(output: number[], start: Point, end: Point, width: number, color: string, alpha: number): void {
  const direction = unitDirection(start, end);
  const normal = { x: -direction.y * width / 2, y: direction.x * width / 2 };
  const a = { x: start.x + normal.x, y: start.y + normal.y };
  const b = { x: end.x + normal.x, y: end.y + normal.y };
  const c = { x: end.x - normal.x, y: end.y - normal.y };
  const d = { x: start.x - normal.x, y: start.y - normal.y };
  for (const point of [a, b, c, a, c, d]) appendVertex(output, point, color, alpha);
}

function appendDisc(
  output: number[],
  center: Point,
  radius: number,
  color: string,
  alpha: number,
  steps = 12,
): void {
  for (let index = 0; index < steps; index += 1) {
    const first = index / steps * Math.PI * 2;
    const second = (index + 1) / steps * Math.PI * 2;
    appendVertex(output, center, color, alpha);
    appendVertex(output, { x: center.x + Math.cos(first) * radius, y: center.y + Math.sin(first) * radius }, color, alpha);
    appendVertex(output, { x: center.x + Math.cos(second) * radius, y: center.y + Math.sin(second) * radius }, color, alpha);
  }
}

function unitDirection(start: Point, end: Point): Point {
  const length = Math.hypot(end.x - start.x, end.y - start.y) || 1;
  return { x: (end.x - start.x) / length, y: (end.y - start.y) / length };
}

function lerpPoint(start: Point, end: Point, t: number): Point {
  return { x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t };
}

function appendLine(output: number[], start: Point, end: Point, color: string, alpha: number): void {
  appendVertex(output, start, color, alpha);
  appendVertex(output, end, color, alpha);
}

function appendVertex(output: number[], point: Point, color: string, alpha: number): void {
  const [r, g, b] = rgb(color);
  const embeddedAlpha = /^#[a-f0-9]{8}$/i.test(color) ? Number.parseInt(color.slice(7, 9), 16) / 255 : 1;
  output.push(point.x, point.y, r, g, b, alpha * embeddedAlpha);
}

function triangulate(points: Point[]): number[] {
  if (points.length < 3) return [];
  const result: number[] = [];
  const indices = points.map((_, index) => index);
  const orientation = signedArea(points) >= 0 ? 1 : -1;
  let guard = points.length * points.length;
  while (indices.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let index = 0; index < indices.length; index += 1) {
      const previous = indices[(index - 1 + indices.length) % indices.length];
      const current = indices[index];
      const next = indices[(index + 1) % indices.length];
      if (cross(points[previous], points[current], points[next]) * orientation <= 0) continue;
      if (indices.some((candidate) => candidate !== previous && candidate !== current && candidate !== next &&
        pointInTriangle(points[candidate], points[previous], points[current], points[next]))) continue;
      result.push(previous, current, next);
      indices.splice(index, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (indices.length === 3) result.push(...indices);
  return result;
}

function visibleBounds(viewport: Viewport, width: number, height: number): Bounds {
  const topLeft = viewport.screenToWorld({ x: -32, y: -32 });
  const bottomRight = viewport.screenToWorld({ x: width + 32, y: height + 32 });
  return normalizedBounds(topLeft, bottomRight);
}

/** Exact visible span, intentionally matching Canvas 2D without culling overscan. */
function exactViewportBounds(viewport: Viewport, width: number, height: number): Bounds {
  const topLeft = viewport.screenToWorld({ x: 0, y: 0 });
  const bottomRight = viewport.screenToWorld({ x: width, y: height });
  return normalizedBounds(topLeft, bottomRight);
}

function normalizedBounds(first: Point, second: Point): Bounds {
  return {
    minX: Math.min(first.x, second.x),
    minY: Math.min(first.y, second.y),
    maxX: Math.max(first.x, second.x),
    maxY: Math.max(first.y, second.y),
  };
}

function finiteBounds(bounds: Bounds): boolean {
  return bounds.minX <= bounds.maxX && bounds.minY <= bounds.maxY &&
    [bounds.minX, bounds.minY, bounds.maxX, bounds.maxY].every(Number.isFinite);
}

function concreteSegmentBounds(item: ConcreteSegment): Bounds {
  if (item.segment.type === 'arc' && item.segment.center && item.segment.radius !== undefined) {
    const radius = Math.abs(item.segment.radius);
    return {
      minX: item.segment.center.x - radius,
      minY: item.segment.center.y - radius,
      maxX: item.segment.center.x + radius,
      maxY: item.segment.center.y + radius,
    };
  }
  if (item.segment.type === 'bezier') {
    // A cubic Bézier lies inside the convex hull of its control points.
    return boundsOf([item.start, item.handleOut ?? item.start, item.handleIn ?? item.end, item.end]);
  }
  return boundsOf([item.start, item.end]);
}

function boundsOf(points: Point[]): Bounds {
  if (points.length === 0) return { minX: -1, minY: -1, maxX: 1, maxY: 1 };
  const bounds = { minX: points[0].x, minY: points[0].y, maxX: points[0].x, maxY: points[0].y };
  for (let index = 1; index < points.length; index += 1) {
    const point = points[index];
    bounds.minX = Math.min(bounds.minX, point.x);
    bounds.minY = Math.min(bounds.minY, point.y);
    bounds.maxX = Math.max(bounds.maxX, point.x);
    bounds.maxY = Math.max(bounds.maxY, point.y);
  }
  return bounds;
}

function expandBounds(bounds: Bounds, amount: number): Bounds {
  return { minX: bounds.minX - amount, minY: bounds.minY - amount, maxX: bounds.maxX + amount, maxY: bounds.maxY + amount };
}

function signedArea(points: Point[]): number {
  return points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + point.x * next.y - next.x * point.y;
  }, 0) / 2;
}

function cross(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function pointInTriangle(point: Point, a: Point, b: Point, c: Point): boolean {
  const c1 = cross(point, a, b);
  const c2 = cross(point, b, c);
  const c3 = cross(point, c, a);
  return (c1 >= 0 && c2 >= 0 && c3 >= 0) || (c1 <= 0 && c2 <= 0 && c3 <= 0);
}

function samePoint(a: Point, b: Point): boolean {
  return Math.abs(a.x - b.x) < 1e-8 && Math.abs(a.y - b.y) < 1e-8;
}

function rgb(hex: string): [number, number, number] {
  const normalized = /^#[a-f0-9]{8}$/i.test(hex) ? hex.slice(1, 7) : hex.replace('#', '');
  if (normalized.length !== 6) return [0.65, 0.7, 0.8];
  return [0, 2, 4].map((offset) => Number.parseInt(normalized.slice(offset, offset + 2), 16) / 255) as [number, number, number];
}

function createProgram(gl: WebGL2RenderingContext, vertexSource: string, fragmentSource: string): WebGLProgram {
  const vertex = createShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = createShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  if (!vertex || !fragment || !program) throw new Error('Unable to allocate WebGL renderer resources.');
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'WebGL link failed.');
  return program;
}

function createShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('Unable to allocate a WebGL shader.');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'WebGL compile failed.');
  return shader;
}

const GEOMETRY_VERTEX = `#version 300 es
in vec2 a_position;
in vec4 a_color;
uniform vec2 u_resolution;
uniform vec2 u_offset;
uniform float u_scale;
out vec4 v_color;
void main() {
  vec2 screen = a_position * u_scale + u_offset;
  vec2 clip = vec2(screen.x / u_resolution.x * 2.0 - 1.0, 1.0 - screen.y / u_resolution.y * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
  v_color = a_color;
}`;

const GEOMETRY_FRAGMENT = `#version 300 es
precision mediump float;
in vec4 v_color;
out vec4 outColor;
void main() { outColor = v_color; }`;

const NODE_VERTEX = `#version 300 es
in vec2 a_corner;
in vec2 a_center;
in vec4 a_color;
in float a_radius;
uniform vec2 u_resolution;
uniform vec2 u_offset;
uniform float u_scale;
out vec4 v_color;
out vec2 v_corner;
void main() {
  vec2 screen = a_center * u_scale + u_offset + a_corner * a_radius;
  vec2 clip = vec2(screen.x / u_resolution.x * 2.0 - 1.0, 1.0 - screen.y / u_resolution.y * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
  v_color = a_color;
  v_corner = a_corner;
}`;

const NODE_FRAGMENT = `#version 300 es
precision mediump float;
in vec4 v_color;
in vec2 v_corner;
out vec4 outColor;
void main() {
  float distanceFromCenter = length(v_corner);
  if (distanceFromCenter > 1.0) discard;
  vec4 border = vec4(0.31, 0.514, 0.902, 1.0);
  outColor = distanceFromCenter > 0.68 ? border : v_color;
}`;
