import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { ChevronDownIcon } from '@primer/octicons-react/ChevronDownIcon';
import { ChevronRightIcon } from '@primer/octicons-react/ChevronRightIcon';
import { ChevronUpIcon } from '@primer/octicons-react/ChevronUpIcon';
import { DuplicateIcon } from '@primer/octicons-react/DuplicateIcon';
import { EyeClosedIcon } from '@primer/octicons-react/EyeClosedIcon';
import { EyeIcon } from '@primer/octicons-react/EyeIcon';
import { FileDirectoryIcon } from '@primer/octicons-react/FileDirectoryIcon';
import { LockIcon } from '@primer/octicons-react/LockIcon';
import { PlusIcon } from '@primer/octicons-react/PlusIcon';
import { RowsIcon } from '@primer/octicons-react/RowsIcon';
import { StackIcon } from '@primer/octicons-react/StackIcon';
import { TrashIcon } from '@primer/octicons-react/TrashIcon';
import { UnlockIcon } from '@primer/octicons-react/UnlockIcon';
import type { VectorDocument } from '../core/document';
import { createEntityId } from '../core/ids';
import { prepareDeleteObject, prepareDuplicateObject } from '../core/object-operations';
import type { OperationManager } from '../core/operations';
import { objectConstructionComposition } from '../core/segment-semantics';
import type { EntityId, LayerNode } from '../core/types';

interface LayersPanelProps {
  document: VectorDocument;
  manager: OperationManager;
  selectedLayerIds: Set<EntityId>;
  onSelectLayers: (layerIds: Set<EntityId>) => void;
  onFrameLayer: (layerId: EntityId) => void;
  onDuplicateArtboard: () => void;
  onDeleteArtboard: () => void;
}

export function LayersPanel({ document, manager, selectedLayerIds, onSelectLayers, onFrameLayer, onDuplicateArtboard, onDeleteArtboard }: LayersPanelProps) {
  const [renamingId, setRenamingId] = useState<EntityId>();
  const [selectionAnchorId, setSelectionAnchorId] = useState<EntityId>();
  const [focusedLayerId, setFocusedLayerId] = useState<EntityId>();
  const [draggingLayerId, setDraggingLayerId] = useState<EntityId>();
  const [draftName, setDraftName] = useState('');
  const [renamingLocation, setRenamingLocation] = useState<'page' | 'artboard'>();
  const [locationName, setLocationName] = useState('');
  const artboard = document.activeArtboard;
  const displayLayerIds = artboard.layerIds.filter((layerId) => !isEmptyStarterLayer(document, layerId));

  useEffect(() => {
    const existing = new Set([...selectedLayerIds].filter((id) => document.getLayer(id)));
    if (existing.size !== selectedLayerIds.size) onSelectLayers(existing);
  }, [document, onSelectLayers, selectedLayerIds]);

  const visibleLayerIds = (() => {
    const ids: EntityId[] = [];
    const visit = (layerId: EntityId) => {
      const layer = document.getLayer(layerId);
      if (!layer) return;
      ids.push(layer.id);
      if (layer.kind !== 'object' && layer.expanded) layer.childIds.forEach(visit);
    };
    displayLayerIds.forEach(visit);
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
      background: reference?.background ?? '#ffffff',
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
  const moveTargets = [...document.layers.values()].filter((layer) =>
    layer.artboardId === artboard.id &&
    layer.kind !== 'object' &&
    !selectedLayerIds.has(layer.id) &&
    !selectedRoots.some((root) => isDescendantOf(layer.id, root.id)));

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

  const moveSelectedTo = (parentId: EntityId | undefined) => {
    if (selectedRoots.length === 0) return;
    const parent = parentId ? document.getLayer(parentId) : undefined;
    const targetIds = parent?.childIds ?? document.getArtboard(artboard.id)?.layerIds ?? [];
    try {
      manager.beginTransaction(selectedRoots.length > 1 ? 'Move layers' : 'Move layer');
      selectedRoots.forEach((layer, offset) => manager.execute({
        type: 'MOVE_LAYER',
        payload: {
          layerId: layer.id,
          parentId,
          artboardId: artboard.id,
          index: targetIds.length + offset,
        },
      }));
      manager.commitTransaction();
    } catch (error) {
      manager.rollbackTransaction();
      console.warn('Moving layers failed.', error);
    }
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

  return (
    <section className="layers-panel" aria-label="Document layers">
      <div className="layers-panel-heading">
        <div>
          <span className="eyebrow">DOCUMENT</span>
          <h2>Layers</h2>
        </div>
        <div className="layers-heading-meta">
          <span className="layers-location-summary">{document.activePage.name} / {artboard.name}</span>
          <div className="layers-heading-actions">
            <button type="button" title="Add layer" aria-label="Add layer" onClick={() => addContainer('layer')}><PlusIcon size={16} /></button>
            <button type="button" title="Add group" aria-label="Add group" onClick={() => addContainer('group')}><FileDirectoryIcon size={16} /></button>
          </div>
        </div>
      </div>

      <div className="document-location">
        <div className="location-selectors">
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
              }}
            >
              {document.pages.map((page) => <option value={page.id} key={page.id}>{page.name}</option>)}
            </select>
          )}
          <span>/</span>
          {renamingLocation === 'artboard' ? (
            <input autoFocus aria-label="Artboard name" value={locationName} onChange={(event) => setLocationName(event.target.value)} onBlur={commitLocationRename} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') setRenamingLocation(undefined); }} />
          ) : (
            <select
              aria-label="Active artboard"
              value={document.activeArtboardId}
              onChange={(event) => manager.execute({
                type: 'SET_ACTIVE_LOCATION',
                payload: { pageId: document.activePageId, artboardId: event.target.value },
              })}
            >
              {document.activePage.artboardIds.map((id) => {
                const item = document.getArtboard(id);
                return item ? <option value={item.id} key={item.id}>{item.name}</option> : null;
              })}
            </select>
          )}
        </div>
        <div className="location-actions" aria-label="Page and artboard actions">
          <details>
            <summary>Page</summary>
            <div className="location-action-menu">
              <button type="button" onClick={addPage}><PlusIcon size={12} />Add page</button>
              <button type="button" onClick={() => { setRenamingLocation('page'); setLocationName(document.activePage.name); }}>Rename page</button>
              <button type="button" title={activePageIndex <= 0 ? 'Page is already first' : undefined} disabled={activePageIndex <= 0} onClick={() => movePage(-1)}><ChevronUpIcon size={12} />Move page up</button>
              <button type="button" title={activePageIndex >= document.pages.length - 1 ? 'Page is already last' : undefined} disabled={activePageIndex >= document.pages.length - 1} onClick={() => movePage(1)}><ChevronDownIcon size={12} />Move page down</button>
            </div>
          </details>
          <details>
            <summary>Artboard</summary>
            <div className="location-action-menu">
              <button type="button" onClick={addArtboard}><PlusIcon size={12} />Add artboard</button>
              <button type="button" disabled={Boolean(artboard.isCanvasRoot)} onClick={onDuplicateArtboard}><DuplicateIcon size={12} />Duplicate artboard</button>
              <button type="button" onClick={() => { setRenamingLocation('artboard'); setLocationName(artboard.name); }}>Rename artboard</button>
              <button type="button" title={activeArtboardIndex <= 0 ? 'Artboard is already first' : undefined} disabled={activeArtboardIndex <= 0} onClick={() => moveArtboard(-1)}><ChevronUpIcon size={12} />Move artboard up</button>
              <button type="button" title={activeArtboardIndex >= document.activePage.artboardIds.length - 1 ? 'Artboard is already last' : undefined} disabled={activeArtboardIndex >= document.activePage.artboardIds.length - 1} onClick={() => moveArtboard(1)}><ChevronDownIcon size={12} />Move artboard down</button>
              <button
                type="button"
                disabled={Boolean(artboard.isCanvasRoot)}
                title={artboard.isCanvasRoot ? 'The Canvas is the page-level container.' : 'Delete artboard and its contents'}
                onClick={removeActiveArtboard}
              ><TrashIcon size={12} />Delete artboard</button>
            </div>
          </details>
        </div>
      </div>

      <div
        className="layer-tree"
        role={displayLayerIds.length > 0 ? 'tree' : 'status'}
        aria-multiselectable={displayLayerIds.length > 0 ? 'true' : undefined}
        aria-label={displayLayerIds.length > 0 ? `${artboard.name} layers` : undefined}
      >
        {displayLayerIds.length === 0 ? (
          <p className="empty-layer-tree">{artboard.isCanvasRoot ? 'The canvas has no layers yet. Draw an object or add a frame to begin.' : 'This artboard has no layers yet. Draw a shape or add a layer to begin.'}</p>
        ) : displayLayerIds.map((layerId) => (
          <LayerRow
            key={layerId}
            document={document}
            manager={manager}
            layerId={layerId}
            depth={0}
            selectedLayerIds={selectedLayerIds}
            focusedLayerId={activeFocusedLayerId}
            renamingId={renamingId}
            draftName={draftName}
            onDraftName={setDraftName}
            onSelect={selectLayer}
            onFocusLayer={focusLayer}
            onFrameLayer={onFrameLayer}
            onKeyDown={handleLayerKeyDown}
            draggingLayerId={draggingLayerId}
            onDragStart={setDraggingLayerId}
            onDragEnd={() => setDraggingLayerId(undefined)}
            onDropLayer={dropLayer}
            onStartRename={(layer) => {
              window.setTimeout(() => {
                setRenamingId(layer.id);
                setDraftName(layer.name);
              }, 50);
            }}
            onCommitRename={commitRename}
            onCancelRename={() => {
              const layerId = renamingId;
              setRenamingId(undefined);
              if (layerId) focusLayer(layerId);
            }}
            onMove={move}
          />
        ))}
      </div>
      <div className="layer-footer-actions" aria-label="Layer actions">
        <button type="button" disabled={selectedRoots.length === 0} onClick={duplicateSelected} title="Duplicate selected layer subtrees"><DuplicateIcon size={13} />Duplicate</button>
        <button type="button" disabled={selectedRoots.length === 0} onClick={deleteSelected} title="Delete selected layer subtrees"><TrashIcon size={13} /></button>
        <button type="button" disabled={!selectedLayer || !sameParentSelection} onClick={groupSelected}><FileDirectoryIcon size={13} />Group</button>
        <button type="button" disabled={selectedLayers.length !== 1 || !selectedLayer || selectedLayer.kind === 'object'} onClick={ungroupSelected}>Ungroup</button>
        <button type="button" disabled={(selectedLayers.length !== 1 || !selectedLayer) && !document.isolatedLayerId} onClick={toggleIsolation}>
          {document.isolatedLayerId ? 'Exit isolate' : 'Isolate'}
        </button>
        <label className="move-layer-field">
          <span>Move to</span>
          <select
            aria-label="Move selected layers to"
            value=""
            disabled={selectedRoots.length === 0}
            onChange={(event) => {
              const value = event.target.value;
              if (value) moveSelectedTo(value === '__root__' ? undefined : value);
            }}
          >
            <option value="" disabled>Choose…</option>
            <option value="__root__">Artboard root</option>
            {moveTargets.map((layer) => <option key={layer.id} value={layer.id}>{layer.name}</option>)}
          </select>
        </label>
      </div>
    </section>
  );
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
  onMove: (layer: LayerNode, direction: -1 | 1) => void;
}

function NamedObjectIcon({ name, construction }: { name: string; construction: boolean }) {
  if (construction) {
    return <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M7 1.5v11" stroke="currentColor" strokeWidth="1.4" strokeDasharray="2 2" strokeLinecap="round" /></svg>;
  }
  if (/triangle/i.test(name)) {
    return <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M7 2 12 12H2L7 2Z" stroke="currentColor" strokeWidth="1.3" /></svg>;
  }
  if (/ring/i.test(name)) {
    return <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.3" /></svg>;
  }
  return <StackIcon size={14} />;
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
  const { document, manager, layerId, depth, selectedLayerIds, focusedLayerId, renamingId, draftName,
    onDraftName, onSelect, onFocusLayer, onFrameLayer, onKeyDown, draggingLayerId, onDragStart, onDragEnd, onDropLayer,
    onStartRename, onCommitRename, onCancelRename, onMove } = props;
  const layer = document.getLayer(layerId);
  if (!layer) return null;
  const expandable = layer.kind !== 'object' && layer.childIds.length > 0;
  const selected = selectedLayerIds.has(layer.id);
  const constructionComposition = layer.kind === 'object' && layer.objectId
    ? objectConstructionComposition(document, layer.objectId)
    : undefined;
  const semanticLabel = constructionComposition === 'construction-only'
    ? 'construction-only object'
    : constructionComposition === 'mixed'
      ? 'object containing construction geometry'
      : layer.kind;
  const siblings = layer.parentId
    ? document.getLayer(layer.parentId)?.childIds ?? []
    : document.getArtboard(layer.artboardId)?.layerIds ?? [];
  const siblingIndex = siblings.indexOf(layer.id);

  return (
    <div className="layer-branch">
      <div
        className={`layer-row${selected ? ' is-selected' : ''}${!layer.visible ? ' is-hidden' : ''}${draggingLayerId === layer.id ? ' is-dragging' : ''}`}
        style={{ '--layer-depth': depth } as React.CSSProperties}
        role="treeitem"
        data-layer-id={layer.id}
        onDragOver={(event) => {
          if (!draggingLayerId || draggingLayerId === layer.id) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
        }}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          const sourceId = draggingLayerId ?? event.dataTransfer.getData('text/plain');
          if (!sourceId) return;
          const rect = event.currentTarget.getBoundingClientRect();
          const ratio = (event.clientY - rect.top) / Math.max(1, rect.height);
          const position = layer.kind !== 'object' && ratio >= 0.3 && ratio <= 0.7
            ? 'inside'
            : ratio < 0.5 ? 'before' : 'after';
          onDropLayer(sourceId, layer, position);
        }}
        tabIndex={focusedLayerId === layer.id ? 0 : -1}
        aria-level={depth + 1}
        aria-label={`${layer.name}, ${semanticLabel}`}
        aria-selected={selected}
        aria-expanded={layer.kind === 'object' ? undefined : layer.expanded}
        onFocus={(event) => {
          if (event.target === event.currentTarget) onFocusLayer(layer.id);
        }}
        onKeyDown={(event) => onKeyDown(layer, event)}
        onClick={(event) => {
          event.currentTarget.focus();
          if (event.detail >= 2) {
            onStartRename(layer);
            return;
          }
          onSelect(layer.id, event);
        }}
      >
        <button
          type="button"
          className="layer-disclosure"
          aria-label={layer.expanded ? 'Collapse layer' : 'Expand layer'}
          disabled={!expandable}
          onClick={(event) => {
            event.stopPropagation();
            if (expandable) manager.execute({
              type: 'UPDATE_LAYER',
              payload: { layerId: layer.id, updates: { expanded: !layer.expanded } },
            });
          }}
        >
          {expandable ? (layer.expanded ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />) : null}
        </button>
        <span
          className="layer-kind-icon layer-drag-handle"
          aria-hidden="true"
          title={`${constructionComposition === 'construction-only' ? 'Construction-only object · ' : ''}Drag to reorder or reparent · Double-click to zoom to layer`}
          draggable={renamingId !== layer.id}
          onClick={(event) => {
            event.stopPropagation();
            if (event.detail === 1) {
              onFocusLayer(layer.id);
              onSelect(layer.id, event);
            }
          }}
          onDoubleClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onFrameLayer(layer.id);
          }}
          onDragStart={(event) => {
            event.stopPropagation();
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', layer.id);
            onDragStart(layer.id);
          }}
          onDragEnd={onDragEnd}
        >
          {layer.kind === 'object'
            ? <NamedObjectIcon name={layer.name} construction={constructionComposition === 'construction-only'} />
            : layer.kind === 'group' ? <FileDirectoryIcon size={14} /> : <RowsIcon size={14} />}
        </span>
        {renamingId === layer.id ? (
          <input
            className="layer-name-input"
            autoFocus
            value={draftName}
            aria-label="Layer name"
            onChange={(event) => onDraftName(event.target.value)}
            onClick={(event) => event.stopPropagation()}
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
        ) : <span className="layer-name" title={layer.name}>{layer.name}</span>}
        
        {constructionComposition === 'construction-only' && <span className="layer-reference-meta">hidden in export</span>}
        {constructionComposition === 'mixed' && (
          <span
            className="layer-construction-badge"
            title="Contains construction geometry"
            aria-label="Contains construction geometry"
          >C</span>
        )}
        {selected && selectedLayerIds.size === 1 && (
          <span className="layer-order-actions">
            <button type="button" disabled={siblingIndex <= 0} title={siblingIndex <= 0 ? 'Layer is already first' : 'Move up'} aria-label="Move layer up" onClick={(event) => { event.stopPropagation(); onMove(layer, -1); }}><ChevronUpIcon size={12} /></button>
            <button type="button" disabled={siblingIndex < 0 || siblingIndex >= siblings.length - 1} title={siblingIndex >= siblings.length - 1 ? 'Layer is already last' : 'Move down'} aria-label="Move layer down" onClick={(event) => { event.stopPropagation(); onMove(layer, 1); }}><ChevronDownIcon size={12} /></button>
          </span>
        )}
        <button
          type="button"
          className="layer-state-button"
          title={layer.locked ? 'Unlock' : 'Lock'}
          aria-label={layer.locked ? 'Unlock layer' : 'Lock layer'}
          onClick={(event) => {
            event.stopPropagation();
            manager.execute({ type: 'UPDATE_LAYER', payload: { layerId: layer.id, updates: { locked: !layer.locked } } });
          }}
        >{layer.locked ? <LockIcon size={13} /> : <UnlockIcon size={13} />}</button>
        <button
          type="button"
          className="layer-state-button"
          title={layer.visible ? 'Hide' : 'Show'}
          aria-label={layer.visible ? 'Hide layer' : 'Show layer'}
          onClick={(event) => {
            event.stopPropagation();
            manager.execute({ type: 'UPDATE_LAYER', payload: { layerId: layer.id, updates: { visible: !layer.visible } } });
          }}
        >{layer.visible ? <EyeIcon size={14} /> : <EyeClosedIcon size={14} />}</button>
      </div>
      {layer.kind !== 'object' && layer.expanded && layer.childIds.length > 0 && (
        <div role="group">
          {layer.childIds.map((childId) => (
            <LayerRow {...props} key={childId} layerId={childId} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}
