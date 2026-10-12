import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { VectorCanvas } from './canvas/VectorCanvas';
import type {
  CollaborationSession,
  CollaborationStatus,
  CollaboratorPresence,
} from './collaboration/session';
import { createConstraintsForSelection } from './constraints/catalog';
import { WasmConstraintWorkerClient } from './constraints/worker-client';
import {
  createVectorClipboardPayload,
  parseVectorClipboard,
  preparePasteObjects,
  serializeVectorClipboard,
  type VectorClipboardPayload,
} from './core/clipboard';
import { deleteArtboardsTransactional, prepareCreateIconArtboard, prepareDuplicateArtboard } from './core/artboard-operations';
import { VectorDocument } from './core/document';
import { DEFAULT_DRAWING_STYLE, normalizeDrawingStyle, normalizeStoredDrawingStyle } from './core/drawing-style';
import { evaluateSegment } from './core/geometry';
import type { GeometryConflictResolution } from './core/geometry-components';
import { createEntityId } from './core/ids';
import { ARTWORK_BOUNDS_POLICY, objectBounds } from './core/object-geometry';
import { OperationManager, type SegmentRoleUpdate } from './core/operations';
import { pathHasConstruction, selectionIsConstructionOnly } from './core/segment-semantics';
import { prepareDeleteObject, prepareFlipObjects } from './core/object-operations';
import { DEFAULT_DOCUMENT_NAME, DocumentPersistence, listDocuments, loadDocumentById, markStoredDocumentImported, type SaveStatus } from './core/store';
import type {
  Appearance,
  AppearanceRule,
  ConstructionExtent,
  Constraint,
  ConstraintConflict,
  ConstraintType,
  DrawingStyle,
  EntityId,
  HandleMirrorMode,
  NetworkObject,
  ParametricTransform,
  Segment,
  SelectionState,
  ToolId,
} from './core/types';
import { emptySelection, enterNetworkEditMode, exitNetworkEditMode } from './tools/select-tool';
import { prepareBulkNodePositions, type BulkNodeAction } from './tools/lasso-tool';
import { preparePrimitiveObject } from './tools/primitive-tool';
import { connectedSelection, prepareClosePath, prepareDeletePoint, prepareJoinEndpoints, prepareReversePath } from './tools/path-commands';
import { prepareSplitAtPoint } from './tools/cut-tool';
import { ConstraintContextMenu, ConstraintPalette } from './ui/ConstraintPalette';
import { ConstraintDiagnostics } from './ui/ConstraintDiagnostics';
import { StatusBar } from './ui/StatusBar';
import { Toolbar } from './ui/Toolbar';
import { drawnObjectCount, drawnObjectsForArtboard, realArtboards } from './core/real-content';
import { Dashboard, type StartAction } from './ui/Dashboard';
import type { AppearanceUpdates, QuickEditPlan, QuickEditTarget } from './core/quick-edit';
import { CommandBar, type CommandItem } from './ui/CommandBar';
import { analyzeConsistency, type ConsistencyReport } from './core/consistency';
import { analyzeTidy, applyTidy, type TidyAnalysis, type TidyRuleId } from './import/tidy';
import { placeImportedPayload } from './import/import-preview';
import type { SvgImportResult } from './import/svg-import';
import { DEFAULT_MOTION_SETTINGS, buildAnimatedSvg, clampMotionSettings, type MotionSettings } from './export/motion-export';
import { MODIFIER_LABEL } from './ui/Toolbar';

const LayersPanel = lazy(async () => {
  const module = await import('./ui/LayersPanel');
  return { default: module.LayersPanel };
});
const PropertiesPanel = lazy(async () => {
  const module = await import('./ui/PropertiesPanel');
  return { default: module.PropertiesPanel };
});
const ExportDialog = lazy(async () => {
  const module = await import('./ui/ExportDialog');
  return { default: module.ExportDialog };
});
const ShareDialog = lazy(async () => {
  const module = await import('./ui/KeylineDialogs');
  return { default: module.ShareDialog };
});
const SettingsDialog = lazy(async () => {
  const module = await import('./ui/KeylineDialogs');
  return { default: module.SettingsDialog };
});
const ImportTidyDialog = lazy(async () => {
  const module = await import('./ui/KeylineDialogs');
  return { default: module.ImportTidyDialog };
});
const MotionDialog = lazy(async () => {
  const module = await import('./ui/KeylineDialogs');
  return { default: module.MotionDialog };
});
const ConsistencyDialog = lazy(async () => {
  const module = await import('./ui/KeylineDialogs');
  return { default: module.ConsistencyDialog };
});
const FamilyCollectionDialog = lazy(async () => {
  const module = await import('./ui/FamilyCollectionDialog');
  return { default: module.FamilyCollectionDialog };
});

interface Runtime {
  document: VectorDocument;
  manager: OperationManager;
}

type Route =
  | { kind: 'loading' }
  | { kind: 'dashboard' }
  | { kind: 'editor'; runtime: Runtime; name: string; start?: StartAction; loadError: boolean };

function setDocParam(id: string | null, mode: 'push' | 'replace', options: { keepRoom?: boolean } = {}) {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set('doc', id);
  else url.searchParams.delete('doc');
  if (!options.keepRoom) url.searchParams.delete('room');
  window.history[mode === 'push' ? 'pushState' : 'replaceState']({}, '', url);
}

export default function App() {
  const [route, setRoute] = useState<Route>({ kind: 'loading' });

  const openFromUrl = useCallback(async (cancelled: () => boolean) => {
    const params = new URLSearchParams(window.location.search);
    const docId = params.get('doc');
    const room = params.get('room');
    try {
      if (docId) {
        const stored = await loadDocumentById(docId);
        if (cancelled()) return;
        if (stored) {
          setRoute({ kind: 'editor', runtime: { document: stored.document, manager: new OperationManager(stored.document) }, name: stored.name, loadError: false });
          return;
        }
        setDocParam(null, 'replace', { keepRoom: true });
      }
      if (room) {
        // Joining a shared link always starts a fresh file so it can never overwrite one of your own.
        const document = VectorDocument.createEmpty();
        if (!cancelled()) setRoute({ kind: 'editor', runtime: { document, manager: new OperationManager(document) }, name: 'Shared drawing', loadError: false });
        return;
      }
      const files = await listDocuments();
      if (cancelled()) return;
      if (files.length === 0) {
        // First visit: skip the files page and go straight to "What are you drawing?".
        const document = VectorDocument.createEmpty();
        setDocParam(document.id, 'replace');
        setRoute({ kind: 'editor', runtime: { document, manager: new OperationManager(document) }, name: DEFAULT_DOCUMENT_NAME, loadError: false });
      } else {
        setRoute({ kind: 'dashboard' });
      }
    } catch (error) {
      console.error('Unable to restore the local document.', error);
      if (cancelled()) return;
      const document = VectorDocument.createEmpty();
      setRoute({ kind: 'editor', runtime: { document, manager: new OperationManager(document) }, name: DEFAULT_DOCUMENT_NAME, loadError: true });
    }
  }, []);

  useEffect(() => {
    let stale = false;
    void openFromUrl(() => stale);
    const onPop = () => { setRoute({ kind: 'loading' }); void openFromUrl(() => stale); };
    window.addEventListener('popstate', onPop);
    return () => { stale = true; window.removeEventListener('popstate', onPop); };
  }, [openFromUrl]);

  const openDocument = useCallback((id: string) => {
    setDocParam(id, 'push');
    setRoute({ kind: 'loading' });
    void openFromUrl(() => false);
  }, [openFromUrl]);

  const startNew = useCallback((start: StartAction) => {
    const document = VectorDocument.createEmpty();
    setDocParam(document.id, 'push');
    setRoute({ kind: 'editor', runtime: { document, manager: new OperationManager(document) }, name: DEFAULT_DOCUMENT_NAME, start, loadError: false });
  }, []);

  const goHome = useCallback(() => {
    setDocParam(null, 'push');
    setRoute({ kind: 'dashboard' });
  }, []);

  if (route.kind === 'loading') {
    return (
      <div className="loading-screen">
        <span className="loading-mark" />
        <strong>Keyline</strong>
        <span>Restoring workspace…</span>
      </div>
    );
  }
  if (route.kind === 'dashboard') return <Dashboard onOpen={openDocument} onStart={startNew} />;
  return (
    <Workspace
      key={route.runtime.document.id}
      runtime={route.runtime}
      loadError={route.loadError}
      initialName={route.name}
      start={route.start}
      onHome={goHome}
    />
  );
}

function Workspace({ runtime, loadError, initialName, start, onHome }: { runtime: Runtime; loadError: boolean; initialName: string; start?: StartAction; onHome: () => void }) {
  const { document, manager } = runtime;
  const [activeTool, setActiveTool] = useState<ToolId>('select');
  const [showEmptyStart, setShowEmptyStart] = useState(() => document.segments.size === 0 && !start);
  const [documentName, setDocumentName] = useState(initialName);
  const documentNameRef = useRef(initialName);
  const [constructionExtent, setConstructionExtent] = useState<ConstructionExtent>('infinite');
  const [selection, setSelection] = useState<SelectionState>(() => emptySelection());
  const [selectedArtboardIds, setSelectedArtboardIds] = useState<Set<EntityId>>(() => new Set());
  const [selectedLayerIds, setSelectedLayerIds] = useState<Set<EntityId>>(() => new Set());
  const [geometryImpactObjectIds, setGeometryImpactObjectIds] = useState<Set<EntityId>>(() => new Set());
  const [saveStatus, setSaveStatus] = useState<SaveStatus>(loadError ? 'error' : 'saved');
  const [revision, setRevision] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [bendMode, setBendMode] = useState<HandleMirrorMode>('mirror');
  const [paintColor, setPaintColor] = useState('#8b6cf6');
  const [drawingStyle, setDrawingStyle] = useState<DrawingStyle>(() => {
    try {
      const stored = window.localStorage.getItem('vector-studio-drawing-style');
      const style = normalizeStoredDrawingStyle(stored ? JSON.parse(stored) as Partial<DrawingStyle> : DEFAULT_DRAWING_STYLE);
      window.localStorage.setItem('vector-studio-drawing-style', JSON.stringify(style));
      return style;
    } catch {
      return DEFAULT_DRAWING_STYLE;
    }
  });
  const [offsetDistance, setOffsetDistance] = useState(16);
  const [filletRadius, setFilletRadius] = useState(24);
  const [eraserSettings, setEraserSettings] = useState<{ weight: number; shape: 'round' | 'square' }>({
    weight: 24,
    shape: 'round',
  });
  const [primitiveSettings, setPrimitiveSettings] = useState({ cornerRadius: 16, polygonSides: 6, starPoints: 5, starInnerRatio: 0.48 });
  const [constraintsOpen, setConstraintsOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [motionOpen, setMotionOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<'Drawing' | 'Performance' | 'Shortcuts'>('Drawing');
  const [reduceMotion, setReduceMotion] = useState(() => window.localStorage.getItem('keyline-reduce-motion') === 'true');
  const [motionSettings, setMotionSettings] = useState<MotionSettings>(() => {
    try { return clampMotionSettings({ ...DEFAULT_MOTION_SETTINGS, ...JSON.parse(window.localStorage.getItem('keyline-motion') ?? '{}') }); } catch { return DEFAULT_MOTION_SETTINGS; }
  });
  const [tidyState, setTidyState] = useState<{ imported: SvgImportResult; analysis: TidyAnalysis; sourceName: string } | null>(null);
  const [consistencyReport, setConsistencyReport] = useState<ConsistencyReport | null>(null);
  const [familyCollectionOpen, setFamilyCollectionOpen] = useState(false);
  const [geometryReviewComponentId, setGeometryReviewComponentId] = useState<EntityId>();
  const [rendererMode, setRendererMode] = useState<'canvas2d' | 'webgl'>(() =>
    window.localStorage.getItem('vector-studio-renderer') === 'webgl' ? 'webgl' : 'canvas2d');
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const stored = Number(window.localStorage.getItem('vector-studio-sidebar-width'));
    return Number.isFinite(stored) && stored >= 240 && stored <= 560 ? stored : 300;
  });
  const [sidebarMode, setSidebarMode] = useState<'split' | 'layers' | 'properties'>(() => {
    const stored = window.localStorage.getItem('vector-studio-sidebar-mode');
    return stored === 'layers' || stored === 'properties' || stored === 'split' ? stored : 'split';
  });
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() =>
    window.localStorage.getItem('vector-studio-sidebar-collapsed') === 'true');
  const [solverStatus, setSolverStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [diagnostics, setDiagnostics] = useState<ConstraintConflict[]>([]);
  const [notice, setNotice] = useState<{ message: string; tone: 'info' | 'error' } | null>(null);
  const [constraintMenu, setConstraintMenu] = useState<{ x: number; y: number } | null>(null);
  const [roomId, setRoomId] = useState(() => new URLSearchParams(window.location.search).get('room'));
  const [collaborationStatus, setCollaborationStatus] = useState<CollaborationStatus | null>(null);
  const [collaborators, setCollaborators] = useState<CollaboratorPresence[]>([]);
  const collaborationRef = useRef<CollaborationSession | null>(null);
  const clipboardRef = useRef<VectorClipboardPayload | null>(null);
  const pasteCountRef = useRef(0);
  const focusRequestIdRef = useRef(0);
  const [viewportFocusRequest, setViewportFocusRequest] = useState<{
    id: number;
    objectIds?: EntityId[];
    bounds?: { minX: number; minY: number; maxX: number; maxY: number };
  }>();
  const [shapeBuilderState, setShapeBuilderState] = useState<{
    regionIds: EntityId[];
    resultPathIds: EntityId[];
  }>({ regionIds: [], resultPathIds: [] });

  const persistence = useMemo(() => new DocumentPersistence(manager, setSaveStatus, () => documentNameRef.current), [manager]);
  const announce = useCallback((message: string, tone: 'info' | 'error' = 'info') => {
    setNotice({ message, tone });
  }, []);
  const updateDrawingStyle = useCallback((updates: Partial<DrawingStyle>) => {
    setDrawingStyle((current) => {
      const next = normalizeDrawingStyle({ ...current, ...updates });
      window.localStorage.setItem('vector-studio-drawing-style', JSON.stringify(next));
      return next;
    });
  }, []);

  useEffect(() => { 
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    if (document.segments.size > 0) setShowEmptyStart(false);
  }, [document, revision]);

  const constructionOnlySelection = useMemo(
    () => selectionIsConstructionOnly(document, selection),
    [document, revision, selection],
  );
  const toolDisabledReasons = useMemo<Partial<Record<ToolId, string>>>(() => {
    if (!constructionOnlySelection) return {};
    const reason = 'Unavailable for construction-only selections. Convert the line role to Artwork first.';
    return { paint: reason, bend: reason, fillet: reason, width: reason, offset: reason };
  }, [constructionOnlySelection]);

  const changeTool = useCallback((tool: ToolId) => {
    if (tool !== 'select') setShowEmptyStart(false);
    const disabledReason = toolDisabledReasons[tool];
    if (disabledReason) {
      const label = tool === 'width' ? 'Variable Width' : tool === 'paint' ? 'Fill' : `${tool[0].toUpperCase()}${tool.slice(1)}`;
      announce(`${label} is unavailable for construction-only selections. Convert the line role to Artwork first.`, 'error');
      return;
    }
    if (tool === 'construction-line') {
      void import('./tools/construction-tool').catch(() => {
        announce('Construction line tools could not be loaded.', 'error');
      });
    }
    setActiveTool(tool);
    const createsObject = tool === 'pen' || tool === 'pencil' || tool === 'brush' || tool === 'rectangle' || tool === 'rounded-rectangle' ||
      tool === 'ellipse' || tool === 'polygon' || tool === 'star' || tool === 'line' || tool === 'construction-line' || tool === 'arc';
    if (createsObject) {
      setSelection((current) => current.mode === 'network' && tool !== 'pen' ? exitNetworkEditMode(current) : current);
    } else if (tool !== 'select') {
      setSelection((current) => {
        if (current.mode === 'network') return current;
        const objectId = [...current.objectIds].find((id) =>
          document.isObjectVisible(id) && !document.isObjectLocked(id)) ??
          document.objectsForArtboard(document.activeArtboardId).find((object) => !document.isObjectLocked(object.id))?.id;
        return objectId ? enterNetworkEditMode(document, objectId) : current;
      });
    }
    if (tool !== 'shape-builder') setShapeBuilderState({ regionIds: [], resultPathIds: [] });
  }, [announce, document, toolDisabledReasons]);

  const shareDocument = useCallback(() => {
    const nextRoom = roomId ?? createEntityId().toLowerCase();
    const url = new URL(window.location.href);
    url.searchParams.set('room', nextRoom);
    window.history.replaceState({}, '', url);
    if (!roomId) setRoomId(nextRoom);
    void navigator.clipboard?.writeText(url.toString()).catch(() => {
      // The room URL is already reflected in the address bar when clipboard
      // permission is unavailable, so sharing still succeeds without a page error.
    });
  }, [roomId]);

  const createParametricGroup = useCallback((kind: 'mirror-x' | 'mirror-y' | 'radial') => {
    if (selection.editingObjectId && document.isObjectLocked(selection.editingObjectId)) return;
    const selectedConstructionSegments = [...selection.segmentIds]
      .map((segmentId) => document.getSegment(segmentId))
      .filter((segment): segment is Segment => segment?.role === 'construction');
    const sourcePathIds = [...new Set([...selection.segmentIds]
      .filter((segmentId) => document.getSegment(segmentId)?.role === 'geometry')
      .map((segmentId) => document.findPathForSegment(segmentId)?.id)
      .filter((pathId): pathId is EntityId => Boolean(pathId)))];
    if (sourcePathIds.length === 0) {
      announce(
        selectedConstructionSegments.length > 0
          ? 'Construction paths cannot be used as Parametric Group sources.'
          : 'Select at least one artwork path as the Parametric Group source.',
        'error',
      );
      return;
    }
    if (sourcePathIds.some((pathId) => pathHasConstruction(document, pathId))) {
      announce('Mixed construction paths cannot be used as Parametric Group sources.', 'error');
      return;
    }
    const nodePositions = sourcePathIds.flatMap((pathId) =>
      (document.getPath(pathId)?.segmentIds ?? []).flatMap((segmentId) => {
        const segment = document.getSegment(segmentId);
        if (!segment) return [];
        return [
          document.getNode(segment.startNodeId)?.position,
          document.getNode(segment.endNodeId)?.position,
        ].filter((point): point is { x: number; y: number } => Boolean(point));
      }),
    );
    if (nodePositions.length === 0) return;
    const bounds = {
      minX: Math.min(...nodePositions.map((point) => point.x)),
      maxX: Math.max(...nodePositions.map((point) => point.x)),
      minY: Math.min(...nodePositions.map((point) => point.y)),
      maxY: Math.max(...nodePositions.map((point) => point.y)),
    };
    const center = { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
    manager.execute({
      type: 'ADD_PARAMETRIC_GROUP',
      payload: {
        group: {
          id: createEntityId(),
          sourcePathIds,
          transform: kind === 'radial'
            ? { type: 'radial', center, count: 6, sweepAngle: 360 }
            : {
                type: 'mirror',
                axis: kind === 'mirror-x' ? 'x' : 'y',
                origin: center,
                axisSegmentId: selectedConstructionSegments[0]?.id,
              },
        },
      },
    });
  }, [announce, document, manager, selection]);

  const removeParametricGroup = useCallback((groupId: EntityId) => {
    const group = document.parametricGroups.get(groupId);
    if (group) manager.execute({ type: 'REMOVE_PARAMETRIC_GROUP', payload: { group } });
  }, [document, manager]);

  const updateParametricTransform = useCallback((groupId: EntityId, transform: ParametricTransform) => {
    if (!document.parametricGroups.has(groupId)) return;
    try {
      manager.execute({
        type: 'UPDATE_PARAMETRIC_GROUP',
        payload: { groupId, updates: { transform } },
      });
    } catch (error) {
      announce(error instanceof Error ? error.message : 'Parametric Group update was rejected.', 'error');
    }
  }, [announce, document, manager]);

  const updateParametricSources = useCallback((groupId: EntityId, sourcePathIds: EntityId[]) => {
    if (!document.parametricGroups.has(groupId) || sourcePathIds.length === 0) return;
    try {
      manager.execute({
        type: 'UPDATE_PARAMETRIC_GROUP',
        payload: { groupId, updates: { sourcePathIds: [...new Set(sourcePathIds)] } },
      });
    } catch (error) {
      announce(error instanceof Error ? error.message : 'Parametric Group source update was rejected.', 'error');
    }
  }, [announce, document, manager]);

  const updateObject = useCallback((objectId: EntityId, updates: Partial<NetworkObject>) => {
    if (document.isObjectLocked(objectId) || !document.isObjectVisible(objectId)) return;
    const layer = document.getLayerForObject(objectId);
    const syncName = typeof updates.name === 'string' && layer && updates.name !== layer.name;
    if (syncName) manager.beginTransaction('Rename object');
    try {
      manager.execute({ type: 'UPDATE_OBJECT', payload: { objectId, updates } });
      if (syncName) {
        manager.execute({ type: 'UPDATE_LAYER', payload: { layerId: layer.id, updates: { name: updates.name } } });
        manager.commitTransaction();
      }
    } catch (error) {
      if (syncName) manager.rollbackTransaction();
      console.warn('Object update rejected.', error);
    }
  }, [document, manager]);

  const updateAppearance = useCallback((appearanceId: EntityId, updates: Partial<Appearance>) => {
    const owner = [...document.objects.values()].find((object) => object.appearanceId === appearanceId);
    const appearance = document.getAppearance(appearanceId);
    if (!owner || !appearance || document.isObjectLocked(owner.id) || !document.isObjectVisible(owner.id)) return;
    if (owner.appearanceRuleId) {
      const rule = document.getAppearanceRule(owner.appearanceRuleId);
      if (!rule) return;
      manager.execute({
        type: 'UPDATE_APPEARANCE_RULE',
        payload: {
          ruleId: rule.id,
          updates: { appearance: appearanceRuleValue(mergeAppearance(appearance, updates)) },
        },
      });
      return;
    }
    manager.execute({ type: 'UPDATE_APPEARANCE', payload: { appearanceId, updates } });
  }, [document, manager]);

  const beginContinuousEdit = useCallback((label: string) => manager.beginTransaction(label), [manager]);
  const commitContinuousEdit = useCallback(() => manager.commitTransaction(), [manager]);
  const rollbackContinuousEdit = useCallback(() => manager.rollbackTransaction(), [manager]);

  const setSegmentRoles = useCallback((segments: SegmentRoleUpdate[]) => {
    if (segments.length === 0) return;
    try {
      manager.execute({ type: 'SET_SEGMENT_ROLES', payload: { segments } });
      announce(
        segments.every((segment) => segment.role === 'construction')
          ? `Updated ${segments.length} construction line${segments.length === 1 ? '' : 's'}.`
          : `Updated ${segments.length} artwork line${segments.length === 1 ? '' : 's'}.`,
      );
    } catch (error) {
      announce(error instanceof Error ? error.message : 'Line role update was rejected.', 'error');
    }
  }, [announce, manager]);

  const updateObjects = useCallback((objectIds: EntityId[], updates: Partial<NetworkObject['transform']>) => {
    const objects = objectIds
      .map((id) => document.getObject(id))
      .filter((object): object is NetworkObject => object !== undefined)
      .filter((object) => document.isObjectVisible(object.id) && !document.isObjectLocked(object.id));
    if (objects.length === 0) return;
    try {
      manager.beginTransaction(objects.length > 1 ? 'Update objects' : 'Update object');
      for (const object of objects) manager.execute({
        type: 'UPDATE_OBJECT',
        payload: { objectId: object.id, updates: { transform: { ...object.transform, ...updates } } },
      });
      manager.commitTransaction();
    } catch (error) {
      manager.rollbackTransaction();
      console.warn('Multi-object transform failed.', error);
    }
  }, [document, manager]);

  const flipObjects = useCallback((objectIds: EntityId[], axis: 'horizontal' | 'vertical') => {
    const plan = prepareFlipObjects(document, objectIds, axis);
    if (!plan) {
      announce('Select one or more unlocked vector objects to flip.', 'error');
      return;
    }
    try {
      manager.beginTransaction(axis === 'horizontal' ? 'Flip horizontal' : 'Flip vertical');
      for (const operation of plan.operations) manager.execute(operation);
      manager.commitTransaction();
    } catch (error) {
      manager.rollbackTransaction();
      announce(error instanceof Error ? error.message : 'Flip was rejected.', 'error');
    }
  }, [announce, document, manager]);

  const updateObjectAppearances = useCallback((
    objectIds: EntityId[],
    updates: AppearanceUpdates,
    continuous = false,
  ) => {
    const objects = objectIds
      .map((id) => document.getObject(id))
      .filter((object): object is NetworkObject => object !== undefined)
      .filter((object) => document.isObjectVisible(object.id) && !document.isObjectLocked(object.id));
    if (objects.length === 0) return;
    try {
      if (!continuous) manager.beginTransaction(objects.length > 1 ? 'Update object appearances' : 'Update object appearance');
      const updatedRuleIds = new Set<EntityId>();
      for (const object of objects) {
        const appearance = document.getAppearance(object.appearanceId);
        if (!appearance) continue;
        if (object.appearanceRuleId) {
          if (updatedRuleIds.has(object.appearanceRuleId)) continue;
          const rule = document.getAppearanceRule(object.appearanceRuleId);
          if (!rule) continue;
          const ruleAppearance: Appearance = { ...rule.appearance, id: appearance.id };
          manager.execute({
            type: 'UPDATE_APPEARANCE_RULE',
            payload: {
              ruleId: rule.id,
              updates: { appearance: appearanceRuleValue(applyAppearanceUpdates(ruleAppearance, updates)) },
            },
          });
          updatedRuleIds.add(rule.id);
          continue;
        }
        manager.execute({
          type: 'UPDATE_APPEARANCE',
          payload: { appearanceId: appearance.id, updates: applyAppearanceUpdates(appearance, updates) },
        });
      }
      if (!continuous) manager.commitTransaction();
    } catch (error) {
      manager.rollbackTransaction();
      console.warn('Multi-object appearance update failed.', error);
    }
  }, [document, manager]);

  const createAppearanceRule = useCallback((name: string, objectIds: EntityId[]) => {
    const objects = objectIds
      .map((id) => document.getObject(id))
      .filter((object): object is NetworkObject => Boolean(object))
      .filter((object) => document.isObjectVisible(object.id) && !document.isObjectLocked(object.id));
    const sourceAppearance = objects[0] ? document.getAppearance(objects[0].appearanceId) : undefined;
    if (!sourceAppearance || objects.length === 0) return;
    const baseName = name.trim() || 'Shared style';
    const usedNames = new Set([...document.appearanceRules.values()].map((rule) => rule.name.toLocaleLowerCase()));
    let uniqueName = baseName;
    let suffix = 2;
    while (usedNames.has(uniqueName.toLocaleLowerCase())) uniqueName = `${baseName} ${suffix++}`;
    const rule: AppearanceRule = {
      id: createEntityId(),
      name: uniqueName,
      kind: 'appearance',
      appearance: appearanceRuleValue(sourceAppearance),
    };
    try {
      manager.beginTransaction('Create shared style');
      manager.execute({ type: 'ADD_APPEARANCE_RULE', payload: { rule } });
      for (const object of objects) {
        manager.execute({
          type: 'UPDATE_APPEARANCE',
          payload: { appearanceId: object.appearanceId, updates: rule.appearance },
        });
        manager.execute({
          type: 'UPDATE_OBJECT',
          payload: { objectId: object.id, updates: { appearanceRuleId: rule.id } },
        });
      }
      manager.commitTransaction();
    } catch (error) {
      manager.rollbackTransaction();
      announce(error instanceof Error ? error.message : 'Shared style could not be created.', 'error');
    }
  }, [announce, document, manager]);

  const applyAppearanceRule = useCallback((ruleId: EntityId, objectIds: EntityId[]) => {
    const rule = document.getAppearanceRule(ruleId);
    const objects = objectIds
      .map((id) => document.getObject(id))
      .filter((object): object is NetworkObject => Boolean(object))
      .filter((object) => document.isObjectVisible(object.id) && !document.isObjectLocked(object.id));
    if (!rule || objects.length === 0) return;
    try {
      manager.beginTransaction('Apply shared style');
      for (const object of objects) {
        manager.execute({
          type: 'UPDATE_APPEARANCE',
          payload: { appearanceId: object.appearanceId, updates: rule.appearance },
        });
        manager.execute({
          type: 'UPDATE_OBJECT',
          payload: { objectId: object.id, updates: { appearanceRuleId: rule.id } },
        });
      }
      manager.commitTransaction();
    } catch (error) {
      manager.rollbackTransaction();
      announce(error instanceof Error ? error.message : 'Shared style could not be applied.', 'error');
    }
  }, [announce, document, manager]);

  const applyAppearanceRuleImpact = useCallback((
    ruleId: EntityId,
    appearance: AppearanceRule['appearance'],
    detachObjectIds: EntityId[],
  ) => {
    const rule = document.getAppearanceRule(ruleId);
    if (!rule) return;
    const linkedObjects = document.objectsForAppearanceRule(ruleId);
    const linkedIds = new Set(linkedObjects.map((object) => object.id));
    const detachableIds = [...new Set(detachObjectIds)]
      .filter((objectId) => linkedIds.has(objectId) && !document.isObjectLocked(objectId));
    if (linkedObjects.length - detachableIds.length < 1) {
      announce('Keep at least one object linked to update this shared style.', 'error');
      return;
    }
    try {
      manager.beginTransaction('Apply shared style impact');
      for (const objectId of detachableIds) {
        manager.execute({
          type: 'UPDATE_OBJECT',
          payload: { objectId, updates: { appearanceRuleId: undefined } },
        });
      }
      manager.execute({
        type: 'UPDATE_APPEARANCE_RULE',
        payload: { ruleId, updates: { appearance: cloneRuleAppearance(appearance) } },
      });
      manager.commitTransaction();
    } catch (error) {
      manager.rollbackTransaction();
      announce(error instanceof Error ? error.message : 'Shared style impact could not be applied.', 'error');
    }
  }, [announce, document, manager]);

  const detachAppearanceRule = useCallback((objectIds: EntityId[]) => {
    const objects = objectIds
      .map((id) => document.getObject(id))
      .filter((object): object is NetworkObject => Boolean(object?.appearanceRuleId))
      .filter((object) => !document.isObjectLocked(object.id));
    if (objects.length === 0) return;
    try {
      manager.beginTransaction('Detach shared style');
      for (const object of objects) {
        manager.execute({
          type: 'UPDATE_OBJECT',
          payload: { objectId: object.id, updates: { appearanceRuleId: undefined } },
        });
      }
      manager.commitTransaction();
    } catch (error) {
      manager.rollbackTransaction();
      announce(error instanceof Error ? error.message : 'Shared style could not be detached.', 'error');
    }
  }, [announce, document, manager]);

  const renameAppearanceRule = useCallback((ruleId: EntityId, name: string) => {
    const nextName = name.trim();
    if (!nextName || !document.getAppearanceRule(ruleId)) return;
    manager.execute({ type: 'UPDATE_APPEARANCE_RULE', payload: { ruleId, updates: { name: nextName } } });
  }, [document, manager]);

  const deleteAppearanceRule = useCallback((ruleId: EntityId) => {
    const rule = document.getAppearanceRule(ruleId);
    if (!rule) return;
    try {
      manager.beginTransaction('Delete shared style');
      for (const object of document.objectsForAppearanceRule(ruleId)) {
        manager.execute({
          type: 'UPDATE_OBJECT',
          payload: { objectId: object.id, updates: { appearanceRuleId: undefined } },
        });
      }
      manager.execute({ type: 'REMOVE_APPEARANCE_RULE', payload: { rule } });
      manager.commitTransaction();
    } catch (error) {
      manager.rollbackTransaction();
      announce(error instanceof Error ? error.message : 'Shared style could not be deleted.', 'error');
    }
  }, [announce, document, manager]);

  const updateGeometryImpactObjects = useCallback((objectIds: EntityId[]) => {
    setGeometryImpactObjectIds(new Set(objectIds));
  }, []);

  const createGeometryVariant = useCallback(async (sourceObjectId: EntityId) => {
    try {
      const { commitCreateGeometryVariant } = await import('./core/geometry-family-actions');
      const plan = commitCreateGeometryVariant(document, manager, sourceObjectId);
      if (!plan) {
        announce('Select one unlocked source object that is not already a variant.', 'error');
        return;
      }
      setSelection({
        mode: 'object',
        objectIds: new Set([plan.objectId]),
        nodeIds: new Set(),
        segmentIds: new Set(),
      });
      announce('Linked geometry variant created.', 'info');
    } catch (error) {
      announce(error instanceof Error ? error.message : 'Geometry variant could not be created.', 'error');
    }
  }, [announce, document, manager]);

  const applyGeometryPropagation = useCallback(async (
    componentId: EntityId,
    includedObjectIds: EntityId[],
    resolutions: Array<{ objectId: EntityId; resolution: GeometryConflictResolution }>,
  ) => {
    try {
      const { commitGeometryFamilyImpact } = await import('./core/geometry-family-actions');
      const result = commitGeometryFamilyImpact(
        document,
        manager,
        componentId,
        includedObjectIds,
        resolutions,
      );
      if (result.operationCount === 0) {
        announce(result.conflictCount > 0
          ? 'Unresolved variants were retained and skipped.'
          : 'Geometry family is already up to date.', 'info');
      } else if (result.resolvedCount > 0 || result.detachedCount > 0) {
        announce(`Geometry family updated · ${result.resolvedCount} resolved · ${result.detachedCount} detached.`, 'info');
      } else {
        announce('Geometry family updated.', 'info');
      }
    } catch (error) {
      announce(error instanceof Error ? error.message : 'Geometry family could not be updated.', 'error');
    }
  }, [announce, document, manager]);

  const setGeometryOverrides = useCallback(async (
    variantObjectId: EntityId,
    nodeIds: EntityId[],
    segmentIds: EntityId[],
    overridden: boolean,
  ) => {
    try {
      const { commitGeometryOverrides } = await import('./core/geometry-family-actions');
      if (!commitGeometryOverrides(document, manager, variantObjectId, nodeIds, segmentIds, overridden)) return;
      announce(overridden ? 'Selected geometry will stay local.' : 'Selected geometry will resume inheritance.', 'info');
    } catch (error) {
      announce(error instanceof Error ? error.message : 'Geometry overrides could not be updated.', 'error');
    }
  }, [announce, document, manager]);

  const detachGeometryVariant = useCallback(async (variantObjectId: EntityId) => {
    try {
      const { commitDetachGeometryVariant } = await import('./core/geometry-family-actions');
      if (!commitDetachGeometryVariant(document, manager, variantObjectId)) return;
      announce('Variant detached; its current geometry is preserved.', 'info');
    } catch (error) {
      announce(error instanceof Error ? error.message : 'Geometry variant could not be detached.', 'error');
    }
  }, [announce, document, manager]);

  const applyFamilyQaFixes = useCallback(async (componentId: EntityId, issueIds: string[]) => {
    try {
      const { commitFamilyQaFixes } = await import('./core/geometry-family-actions');
      const result = commitFamilyQaFixes(document, manager, componentId, issueIds);
      if (result.appliedCount === 0) return;
      announce(`Applied ${result.appliedCount} family QA ${result.appliedCount === 1 ? 'fix' : 'fixes'} as one undoable change.`, 'info');
    } catch (error) {
      announce(error instanceof Error ? error.message : 'Family QA fixes could not be applied.', 'error');
    }
  }, [announce, document, manager]);

  const renameGeometryComponent = useCallback((componentId: EntityId, name: string) => {
    const nextName = name.trim();
    if (!nextName || !document.getGeometryComponent(componentId)) return;
    manager.execute({
      type: 'UPDATE_GEOMETRY_COMPONENT',
      payload: { componentId, updates: { name: nextName } },
    });
  }, [document, manager]);

  const alignObjects = useCallback((
    objectIds: EntityId[],
    alignment: 'left' | 'center-x' | 'right' | 'top' | 'center-y' | 'bottom',
  ) => {
    const objects = objectIds
      .map((id) => document.getObject(id))
      .filter((object): object is NetworkObject => object !== undefined)
      .filter((object) => document.isObjectVisible(object.id) && !document.isObjectLocked(object.id));
    if (objects.length < 2) return;
    const bounds = objects.map((object) => ({
      object,
      bounds: objectBounds(document, object.id, ARTWORK_BOUNDS_POLICY),
    }));
    const target = alignment === 'left'
      ? Math.min(...bounds.map((item) => item.bounds.minX))
      : alignment === 'right'
        ? Math.max(...bounds.map((item) => item.bounds.maxX))
        : alignment === 'top'
          ? Math.min(...bounds.map((item) => item.bounds.minY))
          : alignment === 'bottom'
            ? Math.max(...bounds.map((item) => item.bounds.maxY))
            : alignment === 'center-x'
              ? (Math.min(...bounds.map((item) => item.bounds.minX)) + Math.max(...bounds.map((item) => item.bounds.maxX))) / 2
              : (Math.min(...bounds.map((item) => item.bounds.minY)) + Math.max(...bounds.map((item) => item.bounds.maxY))) / 2;
    try {
      manager.beginTransaction(`Align objects ${alignment}`);
      for (const item of bounds) {
        const current = alignment === 'left' ? item.bounds.minX
          : alignment === 'right' ? item.bounds.maxX
            : alignment === 'top' ? item.bounds.minY
              : alignment === 'bottom' ? item.bounds.maxY
                : alignment === 'center-x' ? (item.bounds.minX + item.bounds.maxX) / 2
                  : (item.bounds.minY + item.bounds.maxY) / 2;
        const horizontal = alignment === 'left' || alignment === 'right' || alignment === 'center-x';
        manager.execute({
          type: 'UPDATE_OBJECT',
          payload: {
            objectId: item.object.id,
            updates: {
              transform: {
                ...item.object.transform,
                x: item.object.transform.x + (horizontal ? target - current : 0),
                y: item.object.transform.y + (horizontal ? 0 : target - current),
              },
            },
          },
        });
      }
      manager.commitTransaction();
    } catch (error) {
      manager.rollbackTransaction();
      console.warn('Align objects failed.', error);
    }
  }, [document, manager]);

  const setObjectLayerState = useCallback((objectIds: EntityId[], updates: { locked?: boolean; visible?: boolean }) => {
    const layers = objectIds
      .map((id) => document.getLayerForObject(id))
      .filter((layer): layer is NonNullable<typeof layer> => Boolean(layer));
    if (layers.length === 0) return;
    try {
      manager.beginTransaction(layers.length > 1 ? 'Update object layer states' : 'Update object layer state');
      for (const layer of layers) manager.execute({ type: 'UPDATE_LAYER', payload: { layerId: layer.id, updates } });
      manager.commitTransaction();
    } catch (error) {
      manager.rollbackTransaction();
      console.warn('Layer state update failed.', error);
    }
  }, [document, manager]);

  const deleteSelectedObjects = useCallback(() => {
    if (selection.mode !== 'object') return false;
    const objectIds = [...selection.objectIds].filter((objectId) =>
      document.getObject(objectId) &&
      document.isObjectVisible(objectId) &&
      !document.isObjectLocked(objectId));
    if (objectIds.length === 0) return false;
    try {
      manager.beginTransaction(objectIds.length > 1 ? 'Delete objects' : 'Delete object');
      for (const objectId of objectIds) {
        const plan = prepareDeleteObject(document, objectId);
        if (!plan) continue;
        for (const operation of plan.operations) manager.execute(operation);
      }
      manager.commitTransaction();
      setSelection(emptySelection('object'));
      setSelectedLayerIds(new Set());
      return true;
    } catch (error) {
      manager.rollbackTransaction();
      console.warn('Object deletion failed.', error);
      return false;
    }
  }, [document, manager, selection]);

  const copySelection = useCallback((intent: 'copy' | 'cut') => {
    const objectIds = [...selection.objectIds].filter((objectId) =>
      document.getObject(objectId) && document.isObjectVisible(objectId) &&
      (intent === 'copy' || !document.isObjectLocked(objectId)));
    const payload = createVectorClipboardPayload(document, objectIds, intent);
    if (!payload) {
      announce(intent === 'cut'
        ? 'Select at least one visible, unlocked object to cut.'
        : 'Select at least one visible object to copy.', 'error');
      return false;
    }
    clipboardRef.current = payload;
    pasteCountRef.current = 0;
    void navigator.clipboard?.writeText(serializeVectorClipboard(payload)).catch(() => {
      // The in-memory clipboard remains available when browser clipboard permission is denied.
    });
    if (intent === 'cut' && !deleteSelectedObjects()) {
      announce('The selected objects could not be cut.', 'error');
      return false;
    }
    announce(`${intent === 'cut' ? 'Cut' : 'Copied'} ${payload.objects.length} object${payload.objects.length === 1 ? '' : 's'}.`);
    return true;
  }, [announce, deleteSelectedObjects, document, selection]);

  const pastePayload = useCallback((payload: VectorClipboardPayload) => {
    const pasteIndex = pasteCountRef.current;
    const step = payload.intent === 'cut' ? pasteIndex : pasteIndex + 1;
    const plan = preparePasteObjects(document, payload, {
      offset: { x: step * 16, y: step * 16 },
      preserveNames: payload.intent === 'cut' && pasteIndex === 0,
    });
    if (!plan) {
      announce('The clipboard does not contain pasteable Keyline objects.', 'error');
      return false;
    }
    try {
      manager.beginTransaction(plan.objectIds.length > 1 ? 'Paste objects' : 'Paste object');
      plan.operations.forEach((operation) => manager.execute(operation));
      manager.commitTransaction();
      pasteCountRef.current += 1;
      setSelection({
        mode: 'object',
        objectIds: new Set(plan.objectIds),
        nodeIds: new Set(),
        segmentIds: new Set(),
      });
      setSelectedLayerIds(new Set(plan.layerIds));
      setActiveTool('select');
      announce(`Pasted ${plan.objectIds.length} object${plan.objectIds.length === 1 ? '' : 's'}.`);
      return true;
    } catch (error) {
      manager.rollbackTransaction();
      announce(`Paste failed: ${error instanceof Error ? error.message : 'unknown error'}`, 'error');
      return false;
    }
  }, [announce, document, manager]);

  const pasteFromClipboard = useCallback(async () => {
    let payload = clipboardRef.current;
    if (!payload && navigator.clipboard?.readText) {
      try {
        payload = parseVectorClipboard(await navigator.clipboard.readText());
      } catch {
        // A clear application notice below covers denied clipboard reads.
      }
    }
    if (!payload) {
      announce('Copy or cut Keyline objects before pasting.', 'error');
      return false;
    }
    clipboardRef.current = payload;
    return pastePayload(payload);
  }, [announce, pastePayload]);

  const addIconFrame = useCallback((width: number, height: number) => {
    try {
      const plan = prepareCreateIconArtboard(document, width, height);
      manager.beginTransaction('Add icon frame');
      plan.operations.forEach((operation) => manager.execute(operation));
      manager.commitTransaction();
      setSelection(emptySelection());
      setSelectedArtboardIds(new Set());
      setSelectedLayerIds(new Set());
      setActiveTool('select');
      setViewportFocusRequest({
        id: ++focusRequestIdRef.current,
        bounds: {
          minX: plan.artboard.frame.x,
          minY: plan.artboard.frame.y,
          maxX: plan.artboard.frame.x + plan.artboard.frame.width,
          maxY: plan.artboard.frame.y + plan.artboard.frame.height,
        },
      });
    } catch (error) {
      manager.rollbackTransaction();
      announce(`Unable to add icon frame: ${error instanceof Error ? error.message : 'unknown error'}`, 'error');
    }
  }, [announce, document, manager]);

  const openStarterSample = useCallback(() => {
    addIconFrame(24, 24);
    const frame = document.activeArtboard.frame;
    const triangle = preparePrimitiveObject(
      document,
      'polygon',
      { x: frame.x + 4, y: frame.y + 4 },
      { x: frame.x + 20, y: frame.y + 20 },
      { sides: 3 },
    );
    const ring = preparePrimitiveObject(
      document,
      'ellipse',
      { x: frame.x + 8, y: frame.y + 8 },
      { x: frame.x + 16, y: frame.y + 16 },
    );
    const guide = preparePrimitiveObject(
      document,
      'line',
      { x: frame.x + 12, y: frame.y + 3 },
      { x: frame.x + 12, y: frame.y + 21 },
    );
    if (!triangle || !ring || !guide) return;
    try {
      manager.beginTransaction('Open starter sample');
      guide.operations.forEach((operation) => manager.execute(operation));
      ring.operations.forEach((operation) => manager.execute(operation));
      triangle.operations.forEach((operation) => manager.execute(operation));

      const triangleObject = document.getObject(triangle.objectId)!;
      const triangleAppearance = document.getAppearance(triangleObject.appearanceId)!;
      manager.execute({
        type: 'UPDATE_OBJECT',
        payload: { objectId: triangle.objectId, updates: { name: 'Triangle', transform: { ...triangleObject.transform, x: frame.x, y: frame.y } } },
      });
      manager.execute({ type: 'UPDATE_LAYER', payload: { layerId: triangle.layerId, updates: { name: 'Triangle' } } });
      manager.execute({
        type: 'SET_NODE_POSITIONS',
        payload: {
          positions: [
            { nodeId: triangle.nodeIds[0], position: { x: 12, y: 5 } },
            { nodeId: triangle.nodeIds[1], position: { x: 19, y: 19 } },
            { nodeId: triangle.nodeIds[2], position: { x: 5, y: 19 } },
          ],
        },
      });
      manager.execute({
        type: 'UPDATE_APPEARANCE',
        payload: {
          appearanceId: triangleAppearance.id,
          updates: {
            fills: [],
            stroke: { ...triangleAppearance.stroke!, color: '#14181F', width: 0.7, cap: 'round', join: 'round', visible: true },
          },
        },
      });

      const apex = document.getNode(triangle.nodeIds[0])!;
      const midpointNodeId = createEntityId();
      const midpointPathId = createEntityId();
      const midpointSegmentId = createEntityId();
      const baseNodes = triangle.nodeIds.slice(1).map((id) => document.getNode(id)!).filter(Boolean);
      const midpoint = {
        x: (baseNodes[0].position.x + baseNodes[1].position.x) / 2,
        y: (baseNodes[0].position.y + baseNodes[1].position.y) / 2,
      };
      manager.execute({ type: 'ADD_NODE', payload: { node: { id: midpointNodeId, position: midpoint, constraintIds: [] }, networkId: triangle.networkId } });
      manager.execute({ type: 'ADD_PATH', payload: { path: { id: midpointPathId, segmentIds: [], isClosed: false }, networkId: triangle.networkId } });
      manager.execute({
        type: 'ADD_SEGMENT',
        payload: { segment: { id: midpointSegmentId, startNodeId: apex.id, endNodeId: midpointNodeId, type: 'line', role: 'geometry' }, pathId: midpointPathId },
      });

      const ringObject = document.getObject(ring.objectId)!;
      const ringAppearance = document.getAppearance(ringObject.appearanceId)!;
      manager.execute({ type: 'UPDATE_OBJECT', payload: { objectId: ring.objectId, updates: { name: 'Ring' } } });
      manager.execute({ type: 'UPDATE_LAYER', payload: { layerId: ring.layerId, updates: { name: 'Ring' } } });
      manager.execute({
        type: 'UPDATE_APPEARANCE',
        payload: { appearanceId: ringAppearance.id, updates: { fills: [], stroke: { ...ringAppearance.stroke!, visible: false } } },
      });

      manager.execute({ type: 'UPDATE_OBJECT', payload: { objectId: guide.objectId, updates: { name: 'Guide line' } } });
      manager.execute({ type: 'UPDATE_LAYER', payload: { layerId: guide.layerId, updates: { name: 'Guide line', visible: false } } });
      manager.execute({
        type: 'SET_SEGMENT_ROLES',
        payload: { segments: guide.segmentIds.map((segmentId) => ({ segmentId, role: 'construction' as const, constructionExtent: 'finite' as const })) },
      });

      manager.commitTransaction();
      setSelection({
        mode: 'network',
        editingObjectId: triangle.objectId,
        objectIds: new Set([triangle.objectId]),
        nodeIds: new Set([apex.id, midpointNodeId]),
        segmentIds: new Set(),
      });
      setSelectedLayerIds(new Set([triangle.layerId]));
      setActiveTool('select');
      setShowEmptyStart(false);
    } catch (error) {
      manager.rollbackTransaction();
      announce(`Unable to open the starter sample: ${error instanceof Error ? error.message : 'unknown error'}`, 'error');
    }
  }, [addIconFrame, announce, document, manager]);

  const renameDocument = useCallback((name: string) => {
    const next = name.trim() || DEFAULT_DOCUMENT_NAME;
    documentNameRef.current = next;
    setDocumentName(next);
    if (document.objects.size > 0) void persistence.flush();
  }, [document, persistence]);

  const importParsed = useCallback((imported: SvgImportResult, sourceName: string, rules: ReadonlySet<TidyRuleId>) => {
    try {
      const payload = rules.size > 0 ? applyTidy(imported.payload, imported.viewport, rules) : structuredClone(imported.payload);
      const { framePlan, objectPlan } = placeImportedPayload(document, manager, payload, imported.viewport);
      setSelection(objectPlan && objectPlan.objectIds.length > 0
        ? { mode: 'object', objectIds: new Set(objectPlan.objectIds), nodeIds: new Set(), segmentIds: new Set() }
        : emptySelection());
      setSelectedLayerIds(new Set(objectPlan?.layerIds ?? []));
      setSelectedArtboardIds(new Set());
      setActiveTool('select');
      setShowEmptyStart(false);
      setViewportFocusRequest({
        id: ++focusRequestIdRef.current,
        bounds: {
          minX: framePlan.artboard.frame.x,
          minY: framePlan.artboard.frame.y,
          maxX: framePlan.artboard.frame.x + framePlan.artboard.frame.width,
          maxY: framePlan.artboard.frame.y + framePlan.artboard.frame.height,
        },
      });
      if (documentNameRef.current === DEFAULT_DOCUMENT_NAME) renameDocument(sourceName.replace(/\.svg$/i, '') || DEFAULT_DOCUMENT_NAME);
      void persistence.flush().then(() => markStoredDocumentImported(document.id));
      const skipped = imported.skippedElementCount > 0 ? ` ${imported.skippedElementCount} unsupported elements were skipped.` : '';
      announce(imported.importedElementCount > 0
        ? `Imported ${imported.importedElementCount} editable ${imported.importedElementCount === 1 ? 'shape' : 'shapes'} from ${sourceName}.${skipped}`
        : `Created a frame from ${sourceName}, but no supported SVG paths or shapes were found.${skipped}`,
      );
    } catch (error) {
      manager.rollbackTransaction();
      announce(`Unable to import SVG: ${error instanceof Error ? error.message : 'unknown error'}`, 'error');
    }
  }, [announce, document, manager, persistence, renameDocument]);

  /** Reads the SVG, then either imports it straight away (nothing to tidy) or asks once. */
  const importSvgSource = useCallback(async (source: string, sourceName: string) => {
    try {
      const parsed = new DOMParser().parseFromString(source, 'image/svg+xml');
      const svg = parsed.documentElement;
      if (svg.tagName.toLowerCase() !== 'svg' || parsed.querySelector('parsererror')) {
        throw new Error('The selected content is not valid SVG.');
      }
      const { parseSvgDocument } = await import('./import/svg-import');
      const imported = parseSvgDocument(svg as unknown as SVGSVGElement);
      const analysis = analyzeTidy(imported.payload, imported.viewport);
      if (analysis.isClean || imported.importedElementCount === 0) importParsed(imported, sourceName, new Set());
      else setTidyState({ imported, analysis, sourceName });
    } catch (error) {
      announce(`Unable to import SVG: ${error instanceof Error ? error.message : 'unknown error'}`, 'error');
    }
  }, [announce, importParsed]);

  const startFromSvgSource = useCallback((source: string, sourceName: string) => {
    void importSvgSource(source, sourceName);
  }, [importSvgSource]);

  const startFromSvgFile = useCallback(async (file: File) => {
    try {
      startFromSvgSource(await file.text(), file.name);
    } catch (error) {
      announce(`Unable to read SVG: ${error instanceof Error ? error.message : 'unknown error'}`, 'error');
    }
  }, [announce, startFromSvgSource]);

  const duplicateActiveArtboard = useCallback(() => {
    const plan = prepareDuplicateArtboard(document, document.activeArtboardId);
    if (!plan) {
      announce('The active artboard could not be duplicated.', 'error');
      return;
    }
    try {
      manager.beginTransaction('Duplicate artboard');
      plan.operations.forEach((operation) => manager.execute(operation));
      manager.commitTransaction();
      setSelection(emptySelection());
      setSelectedArtboardIds(new Set());
      setSelectedLayerIds(new Set());
      setActiveTool('select');
      setViewportFocusRequest({
        id: ++focusRequestIdRef.current,
        bounds: {
          minX: plan.artboard.frame.x,
          minY: plan.artboard.frame.y,
          maxX: plan.artboard.frame.x + plan.artboard.frame.width,
          maxY: plan.artboard.frame.y + plan.artboard.frame.height,
        },
      });
    } catch (error) {
      manager.rollbackTransaction();
      announce(`Unable to duplicate artboard: ${error instanceof Error ? error.message : 'unknown error'}`, 'error');
    }
  }, [announce, document, manager]);

  const deleteArtboards = useCallback((requestedIds: Iterable<EntityId>) => {
    const ids = [...new Set(requestedIds)].filter((id) => document.getArtboard(id));
    if (ids.length === 0) return false;
    try {
      const result = deleteArtboardsTransactional(manager, ids);
      if (!result) {
        announce('No fallback artboard is available.', 'error');
        return false;
      }
      setSelection(emptySelection());
      setSelectedArtboardIds(new Set());
      setSelectedLayerIds(new Set());
      setActiveTool('select');
      return true;
    } catch (error) {
      announce(`Unable to delete ${ids.length === 1 ? 'artboard' : 'artboards'}: ${error instanceof Error ? error.message : 'unknown error'}`, 'error');
      return false;
    }
  }, [announce, document, manager]);

  const deleteActiveArtboard = useCallback(() => {
    deleteArtboards([document.activeArtboardId]);
  }, [deleteArtboards, document.activeArtboardId]);

  const frameLayerOnCanvas = useCallback((layerId: EntityId) => {
    const objectIds: EntityId[] = [];
    const visit = (id: EntityId) => {
      const layer = document.getLayer(id);
      if (!layer || !isLayerEffectivelyVisible(document, id)) return;
      if (layer.objectId && document.getObject(layer.objectId)) objectIds.push(layer.objectId);
      layer.childIds.forEach(visit);
    };
    visit(layerId);
    if (objectIds.length === 0) {
      announce('This layer has no visible object to frame.', 'error');
      return;
    }
    setSelectedLayerIds(new Set([layerId]));
    setSelection({ mode: 'object', objectIds: new Set(objectIds), nodeIds: new Set(), segmentIds: new Set() });
    setActiveTool('select');
    setViewportFocusRequest({ id: ++focusRequestIdRef.current, objectIds });
    announce(`Centered ${objectIds.length === 1 ? 'object' : `${objectIds.length} objects`} on the canvas.`);
  }, [announce, document]);

  const selectFamilyObject = useCallback((objectId: EntityId) => {
    const object = document.getObject(objectId);
    const layer = object ? document.getLayerForObject(object.id) : undefined;
    if (!object || !layer) return;
    setSelection({ mode: 'object', objectIds: new Set([object.id]), nodeIds: new Set(), segmentIds: new Set() });
    setSelectedLayerIds(new Set([layer.id]));
    setSelectedArtboardIds(new Set());
    setActiveTool('select');
    setSidebarCollapsed(false);
    setSidebarMode('properties');
    window.localStorage.setItem('vector-studio-sidebar-collapsed', 'false');
    window.localStorage.setItem('vector-studio-sidebar-mode', 'properties');
    setViewportFocusRequest({ id: ++focusRequestIdRef.current, objectIds: [object.id] });
  }, [document]);

  const reviewFamilyGeometry = useCallback((componentId: EntityId, sourceObjectId: EntityId) => {
    selectFamilyObject(sourceObjectId);
    setGeometryReviewComponentId(componentId);
  }, [selectFamilyObject]);

  const enterObjectNetwork = useCallback((objectId: EntityId) => {
    if (document.isObjectLocked(objectId) || !document.isObjectVisible(objectId)) return;
    setSelection(enterNetworkEditMode(document, objectId));
    setActiveTool('select');
  }, [document]);

  const exitObjectNetwork = useCallback(() => {
    setSelection((current) => exitNetworkEditMode(current));
    setActiveTool('select');
  }, []);

  const applyBulkNodeAction = useCallback((action: BulkNodeAction) => {
    if (selection.editingObjectId && document.isObjectLocked(selection.editingObjectId)) return;
    const positions = prepareBulkNodePositions(document, selection.nodeIds, action);
    if (positions.length === 0) return;
    try {
      manager.execute({ type: 'SET_NODE_POSITIONS', payload: { positions } });
    } catch (error) {
      console.warn('Bulk node action rejected by constraint pre-validation.', error);
    }
  }, [document, manager, selection]);

  const applyConstraint = useCallback((type: ConstraintType, value?: number) => {
    if (selection.editingObjectId && document.isObjectLocked(selection.editingObjectId)) return;
    const constraints = createConstraintsForSelection(document, selection, type, value);
    if (constraints.length === 0) {
      announce(`${type.replaceAll('_', ' ')} is not available for the current selection.`, 'error');
      return;
    }
    try {
      manager.beginTransaction(`Add ${type} constraint`);
      for (const constraint of constraints) {
        manager.execute({ type: 'ADD_CONSTRAINT', payload: { constraint } });
      }
      manager.commitTransaction();
    } catch (error) {
      manager.rollbackTransaction();
      const message = error instanceof Error ? error.message : 'The constraint could not be applied.';
      announce(`Constraint rejected: ${message}`, 'error');
      console.warn('Constraint rejected.', error);
    }
  }, [announce, document, manager, selection]);

  const updateConstraint = useCallback((constraintId: EntityId, updates: Partial<Constraint>) => {
    try {
      manager.execute({ type: 'UPDATE_CONSTRAINT', payload: { constraintId, updates } });
    } catch (error) {
      console.warn('Constraint update rejected.', error);
    }
  }, [manager]);

  const updateConstraintParameters = useCallback((constraintIds: EntityId[], parameter: string, value: number) => {
    if (constraintIds.length === 0 || !Number.isFinite(value)) return;
    try {
      manager.beginTransaction(`Update ${constraintIds.length} constraint parameters`);
      for (const constraintId of constraintIds) {
        const constraint = document.constraints.get(constraintId);
        if (!constraint) continue;
        manager.execute({
          type: 'UPDATE_CONSTRAINT',
          payload: {
            constraintId,
            updates: { parameters: { ...(constraint.parameters ?? {}), [parameter]: value } },
          },
        });
      }
      manager.commitTransaction();
    } catch (error) {
      manager.rollbackTransaction();
      console.warn('Bulk constraint update rejected.', error);
    }
  }, [document, manager]);

  const removeConstraint = useCallback((constraintId: EntityId) => {
    if (!document.constraints.has(constraintId)) return;
    manager.execute({ type: 'REMOVE_CONSTRAINT', payload: { constraintId } });
  }, [document, manager]);

  const runPathCommand = useCallback((command: 'close' | 'reverse' | 'select-connected' | 'add-point' | 'delete-point' | 'join') => {
    if (selection.editingObjectId && document.isObjectLocked(selection.editingObjectId)) return;
    const selectedNodeIds = [...selection.nodeIds];
    const seedId = selection.segmentIds.values().next().value as EntityId | undefined;
    if (command === 'delete-point') {
      const plan = selectedNodeIds.length === 1 ? prepareDeletePoint(document, selectedNodeIds[0]) : null;
      if (!plan) {
        announce('Delete point needs one removable node in an open or closed path.', 'error');
        return;
      }
      manager.beginTransaction(plan.deleteObjectId ? 'Delete path' : 'Delete point');
      try {
        if (plan.deleteObjectId) {
          const objectDeletion = prepareDeleteObject(document, plan.deleteObjectId);
          if (!objectDeletion) throw new Error('The empty path object could not be removed.');
          objectDeletion.operations.forEach((operation) => manager.execute(operation));
        } else {
          plan.constraintIds.forEach((constraintId) => manager.execute({ type: 'REMOVE_CONSTRAINT', payload: { constraintId } }));
          manager.execute({ type: 'APPLY_GRAPH_PATCH', payload: plan.patch });
        }
        manager.commitTransaction();
        setSelection(plan.deleteObjectId
          ? emptySelection('object')
          : (current) => ({ ...current, nodeIds: new Set(), segmentIds: new Set(plan.replacementSegmentId ? [plan.replacementSegmentId] : []) }));
        if (plan.deleteObjectId) setSelectedLayerIds(new Set());
      } catch (error) {
        manager.rollbackTransaction();
        announce(`Delete point rejected: ${error instanceof Error ? error.message : 'unknown error'}`, 'error');
        console.warn('Delete point rejected.', error);
      }
      return;
    }
    if (command === 'join') {
      const operations = selectedNodeIds.length === 2 ? prepareJoinEndpoints(document, selectedNodeIds[0], selectedNodeIds[1]) : null;
      if (!operations) {
        announce('Join needs two compatible open-path endpoints.', 'error');
        return;
      }
      manager.beginTransaction('Join paths');
      try { operations.forEach((operation) => manager.execute(operation)); manager.commitTransaction(); }
      catch (error) {
        manager.rollbackTransaction();
        announce(`Join rejected: ${error instanceof Error ? error.message : 'unknown error'}`, 'error');
        console.warn('Join paths rejected.', error);
      }
      return;
    }
    if (!seedId) {
      announce(`${command.replaceAll('-', ' ')} needs a selected segment.`, 'error');
      return;
    }
    const path = document.findPathForSegment(seedId);
    if (!path) {
      announce('The selected segment is not attached to a path.', 'error');
      return;
    }
    if (command === 'add-point') {
      const segment = document.getSegment(seedId)!;
      if (segment.role === 'construction' && segment.constructionExtent === 'infinite') {
        announce('Infinite construction lines cannot be split.', 'error');
        return;
      }
      try {
        const split = prepareSplitAtPoint(document, seedId, evaluateSegment(document, segment, 0.5));
        if (split) {
          manager.execute({ type: 'SPLIT_SEGMENT', payload: split });
          setSelection((current) => ({
            ...current,
            nodeIds: new Set([split.newNodeId]),
            segmentIds: new Set([split.newSegment1Id, split.newSegment2Id]),
          }));
        } else announce('A point cannot be added to this segment.', 'error');
      } catch (error) {
        announce(error instanceof Error ? error.message : 'A point cannot be added to this segment.', 'error');
      }
      return;
    }
    if (command === 'select-connected') {
      const connected = connectedSelection(document, [seedId]);
      setSelection((current) => ({ ...current, nodeIds: new Set(connected.nodeIds), segmentIds: new Set(connected.segmentIds) }));
      return;
    }
    if (command === 'close') {
      const operations = prepareClosePath(document, path.id);
      if (!operations) {
        announce('Close path is only available for an open path with compatible endpoints.', 'error');
        return;
      }
      manager.beginTransaction('Close path');
      try { operations.forEach((operation) => manager.execute(operation)); manager.commitTransaction(); }
      catch (error) {
        manager.rollbackTransaction();
        announce(`Close path rejected: ${error instanceof Error ? error.message : 'unknown error'}`, 'error');
        console.warn('Close path rejected.', error);
      }
      return;
    }
    const patch = prepareReversePath(document, path.id);
    if (patch) manager.execute({ type: 'APPLY_GRAPH_PATCH', payload: patch });
    else announce('This path cannot be reversed.', 'error');
  }, [announce, document, manager, selection]);

  const adjustConstraintParameter = useCallback((constraintId: EntityId) => {
    const constraint = document.constraints.get(constraintId);
    if (!constraint) return;
    const nodeIds = constraint.targetIds.filter((id) => document.nodes.has(id));
    const segmentIds = constraint.targetIds.filter((id) => document.segments.has(id));
    const object = nodeIds[0]
      ? document.getObjectForNode(nodeIds[0])
      : segmentIds[0]
        ? document.getObjectForSegment(segmentIds[0])
        : undefined;
    setSelection({
      mode: 'network',
      editingObjectId: object?.id,
      objectIds: object ? new Set([object.id]) : new Set(),
      nodeIds: new Set(nodeIds),
      segmentIds: new Set(segmentIds),
    });
    setActiveTool('select');
    setDiagnostics([]);
    window.requestAnimationFrame(() => {
      const card = window.document.querySelector(`[data-constraint-id="${constraintId}"]`);
      const input = card?.querySelector<HTMLInputElement>('input[type="number"]');
      input?.focus();
      input?.select();
      card?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }, [document]);

  useEffect(() => {
    let regionDiagnosticsTimer: number | undefined;
    persistence.start();
    manager.setDiagnosticsListener(setDiagnostics);
    manager.setRegionDiagnosticsListener((items) => {
      window.clearTimeout(regionDiagnosticsTimer);
      regionDiagnosticsTimer = undefined;
      const blocking = items.find((item) => item.severity === 'error');
      if (blocking) {
        // Multi-operation drawing transactions briefly pass through incomplete
        // topology. Only interrupt the user for blocking diagnostics that remain.
        regionDiagnosticsTimer = window.setTimeout(() => announce(blocking.message, 'error'), 140);
      }
    });
    const unsubscribe = manager.subscribe((event) => {
      setRevision((value) => value + 1);
      if (event.reason === 'undo' || event.reason === 'redo') {
        setShapeBuilderState({ regionIds: [], resultPathIds: [] });
      }
      setSelection((current) => {
        const objectIds = new Set([...current.objectIds].filter((id) =>
          document.objects.has(id) && document.isObjectVisible(id)));
        const editingObjectId = current.editingObjectId &&
          document.objects.has(current.editingObjectId) &&
          document.isObjectVisible(current.editingObjectId) &&
          !document.isObjectLocked(current.editingObjectId)
          ? current.editingObjectId
          : undefined;
        return {
          mode: current.mode === 'network' && editingObjectId ? 'network' : 'object',
          editingObjectId,
          objectIds,
          nodeIds: editingObjectId
            ? new Set([...current.nodeIds].filter((id) => document.nodes.has(id) && document.isNodeVisible(id)))
            : new Set(),
          segmentIds: editingObjectId
            ? new Set([...current.segmentIds].filter((id) => document.segments.has(id) && document.isSegmentVisible(id)))
            : new Set(),
        };
      });
      setSelectedArtboardIds((current) => {
        const existing = new Set([...current].filter((id) => Boolean(document.getArtboard(id))));
        if (existing.size > 0 || current.size === 0) return existing;
        const active = document.getArtboard(document.activeArtboardId);
        if (active && !active.isCanvasRoot) return new Set([active.id]);
        const fallback = document.activePage.artboardIds
          .map((id) => document.getArtboard(id))
          .find((artboard) => artboard && !artboard.isCanvasRoot);
        return fallback ? new Set([fallback.id]) : existing;
      });
      setSelectedLayerIds((current) => new Set(
        [...current].filter((id) => isLayerEffectivelyVisible(document, id)),
      ));
    });
    return () => {
      window.clearTimeout(regionDiagnosticsTimer);
      unsubscribe();
      manager.setDiagnosticsListener(undefined);
      manager.setRegionDiagnosticsListener(undefined);
      persistence.stop();
    };
  }, [announce, document, manager, persistence]);

  useEffect(() => {
    if (!roomId) {
      collaborationRef.current = null;
      setCollaborationStatus(null);
      setCollaborators([]);
      return;
    }
    let disposed = false;
    let session: CollaborationSession | null = null;
    setCollaborationStatus('connecting');
    void import('./collaboration/session').then(({ CollaborationSession: Session }) => {
      if (disposed) return;
      session = new Session(
        manager,
        roomId,
        {
          onStatus: setCollaborationStatus,
          onPresence: setCollaborators,
          onReplayConflicts: (messages) => {
            if (messages.length > 0) console.warn('Some concurrent operations were rejected deterministically.', messages);
          },
          onCompatibilityNotice: (message) => announce(message, 'error'),
        },
        collaborationIdentity(),
      );
      collaborationRef.current = session;
      return session.start();
    }).catch((error) => {
      if (disposed) return;
      console.error('Unable to start collaboration.', error);
      setCollaborationStatus('error');
    });
    return () => {
      disposed = true;
      session?.destroy();
      if (collaborationRef.current === session) collaborationRef.current = null;
    };
  }, [announce, manager, roomId]);

  useEffect(() => {
    collaborationRef.current?.setSelection(selection);
  }, [selection]);

  useEffect(() => {
    const worker = new WasmConstraintWorkerClient();
    let verification = 0;
    let disposed = false;
    setSolverStatus('loading');

    const verify = async () => {
      if (document.constraints.size === 0) return;
      const sequence = ++verification;
      try {
        const result = await worker.solve(document);
        if (!disposed && sequence === verification && !result.success) setDiagnostics(result.conflicts);
      } catch (error) {
        if (!disposed) {
          setSolverStatus('error');
          setDiagnostics([{
            constraintIds: [],
            message: 'The Wasm constraint worker could not verify the document.',
            error: Number.POSITIVE_INFINITY,
            suggestion: error instanceof Error ? error.message : String(error),
          }]);
        }
      }
    };

    void worker.version().then(() => {
      if (!disposed) {
        setSolverStatus('ready');
        void verify();
      }
    }).catch((error) => {
      if (!disposed) {
        setSolverStatus('error');
        console.error('Unable to initialize the Wasm solver worker.', error);
      }
    });

    const unsubscribe = manager.subscribe((event) => {
      if (event.committed || event.reason === 'remote') void verify();
    });
    return () => {
      disposed = true;
      unsubscribe();
      worker.terminate();
    };
  }, [document, manager]);

  const isEmptyDocument = showEmptyStart || document.objects.size === 0;

  const applyIconStartStyle = useCallback(() => {
    // First icon set on this device: begin with the common 1.5 px round line instead of a hairline.
    const untouched = drawingStyle.strokeWidth === DEFAULT_DRAWING_STYLE.strokeWidth
      && drawingStyle.strokeCap === DEFAULT_DRAWING_STYLE.strokeCap
      && drawingStyle.strokeJoin === DEFAULT_DRAWING_STYLE.strokeJoin;
    if (untouched && !window.localStorage.getItem('keyline-icon-style-seeded')) {
      updateDrawingStyle({ strokeWidth: 1.5, strokeCap: 'round', strokeJoin: 'round' });
    }
    window.localStorage.setItem('keyline-icon-style-seeded', 'true');
  }, [drawingStyle, updateDrawingStyle]);

  const goHome = useCallback(async () => {
    if (document.objects.size > 0) await persistence.flush().catch(() => undefined);
    onHome();
  }, [document, onHome, persistence]);

  // Run the start chosen on the Dashboard exactly once.
  const startedRef = useRef(false);
  useEffect(() => {
    if (!start || startedRef.current) return;
    startedRef.current = true;
    if (start.kind === 'icon') { applyIconStartStyle(); addIconFrame(start.size, start.size); }
    else if (start.kind === 'logo') addIconFrame(start.width, start.height);
    else if (start.kind === 'sample') openStarterSample();
    else if (start.kind === 'svg') void importSvgSource(start.source, start.name);
    setShowEmptyStart(false);
  }, [addIconFrame, applyIconStartStyle, importSvgSource, openStarterSample, start]);

  useEffect(() => {
    window.document.documentElement.dataset.reduceMotion = String(reduceMotion);
    window.localStorage.setItem('keyline-reduce-motion', String(reduceMotion));
  }, [reduceMotion]);

  const updateMotionSettings = useCallback((next: MotionSettings) => {
    setMotionSettings(next);
    window.localStorage.setItem('keyline-motion', JSON.stringify(next));
  }, []);

  /* Sharing */
  const stopSharing = useCallback(() => {
    const url = new URL(window.location.href);
    url.searchParams.delete('room');
    window.history.replaceState({}, '', url);
    setRoomId(null);
    setCollaborationStatus(null);
    setCollaborators([]);
    announce('Sharing stopped. This drawing is private again.');
  }, [announce]);
  const shareLink = roomId ? `${window.location.origin}${window.location.pathname}?room=${roomId}` : '';

  /* Quick edits ("Ask for an edit") */
  const editTargetIds = useMemo(() => (
    selection.mode === 'network' && selection.editingObjectId ? [selection.editingObjectId] : [...selection.objectIds]
  ), [selection]);
  const quickEditTargets = useMemo<QuickEditTarget[]>(() => editTargetIds.flatMap((id) => {
    const object = document.getObject(id);
    const appearance = object ? document.getAppearance(object.appearanceId) : undefined;
    if (!object || !appearance || document.isObjectLocked(id)) return [];
    const stroke = appearance.stroke && appearance.stroke.visible ? appearance.stroke : undefined;
    return [{
      id,
      strokeWidth: stroke?.width,
      strokeCap: stroke?.cap,
      strokeJoin: stroke?.join,
      strokeColor: stroke?.color,
      fillColor: appearance.fills.find((fill) => fill.visible)?.color,
    }];
  }), [document, editTargetIds, revision]);
  const applyQuickEdit = useCallback((plan: QuickEditPlan) => {
    try {
      manager.beginTransaction('Ask for an edit');
      for (const step of plan.steps) updateObjectAppearances(step.objectIds, step.updates, true);
      manager.commitTransaction();
      announce(`Done: ${plan.changes.map((change) => `${change.label.toLowerCase()} ${change.after}`).join(', ')}. Undo to go back.`);
    } catch (error) {
      manager.rollbackTransaction();
      announce(error instanceof Error ? error.message : 'That edit was rejected.', 'error');
    }
  }, [announce, manager, updateObjectAppearances]);

  /* Check */
  const openCheck = useCallback(() => {
    if (document.objects.size === 0) { announce('Draw something first, then check it.', 'error'); return; }
    setConsistencyReport(analyzeConsistency(document));
  }, [announce, document]);
  const fixConsistency = useCallback(() => {
    const report = analyzeConsistency(document);
    if (!report.target || report.fixObjectIds.length === 0) return;
    updateObjectAppearances(report.fixObjectIds, { strokeWidth: report.target.strokeWidth, strokeCap: report.target.cap, strokeJoin: report.target.join });
    setConsistencyReport(analyzeConsistency(document));
    announce(`Fixed ${report.fixObjectIds.length} ${report.fixObjectIds.length === 1 ? 'shape' : 'shapes'} in one undo step.`);
  }, [announce, document, updateObjectAppearances]);
  const showConsistencyOffenders = useCallback((objectIds: EntityId[]) => {
    setConsistencyReport(null);
    setSelection({ mode: 'object', objectIds: new Set(objectIds), nodeIds: new Set(), segmentIds: new Set() });
    announce(`Selected ${objectIds.length} ${objectIds.length === 1 ? 'shape' : 'shapes'}.`);
  }, [announce]);

  /* Motion */
  const [motionSvg, setMotionSvg] = useState<string | undefined>(undefined);
  const openMotion = useCallback(() => {
    if (drawnObjectCount(document) === 0) { announce('Draw something first, then animate it.', 'error'); return; }
    void import('./export/svg-export').then(({ exportDocumentToSvg }) => {
      const active = document.activeArtboard;
      const artboard = !active.isCanvasRoot && drawnObjectsForArtboard(document, active.id).length > 0
        ? active
        : realArtboards(document).find((item) => drawnObjectsForArtboard(document, item.id).length > 0);
      let svg: string | undefined;
      try {
        svg = artboard ? exportDocumentToSvg(document, { artboardId: artboard.id, exportBoundsMode: 'artboard', includeMetadata: false }) : undefined;
      } catch { svg = undefined; }
      setMotionSvg(svg);
      setMotionOpen(true);
    });
  }, [announce, document]);
  const downloadMotion = useCallback(() => {
    if (!motionSvg) return;
    const url = URL.createObjectURL(new Blob([buildAnimatedSvg(motionSvg, motionSettings)], { type: 'image/svg+xml' }));
    const anchor = window.document.createElement('a');
    anchor.href = url;
    anchor.download = `${documentNameRef.current.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'keyline'}-motion.svg`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    announce('Animated SVG downloaded.');
  }, [announce, motionSettings, motionSvg]);
  const copyMotionCss = useCallback((css: string) => {
    void navigator.clipboard?.writeText(css).then(
      () => announce('Animation CSS copied. Give each path the class “kl”, and “kl-line” or “kl-fill”.'),
      () => announce('Could not copy. Your browser blocked clipboard access.', 'error'),
    );
  }, [announce]);

  /* Command bar */
  const commands = useMemo<CommandItem[]>(() => {
    const tool = (id: ToolId, label: string, shortcut?: string, keywords = ''): CommandItem => ({
      id: `tool-${id}`, label, group: 'Tools', shortcut, keywords, disabledReason: toolDisabledReasons[id], run: () => changeTool(id),
    });
    return [
      tool('select', 'Select', 'V', 'move pick'), tool('pen', 'Pen', 'P', 'draw path point'), tool('pencil', 'Pencil', 'N', 'freehand'),
      tool('brush', 'Brush', 'J'), tool('rectangle', 'Rectangle', 'R', 'square box shape'), tool('rounded-rectangle', 'Rounded rectangle', '⇧ R', 'shape'),
      tool('ellipse', 'Ellipse', 'U', 'circle oval shape'), tool('polygon', 'Polygon', 'G', 'shape'), tool('star', 'Star', 'S', 'shape'),
      tool('line', 'Line', '\\'), tool('arc', 'Arc', 'A', 'curve'), tool('construction-line', 'Guide line', '⇧ \\', 'construction'),
      tool('bend', 'Bend', 'D', 'curve'), tool('cut', 'Cut', 'X', 'split'), tool('fillet', 'Round corner', 'F', 'fillet radius'),
      tool('offset', 'Offset', 'O', 'outline copy'), tool('width', 'Stroke width', 'W', 'variable thickness'), tool('eraser', 'Eraser', '⇧ E'),
      tool('lasso', 'Lasso', 'Q', 'select points align'), tool('shape-builder', 'Shape builder', 'B', 'merge union subtract combine'), tool('paint', 'Fill areas', '⇧ B', 'paint colour'),
      { id: 'frame-24', label: 'New icon frame 24 × 24', group: 'Frames', keywords: 'artboard add', run: () => addIconFrame(24, 24) },
      { id: 'frame-32', label: 'New icon frame 32 × 32', group: 'Frames', keywords: 'artboard add', run: () => addIconFrame(32, 32) },
      { id: 'frame-48', label: 'New icon frame 48 × 48', group: 'Frames', keywords: 'artboard add', run: () => addIconFrame(48, 48) },
      { id: 'export', label: 'Export SVG or code', group: 'Actions', keywords: 'download save react css', disabledReason: isEmptyDocument ? 'Draw something first' : undefined, run: () => setExportOpen(true) },
      { id: 'motion', label: 'Animate (Motion)', group: 'Actions', shortcut: 'M', keywords: 'animation draw on pulse', disabledReason: isEmptyDocument ? 'Draw something first' : undefined, run: openMotion },
      { id: 'check', label: 'Check icons are consistent', group: 'Actions', shortcut: `${MODIFIER_LABEL} ⇧ C`, keywords: 'consistency line width audit', disabledReason: isEmptyDocument ? 'Draw something first' : undefined, run: openCheck },
      { id: 'share', label: 'Share a live link', group: 'Actions', keywords: 'collaborate invite', run: () => setShareOpen(true) },
      { id: 'constraints', label: 'Constraints', group: 'Actions', shortcut: 'K', keywords: 'rules lock parallel equal', run: () => setConstraintsOpen((open) => !open) },
      { id: 'families', label: 'Icon families', group: 'Actions', keywords: 'components variants collection', run: () => setFamilyCollectionOpen(true) },
      { id: 'settings', label: 'Settings', group: 'Actions', keywords: 'preferences renderer shortcuts', run: () => { setSettingsSection('Drawing'); setSettingsOpen(true); } },
      { id: 'shortcuts', label: 'Keyboard shortcuts', group: 'Actions', keywords: 'keys help', run: () => { setSettingsSection('Shortcuts'); setSettingsOpen(true); } },
      { id: 'undo', label: 'Undo', group: 'Actions', shortcut: `${MODIFIER_LABEL} Z`, disabledReason: manager.canUndo ? undefined : 'Nothing to undo', run: () => manager.undo() },
      { id: 'redo', label: 'Redo', group: 'Actions', shortcut: `${MODIFIER_LABEL} ⇧ Z`, disabledReason: manager.canRedo ? undefined : 'Nothing to redo', run: () => manager.redo() },
      { id: 'home', label: 'All files', group: 'Actions', keywords: 'dashboard home projects', run: () => void goHome() },
    ];
  }, [addIconFrame, changeTool, goHome, isEmptyDocument, manager, openCheck, openMotion, revision, toolDisabledReasons]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;
      // Keys pressed inside a dialog belong to the dialog, not the canvas behind it.
      if (event.target instanceof Element && event.target.closest('[role="dialog"]')) return;
      const modifier = event.ctrlKey || event.metaKey;
      if (!modifier && !event.altKey && (event.key === 'Delete' || event.key === 'Backspace')) {
        if (selection.mode === 'network' && selection.nodeIds.size === 1) {
          event.preventDefault();
          runPathCommand('delete-point');
        } else if (selection.mode === 'object' && selectedArtboardIds.size > 0) {
          if (deleteArtboards(selectedArtboardIds)) event.preventDefault();
        } else if (deleteSelectedObjects()) {
          event.preventDefault();
        }
        return;
      }
      const nudgeDirection = !modifier && !event.altKey && selection.mode === 'network'
        ? ({ ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 }, ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 } } as const)[event.key as 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown']
        : undefined;
      if (nudgeDirection && selection.nodeIds.size > 0) {
        const distance = event.shiftKey ? 10 : 1;
        const positions = [...selection.nodeIds]
          .filter((nodeId) => document.getNode(nodeId) && !document.isNodeLocked(nodeId))
          .map((nodeId) => {
            const node = document.getNode(nodeId)!;
            return {
              nodeId,
              position: {
                x: node.position.x + nudgeDirection.x * distance,
                y: node.position.y + nudgeDirection.y * distance,
              },
            };
          });
        if (positions.length > 0) {
          event.preventDefault();
          manager.execute({ type: 'SET_NODE_POSITIONS', payload: { positions } });
        }
        return;
      }
      if (modifier && !event.shiftKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setCommandOpen(true);
        return;
      }
      if (modifier && event.shiftKey && event.key.toLowerCase() === 'c') {
        event.preventDefault();
        openCheck();
        return;
      }
      if (!modifier && !event.altKey && event.key.toLowerCase() === 'm') {
        event.preventDefault();
        openMotion();
        return;
      }
      if (modifier && !event.shiftKey && event.key.toLowerCase() === 'c') {
        event.preventDefault();
        copySelection('copy');
        return;
      }
      if (modifier && !event.shiftKey && event.key.toLowerCase() === 'x') {
        event.preventDefault();
        copySelection('cut');
        return;
      }
      if (modifier && !event.shiftKey && event.key.toLowerCase() === 'v') {
        event.preventDefault();
        void pasteFromClipboard();
        return;
      }
      if (modifier && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) manager.redo();
        else manager.undo();
        return;
      }
      if (!modifier && !event.altKey && event.shiftKey && selection.mode === 'object' && selection.objectIds.size > 0) {
        const key = event.key.toLowerCase();
        if (key === 'h' || key === 'v') {
          event.preventDefault();
          flipObjects([...selection.objectIds], key === 'h' ? 'horizontal' : 'vertical');
          return;
        }
      }
      if (!modifier && !event.altKey && event.key.toLowerCase() === 'v') changeTool('select');
      if (!modifier && !event.altKey && event.key.toLowerCase() === 'p') changeTool('pen');
      if (!modifier && !event.altKey && event.key.toLowerCase() === 'n') changeTool('pencil');
      if (!modifier && !event.altKey && event.key.toLowerCase() === 'j') changeTool('brush');
      if (!modifier && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'r') changeTool('rectangle');
      if (!modifier && !event.altKey && event.shiftKey && event.key.toLowerCase() === 'r') changeTool('rounded-rectangle');
      if (!modifier && !event.altKey && event.key.toLowerCase() === 'u') changeTool('ellipse');
      if (!modifier && !event.altKey && event.key.toLowerCase() === 'g') changeTool('polygon');
      if (!modifier && !event.altKey && event.key.toLowerCase() === 's') changeTool('star');
      if (!modifier && !event.altKey && event.code === 'Backslash') {
        changeTool(event.shiftKey ? 'construction-line' : 'line');
      }
      if (!modifier && !event.altKey && event.key.toLowerCase() === 'a') changeTool('arc');
      if (!modifier && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'b') changeTool('shape-builder');
      if (!modifier && !event.altKey && event.shiftKey && event.key.toLowerCase() === 'b') changeTool('paint');
      if (!modifier && !event.altKey && selection.mode === 'network' && event.key.toLowerCase() === 'x') changeTool('cut');
      if (!modifier && !event.altKey && event.key.toLowerCase() === 'c') changeTool('cut');
      if (!modifier && !event.altKey && event.key.toLowerCase() === 'd') changeTool('bend');
      if (!modifier && !event.altKey && event.key.toLowerCase() === 'f') changeTool('fillet');
      if (!modifier && !event.altKey && event.key.toLowerCase() === 'w') changeTool('width');
      if (!modifier && !event.altKey && event.key.toLowerCase() === 'o') changeTool('offset');
      if (!modifier && !event.altKey && selection.mode === 'network' && event.key.toLowerCase() === 'q') changeTool('lasso');
      if (!modifier && !event.altKey && event.key.toLowerCase() === 'l') changeTool('lasso');
      if (!modifier && !event.altKey && selection.mode === 'network' && event.shiftKey && event.key.toLowerCase() === 'e') changeTool('eraser');
      if (!modifier && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'e') changeTool('eraser');
      if (!modifier && !event.altKey && event.key.toLowerCase() === 'k') setConstraintsOpen((open) => !open);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [changeTool, copySelection, deleteArtboards, deleteSelectedObjects, document, flipObjects, manager, openCheck, openMotion, pasteFromClipboard, runPathCommand, selectedArtboardIds, selection]);

  // revision intentionally makes graph-derived shell values update after operations.
  void revision;

  const chooseSidebarMode = (mode: 'split' | 'layers' | 'properties') => {
    setSidebarMode(mode);
    window.localStorage.setItem('vector-studio-sidebar-mode', mode);
  };
  const toggleSidebar = () => {
    setSidebarCollapsed((current) => {
      window.localStorage.setItem('vector-studio-sidebar-collapsed', String(!current));
      return !current;
    });
  };
  const startSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    event.currentTarget.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent) => {
      const next = Math.min(560, Math.max(240, startWidth + startX - moveEvent.clientX));
      setSidebarWidth(next);
    };
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      setSidebarWidth((current) => {
        window.localStorage.setItem('vector-studio-sidebar-width', String(current));
        return current;
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end, { once: true });
  };

  return (
    <div className="app-shell">
      <Toolbar
        canUndo={manager.canUndo}
        canRedo={manager.canRedo}
        documentName={documentName}
        onRenameDocument={renameDocument}
        isEmpty={isEmptyDocument}
        saveStatus={saveStatus}
        constraintCount={document.constraints.size}
        constraintsOpen={constraintsOpen}
        solverStatus={solverStatus}
        collaborationStatus={collaborationStatus}
        collaborators={collaborators}
        onHome={() => void goHome()}
        onShare={() => setShareOpen(true)}
        onOpenSettings={() => { setSettingsSection('Drawing'); setSettingsOpen(true); }}
        onOpenCommand={() => setCommandOpen(true)}
        onOpenMotion={openMotion}
        onOpenCheck={openCheck}
        onAddIconFrame={addIconFrame}
        onToggleConstraints={() => setConstraintsOpen((open) => !open)}
        onExport={() => setExportOpen(true)}
        onUndo={() => manager.undo()}
        onRedo={() => manager.redo()}
      />
      {commandOpen && (
        <CommandBar
          commands={commands}
          targets={quickEditTargets}
          selectionLabel={quickEditTargets.length === 1 ? 'selected shape' : `${quickEditTargets.length} selected shapes`}
          onApplyEdit={applyQuickEdit}
          onClose={() => setCommandOpen(false)}
        />
      )}
      {exportOpen && (
        <Suspense fallback={<div className="modal-backdrop"><div className="dialog-loading" role="status">Preparing export…</div></div>}>
          <ExportDialog document={document} manager={manager} onClose={() => setExportOpen(false)} />
        </Suspense>
      )}
      {shareOpen && (
        <Suspense fallback={<div className="modal-backdrop"><div className="dialog-loading" role="status">Preparing sharing…</div></div>}>
          <ShareDialog
            documentName={documentName}
            roomId={roomId}
            link={shareLink}
            status={collaborationStatus}
            people={[
              { id: 'you', name: `${collaborationIdentity().name} (you)`, color: collaborationIdentity().color, detail: 'This device' },
              ...collaborators.map((person) => ({ id: String(person.clientId), name: person.user.name, color: person.user.color, detail: 'Editing now' })),
            ]}
            onCreateLink={() => {
              shareDocument();
              announce('Link copied. Anyone who opens it can edit with you.');
            }}
            onCopyLink={() => {
              void navigator.clipboard?.writeText(shareLink).then(
                () => announce('Link copied.'),
                () => announce('Could not copy. Select the link and copy it by hand.', 'error'),
              );
            }}
            onStopSharing={() => { stopSharing(); setShareOpen(false); }}
            onClose={() => setShareOpen(false)}
          />
        </Suspense>
      )}
      {settingsOpen && (
        <Suspense fallback={<div className="modal-backdrop"><div className="dialog-loading" role="status">Preparing settings…</div></div>}>
          <SettingsDialog
            initialSection={settingsSection}
            rendererMode={rendererMode}
            onRendererModeChange={(mode) => {
              setRendererMode(mode);
              window.localStorage.setItem('vector-studio-renderer', mode);
            }}
            reduceMotion={reduceMotion}
            onReduceMotionChange={setReduceMotion}
            drawingStyle={drawingStyle}
            onDrawingStyleChange={updateDrawingStyle}
            onClose={() => setSettingsOpen(false)}
          />
        </Suspense>
      )}
      {tidyState && (
        <Suspense fallback={<div className="modal-backdrop"><div className="dialog-loading" role="status">Inspecting SVG…</div></div>}>
          <ImportTidyDialog
            filename={tidyState.sourceName}
            imported={tidyState.imported}
            analysis={tidyState.analysis}
            onCancel={() => setTidyState(null)}
            onOpenAsIs={() => {
              const pending = tidyState;
              setTidyState(null);
              importParsed(pending.imported, pending.sourceName, new Set());
            }}
            onApply={(rules) => {
              const pending = tidyState;
              setTidyState(null);
              importParsed(pending.imported, pending.sourceName, rules);
            }}
          />
        </Suspense>
      )}
      {motionOpen && (
        <Suspense fallback={<div className="modal-backdrop"><div className="dialog-loading" role="status">Preparing motion…</div></div>}>
          <MotionDialog
            objectName={documentName}
            svg={motionSvg}
            settings={motionSettings}
            onSettingsChange={updateMotionSettings}
            onDownload={downloadMotion}
            onCopyCss={copyMotionCss}
            onClose={() => setMotionOpen(false)}
          />
        </Suspense>
      )}
      {consistencyReport && (
        <Suspense fallback={<div className="modal-backdrop"><div className="dialog-loading" role="status">Checking icons…</div></div>}>
          <ConsistencyDialog
            report={consistencyReport}
            fileName={documentName}
            onFix={fixConsistency}
            onShow={showConsistencyOffenders}
            onOpenAdvanced={() => {
              setConsistencyReport(null);
              setFamilyCollectionOpen(true);
            }}
            onClose={() => setConsistencyReport(null)}
          />
        </Suspense>
      )}
      {familyCollectionOpen && (
        <Suspense fallback={<div className="modal-backdrop"><div className="dialog-loading" role="status">Preparing family collection…</div></div>}>
          <FamilyCollectionDialog
            document={document}
            onClose={() => setFamilyCollectionOpen(false)}
            onApplyFamilyQaFixes={applyFamilyQaFixes}
            onSelectObject={selectFamilyObject}
            onReviewGeometry={reviewFamilyGeometry}
          />
        </Suspense>
      )}
      {constraintsOpen && (
        <ConstraintPalette
          document={document}
          selection={selection}
          solverStatus={solverStatus}
          onApply={applyConstraint}
          onClose={() => setConstraintsOpen(false)}
        />
      )}
      <main
        className={`workspace${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}
        style={{ '--sidebar-width': `${sidebarCollapsed ? 36 : sidebarWidth}px` } as CSSProperties}
      >
        <VectorCanvas
          manager={manager}
          activeTool={activeTool}
          constructionExtent={constructionExtent}
          toolDisabledReasons={toolDisabledReasons}
          selection={selection}
          selectedArtboardIds={selectedArtboardIds}
          impactObjectIds={geometryImpactObjectIds}
          bendMode={bendMode}
          paintColor={paintColor}
          drawingStyle={drawingStyle}
          offsetDistance={offsetDistance}
          filletRadius={filletRadius}
          eraserSettings={eraserSettings}
          primitiveSettings={primitiveSettings}
          shapeBuilderState={shapeBuilderState}
          rendererMode={rendererMode}
          remotePresence={collaborators}
          onPresenceCursor={(point) => collaborationRef.current?.setCursor(point)}
          onSelectionChange={(next) => {
            setSelection(next);
            const layerIds = [...next.objectIds]
              .map((objectId) => document.getLayerForObject(objectId)?.id)
              .filter((id): id is EntityId => Boolean(id));
            setSelectedLayerIds(new Set(layerIds));
          }}
          onArtboardSelectionChange={setSelectedArtboardIds}
          onShapeBuilderStateChange={setShapeBuilderState}
          onRequestToolChange={changeTool}
          onOpenConstraintMenu={(x, y) => setConstraintMenu({ x, y })}
          onViewportChange={setZoom}
          viewportFocusRequest={viewportFocusRequest}
          onNotice={announce}
        />
        {showEmptyStart && (
          <section className="empty-start-overlay" aria-label="Start a new drawing">
            <div className="empty-start-card">
              <header>
                <h2>What are you drawing?</h2>
                <p>Pick a start. You can change the size later.</p>
              </header>
              <div className="empty-start-grid">
                <article className="empty-start-option">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="4" width="14" height="16" rx="2"/><path d="m8 16 4-8 4 8"/></svg>
                  <h3>Icon set</h3>
                  <p>A square frame with a pixel grid. Exports as SVG or a React component.</p>
                  <div className="empty-start-presets" role="group" aria-label="Icon frame size">
                    {[24, 32, 48].map((size) => <button key={size} type="button" onClick={() => { applyIconStartStyle(); addIconFrame(size, size); setShowEmptyStart(false); }}>{size}</button>)}
                    <button type="button" onClick={() => { applyIconStartStyle(); addIconFrame(64, 64); setShowEmptyStart(false); }}>Custom</button>
                  </div>
                </article>
                <article className="empty-start-option">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><circle cx="9" cy="10" r="1"/><circle cx="15" cy="10" r="1"/><path d="M8 14c1.1 1.4 2.4 2 4 2s2.9-.6 4-2"/></svg>
                  <h3>Logo or mark</h3>
                  <p>A free artboard for brand shapes, with mirror and radial repeat ready.</p>
                  <div className="empty-start-presets" role="group" aria-label="Logo frame size">
                    <button type="button" onClick={() => { addIconFrame(512, 512); setShowEmptyStart(false); }}>Square 512</button>
                    <button type="button" onClick={() => { addIconFrame(1024, 512); setShowEmptyStart(false); }}>Wide 1024 × 512</button>
                  </div>
                </article>
                <label
                  className="empty-start-option is-import"
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    event.currentTarget.querySelector('input')?.click();
                  }}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault();
                    const file = [...event.dataTransfer.files].find((candidate) => candidate.type === 'image/svg+xml' || candidate.name.toLowerCase().endsWith('.svg'));
                    if (file) void startFromSvgFile(file);
                    else announce('Drop an SVG file to import editable geometry.', 'error');
                  }}
                  onPaste={(event) => {
                    const file = [...event.clipboardData.files].find((candidate) => candidate.type === 'image/svg+xml' || candidate.name.toLowerCase().endsWith('.svg'));
                    if (file) { event.preventDefault(); void startFromSvgFile(file); return; }
                    const source = event.clipboardData.getData('text/plain').trim();
                    if (source.startsWith('<svg') || source.startsWith('<?xml')) {
                      event.preventDefault();
                      void startFromSvgSource(source, 'pasted SVG');
                    }
                  }}
                >
                  <input type="file" accept="image/svg+xml,.svg" onChange={(event) => { const file = event.target.files?.[0]; if (file) void startFromSvgFile(file); }} />
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M5 14v6h14v-6"/></svg>
                  <h3>Import an SVG</h3>
                  <p>Drop a file or paste code. We tidy the points and suggest rules to lock the shape.</p>
                  <small>From another vector editor or an AI generator</small>
                </label>
                <button type="button" className="empty-start-option is-sample" onClick={openStarterSample}>
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h8l4 4v14H7z"/><path d="M15 3v5h4"/><path d="M10 13h6M10 17h4"/></svg>
                  <h3>Open a sample</h3>
                  <p>A small icon set already built with rules, so you can see what one edit changes.</p>
                  <small>Try changing one number</small>
                </button>
              </div>
              <footer>
                <button type="button" onClick={() => { setShowEmptyStart(false); changeTool('pen'); }}>Or press <kbd>P</kbd> and start drawing on a blank page</button>
                <span>Saved on this device</span>
              </footer>
            </div>
          </section>
        )}
        <aside className={`right-sidebar mode-${sidebarMode}${sidebarCollapsed ? ' is-collapsed' : ''}`}>
          {!sidebarCollapsed && (
            <div
              className="sidebar-resizer"
              role="separator"
              aria-label="Resize inspector sidebar"
              aria-orientation="vertical"
              aria-valuemin={240}
              aria-valuemax={560}
              aria-valuenow={sidebarWidth}
              tabIndex={0}
              onPointerDown={startSidebarResize}
              onKeyDown={(event) => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                event.preventDefault();
                const next = Math.min(560, Math.max(240, sidebarWidth + (event.key === 'ArrowLeft' ? 16 : -16)));
                setSidebarWidth(next);
                window.localStorage.setItem('vector-studio-sidebar-width', String(next));
              }}
            />
          )}
          <div className="sidebar-panel-tabs" role="toolbar" aria-label="Sidebar layout">
            {sidebarCollapsed ? (
              <button type="button" onClick={toggleSidebar} aria-label="Open panels" title="Open panels">‹</button>
            ) : (
              <>
                <button type="button" aria-pressed={sidebarMode === 'layers'} onClick={() => chooseSidebarMode('layers')}>Layers</button>
                <button type="button" aria-label="Properties" aria-pressed={sidebarMode === 'properties'} onClick={() => chooseSidebarMode('properties')}><span aria-hidden="true">Design</span></button>
                <button className="sidebar-split-button" type="button" aria-label="Split" title="Show Layers and Design together" aria-pressed={sidebarMode === 'split'} onClick={() => chooseSidebarMode('split')}><span aria-hidden="true">◫</span></button>
                <button type="button" onClick={toggleSidebar} aria-label="Collapse panels" title="Collapse panels">›</button>
              </>
            )}
          </div>
          <Suspense fallback={<div className="panel-loading" role="status">Loading panels…</div>}>
          <LayersPanel
            document={document}
            manager={manager}
            selectedLayerIds={selectedLayerIds}
            onFrameLayer={frameLayerOnCanvas}
            onDuplicateArtboard={duplicateActiveArtboard}
            onDeleteArtboard={deleteActiveArtboard}
            onSelectLayers={(layerIds) => {
              setSelectedLayerIds(new Set(layerIds));
              const objectIds = [...layerIds]
                .map((layerId) => document.getLayer(layerId)?.objectId)
                .filter((id): id is EntityId => id !== undefined && document.isObjectVisible(id));
              setSelection({
                mode: 'object',
                objectIds: new Set(objectIds),
                nodeIds: new Set(),
                segmentIds: new Set(),
              });
              setActiveTool('select');
            }}
          />
          <PropertiesPanel
            document={document}
            manager={manager}
            selection={selection}
            onDuplicateArtboard={duplicateActiveArtboard}
            onDeleteArtboard={deleteActiveArtboard}
            activeTool={activeTool}
            constructionExtent={constructionExtent}
            bendMode={bendMode}
            paintColor={paintColor}
            drawingStyle={drawingStyle}
            offsetDistance={offsetDistance}
            filletRadius={filletRadius}
            eraserSettings={eraserSettings}
            primitiveSettings={primitiveSettings}
            onPrimitiveSettingsChange={(updates) => setPrimitiveSettings((current) => ({ ...current, ...updates }))}
            onConstructionExtentChange={setConstructionExtent}
            onSetSegmentRoles={setSegmentRoles}
            onBendModeChange={setBendMode}
            onPaintColorChange={setPaintColor}
            onDrawingStyleChange={updateDrawingStyle}
            onOffsetDistanceChange={setOffsetDistance}
            onFilletRadiusChange={setFilletRadius}
            onEraserSettingsChange={(updates) => setEraserSettings((current) => ({ ...current, ...updates }))}
            onCreateMirror={(axis) => createParametricGroup(axis === 'x' ? 'mirror-x' : 'mirror-y')}
            onCreateRadialRepeat={() => createParametricGroup('radial')}
            onRemoveParametricGroup={removeParametricGroup}
            onUpdateParametricTransform={updateParametricTransform}
            onUpdateParametricSources={updateParametricSources}
            onBulkNodeAction={applyBulkNodeAction}
            onApplyConstraint={applyConstraint}
            onUpdateConstraint={updateConstraint}
            onBulkConstraintParameter={updateConstraintParameters}
            onRemoveConstraint={removeConstraint}
            onSetNodeMode={(nodeIds, mode) => manager.execute({
              type: 'SET_NODE_MODES', payload: { modes: nodeIds.map((nodeId) => ({ nodeId, mode })) },
            })}
            onPathCommand={runPathCommand}
            onUpdateObject={updateObject}
            onUpdateAppearance={updateAppearance}
            onBeginContinuousEdit={beginContinuousEdit}
            onCommitContinuousEdit={commitContinuousEdit}
            onRollbackContinuousEdit={rollbackContinuousEdit}
            onUpdateObjects={updateObjects}
            onUpdateObjectAppearances={updateObjectAppearances}
            onCreateAppearanceRule={createAppearanceRule}
            onApplyAppearanceRule={applyAppearanceRule}
            onApplyAppearanceRuleImpact={applyAppearanceRuleImpact}
            onDetachAppearanceRule={detachAppearanceRule}
            onRenameAppearanceRule={renameAppearanceRule}
            onDeleteAppearanceRule={deleteAppearanceRule}
            onCreateGeometryVariant={createGeometryVariant}
            onApplyGeometryPropagation={applyGeometryPropagation}
            onGeometryImpactObjectsChange={updateGeometryImpactObjects}
            onSetGeometryOverrides={setGeometryOverrides}
            onDetachGeometryVariant={detachGeometryVariant}
            onApplyFamilyQaFixes={applyFamilyQaFixes}
            geometryReviewComponentId={geometryReviewComponentId}
            onGeometryReviewOpened={() => setGeometryReviewComponentId(undefined)}
            onRenameGeometryComponent={renameGeometryComponent}
            onAlignObjects={alignObjects}
            onFlipObjects={flipObjects}
            onSetObjectLayerState={setObjectLayerState}
            onEnterNetworkEdit={enterObjectNetwork}
            onExitNetworkEdit={exitObjectNetwork}
          />
          </Suspense>
        </aside>
      </main>
      {constraintMenu && (
        <ConstraintContextMenu
          x={constraintMenu.x}
          y={constraintMenu.y}
          document={document}
          selection={selection}
          onApply={applyConstraint}
          onClose={() => setConstraintMenu(null)}
        />
      )}
      {notice && (
        <div className={`workspace-notice is-${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
          <span>{notice.message}</span>
          <button type="button" aria-label="Dismiss notification" onClick={() => setNotice(null)}>×</button>
        </div>
      )}
      <ConstraintDiagnostics
        conflicts={diagnostics}
        onDrop={removeConstraint}
        onRelax={(constraintId) => updateConstraint(constraintId, { priority: 'soft' })}
        onAdjust={adjustConstraintParameter}
        onDismiss={() => setDiagnostics([])}
      />
      <StatusBar
        nodeCount={document.nodes.size}
        segmentCount={document.segments.size}
        pathCount={document.paths.size}
        regionCount={document.regions.length}
        constraintCount={document.constraints.size}
        solverStatus={solverStatus}
        zoom={showEmptyStart ? 1 : zoom}
        saveStatus={saveStatus}
        selectionLabel={selection.mode === 'network'
          ? `${selection.nodeIds.size + selection.segmentIds.size || 'No'} point${selection.nodeIds.size + selection.segmentIds.size === 1 ? '' : 's'} selected${selection.editingObjectId ? ` on ${document.getObject(selection.editingObjectId)?.name ?? 'vector'}` : ''}`
          : selection.objectIds.size > 0
            ? `${selection.objectIds.size} object${selection.objectIds.size === 1 ? '' : 's'} selected`
            : selectedArtboardIds.size > 0
              ? `${selectedArtboardIds.size} artboard${selectedArtboardIds.size === 1 ? '' : 's'} selected`
              : 'Nothing selected'}
      />
    </div>
  );
}

function appearanceRuleValue(appearance: Appearance): AppearanceRule['appearance'] {
  return cloneRuleAppearance(appearance);
}

function cloneRuleAppearance(appearance: AppearanceRule['appearance']): AppearanceRule['appearance'] {
  return {
    fills: appearance.fills.map((fill) => ({ ...fill })),
    stroke: appearance.stroke ? { ...appearance.stroke, dash: [...appearance.stroke.dash] } : undefined,
    opacity: appearance.opacity,
  };
}

function mergeAppearance(appearance: Appearance, updates: Partial<Appearance>): Appearance {
  return {
    ...appearance,
    ...updates,
    id: appearance.id,
    fills: updates.fills
      ? updates.fills.map((fill) => ({ ...fill }))
      : appearance.fills.map((fill) => ({ ...fill })),
    stroke: updates.stroke
      ? { ...updates.stroke, dash: [...updates.stroke.dash] }
      : appearance.stroke
        ? { ...appearance.stroke, dash: [...appearance.stroke.dash] }
        : undefined,
  };
}

function applyAppearanceUpdates(
  appearance: Appearance,
  updates: AppearanceUpdates,
): Appearance {
  let stroke = appearance.stroke ? { ...appearance.stroke, dash: [...appearance.stroke.dash] } : undefined;
  if (updates.strokeVisible === true && !stroke) {
    stroke = {
      color: '#c8ced9',
      width: 1.25,
      cap: 'round',
      join: 'round',
      alignment: 'center',
      opacity: 1,
      dash: [],
      visible: true,
    };
  }
  if (updates.strokeWidth !== undefined && stroke) stroke.width = Math.max(0, updates.strokeWidth);
  if (updates.strokeVisible !== undefined && stroke) stroke.visible = updates.strokeVisible;
  if (updates.strokeAlignment !== undefined && stroke) stroke.alignment = updates.strokeAlignment;
  if (updates.strokeCap !== undefined && stroke) stroke.cap = updates.strokeCap;
  if (updates.strokeJoin !== undefined && stroke) stroke.join = updates.strokeJoin;
  if (updates.strokeColor !== undefined && stroke) stroke.color = updates.strokeColor;
  const fills = updates.fillRemoved
    ? []
    : updates.fillColor
    ? appearance.fills.length > 0
      ? [{ ...appearance.fills[0], color: updates.fillColor }, ...appearance.fills.slice(1).map((fill) => ({ ...fill }))]
      : [{ type: 'solid' as const, color: updates.fillColor, opacity: 1, visible: true }]
    : appearance.fills.map((fill) => ({ ...fill }));
  return {
    id: appearance.id,
    fills,
    stroke,
    opacity: updates.opacity !== undefined ? Math.min(1, Math.max(0, updates.opacity)) : appearance.opacity,
  };
}

function collaborationIdentity(): { id: string; name: string; color: string } {
  const storageKey = 'vector-studio-collaboration-user';
  const stored = window.localStorage.getItem(storageKey);
  if (stored) {
    try { return JSON.parse(stored) as { id: string; name: string; color: string }; } catch { /* regenerate */ }
  }
  const colors = ['#68a0ff', '#9b7cff', '#56c9a5', '#f0a85b', '#ef7181'];
  const id = createEntityId();
  const identity = {
    id,
    name: `Designer ${id.slice(-4).toUpperCase()}`,
    color: colors[id.charCodeAt(id.length - 1) % colors.length],
  };
  window.localStorage.setItem(storageKey, JSON.stringify(identity));
  return identity;
}

function isLayerEffectivelyVisible(document: VectorDocument, layerId: EntityId): boolean {
  let layer = document.getLayer(layerId);
  if (!layer) return false;
  if (layer.objectId) return document.isObjectVisible(layer.objectId);
  while (layer) {
    if (!layer.visible) return false;
    layer = layer.parentId ? document.getLayer(layer.parentId) : undefined;
  }
  return true;
}

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable);
}
