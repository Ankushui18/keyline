export type EntityId = string;

export interface Point {
  x: number;
  y: number;
}

/** Bézier handles use absolute document-space coordinates. */
export interface BezierHandle extends Point {}

export interface VectorNode {
  id: EntityId;
  position: Point;
  handleIn?: BezierHandle;
  handleOut?: BezierHandle;
  /** Persistent handle behavior for corner, smooth, and symmetric nodes. */
  handleMode?: 'corner' | 'smooth' | 'symmetric';
  constraintIds: EntityId[];
}

export type SegmentType = 'line' | 'bezier' | 'arc';
export type SegmentRole = 'geometry' | 'construction';
export type ConstructionExtent = 'finite' | 'infinite';

export interface WidthPoint {
  id: EntityId;
  t: number;
  width: number;
}

export interface Segment {
  id: EntityId;
  startNodeId: EntityId;
  endNodeId: EntityId;
  type: SegmentType;
  /** Semantic graph role. Renderer artifacts never own this state. */
  role: SegmentRole;
  /** Required only for straight construction segments. */
  constructionExtent?: ConstructionExtent;
  widthProfile?: WidthPoint[];
  /** Native circular-arc data; required when type is 'arc'. */
  center?: Point;
  radius?: number;
  startAngle?: number;
  endAngle?: number;
  clockwise?: boolean;
}

export interface ArcSegment extends Segment {
  type: 'arc';
  role: 'geometry';
  constructionExtent?: never;
  center: Point;
  radius: number;
  startAngle: number;
  endAngle: number;
  clockwise: boolean;
}

export interface ConstructionLineSegment extends Segment {
  type: 'line';
  role: 'construction';
  constructionExtent: ConstructionExtent;
  widthProfile?: never;
  center?: never;
  radius?: never;
  startAngle?: never;
  endAngle?: never;
  clockwise?: never;
}

/** Persistence accepts legacy segments without role metadata; runtime segments do not. */
export type StoredSegment = Omit<Segment, 'role' | 'constructionExtent'> & {
  role?: SegmentRole;
  constructionExtent?: ConstructionExtent;
};

export interface VectorPath {
  id: EntityId;
  segmentIds: EntityId[];
  isClosed: boolean;
}

export interface VectorNetwork {
  id: EntityId;
  nodeIds: EntityId[];
  pathIds: EntityId[];
}

export type ParametricTransform =
  | {
      type: 'mirror';
      /** Legacy cardinal-axis preset retained for v1–v6 snapshots and quick creation. */
      axis: 'x' | 'y';
      /** Source-network-local fallback used when no live reference is assigned. */
      origin: Point;
      /** Arbitrary fallback axis angle in degrees; defaults from axis. */
      angle?: number;
      /** Stable construction segment reference. Live graph geometry overrides origin/angle. */
      axisSegmentId?: EntityId;
    }
  | {
      type: 'radial';
      /** Source-network-local fallback used when no live reference is assigned. */
      center: Point;
      count: number;
      sweepAngle: number;
      startAngle?: number;
      clockwise?: boolean;
      /** Stable node reference; construction anchors are preferred by Gate D UI. */
      centerNodeId?: EntityId;
    };

export interface ParametricGroup {
  id: EntityId;
  sourcePathIds: EntityId[];
  transform: ParametricTransform;
}

export type ExportVariableBinding = 'strokeWidth' | 'fillColor' | 'scale' | 'opacity';

export interface ExportVariable {
  id: EntityId;
  name: string;
  label: string;
  type: 'number' | 'color';
  binding: ExportVariableBinding;
  value: number | string;
  min?: number;
  max?: number;
}

export type DeliveryExportFormat = 'svg' | 'png';
export type DeliveryPngScale = 1 | 2 | 3;
export type DeliveryExportBoundsMode = 'artboard' | 'artwork';

/** Persisted production-delivery choices. Artboard selection stays session-local. */
export interface ExportDeliverySettings {
  boundsMode: DeliveryExportBoundsMode;
  includeBackground: boolean;
  formats: DeliveryExportFormat[];
  pngScales: DeliveryPngScale[];
  customSize?: { width: number; height: number };
  namingPattern: string;
  /** Adds a human-readable family QA/change report to ZIP delivery. */
  includeManifest?: boolean;
}

export interface ExportPreset {
  id: EntityId;
  name: string;
  settings: ExportDeliverySettings;
}

export interface DocumentExportMetadata {
  lastUsed?: ExportDeliverySettings;
  presets: ExportPreset[];
}

export interface FillStyle {
  /** Gate C deliberately narrows live region Paint to the renderer-complete solid model. */
  type: 'solid';
  color: string;
}

export type FillRule = 'nonzero' | 'evenodd';

/** Persistent, object-level appearance. Region fills remain stable topology-bound overrides. */
export interface AppearanceFill {
  type: 'solid';
  color: string;
  opacity: number;
  visible: boolean;
}

export interface StrokeStyle {
  color: string;
  width: number;
  cap: 'butt' | 'round' | 'square';
  join: 'miter' | 'round' | 'bevel';
  alignment: 'center' | 'inside' | 'outside';
  opacity: number;
  dash: number[];
  visible: boolean;
}

export interface Appearance {
  id: EntityId;
  fills: AppearanceFill[];
  stroke?: StrokeStyle;
  opacity: number;
}

/** A named, reusable appearance contract for an asset family. Linked objects
 * retain independent geometry and appearance entities while inheriting these
 * values through transactional rule propagation. */
export interface AppearanceRule {
  id: EntityId;
  name: string;
  kind: 'appearance';
  appearance: Omit<Appearance, 'id'>;
}

/** Stable source-to-variant topology mapping. Overrides use source IDs so they
 * survive ordinary variant edits and remain meaningful during propagation. */
export interface GeometryVariantLink {
  id: EntityId;
  objectId: EntityId;
  nodeMap: Record<EntityId, EntityId>;
  segmentMap: Record<EntityId, EntityId>;
  pathMap: Record<EntityId, EntityId>;
  /** Overrides are source IDs so they remain understandable across syncs. */
  overriddenNodeIds: EntityId[];
  overriddenSegmentIds: EntityId[];
  /** Source topology intentionally omitted by this variant. */
  omittedSourceNodeIds?: EntityId[];
  omittedSourceSegmentIds?: EntityId[];
  omittedSourcePathIds?: EntityId[];
  /** Variant-only topology intentionally retained as a local branch. */
  localNodeIds?: EntityId[];
  localSegmentIds?: EntityId[];
  localPathIds?: EntityId[];
  createdAt?: number;
  lastSyncedAt?: number;
}

export interface GeometryComponent {
  id: EntityId;
  name: string;
  kind?: 'geometry';
  sourceObjectId: EntityId;
  variants: GeometryVariantLink[];
  createdAt?: number;
  lastQa?: {
    checkedAt: number;
    appliedFixes: string[];
    remainingIssueCount: number;
  };
}

/** Persistent user-facing style applied by Pen and Pencil while drawing. */
export interface DrawingStyle {
  strokeEnabled: boolean;
  strokeColor: string;
  strokeWidth: number;
  strokeCap: StrokeStyle['cap'];
  strokeJoin: StrokeStyle['join'];
  strokeAlignment: StrokeStyle['alignment'];
  fillEnabled: boolean;
  fillColor: string;
}

/** Non-destructive object transform; geometry and constraint coordinates stay network-local. */
export interface ObjectTransform {
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
}

export interface NetworkObject {
  id: EntityId;
  name: string;
  networkId: EntityId;
  appearanceId: EntityId;
  /** Optional shared family style. Geometry always remains independently editable. */
  appearanceRuleId?: EntityId;
  transform: ObjectTransform;
}

export type LayerNodeKind = 'layer' | 'group' | 'object';

export interface LayerNode {
  id: EntityId;
  kind: LayerNodeKind;
  name: string;
  artboardId: EntityId;
  parentId?: EntityId;
  childIds: EntityId[];
  objectId?: EntityId;
  visible: boolean;
  locked: boolean;
  expanded: boolean;
}

export interface Artboard {
  id: EntityId;
  pageId: EntityId;
  name: string;
  frame: { x: number; y: number; width: number; height: number };
  layerIds: EntityId[];
  background: string;
  clipContent: boolean;
  /** Internal page-level pasteboard container; not rendered or exported as a frame. */
  isCanvasRoot?: boolean;
}

export interface DocumentPage {
  id: EntityId;
  name: string;
  artboardIds: EntityId[];
}

export interface RegionBoundaryEdge {
  segmentId: EntityId;
  /** Parameter range on the source segment; tStart is always <= tEnd. */
  tStart: number;
  tEnd: number;
  reversed: boolean;
  start: Point;
  end: Point;
}

export interface RegionBoundaryLoop {
  boundarySegmentIds: EntityId[];
  boundaryEdges: RegionBoundaryEdge[];
  outline: Point[];
  /** Signed in canvas coordinates: positive is clockwise, negative counter-clockwise. */
  signedArea: number;
}

export interface Region {
  id: EntityId;
  /** All outer and inner boundary segment IDs, retained for ownership and visibility policy. */
  boundarySegmentIds: EntityId[];
  fill?: FillStyle;
  /** Explicit region-level winding semantics shared by Canvas, WebGL, hit testing, and SVG. */
  fillRule: FillRule;
  /** The positively oriented containing ring. */
  outerLoop: RegionBoundaryLoop;
  /** Immediate nested rings, oriented opposite the outer ring. */
  innerLoops: RegionBoundaryLoop[];
  /**
   * Compatibility projections for existing topology tools. boundaryEdges contains
   * every loop while outline aliases outerLoop.outline.
   */
  boundaryEdges?: RegionBoundaryEdge[];
  outline?: Point[];
  /** Net fillable area: outer ring minus immediate holes. */
  area?: number;
}

export type ConstraintType =
  | 'parallel'
  | 'perpendicular'
  | 'tangent'
  | 'symmetric'
  | 'equal_length'
  | 'fixed_distance'
  | 'fixed_angle'
  | 'fixed_radius'
  | 'horizontal'
  | 'vertical'
  | 'coincident';

export type ConstraintPriority = 'hard' | 'medium' | 'soft';

export interface Constraint {
  id: EntityId;
  type: ConstraintType;
  priority: ConstraintPriority;
  targetIds: EntityId[];
  parameters?: Record<string, number>;
  tolerance: number;
}

export interface ConstraintConflict {
  constraintIds: EntityId[];
  message: string;
  error: number;
  suggestion: string;
}

export interface ConstraintSolveResult {
  success: boolean;
  adjustedNodes: Map<EntityId, Point>;
  adjustedSegments?: Map<EntityId, Segment>;
  error: number;
  iterations: number;
  conflicts: ConstraintConflict[];
}

export interface VectorDocumentData {
  id: EntityId;
  networks: VectorNetwork[];
  nodes: Map<EntityId, VectorNode>;
  segments: Map<EntityId, Segment>;
  paths: Map<EntityId, VectorPath>;
  regions: Region[];
  constraints: Map<EntityId, Constraint>;
  parametricGroups: Map<EntityId, ParametricGroup>;
  exportVariables: Map<EntityId, ExportVariable>;
  exportMetadata: DocumentExportMetadata;
  appearanceRules: Map<EntityId, AppearanceRule>;
  geometryComponents: Map<EntityId, GeometryComponent>;
  variables: Map<string, number>;
  pages: DocumentPage[];
  artboards: Map<EntityId, Artboard>;
  layers: Map<EntityId, LayerNode>;
  objects: Map<EntityId, NetworkObject>;
  appearances: Map<EntityId, Appearance>;
  activePageId: EntityId;
  activeArtboardId: EntityId;
}

/** Array-based representation used at persistence, collaboration, and worker boundaries. */
export interface DocumentSnapshot {
  version: 1 | 2 | 3 | 4 | 5 | 6;
  id: EntityId;
  networks: VectorNetwork[];
  nodes: Array<[EntityId, VectorNode]>;
  segments: Array<[EntityId, StoredSegment]>;
  paths: Array<[EntityId, VectorPath]>;
  regions: Region[];
  constraints?: Array<[EntityId, Constraint]>;
  parametricGroups?: Array<[EntityId, ParametricGroup]>;
  exportVariables?: Array<[EntityId, ExportVariable]>;
  exportMetadata?: DocumentExportMetadata;
  /** Optional in v6 so existing project and collaboration snapshots remain loadable. */
  appearanceRules?: Array<[EntityId, AppearanceRule]>;
  /** Optional family-geometry relationships added without invalidating v6 files. */
  geometryComponents?: Array<[EntityId, GeometryComponent]>;
  variables: Array<[string, number]>;
  /** Required in v5. Optional here so v1–4 snapshots remain directly loadable. */
  pages?: DocumentPage[];
  artboards?: Array<[EntityId, Artboard]>;
  layers?: Array<[EntityId, LayerNode]>;
  objects?: Array<[EntityId, NetworkObject]>;
  appearances?: Array<[EntityId, Appearance]>;
  activePageId?: EntityId;
  activeArtboardId?: EntityId;
}

export type SelectionMode = 'object' | 'network';

export interface SelectionState {
  mode: SelectionMode;
  objectIds: Set<EntityId>;
  /** The object whose local network is being edited when mode is 'network'. */
  editingObjectId?: EntityId;
  nodeIds: Set<EntityId>;
  segmentIds: Set<EntityId>;
}

export type ToolId =
  | 'select'
  | 'pen'
  | 'pencil'
  | 'brush'
  | 'rectangle'
  | 'rounded-rectangle'
  | 'ellipse'
  | 'polygon'
  | 'star'
  | 'line'
  | 'construction-line'
  | 'arc'
  | 'shape-builder'
  | 'cut'
  | 'bend'
  | 'fillet'
  | 'paint'
  | 'width'
  | 'offset'
  | 'lasso'
  | 'eraser';

export type HandleMirrorMode = 'independent' | 'angle' | 'mirror';
