import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { StackIcon } from '@primer/octicons-react/StackIcon';
import type { VectorDocument } from '../core/document';
import { evaluateSegment } from '../core/geometry';
import { createEntityId } from '../core/ids';
import { prepareDeleteObject, prepareDuplicateObject } from '../core/object-operations';
import type { OperationManager } from '../core/operations';
import { realArtboards } from '../core/real-content';
import { objectConstructionComposition } from '../core/segment-semantics';
import type { EntityId, LayerNode } from '../core/types';
import {
  DEFAULT_ARTBOARD_BACKGROUND,
} from '../design-system/document-defaults';

interface LayersPanelProps {
  document: VectorDocument;
  manager: OperationManager;
  selectedLayerIds: Set<EntityId>;
  onSelectLayers: (layerIds: Set<EntityId>) => void;
  onFrameLayer: (layerId: EntityId) => void;
  onDuplicateArtboard: () => void;
  onDeleteArtboard: () => void;
  onCollapse?: () => void;
}

export function LayersPanel({ document, manager, selectedLayerIds, onSelectLayers, onFrameLayer, onDuplicateArtboard, onDeleteArtboard, onCollapse }: LayersPanelProps) {
  const [renamingId, setRenamingId] = useState<EntityId>();
  const [selectionAnchorId, setSelectionAnchorId] = useState<EntityId>();
  const [focusedLayerId, setFocusedLayerId] = useState<EntityId>();
  const [draggingLayerId, setDraggingLayerId] = useState<EntityId>();
  const [draftName, setDraftName] = useState('');
  const [renamingLocation, setRenamingLocation] = useState<'page' | 'artboard'>();
  const [locationName, setLocationName] = useState('');
  const realFrameIds = new Set(realArtboards(document).map((item) => item.id));
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [collapsedFrames, setCollapsedFrames] = useState<Set<EntityId>>(new Set());
  const [frameSelected, setFrameSelected] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; kind: 'layer' | 'frame' | 'page'; id?: EntityId }>();
  const artboard = document.activeArtboard;
  // Every frame of the page, in order, with its real (non-placeholder) layers. The hidden canvas root has no row of its own.
  const sections = document.activePage.artboardIds
    .map((id) => document.getArtboard(id))
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .filter((item) => item.isCanvasRoot || realFrameIds.has(item.id))
    .map((item) => ({ artboard: item, layerIds: item.layerIds.filter((layerId) => !isEmptyStarterLayer(document, layerId)) }));
  const needle = query.trim().toLowerCase();
  const matchSet = (() => {
    if (!needle) return undefined;
    const keep = new Set<EntityId>();
    const visit = (layerId: EntityId): boolean => {
      const layer = document.getLayer(layerId);
      if (!layer) return false;
      let hit = layer.name.toLowerCase().includes(needle);
      for (const childId of layer.childIds) if (visit(childId)) hit = true;
      if (hit) keep.add(layer.id);
      return hit;
    };
    sections.forEach((section) => section.layerIds.forEach(visit));
    return keep;
  })();
  const frameVisible = (item: (typeof sections)[number]) =>
    !needle || item.artboard.name.toLowerCase().includes(needle) || item.layerIds.some((id) => matchSet?.has(id));

  useEffect(() => {
    const existing = new Set([...selectedLayerIds].filter((id) => document.getLayer(id)));
    if (existing.size !== selectedLayerIds.size) onSelectLayers(existing);
  }, [document, onSelectLayers, selectedLayerIds]);

  const visibleLayerIds = (() => {
    const ids: EntityId[] = [];
    const visit = (layerId: EntityId) => {
      const layer = document.getLayer(layerId);
      if (!layer || (matchSet && !matchSet.has(layerId))) return;
      ids.push(layer.id);
      if (layer.kind !== 'object' && (layer.expanded || matchSet)) layer.childIds.forEach(visit);
    };
    for (const section of sections) {
      if (!frameVisible(section)) continue;
      if (section.artboard.isCanvasRoot || !collapsedFrames.has(section.artboard.id) || matchSet) section.layerIds.forEach(visit);
    }
    return ids;
  })();

  const activeFocusedLayerId = focusedLayerId && visibleLayerIds.includes(focusedLayerId)
    ? focusedLayerId
    : visibleLayerIds[0];

  const focusLayer = (layerId: EntityId) => {
    setFocusedLayerId(layerId);
    window.requestAnimationFrame(() => {
      const row = window.document.querySelector<HTMLElement>(`[data-layer-id="${CSS.escape(layerId)}"]`);
      row?.focus();
    });
  };

  const selectLayer = (layerId: EntityId, event: Pick<ReactMouseEvent, 'shiftKey' | 'metaKey' | 'ctrlKey'>) => {
    let next: Set<EntityId>;
    setFrameSelected(false);
    const owner = document.getLayer(layerId)?.artboardId;
    if (owner && owner !== document.activeArtboardId) {
      manager.execute({ type: 'SET_ACTIVE_LOCATION', payload: { pageId: document.activePageId, artboardId: owner } });
    }
    if (event.shiftKey && selectionAnchorId && visibleLayerIds.includes(selectionAnchorId)) {
      const start = visibleLayerIds.indexOf(selectionAnchorId);
      const end = visibleLayerIds.indexOf(layerId);
      const range = visibleLayerIds.slice(Math.min(start, end), Math.max(start, end) + 1);
      next = event.metaKey || event.ctrlKey
        ? new Set([...selectedLayerIds, ...range])
        : new Set(range);
    } else if (event.metaKey || event.ctrlKey) {
      next = new Set(selectedLayerIds);
      if (next.has(layerId)) next.delete(layerId); else next.add(layerId);
      setSelectionAnchorId(layerId);
    } else {
      next = new Set([layerId]);
      setSelectionAnchorId(layerId);
    }
    onSelectLayers(next);
  };

  const handleLayerKeyDown = (layer: LayerNode, event: ReactKeyboardEvent<HTMLDivElement>) => {
    const index = visibleLayerIds.indexOf(layer.id);
    let targetId: EntityId | undefined;
    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      move(layer, event.key === 'ArrowUp' ? -1 : 1);
    } else if (event.altKey && event.key === 'ArrowRight') {
      const siblings = layer.parentId
        ? document.getLayer(layer.parentId)?.childIds ?? []
        : document.getArtboard(layer.artboardId)?.layerIds ?? [];
      const previous = document.getLayer(siblings[Math.max(0, siblings.indexOf(layer.id) - 1)]);
      if (previous && previous.id !== layer.id && previous.kind !== 'object') {
        manager.execute({
          type: 'MOVE_LAYER',
          payload: { layerId: layer.id, parentId: previous.id, artboardId: layer.artboardId, index: previous.childIds.length },
        });
      }
    } else if (event.altKey && event.key === 'ArrowLeft') {
      const parent = layer.parentId ? document.getLayer(layer.parentId) : undefined;
      if (parent) {
        const grandSiblings = parent.parentId
          ? document.getLayer(parent.parentId)?.childIds ?? []
          : document.getArtboard(parent.artboardId)?.layerIds ?? [];
        manager.execute({
          type: 'MOVE_LAYER',
          payload: {
            layerId: layer.id,
            parentId: parent.parentId,
            artboardId: layer.artboardId,
            index: Math.max(0, grandSiblings.indexOf(parent.id) + 1),
          },
        });
      }
    } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'g') {
      if (event.shiftKey) ungroupSelected(); else groupSelected();
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      deleteSelected();
    } else if (event.key === 'ArrowDown') targetId = visibleLayerIds[Math.min(visibleLayerIds.length - 1, index + 1)];
    else if (event.key === 'ArrowUp') targetId = visibleLayerIds[Math.max(0, index - 1)];
    else if (event.key === 'Home') targetId = visibleLayerIds[0];
    else if (event.key === 'End') targetId = visibleLayerIds.at(-1);
    else if (event.key === 'ArrowRight' && layer.kind !== 'object') {
      if (!layer.expanded && layer.childIds.length > 0) {
        manager.execute({ type: 'UPDATE_LAYER', payload: { layerId: layer.id, updates: { expanded: true } } });
      } else targetId = layer.childIds[0];
    } else if (event.key === 'ArrowLeft') {
      if (layer.kind !== 'object' && layer.expanded && layer.childIds.length > 0) {
        manager.execute({ type: 'UPDATE_LAYER', payload: { layerId: layer.id, updates: { expanded: false } } });
      } else targetId = layer.parentId;
    } else if (event.key === ' ' || event.key === 'Spacebar') {
      selectLayer(layer.id, event);
    } else if (event.key === 'Enter' || event.key === 'F2') {
      setRenamingId(layer.id);
      setDraftName(layer.name);
    } else if (event.key.toLowerCase() === 'l') {
      manager.execute({ type: 'UPDATE_LAYER', payload: { layerId: layer.id, updates: { locked: !layer.locked } } });
    } else if (event.key.toLowerCase() === 'h') {
      manager.execute({ type: 'UPDATE_LAYER', payload: { layerId: layer.id, updates: { visible: !layer.visible } } });
    } else if (event.key.toLowerCase() === 'f') {
      onFrameLayer(layer.id);
    } else return;
    event.preventDefault();
    event.stopPropagation();
    if (targetId) focusLayer(targetId);
  };

  const addPage = () => {
    const pageId = createEntityId();
    const artboardId = createEntityId();
    const page = { id: pageId, name: `Page ${document.pages.length + 1}`, artboardIds: [] };
    const nextArtboard = {
      id: artboardId,
      pageId,
      name: 'Artboard 1',
      frame: { x: 0, y: 0, width: artboard.frame.width, height: artboard.frame.height },
      background: artboard.background,
      clipContent: artboard.clipContent,
      layerIds: [],
    };
    manager.beginTransaction('Add page');
    manager.execute({ type: 'ADD_PAGE', payload: { page } });
    manager.execute({ type: 'ADD_ARTBOARD', payload: { artboard: nextArtboard, pageId } });
    manager.execute({ type: 'SET_ACTIVE_LOCATION', payload: { pageId, artboardId } });
    manager.commitTransaction();
    onSelectLayers(new Set());
  };

  const addArtboard = () => {
    const page = document.activePage;
    const artboardId = createEntityId();
    const visibleArtboards = page.artboardIds
      .map((id) => document.getArtboard(id))
      .filter((item) => item && !item.isCanvasRoot);
    const reference = artboard.isCanvasRoot ? visibleArtboards[0] : artboard;
    const index = visibleArtboards.length;
    const baseFrame = reference?.frame ?? { x: 0, y: 0, width: 1024, height: 768 };
    const nextArtboard = {
      id: artboardId,
      pageId: page.id,
      name: `Artboard ${index + 1}`,
      frame: {
        x: baseFrame.x + 40 * index,
        y: baseFrame.y + 40 * index,
        width: baseFrame.width,
        height: baseFrame.height,
      },
      background: reference?.background ?? DEFAULT_ARTBOARD_BACKGROUND,
      clipContent: reference?.clipContent ?? false,
      layerIds: [],
    };
    manager.beginTransaction('Add artboard');
    manager.execute({ type: 'ADD_ARTBOARD', payload: { artboard: nextArtboard, pageId: page.id } });
    manager.execute({ type: 'SET_ACTIVE_LOCATION', payload: { pageId: page.id, artboardId } });
    manager.commitTransaction();
    onSelectLayers(new Set());
  };

  const removeActiveArtboard = () => {
    onDeleteArtboard();
    onSelectLayers(new Set());
  };

  const movePage = (direction: -1 | 1) => {
    const index = document.pages.findIndex((item) => item.id === document.activePageId);
    const next = index + direction;
    if (next >= 0 && next < document.pages.length) {
      manager.execute({ type: 'MOVE_PAGE', payload: { pageId: document.activePageId, index: next } });
    }
  };

  const moveArtboard = (direction: -1 | 1) => {
    const page = document.activePage;
    const index = page.artboardIds.indexOf(document.activeArtboardId);
    const next = index + direction;
    if (next >= 0 && next < page.artboardIds.length) {
      manager.execute({ type: 'MOVE_ARTBOARD', payload: { artboardId: document.activeArtboardId, pageId: page.id, index: next } });
    }
  };

  const commitLocationRename = () => {
    const name = locationName.trim();
    if (name && renamingLocation === 'page' && name !== document.activePage.name) {
      manager.execute({ type: 'UPDATE_PAGE', payload: { pageId: document.activePageId, updates: { name } } });
    } else if (name && renamingLocation === 'artboard' && name !== artboard.name) {
      manager.execute({ type: 'UPDATE_ARTBOARD', payload: { artboardId: artboard.id, updates: { name } } });
    }
    setRenamingLocation(undefined);
  };

  const addContainer = (kind: 'layer' | 'group') => {
    const id = createEntityId();
    const layer: LayerNode = {
      id,
      kind,
      name: kind === 'layer' ? 'New layer' : 'New group',
      artboardId: artboard.id,
      childIds: [],
      visible: true,
      locked: false,
      expanded: true,
    };
    manager.execute({ type: 'ADD_LAYER', payload: { layer, index: 0 } });
    onSelectLayers(new Set([id]));
    setRenamingId(id);
    setDraftName(layer.name);
  };

  const commitRename = (layer: LayerNode) => {
    const name = draftName.trim();
    if (name && name !== layer.name) {
      if (layer.objectId) manager.beginTransaction('Rename object');
      manager.execute({ type: 'UPDATE_LAYER', payload: { layerId: layer.id, updates: { name } } });
      if (layer.objectId) {
        manager.execute({ type: 'UPDATE_OBJECT', payload: { objectId: layer.objectId, updates: { name } } });
        manager.commitTransaction();
      }
    }
    setRenamingId(undefined);
  };

  const move = (layer: LayerNode, direction: -1 | 1) => {
    const siblings = layer.parentId
      ? document.getLayer(layer.parentId)?.childIds
      : document.getArtboard(layer.artboardId)?.layerIds;
    if (!siblings) return;
    const current = siblings.indexOf(layer.id);
    const next = current + direction;
    if (current < 0 || next < 0 || next >= siblings.length) return;
    manager.execute({
      type: 'MOVE_LAYER',
      payload: { layerId: layer.id, parentId: layer.parentId, artboardId: layer.artboardId, index: next },
    });
  };

  const selectedLayers = [...selectedLayerIds]
    .map((id) => document.getLayer(id))
    .filter((layer): layer is LayerNode => Boolean(layer));
  const selectedLayer = selectedLayers[0];
  const sameParentSelection = selectedLayers.length > 0 && selectedLayers.every((layer) =>
    layer.parentId === selectedLayers[0].parentId && layer.artboardId === selectedLayers[0].artboardId);

  const toggleIsolation = () => {
    manager.execute({
      type: 'SET_LAYER_ISOLATION',
      payload: { layerId: document.isolatedLayerId ? undefined : selectedLayer?.id },
    });
  };

  const selectedRoots = selectedLayers.filter((layer) => {
    let parentId = layer.parentId;
    while (parentId) {
      if (selectedLayerIds.has(parentId)) return false;
      parentId = document.getLayer(parentId)?.parentId;
    }
    return true;
  });

  const isDescendantOf = (layerId: EntityId, ancestorId: EntityId): boolean => {
    let parentId = document.getLayer(layerId)?.parentId;
    while (parentId) {
      if (parentId === ancestorId) return true;
      parentId = document.getLayer(parentId)?.parentId;
    }
    return false;
  };
  const dropLayer = (sourceId: EntityId, target: LayerNode, position: 'before' | 'inside' | 'after') => {
    const source = document.getLayer(sourceId);
    if (!source || source.id === target.id || isDescendantOf(target.id, source.id)) return;
    let parentId = target.parentId;
    let index = 0;
    if (position === 'inside' && target.kind !== 'object') {
      parentId = target.id;
      index = target.childIds.length;
    } else {
      const siblings = target.parentId
        ? document.getLayer(target.parentId)?.childIds ?? []
        : document.getArtboard(target.artboardId)?.layerIds ?? [];
      index = Math.max(0, siblings.indexOf(target.id) + (position === 'after' ? 1 : 0));
    }
    manager.execute({
      type: 'MOVE_LAYER',
      payload: { layerId: source.id, parentId, artboardId: target.artboardId, index },
    });
    setDraggingLayerId(undefined);
    onSelectLayers(new Set([source.id]));
    focusLayer(source.id);
  };

  const duplicateSubtree = (sourceId: EntityId, parentId: EntityId | undefined, index: number): EntityId | undefined => {
    const source = document.getLayer(sourceId);
    if (!source) return undefined;
    if (source.kind === 'object' && source.objectId) {
      const plan = prepareDuplicateObject(document, source.objectId);
      if (!plan) return undefined;
      for (const operation of plan.operations) manager.execute(operation);
      manager.execute({
        type: 'MOVE_LAYER',
        payload: { layerId: plan.layerId, parentId, artboardId: source.artboardId, index },
      });
      return plan.layerId;
    }
    const duplicateId = createEntityId();
    const childIds = [...source.childIds];
    manager.execute({
      type: 'ADD_LAYER',
      payload: {
        layer: {
          ...source,
          id: duplicateId,
          name: duplicateLayerName(source.name),
          parentId,
          childIds: [],
        },
        index,
      },
    });
    childIds.forEach((childId, childIndex) => duplicateSubtree(childId, duplicateId, childIndex));
    return duplicateId;
  };

  const duplicateSelected = () => {
    if (selectedRoots.length === 0) return;
    const duplicateLayerIds: EntityId[] = [];
    try {
      manager.beginTransaction(selectedRoots.length > 1 ? 'Duplicate layer subtrees' : 'Duplicate layer subtree');
      for (const layer of selectedRoots) {
        const siblings = layer.parentId
          ? document.getLayer(layer.parentId)?.childIds
          : document.getArtboard(layer.artboardId)?.layerIds;
        const duplicateId = duplicateSubtree(
          layer.id,
          layer.parentId,
          Math.max(0, (siblings?.indexOf(layer.id) ?? -1) + 1),
        );
        if (duplicateId) duplicateLayerIds.push(duplicateId);
      }
      manager.commitTransaction();
      onSelectLayers(new Set(duplicateLayerIds));
    } catch (error) {
      manager.rollbackTransaction();
      console.warn('Layer subtree duplication failed.', error);
    }
  };

  const deleteSubtree = (layerId: EntityId) => {
    const layer = document.getLayer(layerId);
    if (!layer) return;
    for (const childId of [...layer.childIds]) deleteSubtree(childId);
    const current = document.getLayer(layerId);
    if (!current) return;
    if (current.kind === 'object' && current.objectId) {
      const plan = prepareDeleteObject(document, current.objectId);
      if (plan) for (const operation of plan.operations) manager.execute(operation);
    } else {
      manager.execute({ type: 'REMOVE_LAYER', payload: { layer: { ...current, childIds: [] } } });
    }
  };

  const deleteSelected = () => {
    if (selectedRoots.length === 0) return;
    try {
      manager.beginTransaction(selectedRoots.length > 1 ? 'Delete layer subtrees' : 'Delete layer subtree');
      for (const layer of selectedRoots) deleteSubtree(layer.id);
      manager.commitTransaction();
      onSelectLayers(new Set());
    } catch (error) {
      manager.rollbackTransaction();
      console.warn('Layer subtree deletion failed.', error);
    }
  };

  const groupSelected = () => {
    if (!selectedLayer || !sameParentSelection) return;
    const siblings = selectedLayer.parentId
      ? document.getLayer(selectedLayer.parentId)?.childIds
      : document.getArtboard(selectedLayer.artboardId)?.layerIds;
    if (!siblings) return;
    const ordered = selectedLayers
      .filter((layer) => siblings.includes(layer.id))
      .sort((a, b) => siblings.indexOf(a.id) - siblings.indexOf(b.id));
    if (ordered.length === 0) return;
    const index = Math.max(0, Math.min(...ordered.map((layer) => siblings.indexOf(layer.id))));
    const group: LayerNode = {
      id: createEntityId(), kind: 'group', name: 'Group', artboardId: selectedLayer.artboardId,
      parentId: selectedLayer.parentId, childIds: [], visible: true, locked: false, expanded: true,
    };
    try {
      manager.beginTransaction(ordered.length > 1 ? 'Group layers' : 'Group layer');
      manager.execute({ type: 'ADD_LAYER', payload: { layer: group, index } });
      ordered.forEach((layer, childIndex) => manager.execute({
        type: 'MOVE_LAYER',
        payload: { layerId: layer.id, parentId: group.id, artboardId: layer.artboardId, index: childIndex },
      }));
      manager.commitTransaction();
      onSelectLayers(new Set([group.id]));
    } catch (error) {
      manager.rollbackTransaction();
      console.warn('Grouping failed.', error);
    }
  };

  const ungroupSelected = () => {
    if (!selectedLayer || selectedLayer.kind === 'object') return;
    const siblings = selectedLayer.parentId
      ? document.getLayer(selectedLayer.parentId)?.childIds
      : document.getArtboard(selectedLayer.artboardId)?.layerIds;
    const groupIndex = Math.max(0, siblings?.indexOf(selectedLayer.id) ?? 0);
    const childIds = [...selectedLayer.childIds];
    try {
      manager.beginTransaction('Ungroup layer');
      childIds.forEach((childId, index) => manager.execute({
        type: 'MOVE_LAYER',
        payload: {
          layerId: childId,
          parentId: selectedLayer.parentId,
          artboardId: selectedLayer.artboardId,
          index: groupIndex + index,
        },
      }));
      manager.execute({ type: 'REMOVE_LAYER', payload: { layer: { ...selectedLayer, childIds: [] } } });
      manager.commitTransaction();
      onSelectLayers(childIds[0] ? new Set([childIds[0]]) : new Set());
    } catch (error) {
      manager.rollbackTransaction();
      console.warn('Ungrouping failed.', error);
    }
  };

  const activePageIndex = document.pages.findIndex((item) => item.id === document.activePageId);
  const activeArtboardIndex = document.activePage.artboardIds.indexOf(document.activeArtboardId);
  const realFrames = sections.filter((section) => !section.artboard.isCanvasRoot);
  const looseSections = sections.filter((section) => section.artboard.isCanvasRoot);
  const nothingToShow = sections.every((section) => section.layerIds.length === 0) && realFrames.length === 0;
  const canGroup = selectedLayers.length > 0 && sameParentSelection;
  const canUngroup = selectedLayers.length === 1 && selectedLayer !== undefined && selectedLayer.kind !== 'object';
  const closeMenu = () => setMenu(undefined);

  useEffect(() => {
    if (!menu) return undefined;
    const close = () => setMenu(undefined);
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenu(undefined); };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', close);
    };
  }, [menu]);

  // ⌘G groups, ⌘⇧G ungroups, wherever focus is (not while typing in a field).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'g' || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
      if (event.shiftKey ? !canUngroup : !canGroup) return;
      event.preventDefault();
      if (event.shiftKey) ungroupSelected(); else groupSelected();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const toggleFrame = (artboardId: EntityId) => setCollapsedFrames((current) => {
    const next = new Set(current);
    if (next.has(artboardId)) next.delete(artboardId); else next.add(artboardId);
    return next;
  });

  const activateFrame = (artboardId: EntityId) => {
    if (artboardId !== document.activeArtboardId) {
      manager.execute({ type: 'SET_ACTIVE_LOCATION', payload: { pageId: document.activePageId, artboardId } });
    }
    onSelectLayers(new Set());
    setFrameSelected(true);
  };

  const dropOnFrame = (sourceId: EntityId, artboardId: EntityId) => {
    const source = document.getLayer(sourceId);
    const target = document.getArtboard(artboardId);
    if (!source || !target) return;
    manager.execute({
      type: 'MOVE_LAYER',
      payload: { layerId: source.id, parentId: undefined, artboardId, index: target.layerIds.length },
    });
    setDraggingLayerId(undefined);
    onSelectLayers(new Set([source.id]));
  };

  const commitFrameRename = (artboardId: EntityId) => {
    const name = draftName.trim();
    const target = document.getArtboard(artboardId);
    if (name && target && name !== target.name) {
      manager.execute({ type: 'UPDATE_ARTBOARD', payload: { artboardId, updates: { name } } });
    }
    setRenamingId(undefined);
  };

  const deleteFrame = (artboardId: EntityId) => {
    if (artboardId !== document.activeArtboardId) {
      manager.execute({ type: 'SET_ACTIVE_LOCATION', payload: { pageId: document.activePageId, artboardId } });
    }
    removeActiveArtboard();
  };
  const duplicateFrame = (artboardId: EntityId) => {
    if (artboardId !== document.activeArtboardId) {
      manager.execute({ type: 'SET_ACTIVE_LOCATION', payload: { pageId: document.activePageId, artboardId } });
    }
    onDuplicateArtboard();
  };

  const rowProps = {
    document, manager, selectedLayerIds,
    focusedLayerId: activeFocusedLayerId, renamingId, draftName, onDraftName: setDraftName,
    onSelect: selectLayer, onFocusLayer: focusLayer, onFrameLayer, onKeyDown: handleLayerKeyDown,
    draggingLayerId, onDragStart: setDraggingLayerId, onDragEnd: () => setDraggingLayerId(undefined),
    onDropLayer: dropLayer,
    onStartRename: (layer: LayerNode) => {
      window.setTimeout(() => { setRenamingId(layer.id); setDraftName(layer.name); }, 50);
    },
    onCommitRename: commitRename,
    onCancelRename: () => {
      const layerId = renamingId;
      setRenamingId(undefined);
      if (layerId) focusLayer(layerId);
    },
    visibleSet: matchSet,
    onContextMenu: (layer: LayerNode, event: ReactMouseEvent) => {
      event.preventDefault();
      if (!selectedLayerIds.has(layer.id)) selectLayer(layer.id, { shiftKey: false, metaKey: false, ctrlKey: false });
      setMenu({ x: event.clientX, y: event.clientY, kind: 'layer', id: layer.id });
    },
  };

  const menuLayer = menu?.kind === 'layer' && menu.id ? document.getLayer(menu.id) : undefined;
  const menuFrame = menu?.kind === 'frame' && menu.id ? document.getArtboard(menu.id) : undefined;
  const run = (action: () => void) => () => { closeMenu(); action(); };

  return (
    <section className="lp" aria-label="Document layers">
      <div className="lp-head">
        <h2>Layers</h2>
        <div className="lp-head-actions">
          <button type="button" className={`lp-icon${searchOpen ? ' is-on' : ''}`} title="Search layers" aria-label="Search layers" aria-pressed={searchOpen} onClick={() => { setSearchOpen((value) => !value); if (searchOpen) setQuery(''); }}><LpIcon name="search" /></button>
          <button type="button" className="lp-icon" title="New frame" aria-label="New frame" onClick={addArtboard}><LpIcon name="frame" /></button>
          <button type="button" className="lp-icon" title="New group" aria-label="New group" onClick={() => addContainer('group')}><LpIcon name="plus" /></button>
          <button type="button" className="lp-icon" title="Page options" aria-label="Page options" onClick={(event) => {
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            setMenu({ x: rect.right - 188, y: rect.bottom + 4, kind: 'page' });
          }} onPointerDown={(event) => event.stopPropagation()}><LpIcon name="more" /></button>
          {onCollapse && <button type="button" className="lp-icon lp-collapse" aria-label="Collapse panels" title="Collapse Layers and Design" onClick={onCollapse}><LpIcon name="right" /></button>}
        </div>
      </div>
      <div className="lp-page-row">
        {renamingLocation === 'page' ? (
          <input autoFocus aria-label="Page name" value={locationName} onChange={(event) => setLocationName(event.target.value)} onBlur={commitLocationRename} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') setRenamingLocation(undefined); }} />
        ) : (
          <select
            aria-label="Active page"
            value={document.activePageId}
            onChange={(event) => {
              const page = document.getPage(event.target.value);
              const artboardId = page?.artboardIds[0];
              if (page && artboardId) manager.execute({ type: 'SET_ACTIVE_LOCATION', payload: { pageId: page.id, artboardId } });
              onSelectLayers(new Set());
            }}
          >
            {document.pages.map((page) => <option value={page.id} key={page.id}>{page.name}</option>)}
          </select>
        )}
      </div>
      {searchOpen && (
        <div className="lp-search">
          <LpIcon name="search" />
          <input autoFocus value={query} placeholder="Find a layer" aria-label="Find a layer" onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') { setQuery(''); setSearchOpen(false); } }} />
          {query && <button type="button" className="lp-icon" aria-label="Clear search" onClick={() => setQuery('')}>×</button>}
        </div>
      )}

      <div
        className="lp-tree"
        role={nothingToShow ? 'status' : 'tree'}
        aria-multiselectable={nothingToShow ? undefined : 'true'}
        aria-label={nothingToShow ? undefined : `${document.activePage.name} layers`}
        onClick={(event) => { if (event.target === event.currentTarget) { onSelectLayers(new Set()); setFrameSelected(false); } }}
      >
        {nothingToShow ? (
          <p className="lp-empty">Nothing here yet. Draw a shape, or press + to add a frame.</p>
        ) : (
          <>
            {looseSections.map((section) => section.layerIds.filter((id) => !matchSet || matchSet.has(id)).map((layerId) => (
              <LayerRow key={layerId} {...rowProps} layerId={layerId} depth={0} />
            )))}
            {realFrames.filter(frameVisible).map((section) => {
              const frame = section.artboard;
              const collapsed = collapsedFrames.has(frame.id) && !matchSet;
              const active = frame.id === document.activeArtboardId;
              const selectedFrame = active && frameSelected && selectedLayerIds.size === 0;
              const children = section.layerIds.filter((id) => !matchSet || matchSet.has(id));
              return (
                <div className="lp-branch" key={frame.id}>
                  <div
                    className={`lp-row lp-frame${selectedFrame ? ' is-selected' : ''}${active ? ' is-active' : ''}`}
                    role="treeitem"
                    aria-level={1}
                    aria-selected={selectedFrame}
                    aria-expanded={!collapsed}
                    aria-label={`${frame.name}, frame`}
                    tabIndex={0}
                    onClick={(event) => {
                      if (event.detail >= 2) { setRenamingId(frame.id); setDraftName(frame.name); return; }
                      activateFrame(frame.id);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === 'F2') { setRenamingId(frame.id); setDraftName(frame.name); event.preventDefault(); }
                      else if (event.key === 'ArrowLeft' && !collapsed) { toggleFrame(frame.id); event.preventDefault(); }
                      else if (event.key === 'ArrowRight' && collapsed) { toggleFrame(frame.id); event.preventDefault(); }
                      else if (event.key === ' ') { activateFrame(frame.id); event.preventDefault(); }
                    }}
                    onContextMenu={(event) => { event.preventDefault(); activateFrame(frame.id); setMenu({ x: event.clientX, y: event.clientY, kind: 'frame', id: frame.id }); }}
                    onDragOver={(event) => { if (draggingLayerId) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; } }}
                    onDrop={(event) => { event.preventDefault(); event.stopPropagation(); const sourceId = draggingLayerId ?? event.dataTransfer.getData('text/plain'); if (sourceId) dropOnFrame(sourceId, frame.id); }}
                  >
                    <button type="button" className="lp-chevron" aria-label={collapsed ? 'Expand frame' : 'Collapse frame'} tabIndex={-1} onClick={(event) => { event.stopPropagation(); toggleFrame(frame.id); }}>
                      <LpIcon name={collapsed ? 'right' : 'down'} />
                    </button>
                    <span className="lp-kind"><LpIcon name="frame" /></span>
                    {renamingId === frame.id ? (
                      <input className="lp-name-input" autoFocus value={draftName} aria-label="Frame name" onChange={(event) => setDraftName(event.target.value)} onClick={(event) => event.stopPropagation()} onBlur={() => commitFrameRename(frame.id)} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') { event.stopPropagation(); setRenamingId(undefined); } }} />
                    ) : <span className="lp-name" title={frame.name}>{frame.name}</span>}
                    <span className="lp-meta">{frame.frame.width}×{frame.frame.height}</span>
                  </div>
                  {!collapsed && (
                    <div role="group">
                      {children.length === 0
                        ? <p className="lp-empty lp-empty-frame">Empty frame</p>
                        : children.map((layerId) => <LayerRow key={layerId} {...rowProps} layerId={layerId} depth={1} />)}
                    </div>
                  )}
                </div>
              );
            })}
            {needle && visibleLayerIds.length === 0 && <p className="lp-empty">No layer called “{query}”.</p>}
          </>
        )}
      </div>

      {selectedRoots.length > 0 && (
        <div className="lp-selection-bar" role="toolbar" aria-label="Layer actions">
          <span>{selectedRoots.length === 1 ? '1 selected' : `${selectedRoots.length} selected`}</span>
          <span className="lp-bar-actions">
            <button type="button" disabled={!canGroup} onClick={groupSelected} title={`Group · ${MOD}G`}><LpIcon name="group" />Group</button>
            <button type="button" disabled={!canUngroup} onClick={ungroupSelected} title={`Ungroup · ${MOD}⇧G`}>Ungroup</button>
            <button type="button" onClick={duplicateSelected} title="Duplicate" aria-label="Duplicate"><LpIcon name="copy" /></button>
            <button type="button" onClick={deleteSelected} title="Delete" aria-label="Delete"><LpIcon name="trash" /></button>
          </span>
        </div>
      )}

      {menu && (
        <div className="lp-menu" role="menu" style={{ left: Math.min(menu.x, window.innerWidth - 204), top: Math.min(menu.y, window.innerHeight - 330) }} onPointerDown={(event) => event.stopPropagation()}>
          {menu.kind === 'layer' && menuLayer && (
            <>
              <button type="button" role="menuitem" onClick={run(() => { setRenamingId(menuLayer.id); setDraftName(menuLayer.name); })}>Rename<kbd>F2</kbd></button>
              <button type="button" role="menuitem" disabled={!canGroup} onClick={run(groupSelected)}>Group selection<kbd>{MOD}G</kbd></button>
              <button type="button" role="menuitem" disabled={!canUngroup} onClick={run(ungroupSelected)}>Ungroup<kbd>{MOD}⇧G</kbd></button>
              <hr />
              <button type="button" role="menuitem" onClick={run(duplicateSelected)}>Duplicate</button>
              <button type="button" role="menuitem" onClick={run(() => move(menuLayer, -1))}>Bring forward<kbd>⌥↑</kbd></button>
              <button type="button" role="menuitem" onClick={run(() => move(menuLayer, 1))}>Send backward<kbd>⌥↓</kbd></button>
              <hr />
              <button type="button" role="menuitem" onClick={run(() => onFrameLayer(menuLayer.id))}>Zoom to it<kbd>F</kbd></button>
              <button type="button" role="menuitem" disabled={selectedLayers.length !== 1} onClick={run(toggleIsolation)}>{document.isolatedLayerId ? 'Exit isolate' : 'Isolate'}</button>
              <button type="button" role="menuitem" onClick={run(() => manager.execute({ type: 'UPDATE_LAYER', payload: { layerId: menuLayer.id, updates: { locked: !menuLayer.locked } } }))}>{menuLayer.locked ? 'Unlock' : 'Lock'}<kbd>L</kbd></button>
              <button type="button" role="menuitem" onClick={run(() => manager.execute({ type: 'UPDATE_LAYER', payload: { layerId: menuLayer.id, updates: { visible: !menuLayer.visible } } }))}>{menuLayer.visible ? 'Hide' : 'Show'}<kbd>H</kbd></button>
              <hr />
              <button type="button" role="menuitem" className="is-danger" onClick={run(deleteSelected)}>Delete<kbd>⌫</kbd></button>
            </>
          )}
          {menu.kind === 'frame' && menuFrame && (
            <>
              <button type="button" role="menuitem" onClick={run(() => { setRenamingId(menuFrame.id); setDraftName(menuFrame.name); })}>Rename frame<kbd>F2</kbd></button>
              <button type="button" role="menuitem" onClick={run(() => duplicateFrame(menuFrame.id))}>Duplicate frame</button>
              <button type="button" role="menuitem" disabled={activeArtboardIndex <= 0} onClick={run(() => moveArtboard(-1))}>Move up</button>
              <button type="button" role="menuitem" disabled={activeArtboardIndex >= document.activePage.artboardIds.length - 1} onClick={run(() => moveArtboard(1))}>Move down</button>
              <hr />
              <button type="button" role="menuitem" className="is-danger" onClick={run(() => deleteFrame(menuFrame.id))}>Delete frame and contents</button>
            </>
          )}
          {menu.kind === 'page' && (
            <>
              <button type="button" role="menuitem" onClick={run(addArtboard)}>New frame</button>
              <button type="button" role="menuitem" onClick={run(() => addContainer('group'))}>New group</button>
              <button type="button" role="menuitem" onClick={run(() => addContainer('layer'))}>New layer</button>
              <hr />
              <button type="button" role="menuitem" onClick={run(addPage)}>Add page</button>
              <button type="button" role="menuitem" onClick={run(() => { setRenamingLocation('page'); setLocationName(document.activePage.name); })}>Rename page</button>
              <button type="button" role="menuitem" disabled={activePageIndex <= 0} onClick={run(() => movePage(-1))}>Move page up</button>
              <button type="button" role="menuitem" disabled={activePageIndex >= document.pages.length - 1} onClick={run(() => movePage(1))}>Move page down</button>
            </>
          )}
        </div>
      )}
    </section>
  );
}

const MOD = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform) ? '⌘' : 'Ctrl+';

type LpIconName = 'search' | 'frame' | 'plus' | 'more' | 'right' | 'down' | 'group' | 'layer' | 'repeat' | 'copy' | 'trash' | 'lock' | 'eye' | 'eyeOff';
const LP_PATHS: Record<LpIconName, string> = {
  search: 'M7 12a5 5 0 100-10 5 5 0 000 10zM14 14l-3.5-3.5',
  frame: 'M5.5 1.5v13M10.5 1.5v13M1.5 5.5h13M1.5 10.5h13',
  plus: 'M8 3v10M3 8h10',
  more: 'M3.5 8h.01M8 8h.01M12.5 8h.01',
  right: 'M6 3.5 10.5 8 6 12.5',
  down: 'M3.5 6 8 10.5 12.5 6',
  group: 'M2.5 5V3.5a1 1 0 011-1H5M11 2.5h1.5a1 1 0 011 1V5M13.5 11v1.5a1 1 0 01-1 1H11M5 13.5H3.5a1 1 0 01-1-1V11M5.5 5.5h5v5h-5z',
  layer: 'M8 2 14 5.2 8 8.4 2 5.2 8 2zM2 8.2l6 3.2 6-3.2M2 11l6 3.2 6-3.2',
  repeat: 'M13 8a5 5 0 11-1.6-3.7M13 2.5v3h-3',
  copy: 'M5.5 5.5h8v8h-8zM10.5 5.5v-3h-8v8h3',
  trash: 'M3 4.5h10M6.5 4.5v-2h3v2M4.5 4.5l.6 9h5.8l.6-9',
  lock: 'M4.5 7.5h7v6h-7zM6 7.5v-2a2 2 0 014 0v2',
  eye: 'M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM8 9.8a1.8 1.8 0 100-3.6 1.8 1.8 0 000 3.6z',
  eyeOff: 'M2 2l12 12M6.4 4a6 6 0 011.6-.5c4 0 6.5 4.5 6.5 4.5a11 11 0 01-2 2.5M4 5.5C2.5 6.8 1.5 8 1.5 8S4 12.5 8 12.5c.9 0 1.7-.2 2.4-.5',
};
function LpIcon({ name, size = 14 }: { name: LpIconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={LP_PATHS[name]} /></svg>;
}

interface LayerRowProps {
  document: VectorDocument;
  manager: OperationManager;
  layerId: EntityId;
  depth: number;
  selectedLayerIds: Set<EntityId>;
  focusedLayerId?: EntityId;
  renamingId?: EntityId;
  draftName: string;
  visibleSet?: Set<EntityId>;
  onDraftName: (name: string) => void;
  onSelect: (layerId: EntityId, event: ReactMouseEvent) => void;
  onFocusLayer: (layerId: EntityId) => void;
  onFrameLayer: (layerId: EntityId) => void;
  onKeyDown: (layer: LayerNode, event: ReactKeyboardEvent<HTMLDivElement>) => void;
  draggingLayerId?: EntityId;
  onDragStart: (layerId: EntityId) => void;
  onDragEnd: () => void;
  onDropLayer: (sourceId: EntityId, target: LayerNode, position: 'before' | 'inside' | 'after') => void;
  onStartRename: (layer: LayerNode) => void;
  onCommitRename: (layer: LayerNode) => void;
  onCancelRename: () => void;
  onContextMenu: (layer: LayerNode, event: ReactMouseEvent) => void;
}

/** A 14 px drawing of the object's real outline, so the row looks like what it is. */
function ObjectShapeIcon({ document, objectId, construction }: { document: VectorDocument; objectId?: EntityId; construction: boolean }) {
  if (construction) {
    return <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M7 1.5v11" stroke="currentColor" strokeWidth="1.4" strokeDasharray="2 2" strokeLinecap="round" /></svg>;
  }
  const object = objectId ? document.getObject(objectId) : undefined;
  const network = object ? document.getNetwork(object.networkId) : undefined;
  const lines: Array<Array<{ x: number; y: number }>> = [];
  if (network) {
    for (const pathId of network.pathIds) {
      for (const segmentId of document.getPath(pathId)?.segmentIds ?? []) {
        const segment = document.getSegment(segmentId);
        if (!segment || segment.role !== 'geometry') continue;
        const steps = segment.type === 'line' ? 1 : 12;
        lines.push(Array.from({ length: steps + 1 }, (_value, index) => evaluateSegment(document, segment, index / steps)));
      }
    }
  }
  const all = lines.flat();
  if (all.length === 0) return <StackIcon size={14} />;
  const minX = Math.min(...all.map((point) => point.x));
  const maxX = Math.max(...all.map((point) => point.x));
  const minY = Math.min(...all.map((point) => point.y));
  const maxY = Math.max(...all.map((point) => point.y));
  const scale = 10 / Math.max(maxX - minX, maxY - minY, 0.0001);
  const offsetX = 2 + (10 - (maxX - minX) * scale) / 2;
  const offsetY = 2 + (10 - (maxY - minY) * scale) / 2;
  const d = lines.map((line) => line.map((point, index) => `${index === 0 ? 'M' : 'L'}${((point.x - minX) * scale + offsetX).toFixed(2)} ${((point.y - minY) * scale + offsetY).toFixed(2)}`).join('')).join('');
  return <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d={d} stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function isEmptyStarterLayer(document: VectorDocument, layerId: EntityId): boolean {
  const layer = document.getLayer(layerId);
  if (!layer) return true;
  if (layer.kind === 'object' && layer.objectId) {
    const object = document.getObject(layer.objectId);
    const network = object ? document.getNetwork(object.networkId) : undefined;
    return Boolean(network && network.nodeIds.length === 0 && network.pathIds.length === 0 &&
      /^Vector Network 1$/i.test(layer.name));
  }
  return /^Layer 1$/i.test(layer.name) && layer.childIds.length > 0 &&
    layer.childIds.every((childId) => isEmptyStarterLayer(document, childId));
}

function duplicateLayerName(name: string): string {
  const match = name.match(/^(.*) copy(?: (\d+))?$/i);
  if (!match) return `${name} copy`;
  return `${match[1]} copy ${Number(match[2] ?? 1) + 1}`;
}
function LayerRow(props: LayerRowProps) {
  const { document, manager, layerId, depth, selectedLayerIds, focusedLayerId, renamingId, draftName, visibleSet,
    onDraftName, onSelect, onFocusLayer, onKeyDown, draggingLayerId, onDragStart, onDragEnd, onDropLayer,
    onStartRename, onCommitRename, onCancelRename, onContextMenu, onFrameLayer } = props;
  const [dropHint, setDropHint] = useState<'before' | 'inside' | 'after'>();
  const layer = document.getLayer(layerId);
  if (!layer) return null;
  const isContainer = layer.kind !== 'object';
  const expandable = isContainer && layer.childIds.length > 0;
  const open = Boolean(visibleSet) || layer.expanded;
  const selected = selectedLayerIds.has(layer.id);
  const constructionComposition = layer.kind === 'object' && layer.objectId
    ? objectConstructionComposition(document, layer.objectId)
    : undefined;
  const semanticLabel = constructionComposition === 'construction-only'
    ? 'construction-only object'
    : constructionComposition === 'mixed' ? 'object containing construction geometry' : layer.kind;
  const children = layer.childIds.filter((id) => !visibleSet || visibleSet.has(id));

  return (
    <div className="lp-branch">
      <div
        className={`lp-row${selected ? ' is-selected' : ''}${!layer.visible ? ' is-hidden' : ''}${layer.locked ? ' is-locked' : ''}${draggingLayerId === layer.id ? ' is-dragging' : ''}${dropHint ? ` drop-${dropHint}` : ''}`}
        style={{ '--lp-depth': depth } as React.CSSProperties}
        role="treeitem"
        data-layer-id={layer.id}
        draggable={renamingId !== layer.id}
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', layer.id);
          onDragStart(layer.id);
        }}
        onDragEnd={() => { setDropHint(undefined); onDragEnd(); }}
        onDragLeave={() => setDropHint(undefined)}
        onDragOver={(event) => {
          if (!draggingLayerId || draggingLayerId === layer.id) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          const rect = event.currentTarget.getBoundingClientRect();
          const ratio = (event.clientY - rect.top) / Math.max(1, rect.height);
          setDropHint(isContainer && ratio >= 0.3 && ratio <= 0.7 ? 'inside' : ratio < 0.5 ? 'before' : 'after');
        }}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          const sourceId = draggingLayerId ?? event.dataTransfer.getData('text/plain');
          const position = dropHint ?? 'after';
          setDropHint(undefined);
          if (sourceId) onDropLayer(sourceId, layer, position);
        }}
        tabIndex={focusedLayerId === layer.id ? 0 : -1}
        aria-level={depth + 1}
        aria-label={`${layer.name}, ${semanticLabel}`}
        aria-selected={selected}
        aria-expanded={isContainer ? layer.expanded : undefined}
        onFocus={(event) => { if (event.target === event.currentTarget) onFocusLayer(layer.id); }}
        onKeyDown={(event) => onKeyDown(layer, event)}
        onContextMenu={(event) => onContextMenu(layer, event)}
        onClick={(event) => {
          event.currentTarget.focus();
          if (event.detail >= 2) {
            if (isContainer) onStartRename(layer); else onFrameLayer(layer.id);
            return;
          }
          onSelect(layer.id, event);
        }}
      >
        <button
          type="button"
          className="lp-chevron"
          aria-label={open ? 'Collapse layer' : 'Expand layer'}
          tabIndex={-1}
          disabled={!expandable}
          onClick={(event) => {
            event.stopPropagation();
            if (expandable) manager.execute({ type: 'UPDATE_LAYER', payload: { layerId: layer.id, updates: { expanded: !layer.expanded } } });
          }}
        >{expandable ? <LpIcon name={open ? 'down' : 'right'} /> : null}</button>
        <span className="lp-kind" title={constructionComposition === 'construction-only' ? 'Construction-only object' : undefined}>
          {layer.kind === 'object'
            ? <ObjectShapeIcon document={document} objectId={layer.objectId} construction={constructionComposition === 'construction-only'} />
            : layer.kind === 'group' ? <LpIcon name="group" /> : <LpIcon name="layer" />}
        </span>
        {renamingId === layer.id ? (
          <input
            className="lp-name-input"
            autoFocus
            value={draftName}
            aria-label="Layer name"
            onChange={(event) => onDraftName(event.target.value)}
            onClick={(event) => event.stopPropagation()}
            onFocus={(event) => event.currentTarget.select()}
            onBlur={() => onCommitRename(layer)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.currentTarget.blur();
                window.requestAnimationFrame(() => onFocusLayer(layer.id));
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                onDraftName(layer.name);
                onCancelRename();
              }
            }}
          />
        ) : <span className="lp-name" title={layer.name}>{layer.name}</span>}
        {constructionComposition === 'construction-only' && <span className="lp-meta">guide</span>}
        {constructionComposition === 'mixed' && <span className="lp-meta" title="Contains construction geometry">C</span>}
        <button
          type="button"
          className={`lp-state${layer.locked ? ' is-set' : ''}`}
          title={layer.locked ? 'Unlock' : 'Lock'}
          aria-label={layer.locked ? 'Unlock layer' : 'Lock layer'}
          tabIndex={-1}
          onClick={(event) => {
            event.stopPropagation();
            manager.execute({ type: 'UPDATE_LAYER', payload: { layerId: layer.id, updates: { locked: !layer.locked } } });
          }}
        ><LpIcon name="lock" /></button>
        <button
          type="button"
          className={`lp-state${!layer.visible ? ' is-set' : ''}`}
          title={layer.visible ? 'Hide' : 'Show'}
          aria-label={layer.visible ? 'Hide layer' : 'Show layer'}
          tabIndex={-1}
          onClick={(event) => {
            event.stopPropagation();
            manager.execute({ type: 'UPDATE_LAYER', payload: { layerId: layer.id, updates: { visible: !layer.visible } } });
          }}
        ><LpIcon name={layer.visible ? 'eye' : 'eyeOff'} /></button>
      </div>
      {isContainer && open && children.length > 0 && (
        <div role="group">
          {children.map((childId) => <LayerRow {...props} key={childId} layerId={childId} depth={depth + 1} />)}
        </div>
      )}
    </div>
  );
}
