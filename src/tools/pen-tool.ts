import { prepareArtboardPlacement } from '../core/artboard-operations';
import { appearanceFromDrawingStyle, DEFAULT_DRAWING_STYLE } from '../core/drawing-style';
import { createEntityId } from '../core/ids';
import type { OperationManager } from '../core/operations';
import type { DrawingStyle, EntityId, LayerNode, NetworkObject, Point, Segment, VectorNode, VectorPath } from '../core/types';

interface PathSession {
  pathId: EntityId;
  pathCreated: boolean;
  firstNodeId: EntityId;
  lastNodeId: EntityId;
  networkId: EntityId;
  objectId?: EntityId;
  appearanceId?: EntityId;
  origin?: Point;
  coordinateSpace: 'world' | 'local';
}

export interface PenToolOptions {
  standaloneObjects?: boolean;
  drawingStyle?: DrawingStyle;
}

export interface PlacePointOptions {
  position: Point;
  handleVector?: Point;
  closeTolerance: number;
  allowClose: boolean;
  targetNetworkId?: EntityId;
  targetObjectId?: EntityId;
  coordinateSpace?: 'world' | 'local';
}

export interface PlacePointResult {
  nodeId?: EntityId;
  objectId?: EntityId;
  closed: boolean;
}

export interface PenContinuationPreview {
  start: Point;
  cursor: Point;
  controlOut?: Point;
  closeTarget?: Point;
  willClose: boolean;
  coordinateSpace: 'world' | 'local';
  objectId?: EntityId;
}

/** Stateful pen controller; all graph changes are delegated to OperationManager. */
export class PenTool {
  private session: PathSession | null = null;
  private drawingStyle: DrawingStyle;

  constructor(
    private readonly operations: OperationManager,
    private readonly options: PenToolOptions = {},
  ) {
    this.drawingStyle = options.drawingStyle ?? DEFAULT_DRAWING_STYLE;
  }

  setDrawingStyle(style: DrawingStyle): void {
    this.drawingStyle = style;
    const appearanceId = this.session?.appearanceId;
    if (!appearanceId) return;
    const current = this.operations.document.getAppearance(appearanceId);
    if (!current) return;
    const next = appearanceFromDrawingStyle(appearanceId, style);
    if (JSON.stringify(current) === JSON.stringify(next)) return;
    this.operations.execute({ type: 'UPDATE_APPEARANCE', payload: { appearanceId, updates: next } });
  }

  placePoint(options: PlacePointOptions): PlacePointResult {
    this.ensureValidSession();
    const position = this.session?.origin
      ? { x: options.position.x - this.session.origin.x, y: options.position.y - this.session.origin.y }
      : options.position;
    if (options.allowClose && this.canCloseAt(position, options.closeTolerance)) {
      const objectId = this.session?.objectId;
      this.closePath();
      return { objectId, closed: true };
    }

    const handleVector = options.handleVector;
    const targetNetwork = options.targetNetworkId
      ? this.operations.document.getNetwork(options.targetNetworkId)
      : undefined;
    const targetObject = options.targetObjectId
      ? this.operations.document.getObject(options.targetObjectId)
      : undefined;
    if (options.targetNetworkId && !targetNetwork) throw new Error('The target vector network no longer exists.');
    if (targetObject && targetObject.networkId !== options.targetNetworkId) {
      throw new Error('The target object does not own the requested vector network.');
    }
    const targeted = !this.session && Boolean(targetNetwork);
    const standalone = !targeted && Boolean(this.options.standaloneObjects);
    const origin = !this.session && standalone ? { ...options.position } : this.session?.origin;
    const localPosition = origin
      ? { x: options.position.x - origin.x, y: options.position.y - origin.y }
      : { ...options.position };
    const placement = !this.session && standalone
      ? prepareArtboardPlacement(this.operations.document, options.position)
      : undefined;
    const node: VectorNode = {
      id: createEntityId(),
      position: localPosition,
      handleIn: handleVector ? { x: localPosition.x - handleVector.x, y: localPosition.y - handleVector.y } : undefined,
      handleOut: handleVector ? { x: localPosition.x + handleVector.x, y: localPosition.y + handleVector.y } : undefined,
      constraintIds: [],
    };
    const networkId = this.session?.networkId ?? targetNetwork?.id ?? (standalone ? createEntityId() : this.operations.document.activeNetwork.id);

    this.operations.beginTransaction(this.session ? 'Add pen point' : 'Start pen path');
    try {
      let objectId = this.session?.objectId ?? targetObject?.id;
      let appearanceId = this.session?.appearanceId ?? targetObject?.appearanceId;
      if (!this.session && standalone) {
        appearanceId = createEntityId();
        objectId = createEntityId();
        const layerId = createEntityId();
        const name = nextPenName(this.operations);
        const object: NetworkObject = {
          id: objectId,
          name,
          networkId,
          appearanceId,
          transform: { x: origin!.x, y: origin!.y, rotation: 0, scaleX: 1, scaleY: 1 },
        };
        const targetArtboard = placement ? this.operations.document.getArtboard(placement.artboardId) : undefined;
        const layer: LayerNode = {
          id: layerId,
          kind: 'object',
          name,
          artboardId: placement?.artboardId ?? this.operations.document.activeArtboardId,
          childIds: [],
          objectId,
          visible: true,
          locked: false,
          expanded: true,
        };
        for (const operation of placement?.setupOperations ?? []) this.operations.execute(operation);
        this.operations.execute({ type: 'ADD_NETWORK', payload: { network: { id: networkId, nodeIds: [], pathIds: [] } } });
        this.operations.execute({ type: 'ADD_APPEARANCE', payload: { appearance: appearanceFromDrawingStyle(appearanceId, this.drawingStyle) } });
        this.operations.execute({ type: 'ADD_OBJECT', payload: { object } });
        this.operations.execute({ type: 'ADD_LAYER', payload: { layer, index: targetArtboard?.layerIds.length ?? 0 } });
        if (placement && placement.artboardId !== this.operations.document.activeArtboardId) {
          this.operations.execute({
            type: 'SET_ACTIVE_LOCATION',
            payload: { pageId: this.operations.document.activePageId, artboardId: placement.artboardId },
          });
        }
      }

      this.operations.execute({ type: 'ADD_NODE', payload: { node, networkId } });

      if (!this.session) {
        const path: VectorPath = { id: createEntityId(), segmentIds: [], isClosed: false };
        this.operations.execute({ type: 'ADD_PATH', payload: { path, networkId } });
        this.session = {
          pathId: path.id,
          pathCreated: true,
          firstNodeId: node.id,
          lastNodeId: node.id,
          networkId,
          objectId,
          appearanceId,
          origin,
          coordinateSpace: options.coordinateSpace ?? 'world',
        };
      } else {
        const previous = this.operations.document.getNode(this.session.lastNodeId);
        if (!previous) throw new Error('The active pen path is no longer valid.');
        if (!this.session.pathCreated) {
          this.operations.execute({
            type: 'ADD_PATH',
            payload: { path: { id: this.session.pathId, segmentIds: [], isClosed: false }, networkId: this.session.networkId },
          });
          this.session.pathCreated = true;
        }
        const segment: Segment = {
          id: createEntityId(),
          startNodeId: previous.id,
          endNodeId: node.id,
          type: previous.handleOut || node.handleIn ? 'bezier' : 'line',
          role: 'geometry',
        };
        this.operations.execute({ type: 'ADD_SEGMENT', payload: { segment, pathId: this.session.pathId } });
        this.session.lastNodeId = node.id;
      }

      this.operations.commitTransaction();
      return { nodeId: node.id, objectId: this.session.objectId, closed: false };
    } catch (error) {
      this.operations.rollbackTransaction();
      throw error;
    }
  }

  beginFromNode(nodeId: EntityId, networkId: EntityId, objectId?: EntityId): boolean {
    this.ensureValidSession();
    if (this.session) return false;
    const network = this.operations.document.getNetwork(networkId);
    const node = this.operations.document.getNode(nodeId);
    const object = objectId ? this.operations.document.getObject(objectId) : undefined;
    if (!network || !node || !network.nodeIds.includes(nodeId)) return false;
    if (object && object.networkId !== networkId) return false;
    this.session = {
      pathId: createEntityId(),
      pathCreated: false,
      firstNodeId: nodeId,
      lastNodeId: nodeId,
      networkId,
      objectId: object?.id,
      appearanceId: object?.appearanceId,
      coordinateSpace: object ? 'local' : 'world',
    };
    return true;
  }

  connectToNode(nodeId: EntityId): { connected: boolean; closed: boolean } {
    this.ensureValidSession();
    const session = this.session;
    if (!session || nodeId === session.lastNodeId) return { connected: false, closed: false };
    const network = this.operations.document.getNetwork(session.networkId);
    const target = this.operations.document.getNode(nodeId);
    const last = this.operations.document.getNode(session.lastNodeId);
    if (!network || !target || !last || !network.nodeIds.includes(nodeId)) return { connected: false, closed: false };
    const path = session.pathCreated ? this.operations.document.getPath(session.pathId) : undefined;
    if (nodeId === session.firstNodeId && path && path.segmentIds.length >= 2) {
      this.closePath();
      return { connected: true, closed: true };
    }

    this.operations.beginTransaction('Connect pen path');
    try {
      if (!session.pathCreated) {
        this.operations.execute({
          type: 'ADD_PATH',
          payload: { path: { id: session.pathId, segmentIds: [], isClosed: false }, networkId: session.networkId },
        });
        session.pathCreated = true;
      }
      const segment: Segment = {
        id: createEntityId(),
        startNodeId: last.id,
        endNodeId: target.id,
        type: last.handleOut || target.handleIn ? 'bezier' : 'line',
        role: 'geometry',
      };
      this.operations.execute({ type: 'ADD_SEGMENT', payload: { segment, pathId: session.pathId } });
      session.lastNodeId = target.id;
      this.operations.commitTransaction();
      return { connected: true, closed: false };
    } catch (error) {
      this.operations.rollbackTransaction();
      throw error;
    }
  }

  endPath(): void {
    this.session = null;
  }

  get hasActivePath(): boolean {
    this.ensureValidSession();
    return this.session !== null;
  }

  get activeCoordinateSpace(): 'world' | 'local' | undefined {
    this.ensureValidSession();
    return this.session?.coordinateSpace;
  }

  get activeObjectId(): EntityId | undefined {
    this.ensureValidSession();
    return this.session?.objectId;
  }

  /** Constrains the next anchor to 45° increments from the active endpoint. */
  constrainPosition(position: Point): Point {
    this.ensureValidSession();
    if (!this.session) return { ...position };
    const last = this.operations.document.getNode(this.session.lastNodeId);
    if (!last) return { ...position };
    const localPosition = this.session.origin
      ? { x: position.x - this.session.origin.x, y: position.y - this.session.origin.y }
      : position;
    const dx = localPosition.x - last.position.x;
    const dy = localPosition.y - last.position.y;
    const length = Math.hypot(dx, dy);
    if (length < 1e-9) return { ...position };
    const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI / 4;
    const constrained = {
      x: last.position.x + Math.cos(angle) * length,
      y: last.position.y + Math.sin(angle) * length,
    };
    return this.session.origin
      ? { x: constrained.x + this.session.origin.x, y: constrained.y + this.session.origin.y }
      : constrained;
  }

  continuationPreview(cursor: Point, closeTolerance: number): PenContinuationPreview | undefined {
    this.ensureValidSession();
    if (!this.session) return undefined;
    const last = this.operations.document.getNode(this.session.lastNodeId);
    const first = this.operations.document.getNode(this.session.firstNodeId);
    if (!last || !first) return undefined;
    const toWorld = (point: Point): Point => this.session?.origin
      ? { x: point.x + this.session.origin.x, y: point.y + this.session.origin.y }
      : { ...point };
    const localCursor = this.session.origin
      ? { x: cursor.x - this.session.origin.x, y: cursor.y - this.session.origin.y }
      : cursor;
    return {
      start: toWorld(last.position),
      cursor: { ...cursor },
      controlOut: last.handleOut ? toWorld(last.handleOut) : undefined,
      closeTarget: this.session.firstNodeId !== this.session.lastNodeId ? toWorld(first.position) : undefined,
      willClose: this.canCloseAt(localCursor, closeTolerance),
      coordinateSpace: this.session.coordinateSpace,
      objectId: this.session.objectId,
    };
  }

  private canCloseAt(position: Point, tolerance: number): boolean {
    if (!this.session || this.session.firstNodeId === this.session.lastNodeId) return false;
    const path = this.operations.document.getPath(this.session.pathId);
    const first = this.operations.document.getNode(this.session.firstNodeId);
    if (!path || !first || path.segmentIds.length < 2) return false;
    return Math.hypot(first.position.x - position.x, first.position.y - position.y) <= tolerance;
  }

  private closePath(): void {
    if (!this.session || !this.session.pathCreated) return;
    const pathId = this.session.pathId;
    const first = this.operations.document.getNode(this.session.firstNodeId);
    const last = this.operations.document.getNode(this.session.lastNodeId);
    if (!first || !last) return;

    const segment: Segment = {
      id: createEntityId(),
      startNodeId: last.id,
      endNodeId: first.id,
      type: last.handleOut || first.handleIn ? 'bezier' : 'line',
      role: 'geometry',
    };

    this.operations.beginTransaction('Close pen path');
    try {
      this.operations.execute({ type: 'ADD_SEGMENT', payload: { segment, pathId } });
      this.operations.execute({ type: 'SET_PATH_CLOSED', payload: { pathId, isClosed: true } });
      this.operations.commitTransaction();
      this.session = null;
    } catch (error) {
      this.operations.rollbackTransaction();
      throw error;
    }
  }

  private ensureValidSession(): void {
    if (!this.session) return;
    const first = this.operations.document.getNode(this.session.firstNodeId);
    const network = this.operations.document.getNetwork(this.session.networkId);
    if (!first || !network || !network.nodeIds.includes(first.id)) {
      this.session = null;
      return;
    }
    if (!this.session.pathCreated) {
      if (!this.operations.document.getNode(this.session.lastNodeId)) this.session = null;
      return;
    }
    const path = this.operations.document.getPath(this.session.pathId);
    if (!path || path.isClosed) {
      this.session = null;
      return;
    }
    if (this.operations.document.getNode(this.session.lastNodeId)) return;

    // Undo may remove the latest pen point while leaving the open path alive.
    // Re-anchor the controller to the current final segment so drawing can
    // continue naturally without bypassing the operation boundary.
    const finalSegmentId = path.segmentIds.at(-1);
    const finalSegment = finalSegmentId ? this.operations.document.getSegment(finalSegmentId) : undefined;
    this.session.lastNodeId = finalSegment?.endNodeId ?? this.session.firstNodeId;
  }
}

function nextPenName(operations: OperationManager): string {
  const count = operations.document.objectsForArtboard(operations.document.activeArtboardId)
    .filter((object) => /^(?:Pen|Path)(?:\s|$)/.test(object.name)).length;
  return `Path ${count + 1}`;
}
