import { createEntityId } from './ids';
import { validateSegmentGeometry, VectorDocument } from './document';
import { assertValidParametricGroup } from './parametric';
import { detectRegionsDetailed, type RegionDiagnostic } from './regions';
import { DeterministicConstraintSolver } from '../constraints/solver';
import type {
  Appearance,
  AppearanceRule,
  Artboard,
  BezierHandle,
  Constraint,
  ConstraintConflict,
  ConstructionExtent,
  DocumentExportMetadata,
  DocumentPage,
  DocumentSnapshot,
  EntityId,
  ExportVariable,
  FillRule,
  FillStyle,
  GeometryComponent,
  LayerNode,
  NetworkObject,
  ParametricGroup,
  Point,
  Segment,
  SegmentRole,
  SegmentType,
  WidthPoint,
  VectorNetwork,
  VectorNode,
  VectorPath,
} from './types';

export type OperationType =
  | 'ADD_NETWORK'
  | 'REMOVE_NETWORK'
  | 'ADD_NODE'
  | 'REMOVE_NODE'
  | 'MOVE_NODE'
  | 'SET_NODE_MODES'
  | 'ADD_PATH'
  | 'REMOVE_PATH'
  | 'ADD_SEGMENT'
  | 'REMOVE_SEGMENT'
  | 'SET_PATH_CLOSED'
  | 'APPLY_GRAPH_PATCH'
  | 'MERGE_REGIONS'
  | 'EXTRACT_REGION'
  | 'SUBTRACT_REGION'
  | 'SPLIT_SEGMENT'
  | 'RESTORE_SPLIT_SEGMENT'
  | 'CUT_PATHS'
  | 'RESTORE_CUT_PATHS'
  | 'ADD_BEZIER_HANDLES'
  | 'CONVERT_TO_BEZIER'
  | 'ADJUST_HANDLE'
  | 'RESTORE_BEND_STATE'
  | 'ADD_CONSTRAINT'
  | 'REMOVE_CONSTRAINT'
  | 'UPDATE_CONSTRAINT'
  | 'SET_NODE_POSITIONS'
  | 'SET_SEGMENT_GEOMETRIES'
  | 'SET_SEGMENT_ROLES'
  | 'SET_SEGMENT_WIDTH_PROFILE'
  | 'ADD_PARAMETRIC_GROUP'
  | 'REMOVE_PARAMETRIC_GROUP'
  | 'UPDATE_PARAMETRIC_GROUP'
  | 'ADD_EXPORT_VARIABLE'
  | 'UPDATE_EXPORT_VARIABLE'
  | 'REMOVE_EXPORT_VARIABLE'
  | 'UPDATE_EXPORT_METADATA'
  | 'ADD_APPEARANCE_RULE'
  | 'REMOVE_APPEARANCE_RULE'
  | 'UPDATE_APPEARANCE_RULE'
  | 'ADD_GEOMETRY_COMPONENT'
  | 'REMOVE_GEOMETRY_COMPONENT'
  | 'UPDATE_GEOMETRY_COMPONENT'
  | 'SET_REGION_FILL'
  | 'SET_REGION_FILL_RULE'
  | 'ADD_PAGE'
  | 'REMOVE_PAGE'
  | 'UPDATE_PAGE'
  | 'MOVE_PAGE'
  | 'ADD_ARTBOARD'
  | 'REMOVE_ARTBOARD'
  | 'UPDATE_ARTBOARD'
  | 'UPDATE_ARTBOARD_DIMENSIONS'
  | 'MOVE_ARTBOARD'
  | 'ADD_LAYER'
  | 'REMOVE_LAYER'
  | 'UPDATE_LAYER'
  | 'MOVE_LAYER'
  | 'ADD_OBJECT'
  | 'REMOVE_OBJECT'
  | 'UPDATE_OBJECT'
  | 'ADD_APPEARANCE'
  | 'REMOVE_APPEARANCE'
  | 'UPDATE_APPEARANCE'
  | 'SET_LAYER_ISOLATION'
  | 'SET_ACTIVE_LOCATION'
  | 'BATCH';

export interface OperationDescriptor<T = unknown> {
  id: EntityId;
  type: OperationType;
  timestamp: number;
  payload: T;
}

/** A committed semantic operation and the serializable descriptor that reverses it. */
export interface Operation<T = unknown> extends OperationDescriptor<T> {
  inverse: OperationDescriptor;
}

export type OperationInput<T = unknown> = Pick<OperationDescriptor<T>, 'type' | 'payload'> &
  Partial<Pick<OperationDescriptor<T>, 'id' | 'timestamp'>>;

export interface NetworkPayload { network: VectorNetwork; index?: number }
export interface AddNodePayload { node: VectorNode; networkId: EntityId; index?: number }
export interface RemoveNodePayload { node: VectorNode; networkId: EntityId; index?: number }
export interface MoveNodePayload { nodeId: EntityId; delta: Point }
export interface SetNodeModesPayload { modes: Array<{ nodeId: EntityId; mode?: VectorNode['handleMode'] }> }
export interface AddPathPayload { path: VectorPath; networkId: EntityId; index?: number }
export interface RemovePathPayload { path: VectorPath; networkId: EntityId; index?: number }
export interface AddSegmentPayload { segment: Segment; pathId: EntityId; index?: number }
export interface RemoveSegmentPayload { segment: Segment; pathId: EntityId; index?: number }
export interface SetPathClosedPayload { pathId: EntityId; isClosed: boolean }
export interface AddConstraintPayload { constraint: Constraint }
export interface RemoveConstraintPayload { constraintId: EntityId }
export interface UpdateConstraintPayload { constraintId: EntityId; updates: Partial<Constraint> }
export interface SetNodePositionsPayload { positions: Array<{ nodeId: EntityId; position: Point }> }
export interface SetSegmentGeometriesPayload { segments: Segment[] }
export interface SegmentRoleUpdate {
  segmentId: EntityId;
  role: SegmentRole;
  constructionExtent?: ConstructionExtent;
}
export interface SetSegmentRolesPayload { segments: SegmentRoleUpdate[] }
export interface SetSegmentWidthProfilePayload { segmentId: EntityId; widthProfile?: WidthPoint[] }
export interface ParametricGroupPayload { group: ParametricGroup }
export interface UpdateParametricGroupPayload { groupId: EntityId; updates: Partial<ParametricGroup> }
export interface ExportVariablePayload { variable: ExportVariable }
export interface UpdateExportVariablePayload { variableId: EntityId; updates: Partial<ExportVariable> }
export interface RemoveExportVariablePayload { variableId: EntityId }
export interface UpdateExportMetadataPayload { metadata: DocumentExportMetadata }
export interface AppearanceRulePayload { rule: AppearanceRule }
export interface UpdateAppearanceRulePayload { ruleId: EntityId; updates: Partial<AppearanceRule> }
export interface GeometryComponentPayload { component: GeometryComponent }
export interface UpdateGeometryComponentPayload {
  componentId: EntityId;
  updates: Partial<GeometryComponent>;
}
export interface SetRegionFillPayload { regionId: EntityId; fill?: FillStyle }
export interface SetRegionFillRulePayload { regionId: EntityId; fillRule: FillRule }
export interface PagePayload { page: DocumentPage; index?: number }
export interface UpdatePagePayload { pageId: EntityId; updates: Partial<DocumentPage> }
export interface MovePagePayload { pageId: EntityId; index: number }
export interface ArtboardPayload { artboard: Artboard; pageId: EntityId; index?: number }
export interface UpdateArtboardPayload { artboardId: EntityId; updates: Partial<Artboard> }
export interface UpdateArtboardDimensionsPayload {
  artboardId: EntityId;
  width: number;
  height: number;
}
export interface MoveArtboardPayload { artboardId: EntityId; pageId: EntityId; index: number }
export interface LayerPayload { layer: LayerNode; index?: number }
export interface UpdateLayerPayload { layerId: EntityId; updates: Partial<LayerNode> }
export interface MoveLayerPayload {
  layerId: EntityId;
  parentId?: EntityId;
  artboardId: EntityId;
  index?: number;
}
export interface ObjectPayload { object: NetworkObject }
export interface UpdateObjectPayload { objectId: EntityId; updates: Partial<NetworkObject> }
export interface AppearancePayload { appearance: Appearance }
export interface UpdateAppearancePayload { appearanceId: EntityId; updates: Partial<Appearance> }
export interface SetLayerIsolationPayload { layerId?: EntityId }
export interface SetActiveLocationPayload { pageId: EntityId; artboardId: EntityId }
export interface BatchPayload { label: string; operations: OperationDescriptor[] }

export interface GraphPatch {
  addNodes: AddNodePayload[];
  addPaths: AddPathPayload[];
  addSegments: AddSegmentPayload[];
  removeSegments: RemoveSegmentPayload[];
  removePaths: RemovePathPayload[];
  removeNodes: RemoveNodePayload[];
}

export interface ShapeBuilderPayload {
  networkId: EntityId;
  regionIds: EntityId[];
  regionId?: EntityId;
  targetPathId?: EntityId;
  resultPathId: EntityId;
  resultPathIds: EntityId[];
  patch: GraphPatch;
}

export interface NodeHandleState {
  handleIn: BezierHandle | null;
  handleOut: BezierHandle | null;
}

export interface SplitSegmentPayload {
  segmentId: EntityId;
  splitPoint: Point;
  newNodeId: EntityId;
  newSegment1Id: EntityId;
  newSegment2Id: EntityId;
  t: number;
  pathId: EntityId;
  networkId: EntityId;
  originalIndex: number;
  originalSegment: Segment;
  newNode: VectorNode;
  newSegment1: Segment;
  newSegment2: Segment;
  startBefore: NodeHandleState;
  startAfter: NodeHandleState;
  endBefore: NodeHandleState;
  endAfter: NodeHandleState;
}

export interface CutPathsPayload {
  cutLine: { start: Point; end: Point };
  affectedSegmentIds: EntityId[];
  newNodes: VectorNode[];
  newSegments: Segment[];
  splits: SplitSegmentPayload[];
}

export interface AddBezierHandlesPayload {
  nodeId: EntityId;
  handleIn: BezierHandle;
  handleOut: BezierHandle;
}

export interface ConvertToBezierPayload {
  segmentId: EntityId;
  startHandleOut: BezierHandle;
  endHandleIn: BezierHandle;
}

export interface AdjustHandlePayload {
  nodeId: EntityId;
  handleType: 'in' | 'out';
  newHandle: BezierHandle;
  mirroredHandle?: BezierHandle;
}

export interface BendStatePayload {
  nodes: Array<{ nodeId: EntityId; state: NodeHandleState }>;
  segments: Array<{ segmentId: EntityId; type: SegmentType }>;
}

export interface OperationChangeEvent {
  document: VectorDocument;
  operation?: OperationDescriptor;
  committed: boolean;
  reason: 'execute' | 'undo' | 'redo' | 'transaction' | 'rollback' | 'remote';
}

type Listener = (event: OperationChangeEvent) => void;
type PreValidate = (operation: OperationDescriptor, document: VectorDocument) => void | string;
type DiagnosticsListener = (conflicts: ConstraintConflict[]) => void;
type RegionDiagnosticsListener = (diagnostics: RegionDiagnostic[]) => void;

export class ConstraintViolationError extends Error {
  constructor(readonly conflicts: ConstraintConflict[]) {
    super(conflicts[0]?.message ?? 'The operation violates a hard constraint.');
    this.name = 'ConstraintViolationError';
  }
}

/**
 * The sole production graph-mutation boundary. All semantic operations stay
 * serializable, are pre-validatable, and refresh the derived planar regions
 * before observers render or persist the document.
 */
export class OperationManager {
  private undoStack: Operation[] = [];
  private redoStack: Operation[] = [];
  private listeners = new Set<Listener>();
  private validators = new Set<PreValidate>();
  private diagnosticsListener: DiagnosticsListener | undefined;
  private regionDiagnosticsListener: RegionDiagnosticsListener | undefined;
  private lastRegionDiagnosticsKey = '';
  private readonly constraintSolver = new DeterministicConstraintSolver();
  private transaction: { label: string; operations: Operation[]; touchedNodeIds: Set<EntityId> } | null = null;

  constructor(readonly document: VectorDocument) {
    this.refreshRegions();
  }

  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }

  replaceFromRemoteSnapshot(snapshot: DocumentSnapshot): void {
    if (this.transaction) this.rollbackTransaction();
    this.document._replaceFromSnapshot(snapshot);
    this.undoStack = [];
    this.redoStack = [];
    this.refreshRegions();
    this.emit({ committed: false, reason: 'remote' });
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  addValidator(validator: PreValidate): () => void {
    this.validators.add(validator);
    return () => this.validators.delete(validator);
  }

  setDiagnosticsListener(listener: DiagnosticsListener | undefined): void {
    this.diagnosticsListener = listener;
  }

  setRegionDiagnosticsListener(listener: RegionDiagnosticsListener | undefined): void {
    this.regionDiagnosticsListener = listener;
    if (listener) this.lastRegionDiagnosticsKey = '';
  }

  execute(input: OperationInput): Operation {
    const descriptor = normalize(input);
    this.validate(descriptor);
    const inverse = this.createInverse(descriptor);
    this.apply(descriptor);

    let operation: Operation = { ...descriptor, inverse };
    let emittedDescriptor: OperationDescriptor = descriptor;
    const pinnedNodeIds = this.pinnedNodeIdsFor(descriptor);
    if (this.transaction) {
      for (const nodeId of pinnedNodeIds) this.transaction.touchedNodeIds.add(nodeId);
    }

    if (this.shouldSolve(descriptor)) {
      const tentativePositions = this.capturePositions();
      const pinned = this.transaction?.touchedNodeIds ?? pinnedNodeIds;
      const result = this.constraintSolver.solve(this.document, { pinnedNodeIds: pinned });
      if (!result.success) {
        this.apply(inverse);
        this.refreshRegions();
        this.diagnosticsListener?.(result.conflicts);
        throw new ConstraintViolationError(result.conflicts);
      }

      const solvedPositions = [...result.adjustedNodes]
        .filter(([nodeId, position]) => {
          const current = tentativePositions.get(nodeId);
          return current && (Math.abs(current.x - position.x) > 1e-12 || Math.abs(current.y - position.y) > 1e-12);
        })
        .map(([nodeId, position]) => ({ nodeId, position: { ...position } }));

      const solvedSegments = [...(result.adjustedSegments ?? new Map<EntityId, Segment>())]
        .filter(([segmentId, segment]) => {
          const current = this.document.getSegment(segmentId);
          return current && !segmentGeometryEqual(current, segment);
        })
        .map(([, segment]) => cloneSegment(segment));

      if (solvedPositions.length > 0 || solvedSegments.length > 0) {
        const solvedDescriptors: OperationDescriptor[] = [];
        const solvedInverses: OperationDescriptor[] = [];
        if (solvedSegments.length > 0) {
          const geometryDescriptor: OperationDescriptor<SetSegmentGeometriesPayload> = normalize({
            type: 'SET_SEGMENT_GEOMETRIES',
            payload: { segments: solvedSegments },
          });
          const geometryInverse: OperationDescriptor<SetSegmentGeometriesPayload> = normalize({
            type: 'SET_SEGMENT_GEOMETRIES',
            payload: {
              segments: solvedSegments.map((segment) => cloneSegment(this.requireSegment(segment.id))),
            },
          });
          this.apply(geometryDescriptor);
          solvedDescriptors.push(geometryDescriptor);
          solvedInverses.unshift(geometryInverse);
        }
        if (solvedPositions.length > 0) {
          const positionDescriptor: OperationDescriptor<SetNodePositionsPayload> = normalize({
            type: 'SET_NODE_POSITIONS',
            payload: { positions: solvedPositions },
          });
          const positionInverse: OperationDescriptor<SetNodePositionsPayload> = normalize({
            type: 'SET_NODE_POSITIONS',
            payload: {
              positions: solvedPositions.map(({ nodeId }) => ({
                nodeId,
                position: { ...tentativePositions.get(nodeId)! },
              })),
            },
          });
          this.apply(positionDescriptor);
          solvedDescriptors.push(positionDescriptor);
          solvedInverses.unshift(positionInverse);
        }
        const batchDescriptor: OperationDescriptor<BatchPayload> = normalize({
          type: 'BATCH',
          payload: { label: `Constrained ${descriptor.type}`, operations: [descriptor, ...solvedDescriptors] },
        });
        const batchInverse: OperationDescriptor<BatchPayload> = normalize({
          type: 'BATCH',
          payload: { label: `Undo constrained ${descriptor.type}`, operations: [...solvedInverses, inverse] },
        });
        operation = { ...batchDescriptor, inverse: batchInverse };
        emittedDescriptor = batchDescriptor;
      }
      this.diagnosticsListener?.([]);
    }

    this.refreshRegions();
    if (this.transaction) {
      this.recordTransactionOperation(operation);
      this.emit({ operation: emittedDescriptor, committed: false, reason: 'execute' });
    } else {
      this.undoStack.push(operation);
      this.redoStack = [];
      this.emit({ operation: emittedDescriptor, committed: true, reason: 'execute' });
    }
    return operation;
  }

  beginTransaction(label: string): void {
    if (this.transaction) throw new Error('A transaction is already active.');
    this.transaction = { label, operations: [], touchedNodeIds: new Set() };
  }

  commitTransaction(): void {
    const transaction = this.transaction;
    if (!transaction) return;
    this.transaction = null;
    if (transaction.operations.length === 0) return;

    const descriptor: OperationDescriptor<BatchPayload> = normalize({
      type: 'BATCH',
      payload: { label: transaction.label, operations: transaction.operations.map(stripInverse) },
    });
    const inverse: OperationDescriptor<BatchPayload> = normalize({
      type: 'BATCH',
      payload: {
        label: `Undo ${transaction.label}`,
        operations: [...transaction.operations].reverse().map((item) => item.inverse),
      },
    });
    this.undoStack.push({ ...descriptor, inverse });
    this.redoStack = [];
    this.emit({ operation: descriptor, committed: true, reason: 'transaction' });
  }

  rollbackTransaction(): void {
    const transaction = this.transaction;
    if (!transaction) return;
    this.transaction = null;
    for (const operation of [...transaction.operations].reverse()) this.apply(operation.inverse);
    this.refreshRegions();
    this.emit({ committed: false, reason: 'rollback' });
  }

  undo(): boolean {
    if (this.transaction) return false;
    const operation = this.undoStack.pop();
    if (!operation) return false;
    this.apply(operation.inverse);
    this.refreshRegions();
    this.redoStack.push(operation);
    this.emit({ operation: operation.inverse, committed: true, reason: 'undo' });
    return true;
  }

  redo(): boolean {
    if (this.transaction) return false;
    const operation = this.redoStack.pop();
    if (!operation) return false;
    this.apply(stripInverse(operation));
    this.refreshRegions();
    this.undoStack.push(operation);
    this.emit({ operation, committed: true, reason: 'redo' });
    return true;
  }

  private validate(operation: OperationDescriptor): void {
    if (operation.type === 'UPDATE_ARTBOARD_DIMENSIONS') {
      const { artboardId, width, height } = operation.payload as UpdateArtboardDimensionsPayload;
      if (!this.document.getArtboard(artboardId)) throw new Error(`Unknown artboard ${artboardId}.`);
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        throw new Error('Artboard dimensions must be finite values greater than 0.');
      }
    }
    validateOperationSegmentGeometry(operation);
    validateSegmentRoleAndConstructionOperations(this.document, operation);
    validateParametricReferenceRemoval(this.document, operation);
    validateParametricReferenceGeometry(this.document, operation);
    validateShapeBuilderOperation(this.document, operation);
    for (const validator of this.validators) {
      const error = validator(operation, this.document);
      if (typeof error === 'string') throw new Error(error);
    }
  }

  private createInverse(operation: OperationDescriptor): OperationDescriptor {
    switch (operation.type) {
      case 'ADD_NETWORK': return normalize({ type: 'REMOVE_NETWORK', payload: operation.payload });
      case 'REMOVE_NETWORK': {
        const { network } = operation.payload as NetworkPayload;
        const existing = this.document.getNetwork(network.id);
        if (!existing) throw new Error(`Unknown network ${network.id}.`);
        return normalize({
          type: 'ADD_NETWORK',
          payload: { network: { ...existing, nodeIds: [], pathIds: [] }, index: this.document.networks.findIndex((item) => item.id === network.id) },
        });
      }
      case 'ADD_NODE': return normalize({ type: 'REMOVE_NODE', payload: operation.payload });
      case 'REMOVE_NODE': return normalize({ type: 'ADD_NODE', payload: operation.payload });
      case 'MOVE_NODE': {
        const { nodeId, delta } = operation.payload as MoveNodePayload;
        return normalize({ type: 'MOVE_NODE', payload: { nodeId, delta: { x: -delta.x, y: -delta.y } } });
      }
      case 'SET_NODE_MODES': {
        const payload = operation.payload as SetNodeModesPayload;
        return normalize({
          type: 'SET_NODE_MODES',
          payload: { modes: payload.modes.map(({ nodeId }) => ({ nodeId, mode: this.requireNode(nodeId).handleMode })) },
        });
      }
      case 'ADD_PATH': return normalize({ type: 'REMOVE_PATH', payload: operation.payload });
      case 'REMOVE_PATH': return normalize({ type: 'ADD_PATH', payload: operation.payload });
      case 'ADD_SEGMENT': return normalize({ type: 'REMOVE_SEGMENT', payload: operation.payload });
      case 'REMOVE_SEGMENT': return normalize({ type: 'ADD_SEGMENT', payload: operation.payload });
      case 'SET_PATH_CLOSED': {
        const { pathId } = operation.payload as SetPathClosedPayload;
        const path = this.document.getPath(pathId);
        if (!path) throw new Error(`Unknown path ${pathId}.`);
        return normalize({ type: 'SET_PATH_CLOSED', payload: { pathId, isClosed: path.isClosed } });
      }
      case 'APPLY_GRAPH_PATCH': {
        return normalize({ type: 'APPLY_GRAPH_PATCH', payload: invertGraphPatch(operation.payload as GraphPatch) });
      }
      case 'MERGE_REGIONS':
      case 'EXTRACT_REGION':
      case 'SUBTRACT_REGION': {
        const payload = operation.payload as ShapeBuilderPayload;
        return normalize({ type: 'APPLY_GRAPH_PATCH', payload: invertGraphPatch(payload.patch) });
      }
      case 'SPLIT_SEGMENT': return normalize({ type: 'RESTORE_SPLIT_SEGMENT', payload: operation.payload });
      case 'RESTORE_SPLIT_SEGMENT': return normalize({ type: 'SPLIT_SEGMENT', payload: operation.payload });
      case 'CUT_PATHS': return normalize({ type: 'RESTORE_CUT_PATHS', payload: operation.payload });
      case 'RESTORE_CUT_PATHS': return normalize({ type: 'CUT_PATHS', payload: operation.payload });
      case 'ADD_BEZIER_HANDLES': {
        const payload = operation.payload as AddBezierHandlesPayload;
        return normalize({ type: 'RESTORE_BEND_STATE', payload: this.captureBendState([payload.nodeId], this.document.connectedSegments(payload.nodeId).map((item) => item.id)) });
      }
      case 'CONVERT_TO_BEZIER': {
        const payload = operation.payload as ConvertToBezierPayload;
        const segment = this.requireSegment(payload.segmentId);
        return normalize({
          type: 'RESTORE_BEND_STATE',
          payload: this.captureBendState([segment.startNodeId, segment.endNodeId], [segment.id]),
        });
      }
      case 'ADJUST_HANDLE': {
        const payload = operation.payload as AdjustHandlePayload;
        return normalize({
          type: 'RESTORE_BEND_STATE',
          payload: this.captureBendState(
            [payload.nodeId],
            this.document.connectedSegments(payload.nodeId).map((item) => item.id),
          ),
        });
      }
      case 'RESTORE_BEND_STATE': {
        const payload = operation.payload as BendStatePayload;
        return normalize({
          type: 'RESTORE_BEND_STATE',
          payload: this.captureBendState(
            payload.nodes.map((item) => item.nodeId),
            payload.segments.map((item) => item.segmentId),
          ),
        });
      }
      case 'ADD_CONSTRAINT': {
        const { constraint } = operation.payload as AddConstraintPayload;
        return normalize({ type: 'REMOVE_CONSTRAINT', payload: { constraintId: constraint.id } });
      }
      case 'REMOVE_CONSTRAINT': {
        const { constraintId } = operation.payload as RemoveConstraintPayload;
        const constraint = this.document.constraints.get(constraintId);
        if (!constraint) throw new Error(`Unknown constraint ${constraintId}.`);
        return normalize({ type: 'ADD_CONSTRAINT', payload: { constraint: cloneConstraint(constraint) } });
      }
      case 'UPDATE_CONSTRAINT': {
        const { constraintId } = operation.payload as UpdateConstraintPayload;
        const constraint = this.document.constraints.get(constraintId);
        if (!constraint) throw new Error(`Unknown constraint ${constraintId}.`);
        return normalize({
          type: 'UPDATE_CONSTRAINT',
          payload: { constraintId, updates: cloneConstraint(constraint) },
        });
      }
      case 'SET_NODE_POSITIONS': {
        const payload = operation.payload as SetNodePositionsPayload;
        return normalize({
          type: 'SET_NODE_POSITIONS',
          payload: {
            positions: payload.positions.map(({ nodeId }) => {
              const node = this.requireNode(nodeId);
              return { nodeId, position: { ...node.position } };
            }),
          },
        });
      }
      case 'SET_SEGMENT_GEOMETRIES': {
        const payload = operation.payload as SetSegmentGeometriesPayload;
        return normalize({
          type: 'SET_SEGMENT_GEOMETRIES',
          payload: { segments: payload.segments.map((segment) => cloneSegment(this.requireSegment(segment.id))) },
        });
      }
      case 'SET_SEGMENT_ROLES': {
        const payload = operation.payload as SetSegmentRolesPayload;
        const targetIds = new Set(payload.segments.map((update) => update.segmentId));
        const restoreRoles = normalize({
          type: 'SET_SEGMENT_ROLES',
          payload: {
            segments: payload.segments.map(({ segmentId }) => {
              const segment = this.requireSegment(segmentId);
              return segment.role === 'construction'
                ? {
                    segmentId,
                    role: segment.role,
                    constructionExtent: segment.constructionExtent,
                  }
                : { segmentId, role: segment.role };
            }),
          },
        });
        const restoreFills = this.document.regions
          .filter((region) => region.fill && region.boundarySegmentIds.some((segmentId) => targetIds.has(segmentId)))
          .map((region) => normalize({
            type: 'SET_REGION_FILL',
            payload: { regionId: region.id, fill: { ...region.fill! } },
          }));
        return normalize({
          type: 'BATCH',
          payload: {
            label: 'Restore segment roles and region fills',
            operations: [restoreRoles, ...restoreFills],
          },
        });
      }
      case 'SET_SEGMENT_WIDTH_PROFILE': {
        const { segmentId } = operation.payload as SetSegmentWidthProfilePayload;
        const segment = this.requireSegment(segmentId);
        return normalize({
          type: 'SET_SEGMENT_WIDTH_PROFILE',
          payload: { segmentId, widthProfile: segment.widthProfile?.map((point) => ({ ...point })) },
        });
      }
      case 'ADD_PARAMETRIC_GROUP': return normalize({ type: 'REMOVE_PARAMETRIC_GROUP', payload: operation.payload });
      case 'REMOVE_PARAMETRIC_GROUP': {
        const { group } = operation.payload as ParametricGroupPayload;
        const existing = this.document.parametricGroups.get(group.id);
        if (!existing) throw new Error(`Unknown parametric group ${group.id}.`);
        return normalize({ type: 'ADD_PARAMETRIC_GROUP', payload: { group: cloneParametricGroup(existing) } });
      }
      case 'UPDATE_PARAMETRIC_GROUP': {
        const { groupId } = operation.payload as UpdateParametricGroupPayload;
        const existing = this.document.parametricGroups.get(groupId);
        if (!existing) throw new Error(`Unknown parametric group ${groupId}.`);
        return normalize({
          type: 'UPDATE_PARAMETRIC_GROUP',
          payload: { groupId, updates: cloneParametricGroup(existing) },
        });
      }
      case 'ADD_EXPORT_VARIABLE': {
        const { variable } = operation.payload as ExportVariablePayload;
        return normalize({ type: 'REMOVE_EXPORT_VARIABLE', payload: { variableId: variable.id } });
      }
      case 'REMOVE_EXPORT_VARIABLE': {
        const { variableId } = operation.payload as RemoveExportVariablePayload;
        const variable = this.document.exportVariables.get(variableId);
        if (!variable) throw new Error(`Unknown export variable ${variableId}.`);
        return normalize({ type: 'ADD_EXPORT_VARIABLE', payload: { variable: { ...variable } } });
      }
      case 'UPDATE_EXPORT_VARIABLE': {
        const { variableId } = operation.payload as UpdateExportVariablePayload;
        const variable = this.document.exportVariables.get(variableId);
        if (!variable) throw new Error(`Unknown export variable ${variableId}.`);
        return normalize({ type: 'UPDATE_EXPORT_VARIABLE', payload: { variableId, updates: { ...variable } } });
      }
      case 'UPDATE_EXPORT_METADATA': {
        return normalize({
          type: 'UPDATE_EXPORT_METADATA',
          payload: { metadata: cloneExportMetadata(this.document.exportMetadata) },
        });
      }
      case 'ADD_APPEARANCE_RULE': {
        const { rule } = operation.payload as AppearanceRulePayload;
        return normalize({ type: 'REMOVE_APPEARANCE_RULE', payload: { rule: cloneAppearanceRule(rule) } });
      }
      case 'REMOVE_APPEARANCE_RULE': {
        const { rule } = operation.payload as AppearanceRulePayload;
        const existing = this.document.getAppearanceRule(rule.id);
        if (!existing) throw new Error(`Unknown appearance rule ${rule.id}.`);
        return normalize({ type: 'ADD_APPEARANCE_RULE', payload: { rule: cloneAppearanceRule(existing) } });
      }
      case 'UPDATE_APPEARANCE_RULE': {
        const { ruleId } = operation.payload as UpdateAppearanceRulePayload;
        const existing = this.document.getAppearanceRule(ruleId);
        if (!existing) throw new Error(`Unknown appearance rule ${ruleId}.`);
        return normalize({
          type: 'UPDATE_APPEARANCE_RULE',
          payload: { ruleId, updates: cloneAppearanceRule(existing) },
        });
      }
      case 'ADD_GEOMETRY_COMPONENT': {
        const { component } = operation.payload as GeometryComponentPayload;
        return normalize({
          type: 'REMOVE_GEOMETRY_COMPONENT',
          payload: { component: cloneGeometryComponent(component) },
        });
      }
      case 'REMOVE_GEOMETRY_COMPONENT': {
        const { component } = operation.payload as GeometryComponentPayload;
        const existing = this.document.getGeometryComponent(component.id);
        if (!existing) throw new Error(`Unknown geometry component ${component.id}.`);
        return normalize({
          type: 'ADD_GEOMETRY_COMPONENT',
          payload: { component: cloneGeometryComponent(existing) },
        });
      }
      case 'UPDATE_GEOMETRY_COMPONENT': {
        const { componentId } = operation.payload as UpdateGeometryComponentPayload;
        const existing = this.document.getGeometryComponent(componentId);
        if (!existing) throw new Error(`Unknown geometry component ${componentId}.`);
        return normalize({
          type: 'UPDATE_GEOMETRY_COMPONENT',
          payload: { componentId, updates: cloneGeometryComponent(existing) },
        });
      }
      case 'SET_REGION_FILL': {
        const { regionId } = operation.payload as SetRegionFillPayload;
        const region = this.document.regions.find((item) => item.id === regionId);
        if (!region) throw new Error(`Unknown region ${regionId}.`);
        return normalize({
          type: 'SET_REGION_FILL',
          payload: { regionId, fill: region.fill ? { ...region.fill } : undefined },
        });
      }
      case 'SET_REGION_FILL_RULE': {
        const { regionId } = operation.payload as SetRegionFillRulePayload;
        const region = this.document.regions.find((item) => item.id === regionId);
        if (!region) throw new Error(`Unknown region ${regionId}.`);
        return normalize({
          type: 'SET_REGION_FILL_RULE',
          payload: { regionId, fillRule: region.fillRule },
        });
      }
      case 'ADD_PAGE': return normalize({ type: 'REMOVE_PAGE', payload: operation.payload });
      case 'REMOVE_PAGE': {
        const { page } = operation.payload as PagePayload;
        const existing = this.document.getPage(page.id);
        if (!existing) throw new Error(`Unknown page ${page.id}.`);
        return normalize({
          type: 'ADD_PAGE',
          payload: { page: clonePage(existing), index: this.document.pages.findIndex((item) => item.id === page.id) },
        });
      }
      case 'UPDATE_PAGE': {
        const { pageId } = operation.payload as UpdatePagePayload;
        const existing = this.document.getPage(pageId);
        if (!existing) throw new Error(`Unknown page ${pageId}.`);
        return normalize({ type: 'UPDATE_PAGE', payload: { pageId, updates: clonePage(existing) } });
      }
      case 'MOVE_PAGE': {
        const { pageId } = operation.payload as MovePagePayload;
        return normalize({ type: 'MOVE_PAGE', payload: { pageId, index: this.document.pages.findIndex((item) => item.id === pageId) } });
      }
      case 'ADD_ARTBOARD': return normalize({ type: 'REMOVE_ARTBOARD', payload: operation.payload });
      case 'REMOVE_ARTBOARD': {
        const { artboard, pageId } = operation.payload as ArtboardPayload;
        const existing = this.document.getArtboard(artboard.id);
        const page = this.document.getPage(pageId);
        if (!existing || !page) throw new Error(`Unknown artboard ${artboard.id}.`);
        return normalize({
          type: 'ADD_ARTBOARD',
          payload: { artboard: cloneArtboard(existing), pageId, index: page.artboardIds.indexOf(artboard.id) },
        });
      }
      case 'UPDATE_ARTBOARD': {
        const { artboardId } = operation.payload as UpdateArtboardPayload;
        const existing = this.document.getArtboard(artboardId);
        if (!existing) throw new Error(`Unknown artboard ${artboardId}.`);
        return normalize({ type: 'UPDATE_ARTBOARD', payload: { artboardId, updates: cloneArtboard(existing) } });
      }
      case 'UPDATE_ARTBOARD_DIMENSIONS': {
        const { artboardId } = operation.payload as UpdateArtboardDimensionsPayload;
        const existing = this.document.getArtboard(artboardId);
        if (!existing) throw new Error(`Unknown artboard ${artboardId}.`);
        return normalize({
          type: 'UPDATE_ARTBOARD_DIMENSIONS',
          payload: { artboardId, width: existing.frame.width, height: existing.frame.height },
        });
      }
      case 'MOVE_ARTBOARD': {
        const { artboardId, pageId } = operation.payload as MoveArtboardPayload;
        const page = this.document.getPage(pageId);
        if (!page) throw new Error(`Unknown page ${pageId}.`);
        return normalize({ type: 'MOVE_ARTBOARD', payload: { artboardId, pageId, index: page.artboardIds.indexOf(artboardId) } });
      }
      case 'ADD_LAYER': return normalize({ type: 'REMOVE_LAYER', payload: operation.payload });
      case 'REMOVE_LAYER': {
        const { layer } = operation.payload as LayerPayload;
        const existing = this.document.getLayer(layer.id);
        if (!existing) throw new Error(`Unknown layer ${layer.id}.`);
        return normalize({
          type: 'ADD_LAYER',
          payload: { layer: cloneLayer(existing), index: this.layerIndex(existing) },
        });
      }
      case 'UPDATE_LAYER': {
        const { layerId } = operation.payload as UpdateLayerPayload;
        const existing = this.document.getLayer(layerId);
        if (!existing) throw new Error(`Unknown layer ${layerId}.`);
        return normalize({ type: 'UPDATE_LAYER', payload: { layerId, updates: cloneLayer(existing) } });
      }
      case 'MOVE_LAYER': {
        const { layerId } = operation.payload as MoveLayerPayload;
        const existing = this.document.getLayer(layerId);
        if (!existing) throw new Error(`Unknown layer ${layerId}.`);
        return normalize({
          type: 'MOVE_LAYER',
          payload: {
            layerId,
            parentId: existing.parentId,
            artboardId: existing.artboardId,
            index: this.layerIndex(existing),
          },
        });
      }
      case 'ADD_OBJECT': return normalize({ type: 'REMOVE_OBJECT', payload: operation.payload });
      case 'REMOVE_OBJECT': {
        const { object } = operation.payload as ObjectPayload;
        const existing = this.document.getObject(object.id);
        if (!existing) throw new Error(`Unknown object ${object.id}.`);
        return normalize({ type: 'ADD_OBJECT', payload: { object: cloneObject(existing) } });
      }
      case 'UPDATE_OBJECT': {
        const { objectId } = operation.payload as UpdateObjectPayload;
        const existing = this.document.getObject(objectId);
        if (!existing) throw new Error(`Unknown object ${objectId}.`);
        return normalize({ type: 'UPDATE_OBJECT', payload: { objectId, updates: cloneObject(existing) } });
      }
      case 'ADD_APPEARANCE': return normalize({ type: 'REMOVE_APPEARANCE', payload: operation.payload });
      case 'REMOVE_APPEARANCE': {
        const { appearance } = operation.payload as AppearancePayload;
        const existing = this.document.getAppearance(appearance.id);
        if (!existing) throw new Error(`Unknown appearance ${appearance.id}.`);
        return normalize({ type: 'ADD_APPEARANCE', payload: { appearance: cloneAppearance(existing) } });
      }
      case 'UPDATE_APPEARANCE': {
        const { appearanceId } = operation.payload as UpdateAppearancePayload;
        const existing = this.document.getAppearance(appearanceId);
        if (!existing) throw new Error(`Unknown appearance ${appearanceId}.`);
        return normalize({
          type: 'UPDATE_APPEARANCE',
          payload: { appearanceId, updates: cloneAppearance(existing) },
        });
      }
      case 'SET_LAYER_ISOLATION': {
        return normalize({ type: 'SET_LAYER_ISOLATION', payload: { layerId: this.document.isolatedLayerId } });
      }
      case 'SET_ACTIVE_LOCATION': {
        return normalize({
          type: 'SET_ACTIVE_LOCATION',
          payload: { pageId: this.document.activePageId, artboardId: this.document.activeArtboardId },
        });
      }
      case 'BATCH': {
        const payload = operation.payload as BatchPayload;
        const inverses: OperationDescriptor[] = [];
        for (const child of payload.operations) {
          if (child.type === 'SET_REGION_FILL' || child.type === 'SET_REGION_FILL_RULE') this.refreshRegions();
          const inverse = this.createInverse(child);
          this.apply(child);
          inverses.unshift(inverse);
        }
        for (const inverse of inverses) this.apply(inverse);
        return normalize({ type: 'BATCH', payload: { label: `Undo ${payload.label}`, operations: inverses } });
      }
    }
  }

  private apply(operation: OperationDescriptor): void {
    switch (operation.type) {
      case 'ADD_NETWORK': {
        const { network, index } = operation.payload as NetworkPayload;
        this.document._addNetwork(network, index);
        break;
      }
      case 'REMOVE_NETWORK': {
        this.document._removeNetwork((operation.payload as NetworkPayload).network.id);
        break;
      }
      case 'ADD_NODE': {
        const { node, networkId, index } = operation.payload as AddNodePayload;
        this.document._addNode(node, networkId, index);
        break;
      }
      case 'REMOVE_NODE': {
        const { node, networkId } = operation.payload as RemoveNodePayload;
        this.document._removeNode(node.id, networkId);
        break;
      }
      case 'MOVE_NODE': {
        const { nodeId, delta } = operation.payload as MoveNodePayload;
        this.document._moveNode(nodeId, delta);
        break;
      }
      case 'SET_NODE_MODES': {
        for (const { nodeId, mode } of (operation.payload as SetNodeModesPayload).modes) {
          this.document._setNodeMode(nodeId, mode);
        }
        break;
      }
      case 'ADD_PATH': {
        const { path, networkId, index } = operation.payload as AddPathPayload;
        this.document._addPath(path, networkId, index);
        break;
      }
      case 'REMOVE_PATH': {
        const { path, networkId } = operation.payload as RemovePathPayload;
        this.document._removePath(path.id, networkId);
        break;
      }
      case 'ADD_SEGMENT': {
        const { segment, pathId, index } = operation.payload as AddSegmentPayload;
        this.document._addSegment(segment, pathId, index);
        break;
      }
      case 'REMOVE_SEGMENT': {
        const { segment, pathId } = operation.payload as RemoveSegmentPayload;
        this.document._removeSegment(segment.id, pathId);
        break;
      }
      case 'SET_PATH_CLOSED': {
        const { pathId, isClosed } = operation.payload as SetPathClosedPayload;
        this.document._setPathClosed(pathId, isClosed);
        break;
      }
      case 'APPLY_GRAPH_PATCH': this.applyGraphPatch(operation.payload as GraphPatch); break;
      case 'MERGE_REGIONS':
      case 'EXTRACT_REGION':
      case 'SUBTRACT_REGION': this.applyGraphPatch((operation.payload as ShapeBuilderPayload).patch); break;
      case 'SPLIT_SEGMENT': this.applySplit(operation.payload as SplitSegmentPayload); break;
      case 'RESTORE_SPLIT_SEGMENT': this.restoreSplit(operation.payload as SplitSegmentPayload); break;
      case 'CUT_PATHS': {
        for (const split of (operation.payload as CutPathsPayload).splits) this.applySplit(split);
        break;
      }
      case 'RESTORE_CUT_PATHS': {
        for (const split of [...(operation.payload as CutPathsPayload).splits].reverse()) this.restoreSplit(split);
        break;
      }
      case 'ADD_BEZIER_HANDLES': {
        const payload = operation.payload as AddBezierHandlesPayload;
        this.document._setNodeHandles(payload.nodeId, { handleIn: payload.handleIn, handleOut: payload.handleOut });
        for (const segment of this.document.connectedSegments(payload.nodeId)) {
          this.document._setSegmentType(segment.id, 'bezier');
        }
        break;
      }
      case 'CONVERT_TO_BEZIER': {
        const payload = operation.payload as ConvertToBezierPayload;
        const segment = this.requireSegment(payload.segmentId);
        this.document._setNodeHandles(segment.startNodeId, { handleOut: payload.startHandleOut });
        this.document._setNodeHandles(segment.endNodeId, { handleIn: payload.endHandleIn });
        this.document._setSegmentType(segment.id, 'bezier');
        break;
      }
      case 'ADJUST_HANDLE': {
        const payload = operation.payload as AdjustHandlePayload;
        const update = payload.handleType === 'in'
          ? { handleIn: payload.newHandle, handleOut: payload.mirroredHandle }
          : { handleOut: payload.newHandle, handleIn: payload.mirroredHandle };
        this.document._setNodeHandles(payload.nodeId, update);
        for (const segment of this.document.connectedSegments(payload.nodeId)) {
          this.document._setSegmentType(segment.id, 'bezier');
        }
        break;
      }
      case 'RESTORE_BEND_STATE': this.restoreBendState(operation.payload as BendStatePayload); break;
      case 'ADD_CONSTRAINT': {
        this.document._addConstraint((operation.payload as AddConstraintPayload).constraint);
        break;
      }
      case 'REMOVE_CONSTRAINT': {
        this.document._removeConstraint((operation.payload as RemoveConstraintPayload).constraintId);
        break;
      }
      case 'UPDATE_CONSTRAINT': {
        const { constraintId, updates } = operation.payload as UpdateConstraintPayload;
        const current = this.document.constraints.get(constraintId);
        if (!current) throw new Error(`Unknown constraint ${constraintId}.`);
        this.document._updateConstraint(constraintId, {
          ...current,
          ...updates,
          id: constraintId,
          targetIds: updates.targetIds ? [...updates.targetIds] : [...current.targetIds],
          parameters: updates.parameters ? { ...updates.parameters } : current.parameters ? { ...current.parameters } : undefined,
        });
        break;
      }
      case 'SET_NODE_POSITIONS': {
        for (const { nodeId, position } of (operation.payload as SetNodePositionsPayload).positions) {
          this.document._setNodePosition(nodeId, position);
        }
        break;
      }
      case 'SET_SEGMENT_GEOMETRIES': {
        for (const segment of (operation.payload as SetSegmentGeometriesPayload).segments) {
          this.document._setSegmentGeometry(segment.id, segment);
        }
        break;
      }
      case 'SET_SEGMENT_ROLES': {
        this.document._setSegmentRoles((operation.payload as SetSegmentRolesPayload).segments);
        break;
      }
      case 'SET_SEGMENT_WIDTH_PROFILE': {
        const { segmentId, widthProfile } = operation.payload as SetSegmentWidthProfilePayload;
        this.document._setSegmentWidthProfile(segmentId, widthProfile);
        break;
      }
      case 'ADD_PARAMETRIC_GROUP': {
        this.document._addParametricGroup((operation.payload as ParametricGroupPayload).group);
        break;
      }
      case 'REMOVE_PARAMETRIC_GROUP': {
        this.document._removeParametricGroup((operation.payload as ParametricGroupPayload).group.id);
        break;
      }
      case 'UPDATE_PARAMETRIC_GROUP': {
        const { groupId, updates } = operation.payload as UpdateParametricGroupPayload;
        const current = this.document.parametricGroups.get(groupId);
        if (!current) throw new Error(`Unknown parametric group ${groupId}.`);
        this.document._setParametricGroup(groupId, {
          ...current,
          ...updates,
          id: groupId,
          sourcePathIds: updates.sourcePathIds ? [...updates.sourcePathIds] : [...current.sourcePathIds],
          transform: updates.transform ? { ...updates.transform } : { ...current.transform },
        });
        break;
      }
      case 'ADD_EXPORT_VARIABLE': {
        this.document._addExportVariable((operation.payload as ExportVariablePayload).variable);
        break;
      }
      case 'REMOVE_EXPORT_VARIABLE': {
        this.document._removeExportVariable((operation.payload as RemoveExportVariablePayload).variableId);
        break;
      }
      case 'UPDATE_EXPORT_VARIABLE': {
        const { variableId, updates } = operation.payload as UpdateExportVariablePayload;
        const current = this.document.exportVariables.get(variableId);
        if (!current) throw new Error(`Unknown export variable ${variableId}.`);
        this.document._updateExportVariable(variableId, { ...current, ...updates, id: variableId });
        break;
      }
      case 'UPDATE_EXPORT_METADATA': {
        this.document._setExportMetadata(cloneExportMetadata(
          (operation.payload as UpdateExportMetadataPayload).metadata,
        ));
        break;
      }
      case 'ADD_APPEARANCE_RULE': {
        this.document._addAppearanceRule((operation.payload as AppearanceRulePayload).rule);
        break;
      }
      case 'REMOVE_APPEARANCE_RULE': {
        this.document._removeAppearanceRule((operation.payload as AppearanceRulePayload).rule.id);
        break;
      }
      case 'UPDATE_APPEARANCE_RULE': {
        const { ruleId, updates } = operation.payload as UpdateAppearanceRulePayload;
        const current = this.document.getAppearanceRule(ruleId);
        if (!current) throw new Error(`Unknown appearance rule ${ruleId}.`);
        this.document._setAppearanceRule(ruleId, {
          ...current,
          ...updates,
          id: ruleId,
          kind: 'appearance',
          appearance: cloneAppearanceRule({
            id: ruleId,
            name: current.name,
            kind: 'appearance',
            appearance: updates.appearance ?? current.appearance,
          }).appearance,
        });
        break;
      }
      case 'ADD_GEOMETRY_COMPONENT': {
        this.document._addGeometryComponent(
          cloneGeometryComponent((operation.payload as GeometryComponentPayload).component),
        );
        break;
      }
      case 'REMOVE_GEOMETRY_COMPONENT': {
        this.document._removeGeometryComponent(
          (operation.payload as GeometryComponentPayload).component.id,
        );
        break;
      }
      case 'UPDATE_GEOMETRY_COMPONENT': {
        const { componentId, updates } = operation.payload as UpdateGeometryComponentPayload;
        const current = this.document.getGeometryComponent(componentId);
        if (!current) throw new Error(`Unknown geometry component ${componentId}.`);
        const merged = cloneGeometryComponent({
          ...current,
          ...updates,
          id: componentId,
          kind: 'geometry',
          variants: updates.variants ?? current.variants,
        });
        this.document._setGeometryComponent(componentId, merged);
        break;
      }
      case 'SET_REGION_FILL': {
        const { regionId, fill } = operation.payload as SetRegionFillPayload;
        this.document._setRegionFill(regionId, fill);
        break;
      }
      case 'SET_REGION_FILL_RULE': {
        const { regionId, fillRule } = operation.payload as SetRegionFillRulePayload;
        this.document._setRegionFillRule(regionId, fillRule);
        break;
      }
      case 'ADD_PAGE': {
        const { page, index } = operation.payload as PagePayload;
        this.document._addPage(page, index);
        break;
      }
      case 'REMOVE_PAGE': {
        this.document._removePage((operation.payload as PagePayload).page.id);
        break;
      }
      case 'UPDATE_PAGE': {
        const { pageId, updates } = operation.payload as UpdatePagePayload;
        const current = this.document.getPage(pageId);
        if (!current) throw new Error(`Unknown page ${pageId}.`);
        this.document._setPage(pageId, {
          ...current,
          ...updates,
          id: pageId,
          artboardIds: updates.artboardIds ? [...updates.artboardIds] : [...current.artboardIds],
        });
        break;
      }
      case 'MOVE_PAGE': {
        const { pageId, index } = operation.payload as MovePagePayload;
        this.document._movePage(pageId, index);
        break;
      }
      case 'ADD_ARTBOARD': {
        const { artboard, pageId, index } = operation.payload as ArtboardPayload;
        this.document._addArtboard(artboard, pageId, index);
        break;
      }
      case 'REMOVE_ARTBOARD': {
        const { artboard, pageId } = operation.payload as ArtboardPayload;
        this.document._removeArtboard(artboard.id, pageId);
        break;
      }
      case 'UPDATE_ARTBOARD': {
        const { artboardId, updates } = operation.payload as UpdateArtboardPayload;
        const current = this.document.getArtboard(artboardId);
        if (!current) throw new Error(`Unknown artboard ${artboardId}.`);
        this.document._setArtboard(artboardId, {
          ...current,
          ...updates,
          id: artboardId,
          frame: updates.frame ? { ...updates.frame } : { ...current.frame },
          layerIds: updates.layerIds ? [...updates.layerIds] : [...current.layerIds],
        });
        break;
      }
      case 'UPDATE_ARTBOARD_DIMENSIONS': {
        const { artboardId, width, height } = operation.payload as UpdateArtboardDimensionsPayload;
        const current = this.document.getArtboard(artboardId);
        if (!current) throw new Error(`Unknown artboard ${artboardId}.`);
        this.document._setArtboard(artboardId, {
          ...current,
          frame: { ...current.frame, width, height },
        });
        break;
      }
      case 'MOVE_ARTBOARD': {
        const { artboardId, pageId, index } = operation.payload as MoveArtboardPayload;
        this.document._moveArtboard(artboardId, pageId, index);
        break;
      }
      case 'ADD_LAYER': {
        const { layer, index } = operation.payload as LayerPayload;
        this.document._addLayer(layer, index);
        break;
      }
      case 'REMOVE_LAYER': {
        this.document._removeLayer((operation.payload as LayerPayload).layer.id);
        break;
      }
      case 'UPDATE_LAYER': {
        const { layerId, updates } = operation.payload as UpdateLayerPayload;
        const current = this.document.getLayer(layerId);
        if (!current) throw new Error(`Unknown layer ${layerId}.`);
        this.document._setLayer(layerId, {
          ...current,
          ...updates,
          id: layerId,
          childIds: updates.childIds ? [...updates.childIds] : [...current.childIds],
        });
        break;
      }
      case 'MOVE_LAYER': {
        const { layerId, parentId, artboardId, index } = operation.payload as MoveLayerPayload;
        this.document._moveLayer(layerId, parentId, artboardId, index);
        break;
      }
      case 'ADD_OBJECT': {
        this.document._addObject((operation.payload as ObjectPayload).object);
        break;
      }
      case 'REMOVE_OBJECT': {
        this.document._removeObject((operation.payload as ObjectPayload).object.id);
        break;
      }
      case 'UPDATE_OBJECT': {
        const { objectId, updates } = operation.payload as UpdateObjectPayload;
        const current = this.document.getObject(objectId);
        if (!current) throw new Error(`Unknown object ${objectId}.`);
        this.document._setObject(objectId, {
          ...current,
          ...updates,
          id: objectId,
          transform: updates.transform ? { ...updates.transform } : { ...current.transform },
        });
        break;
      }
      case 'ADD_APPEARANCE': {
        this.document._addAppearance((operation.payload as AppearancePayload).appearance);
        break;
      }
      case 'REMOVE_APPEARANCE': {
        this.document._removeAppearance((operation.payload as AppearancePayload).appearance.id);
        break;
      }
      case 'UPDATE_APPEARANCE': {
        const { appearanceId, updates } = operation.payload as UpdateAppearancePayload;
        const current = this.document.getAppearance(appearanceId);
        if (!current) throw new Error(`Unknown appearance ${appearanceId}.`);
        this.document._setAppearance(appearanceId, {
          ...current,
          ...updates,
          id: appearanceId,
          fills: updates.fills ? updates.fills.map((fill) => ({ ...fill })) : current.fills.map((fill) => ({ ...fill })),
          stroke: updates.stroke
            ? { ...updates.stroke, dash: [...updates.stroke.dash] }
            : current.stroke
              ? { ...current.stroke, dash: [...current.stroke.dash] }
              : undefined,
        });
        break;
      }
      case 'SET_LAYER_ISOLATION': {
        this.document._setLayerIsolation((operation.payload as SetLayerIsolationPayload).layerId);
        break;
      }
      case 'SET_ACTIVE_LOCATION': {
        const { pageId, artboardId } = operation.payload as SetActiveLocationPayload;
        this.document._setActiveLocation(pageId, artboardId);
        break;
      }
      case 'BATCH': {
        for (const child of (operation.payload as BatchPayload).operations) {
          if (child.type === 'SET_REGION_FILL' || child.type === 'SET_REGION_FILL_RULE') this.refreshRegions();
          this.apply(child);
        }
        break;
      }
    }
  }

  private applyGraphPatch(patch: GraphPatch): void {
    for (const { segment, pathId } of patch.removeSegments) this.document._removeSegment(segment.id, pathId);
    for (const { path, networkId } of patch.removePaths) this.document._removePath(path.id, networkId);
    for (const { node, networkId } of patch.removeNodes) this.document._removeNode(node.id, networkId);
    for (const { node, networkId, index } of patch.addNodes) this.document._addNode(node, networkId, index);
    for (const { path, networkId, index } of patch.addPaths) this.document._addPath(path, networkId, index);
    for (const { segment, pathId, index } of patch.addSegments) this.document._addSegment(segment, pathId, index);
  }

  private applySplit(payload: SplitSegmentPayload): void {
    const path = this.document.getPath(payload.pathId);
    const liveIndex = path?.segmentIds.indexOf(payload.originalSegment.id) ?? payload.originalIndex;
    this.document._removeSegment(payload.originalSegment.id, payload.pathId);
    this.document._addNode(payload.newNode, payload.networkId);
    if (payload.originalSegment.type === 'bezier') {
      this.document._setNodeHandles(payload.originalSegment.startNodeId, {
        handleOut: payload.startAfter.handleOut,
      });
      this.document._setNodeHandles(payload.originalSegment.endNodeId, {
        handleIn: payload.endAfter.handleIn,
      });
    }
    this.document._addSegment(payload.newSegment1, payload.pathId, liveIndex);
    this.document._addSegment(payload.newSegment2, payload.pathId, liveIndex + 1);
  }

  private restoreSplit(payload: SplitSegmentPayload): void {
    const path = this.document.getPath(payload.pathId);
    const liveIndex = path?.segmentIds.indexOf(payload.newSegment1.id) ?? payload.originalIndex;
    this.document._removeSegment(payload.newSegment2.id, payload.pathId);
    this.document._removeSegment(payload.newSegment1.id, payload.pathId);
    if (payload.originalSegment.type === 'bezier') {
      this.document._setNodeHandles(payload.originalSegment.startNodeId, {
        handleOut: payload.startBefore.handleOut,
      });
      this.document._setNodeHandles(payload.originalSegment.endNodeId, {
        handleIn: payload.endBefore.handleIn,
      });
    }
    this.document._removeNode(payload.newNode.id, payload.networkId);
    this.document._addSegment(payload.originalSegment, payload.pathId, liveIndex);
  }

  private captureBendState(nodeIds: EntityId[], segmentIds: EntityId[]): BendStatePayload {
    return {
      nodes: [...new Set(nodeIds)].map((nodeId) => ({ nodeId, state: nodeHandleState(this.requireNode(nodeId)) })),
      segments: [...new Set(segmentIds)].map((segmentId) => ({ segmentId, type: this.requireSegment(segmentId).type })),
    };
  }

  private restoreBendState(payload: BendStatePayload): void {
    for (const item of payload.nodes) this.setHandleState(item.nodeId, item.state);
    for (const item of payload.segments) this.document._setSegmentType(item.segmentId, item.type);
  }

  private setHandleState(nodeId: EntityId, state: NodeHandleState): void {
    this.document._setNodeHandles(nodeId, {
      handleIn: state.handleIn ? { ...state.handleIn } : null,
      handleOut: state.handleOut ? { ...state.handleOut } : null,
    });
  }

  private layerIndex(layer: LayerNode): number {
    const siblings = layer.parentId
      ? this.document.getLayer(layer.parentId)?.childIds
      : this.document.getArtboard(layer.artboardId)?.layerIds;
    return Math.max(0, siblings?.indexOf(layer.id) ?? 0);
  }

  private requireNode(id: EntityId): VectorNode {
    const node = this.document.getNode(id);
    if (!node) throw new Error(`Unknown node ${id}.`);
    return node;
  }

  private requireSegment(id: EntityId): Segment {
    const segment = this.document.getSegment(id);
    if (!segment) throw new Error(`Unknown segment ${id}.`);
    return segment;
  }

  private shouldSolve(operation: OperationDescriptor): boolean {
    if (this.document.constraints.size === 0) return false;
    return operation.type !== 'ADD_NETWORK' &&
      operation.type !== 'REMOVE_NETWORK' &&
      operation.type !== 'SET_LAYER_ISOLATION' &&
      operation.type !== 'SET_NODE_MODES' &&
      operation.type !== 'SET_SEGMENT_WIDTH_PROFILE' &&
      operation.type !== 'ADD_PARAMETRIC_GROUP' &&
      operation.type !== 'REMOVE_PARAMETRIC_GROUP' &&
      operation.type !== 'UPDATE_PARAMETRIC_GROUP' &&
      operation.type !== 'ADD_EXPORT_VARIABLE' &&
      operation.type !== 'UPDATE_EXPORT_VARIABLE' &&
      operation.type !== 'REMOVE_EXPORT_VARIABLE' &&
      operation.type !== 'UPDATE_EXPORT_METADATA' &&
      operation.type !== 'ADD_APPEARANCE_RULE' &&
      operation.type !== 'REMOVE_APPEARANCE_RULE' &&
      operation.type !== 'UPDATE_APPEARANCE_RULE' &&
      operation.type !== 'SET_REGION_FILL' &&
      operation.type !== 'SET_REGION_FILL_RULE' &&
      operation.type !== 'ADD_PAGE' &&
      operation.type !== 'REMOVE_PAGE' &&
      operation.type !== 'UPDATE_PAGE' &&
      operation.type !== 'MOVE_PAGE' &&
      operation.type !== 'ADD_ARTBOARD' &&
      operation.type !== 'REMOVE_ARTBOARD' &&
      operation.type !== 'UPDATE_ARTBOARD' &&
      operation.type !== 'MOVE_ARTBOARD' &&
      operation.type !== 'ADD_LAYER' &&
      operation.type !== 'REMOVE_LAYER' &&
      operation.type !== 'UPDATE_LAYER' &&
      operation.type !== 'MOVE_LAYER' &&
      operation.type !== 'ADD_OBJECT' &&
      operation.type !== 'REMOVE_OBJECT' &&
      operation.type !== 'UPDATE_OBJECT' &&
      operation.type !== 'ADD_APPEARANCE' &&
      operation.type !== 'REMOVE_APPEARANCE' &&
      operation.type !== 'UPDATE_APPEARANCE' &&
      operation.type !== 'SET_ACTIVE_LOCATION' &&
      operation.type !== 'REMOVE_CONSTRAINT' &&
      operation.type !== 'RESTORE_BEND_STATE';
  }

  private pinnedNodeIdsFor(operation: OperationDescriptor): Set<EntityId> {
    const result = new Set<EntityId>();
    if (operation.type === 'MOVE_NODE') {
      result.add((operation.payload as MoveNodePayload).nodeId);
    } else if (operation.type === 'SET_NODE_POSITIONS') {
      for (const item of (operation.payload as SetNodePositionsPayload).positions) result.add(item.nodeId);
    } else if (operation.type === 'BATCH') {
      for (const child of (operation.payload as BatchPayload).operations) {
        for (const nodeId of this.pinnedNodeIdsFor(child)) result.add(nodeId);
      }
    }
    return result;
  }

  private capturePositions(): Map<EntityId, Point> {
    return new Map([...this.document.nodes].map(([id, node]) => [id, { ...node.position }]));
  }

  private refreshRegions(): void {
    this.document._rebuildConstraintAttachments();
    const result = detectRegionsDetailed(this.document);
    this.document._setRegions(result.regions);
    const diagnosticsKey = JSON.stringify(result.diagnostics);
    if (diagnosticsKey !== this.lastRegionDiagnosticsKey) {
      this.lastRegionDiagnosticsKey = diagnosticsKey;
      this.regionDiagnosticsListener?.(result.diagnostics);
    }
  }

  private recordTransactionOperation(operation: Operation): void {
    const items = this.transaction!.operations;
    if (operation.type === 'MOVE_NODE') {
      const nextPayload = operation.payload as MoveNodePayload;
      const existing = items.find((item) =>
        item.type === 'MOVE_NODE' && (item.payload as MoveNodePayload).nodeId === nextPayload.nodeId,
      );
      if (existing) {
        const payload = existing.payload as MoveNodePayload;
        payload.delta.x += nextPayload.delta.x;
        payload.delta.y += nextPayload.delta.y;
        const inversePayload = existing.inverse.payload as MoveNodePayload;
        inversePayload.delta.x -= nextPayload.delta.x;
        inversePayload.delta.y -= nextPayload.delta.y;
        return;
      }
    }
    if (operation.type === 'UPDATE_OBJECT') {
      const next = operation.payload as UpdateObjectPayload;
      const existing = items.find((item) =>
        item.type === 'UPDATE_OBJECT' && (item.payload as UpdateObjectPayload).objectId === next.objectId,
      );
      if (existing) {
        const payload = existing.payload as UpdateObjectPayload;
        payload.updates = {
          ...payload.updates,
          ...next.updates,
          transform: next.updates.transform ? { ...next.updates.transform } : payload.updates.transform,
        };
        return;
      }
    }
    if (operation.type === 'SET_SEGMENT_WIDTH_PROFILE') {
      const next = operation.payload as SetSegmentWidthProfilePayload;
      const existing = items.find((item) =>
        item.type === 'SET_SEGMENT_WIDTH_PROFILE' &&
        (item.payload as SetSegmentWidthProfilePayload).segmentId === next.segmentId,
      );
      if (existing) {
        (existing.payload as SetSegmentWidthProfilePayload).widthProfile =
          next.widthProfile?.map((point) => ({ ...point }));
        return;
      }
    }
    if (operation.type === 'ADJUST_HANDLE') {
      const next = operation.payload as AdjustHandlePayload;
      const existing = items.find((item) => {
        if (item.type !== 'ADJUST_HANDLE') return false;
        const payload = item.payload as AdjustHandlePayload;
        return payload.nodeId === next.nodeId && payload.handleType === next.handleType;
      });
      if (existing) {
        (existing.payload as AdjustHandlePayload).newHandle = { ...next.newHandle };
        (existing.payload as AdjustHandlePayload).mirroredHandle = next.mirroredHandle ? { ...next.mirroredHandle } : undefined;
        return;
      }
    }
    items.push(operation);
  }

  private emit(event: Omit<OperationChangeEvent, 'document'>): void {
    const complete = { ...event, document: this.document };
    for (const listener of this.listeners) listener(complete);
  }
}

export function emptyGraphPatch(): GraphPatch {
  return { addNodes: [], addPaths: [], addSegments: [], removeSegments: [], removePaths: [], removeNodes: [] };
}

export function invertGraphPatch(patch: GraphPatch): GraphPatch {
  return {
    addNodes: patch.removeNodes.map(cloneNodeEntry),
    addPaths: patch.removePaths.map((entry) => ({
      ...clonePathEntry(entry),
      path: { ...entry.path, segmentIds: [] },
    })),
    addSegments: patch.removeSegments.map(cloneSegmentEntry),
    removeSegments: patch.addSegments.map(cloneSegmentEntry),
    removePaths: patch.addPaths.map(clonePathEntry),
    removeNodes: patch.addNodes.map(cloneNodeEntry),
  };
}

export function nodeHandleState(node: VectorNode): NodeHandleState {
  return {
    handleIn: node.handleIn ? { ...node.handleIn } : null,
    handleOut: node.handleOut ? { ...node.handleOut } : null,
  };
}

function validateOperationSegmentGeometry(operation: OperationDescriptor): void {
  const validatePatch = (patch: GraphPatch) => {
    patch.addSegments.forEach(({ segment }) => validateSegmentGeometry(segment));
  };
  switch (operation.type) {
    case 'ADD_SEGMENT':
      validateSegmentGeometry((operation.payload as AddSegmentPayload).segment);
      break;
    case 'SET_SEGMENT_GEOMETRIES':
      (operation.payload as SetSegmentGeometriesPayload).segments.forEach(validateSegmentGeometry);
      break;
    case 'APPLY_GRAPH_PATCH':
      validatePatch(operation.payload as GraphPatch);
      break;
    case 'MERGE_REGIONS':
    case 'EXTRACT_REGION':
    case 'SUBTRACT_REGION':
      validatePatch((operation.payload as ShapeBuilderPayload).patch);
      break;
    case 'SPLIT_SEGMENT': {
      const payload = operation.payload as SplitSegmentPayload;
      validateSegmentGeometry(payload.newSegment1);
      validateSegmentGeometry(payload.newSegment2);
      break;
    }
    case 'RESTORE_SPLIT_SEGMENT':
      validateSegmentGeometry((operation.payload as SplitSegmentPayload).originalSegment);
      break;
    case 'CUT_PATHS':
      (operation.payload as CutPathsPayload).splits.forEach((split) => {
        validateSegmentGeometry(split.newSegment1);
        validateSegmentGeometry(split.newSegment2);
      });
      break;
    case 'RESTORE_CUT_PATHS':
      (operation.payload as CutPathsPayload).splits.forEach((split) => validateSegmentGeometry(split.originalSegment));
      break;
    case 'BATCH':
      (operation.payload as BatchPayload).operations.forEach(validateOperationSegmentGeometry);
      break;
  }
}

function validateSegmentRoleAndConstructionOperations(
  document: VectorDocument,
  operation: OperationDescriptor,
): void {
  const rejectConstructionBend = (segmentIds: Iterable<EntityId>) => {
    for (const segmentId of segmentIds) {
      if (document.getSegment(segmentId)?.role === 'construction') {
        throw new Error('Bend is unavailable for construction segments.');
      }
    }
  };
  switch (operation.type) {
    case 'SET_SEGMENT_ROLES': {
      const payload = operation.payload as SetSegmentRolesPayload;
      if (payload.segments.length === 0) throw new Error('Segment role update requires at least one segment.');
      const ids = new Set<EntityId>();
      for (const update of payload.segments) {
        if (ids.has(update.segmentId)) throw new Error(`Segment role update repeats ${update.segmentId}.`);
        ids.add(update.segmentId);
        const current = document.getSegment(update.segmentId);
        if (!current) throw new Error(`Unknown segment ${update.segmentId}.`);
        const replacement: Segment = {
          ...current,
          role: update.role,
          constructionExtent: update.role === 'construction' ? update.constructionExtent : undefined,
        };
        validateSegmentGeometry(replacement);
        if (replacement.role === 'construction') {
          const start = document.getNode(replacement.startNodeId);
          const end = document.getNode(replacement.endNodeId);
          if (!start || !end || Math.hypot(
            end.position.x - start.position.x,
            end.position.y - start.position.y,
          ) < 1e-6) {
            throw new Error(`Construction segment ${replacement.id} requires two distinct anchor nodes.`);
          }
          const path = document.findPathForSegment(replacement.id);
          if (path && [...document.parametricGroups.values()].some((group) => group.sourcePathIds.includes(path.id))) {
            throw new Error('Construction paths cannot be used as Parametric Group sources.');
          }
        }
      }
      break;
    }
    case 'SPLIT_SEGMENT':
      validateSplitConstruction(operation.payload as SplitSegmentPayload);
      break;
    case 'CUT_PATHS':
      (operation.payload as CutPathsPayload).splits.forEach(validateSplitConstruction);
      break;
    case 'ADD_BEZIER_HANDLES': {
      const nodeId = (operation.payload as AddBezierHandlesPayload).nodeId;
      rejectConstructionBend(document.connectedSegments(nodeId).map((segment) => segment.id));
      break;
    }
    case 'CONVERT_TO_BEZIER':
      rejectConstructionBend([(operation.payload as ConvertToBezierPayload).segmentId]);
      break;
    case 'ADJUST_HANDLE': {
      const nodeId = (operation.payload as AdjustHandlePayload).nodeId;
      rejectConstructionBend(document.connectedSegments(nodeId).map((segment) => segment.id));
      break;
    }
    case 'RESTORE_BEND_STATE': {
      const payload = operation.payload as BendStatePayload;
      for (const item of payload.segments) {
        if (document.getSegment(item.segmentId)?.role === 'construction' && item.type !== 'line') {
          throw new Error('Bend is unavailable for construction segments.');
        }
      }
      break;
    }
    case 'SET_SEGMENT_WIDTH_PROFILE': {
      const segmentId = (operation.payload as SetSegmentWidthProfilePayload).segmentId;
      if (document.getSegment(segmentId)?.role === 'construction') {
        throw new Error('Variable Width is unavailable for construction segments.');
      }
      break;
    }
    case 'ADD_PARAMETRIC_GROUP':
      assertValidParametricGroup(document, (operation.payload as ParametricGroupPayload).group);
      break;
    case 'UPDATE_PARAMETRIC_GROUP': {
      const payload = operation.payload as UpdateParametricGroupPayload;
      const current = document.parametricGroups.get(payload.groupId);
      if (!current) throw new Error(`Unknown parametric group ${payload.groupId}.`);
      assertValidParametricGroup(document, {
        ...current,
        ...payload.updates,
        id: current.id,
        sourcePathIds: payload.updates.sourcePathIds ?? current.sourcePathIds,
        transform: payload.updates.transform ?? current.transform,
      });
      break;
    }
    case 'BATCH':
      (operation.payload as BatchPayload).operations.forEach((child) =>
        validateSegmentRoleAndConstructionOperations(document, child));
      break;
  }
}

function validateSplitConstruction(payload: SplitSegmentPayload): void {
  if (payload.originalSegment.role === 'construction' && payload.originalSegment.constructionExtent === 'infinite') {
    throw new Error('Infinite construction lines cannot be split.');
  }
  for (const segment of [payload.newSegment1, payload.newSegment2]) {
    if (segment.role !== payload.originalSegment.role ||
      segment.constructionExtent !== payload.originalSegment.constructionExtent) {
      throw new Error('Split segments must preserve their source role and construction extent.');
    }
  }
}

function validateParametricReferenceGeometry(
  document: VectorDocument,
  operation: OperationDescriptor,
): void {
  if (operation.type === 'BATCH') {
    (operation.payload as BatchPayload).operations
      .forEach((child) => validateParametricReferenceGeometry(document, child));
    return;
  }
  const positions = new Map<EntityId, Point>();
  if (operation.type === 'MOVE_NODE') {
    const { nodeId, delta } = operation.payload as MoveNodePayload;
    const current = document.getNode(nodeId)?.position;
    if (current) positions.set(nodeId, { x: current.x + delta.x, y: current.y + delta.y });
  } else if (operation.type === 'SET_NODE_POSITIONS') {
    for (const update of (operation.payload as SetNodePositionsPayload).positions) {
      positions.set(update.nodeId, update.position);
    }
  }
  if (positions.size === 0) return;
  for (const group of document.parametricGroups.values()) {
    if (group.transform.type !== 'mirror' || !group.transform.axisSegmentId) continue;
    const segment = document.getSegment(group.transform.axisSegmentId);
    if (!segment || (!positions.has(segment.startNodeId) && !positions.has(segment.endNodeId))) continue;
    const start = positions.get(segment.startNodeId) ?? document.getNode(segment.startNodeId)?.position;
    const end = positions.get(segment.endNodeId) ?? document.getNode(segment.endNodeId)?.position;
    if (!start || !end || !Number.isFinite(start.x) || !Number.isFinite(start.y) ||
      !Number.isFinite(end.x) || !Number.isFinite(end.y) ||
      Math.hypot(end.x - start.x, end.y - start.y) < 1e-9) {
      throw new Error('Referenced mirror axes must remain finite and non-degenerate.');
    }
  }
}

function validateParametricReferenceRemoval(
  document: VectorDocument,
  operation: OperationDescriptor,
  allowedRemovedGroupIds = new Set<EntityId>(),
): void {
  if (operation.type === 'BATCH') {
    const children = (operation.payload as BatchPayload).operations;
    const removed = new Set(allowedRemovedGroupIds);
    for (const child of children) {
      if (child.type === 'REMOVE_PARAMETRIC_GROUP') {
        removed.add((child.payload as ParametricGroupPayload).group.id);
      }
    }
    children.forEach((child) => validateParametricReferenceRemoval(document, child, removed));
    return;
  }
  const segmentIds = new Set<EntityId>();
  const nodeIds = new Set<EntityId>();
  const pathIds = new Set<EntityId>();
  const includeNetwork = (networkId: EntityId) => {
    const network = document.getNetwork(networkId);
    if (!network) return;
    network.nodeIds.forEach((id) => nodeIds.add(id));
    network.pathIds.forEach((pathId) => {
      pathIds.add(pathId);
      document.getPath(pathId)?.segmentIds.forEach((id) => segmentIds.add(id));
    });
  };
  if (operation.type === 'REMOVE_SEGMENT') {
    segmentIds.add((operation.payload as RemoveSegmentPayload).segment.id);
  } else if (operation.type === 'REMOVE_NODE') {
    nodeIds.add((operation.payload as RemoveNodePayload).node.id);
  } else if (operation.type === 'REMOVE_PATH') {
    pathIds.add((operation.payload as RemovePathPayload).path.id);
  } else if (operation.type === 'REMOVE_NETWORK') {
    includeNetwork((operation.payload as NetworkPayload).network.id);
  } else if (operation.type === 'REMOVE_OBJECT') {
    includeNetwork((operation.payload as ObjectPayload).object.networkId);
  } else if (operation.type === 'APPLY_GRAPH_PATCH' || operation.type === 'MERGE_REGIONS' ||
    operation.type === 'EXTRACT_REGION' || operation.type === 'SUBTRACT_REGION') {
    const patch = operation.type === 'APPLY_GRAPH_PATCH'
      ? operation.payload as GraphPatch
      : (operation.payload as ShapeBuilderPayload).patch;
    patch.removeSegments.forEach((item) => segmentIds.add(item.segment.id));
    patch.removeNodes.forEach((item) => nodeIds.add(item.node.id));
    patch.removePaths.forEach((item) => pathIds.add(item.path.id));
  } else if (operation.type === 'SPLIT_SEGMENT') {
    segmentIds.add((operation.payload as SplitSegmentPayload).originalSegment.id);
  } else if (operation.type === 'CUT_PATHS') {
    (operation.payload as CutPathsPayload).splits.forEach((item) => segmentIds.add(item.originalSegment.id));
  } else if (operation.type === 'SET_SEGMENT_ROLES') {
    for (const update of (operation.payload as SetSegmentRolesPayload).segments) {
      if (update.role !== 'construction') segmentIds.add(update.segmentId);
    }
  }
  if (segmentIds.size === 0 && nodeIds.size === 0 && pathIds.size === 0) return;
  for (const group of document.parametricGroups.values()) {
    if (allowedRemovedGroupIds.has(group.id)) continue;
    if (group.sourcePathIds.some((pathId) => pathIds.has(pathId))) {
      throw new Error('Parametric Group source paths are in use; remove the group before deleting their owner.');
    }
    if (group.transform.type === 'mirror' && group.transform.axisSegmentId &&
      segmentIds.has(group.transform.axisSegmentId)) {
      throw new Error(`Mirror reference ${group.transform.axisSegmentId} is in use; retarget or remove its Parametric Group first.`);
    }
    if (group.transform.type === 'radial' && group.transform.centerNodeId &&
      nodeIds.has(group.transform.centerNodeId)) {
      throw new Error(`Radial center reference ${group.transform.centerNodeId} is in use; retarget or remove its Parametric Group first.`);
    }
  }
}

function validateShapeBuilderOperation(document: VectorDocument, operation: OperationDescriptor): void {
  if (operation.type === 'MERGE_REGIONS' || operation.type === 'EXTRACT_REGION' || operation.type === 'SUBTRACT_REGION') {
    validateShapeBuilderOwnership(document, operation.payload as ShapeBuilderPayload);
  } else if (operation.type === 'BATCH') {
    (operation.payload as BatchPayload).operations.forEach((child) => validateShapeBuilderOperation(document, child));
  }
}

function validateShapeBuilderOwnership(document: VectorDocument, payload: ShapeBuilderPayload): void {
  if (!document.getNetwork(payload.networkId)) {
    throw new Error(`Shape Builder target network ${payload.networkId} does not exist.`);
  }
  const regionIds = new Set(payload.regionIds);
  if (payload.regionId) regionIds.add(payload.regionId);
  for (const regionId of regionIds) {
    const region = document.regions.find((item) => item.id === regionId);
    if (!region) throw new Error(`Shape Builder region ${regionId} does not exist.`);
    for (const segmentId of region.boundarySegmentIds) {
      const segment = document.getSegment(segmentId);
      if (!segment || segment.role === 'construction') {
        throw new Error('Shape Builder requires geometry-only regions.');
      }
      const path = document.findPathForSegment(segmentId);
      const network = path ? document.findNetworkForPath(path.id) : undefined;
      if (!network || network.id !== payload.networkId) {
        throw new Error('Shape Builder requires regions from a single network.');
      }
    }
  }
  const addedNetworkIds = new Set([
    ...payload.patch.addNodes.map((entry) => entry.networkId),
    ...payload.patch.addPaths.map((entry) => entry.networkId),
  ]);
  if ([...addedNetworkIds].some((networkId) => networkId !== payload.networkId)) {
    throw new Error('Shape Builder output must be added to its resolved source network.');
  }
  for (const entry of payload.patch.removePaths) {
    if (entry.networkId !== payload.networkId) {
      throw new Error('Shape Builder cannot replace output from another network.');
    }
  }
}

function normalize<T>(input: OperationInput<T>): OperationDescriptor<T> {
  return {
    id: input.id ?? createEntityId(),
    type: input.type,
    timestamp: input.timestamp ?? Date.now(),
    payload: input.payload,
  };
}

function stripInverse(operation: Operation): OperationDescriptor {
  return { id: operation.id, type: operation.type, timestamp: operation.timestamp, payload: operation.payload };
}

function cloneNodeEntry<T extends AddNodePayload | RemoveNodePayload>(entry: T): T {
  return { ...entry, node: cloneNode(entry.node) } as T;
}

function clonePathEntry<T extends AddPathPayload | RemovePathPayload>(entry: T): T {
  return { ...entry, path: { ...entry.path, segmentIds: [...entry.path.segmentIds] } } as T;
}

function cloneSegmentEntry<T extends AddSegmentPayload | RemoveSegmentPayload>(entry: T): T {
  return { ...entry, segment: cloneSegment(entry.segment) } as T;
}

function cloneSegment(segment: Segment): Segment {
  return {
    ...segment,
    center: segment.center ? { ...segment.center } : undefined,
    widthProfile: segment.widthProfile?.map((point) => ({ ...point })),
  };
}

function segmentGeometryEqual(a: Segment, b: Segment): boolean {
  return a.type === b.type &&
    a.startNodeId === b.startNodeId &&
    a.endNodeId === b.endNodeId &&
    (a.center?.x ?? null) === (b.center?.x ?? null) &&
    (a.center?.y ?? null) === (b.center?.y ?? null) &&
    (a.radius ?? null) === (b.radius ?? null) &&
    (a.startAngle ?? null) === (b.startAngle ?? null) &&
    (a.endAngle ?? null) === (b.endAngle ?? null) &&
    (a.clockwise ?? null) === (b.clockwise ?? null);
}

function cloneParametricGroup(group: ParametricGroup): ParametricGroup {
  return {
    ...group,
    sourcePathIds: [...group.sourcePathIds],
    transform: group.transform.type === 'mirror'
      ? { ...group.transform, origin: { ...group.transform.origin } }
      : { ...group.transform, center: { ...group.transform.center } },
  };
}

function cloneConstraint(constraint: Constraint): Constraint {
  return {
    ...constraint,
    targetIds: [...constraint.targetIds],
    parameters: constraint.parameters ? { ...constraint.parameters } : undefined,
  };
}

function cloneNode(node: VectorNode): VectorNode {
  return {
    ...node,
    position: { ...node.position },
    handleIn: node.handleIn ? { ...node.handleIn } : undefined,
    handleOut: node.handleOut ? { ...node.handleOut } : undefined,
    constraintIds: [...node.constraintIds],
  };
}

function cloneExportMetadata(metadata: DocumentExportMetadata): DocumentExportMetadata {
  const cloneSettings = (settings: NonNullable<DocumentExportMetadata['lastUsed']>) => ({
    ...settings,
    formats: [...settings.formats],
    pngScales: [...settings.pngScales],
    customSize: settings.customSize ? { ...settings.customSize } : undefined,
  });
  return {
    lastUsed: metadata.lastUsed ? cloneSettings(metadata.lastUsed) : undefined,
    presets: metadata.presets.map((preset) => ({ ...preset, settings: cloneSettings(preset.settings) })),
  };
}

function clonePage(page: DocumentPage): DocumentPage {
  return { ...page, artboardIds: [...page.artboardIds] };
}

function cloneArtboard(artboard: Artboard): Artboard {
  return { ...artboard, frame: { ...artboard.frame }, layerIds: [...artboard.layerIds] };
}

function cloneLayer(layer: LayerNode): LayerNode {
  return { ...layer, childIds: [...layer.childIds] };
}

function cloneObject(object: NetworkObject): NetworkObject {
  return { ...object, transform: { ...object.transform } };
}

function cloneAppearance(appearance: Appearance): Appearance {
  return {
    ...appearance,
    fills: appearance.fills.map((fill) => ({ ...fill })),
    stroke: appearance.stroke ? { ...appearance.stroke, dash: [...appearance.stroke.dash] } : undefined,
  };
}

function cloneAppearanceRule(rule: AppearanceRule): AppearanceRule {
  return {
    ...rule,
    appearance: {
      fills: rule.appearance.fills.map((fill) => ({ ...fill })),
      stroke: rule.appearance.stroke
        ? { ...rule.appearance.stroke, dash: [...rule.appearance.stroke.dash] }
        : undefined,
      opacity: rule.appearance.opacity,
    },
  };
}

function cloneGeometryComponent(component: GeometryComponent): GeometryComponent {
  return {
    ...component,
    variants: component.variants.map((variant) => ({
      ...variant,
      nodeMap: { ...variant.nodeMap },
      segmentMap: { ...variant.segmentMap },
      pathMap: { ...variant.pathMap },
      overriddenNodeIds: [...variant.overriddenNodeIds],
      overriddenSegmentIds: [...variant.overriddenSegmentIds],
      omittedSourceNodeIds: [...(variant.omittedSourceNodeIds ?? [])],
      omittedSourceSegmentIds: [...(variant.omittedSourceSegmentIds ?? [])],
      omittedSourcePathIds: [...(variant.omittedSourcePathIds ?? [])],
      localNodeIds: [...(variant.localNodeIds ?? [])],
      localSegmentIds: [...(variant.localSegmentIds ?? [])],
      localPathIds: [...(variant.localPathIds ?? [])],
    })),
    lastQa: component.lastQa
      ? { ...component.lastQa, appliedFixes: [...component.lastQa.appliedFixes] }
      : undefined,
  };
}
