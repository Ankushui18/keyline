export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface SpatialItem<T> extends Bounds {
  value: T;
}

export function isFiniteSpatialBounds(bounds: Bounds): boolean {
  return bounds.minX <= bounds.maxX && bounds.minY <= bounds.maxY &&
    [bounds.minX, bounds.minY, bounds.maxX, bounds.maxY].every(Number.isFinite);
}

interface QuadNode<T> {
  bounds: Bounds;
  depth: number;
  items: SpatialItem<T>[];
  children?: [QuadNode<T>, QuadNode<T>, QuadNode<T>, QuadNode<T>];
}

/** Lightweight deterministic quadtree used by the WebGL renderer for culling. */
export class SpatialIndex<T> {
  private readonly root: QuadNode<T>;

  constructor(bounds: Bounds, private readonly capacity = 24, private readonly maxDepth = 10) {
    this.root = {
      bounds: isFiniteSpatialBounds(bounds) ? bounds : { minX: -1, minY: -1, maxX: 1, maxY: 1 },
      depth: 0,
      items: [],
    };
  }

  insert(item: SpatialItem<T>): void {
    // Renderer-derived data must never poison the quadtree with NaN/Infinity.
    if (!isFiniteSpatialBounds(item)) return;
    insertNode(this.root, item, this.capacity, this.maxDepth);
  }

  query(bounds: Bounds): T[] {
    if (!isFiniteSpatialBounds(bounds)) return [];
    const result: T[] = [];
    queryNode(this.root, bounds, result);
    return result;
  }
}

function insertNode<T>(node: QuadNode<T>, item: SpatialItem<T>, capacity: number, maxDepth: number): void {
  if (node.children) {
    const child = node.children.find((candidate) => contains(candidate.bounds, item));
    if (child) {
      insertNode(child, item, capacity, maxDepth);
      return;
    }
  }
  node.items.push(item);
  if (!node.children && node.items.length > capacity && node.depth < maxDepth) {
    node.children = split(node);
    const retained: SpatialItem<T>[] = [];
    for (const existing of node.items) {
      const child = node.children.find((candidate) => contains(candidate.bounds, existing));
      if (child) insertNode(child, existing, capacity, maxDepth);
      else retained.push(existing);
    }
    node.items = retained;
  }
}

function queryNode<T>(node: QuadNode<T>, bounds: Bounds, result: T[]): void {
  if (!intersects(node.bounds, bounds)) return;
  for (const item of node.items) if (intersects(item, bounds)) result.push(item.value);
  if (node.children) for (const child of node.children) queryNode(child, bounds, result);
}

function split<T>(node: QuadNode<T>): [QuadNode<T>, QuadNode<T>, QuadNode<T>, QuadNode<T>] {
  const middleX = (node.bounds.minX + node.bounds.maxX) / 2;
  const middleY = (node.bounds.minY + node.bounds.maxY) / 2;
  const child = (bounds: Bounds): QuadNode<T> => ({ bounds, depth: node.depth + 1, items: [] });
  return [
    child({ minX: node.bounds.minX, minY: node.bounds.minY, maxX: middleX, maxY: middleY }),
    child({ minX: middleX, minY: node.bounds.minY, maxX: node.bounds.maxX, maxY: middleY }),
    child({ minX: node.bounds.minX, minY: middleY, maxX: middleX, maxY: node.bounds.maxY }),
    child({ minX: middleX, minY: middleY, maxX: node.bounds.maxX, maxY: node.bounds.maxY }),
  ];
}

function contains(outer: Bounds, inner: Bounds): boolean {
  return inner.minX >= outer.minX && inner.maxX <= outer.maxX && inner.minY >= outer.minY && inner.maxY <= outer.maxY;
}

function intersects(a: Bounds, b: Bounds): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}
