import type { VectorClipboardPayload } from '../core/clipboard';
import type { Point, Segment, VectorNode } from '../core/types';

export type TidyRuleId = 'straighten' | 'merge-collinear' | 'snap-grid';

export interface TidyRule {
  id: TidyRuleId;
  title: string;
  description: string;
  count: number;
  /** Whether the rule is switched on by default. Grid snapping moves points, so it is opt-in. */
  defaultOn: boolean;
}

export interface TidyAnalysis {
  pointCount: number;
  pointCountAfterDefaults: number;
  rules: TidyRule[];
  /** True when there is nothing worth asking about. */
  isClean: boolean;
}

/** Lines within this angle of flat or upright count as "meant to be straight". */
const STRAIGHTEN_MAX_DEGREES = 1.5;
/** Collinear points must bend less than this to be redundant. */
const COLLINEAR_MAX_DEGREES = 0.75;
const MAX_STRAIGHTEN_SHIFT = 0.5;
const MAX_GRID_SHIFT = 0.25;
const GRID_STEP = 0.5;
const EPSILON = 1e-6;

const RULE_COPY: Record<TidyRuleId, Pick<TidyRule, 'title' | 'defaultOn'> & { describe: (count: number, frame: number) => string }> = {
  straighten: {
    title: 'Straighten near-flat lines',
    defaultOn: true,
    describe: (count) => `${count} ${count === 1 ? 'line is' : 'lines are'} a hair off horizontal or vertical. Makes them exact.`,
  },
  'merge-collinear': {
    title: 'Remove points that sit on straight lines',
    defaultOn: true,
    describe: (count) => `${count} ${count === 1 ? 'point does' : 'points do'} nothing. The shape looks the same without them.`,
  },
  'snap-grid': {
    title: 'Line up with the pixel grid',
    defaultOn: false,
    describe: (count, frame) => `Moves ${count} ${count === 1 ? 'point' : 'points'} by under ${MAX_GRID_SHIFT} px onto the ${frame} px grid. Off by default.`,
  },
};

interface WorkingObject {
  nodes: Map<string, VectorNode>;
  segments: Map<string, Segment>;
  paths: Array<{ id: string; segmentIds: string[]; isClosed: boolean }>;
  networkNodeIds: string[];
}

function totalPoints(payload: VectorClipboardPayload): number {
  return payload.objects.reduce((sum, item) => sum + item.nodes.length, 0);
}

function angleBetween(a: Point, b: Point): number {
  const cross = a.x * b.y - a.y * b.x;
  const dot = a.x * b.x + a.y * b.y;
  return Math.abs(Math.atan2(cross, dot)) * 180 / Math.PI;
}

function nearAxisSegments(item: VectorClipboardPayload['objects'][number]): Array<{ segment: Segment; axis: 'h' | 'v' }> {
  const nodes = new Map(item.nodes.map((node) => [node.id, node]));
  const found: Array<{ segment: Segment; axis: 'h' | 'v' }> = [];
  for (const segment of item.segments) {
    if (segment.type !== 'line' || segment.role !== 'geometry') continue;
    const a = nodes.get(segment.startNodeId)?.position;
    const b = nodes.get(segment.endNodeId)?.position;
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    if (length < EPSILON) continue;
    const limit = Math.tan(STRAIGHTEN_MAX_DEGREES * Math.PI / 180);
    if (Math.abs(dy) > EPSILON && Math.abs(dy) <= Math.abs(dx) * limit && Math.abs(dy) <= MAX_STRAIGHTEN_SHIFT * 2) found.push({ segment, axis: 'h' });
    else if (Math.abs(dx) > EPSILON && Math.abs(dx) <= Math.abs(dy) * limit && Math.abs(dx) <= MAX_STRAIGHTEN_SHIFT * 2) found.push({ segment, axis: 'v' });
  }
  return found;
}

function moveNode(node: VectorNode, to: Point) {
  const dx = to.x - node.position.x;
  const dy = to.y - node.position.y;
  node.position = { x: to.x, y: to.y };
  // Bézier handles are absolute, so they travel with their node.
  if (node.handleIn) node.handleIn = { x: node.handleIn.x + dx, y: node.handleIn.y + dy };
  if (node.handleOut) node.handleOut = { x: node.handleOut.x + dx, y: node.handleOut.y + dy };
}

function straighten(payload: VectorClipboardPayload): number {
  let count = 0;
  for (const item of payload.objects) {
    const nodes = new Map(item.nodes.map((node) => [node.id, node]));
    for (const { segment, axis } of nearAxisSegments(item)) {
      const a = nodes.get(segment.startNodeId);
      const b = nodes.get(segment.endNodeId);
      if (!a || !b) continue;
      if (axis === 'h') {
        const y = (a.position.y + b.position.y) / 2;
        moveNode(a, { x: a.position.x, y });
        moveNode(b, { x: b.position.x, y });
      } else {
        const x = (a.position.x + b.position.x) / 2;
        moveNode(a, { x, y: a.position.y });
        moveNode(b, { x, y: b.position.y });
      }
      count += 1;
    }
  }
  return count;
}

function working(item: VectorClipboardPayload['objects'][number]): WorkingObject {
  return {
    nodes: new Map(item.nodes.map((node) => [node.id, node])),
    segments: new Map(item.segments.map((segment) => [segment.id, segment])),
    paths: item.paths,
    networkNodeIds: item.network.nodeIds,
  };
}

/** Finds nodes that sit between exactly two straight segments pointing the same way. */
function collinearCandidates(item: VectorClipboardPayload['objects'][number]): Array<{ pathIndex: number; index: number; nodeId: string }> {
  const work = working(item);
  const useCount = new Map<string, number>();
  for (const segment of item.segments) {
    useCount.set(segment.startNodeId, (useCount.get(segment.startNodeId) ?? 0) + 1);
    useCount.set(segment.endNodeId, (useCount.get(segment.endNodeId) ?? 0) + 1);
  }
  const found: Array<{ pathIndex: number; index: number; nodeId: string }> = [];
  work.paths.forEach((path, pathIndex) => {
    const count = path.segmentIds.length;
    const limit = path.isClosed ? count : count - 1;
    for (let index = 0; index < limit; index += 1) {
      const first = work.segments.get(path.segmentIds[index]);
      const second = work.segments.get(path.segmentIds[(index + 1) % count]);
      if (!first || !second || first.type !== 'line' || second.type !== 'line') continue;
      if (first.role !== 'geometry' || second.role !== 'geometry') continue;
      if (first.endNodeId !== second.startNodeId) continue;
      if (useCount.get(first.endNodeId) !== 2) continue;
      const a = work.nodes.get(first.startNodeId)?.position;
      const m = work.nodes.get(first.endNodeId)?.position;
      const b = work.nodes.get(second.endNodeId)?.position;
      if (!a || !m || !b || first.startNodeId === second.endNodeId) continue;
      const v1 = { x: m.x - a.x, y: m.y - a.y };
      const v2 = { x: b.x - m.x, y: b.y - m.y };
      if (Math.hypot(v1.x, v1.y) < EPSILON || Math.hypot(v2.x, v2.y) < EPSILON) continue;
      if (angleBetween(v1, v2) <= COLLINEAR_MAX_DEGREES) found.push({ pathIndex, index, nodeId: first.endNodeId });
    }
  });
  return found;
}

function mergeCollinear(payload: VectorClipboardPayload): number {
  let removed = 0;
  for (const item of payload.objects) {
    // Remove one point at a time and look again, because merging changes neighbours.
    for (let guard = 0; guard < 10_000; guard += 1) {
      const candidate = collinearCandidates(item)[0];
      if (!candidate) break;
      const path = item.paths[candidate.pathIndex];
      const count = path.segmentIds.length;
      const firstId = path.segmentIds[candidate.index];
      const secondId = path.segmentIds[(candidate.index + 1) % count];
      const first = item.segments.find((segment) => segment.id === firstId)!;
      const second = item.segments.find((segment) => segment.id === secondId)!;
      first.endNodeId = second.endNodeId;
      item.segments = item.segments.filter((segment) => segment.id !== secondId);
      path.segmentIds = path.segmentIds.filter((id) => id !== secondId);
      item.nodes = item.nodes.filter((node) => node.id !== candidate.nodeId);
      item.network.nodeIds = item.network.nodeIds.filter((id) => id !== candidate.nodeId);
      removed += 1;
    }
  }
  return removed;
}

function snapValue(value: number): number {
  return Math.round(value / GRID_STEP) * GRID_STEP;
}

function gridMoves(item: VectorClipboardPayload['objects'][number], frame: number, origin: Point): VectorNode[] {
  if (frame > 64) return [];
  return item.nodes.filter((node) => {
    const x = snapValue(node.position.x - origin.x) + origin.x;
    const y = snapValue(node.position.y - origin.y) + origin.y;
    const dx = Math.abs(x - node.position.x);
    const dy = Math.abs(y - node.position.y);
    return (dx > 0.001 || dy > 0.001) && dx <= MAX_GRID_SHIFT && dy <= MAX_GRID_SHIFT;
  });
}

function snapToGrid(payload: VectorClipboardPayload, frame: number, origin: Point): number {
  let count = 0;
  for (const item of payload.objects) {
    for (const node of gridMoves(item, frame, origin)) {
      moveNode(node, {
        x: snapValue(node.position.x - origin.x) + origin.x,
        y: snapValue(node.position.y - origin.y) + origin.y,
      });
      count += 1;
    }
  }
  return count;
}

function frameSize(viewport: { width: number; height: number }): number {
  return Math.max(viewport.width, viewport.height);
}

function clonePayload(payload: VectorClipboardPayload): VectorClipboardPayload {
  return structuredClone(payload);
}

export function analyzeTidy(
  payload: VectorClipboardPayload,
  viewport: { minX: number; minY: number; width: number; height: number },
): TidyAnalysis {
  const frame = frameSize(viewport);
  const origin = { x: viewport.minX, y: viewport.minY };
  const counts: Record<TidyRuleId, number> = {
    straighten: payload.objects.reduce((sum, item) => sum + nearAxisSegments(item).length, 0),
    'merge-collinear': mergeCollinear(clonePayload(payload)),
    'snap-grid': payload.objects.reduce((sum, item) => sum + gridMoves(item, frame, origin).length, 0),
  };
  const rules = (Object.keys(counts) as TidyRuleId[])
    .filter((id) => counts[id] > 0)
    .map((id): TidyRule => ({
      id,
      title: RULE_COPY[id].title,
      description: RULE_COPY[id].describe(counts[id], Math.round(frame)),
      count: counts[id],
      defaultOn: RULE_COPY[id].defaultOn,
    }));
  const afterDefaults = applyTidy(payload, viewport, new Set(rules.filter((rule) => rule.defaultOn).map((rule) => rule.id)));
  return {
    pointCount: totalPoints(payload),
    pointCountAfterDefaults: totalPoints(afterDefaults),
    rules,
    isClean: rules.length === 0,
  };
}

/** Returns a tidied copy. The input payload is never mutated, so the dialog can preview freely. */
export function applyTidy(
  payload: VectorClipboardPayload,
  viewport: { minX: number; minY: number; width: number; height: number },
  rules: ReadonlySet<TidyRuleId>,
): VectorClipboardPayload {
  const next = clonePayload(payload);
  if (rules.has('straighten')) straighten(next);
  if (rules.has('merge-collinear')) mergeCollinear(next);
  if (rules.has('snap-grid')) snapToGrid(next, frameSize(viewport), { x: viewport.minX, y: viewport.minY });
  return next;
}
