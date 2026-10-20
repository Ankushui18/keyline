import { subscribePixelGrid } from './view-settings';
import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { ArrowBothIcon } from '@primer/octicons-react/ArrowBothIcon';
import { CursorIcon } from '@primer/octicons-react/CursorIcon';
import { DuplicateIcon } from '@primer/octicons-react/DuplicateIcon';
import { IterationsIcon } from '@primer/octicons-react/IterationsIcon';
import { MultiSelectIcon } from '@primer/octicons-react/MultiSelectIcon';
import { PaintbrushIcon } from '@primer/octicons-react/PaintbrushIcon';
import { PencilIcon } from '@primer/octicons-react/PencilIcon';
import { SquareIcon } from '@primer/octicons-react/SquareIcon';
import { CircleIcon } from '@primer/octicons-react/CircleIcon';
import { CircleSlashIcon } from '@primer/octicons-react/CircleSlashIcon';
import { DashIcon } from '@primer/octicons-react/DashIcon';
import { DiamondIcon } from '@primer/octicons-react/DiamondIcon';
import { StarIcon } from '@primer/octicons-react/StarIcon';
import { SquareFillIcon } from '@primer/octicons-react/SquareFillIcon';
import { StackAddIcon } from '@primer/octicons-react/StackAddIcon';
import { UnlinkIcon } from '@primer/octicons-react/UnlinkIcon';
import type { CollaboratorPresence } from '../collaboration/session';
import type { VectorDocument } from '../core/document';
import type { OperationInput, OperationManager } from '../core/operations';
import type { Artboard, ConstructionExtent, DrawingStyle, EntityId, HandleMirrorMode, NetworkObject, Point, SelectionState, ToolId } from '../core/types';
import { PenTool } from '../tools/pen-tool';
import { preparePencilObject } from '../tools/pencil-tool';
import { prepareBrushObject, type BrushSample } from '../tools/brush-tool';
import {
  enterNetworkEditMode,
  exitNetworkEditMode,
  hitTest,
  hitTestObject,
  hitTestSegment,
  selectionForHit,
  selectionForObjectHit,
} from '../tools/select-tool';
import { buildShapeBuilderResult, regionAtPoint } from '../tools/shape-builder';
import { prepareCutPaths, prepareSplitAtPoint, prepareSplitSegment } from '../tools/cut-tool';
import { addWidthPoint, hitTestWidthHandle, updateWidthPoint, type WidthHandle } from '../tools/width-tool';
import { localEraseSpan, prepareEraseSegment } from '../tools/eraser-tool';
import { preparePrimitiveObject, type PrimitiveKind } from '../tools/primitive-tool';
import { snapPoint, type SnapResult } from '../tools/snapping';
import {
  addHandlesFromDrag,
  adjustHandlePayload,
  canDirectBendSegment,
  convertSegmentFromDrag,
  defaultHandlesForNode,
  hitTestHandle,
  type HandleHit,
} from '../tools/bend-tool';
import { closestPointOnSegment, pointInPolygon, segmentCurve } from '../core/geometry';
import { INTERACTION_BOUNDS_POLICY, objectBounds } from '../core/object-geometry';
import { prepareDuplicateArtboard } from '../core/artboard-operations';
import { prepareDuplicateObject } from '../core/object-operations';
import { parametricSourceObjectId, resolveParametricTransform } from '../core/parametric';
import { inverseMatrix, matrixScale, objectTransformMatrix, transformPoint } from '../core/transforms';
import {
  renderVectorScene,
  type BendPreview,
  type ConstructionLinePreview,
  type FreehandPreview,
  type MarqueePreview,
  type EraserPreview,
  type PenPreview,
  type PrimitivePreview,
} from './renderer';
import { renderWebGLScene } from './webgl-renderer';
import { Viewport, wheelIntent } from './viewport';

interface ShapeBuilderState {
  regionIds: EntityId[];
  resultPathIds: EntityId[];
}

interface VectorCanvasProps {
  manager: OperationManager;
  activeTool: ToolId;
  constructionExtent: ConstructionExtent;
  toolDisabledReasons?: Partial<Record<ToolId, string>>;
  selection: SelectionState;
  selectedArtboardIds: Set<EntityId>;
  impactObjectIds?: ReadonlySet<EntityId>;
  bendMode: HandleMirrorMode;
  paintColor: string;
  drawingStyle: DrawingStyle;
  offsetDistance: number;
  filletRadius: number;
  eraserSettings: { weight: number; shape: 'round' | 'square' };
  primitiveSettings: { cornerRadius: number; polygonSides: number; starPoints: number; starInnerRatio: number };
  shapeBuilderState: ShapeBuilderState;
  rendererMode: 'canvas2d' | 'webgl';
  remotePresence: CollaboratorPresence[];
  onPresenceCursor: (point?: Point) => void;
  onSelectionChange: (selection: SelectionState) => void;
  onArtboardSelectionChange: (artboardIds: Set<EntityId>) => void;
  onShapeBuilderStateChange: (state: ShapeBuilderState) => void;
  onRequestToolChange: (tool: ToolId) => void;
  onOpenConstraintMenu: (x: number, y: number) => void;
  onViewportChange: (scale: number) => void;
  viewportFocusRequest?: {
    id: number;
    objectIds?: EntityId[];
    bounds?: { minX: number; minY: number; maxX: number; maxY: number };
  };
  onNotice: (message: string, tone?: 'info' | 'error') => void;
}

type ArtboardResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
type ArtboardHit = { artboardId: EntityId; part: 'title' | 'border' | ArtboardResizeHandle };

const PEN_CURSOR = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Cpath d='m4 21 4.4-1.1L20 8.3 15.7 4 4.1 15.6 4 21Z' fill='white' stroke='%231f2328' stroke-width='1.5' stroke-linejoin='round'/%3E%3Cpath d='m13.8 6 4.2 4.2M5 19.8l4-4' fill='none' stroke='%231f2328' stroke-width='1.4'/%3E%3C/svg%3E") 4 21, crosshair`;

type Gesture =
  | { kind: 'pan'; pointerId: number; lastScreen: Point }
  | { kind: 'move'; pointerId: number; startScreen: Point; lastWorld: Point; nodeIds: EntityId[]; moving: boolean }
  | { kind: 'move-object'; pointerId: number; startScreen: Point; lastWorld: Point; objectIds: EntityId[]; moving: boolean; duplicateOnDrag: boolean }
  | {
      kind: 'move-artboard'; pointerId: number; startScreen: Point; startWorld: Point; artboardIds: EntityId[];
      frames: Array<{ artboardId: EntityId; frame: { x: number; y: number; width: number; height: number } }>;
      objects: Array<{ objectId: EntityId; transform: NetworkObject['transform'] }>;
      moving: boolean;
      duplicateOnDrag: boolean;
    }
  | { kind: 'resize-artboard'; pointerId: number; startScreen: Point; startWorld: Point; artboardId: EntityId; handle: ArtboardResizeHandle; frame: { x: number; y: number; width: number; height: number }; moving: boolean }
  | { kind: 'parametric-control'; pointerId: number; startScreen: Point; lastWorld: Point; groupId: EntityId; moving: boolean }
  | {
      kind: 'pen'; pointerId: number; startScreen: Point;
      anchor: Point; previewAnchor: Point; local: boolean;
      targetNetworkId?: EntityId; targetObjectId?: EntityId;
    }
  | { kind: 'pencil'; pointerId: number; points: Point[]; lastScreen: Point }
  | { kind: 'brush'; pointerId: number; samples: BrushSample[]; lastScreen: Point }
  | { kind: 'construction'; pointerId: number; startScreen: Point; startWorld: Point; currentWorld: Point; constrain: boolean }
  | { kind: 'primitive'; pointerId: number; startScreen: Point; primitive: PrimitiveKind; startWorld: Point; currentWorld: Point }
  | { kind: 'cut'; pointerId: number; startScreen: Point; startWorld: Point; currentWorld: Point }
  | { kind: 'eraser'; pointerId: number; lastScreen: Point; gapNodeIds: EntityId[] }
  | { kind: 'bend-node'; pointerId: number; startScreen: Point; nodeId: EntityId }
  | { kind: 'bend-segment'; pointerId: number; startScreen: Point; segmentId: EntityId; direct: boolean }
  | { kind: 'bend-handle'; pointerId: number; startScreen: Point; hit: HandleHit; moving: boolean }
  | { kind: 'width'; pointerId: number; handle: WidthHandle; moving: boolean }
  | { kind: 'lasso'; pointerId: number; points: Point[]; lastScreen: Point }
  | { kind: 'marquee'; pointerId: number; startScreen: Point; startWorld: Point; currentWorld: Point; additive: boolean; baseIds: EntityId[]; baseArtboardIds: EntityId[] }
  | { kind: 'network-marquee'; pointerId: number; startScreen: Point; startLocal: Point; currentLocal: Point; additive: boolean; baseNodeIds: EntityId[]; baseSegmentIds: EntityId[] };

export function VectorCanvas({
  manager,
  activeTool,
  constructionExtent,
  toolDisabledReasons = {},
  selection,
  selectedArtboardIds,
  impactObjectIds = new Set<EntityId>(),
  bendMode,
  paintColor,
  drawingStyle,
  offsetDistance,
  filletRadius,
  eraserSettings,
  primitiveSettings,
  shapeBuilderState,
  rendererMode,
  remotePresence,
  onPresenceCursor,
  onSelectionChange,
  onArtboardSelectionChange,
  onShapeBuilderStateChange,
  onRequestToolChange,
  onOpenConstraintMenu,
  onViewportChange,
  viewportFocusRequest,
  onNotice,
}: VectorCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const webglCanvasRef = useRef<HTMLCanvasElement>(null);
  const geometryRevisionRef = useRef(0);
  const viewportRef = useRef(new Viewport());
  const penToolRef = useRef(new PenTool(manager, { standaloneObjects: true, drawingStyle }));
  const gestureRef = useRef<Gesture | null>(null);
  const penPreviewRef = useRef<PenPreview | undefined>();
  const pencilPreviewRef = useRef<FreehandPreview | undefined>();
  const bendPreviewRef = useRef<BendPreview | undefined>();
  const cutPreviewRef = useRef<{ start: Point; end: Point } | undefined>();
  const lassoPreviewRef = useRef<Point[] | undefined>();
  const marqueePreviewRef = useRef<MarqueePreview | undefined>();
  const eraserPreviewRef = useRef<EraserPreview | undefined>();
  const primitivePreviewRef = useRef<PrimitivePreview | undefined>();
  const constructionPreviewRef = useRef<ConstructionLinePreview | undefined>();
  const snapPreviewRef = useRef<SnapResult | undefined>();
  const hoveredRegionRef = useRef<EntityId | undefined>();
  const hoveredNodeRef = useRef<EntityId | undefined>();
  const hoveredSegmentRef = useRef<EntityId | undefined>();
  const hoveredHandleRef = useRef<HandleHit | undefined>();
  const spacePressedRef = useRef(false);
  const altPressedRef = useRef(false);
  const initializedViewportRef = useRef(false);
  const frameRef = useRef<number | null>(null);
  const drawRef = useRef<() => void>(() => undefined);
  const selectionRef = useRef(selection);
  const toolRef = useRef(activeTool);
  const previousToolRef = useRef(activeTool);
  const constructionExtentRef = useRef(constructionExtent);
  const bendModeRef = useRef(bendMode);
  const shapeBuilderRef = useRef(shapeBuilderState);
  const [railTooltip, setRailTooltip] = useState<{ label: string; x: number; y: number }>();
  const [railGroupOpen, setRailGroupOpen] = useState<'select' | 'draw' | 'shapes' | 'edit' | 'build'>();
  const [networkSelectExplicit, setNetworkSelectExplicit] = useState(false);
  const autoOpenedEditingObjectRef = useRef<EntityId>();
  const [vectorMoreOpen, setVectorMoreOpen] = useState(false);
  const selectedArtboardIdsRef = useRef(selectedArtboardIds);
  const [artboardRename, setArtboardRename] = useState<{ artboardId: EntityId; value: string; left: number; top: number; width: number }>();
  const artboardRenameCancelledRef = useRef(false);
  const lastSelectPressRef = useRef<{ at: number; screen: Point }>();

  selectionRef.current = selection;
  selectedArtboardIdsRef.current = selectedArtboardIds;
  toolRef.current = activeTool;
  constructionExtentRef.current = constructionExtent;
  bendModeRef.current = bendMode;
  shapeBuilderRef.current = shapeBuilderState;

  useEffect(() => {
    if (selection.mode !== 'network' || !selection.editingObjectId) {
      autoOpenedEditingObjectRef.current = undefined;
      setNetworkSelectExplicit(false);
      setRailGroupOpen((open) => open === 'draw' ? undefined : open);
      return;
    }
    if (autoOpenedEditingObjectRef.current === selection.editingObjectId) return;
    autoOpenedEditingObjectRef.current = selection.editingObjectId;
    setNetworkSelectExplicit(false);
  }, [selection.editingObjectId, selection.mode]);

  useEffect(() => {
    if (activeTool !== 'select') setNetworkSelectExplicit(false);
  }, [activeTool]);

  const requestRender = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      drawRef.current();
    });
  }, []);

  useEffect(() => subscribePixelGrid(requestRender), [requestRender]);

  drawRef.current = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    const rect = canvas.getBoundingClientRect();
    let webglRendered = false;
    if (rendererMode === 'webgl' && webglCanvasRef.current) {
      webglRendered = renderWebGLScene(webglCanvasRef.current, {
        width: rect.width,
        height: rect.height,
        dpr: window.devicePixelRatio || 1,
        document: manager.document,
        viewport: viewportRef.current,
        selection: selectionRef.current,
        revision: geometryRevisionRef.current,
      });
    }
    renderVectorScene(context, {
      width: rect.width,
      height: rect.height,
      dpr: window.devicePixelRatio || 1,
      document: manager.document,
      viewport: viewportRef.current,
      selection: selectionRef.current,
      selectedArtboardIds: selectedArtboardIdsRef.current,
      impactObjectIds,
      penPreview: penPreviewRef.current,
      freehandPreview: pencilPreviewRef.current,
      bendPreview: bendPreviewRef.current,
      cutPreview: cutPreviewRef.current,
      lassoPreview: lassoPreviewRef.current,
      marqueePreview: marqueePreviewRef.current,
      eraserPreview: eraserPreviewRef.current,
      primitivePreview: primitivePreviewRef.current,
      constructionLinePreview: constructionPreviewRef.current,
      snapPreview: snapPreviewRef.current,
      hoveredRegionId: hoveredRegionRef.current,
      paintRegionHover: toolRef.current === 'paint',
      builderRegionIds: new Set(shapeBuilderRef.current.regionIds),
      subtractRegion: altPressedRef.current,
      hoveredNodeId: hoveredNodeRef.current,
      hoveredSegmentId: hoveredSegmentRef.current,
      hoveredHandle: hoveredHandleRef.current,
      widthToolActive: toolRef.current === 'width',
      remotePresence,
      overlayOnly: webglRendered,
    });
  };

  useEffect(() => {
    penToolRef.current = new PenTool(manager, { standaloneObjects: true, drawingStyle });
    return manager.subscribe(() => {
      geometryRevisionRef.current += 1;
      const current = selectedArtboardIdsRef.current;
      const existing = new Set([...current].filter((id) => manager.document.getArtboard(id)));
      if (existing.size !== current.size) onArtboardSelectionChange(existing);
      requestRender();
    });
  }, [manager, onArtboardSelectionChange, requestRender]);

  useEffect(() => {
    penToolRef.current.setDrawingStyle(drawingStyle);
    if (pencilPreviewRef.current) pencilPreviewRef.current = { ...pencilPreviewRef.current, color: drawingStyle.strokeColor, width: drawingStyle.strokeWidth };
    requestRender();
  }, [drawingStyle, requestRender]);

  useEffect(() => {
    if (constructionPreviewRef.current) {
      constructionPreviewRef.current = { ...constructionPreviewRef.current, extent: constructionExtent };
    }
    requestRender();
  }, [selection, activeTool, bendMode, constructionExtent, shapeBuilderState, remotePresence, rendererMode, impactObjectIds, requestRender]);

  useEffect(() => {
    if (previousToolRef.current === 'pen' && activeTool !== 'pen') penToolRef.current.endPath();
    previousToolRef.current = activeTool;
    penPreviewRef.current = undefined;
    hoveredRegionRef.current = undefined;
    hoveredNodeRef.current = undefined;
    hoveredSegmentRef.current = undefined;
    hoveredHandleRef.current = undefined;
    pencilPreviewRef.current = undefined;
    bendPreviewRef.current = undefined;
    cutPreviewRef.current = undefined;
    lassoPreviewRef.current = undefined;
    marqueePreviewRef.current = undefined;
    eraserPreviewRef.current = undefined;
    primitivePreviewRef.current = undefined;
    constructionPreviewRef.current = undefined;
    snapPreviewRef.current = undefined;
    requestRender();
  }, [activeTool, requestRender]);

  useEffect(() => {
    if (activeTool !== 'pen' || !penToolRef.current.hasActivePath) return;
    const activeObjectId = penToolRef.current.activeObjectId;
    if (activeObjectId && (selection.mode !== 'network' || selection.editingObjectId !== activeObjectId)) {
      penToolRef.current.endPath();
      penPreviewRef.current = undefined;
      requestRender();
    }
  }, [activeTool, requestRender, selection.editingObjectId, selection.mode]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      if (webglCanvasRef.current) {
        webglCanvasRef.current.width = canvas.width;
        webglCanvasRef.current.height = canvas.height;
      }
      if (!initializedViewportRef.current && rect.width > 0 && rect.height > 0) {
        const activeLocation = manager.document.activeArtboard;
        if (activeLocation.isCanvasRoot) {
          viewportRef.current.centerOn(rect.width, rect.height);
        } else {
          viewportRef.current.fitBounds({
            minX: activeLocation.frame.x,
            minY: activeLocation.frame.y,
            maxX: activeLocation.frame.x + activeLocation.frame.width,
            maxY: activeLocation.frame.y + activeLocation.frame.height,
          }, rect.width, rect.height, 72);
        }
        onViewportChange(viewportRef.current.scale);
        initializedViewportRef.current = true;
      }
      requestRender();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();
    return () => observer.disconnect();
  }, [manager, onViewportChange, rendererMode, requestRender]);

  useEffect(() => {
    if (!viewportFocusRequest) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const objectBoundsList = (viewportFocusRequest.objectIds ?? [])
      .filter((objectId) => manager.document.getObject(objectId) && manager.document.isObjectVisible(objectId))
      .map((objectId) => objectBounds(manager.document, objectId, INTERACTION_BOUNDS_POLICY));
    const union = viewportFocusRequest.bounds ?? (objectBoundsList.length > 0 ? {
      minX: Math.min(...objectBoundsList.map((item) => item.minX)),
      minY: Math.min(...objectBoundsList.map((item) => item.minY)),
      maxX: Math.max(...objectBoundsList.map((item) => item.maxX)),
      maxY: Math.max(...objectBoundsList.map((item) => item.maxY)),
    } : undefined);
    if (!union) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    viewportRef.current.fitBounds(union, rect.width, rect.height);
    onViewportChange(viewportRef.current.scale);
    requestRender();
  }, [manager, onViewportChange, requestRender, viewportFocusRequest]);

  /** Keyboard zoom around the canvas centre, for pointers without a wheel. */
  const zoomStep = useCallback((direction: 1 | -1) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    viewportRef.current.zoomAt({ x: rect.width / 2, y: rect.height / 2 }, direction === 1 ? 1.25 : 0.8);
    onViewportChange(viewportRef.current.scale);
    requestRender();
  }, [onViewportChange, requestRender]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;
      if ((event.ctrlKey || event.metaKey) && (event.key === '=' || event.key === '+')) {
        event.preventDefault();
        zoomStep(1);
        return;
      }
      if ((event.ctrlKey || event.metaKey) && (event.key === '-' || event.key === '_')) {
        event.preventDefault();
        zoomStep(-1);
        return;
      }
      if (event.code === 'Space') {
        spacePressedRef.current = true;
        event.preventDefault();
      }
      if (event.key === 'Alt') {
        altPressedRef.current = true;
        canvasRef.current?.classList.add('is-subtracting');
        requestRender();
      }
      if (event.key === 'Enter' && toolRef.current === 'select' && selectionRef.current.mode === 'object' && selectionRef.current.objectIds.size === 1) {
        const objectId = [...selectionRef.current.objectIds][0];
        if (manager.document.isObjectVisible(objectId) && !manager.document.isObjectLocked(objectId)) {
          onSelectionChange(enterNetworkEditMode(manager.document, objectId));
          event.preventDefault();
        }
      } else if (event.key === 'Enter' && selectionRef.current.mode === 'network') {
        penToolRef.current.endPath();
        clearPreviews();
        onSelectionChange(exitNetworkEditMode(selectionRef.current));
        onRequestToolChange('select');
        event.preventDefault();
      }
      if (event.key === 'Escape') {
        if (toolRef.current === 'pen' && penToolRef.current.hasActivePath) {
          penToolRef.current.endPath();
          clearPreviews();
          requestRender();
          event.preventDefault();
          return;
        }
        const gesture = gestureRef.current;
        if (gesture?.kind === 'width' ||
          ((gesture?.kind === 'move' || gesture?.kind === 'move-object' || gesture?.kind === 'move-artboard' || gesture?.kind === 'resize-artboard' || gesture?.kind === 'bend-handle') && gesture.moving)) {
          manager.rollbackTransaction();
        }
        gestureRef.current = null;
        penToolRef.current.endPath();
        clearPreviews();
        if (toolRef.current === 'shape-builder') {
          onShapeBuilderStateChange({ regionIds: [], resultPathIds: [] });
        }
        if (selectionRef.current.mode === 'network') {
          onSelectionChange(exitNetworkEditMode(selectionRef.current));
          onRequestToolChange('select');
        } else if (toolRef.current !== 'select' && toolRef.current !== 'pen' && toolRef.current !== 'pencil' && toolRef.current !== 'brush') {
          onRequestToolChange('select');
        } else if (toolRef.current === 'select' && selectedArtboardIdsRef.current.size > 0) {
          onArtboardSelectionChange(new Set());
        }
        requestRender();
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') spacePressedRef.current = false;
      if (event.key === 'Alt') {
        altPressedRef.current = false;
        canvasRef.current?.classList.remove('is-subtracting');
        requestRender();
      }
    };
    const onBlur = () => {
      spacePressedRef.current = false;
      altPressedRef.current = false;
      canvasRef.current?.classList.remove('is-subtracting');
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [manager, onArtboardSelectionChange, onRequestToolChange, onSelectionChange, onShapeBuilderStateChange, requestRender, zoomStep]);

  const clearPreviews = () => {
    penPreviewRef.current = undefined;
    pencilPreviewRef.current = undefined;
    bendPreviewRef.current = undefined;
    cutPreviewRef.current = undefined;
    lassoPreviewRef.current = undefined;
    marqueePreviewRef.current = undefined;
    eraserPreviewRef.current = undefined;
    primitivePreviewRef.current = undefined;
    constructionPreviewRef.current = undefined;
    snapPreviewRef.current = undefined;
    hoveredRegionRef.current = undefined;
    hoveredSegmentRef.current = undefined;
    hoveredHandleRef.current = undefined;
  };

  const localPoint = (event: { clientX: number; clientY: number }): Point => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const editingLocalPoint = (point: Point): Point => {
    const objectId = selectionRef.current.editingObjectId;
    const object = objectId ? manager.document.getObject(objectId) : undefined;
    const inverse = object ? inverseMatrix(objectTransformMatrix(object.transform)) : undefined;
    return inverse ? transformPoint(point, inverse) : point;
  };

  const executeSafely = (operation: OperationInput): boolean => {
    try {
      manager.execute(operation);
      return true;
    } catch (error) {
      onNotice(`Operation rejected: ${error instanceof Error ? error.message : 'constraint pre-validation failed'}`, 'error');
      console.warn('Operation rejected by constraint pre-validation.', error);
      return false;
    }
  };

  const eraseAtPoint = (worldPoint: Point, gapNodeIds: EntityId[]): boolean => {
    const viewport = viewportRef.current;
    const radiusPx = Math.max(0.5, eraserSettings.weight / 2);
    const hitTolerance = radiusPx * (eraserSettings.shape === 'square' ? Math.SQRT2 : 1) / viewport.scale;
    const hit = hitTestSegment(
      manager.document,
      worldPoint,
      hitTolerance,
      selectionRef.current.editingObjectId,
    );
    if (hit?.kind !== 'segment') return false;
    const segment = manager.document.getSegment(hit.id);
    if (!segment || segment.role === 'construction') return false;
    const originalErase = prepareEraseSegment(manager.document, hit.id);
    const path = manager.document.findPathForSegment(hit.id);
    const hitObject = manager.document.getObjectForSegment(hit.id);
    const hitMatrix = objectTransformMatrix(hitObject?.transform ?? { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 });
    const hitScale = matrixScale(hitMatrix);
    const averageObjectScale = Math.max(1e-4, (hitScale.x + hitScale.y) / 2);
    const inverseHitMatrix = inverseMatrix(hitMatrix);
    const erasePoint = hitObject && inverseHitMatrix ? transformPoint(worldPoint, inverseHitMatrix) : worldPoint;
    const span = localEraseSpan(manager.document, hit.id, erasePoint, radiusPx / (viewport.scale * averageObjectScale));
    if (!originalErase || !path || !span) return false;

    for (const constraintId of originalErase.removedConstraintIds) {
      if (manager.document.constraints.has(constraintId)) {
        manager.execute({ type: 'REMOVE_CONSTRAINT', payload: { constraintId } });
      }
    }
    for (const group of originalErase.removedParametricGroups) {
      if (manager.document.parametricGroups.has(group.id)) {
        manager.execute({ type: 'REMOVE_PARAMETRIC_GROUP', payload: { group } });
      }
    }
    let erase = originalErase;
    if (span.endT - span.startT > 2e-3) {
      if (span.startT <= 1e-3) {
        const split = prepareSplitSegment(manager.document, hit.id, span.endT);
        if (!split) throw new Error('The erased span is too close to the path endpoint.');
        manager.execute({ type: 'SPLIT_SEGMENT', payload: split });
        erase = prepareEraseSegment(manager.document, split.newSegment1Id, true) ?? erase;
      } else if (span.endT >= 1 - 1e-3) {
        const split = prepareSplitSegment(manager.document, hit.id, span.startT);
        if (!split) throw new Error('The erased span is too close to the path endpoint.');
        manager.execute({ type: 'SPLIT_SEGMENT', payload: split });
        erase = prepareEraseSegment(manager.document, split.newSegment2Id, true) ?? erase;
      } else {
        const first = prepareSplitSegment(manager.document, hit.id, span.startT);
        if (!first) throw new Error('The erased span could not be split.');
        manager.execute({ type: 'SPLIT_SEGMENT', payload: first });
        const relativeEnd = (span.endT - span.startT) / (1 - span.startT);
        const second = prepareSplitSegment(manager.document, first.newSegment2Id, relativeEnd);
        if (!second) throw new Error('The erased span could not be completed.');
        manager.execute({ type: 'SPLIT_SEGMENT', payload: second });
        erase = prepareEraseSegment(manager.document, second.newSegment1Id, true) ?? erase;
      }
    }

    for (const constraintId of erase.removedConstraintIds) {
      if (manager.document.constraints.has(constraintId)) {
        manager.execute({ type: 'REMOVE_CONSTRAINT', payload: { constraintId } });
      }
    }
    for (const group of erase.removedParametricGroups) {
      if (manager.document.parametricGroups.has(group.id)) {
        manager.execute({ type: 'REMOVE_PARAMETRIC_GROUP', payload: { group } });
      }
    }
    manager.execute({ type: 'APPLY_GRAPH_PATCH', payload: erase.patch });
    if (path.isClosed) {
      manager.execute({ type: 'SET_PATH_CLOSED', payload: { pathId: path.id, isClosed: false } });
    }
    gapNodeIds.push(...erase.gapNodeIds.filter((nodeId) => Boolean(manager.document.getNode(nodeId))));
    return true;
  };

  const handleDoubleClick = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    if (toolRef.current !== 'select' || selectionRef.current.mode !== 'object') return;
    const viewport = viewportRef.current;
    const screen = localPoint(event);
    const world = viewport.screenToWorld(screen);
    const artboardHit = hitTestArtboard(manager.document, world, viewport.scale, selectedArtboardIdsRef.current);
    if (artboardHit?.part === 'title') {
      const artboard = manager.document.getArtboard(artboardHit.artboardId);
      if (!artboard) return;
      artboardRenameCancelledRef.current = false;
      const title = viewport.worldToScreen({ x: artboard.frame.x, y: artboard.frame.y });
      setArtboardRename({
        artboardId: artboard.id,
        value: artboard.name,
        left: title.x - 2,
        top: Math.max(2, title.y - 27),
        width: Math.max(110, artboard.name.length * 8 + 28),
      });
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const objectHit = hitTestObject(manager.document, world, 7 / viewport.scale);
    if (objectHit) {
      const editing = enterNetworkEditMode(manager.document, objectHit.id);
      onSelectionChange(selectionForHit(editing, objectHit.geometryHit ?? null, false));
      event.preventDefault();
    }
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!;
    setVectorMoreOpen(false);
    canvas.focus({ preventScroll: true });
    const screen = localPoint(event);
    const viewport = viewportRef.current;
    const world = viewport.screenToWorld(screen);
    const localWorld = editingLocalPoint(world);
    const isPan = event.button === 1 || (event.button === 0 && spacePressedRef.current);

    if (isPan) {
      gestureRef.current = { kind: 'pan', pointerId: event.pointerId, lastScreen: screen };
      canvas.setPointerCapture(event.pointerId);
      canvas.classList.add('is-panning');
      event.preventDefault();
      return;
    }
    if (event.button !== 0) return;
    const previousPress = lastSelectPressRef.current;
    const isDirectDoubleClick = toolRef.current === 'select' && Boolean(
      previousPress && event.timeStamp - previousPress.at < 420 &&
        Math.hypot(previousPress.screen.x - screen.x, previousPress.screen.y - screen.y) < 5,
    );
    if (toolRef.current === 'select') lastSelectPressRef.current = { at: event.timeStamp, screen };
    else lastSelectPressRef.current = undefined;

    if (toolRef.current === 'paint') {
      const region = regionAtPoint(manager.document, world);
      if (!region) {
        onNotice('Paint needs a visible closed region under the pointer.', 'error');
      } else {
        const object = region.boundarySegmentIds[0]
          ? manager.document.getObjectForSegment(region.boundarySegmentIds[0])
          : undefined;
        if (object && manager.document.isObjectLocked(object.id)) {
          onNotice('Unlock this object before painting its region.', 'error');
        } else {
          const clearing = event.altKey || altPressedRef.current;
          if (executeSafely({
            type: 'SET_REGION_FILL',
            payload: {
              regionId: region.id,
              fill: clearing ? undefined : { type: 'solid', color: paintColor },
            },
          })) {
            onNotice(clearing ? 'Region fill cleared.' : `Region filled with ${paintColor.toUpperCase()}.`);
          }
        }
      }
      event.preventDefault();
      return;
    }

    if (toolRef.current === 'construction-line') {
      const snapped = snapPoint(manager.document, world, { scale: viewport.scale });
      snapPreviewRef.current = snapped;
      gestureRef.current = {
        kind: 'construction',
        pointerId: event.pointerId,
        startScreen: screen,
        startWorld: snapped.point,
        currentWorld: snapped.point,
        constrain: event.shiftKey,
      };
      constructionPreviewRef.current = {
        start: snapped.point,
        end: snapped.point,
        constrain: event.shiftKey,
        extent: constructionExtentRef.current,
      };
      canvas.setPointerCapture(event.pointerId);
      event.preventDefault();
      return;
    }

    if (isPrimitiveTool(toolRef.current)) {
      const primitive = toolRef.current;
      const snapped = snapPoint(manager.document, world, { scale: viewport.scale });
      snapPreviewRef.current = snapped;
      gestureRef.current = {
        kind: 'primitive', pointerId: event.pointerId, startScreen: screen,
        primitive, startWorld: snapped.point, currentWorld: snapped.point,
      };
      primitivePreviewRef.current = {
        kind: primitive, start: snapped.point, end: snapped.point,
        constrain: event.shiftKey, fromCenter: event.altKey || altPressedRef.current,
      };
      canvas.setPointerCapture(event.pointerId);
      event.preventDefault();
      return;
    }

    if (toolRef.current !== 'select' && toolRef.current !== 'pen' && toolRef.current !== 'pencil' && toolRef.current !== 'brush' && selectionRef.current.mode !== 'network') {
      event.preventDefault();
      return;
    }
    const editingObjectId = selectionRef.current.editingObjectId;
    if (editingObjectId && manager.document.isObjectLocked(editingObjectId)) {
      event.preventDefault();
      return;
    }

    if (toolRef.current === 'shape-builder') {
      const region = regionAtPoint(manager.document, world);
      if (region) {
        try {
          const result = buildShapeBuilderResult(
            manager.document,
            shapeBuilderRef.current.regionIds,
            shapeBuilderRef.current.resultPathIds,
            region.id,
            event.altKey || altPressedRef.current,
          );
          if (result && executeSafely({ type: result.type, payload: result.payload })) {
            onShapeBuilderStateChange({
              regionIds: result.selectedRegionIds,
              resultPathIds: result.resultPathIds,
            });
            const segmentIds = result.resultPathIds.flatMap((id) => manager.document.getPath(id)?.segmentIds ?? []);
            onSelectionChange(networkSelection(manager.document, [], segmentIds));
          }
        } catch (error) {
          onNotice(error instanceof Error ? error.message : 'Shape Builder could not prepare this region.', 'error');
        }
      } else {
        onNotice('Shape Builder requires a visible closed region under the pointer.', 'error');
      }
      event.preventDefault();
      return;
    }

    if (toolRef.current === 'lasso') {
      gestureRef.current = { kind: 'lasso', pointerId: event.pointerId, points: [localWorld], lastScreen: screen };
      lassoPreviewRef.current = [localWorld];
      canvas.setPointerCapture(event.pointerId);
      event.preventDefault();
      return;
    }

    if (toolRef.current === 'cut') {
      gestureRef.current = {
        kind: 'cut',
        pointerId: event.pointerId,
        startScreen: screen,
        startWorld: localWorld,
        currentWorld: localWorld,
      };
      cutPreviewRef.current = { start: localWorld, end: localWorld };
      canvas.setPointerCapture(event.pointerId);
      event.preventDefault();
      return;
    }

    if (toolRef.current === 'eraser') {
      const gapNodeIds: EntityId[] = [];
      try {
        manager.beginTransaction('Erase path area');
        eraseAtPoint(world, gapNodeIds);
        gestureRef.current = { kind: 'eraser', pointerId: event.pointerId, lastScreen: screen, gapNodeIds };
        eraserPreviewRef.current = {
          point: localWorld,
          radius: Math.max(0.5, eraserSettings.weight / 2),
          shape: eraserSettings.shape,
        };
        canvas.setPointerCapture(event.pointerId);
      } catch (error) {
        manager.rollbackTransaction();
        onNotice(error instanceof Error ? error.message : 'The brushed path area could not be erased.', 'error');
        console.warn('Erase rejected by constraint pre-validation.', error);
      }
      event.preventDefault();
      requestRender();
      return;
    }

    if (toolRef.current === 'offset') {
      const hit = hitTest(manager.document, world, 8 / viewport.scale, selectionRef.current.editingObjectId);
      event.preventDefault();
      if (hit?.kind === 'segment') {
        const pathId = manager.document.findPathForSegment(hit.id)?.id;
        const distance = (event.altKey || altPressedRef.current ? -1 : 1) * Math.max(0.1, Math.abs(offsetDistance));
        void import('../tools/offset-tool').then(({ preparePathOffset }) => {
          try {
            const offset = pathId ? preparePathOffset(manager.document, pathId, distance) : null;
            if (offset && executeSafely({ type: 'APPLY_GRAPH_PATCH', payload: offset.patch })) {
              onSelectionChange(networkSelection(manager.document, [], offset.resultSegmentIds));
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Path offset could not be created.';
            onNotice(message, 'error');
            console.warn('Path offset could not be created.', error);
          }
        }).catch((error: unknown) => {
          onNotice('Offset tool could not be loaded.', 'error');
          console.warn('Offset tool loading failed.', error);
        });
      }
      return;
    }

    if (toolRef.current === 'width') {
      const widthHandle = hitTestWidthHandle(manager.document, localWorld, 8 / viewport.scale);
      if (widthHandle && (event.altKey || altPressedRef.current)) {
        const segment = manager.document.getSegment(widthHandle.segmentId);
        if (segment) {
          const widthProfile = segment.widthProfile?.filter((point) => point.id !== widthHandle.pointId);
          executeSafely({
            type: 'SET_SEGMENT_WIDTH_PROFILE',
            payload: { segmentId: segment.id, widthProfile: widthProfile?.length ? widthProfile : undefined },
          });
        }
      } else if (widthHandle) {
        manager.beginTransaction(widthHandle.kind === 'position' ? 'Move width point' : 'Resize width point');
        gestureRef.current = { kind: 'width', pointerId: event.pointerId, handle: widthHandle, moving: false };
        canvas.setPointerCapture(event.pointerId);
      } else {
        const hit = hitTest(manager.document, world, 8 / viewport.scale, selectionRef.current.editingObjectId);
        if (hit?.kind === 'segment') {
          const segment = manager.document.getSegment(hit.id);
          if (segment?.role === 'construction') {
            onNotice('Variable Width is unavailable for construction segments.', 'error');
            event.preventDefault();
            return;
          }
          const widthPoint = segment ? addWidthPoint(manager.document, segment, localWorld) : null;
          if (segment && widthPoint) {
            const widthProfile = [...(segment.widthProfile ?? []).map((point) => ({ ...point })), widthPoint]
              .sort((a, b) => a.t - b.t || a.id.localeCompare(b.id));
            if (executeSafely({ type: 'SET_SEGMENT_WIDTH_PROFILE', payload: { segmentId: segment.id, widthProfile } })) {
              onSelectionChange(networkSelection(manager.document, [], [segment.id]));
            }
          }
        }
      }
      event.preventDefault();
      return;
    }

    if (toolRef.current === 'fillet') {
      const hit = hitTest(manager.document, world, 9 / viewport.scale, selectionRef.current.editingObjectId);
      if (hit?.kind !== 'node') {
        onNotice('Fillet requires a corner node shared by two adjacent line segments.', 'error');
        event.preventDefault();
        return;
      }
      const requestedRadius = Math.abs(filletRadius);
      event.preventDefault();
      void import('../tools/fillet-tool').then(({ prepareFillet, validateFillet }) => {
        const validation = validateFillet(manager.document, hit.id, requestedRadius);
        if (!validation.valid) {
          onNotice(validation.message, 'error');
          return;
        }
        const fillet = prepareFillet(manager.document, hit.id, requestedRadius);
        if (!fillet) {
          onNotice('Fillet could not prepare this corner.', 'error');
          return;
        }
        try {
          manager.beginTransaction('Create true arc fillet');
          manager.execute({ type: 'APPLY_GRAPH_PATCH', payload: fillet.patch });
          for (const constraint of fillet.constraints) {
            manager.execute({ type: 'ADD_CONSTRAINT', payload: { constraint } });
          }
          manager.commitTransaction();
          onSelectionChange(networkSelection(
            manager.document,
            [fillet.cornerNodeId, fillet.tangentNodeId],
            [fillet.arcSegmentId],
          ));
        } catch (error) {
          manager.rollbackTransaction();
          const message = error instanceof Error ? error.message : 'constraint pre-validation failed';
          onNotice(`Fillet rejected: ${message}`, 'error');
          console.warn('Fillet rejected by constraint pre-validation.', error);
        }
      }).catch((error: unknown) => {
        onNotice('Fillet tool could not be loaded.', 'error');
        console.warn('Fillet tool loading failed.', error);
      });
      return;
    }

    if (toolRef.current === 'bend') {
      const handle = hitTestHandle(manager.document, selectionRef.current.nodeIds, localWorld, 8 / viewport.scale);
      if (handle) {
        gestureRef.current = { kind: 'bend-handle', pointerId: event.pointerId, startScreen: screen, hit: handle, moving: false };
        canvas.setPointerCapture(event.pointerId);
        event.preventDefault();
        return;
      }
      const hit = hitTest(manager.document, world, 7 / viewport.scale, selectionRef.current.editingObjectId);
      const constructionHit = hit?.kind === 'segment'
        ? manager.document.getSegment(hit.id)?.role === 'construction'
        : hit?.kind === 'node'
          ? manager.document.connectedSegments(hit.id).some((segment) => segment.role === 'construction')
          : false;
      if (constructionHit) {
        onNotice('Bend is unavailable for construction segments.', 'error');
        event.preventDefault();
        return;
      }
      if (hit?.kind === 'node') {
        onSelectionChange(networkSelection(manager.document, [hit.id]));
        gestureRef.current = { kind: 'bend-node', pointerId: event.pointerId, startScreen: screen, nodeId: hit.id };
        canvas.setPointerCapture(event.pointerId);
      } else if (hit?.kind === 'segment') {
        onSelectionChange(networkSelection(manager.document, [], [hit.id]));
        gestureRef.current = { kind: 'bend-segment', pointerId: event.pointerId, startScreen: screen, segmentId: hit.id, direct: false };
        canvas.setPointerCapture(event.pointerId);
      } else {
        onSelectionChange(networkSelection(manager.document, [], [], selectionRef.current.editingObjectId));
      }
      event.preventDefault();
      return;
    }

    if (toolRef.current === 'pencil') {
      gestureRef.current = { kind: 'pencil', pointerId: event.pointerId, points: [world], lastScreen: screen };
      pencilPreviewRef.current = { points: [world], color: drawingStyle.strokeColor, width: drawingStyle.strokeWidth };
      canvas.setPointerCapture(event.pointerId);
      event.preventDefault();
      return;
    }

    if (toolRef.current === 'brush') {
      const pressure = event.pressure > 0 ? event.pressure : 0.5;
      const width = Math.max(0.5, drawingStyle.strokeWidth * (0.3 + pressure * 1.4) * 0.38);
      gestureRef.current = {
        kind: 'brush', pointerId: event.pointerId,
        samples: [{ point: world, pressure }], lastScreen: screen,
      };
      pencilPreviewRef.current = {
        points: [world], widths: [width], color: drawingStyle.strokeColor, width: drawingStyle.strokeWidth,
      };
      canvas.setPointerCapture(event.pointerId);
      event.preventDefault();
      return;
    }

    if (toolRef.current === 'pen') {
      const editingObject = selectionRef.current.mode === 'network' && selectionRef.current.editingObjectId
        ? manager.document.getObject(selectionRef.current.editingObjectId)
        : undefined;
      const targetNetwork = editingObject ? manager.document.getNetwork(editingObject.networkId) : undefined;
      if (editingObject && targetNetwork) {
        const hit = hitTest(manager.document, world, 8 / viewport.scale, editingObject.id);
        let targetNodeId: EntityId | undefined;
        if (hit?.kind === 'segment') {
          const split = prepareSplitAtPoint(manager.document, hit.id, localWorld);
          if (split && executeSafely({ type: 'SPLIT_SEGMENT', payload: split })) targetNodeId = split.newNodeId;
        } else if (hit?.kind === 'node') {
          targetNodeId = hit.id;
        }
        if (targetNodeId) {
          try {
            if (penToolRef.current.hasActivePath) penToolRef.current.connectToNode(targetNodeId);
            else penToolRef.current.beginFromNode(targetNodeId, targetNetwork.id, editingObject.id);
            onSelectionChange(networkSelection(manager.document, [targetNodeId], [], editingObject.id));
            penPreviewRef.current = undefined;
            requestRender();
          } catch (error) {
            onNotice(error instanceof Error ? error.message : 'Pen could not connect to this point.', 'error');
          }
          event.preventDefault();
          return;
        }
        const localPenCoordinates = !penToolRef.current.hasActivePath || penToolRef.current.activeCoordinateSpace === 'local';
        const rawAnchor = localPenCoordinates ? localWorld : world;
        const anchor = event.shiftKey && penToolRef.current.hasActivePath
          ? penToolRef.current.constrainPosition(rawAnchor)
          : rawAnchor;
        const previewAnchor = localPenCoordinates
          ? transformPoint(anchor, objectTransformMatrix(editingObject.transform))
          : anchor;
        gestureRef.current = {
          kind: 'pen', pointerId: event.pointerId, startScreen: screen,
          anchor,
          previewAnchor,
          local: localPenCoordinates,
          targetNetworkId: targetNetwork.id,
          targetObjectId: editingObject.id,
        };
      } else {
        const anchor = event.shiftKey && penToolRef.current.hasActivePath
          ? penToolRef.current.constrainPosition(world)
          : world;
        gestureRef.current = {
          kind: 'pen', pointerId: event.pointerId, startScreen: screen,
          anchor, previewAnchor: anchor, local: false,
        };
      }
      canvas.setPointerCapture(event.pointerId);
      event.preventDefault();
      return;
    }

    if (toolRef.current === 'select') {
      const controlGroupId = hitParametricControl(
        manager.document,
        selectionRef.current,
        world,
        9 / viewport.scale,
      );
      if (controlGroupId) {
        gestureRef.current = {
          kind: 'parametric-control', pointerId: event.pointerId, startScreen: screen,
          lastWorld: world, groupId: controlGroupId, moving: false,
        };
        canvas.setPointerCapture(event.pointerId);
        event.preventDefault();
        return;
      }
    }

    if (toolRef.current === 'select' && selectionRef.current.mode === 'object') {
      const artboardHit = hitTestArtboard(manager.document, world, viewport.scale, selectedArtboardIdsRef.current);
      if (artboardHit) {
        const artboard = manager.document.getArtboard(artboardHit.artboardId);
        if (!artboard) return;
        if (artboardHit.part === 'title' && isDirectDoubleClick) {
          artboardRenameCancelledRef.current = false;
          const title = viewport.worldToScreen({ x: artboard.frame.x, y: artboard.frame.y });
          setArtboardRename({
            artboardId: artboard.id,
            value: artboard.name,
            left: title.x - 2,
            top: Math.max(2, title.y - 27),
            width: Math.max(110, artboard.name.length * 8 + 28),
          });
          event.preventDefault();
          return;
        }
        const nextIds = new Set(selectedArtboardIdsRef.current);
        if (event.shiftKey) {
          if (nextIds.has(artboard.id)) nextIds.delete(artboard.id);
          else nextIds.add(artboard.id);
        } else {
          nextIds.clear();
          nextIds.add(artboard.id);
        }
        onArtboardSelectionChange(nextIds);
        if (!nextIds.has(artboard.id)) {
          requestRender();
          event.preventDefault();
          return;
        }
        const duplicateOnDrag = !isArtboardResizeHandle(artboardHit.part) && (event.altKey || altPressedRef.current);
        if (manager.document.activeArtboardId !== artboard.id && !duplicateOnDrag) {
          manager.execute({ type: 'SET_ACTIVE_LOCATION', payload: { pageId: artboard.pageId, artboardId: artboard.id } });
        }
        onSelectionChange({ mode: 'object', objectIds: new Set(), nodeIds: new Set(), segmentIds: new Set() });
        if (isArtboardResizeHandle(artboardHit.part)) {
          gestureRef.current = {
            kind: 'resize-artboard',
            pointerId: event.pointerId,
            startScreen: screen,
            startWorld: world,
            artboardId: artboard.id,
            handle: artboardHit.part,
            frame: { ...artboard.frame },
            moving: false,
          };
        } else {
          const artboardIds = [...nextIds];
          gestureRef.current = {
            kind: 'move-artboard',
            pointerId: event.pointerId,
            startScreen: screen,
            startWorld: world,
            artboardIds,
            frames: artboardIds.flatMap((artboardId) => {
              const selected = manager.document.getArtboard(artboardId);
              return selected ? [{ artboardId, frame: { ...selected.frame } }] : [];
            }),
            objects: artboardIds.flatMap((artboardId) => manager.document.objectsForArtboard(artboardId)
              .map((object) => ({ objectId: object.id, transform: { ...object.transform } }))),
            moving: false,
            duplicateOnDrag,
          };
        }
        canvas.setPointerCapture(event.pointerId);
        event.preventDefault();
        return;
      }
    }

    if (selectionRef.current.mode === 'object') {
      const objectHit = hitTestObject(manager.document, world, 7 / viewport.scale);
      if (objectHit || !event.shiftKey) onArtboardSelectionChange(new Set());
      if (objectHit && isDirectDoubleClick) {
        const editing = enterNetworkEditMode(manager.document, objectHit.id);
        const nextSelection = selectionForHit(editing, objectHit.geometryHit ?? null, false);
        onSelectionChange(nextSelection);
      } else if (!objectHit) {
        gestureRef.current = {
          kind: 'marquee',
          pointerId: event.pointerId,
          startScreen: screen,
          startWorld: world,
          currentWorld: world,
          additive: event.shiftKey,
          baseIds: event.shiftKey ? [...selectionRef.current.objectIds] : [],
          baseArtboardIds: event.shiftKey ? [...selectedArtboardIdsRef.current] : [],
        };
        marqueePreviewRef.current = { start: world, end: world, mode: 'contain' };
        canvas.setPointerCapture(event.pointerId);
      } else {
        const nextSelection = !event.shiftKey && selectionRef.current.objectIds.has(objectHit.id)
          ? {
              ...selectionRef.current,
              objectIds: new Set(selectionRef.current.objectIds),
              nodeIds: new Set<EntityId>(),
              segmentIds: new Set<EntityId>(),
            }
          : selectionForObjectHit(selectionRef.current, objectHit, event.shiftKey);
        onSelectionChange(nextSelection);
        if (nextSelection.objectIds.has(objectHit.id)) {
          gestureRef.current = {
            kind: 'move-object',
            pointerId: event.pointerId,
            startScreen: screen,
            lastWorld: world,
            objectIds: [...nextSelection.objectIds],
            moving: false,
            duplicateOnDrag: event.altKey || altPressedRef.current,
          };
          canvas.setPointerCapture(event.pointerId);
        }
      }
    } else {
      // Move mode is the direct-manipulation mode: visible Bézier handles and
      // editable paths should not require a trip to the Bend tool first.
      const directHandle = hitTestHandle(
        manager.document,
        selectionRef.current.nodeIds,
        localWorld,
        8 / viewport.scale,
      );
      if (directHandle) {
        gestureRef.current = {
          kind: 'bend-handle',
          pointerId: event.pointerId,
          startScreen: screen,
          hit: directHandle,
          moving: false,
        };
        canvas.setPointerCapture(event.pointerId);
        event.preventDefault();
        return;
      }

      const hit = hitTest(
        manager.document,
        world,
        7 / viewport.scale,
        selectionRef.current.editingObjectId,
      );
      if (!hit) {
        gestureRef.current = {
          kind: 'network-marquee',
          pointerId: event.pointerId,
          startScreen: screen,
          startLocal: localWorld,
          currentLocal: localWorld,
          additive: event.shiftKey,
          baseNodeIds: event.shiftKey ? [...selectionRef.current.nodeIds] : [],
          baseSegmentIds: event.shiftKey ? [...selectionRef.current.segmentIds] : [],
        };
        marqueePreviewRef.current = { start: localWorld, end: localWorld, mode: 'contain' };
        canvas.setPointerCapture(event.pointerId);
      } else {
        const nextSelection = selectionForHit(selectionRef.current, hit, event.shiftKey);
        onSelectionChange(nextSelection);
        if (hit.kind === 'node' && nextSelection.nodeIds.has(hit.id)) {
          gestureRef.current = {
            kind: 'move',
            pointerId: event.pointerId,
            startScreen: screen,
            lastWorld: localWorld,
            nodeIds: [...nextSelection.nodeIds],
            moving: false,
          };
          canvas.setPointerCapture(event.pointerId);
        } else if (hit.kind === 'segment') {
          const segment = manager.document.getSegment(hit.id);
          if (canDirectBendSegment(segment)) {
            gestureRef.current = {
              kind: 'bend-segment',
              pointerId: event.pointerId,
              startScreen: screen,
              segmentId: hit.id,
              direct: true,
            };
            canvas.setPointerCapture(event.pointerId);
          }
        }
      }
    }
    event.preventDefault();
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const screen = localPoint(event);
    const viewport = viewportRef.current;
    const world = viewport.screenToWorld(screen);
    const localWorld = editingLocalPoint(world);
    const gesture = gestureRef.current;
    onPresenceCursor(world);

    if (!gesture) {
      updateHover(world, event.shiftKey);
      return;
    }
    if (gesture.pointerId !== event.pointerId) return;

    if (gesture.kind === 'pan') {
      viewport.panBy(screen.x - gesture.lastScreen.x, screen.y - gesture.lastScreen.y);
      gesture.lastScreen = screen;
      requestRender();
      return;
    }
    if (gesture.kind === 'move-artboard') {
      if (!gesture.moving && screenDistance(screen, gesture.startScreen) >= 3) {
        manager.beginTransaction(gesture.duplicateOnDrag
          ? (gesture.artboardIds.length > 1 ? 'Duplicate artboards' : 'Duplicate artboard')
          : (gesture.artboardIds.length > 1 ? 'Move artboards' : 'Move artboard'));
        if (gesture.duplicateOnDrag) {
          const duplicateFrames: typeof gesture.frames = [];
          const duplicateObjects: typeof gesture.objects = [];
          const duplicateArtboardIds: EntityId[] = [];
          let accepted = true;
          for (const sourceArtboardId of [...gesture.artboardIds]) {
            const source = manager.document.getArtboard(sourceArtboardId);
            const plan = source ? prepareDuplicateArtboard(manager.document, sourceArtboardId) : null;
            if (!source || !plan) {
              accepted = false;
              break;
            }
            for (const operation of plan.operations) {
              if (!executeSafely(operation)) {
                accepted = false;
                break;
              }
            }
            if (!accepted) break;
            const offsetBack = {
              x: source.frame.x - plan.artboard.frame.x,
              y: source.frame.y - plan.artboard.frame.y,
            };
            const duplicated = manager.document.getArtboard(plan.artboard.id);
            if (!duplicated) {
              accepted = false;
              break;
            }
            const frame = {
              ...duplicated.frame,
              x: duplicated.frame.x + offsetBack.x,
              y: duplicated.frame.y + offsetBack.y,
            };
            if (!executeSafely({
              type: 'UPDATE_ARTBOARD',
              payload: { artboardId: duplicated.id, updates: { frame } },
            })) {
              accepted = false;
              break;
            }
            duplicateArtboardIds.push(duplicated.id);
            duplicateFrames.push({ artboardId: duplicated.id, frame });
            for (const object of manager.document.objectsForArtboard(duplicated.id)) {
              const transform = {
                ...object.transform,
                x: object.transform.x + offsetBack.x,
                y: object.transform.y + offsetBack.y,
              };
              if (!executeSafely({ type: 'UPDATE_OBJECT', payload: { objectId: object.id, updates: { transform } } })) {
                accepted = false;
                break;
              }
              duplicateObjects.push({ objectId: object.id, transform });
            }
            if (!accepted) break;
          }
          if (!accepted || duplicateArtboardIds.length === 0) {
            manager.rollbackTransaction();
            gestureRef.current = null;
            onNotice('Artboard duplication was rejected; the source was left unchanged.', 'error');
            return;
          }
          gesture.artboardIds = duplicateArtboardIds;
          gesture.frames = duplicateFrames;
          gesture.objects = duplicateObjects;
          onSelectionChange({ mode: 'object', objectIds: new Set(), nodeIds: new Set(), segmentIds: new Set() });
          onArtboardSelectionChange(new Set(duplicateArtboardIds));
        }
        gesture.moving = true;
      }
      if (gesture.moving) {
        let delta = { x: world.x - gesture.startWorld.x, y: world.y - gesture.startWorld.y };
        const anchorFrame = gesture.frames.find((item) => item.artboardId === gesture.artboardIds[0])?.frame;
        if (anchorFrame) {
          const excludedNodeIds = new Set(gesture.artboardIds.flatMap((artboardId) =>
            manager.document.objectsForArtboard(artboardId).flatMap((object) =>
              manager.document.getNetwork(object.networkId)?.nodeIds ?? [])));
          const snapped = snapPoint(manager.document, {
            x: anchorFrame.x + delta.x,
            y: anchorFrame.y + delta.y,
          }, { scale: viewport.scale, excludeNodeIds: excludedNodeIds });
          delta = { x: snapped.point.x - anchorFrame.x, y: snapped.point.y - anchorFrame.y };
          snapPreviewRef.current = snapped;
        }
        for (const original of gesture.frames) {
          const artboard = manager.document.getArtboard(original.artboardId);
          if (!artboard) continue;
          const target = { ...original.frame, x: original.frame.x + delta.x, y: original.frame.y + delta.y };
          if (Math.abs(artboard.frame.x - target.x) > 1e-9 || Math.abs(artboard.frame.y - target.y) > 1e-9) {
            manager.execute({
              type: 'UPDATE_ARTBOARD',
              payload: { artboardId: artboard.id, updates: { frame: target } },
            });
          }
        }
        for (const original of gesture.objects) {
          const object = manager.document.getObject(original.objectId);
          if (!object) continue;
          const target = { ...original.transform, x: original.transform.x + delta.x, y: original.transform.y + delta.y };
          if (Math.abs(object.transform.x - target.x) > 1e-9 || Math.abs(object.transform.y - target.y) > 1e-9) {
            manager.execute({ type: 'UPDATE_OBJECT', payload: { objectId: object.id, updates: { transform: target } } });
          }
        }
        requestRender();
      }
      return;
    }
    if (gesture.kind === 'resize-artboard') {
      if (!gesture.moving && screenDistance(screen, gesture.startScreen) >= 3) {
        manager.beginTransaction('Resize artboard');
        gesture.moving = true;
      }
      if (gesture.moving) {
        const next = resizedArtboardFrame(
          gesture.frame,
          gesture.handle,
          { x: world.x - gesture.startWorld.x, y: world.y - gesture.startWorld.y },
          event.shiftKey,
          event.altKey || altPressedRef.current,
        );
        const current = manager.document.getArtboard(gesture.artboardId);
        if (current) {
          const originDelta = { x: next.x - current.frame.x, y: next.y - current.frame.y };
          if (Math.abs(originDelta.x) > 1e-9 || Math.abs(originDelta.y) > 1e-9) {
            manager.execute({
              type: 'UPDATE_ARTBOARD',
              payload: { artboardId: current.id, updates: { frame: { ...current.frame, x: next.x, y: next.y } } },
            });
            for (const object of manager.document.objectsForArtboard(current.id)) {
              manager.execute({
                type: 'UPDATE_OBJECT',
                payload: {
                  objectId: object.id,
                  updates: {
                    transform: {
                      ...object.transform,
                      x: object.transform.x + originDelta.x,
                      y: object.transform.y + originDelta.y,
                    },
                  },
                },
              });
            }
          }
          if (Math.abs(current.frame.width - next.width) > 1e-9 || Math.abs(current.frame.height - next.height) > 1e-9) {
            manager.execute({
              type: 'UPDATE_ARTBOARD_DIMENSIONS',
              payload: { artboardId: current.id, width: next.width, height: next.height },
            });
          }
        }
        requestRender();
      }
      return;
    }
    if (gesture.kind === 'construction') {
      const snapped = snapPoint(manager.document, world, { scale: viewport.scale });
      gesture.currentWorld = snapped.point;
      gesture.constrain = event.shiftKey;
      snapPreviewRef.current = snapped;
      constructionPreviewRef.current = {
        start: gesture.startWorld,
        end: snapped.point,
        constrain: event.shiftKey,
        extent: constructionExtentRef.current,
      };
      requestRender();
      return;
    }
    if (gesture.kind === 'primitive') {
      const snapped = snapPoint(manager.document, world, { scale: viewport.scale });
      gesture.currentWorld = snapped.point;
      snapPreviewRef.current = snapped;
      primitivePreviewRef.current = {
        kind: gesture.primitive,
        start: gesture.startWorld,
        end: snapped.point,
        constrain: event.shiftKey,
        fromCenter: event.altKey || altPressedRef.current,
      };
      requestRender();
      return;
    }
    if (gesture.kind === 'pencil') {
      if (screenDistance(screen, gesture.lastScreen) >= 2) {
        gesture.points.push(world);
        gesture.lastScreen = screen;
        pencilPreviewRef.current = { points: gesture.points, color: drawingStyle.strokeColor, width: drawingStyle.strokeWidth };
        requestRender();
      }
      return;
    }
    if (gesture.kind === 'brush') {
      if (screenDistance(screen, gesture.lastScreen) >= 2) {
        const pressure = event.pressure > 0 ? event.pressure : 0.5;
        gesture.samples.push({ point: world, pressure });
        gesture.lastScreen = screen;
        pencilPreviewRef.current = {
          points: gesture.samples.map((sample) => sample.point),
          widths: gesture.samples.map((sample) => Math.max(0.5, drawingStyle.strokeWidth * (0.3 + sample.pressure * 1.4))),
          color: drawingStyle.strokeColor,
          width: drawingStyle.strokeWidth,
        };
        requestRender();
      }
      return;
    }
    if (gesture.kind === 'pen') {
      penPreviewRef.current = screenDistance(screen, gesture.startScreen) >= 3
        ? { kind: 'handles', anchor: gesture.previewAnchor, cursor: world }
        : undefined;
      requestRender();
      return;
    }
    if (gesture.kind === 'cut') {
      gesture.currentWorld = localWorld;
      cutPreviewRef.current = { start: gesture.startWorld, end: localWorld };
      requestRender();
      return;
    }
    if (gesture.kind === 'eraser') {
      const distance = screenDistance(screen, gesture.lastScreen);
      const spacing = Math.max(2, eraserSettings.weight * 0.18);
      const steps = Math.max(1, Math.ceil(distance / spacing));
      try {
        for (let index = 1; index <= steps; index += 1) {
          const t = index / steps;
          const sampleScreen = {
            x: gesture.lastScreen.x + (screen.x - gesture.lastScreen.x) * t,
            y: gesture.lastScreen.y + (screen.y - gesture.lastScreen.y) * t,
          };
          eraseAtPoint(viewport.screenToWorld(sampleScreen), gesture.gapNodeIds);
        }
        gesture.lastScreen = screen;
        eraserPreviewRef.current = {
          point: localWorld,
          radius: Math.max(0.5, eraserSettings.weight / 2),
          shape: eraserSettings.shape,
        };
      } catch (error) {
        manager.rollbackTransaction();
        gestureRef.current = null;
        onNotice(error instanceof Error ? error.message : 'The brushed path area could not be erased.', 'error');
        console.warn('Erase drag rejected by constraint pre-validation.', error);
      }
      requestRender();
      return;
    }
    if (gesture.kind === 'lasso') {
      if (screenDistance(screen, gesture.lastScreen) >= 3) {
        gesture.points.push(localWorld);
        gesture.lastScreen = screen;
        lassoPreviewRef.current = [...gesture.points];
        requestRender();
      }
      return;
    }
    if (gesture.kind === 'marquee') {
      gesture.currentWorld = world;
      marqueePreviewRef.current = {
        start: gesture.startWorld,
        end: world,
        mode: world.x >= gesture.startWorld.x ? 'contain' : 'intersect',
      };
      requestRender();
      return;
    }
    if (gesture.kind === 'network-marquee') {
      gesture.currentLocal = localWorld;
      marqueePreviewRef.current = {
        start: gesture.startLocal,
        end: localWorld,
        mode: localWorld.x >= gesture.startLocal.x ? 'contain' : 'intersect',
      };
      requestRender();
      return;
    }
    if (gesture.kind === 'bend-node') {
      const node = manager.document.getNode(gesture.nodeId);
      if (node && screenDistance(screen, gesture.startScreen) >= 2) {
        bendPreviewRef.current = { kind: 'handles', anchor: node.position, cursor: localWorld };
      }
      requestRender();
      return;
    }
    if (gesture.kind === 'bend-segment') {
      const payload = convertSegmentFromDrag(manager.document, gesture.segmentId, localWorld);
      const segment = manager.document.getSegment(gesture.segmentId);
      if (payload && segment && screenDistance(screen, gesture.startScreen) >= (gesture.direct ? 4 : 2)) {
        const curve = segmentCurve(manager.document, segment);
        if (curve) {
          bendPreviewRef.current = {
            kind: 'curve',
            curve: { ...curve, p1: payload.startHandleOut, p2: payload.endHandleIn },
          };
        }
      }
      requestRender();
      return;
    }
    if (gesture.kind === 'width') {
      const segment = manager.document.getSegment(gesture.handle.segmentId);
      if (!segment) return;
      gesture.moving = true;
      const widthProfile = updateWidthPoint(
        manager.document,
        segment,
        gesture.handle.pointId,
        gesture.handle.kind,
        gesture.handle.side,
        localWorld,
      );
      if (!executeSafely({
        type: 'SET_SEGMENT_WIDTH_PROFILE',
        payload: { segmentId: segment.id, widthProfile },
      })) {
        manager.rollbackTransaction();
        gestureRef.current = null;
      }
      return;
    }
    if (gesture.kind === 'bend-handle') {
      if (!gesture.moving && screenDistance(screen, gesture.startScreen) >= 2) {
        manager.beginTransaction('Adjust Bézier handle');
        gesture.moving = true;
      }
      if (gesture.moving) {
        const node = manager.document.getNode(gesture.hit.nodeId);
        if (node && !executeSafely({
          type: 'ADJUST_HANDLE',
          payload: adjustHandlePayload(
            node,
            gesture.hit.handleType,
            localWorld,
            node.handleMode === 'corner' ? 'independent' : node.handleMode === 'smooth' ? 'angle' : node.handleMode === 'symmetric' ? 'mirror' : bendModeRef.current,
          ),
        })) {
          manager.rollbackTransaction();
          gestureRef.current = null;
        }
      }
      return;
    }

    if (gesture.kind === 'parametric-control') {
      if (!gesture.moving && screenDistance(screen, gesture.startScreen) >= 2) {
        manager.beginTransaction('Move Parametric Group control');
        gesture.moving = true;
      }
      if (!gesture.moving) return;
      const group = manager.document.parametricGroups.get(gesture.groupId);
      if (!group) {
        manager.rollbackTransaction();
        gestureRef.current = null;
        return;
      }
      let accepted = true;
      if (group.transform.type === 'mirror' && group.transform.axisSegmentId) {
        const segment = manager.document.getSegment(group.transform.axisSegmentId);
        const referenceObject = segment ? manager.document.getObjectForSegment(segment.id) : undefined;
        const inverse = referenceObject
          ? inverseMatrix(objectTransformMatrix(referenceObject.transform))
          : undefined;
        if (!segment || (referenceObject && manager.document.isObjectLocked(referenceObject.id))) {
          accepted = false;
        } else {
          const previous = inverse ? transformPoint(gesture.lastWorld, inverse) : gesture.lastWorld;
          const current = inverse ? transformPoint(world, inverse) : world;
          const delta = { x: current.x - previous.x, y: current.y - previous.y };
          const start = manager.document.getNode(segment.startNodeId);
          const end = manager.document.getNode(segment.endNodeId);
          accepted = Boolean(start && end) && executeSafely({
            type: 'SET_NODE_POSITIONS',
            payload: { positions: start && end ? [
              { nodeId: start.id, position: { x: start.position.x + delta.x, y: start.position.y + delta.y } },
              { nodeId: end.id, position: { x: end.position.x + delta.x, y: end.position.y + delta.y } },
            ] : [] },
          });
        }
      } else if (group.transform.type === 'radial' && group.transform.centerNodeId) {
        const referenceObject = manager.document.getObjectForNode(group.transform.centerNodeId);
        const inverse = referenceObject
          ? inverseMatrix(objectTransformMatrix(referenceObject.transform))
          : undefined;
        if (referenceObject && manager.document.isObjectLocked(referenceObject.id)) {
          accepted = false;
        } else {
          const previous = inverse ? transformPoint(gesture.lastWorld, inverse) : gesture.lastWorld;
          const current = inverse ? transformPoint(world, inverse) : world;
          accepted = executeSafely({
            type: 'MOVE_NODE',
            payload: {
              nodeId: group.transform.centerNodeId,
              delta: { x: current.x - previous.x, y: current.y - previous.y },
            },
          });
        }
      } else {
        const sourceObjectId = parametricSourceObjectId(manager.document, group);
        const sourceObject = sourceObjectId ? manager.document.getObject(sourceObjectId) : undefined;
        const inverse = sourceObject
          ? inverseMatrix(objectTransformMatrix(sourceObject.transform))
          : undefined;
        const local = inverse ? transformPoint(world, inverse) : world;
        accepted = executeSafely({
          type: 'UPDATE_PARAMETRIC_GROUP',
          payload: {
            groupId: group.id,
            updates: {
              transform: group.transform.type === 'mirror'
                ? { ...group.transform, origin: local }
                : { ...group.transform, center: local },
            },
          },
        });
      }
      if (!accepted) {
        manager.rollbackTransaction();
        gestureRef.current = null;
        onNotice('Unlock or repair the referenced construction geometry before moving this control.', 'error');
        return;
      }
      gesture.lastWorld = world;
      return;
    }

    if (gesture.kind === 'move-object') {
      if (!gesture.moving && screenDistance(screen, gesture.startScreen) >= 2) {
        manager.beginTransaction(
          gesture.duplicateOnDrag
            ? gesture.objectIds.length > 1 ? 'Duplicate and move objects' : 'Duplicate and move object'
            : gesture.objectIds.length > 1 ? 'Move objects' : 'Move object',
        );
        if (gesture.duplicateOnDrag) {
          const duplicateIds: EntityId[] = [];
          let accepted = true;
          for (const sourceId of gesture.objectIds) {
            const source = manager.document.getObject(sourceId);
            const plan = source ? prepareDuplicateObject(manager.document, sourceId) : null;
            if (!source || !plan) {
              accepted = false;
              break;
            }
            for (const operation of plan.operations) {
              if (!executeSafely(operation)) {
                accepted = false;
                break;
              }
            }
            if (!accepted) break;
            if (!executeSafely({
              type: 'UPDATE_OBJECT',
              payload: { objectId: plan.objectId, updates: { transform: { ...source.transform } } },
            })) {
              accepted = false;
              break;
            }
            duplicateIds.push(plan.objectId);
          }
          if (!accepted || duplicateIds.length === 0) {
            manager.rollbackTransaction();
            gestureRef.current = null;
            return;
          }
          gesture.objectIds = duplicateIds;
          onSelectionChange({ mode: 'object', objectIds: new Set(duplicateIds), nodeIds: new Set(), segmentIds: new Set() });
        }
        gesture.moving = true;
      }
      if (!gesture.moving) return;
      const delta = { x: world.x - gesture.lastWorld.x, y: world.y - gesture.lastWorld.y };
      if (delta.x !== 0 || delta.y !== 0) {
        for (const objectId of gesture.objectIds) {
          const object = manager.document.getObject(objectId);
          if (object && !executeSafely({
            type: 'UPDATE_OBJECT',
            payload: {
              objectId,
              updates: { transform: { ...object.transform, x: object.transform.x + delta.x, y: object.transform.y + delta.y } },
            },
          })) {
            manager.rollbackTransaction();
            gestureRef.current = null;
            return;
          }
        }
      }
      gesture.lastWorld = world;
      return;
    }

    if (!gesture.moving && screenDistance(screen, gesture.startScreen) >= 2) {
      manager.beginTransaction(gesture.nodeIds.length > 1 ? 'Move nodes' : 'Move node');
      gesture.moving = true;
    }
    if (!gesture.moving) return;
    const movingNodeIds = new Set(gesture.nodeIds);
    const owningConstructionSegmentIds = new Set(
      [...manager.document.segments.values()]
        .filter((segment) => segment.role === 'construction' &&
          (movingNodeIds.has(segment.startNodeId) || movingNodeIds.has(segment.endNodeId)))
        .map((segment) => segment.id),
    );
    const snapped = snapPoint(manager.document, world, {
      scale: viewport.scale,
      excludeNodeIds: movingNodeIds,
      excludeSegmentIds: owningConstructionSegmentIds,
    });
    snapPreviewRef.current = snapped;
    const snappedLocal = editingLocalPoint(snapped.point);
    const delta = { x: snappedLocal.x - gesture.lastWorld.x, y: snappedLocal.y - gesture.lastWorld.y };
    if (delta.x !== 0 || delta.y !== 0) {
      for (const nodeId of gesture.nodeIds) {
        if (!executeSafely({ type: 'MOVE_NODE', payload: { nodeId, delta: { ...delta } } })) {
          manager.rollbackTransaction();
          gestureRef.current = null;
          return;
        }
      }
    } else {
      requestRender();
    }
    gesture.lastWorld = snappedLocal;
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const canvas = canvasRef.current!;
    const screen = localPoint(event);
    const world = viewportRef.current.screenToWorld(screen);
    const localWorld = editingLocalPoint(world);

    if (gesture.kind === 'construction') {
      const input = {
        start: gesture.startWorld,
        end: gesture.currentWorld,
        constrain: gesture.constrain || event.shiftKey,
        extent: constructionExtentRef.current,
      };
      void import('../tools/construction-tool')
        .then(({ prepareConstructionLineObject }) => {
          const prepared = prepareConstructionLineObject(manager.document, input.start, input.end, {
            extent: input.extent,
            constrain: input.constrain,
          });
          if (!prepared.ok) {
            onNotice(prepared.message, 'error');
            return;
          }
          try {
            manager.beginTransaction('Create construction line');
            for (const operation of prepared.plan.operations) manager.execute(operation);
            manager.commitTransaction();
            onSelectionChange({
              mode: 'object',
              objectIds: new Set([prepared.plan.objectId]),
              nodeIds: new Set(),
              segmentIds: new Set(),
            });
          } catch (error) {
            manager.rollbackTransaction();
            onNotice(
              error instanceof Error ? error.message : 'Construction line creation was rejected.',
              'error',
            );
          }
        })
        .catch(() => onNotice('Construction line tools could not be loaded.', 'error'));
    } else if (gesture.kind === 'primitive') {
      const preview = primitivePreviewRef.current;
      const plan = screenDistance(screen, gesture.startScreen) >= 2
        ? preparePrimitiveObject(manager.document, gesture.primitive, gesture.startWorld, gesture.currentWorld, {
            constrain: preview?.constrain ?? event.shiftKey,
            fromCenter: preview?.fromCenter ?? event.altKey,
            cornerRadius: primitiveSettings.cornerRadius,
            sides: gesture.primitive === 'star' ? primitiveSettings.starPoints : primitiveSettings.polygonSides,
            starInnerRatio: primitiveSettings.starInnerRatio,
            style: drawingStyle,
          })
        : null;
      if (plan) {
        try {
          manager.beginTransaction(`Create ${plan.name.toLowerCase()}`);
          for (const operation of plan.operations) manager.execute(operation);
          manager.commitTransaction();
          onSelectionChange({
            mode: 'object', objectIds: new Set([plan.objectId]), nodeIds: new Set(), segmentIds: new Set(),
          });
        } catch (error) {
          manager.rollbackTransaction();
          console.warn(`${plan.name} creation was rejected.`, error);
        }
      }
    } else if (gesture.kind === 'width') {
      manager.commitTransaction();
    } else if (gesture.kind === 'eraser') {
      const candidateNodeIds = [...new Set(gesture.gapNodeIds)];
      for (const nodeId of candidateNodeIds) {
        const node = manager.document.getNode(nodeId);
        if (!node || manager.document.connectedSegments(nodeId).length > 0) continue;
        const network = manager.document.networks.find((item) => item.nodeIds.includes(nodeId));
        if (!network) continue;
        manager.execute({
          type: 'REMOVE_NODE',
          payload: { node, networkId: network.id, index: network.nodeIds.indexOf(nodeId) },
        });
      }
      manager.commitTransaction();
      const survivingGapNodes = candidateNodeIds.filter((nodeId) =>
        manager.document.getNode(nodeId) && manager.document.connectedSegments(nodeId).length > 0);
      if (survivingGapNodes.length > 0) {
        onSelectionChange(networkSelection(
          manager.document,
          survivingGapNodes,
          [],
          selectionRef.current.editingObjectId,
        ));
      }
    } else if ((gesture.kind === 'move' || gesture.kind === 'move-object' || gesture.kind === 'move-artboard' || gesture.kind === 'resize-artboard' || gesture.kind === 'parametric-control') && gesture.moving) {
      manager.commitTransaction();
    } else if (gesture.kind === 'move-artboard' && gesture.duplicateOnDrag) {
      const selected = manager.document.getArtboard(gesture.artboardIds[0]);
      if (selected && manager.document.activeArtboardId !== selected.id) {
        manager.execute({ type: 'SET_ACTIVE_LOCATION', payload: { pageId: selected.pageId, artboardId: selected.id } });
      }
    } else if (gesture.kind === 'marquee') {
      const moved = screenDistance(screen, gesture.startScreen) >= 2;
      const mode = gesture.currentWorld.x >= gesture.startWorld.x ? 'contain' : 'intersect';
      const minX = Math.min(gesture.startWorld.x, gesture.currentWorld.x);
      const maxX = Math.max(gesture.startWorld.x, gesture.currentWorld.x);
      const minY = Math.min(gesture.startWorld.y, gesture.currentWorld.y);
      const maxY = Math.max(gesture.startWorld.y, gesture.currentWorld.y);
      const matched = moved
        ? manager.document.objectsForArtboard(manager.document.activeArtboardId)
          .filter((object) => !manager.document.isObjectLocked(object.id))
          .filter((object) => {
            const bounds = objectBounds(manager.document, object.id, INTERACTION_BOUNDS_POLICY);
            if (bounds.width <= 1e-6 && bounds.height <= 1e-6) return false;
            return mode === 'contain'
              ? bounds.minX >= minX && bounds.maxX <= maxX && bounds.minY >= minY && bounds.maxY <= maxY
              : bounds.maxX >= minX && bounds.minX <= maxX && bounds.maxY >= minY && bounds.minY <= maxY;
          })
          .map((object) => object.id)
        : [];
      const matchedArtboards = moved
        ? manager.document.activePage.artboardIds
          .map((id) => manager.document.getArtboard(id))
          .filter((artboard) => artboard !== undefined)
          .filter((artboard) => {
            const frame = artboard.frame;
            const right = frame.x + frame.width;
            const bottom = frame.y + frame.height;
            return mode === 'contain'
              ? frame.x >= minX && right <= maxX && frame.y >= minY && bottom <= maxY
              : right >= minX && frame.x <= maxX && bottom >= minY && frame.y <= maxY;
          })
          .map((artboard) => artboard.id)
        : [];
      if (matchedArtboards.length > 0 || gesture.baseArtboardIds.length > 0) {
        onArtboardSelectionChange(new Set([...gesture.baseArtboardIds, ...matchedArtboards]));
        onSelectionChange({ mode: 'object', objectIds: new Set(), nodeIds: new Set(), segmentIds: new Set() });
      } else {
        onArtboardSelectionChange(new Set());
        onSelectionChange({
          mode: 'object',
          objectIds: new Set([...gesture.baseIds, ...matched]),
          nodeIds: new Set(),
          segmentIds: new Set(),
        });
      }
    } else if (gesture.kind === 'network-marquee') {
      const moved = screenDistance(screen, gesture.startScreen) >= 2;
      const minX = Math.min(gesture.startLocal.x, gesture.currentLocal.x);
      const maxX = Math.max(gesture.startLocal.x, gesture.currentLocal.x);
      const minY = Math.min(gesture.startLocal.y, gesture.currentLocal.y);
      const maxY = Math.max(gesture.startLocal.y, gesture.currentLocal.y);
      const editingObject = selectionRef.current.editingObjectId
        ? manager.document.getObject(selectionRef.current.editingObjectId)
        : undefined;
      const network = editingObject ? manager.document.getNetwork(editingObject.networkId) : undefined;
      const matched = moved
        ? (network?.nodeIds ?? [])
          .map((nodeId) => manager.document.getNode(nodeId))
          .filter((node): node is NonNullable<typeof node> => node !== undefined && !manager.document.isNodeLocked(node.id))
          .filter((node) => node.position.x >= minX && node.position.x <= maxX &&
            node.position.y >= minY && node.position.y <= maxY)
          .map((node) => node.id)
        : [];
      onSelectionChange(networkSelection(
        manager.document,
        [...gesture.baseNodeIds, ...matched],
        gesture.baseSegmentIds,
        selectionRef.current.editingObjectId,
      ));
    } else if (gesture.kind === 'lasso') {
      const enclosed = gesture.points.length >= 3
        ? [...manager.document.nodes.values()]
          .filter((node) => !selectionRef.current.editingObjectId ||
            manager.document.getObjectForNode(node.id)?.id === selectionRef.current.editingObjectId)
          .filter((node) => pointInPolygon(node.position, gesture.points))
          .map((node) => node.id)
        : [];
      onSelectionChange(networkSelection(
        manager.document,
        event.shiftKey ? [...selectionRef.current.nodeIds, ...enclosed] : enclosed,
        event.shiftKey ? selectionRef.current.segmentIds : [],
        selectionRef.current.editingObjectId,
      ));
    } else if (gesture.kind === 'pencil') {
      if (screenDistance(screen, gesture.lastScreen) >= 1) gesture.points.push(world);
      const plan = preparePencilObject(manager.document, gesture.points, drawingStyle);
      if (plan && executeSafely({ type: 'BATCH', payload: { label: 'Draw pencil path', operations: plan.operations } })) {
        onSelectionChange({ mode: 'object', objectIds: new Set([plan.objectId]), nodeIds: new Set(), segmentIds: new Set() });
      }
    } else if (gesture.kind === 'brush') {
      if (screenDistance(screen, gesture.lastScreen) >= 1) {
        gesture.samples.push({ point: world, pressure: event.pressure > 0 ? event.pressure : 0.5 });
      }
      const plan = prepareBrushObject(manager.document, gesture.samples, drawingStyle);
      if (plan && executeSafely({ type: 'BATCH', payload: { label: 'Draw brush path', operations: plan.operations } })) {
        onSelectionChange({ mode: 'object', objectIds: new Set([plan.objectId]), nodeIds: new Set(), segmentIds: new Set() });
      }
    } else if (gesture.kind === 'pen') {
      const dragged = screenDistance(screen, gesture.startScreen) >= 3;
      const endpoint = gesture.local ? localWorld : world;
      const result = penToolRef.current.placePoint({
        position: gesture.anchor,
        handleVector: dragged
          ? { x: endpoint.x - gesture.anchor.x, y: endpoint.y - gesture.anchor.y }
          : undefined,
        closeTolerance: 9 / viewportRef.current.scale,
        allowClose: !dragged,
        targetNetworkId: gesture.targetNetworkId,
        targetObjectId: gesture.targetObjectId,
        coordinateSpace: gesture.local ? 'local' : 'world',
      });
      if (result.nodeId) onSelectionChange(networkSelection(manager.document, [result.nodeId], [], result.objectId));
      else if (result.closed) onSelectionChange(networkSelection(manager.document, [], [], result.objectId));
    } else if (gesture.kind === 'cut') {
      const dragged = screenDistance(screen, gesture.startScreen) >= 4;
      try {
        if (dragged) {
          const cut = prepareCutPaths(manager.document, gesture.startWorld, localWorld);
          if (cut && executeSafely({ type: 'CUT_PATHS', payload: cut })) {
            onSelectionChange(networkSelection(
              manager.document,
              cut.newNodes.map((node) => node.id),
              cut.newSegments.map((segment) => segment.id),
            ));
          }
        } else {
          const hit = hitTest(manager.document, world, 8 / viewportRef.current.scale, selectionRef.current.editingObjectId);
          if (hit?.kind === 'segment') {
            const split = prepareSplitAtPoint(manager.document, hit.id, localWorld);
            if (split && executeSafely({ type: 'SPLIT_SEGMENT', payload: split })) {
              onSelectionChange(networkSelection(
                manager.document,
                [split.newNodeId],
                [split.newSegment1Id, split.newSegment2Id],
              ));
            }
          }
        }
      } catch (error) {
        onNotice(error instanceof Error ? error.message : 'Cut could not split this segment.', 'error');
      }
    } else if (gesture.kind === 'bend-node') {
      const node = manager.document.getNode(gesture.nodeId);
      if (node) {
        const payload = screenDistance(screen, gesture.startScreen) >= 3
          ? addHandlesFromDrag(node, localWorld)
          : defaultHandlesForNode(manager.document, node);
        if (executeSafely({ type: 'ADD_BEZIER_HANDLES', payload })) {
          onSelectionChange(networkSelection(manager.document, [node.id]));
        }
      }
    } else if (gesture.kind === 'bend-segment') {
      if (screenDistance(screen, gesture.startScreen) >= (gesture.direct ? 4 : 2)) {
        const payload = convertSegmentFromDrag(manager.document, gesture.segmentId, localWorld);
        if (payload) executeSafely({ type: 'CONVERT_TO_BEZIER', payload });
      }
    } else if (gesture.kind === 'bend-handle' && gesture.moving) {
      manager.commitTransaction();
    }

    gestureRef.current = null;
    clearPreviews();
    canvas.classList.remove('is-panning');
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    requestRender();
  };

  const handlePointerCancel = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const gesture = gestureRef.current;
    if (gesture?.kind === 'width' || gesture?.kind === 'eraser' ||
      ((gesture?.kind === 'move' || gesture?.kind === 'move-object' || gesture?.kind === 'move-artboard' || gesture?.kind === 'resize-artboard' || gesture?.kind === 'parametric-control' || gesture?.kind === 'bend-handle') && gesture.moving)) {
      manager.rollbackTransaction();
    }
    gestureRef.current = null;
    clearPreviews();
    canvasRef.current?.classList.remove('is-panning');
    requestRender();
    if (canvasRef.current?.hasPointerCapture(event.pointerId)) canvasRef.current.releasePointerCapture(event.pointerId);
  };

  const updateHover = (world: Point, constrainPen = false) => {
    const localWorld = editingLocalPoint(world);
    const canvas = canvasRef.current;
    if (canvas && toolRef.current === 'select' && selectionRef.current.mode === 'object') {
      const artboardHit = hitTestArtboard(manager.document, world, viewportRef.current.scale, selectedArtboardIdsRef.current);
      canvas.style.cursor = artboardHit
        ? isArtboardResizeHandle(artboardHit.part)
          ? artboardResizeCursor(artboardHit.part)
          : 'move'
        : '';
    } else if (canvas) {
      canvas.style.cursor = toolRef.current === 'pen' ? PEN_CURSOR : '';
    }
    penPreviewRef.current = toolRef.current === 'pen'
      ? (() => {
          const editingObject = selectionRef.current.mode === 'network' && selectionRef.current.editingObjectId
            ? manager.document.getObject(selectionRef.current.editingObjectId)
            : undefined;
          const objectMatrix = editingObject ? objectTransformMatrix(editingObject.transform) : undefined;
          const hit = editingObject
            ? hitTest(manager.document, world, 8 / viewportRef.current.scale, editingObject.id)
            : undefined;
          let target: { point: Point; targetKind: 'node' | 'segment' } | undefined;
          if (editingObject && objectMatrix && hit?.kind === 'node') {
            const node = manager.document.getNode(hit.id);
            if (node) target = { point: transformPoint(node.position, objectMatrix), targetKind: 'node' };
          } else if (editingObject && objectMatrix && hit?.kind === 'segment') {
            const segment = manager.document.getSegment(hit.id);
            const closest = segment ? closestPointOnSegment(manager.document, segment, localWorld) : undefined;
            if (closest) target = { point: transformPoint(closest.point, objectMatrix), targetKind: 'segment' };
          }
          const rawCursor = penToolRef.current.activeCoordinateSpace === 'local' ? localWorld : world;
          const previewCursor = constrainPen && penToolRef.current.hasActivePath
            ? penToolRef.current.constrainPosition(rawCursor)
            : rawCursor;
          const continuation = penToolRef.current.continuationPreview(
            previewCursor,
            9 / viewportRef.current.scale,
          );
          if (continuation) {
            const matrix = continuation.coordinateSpace === 'local' && continuation.objectId
              ? objectTransformMatrix(manager.document.getObject(continuation.objectId)?.transform ?? { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 })
              : undefined;
            const map = (point: Point | undefined) => point && matrix ? transformPoint(point, matrix) : point;
            return {
              kind: 'continuation' as const,
              start: map(continuation.start)!,
              cursor: target?.point ?? map(continuation.cursor)!,
              controlOut: map(continuation.controlOut),
              closeTarget: map(continuation.closeTarget),
              willClose: continuation.willClose,
              targetKind: target?.targetKind,
            };
          }
          return target ? { kind: 'target' as const, ...target } : undefined;
        })()
      : undefined;
    hoveredRegionRef.current = undefined;
    hoveredNodeRef.current = undefined;
    hoveredSegmentRef.current = undefined;
    hoveredHandleRef.current = undefined;
    eraserPreviewRef.current = toolRef.current === 'eraser'
      ? { point: localWorld, radius: Math.max(0.5, eraserSettings.weight / 2), shape: eraserSettings.shape }
      : undefined;
    if (toolRef.current === 'select' && selectionRef.current.mode === 'network') {
      const handle = hitTestHandle(
        manager.document,
        selectionRef.current.nodeIds,
        localWorld,
        8 / viewportRef.current.scale,
      );
      if (handle) {
        hoveredHandleRef.current = handle;
        if (canvas) canvas.style.cursor = 'move';
      } else {
        const hit = hitTest(
          manager.document,
          world,
          7 / viewportRef.current.scale,
          selectionRef.current.editingObjectId,
        );
        if (hit?.kind === 'node') {
          hoveredNodeRef.current = hit.id;
          if (canvas) canvas.style.cursor = 'move';
        } else if (hit?.kind === 'segment') {
          hoveredSegmentRef.current = hit.id;
          const segment = manager.document.getSegment(hit.id);
          if (canvas && canDirectBendSegment(segment)) canvas.style.cursor = 'grab';
        }
      }
    } else if (toolRef.current === 'shape-builder' || toolRef.current === 'paint') {
      hoveredRegionRef.current = regionAtPoint(manager.document, world)?.id;
    } else if (toolRef.current === 'cut' || toolRef.current === 'offset') {
      const hit = hitTest(manager.document, world, 7 / viewportRef.current.scale, selectionRef.current.editingObjectId);
      if (hit?.kind === 'segment') hoveredSegmentRef.current = hit.id;
    } else if (toolRef.current === 'eraser') {
      const radiusPx = Math.max(0.5, eraserSettings.weight / 2);
      const hit = hitTestSegment(
        manager.document,
        world,
        radiusPx * (eraserSettings.shape === 'square' ? Math.SQRT2 : 1) / viewportRef.current.scale,
        selectionRef.current.editingObjectId,
      );
      if (hit?.kind === 'segment') hoveredSegmentRef.current = hit.id;
      if (canvas) canvas.style.cursor = 'none';
    } else if (toolRef.current === 'bend') {
      const handle = hitTestHandle(manager.document, selectionRef.current.nodeIds, localWorld, 8 / viewportRef.current.scale);
      if (handle) hoveredHandleRef.current = handle;
      else {
        const hit = hitTest(manager.document, world, 7 / viewportRef.current.scale, selectionRef.current.editingObjectId);
        if (hit?.kind === 'segment') hoveredSegmentRef.current = hit.id;
      }
    }
    requestRender();
  };

  const handleWheel = useCallback((event: globalThis.WheelEvent) => {
    event.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const intent = wheelIntent(event, rect.height);
    if (intent.kind === 'zoom') {
      viewportRef.current.zoomAt({ x: event.clientX - rect.left, y: event.clientY - rect.top }, intent.factor);
      onViewportChange(viewportRef.current.scale);
    } else {
      // The sheet follows the gesture: scrolling down walks you down the canvas.
      viewportRef.current.panBy(-intent.deltaX, -intent.deltaY);
    }
    requestRender();
  }, [onViewportChange, requestRender]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.addEventListener('wheel', handleWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', handleWheel);
  }, [handleWheel]);

  return (
    <div className="canvas-wrap">
      {rendererMode === 'webgl' && <canvas ref={webglCanvasRef} className="webgl-canvas" aria-hidden="true" />}
      <canvas
        ref={canvasRef}
        className={`vector-canvas tool-${activeTool}`}
        aria-label="Vector drawing canvas"
        tabIndex={0}
        onContextMenu={(event) => {
          event.preventDefault();
          onOpenConstraintMenu(event.clientX, event.clientY);
        }}
        onPointerDown={handlePointerDown}
        onDoubleClick={handleDoubleClick}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onPointerLeave={() => {
          onPresenceCursor(undefined);
          if (!gestureRef.current) {
            hoveredRegionRef.current = undefined;
            hoveredNodeRef.current = undefined;
            hoveredSegmentRef.current = undefined;
            hoveredHandleRef.current = undefined;
            eraserPreviewRef.current = undefined;
            requestRender();
          }
        }}
      />
      {artboardRename && (
        <input
          autoFocus
          className="canvas-artboard-name-input"
          aria-label="Artboard name on canvas"
          value={artboardRename.value}
          style={{ left: artboardRename.left, top: artboardRename.top, width: artboardRename.width }}
          onChange={(event) => setArtboardRename((current) => current ? { ...current, value: event.target.value } : current)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              artboardRenameCancelledRef.current = true;
              setArtboardRename(undefined);
              canvasRef.current?.focus();
            }
          }}
          onBlur={(event) => {
            const current = artboardRename;
            setArtboardRename(undefined);
            if (artboardRenameCancelledRef.current) {
              artboardRenameCancelledRef.current = false;
              return;
            }
            const name = event.currentTarget.value.trim();
            const artboard = manager.document.getArtboard(current.artboardId);
            if (name && artboard && name !== artboard.name) {
              manager.execute({ type: 'UPDATE_ARTBOARD', payload: { artboardId: artboard.id, updates: { name } } });
            }
          }}
        />
      )}
      {manager.document.isolatedLayerId && (
        <div className="isolation-banner" role="status">
          <span>Editing only <strong>{layerBreadcrumb(manager.document, manager.document.isolatedLayerId)}</strong></span>
          <button type="button" onClick={() => manager.execute({ type: 'SET_LAYER_ISOLATION', payload: { layerId: undefined } })}>Exit isolation</button>
        </div>
      )}
      {selection.mode === 'network' && (
        <div className="vector-edit-toolbar" role="toolbar" aria-label="Vector edit tools">
          <span className="vector-edit-toolbar-label">Editing <b>{selection.editingObjectId ? manager.document.getObject(selection.editingObjectId)?.name ?? 'vector' : 'vector'}</b></span>
          {([
            ['select', 'Move', 'V'],
            ['pen', 'Add point', 'P'],
          ] as Array<[ToolId, string, string]>).map(([tool, label, shortcut]) => (
            <VectorEditToolbarButton
              key={tool}
              tool={tool}
              label={label}
              shortcut={shortcut}
              active={activeTool === tool}
              onClick={() => onRequestToolChange(tool)}
            />
          ))}
          <span className="vector-edit-toolbar-divider" aria-hidden="true" />
          {([
            ['bend', 'Bend', 'D'],
            ['cut', 'Split', 'X'],
          ] as Array<[ToolId, string, string]>).map(([tool, label, shortcut]) => (
            <VectorEditToolbarButton
              key={tool}
              tool={tool}
              label={label}
              shortcut={shortcut}
              active={activeTool === tool}
              disabledReason={toolDisabledReasons[tool]}
              onClick={() => onRequestToolChange(tool)}
            />
          ))}
          <div className="vector-edit-toolbar-more">
            <button
              type="button"
              className={(['width', 'shape-builder', 'eraser', 'lasso', 'paint'] as ToolId[]).includes(activeTool) ? 'is-active' : ''}
              aria-label="More vector tools"
              aria-expanded={vectorMoreOpen}
              onClick={() => setVectorMoreOpen((open) => !open)}
            >
              More <span aria-hidden="true">⌄</span>
            </button>
            {vectorMoreOpen && (
              <div className="vector-edit-toolbar-menu" role="group" aria-label="More vector tools">
                {([
                  ['width', 'Width', 'W'],
                  ['shape-builder', 'Build', 'B'],
                  ['eraser', 'Eraser', 'Shift+E'],
                  ['lasso', 'Lasso', 'Q'],
                  ['paint', 'Paint', 'Shift+B'],
                ] as Array<[ToolId, string, string]>).map(([tool, label, shortcut]) => (
                  <VectorEditToolbarButton
                    key={tool}
                    tool={tool}
                    label={label}
                    shortcut={shortcut}
                    active={activeTool === tool}
                    disabledReason={toolDisabledReasons[tool]}
                    onClick={() => {
                      setVectorMoreOpen(false);
                      onRequestToolChange(tool);
                    }}
                  />
                ))}
              </div>
            )}
          </div>
          <span className="vector-edit-toolbar-divider" aria-hidden="true" />
          <button
            type="button"
            className="vector-edit-toolbar-done"
            onClick={() => {
              penToolRef.current.endPath();
              onSelectionChange(exitNetworkEditMode(selectionRef.current));
              onRequestToolChange('select');
              canvasRef.current?.focus();
            }}
          >
            Done <kbd>Esc</kbd>
          </button>
        </div>
      )}
      <nav
        className="canvas-tool-rail"
        aria-label="Canvas tools"
        onMouseOver={(event) => showRailTooltip(event.target, setRailTooltip)}
        onMouseOut={(event) => {
          const next = event.relatedTarget;
          if (!(next instanceof Node) || !event.currentTarget.contains(next)) setRailTooltip(undefined);
        }}
        onFocus={(event) => showRailTooltip(event.target, setRailTooltip)}
        onBlur={(event) => {
          const next = event.relatedTarget;
          if (!(next instanceof Node) || !event.currentTarget.contains(next)) setRailTooltip(undefined);
        }}
      >
        <CanvasRailGroup
          name="Select"
          open={railGroupOpen === 'select'}
          active={activeTool === 'select' && (selection.mode !== 'network' || networkSelectExplicit)}
          primaryLabel="Select (V)"
          icon={<CursorIcon size={18} />}
          onPrimary={() => {
            if (selection.mode === 'network') setNetworkSelectExplicit(true);
            onRequestToolChange('select');
          }}
          onToggle={() => setRailGroupOpen((open) => open === 'select' ? undefined : 'select')}
        >
          <CanvasFlyoutTool label="Select" description="Move and pick shapes" shortcut="V" active={activeTool === 'select'} icon={<CursorIcon size={16} />} onClick={() => { onRequestToolChange('select'); setRailGroupOpen(undefined); }} />
          <CanvasFlyoutTool label="Lasso" description="Draw around points to pick them" shortcut="Q" active={activeTool === 'lasso'} icon={<MultiSelectIcon size={16} />} onClick={() => { onRequestToolChange('lasso'); setRailGroupOpen(undefined); }} />
        </CanvasRailGroup>
        <CanvasRailGroup
          name="Draw"
          open={railGroupOpen === 'draw'}
          active={activeTool === 'pen' || (selection.mode === 'network' && activeTool === 'select' && !networkSelectExplicit)}
          primaryLabel="Pen (P)"
          icon={<PenRailIcon />}
          onPrimary={() => onRequestToolChange('pen')}
          onToggle={() => setRailGroupOpen((open) => open === 'draw' ? undefined : 'draw')}
        >
          <CanvasFlyoutTool label="Pen" shortcut="P" active={activeTool === 'pen' || selection.mode === 'network' && activeTool === 'select'} onClick={() => { onRequestToolChange('pen'); setRailGroupOpen(undefined); }} />
          <CanvasFlyoutTool label="Pencil" shortcut="N" active={activeTool === 'pencil'} onClick={() => { onRequestToolChange('pencil'); setRailGroupOpen(undefined); }} />
          <CanvasFlyoutTool label="Brush" shortcut="J" active={activeTool === 'brush'} onClick={() => { onRequestToolChange('brush'); setRailGroupOpen(undefined); }} />
          <CanvasFlyoutTool label="Line" shortcut={'\\'} active={activeTool === 'line'} onClick={() => { onRequestToolChange('line'); setRailGroupOpen(undefined); }} />
          <CanvasFlyoutTool label="Arc" shortcut="A" active={activeTool === 'arc'} onClick={() => { onRequestToolChange('arc'); setRailGroupOpen(undefined); }} />
          <CanvasFlyoutTool label="Guide line" description="(not exported)" shortcut="⇧\" active={activeTool === 'construction-line'} onClick={() => { onRequestToolChange('construction-line'); setRailGroupOpen(undefined); }} />
        </CanvasRailGroup>
        <CanvasRailGroup
          name="Shapes"
          open={railGroupOpen === 'shapes'}
          active={activeTool === 'rectangle'}
          primaryLabel="Rectangle (R)"
          icon={<ShapeRailIcon />}
          onPrimary={() => onRequestToolChange('rectangle')}
          onToggle={() => setRailGroupOpen((open) => open === 'shapes' ? undefined : 'shapes')}
        >
          <CanvasFlyoutTool label="Rectangle" shortcut="R" active={activeTool === 'rectangle'} icon={<SquareIcon size={16} />} onClick={() => { onRequestToolChange('rectangle'); setRailGroupOpen(undefined); }} />
          <CanvasFlyoutTool label="Rounded rectangle" active={activeTool === 'rounded-rectangle'} icon={<SquareFillIcon size={16} />} onClick={() => { onRequestToolChange('rounded-rectangle'); setRailGroupOpen(undefined); }} />
          <CanvasFlyoutTool label="Ellipse" shortcut="U" active={activeTool === 'ellipse'} icon={<CircleIcon size={16} />} onClick={() => { onRequestToolChange('ellipse'); setRailGroupOpen(undefined); }} />
          <CanvasFlyoutTool label="Polygon" active={activeTool === 'polygon'} icon={<DiamondIcon size={16} />} onClick={() => { onRequestToolChange('polygon'); setRailGroupOpen(undefined); }} />
          <CanvasFlyoutTool label="Star" active={activeTool === 'star'} icon={<StarIcon size={16} />} onClick={() => { onRequestToolChange('star'); setRailGroupOpen(undefined); }} />
        </CanvasRailGroup>
        <CanvasRailGroup
          name="Edit shape"
          open={railGroupOpen === 'edit'}
          active={activeTool === 'bend'}
          primaryLabel="Bend (D)"
          icon={<BendRailIcon />}
          disabledReason={toolDisabledReasons.bend}
          onPrimary={() => onRequestToolChange('bend')}
          onToggle={() => setRailGroupOpen((open) => open === 'edit' ? undefined : 'edit')}
        >
          <CanvasFlyoutTool label="Bend" description="Drag a line into a curve" shortcut="D" active={activeTool === 'bend'} disabledReason={toolDisabledReasons.bend} onClick={() => { onRequestToolChange('bend'); setRailGroupOpen(undefined); }} />
          <CanvasFlyoutTool label="Cut" description="Split a path at a point" shortcut="X" active={activeTool === 'cut'} onClick={() => { onRequestToolChange('cut'); setRailGroupOpen(undefined); }} />
          <CanvasFlyoutTool label="Round corner" description="Smooth with a true arc" shortcut="F" active={activeTool === 'fillet'} disabledReason={toolDisabledReasons.fillet} onClick={() => { onRequestToolChange('fillet'); setRailGroupOpen(undefined); }} />
          <CanvasFlyoutTool label="Offset" description="Copy a path at a set distance" shortcut="O" active={activeTool === 'offset'} disabledReason={toolDisabledReasons.offset} onClick={() => { onRequestToolChange('offset'); setRailGroupOpen(undefined); }} />
          <CanvasFlyoutTool label="Stroke width" description="Thicker or thinner along a line" shortcut="W" active={activeTool === 'width'} disabledReason={toolDisabledReasons.width} onClick={() => { onRequestToolChange('width'); setRailGroupOpen(undefined); }} />
          <CanvasFlyoutTool label="Eraser" description="Remove a piece, keep the shape" shortcut="⇧E" active={activeTool === 'eraser'} icon={<EraserRailIcon />} onClick={() => { onRequestToolChange('eraser'); setRailGroupOpen(undefined); }} />
        </CanvasRailGroup>
        <CanvasRailGroup
          name="Combine"
          open={railGroupOpen === 'build'}
          active={activeTool === 'shape-builder'}
          primaryLabel="Shape Builder (B)"
          icon={<BuildRailIcon />}
          onPrimary={() => onRequestToolChange('shape-builder')}
          onToggle={() => setRailGroupOpen((open) => open === 'build' ? undefined : 'build')}
        >
          <CanvasFlyoutTool label="Shape builder" description="Drag across overlaps to merge or cut" shortcut="B" active={activeTool === 'shape-builder'} icon={<StackAddIcon size={16} />} onClick={() => { onRequestToolChange('shape-builder'); setRailGroupOpen(undefined); }} />
          <CanvasFlyoutTool label="Fill areas" description="Click inside a closed area to colour it" shortcut="⇧B" active={activeTool === 'paint'} disabledReason={toolDisabledReasons.paint} icon={<PaintbrushIcon size={16} />} onClick={() => { onRequestToolChange('paint'); setRailGroupOpen(undefined); }} />
        </CanvasRailGroup>
        <div className="canvas-tool-proxies" aria-label="Direct tool access">
          <CanvasToolProxy index={0} active={activeTool === 'pencil'} label="Pencil (N)" onClick={() => onRequestToolChange('pencil')} icon={<PencilIcon size={18} />} />
          <CanvasToolProxy index={1} active={activeTool === 'brush'} label="Brush (J)" onClick={() => onRequestToolChange('brush')} icon={<PaintbrushIcon size={18} />} />
          <CanvasToolProxy index={2} active={activeTool === 'rounded-rectangle'} label="Rounded Rectangle" onClick={() => onRequestToolChange('rounded-rectangle')} icon={<SquareFillIcon size={18} />} />
          <CanvasToolProxy index={3} active={activeTool === 'ellipse'} label="Ellipse (U)" onClick={() => onRequestToolChange('ellipse')} icon={<CircleIcon size={18} />} />
          <CanvasToolProxy index={4} active={activeTool === 'polygon'} label="Polygon" onClick={() => onRequestToolChange('polygon')} icon={<DiamondIcon size={18} />} />
          <CanvasToolProxy index={5} active={activeTool === 'star'} label="Star" onClick={() => onRequestToolChange('star')} icon={<StarIcon size={18} />} />
          <CanvasToolProxy index={6} active={activeTool === 'line'} label="Line (Backslash)" onClick={() => onRequestToolChange('line')} icon={<DashIcon size={18} />} />
          <CanvasToolProxy index={7} active={activeTool === 'construction-line'} label="Construction Line (Shift+\)" onClick={() => onRequestToolChange('construction-line')} icon={<ConstructionLineRailIcon />} />
          <CanvasToolProxy index={8} active={activeTool === 'arc'} label="Arc" onClick={() => onRequestToolChange('arc')} icon={<CircleSlashIcon size={18} />} />
          <CanvasToolProxy index={9} active={activeTool === 'paint'} label="Paint (Shift+B)" disabledReason={toolDisabledReasons.paint} onClick={() => onRequestToolChange('paint')} icon={<PaintbrushIcon size={18} />} />
          <CanvasToolProxy index={10} active={activeTool === 'cut'} label="Cut (X)" onClick={() => onRequestToolChange('cut')} icon={<UnlinkIcon size={18} />} />
          <CanvasToolProxy index={11} active={activeTool === 'fillet'} label="Fillet (F)" disabledReason={toolDisabledReasons.fillet} onClick={() => onRequestToolChange('fillet')} icon={<IterationsIcon size={18} />} />
          <CanvasToolProxy index={12} active={activeTool === 'width'} label="Variable Width (W)" disabledReason={toolDisabledReasons.width} onClick={() => onRequestToolChange('width')} icon={<ArrowBothIcon size={18} />} />
          <CanvasToolProxy index={13} active={activeTool === 'offset'} label="Offset (O)" disabledReason={toolDisabledReasons.offset} onClick={() => onRequestToolChange('offset')} icon={<DuplicateIcon size={18} />} />
          <CanvasToolProxy index={14} active={activeTool === 'lasso'} label="Lasso (Q)" onClick={() => onRequestToolChange('lasso')} icon={<MultiSelectIcon size={18} />} />
          <CanvasToolProxy index={15} active={activeTool === 'eraser'} label="Eraser (Shift+E)" onClick={() => onRequestToolChange('eraser')} icon={<EraserRailIcon />} />
        </div>
      </nav>
      <div className="canvas-hint" aria-hidden="true">{toolHint(activeTool, selection, selectedArtboardIds.size)}</div>
      {railTooltip && createPortal(
        <div id="canvas-rail-tooltip" className="canvas-rail-tooltip" role="tooltip" style={{ left: railTooltip.x, top: railTooltip.y }}>
          {railTooltip.label}
        </div>,
        window.document.body,
      )}
    </div>
  );
}

function showRailTooltip(
  target: EventTarget,
  setTooltip: (tooltip: { label: string; x: number; y: number } | undefined) => void,
): void {
  const element = target instanceof Element ? target.closest<HTMLButtonElement>('.canvas-tool-rail button') : null;
  const label = element?.dataset.label;
  if (!element || !label) return;
  const rect = element.getBoundingClientRect();
  setTooltip({
    label,
    x: Math.min(window.innerWidth - 190, rect.right + 10),
    y: Math.max(8, Math.min(window.innerHeight - 36, rect.top + rect.height / 2)),
  });
}

function VectorEditToolbarButton({
  tool,
  label,
  shortcut,
  active,
  disabledReason,
  onClick,
}: {
  tool: ToolId;
  label: string;
  shortcut: string;
  active: boolean;
  disabledReason?: string;
  onClick: () => void;
}) {
  const accessibleLabel = tool === 'shape-builder'
    ? 'Shape builder'
    : tool === 'pen' && label === 'Add point'
      ? 'Pen'
      : tool === 'cut' && label === 'Split'
        ? 'Cut'
        : label;
  return (
    <button
      type="button"
      data-tool={tool}
      className={active ? 'is-active' : ''}
      aria-label={accessibleLabel}
      aria-pressed={active}
      aria-keyshortcuts={shortcut}
      title={disabledReason ?? `${accessibleLabel} (${shortcut})`}
      disabled={Boolean(disabledReason)}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function CanvasRailGroup({
  name,
  open,
  active,
  primaryLabel,
  icon,
  disabledReason,
  onPrimary,
  onToggle,
  children,
}: {
  name: string;
  open: boolean;
  active: boolean;
  primaryLabel: string;
  icon: React.ReactNode;
  disabledReason?: string;
  onPrimary: () => void;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="canvas-rail-group">
      <button
        type="button"
        className={`canvas-rail-primary${active ? ' is-active' : ''}`}
        aria-label={primaryLabel}
        aria-describedby="canvas-rail-tooltip"
        title={disabledReason ?? primaryLabel}
        data-label={disabledReason ? `${primaryLabel} — ${disabledReason}` : primaryLabel}
        disabled={Boolean(disabledReason)}
        onClick={onPrimary}
      >
        <span className="canvas-tool-icon" aria-hidden="true">{icon}</span>
      </button>
      <button
        type="button"
        className="canvas-rail-flyout-trigger"
        aria-label={`Open ${name} tools`}
        aria-expanded={open}
        onClick={onToggle}
      ><span aria-hidden="true" /></button>
      {open && (
        <div className="canvas-tool-flyout" role="group" aria-label={`${name} tools`}>
          <span className="canvas-tool-flyout-title">{name}</span>
          {children}
        </div>
      )}
    </div>
  );
}

function CanvasFlyoutTool({
  label,
  description,
  shortcut,
  active,
  icon,
  disabledReason,
  onClick,
}: {
  label: string;
  description?: string;
  shortcut?: string;
  active: boolean;
  icon?: React.ReactNode;
  disabledReason?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`canvas-flyout-tool${active ? ' is-active' : ''}`}
      aria-label={label}
      aria-pressed={active}
      title={disabledReason}
      disabled={Boolean(disabledReason)}
      onClick={onClick}
    >
      {icon && <span className="canvas-flyout-tool-icon" aria-hidden="true">{icon}</span>}
      <span className="canvas-flyout-tool-copy"><strong>{label}</strong>{description && <small>{description}</small>}</span>
      {shortcut && <kbd>{shortcut}</kbd>}
    </button>
  );
}

function CanvasToolProxy({
  index,
  active,
  label,
  icon,
  disabledReason,
  onClick,
}: {
  index: number;
  active: boolean;
  label: string;
  icon: React.ReactNode;
  disabledReason?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`canvas-tool-proxy${active ? ' is-active' : ''}`}
      style={{ top: `${54 + index * 3}px` }}
      aria-label={label}
      title={label}
      data-label={disabledReason ? `${label} — ${disabledReason}` : label}
      disabled={Boolean(disabledReason)}
      onClick={onClick}
    ><span aria-hidden="true">{icon}</span></button>
  );
}

function PenRailIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="m12 3 7 7-3 3-7-7 3-3Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
      <path d="m9 6-5 11 4 3 11-5" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx="8.5" cy="15.5" r="1.3" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

function ShapeRailIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="4" width="16" height="16" rx="2" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
    </svg>
  );
}

function BendRailIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 18C8 6 16 6 20 18" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <circle cx="12" cy="9" r="1.8" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
}

function BuildRailIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="9" cy="12" r="5.5" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="15" cy="12" r="5.5" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
}

function EraserRailIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path d="m3.2 10.8 6.8-7.2a1.8 1.8 0 0 1 2.55-.06l2.1 1.98a1.8 1.8 0 0 1 .06 2.55L8.2 15H6.05l-2.8-2.64a1.08 1.08 0 0 1-.05-1.56Z" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinejoin="round" />
      <path d="m7 6.8 4.8 4.5M8.2 15h6.6" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" />
    </svg>
  );
}

function ConstructionLineRailIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path d="M2 14.5 16 3.5" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 2" strokeLinecap="round" />
      <circle cx="6" cy="11.35" r="1.2" fill="currentColor" />
      <circle cx="12" cy="6.65" r="1.2" fill="currentColor" />
    </svg>
  );
}

function toolHint(tool: ToolId, selection: SelectionState, selectedArtboardCount = 0) {
  if (tool === 'select' && selection.mode === 'network') {
    return <><span>Drag points to move</span><span className="hint-separator">·</span><span>Drag a path to bend</span><span className="hint-separator">·</span><kbd>Shift</kbd><span>select more</span></>;
  }
  if (tool === 'select' && selectedArtboardCount > 0) {
    return <><span className="hint-dot select" />Drag frame to move · <kbd>Alt</kbd>-drag duplicate · Drag edge or corner handles to resize · <kbd>Delete</kbd> remove</>;
  }
  if (tool === 'select' && selection.objectIds.size === 1) {
    return <><span className="hint-dot select" />Drag to move · <kbd>Alt</kbd>-drag duplicate · <kbd>Double-click</kbd> or <kbd>Enter</kbd> edit vector points</>;
  }
  if (tool === 'pen' && selection.mode === 'network') {
    return <><span className="hint-dot pen" />Click to add · <kbd>Shift</kbd> constrain 45° · <kbd>Drag</kbd> curve · Click node to connect · Click path to insert · <kbd>Esc</kbd> finish</>;
  }
  if (tool === 'pen') return <><span className="hint-dot pen" />Click to draw · <kbd>Shift</kbd> constrain 45° · <kbd>Drag</kbd> curves · <kbd>Esc</kbd> end path</>;
  if (tool === 'pencil') return <><span className="hint-dot pen" />Drag to draw a smooth editable path <kbd>N</kbd></>;
  if (tool === 'brush') return <><span className="hint-dot pen" />Drag to draw a pressure-aware variable-width path <kbd>J</kbd></>;
  if (tool === 'rectangle') return <><span className="hint-dot build" />Drag a rectangle <kbd>Shift</kbd> square <kbd>Alt</kbd> from center</>;
  if (tool === 'ellipse') return <><span className="hint-dot build" />Drag an ellipse <kbd>Shift</kbd> circle <kbd>Alt</kbd> from center</>;
  if (tool === 'rounded-rectangle') return <><span className="hint-dot build" />Drag a rounded rectangle <kbd>Shift</kbd> equal sides</>;
  if (tool === 'polygon' || tool === 'star') return <><span className="hint-dot build" />Drag a {tool} <kbd>Shift</kbd> regular <kbd>Alt</kbd> from center</>;
  if (tool === 'line') return <><span className="hint-dot pen" />Drag a line <kbd>Shift</kbd> constrain to 45°</>;
  if (tool === 'construction-line') return <><span className="hint-dot pen" />Drag a construction line <kbd>Shift</kbd> constrain to 45°</>;
  if (tool === 'arc') return <><span className="hint-dot bend" />Drag a native semicircular arc <kbd>Shift</kbd> equal bounds</>;
  if (tool === 'shape-builder') return <><span className="hint-dot build" />Click face to add <kbd>Alt</kbd> subtract <kbd>Esc</kbd> exit</>;
  if (tool === 'cut') return <><span className="hint-dot cut" />Click to split <kbd>Drag</kbd> cut line <kbd>Esc</kbd> exit</>;
  if (tool === 'bend') return <><span className="hint-dot bend" />Drag nodes, segments, or handles <kbd>Esc</kbd> exit</>;
  if (tool === 'fillet') return <><span className="hint-dot bend" />Click a two-line corner to create a constrained true arc <kbd>Esc</kbd> exit</>;
  if (tool === 'paint') return <><span className="hint-dot build" />Click a striped region to fill <kbd>Alt</kbd> clear fill <kbd>Shift B</kbd></>;
  if (tool === 'width') return <><span className="hint-dot bend" />Click to add width <kbd>Drag</kbd> edit <kbd>Alt</kbd> remove point</>;
  if (tool === 'offset') return <><span className="hint-dot cut" />Click a path to offset <kbd>Alt</kbd> opposite side</>;
  if (tool === 'lasso') return <><span className="hint-dot select" />Draw around nodes <kbd>Shift</kbd> add to selection</>;
  if (tool === 'eraser') return <><span className="hint-dot cut" />Click and drag to erase with the current weight and tip shape</>;
  return <><span className="hint-dot select" />Select and drag objects <kbd>Drag empty space</kbd> marquee <kbd>← intersect</kbd> <kbd>Shift</kbd> add</>;
}

function hitTestArtboard(
  document: VectorDocument,
  point: Point,
  scale: number,
  selectedIds: Set<EntityId>,
): ArtboardHit | undefined {
  const artboards = [...document.activePage.artboardIds].reverse()
    .map((id) => document.getArtboard(id))
    .filter((artboard): artboard is Artboard => Boolean(artboard) && !artboard?.isCanvasRoot);
  const handleRadius = 8 / Math.max(scale, 1e-9);
  for (const artboard of artboards) {
    const { x, y, width, height } = artboard.frame;
    if (selectedIds.has(artboard.id)) {
      const handles: Array<{ part: ArtboardResizeHandle; point: Point }> = [
        { part: 'nw', point: { x, y } },
        { part: 'n', point: { x: x + width / 2, y } },
        { part: 'ne', point: { x: x + width, y } },
        { part: 'e', point: { x: x + width, y: y + height / 2 } },
        { part: 'se', point: { x: x + width, y: y + height } },
        { part: 's', point: { x: x + width / 2, y: y + height } },
        { part: 'sw', point: { x, y: y + height } },
        { part: 'w', point: { x, y: y + height / 2 } },
      ];
      const handle = handles.find((item) =>
        Math.abs(point.x - item.point.x) <= handleRadius && Math.abs(point.y - item.point.y) <= handleRadius);
      if (handle) return { artboardId: artboard.id, part: handle.part };
    }
    const titleWidth = Math.max(82, artboard.name.length * 7 + (artboard.clipContent ? 30 : 0)) / Math.max(scale, 1e-9);
    if (point.x >= x - 4 / scale && point.x <= x + titleWidth && point.y >= y - 28 / scale && point.y <= y - 2 / scale) {
      return { artboardId: artboard.id, part: 'title' };
    }
    const tolerance = 6 / Math.max(scale, 1e-9);
    const within = point.x >= x - tolerance && point.x <= x + width + tolerance &&
      point.y >= y - tolerance && point.y <= y + height + tolerance;
    const nearEdge = Math.abs(point.x - x) <= tolerance || Math.abs(point.x - (x + width)) <= tolerance ||
      Math.abs(point.y - y) <= tolerance || Math.abs(point.y - (y + height)) <= tolerance;
    if (within && nearEdge) return { artboardId: artboard.id, part: 'border' };
  }
  return undefined;
}

function isArtboardResizeHandle(value: ArtboardHit['part']): value is ArtboardResizeHandle {
  return value === 'nw' || value === 'n' || value === 'ne' || value === 'e' ||
    value === 'se' || value === 's' || value === 'sw' || value === 'w';
}

function artboardResizeCursor(handle: ArtboardResizeHandle): string {
  if (handle === 'n' || handle === 's') return 'ns-resize';
  if (handle === 'e' || handle === 'w') return 'ew-resize';
  return handle === 'nw' || handle === 'se' ? 'nwse-resize' : 'nesw-resize';
}

function resizedArtboardFrame(
  frame: { x: number; y: number; width: number; height: number },
  handle: ArtboardResizeHandle,
  delta: Point,
  preserveRatio: boolean,
  fromCenter: boolean,
) {
  const east = handle === 'ne' || handle === 'e' || handle === 'se';
  const west = handle === 'nw' || handle === 'w' || handle === 'sw';
  const north = handle === 'nw' || handle === 'n' || handle === 'ne';
  const south = handle === 'se' || handle === 's' || handle === 'sw';
  const changesWidth = east || west;
  const changesHeight = north || south;
  const center = { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
  let width = changesWidth
    ? Math.max(1, frame.width + (east ? delta.x : -delta.x) * (fromCenter ? 2 : 1))
    : frame.width;
  let height = changesHeight
    ? Math.max(1, frame.height + (south ? delta.y : -delta.y) * (fromCenter ? 2 : 1))
    : frame.height;
  if (preserveRatio) {
    const ratio = frame.width / Math.max(frame.height, 1e-9);
    if (changesWidth && !changesHeight) height = width / ratio;
    else if (changesHeight && !changesWidth) width = height * ratio;
    else if (width / height > ratio) height = width / ratio;
    else width = height * ratio;
  }
  const centerWidth = fromCenter || (preserveRatio && !changesWidth);
  const centerHeight = fromCenter || (preserveRatio && !changesHeight);
  let x = centerWidth ? center.x - width / 2 : east ? frame.x : frame.x + frame.width - width;
  let y = centerHeight ? center.y - height / 2 : south ? frame.y : frame.y + frame.height - height;
  x = Math.round(x * 1000) / 1000;
  y = Math.round(y * 1000) / 1000;
  width = Math.round(width * 1000) / 1000;
  height = Math.round(height * 1000) / 1000;
  return { x, y, width, height };
}

function networkSelection(
  document: VectorDocument,
  nodeIds: Iterable<EntityId> = [],
  segmentIds: Iterable<EntityId> = [],
  preferredObjectId?: EntityId,
): SelectionState {
  const nodes = new Set(nodeIds);
  const segments = new Set(segmentIds);
  const firstNodeId = nodes.values().next().value as EntityId | undefined;
  const firstSegmentId = segments.values().next().value as EntityId | undefined;
  const object = preferredObjectId
    ? document.getObject(preferredObjectId)
    : firstNodeId
      ? document.getObjectForNode(firstNodeId)
      : firstSegmentId
        ? document.getObjectForSegment(firstSegmentId)
        : undefined;
  return {
    mode: 'network',
    editingObjectId: object?.id,
    objectIds: object ? new Set([object.id]) : new Set(),
    nodeIds: nodes,
    segmentIds: segments,
  };
}

function hitParametricControl(
  document: VectorDocument,
  selection: SelectionState,
  point: Point,
  tolerance: number,
): EntityId | undefined {
  const selectedObjectIds = new Set(selection.objectIds);
  if (selection.editingObjectId) selectedObjectIds.add(selection.editingObjectId);
  const groups = [...document.parametricGroups.values()];
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index];
    const objectId = parametricSourceObjectId(document, group);
    if (!objectId || !selectedObjectIds.has(objectId) || document.isObjectLocked(objectId)) continue;
    const object = document.getObject(objectId);
    const resolved = resolveParametricTransform(document, group);
    if (!object || !resolved) continue;
    const local = resolved.type === 'mirror' ? resolved.origin : resolved.center;
    const documentPoint = transformPoint(local, objectTransformMatrix(object.transform));
    if (screenDistance(documentPoint, point) <= tolerance) return group.id;
  }
  return undefined;
}

function isPrimitiveTool(tool: ToolId): tool is PrimitiveKind {
  return tool === 'rectangle' || tool === 'rounded-rectangle' || tool === 'ellipse' || tool === 'polygon' ||
    tool === 'star' || tool === 'line' || tool === 'arc';
}

function screenDistance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function layerBreadcrumb(document: VectorDocument, layerId: EntityId): string {
  const names: string[] = [];
  let layer = document.getLayer(layerId);
  while (layer) {
    names.unshift(layer.name);
    layer = layer.parentId ? document.getLayer(layer.parentId) : undefined;
  }
  return names.join(' / ');
}

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ||
    target instanceof HTMLButtonElement || target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable);
}
