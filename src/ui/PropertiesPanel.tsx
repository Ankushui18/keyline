import { useEffect, useRef, useState, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { constraintActions, constraintDisplayName, constraintsForSelection } from '../constraints/catalog';
import type { VectorDocument } from '../core/document';
import { INTERACTION_BOUNDS_POLICY, objectBounds } from '../core/object-geometry';
import {
  previewGeometryPropagation,
  type GeometryConflictResolution,
  type GeometryVariantImpact,
} from '../core/geometry-components';
import { evaluateSegment } from '../core/geometry';
import { FamilyQaDialog } from './FamilyQaDialog';
import { evaluateNumericExpression } from '../core/numeric-expression';
import type { OperationManager, SegmentRoleUpdate } from '../core/operations';
import { parametricSourceObjectId, validateParametricGroup } from '../core/parametric';
import { objectConstructionComposition, selectionIsConstructionOnly } from '../core/segment-semantics';
import type {
  Appearance,
  AppearanceRule,
  ConstructionExtent,
  Constraint,
  ConstraintType,
  DrawingStyle,
  EntityId,
  HandleMirrorMode,
  NetworkObject,
  ParametricGroup,
  ParametricTransform,
  Segment,
  SelectionState,
  ToolId,
  VectorNode,
} from '../core/types';

interface PropertiesPanelProps {
  document: VectorDocument;
  manager: OperationManager;
  selection: SelectionState;
  onDuplicateArtboard: () => void;
  onDeleteArtboard: () => void;
  activeTool: ToolId;
  constructionExtent: ConstructionExtent;
  bendMode: HandleMirrorMode;
  paintColor: string;
  drawingStyle: DrawingStyle;
  offsetDistance: number;
  filletRadius: number;
  eraserSettings: { weight: number; shape: 'round' | 'square' };
  primitiveSettings: { cornerRadius: number; polygonSides: number; starPoints: number; starInnerRatio: number };
  onPrimitiveSettingsChange: (updates: Partial<{ cornerRadius: number; polygonSides: number; starPoints: number; starInnerRatio: number }>) => void;
  onConstructionExtentChange: (extent: ConstructionExtent) => void;
  onSetSegmentRoles: (updates: SegmentRoleUpdate[]) => void;
  onBendModeChange: (mode: HandleMirrorMode) => void;
  onPaintColorChange: (color: string) => void;
  onDrawingStyleChange: (updates: Partial<DrawingStyle>) => void;
  onOffsetDistanceChange: (distance: number) => void;
  onFilletRadiusChange: (radius: number) => void;
  onEraserSettingsChange: (updates: Partial<{ weight: number; shape: 'round' | 'square' }>) => void;
  onCreateMirror: (axis: 'x' | 'y') => void;
  onCreateRadialRepeat: () => void;
  onRemoveParametricGroup: (groupId: EntityId) => void;
  onUpdateParametricTransform: (groupId: EntityId, transform: ParametricTransform) => void;
  onUpdateParametricSources: (groupId: EntityId, sourcePathIds: EntityId[]) => void;
  onBulkNodeAction: (action: 'horizontal' | 'vertical' | 'distribute' | 'symmetry') => void;
  onApplyConstraint: (type: ConstraintType) => void;
  onUpdateConstraint: (constraintId: EntityId, updates: Partial<Constraint>) => void;
  onBulkConstraintParameter: (constraintIds: EntityId[], parameter: string, value: number) => void;
  onRemoveConstraint: (constraintId: EntityId) => void;
  onSetNodeMode: (nodeIds: EntityId[], mode: 'corner' | 'smooth' | 'symmetric') => void;
  onPathCommand: (command: 'close' | 'reverse' | 'select-connected' | 'add-point' | 'delete-point' | 'join') => void;
  onUpdateObject: (objectId: EntityId, updates: Partial<NetworkObject>) => void;
  onUpdateAppearance: (appearanceId: EntityId, updates: Partial<Appearance>) => void;
  onBeginContinuousEdit: (label: string) => void;
  onCommitContinuousEdit: () => void;
  onRollbackContinuousEdit: () => void;
  onUpdateObjects: (objectIds: EntityId[], updates: Partial<NetworkObject['transform']>) => void;
  onUpdateObjectAppearances: (objectIds: EntityId[], updates: { opacity?: number; strokeWidth?: number; strokeVisible?: boolean; strokeAlignment?: 'center' | 'inside' | 'outside'; fillColor?: string }, continuous?: boolean) => void;
  onCreateAppearanceRule: (name: string, objectIds: EntityId[]) => void;
  onApplyAppearanceRule: (ruleId: EntityId, objectIds: EntityId[]) => void;
  onApplyAppearanceRuleImpact: (ruleId: EntityId, appearance: AppearanceRule['appearance'], detachObjectIds: EntityId[]) => void;
  onDetachAppearanceRule: (objectIds: EntityId[]) => void;
  onRenameAppearanceRule: (ruleId: EntityId, name: string) => void;
  onDeleteAppearanceRule: (ruleId: EntityId) => void;
  onCreateGeometryVariant: (sourceObjectId: EntityId) => void;
  onApplyGeometryPropagation: (
    componentId: EntityId,
    includedObjectIds: EntityId[],
    resolutions: Array<{ objectId: EntityId; resolution: GeometryConflictResolution }>,
  ) => void;
  onGeometryImpactObjectsChange: (objectIds: EntityId[]) => void;
  onSetGeometryOverrides: (
    variantObjectId: EntityId,
    nodeIds: EntityId[],
    segmentIds: EntityId[],
    overridden: boolean,
  ) => void;
  onDetachGeometryVariant: (variantObjectId: EntityId) => void;
  onApplyFamilyQaFixes: (componentId: EntityId, issueIds: string[]) => Promise<void>;
  geometryReviewComponentId?: EntityId;
  onGeometryReviewOpened: () => void;
  onRenameGeometryComponent: (componentId: EntityId, name: string) => void;
  onAlignObjects: (objectIds: EntityId[], alignment: 'left' | 'center-x' | 'right' | 'top' | 'center-y' | 'bottom') => void;
  onFlipObjects: (objectIds: EntityId[], axis: 'horizontal' | 'vertical') => void;
  onSetObjectLayerState: (objectIds: EntityId[], updates: { locked?: boolean; visible?: boolean }) => void;
  onEnterNetworkEdit: (objectId: EntityId) => void;
  onExitNetworkEdit: () => void;
}

export function PropertiesPanel({
  document,
  manager,
  selection,
  onDuplicateArtboard,
  onDeleteArtboard,
  activeTool,
  constructionExtent,
  bendMode,
  paintColor,
  drawingStyle,
  offsetDistance,
  filletRadius,
  eraserSettings,
  primitiveSettings,
  onPrimitiveSettingsChange,
  onConstructionExtentChange,
  onSetSegmentRoles,
  onBendModeChange,
  onPaintColorChange,
  onDrawingStyleChange,
  onOffsetDistanceChange,
  onFilletRadiusChange,
  onEraserSettingsChange,
  onCreateMirror,
  onCreateRadialRepeat,
  onRemoveParametricGroup,
  onUpdateParametricTransform,
  onUpdateParametricSources,
  onBulkNodeAction,
  onApplyConstraint,
  onUpdateConstraint,
  onBulkConstraintParameter,
  onRemoveConstraint,
  onSetNodeMode,
  onPathCommand,
  onUpdateObject,
  onUpdateAppearance,
  onBeginContinuousEdit,
  onCommitContinuousEdit,
  onRollbackContinuousEdit,
  onUpdateObjects,
  onUpdateObjectAppearances,
  onCreateAppearanceRule,
  onApplyAppearanceRule,
  onApplyAppearanceRuleImpact,
  onDetachAppearanceRule,
  onRenameAppearanceRule,
  onDeleteAppearanceRule,
  onCreateGeometryVariant,
  onApplyGeometryPropagation,
  onGeometryImpactObjectsChange,
  onSetGeometryOverrides,
  onDetachGeometryVariant,
  onApplyFamilyQaFixes,
  geometryReviewComponentId,
  onGeometryReviewOpened,
  onRenameGeometryComponent,
  onAlignObjects,
  onFlipObjects,
  onSetObjectLayerState,
  onEnterNetworkEdit,
  onExitNetworkEdit,
}: PropertiesPanelProps) {
  const selectedNodes = [...selection.nodeIds]
    .map((id) => document.getNode(id))
    .filter((node) => node !== undefined);
  const selectedSegments = [...selection.segmentIds]
    .map((id) => document.getSegment(id))
    .filter((segment) => segment !== undefined);
  const selectedObjects = [...selection.objectIds]
    .map((id) => document.getObject(id))
    .filter((object) => object !== undefined);
  const selectedPathIds = new Set(selectedSegments
    .map((segment) => document.findPathForSegment(segment.id)?.id)
    .filter((pathId): pathId is EntityId => Boolean(pathId)));
  const selectedGeometryPathIds = [...new Set(selectedSegments
    .filter((segment) => segment.role === 'geometry')
    .map((segment) => document.findPathForSegment(segment.id)?.id)
    .filter((pathId): pathId is EntityId => Boolean(pathId)))]
    .filter((pathId) => !document.getPath(pathId)?.segmentIds
      .some((segmentId) => document.getSegment(segmentId)?.role === 'construction'));
  const visibleParametricGroups = [...document.parametricGroups.values()].filter((group) => {
    const sourceObjectId = parametricSourceObjectId(document, group);
    const selectedAsSource = Boolean(sourceObjectId && selection.objectIds.has(sourceObjectId));
    const selectedSourcePath = group.sourcePathIds.some((pathId) => selectedPathIds.has(pathId));
    const selectedReference = group.transform.type === 'mirror'
      ? Boolean(group.transform.axisSegmentId && selection.segmentIds.has(group.transform.axisSegmentId))
      : Boolean(group.transform.centerNodeId && selection.nodeIds.has(group.transform.centerNodeId));
    return selectedAsSource || selectedSourcePath || selectedReference;
  });
  const constructionOnlySelection = selectionIsConstructionOnly(document, selection);
  const visibleConstraints = constraintsForSelection(document, selection);
  const suggestedConstraints = selection.nodeIds.size + selection.segmentIds.size > 0
    ? constraintActions(document, selection).filter((action) => action.enabled)
    : [];

  const selectionCount = selection.mode === 'object'
    ? selectedObjects.length
    : selectedNodes.length + selectedSegments.length;
  const showArtboardProperties = selection.mode === 'object' && selectedObjects.length === 0;

  return (
    <aside className="properties-panel">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">INSPECTOR</span>
          <h2 aria-label="Properties">Design</h2>
        </div>
        <span className={`inspector-context${selectionCount > 0 ? ' has-selection' : ''}`}>
          {selection.mode === 'object' && selectedObjects.length === 1
            ? selectedObjects[0].name
            : selection.mode === 'network' && selectedNodes.length > 0 && selectedSegments.length === 0
              ? `${selectedNodes.length} ${selectedNodes.length === 1 ? 'point' : 'points'} selected`
              : selectionCount > 0
                ? `${selectionCount} selected`
                : selection.mode === 'network'
                  ? 'Editing network'
                  : document.activeArtboard.name}
        </span>
      </div>

      {showArtboardProperties && activeTool !== 'pen' && activeTool !== 'pencil' && activeTool !== 'brush' && (
        <ArtboardFrameInspector
          key={document.activeArtboardId}
          document={document}
          manager={manager}
          onDuplicate={onDuplicateArtboard}
          onDelete={onDeleteArtboard}
        />
      )}

      {(activeTool === 'pen' || activeTool === 'pencil' || activeTool === 'brush') && (
        <DrawingStyleInspector
          tool={activeTool}
          style={drawingStyle}
          onChange={onDrawingStyleChange}
        />
      )}

      {selection.mode === 'object' && selectedObjects.length === 1 ? (
        <ObjectInspector
          document={document}
          object={selectedObjects[0]}
          locked={document.isObjectLocked(selectedObjects[0].id)}
          appearanceExpanded={activeTool !== 'pen' && activeTool !== 'pencil' && activeTool !== 'brush'}
          onEnterEdit={() => onEnterNetworkEdit(selectedObjects[0].id)}
          onUpdate={onUpdateObject}
          onUpdateAppearance={onUpdateAppearance}
          onBeginContinuousEdit={onBeginContinuousEdit}
          onCommitContinuousEdit={onCommitContinuousEdit}
          onRollbackContinuousEdit={onRollbackContinuousEdit}
          onFlip={(axis) => onFlipObjects([selectedObjects[0].id], axis)}
        />
      ) : selection.mode === 'object' && selectedObjects.length > 1 ? (
        <MultiObjectInspector
          document={document}
          objects={selectedObjects}
          onUpdateObjects={onUpdateObjects}
          onUpdateAppearances={onUpdateObjectAppearances}
          onBeginContinuousEdit={onBeginContinuousEdit}
          onCommitContinuousEdit={onCommitContinuousEdit}
          onRollbackContinuousEdit={onRollbackContinuousEdit}
          onAlign={onAlignObjects}
          onFlip={(axis) => onFlipObjects(selectedObjects.map((object) => object.id), axis)}
          onSetLayerState={onSetObjectLayerState}
        />
      ) : selection.mode === 'object' ? (
        activeTool === 'select' ? <EmptyInspector /> : null
      ) : selectedNodes.length === 0 && selectedSegments.length === 0 ? (
        <NetworkEditSummary
          object={selection.editingObjectId ? document.getObject(selection.editingObjectId) : undefined}
          onExit={onExitNetworkEdit}
        />
      ) : selectedNodes.length === 1 ? (
        <NodeInspector
          node={selectedNodes[0]}
          onSetMode={(mode) => onSetNodeMode([selectedNodes[0].id], mode)}
          onMove={(position) => manager.execute({
            type: 'SET_NODE_POSITIONS',
            payload: { positions: [{ nodeId: selectedNodes[0].id, position }] },
          })}
          onDelete={() => onPathCommand('delete-point')}
        />
      ) : selectedNodes.length > 1 && selectedSegments.length === 0 ? (
        <KeylineMultiNodeInspector
          nodes={selectedNodes}
          lockedRuleCount={visibleConstraints.length}
          verticalSuggested={selectedNodes.length === 2 && !visibleConstraints.some((constraint) => constraint.type === 'vertical')}
          onSetMode={(mode) => onSetNodeMode(selectedNodes.map((node) => node.id), mode)}
          onMoveAxis={(axis, value) => manager.execute({
            type: 'SET_NODE_POSITIONS',
            payload: { positions: selectedNodes.map((node) => ({
              nodeId: node.id,
              position: { ...node.position, [axis]: value },
            })) },
          })}
          onMakeVertical={() => onApplyConstraint('vertical')}
        />
      ) : selectedSegments.length === 1 ? (
        <SegmentInspector document={document} segmentId={selectedSegments[0].id} />
      ) : (
        <MultiInspector nodeCount={selectedNodes.length} segmentCount={selectedSegments.length} />
      )}

      {selection.mode === 'object' && selectedObjects.length > 0 && (
        <SharedAppearanceRuleInspector
          document={document}
          objects={selectedObjects}
          onCreate={(name) => onCreateAppearanceRule(name, selectedObjects.map((object) => object.id))}
          onApply={(ruleId) => onApplyAppearanceRule(ruleId, selectedObjects.map((object) => object.id))}
          onApplyImpact={onApplyAppearanceRuleImpact}
          onDetach={() => onDetachAppearanceRule(selectedObjects.map((object) => object.id))}
          onRename={onRenameAppearanceRule}
          onDelete={onDeleteAppearanceRule}
        />
      )}

      {selection.mode === 'object' && selectedObjects.length === 1 && (
        <GeometryFamilyInspector
          document={document}
          object={selectedObjects[0]}
          selectedObjectIds={selection.objectIds}
          onCreateVariant={() => onCreateGeometryVariant(selectedObjects[0].id)}
          onApplyPropagation={onApplyGeometryPropagation}
          onImpactObjectsChange={onGeometryImpactObjectsChange}
          onDetachVariant={() => onDetachGeometryVariant(selectedObjects[0].id)}
          onApplyQaFixes={onApplyFamilyQaFixes}
          geometryReviewRequested={geometryReviewComponentId === document.geometryComponentForObject(selectedObjects[0].id)?.id}
          onGeometryReviewOpened={onGeometryReviewOpened}
          onRename={onRenameGeometryComponent}
        />
      )}

      {selection.mode === 'network' && selection.editingObjectId && (
        <GeometryOverrideInspector
          document={document}
          objectId={selection.editingObjectId}
          selectedNodeIds={[...selection.nodeIds]}
          selectedSegmentIds={[...selection.segmentIds]}
          onSetOverrides={(overridden) => onSetGeometryOverrides(
            selection.editingObjectId!,
            [...selection.nodeIds],
            [...selection.segmentIds],
            overridden,
          )}
        />
      )}

      {selection.mode === 'network' && selectedSegments.length > 0 && (
        <SegmentSemanticInspector
          document={document}
          segmentIds={selectedSegments.map((segment) => segment.id)}
          defaultExtent={constructionExtent}
          onApply={onSetSegmentRoles}
        />
      )}

      {selection.mode === 'network' && (selectedSegments.length > 0 || selectedNodes.length === 2) && (
        <div className="panel-section bend-options">
          <span className="section-label">PATH</span>
          <div className="segmented-control path-command-grid" role="group" aria-label="Path commands">
            {selectedSegments.length > 0 && <button type="button" onClick={() => onPathCommand('add-point')}>Add point</button>}
            {selectedNodes.length === 2 && <button type="button" onClick={() => onPathCommand('join')}>Join</button>}
            {selectedSegments.length > 0 && <button type="button" onClick={() => onPathCommand('close')}>Close</button>}
            {selectedSegments.length > 0 && <button type="button" onClick={() => onPathCommand('reverse')}>Reverse</button>}
            {selectedSegments.length > 0 && <button type="button" onClick={() => onPathCommand('select-connected')}>Connected</button>}
          </div>
        </div>
      )}

      {selection.mode === 'network' && (
        <ConstraintInspector
          constraints={visibleConstraints}
          suggestions={suggestedConstraints}
          showingDocumentConstraints={selection.nodeIds.size + selection.segmentIds.size === 0}
          onApply={onApplyConstraint}
          onUpdate={onUpdateConstraint}
          onBulkParameter={onBulkConstraintParameter}
          onRemove={onRemoveConstraint}
        />
      )}

      {activeTool === 'construction-line' && (
        <ConstructionLineToolInspector
          extent={constructionExtent}
          onExtentChange={onConstructionExtentChange}
        />
      )}

      {(activeTool === 'rounded-rectangle' || activeTool === 'polygon' || activeTool === 'star') && (
        <details className="panel-section inspector-section primitive-options" open>
          <summary><span>Tool options</span></summary>
          <div className="inspector-section-body">
            {activeTool === 'rounded-rectangle' && <NumericField label="Radius" value={primitiveSettings.cornerRadius} min={0} onCommit={(cornerRadius) => onPrimitiveSettingsChange({ cornerRadius })} />}
            {activeTool === 'polygon' && <NumericField label="Sides" value={primitiveSettings.polygonSides} min={3} max={64} onCommit={(polygonSides) => onPrimitiveSettingsChange({ polygonSides: Math.round(polygonSides) })} />}
            {activeTool === 'star' && <div className="numeric-field-grid"><NumericField label="Points" value={primitiveSettings.starPoints} min={3} max={64} onCommit={(starPoints) => onPrimitiveSettingsChange({ starPoints: Math.round(starPoints) })} /><NumericField label="Inner %" value={primitiveSettings.starInnerRatio * 100} min={5} max={95} onCommit={(value) => onPrimitiveSettingsChange({ starInnerRatio: value / 100 })} /></div>}
          </div>
        </details>
      )}

      {activeTool === 'bend' && (constructionOnlySelection ? (
        <ConstructionActionUnavailable action="Bend" />
      ) : (
        <div className="panel-section bend-options">
          <span className="section-label">HANDLE MIRRORING</span>
          <div className="segmented-control" role="group" aria-label="Handle mirroring mode">
            <ModeButton active={bendMode === 'independent'} label="Free" title="Independent handles" onClick={() => onBendModeChange('independent')} />
            <ModeButton active={bendMode === 'angle'} label="Angle" title="Mirror angle only" onClick={() => onBendModeChange('angle')} />
            <ModeButton active={bendMode === 'mirror'} label="Mirror" title="Mirror angle and length" onClick={() => onBendModeChange('mirror')} />
          </div>
          <p>Drag a node to add handles, a segment to bend it, or an endpoint to refine the curve.</p>
        </div>
      ))}

      {activeTool === 'fillet' && (constructionOnlySelection ? (
        <ConstructionActionUnavailable action="Fillet" />
      ) : (
        <div className="panel-section region-summary">
          <span className="section-label">TRUE ARC FILLET</span>
          <label className="offset-distance-field">
            <span>Radius</span>
            <input
              type="number"
              min="0.1"
              step="1"
              value={filletRadius}
              onChange={(event) => {
                const value = Number(event.target.value);
                if (Number.isFinite(value) && value > 0) onFilletRadiusChange(value);
              }}
            />
            <span>px</span>
          </label>
          <p>Click a two-line corner. Unsupported corners and oversized radii are rejected before the graph changes.</p>
        </div>
      ))}

      {activeTool === 'width' && (constructionOnlySelection ? (
        <ConstructionActionUnavailable action="Variable Width" />
      ) : (
        <div className="panel-section region-summary">
          <span className="section-label">VARIABLE WIDTH</span>
          <p>Click a segment to add a width point without changing its current shape. Drag the center or a square endpoint to refine it; Alt-click a handle to remove that point.</p>
        </div>
      ))}

      {activeTool === 'paint' && (constructionOnlySelection ? (
        <ConstructionActionUnavailable action="Fill" />
      ) : (
        <div className="panel-section region-summary">
          <span className="section-label">LIVE REGION FILL</span>
          <label className="paint-color-field">
            <input
              type="color"
              value={paintColor}
              onChange={(event) => onPaintColorChange(event.target.value)}
              aria-label="Paint fill color"
            />
            <code>{paintColor.toUpperCase()}</code>
          </label>
          <p>Hover a face for striped feedback, then click to bind this fill to its stable region ID. Alt-click clears it.</p>
        </div>
      ))}

      {activeTool === 'shape-builder' && (
        <div className="panel-section region-summary">
          <span className="section-label">PLANAR REGIONS</span>
          <div><strong>{document.regions.length}</strong><span>detected faces</span></div>
          <p>Click to add a face. Hold Alt or Option and click to subtract.</p>
        </div>
      )}

      {activeTool === 'cut' && (
        <div className="panel-section region-summary cut-summary">
          <span className="section-label">CUT MODE</span>
          <p>Click a segment to split once, or drag a line through several segments.</p>
        </div>
      )}

      {activeTool === 'lasso' && (
        <div className="panel-section region-summary cut-summary">
          <span className="section-label">LASSO NODES</span>
          <p>Draw a freeform enclosure around nodes, then use the bulk actions below.</p>
        </div>
      )}

      {activeTool === 'eraser' && (
        <div className="panel-section region-summary cut-summary eraser-settings">
          <span className="section-label">ERASER</span>
          <label className="offset-distance-field">
            <span>Weight</span>
            <input
              type="number"
              aria-label="Eraser weight"
              min="1"
              max="256"
              step="1"
              value={eraserSettings.weight}
              onChange={(event) => {
                const weight = Number(event.target.value);
                if (Number.isFinite(weight) && weight >= 1 && weight <= 256) onEraserSettingsChange({ weight });
              }}
            />
            <span>px</span>
          </label>
          <div className="segmented-control" role="group" aria-label="Eraser shape">
            <ModeButton active={eraserSettings.shape === 'round'} label="Round" title="Round eraser tip" onClick={() => onEraserSettingsChange({ shape: 'round' })} />
            <ModeButton active={eraserSettings.shape === 'square'} label="Square" title="Square eraser tip" onClick={() => onEraserSettingsChange({ shape: 'square' })} />
          </div>
          <p>Click and drag across vector paths. Touched spans are removed while the vector stays in the same editable layer.</p>
        </div>
      )}

      {activeTool === 'offset' && (constructionOnlySelection ? (
        <ConstructionActionUnavailable action="Offset" />
      ) : (
        <div className="panel-section region-summary cut-summary">
          <span className="section-label">PATH OFFSET</span>
          <label className="offset-distance-field">
            <span>Distance</span>
            <input
              type="number"
              min="0.1"
              step="1"
              value={offsetDistance}
              onChange={(event) => {
                const value = Number(event.target.value);
                if (Number.isFinite(value) && value > 0) onOffsetDistanceChange(value);
              }}
            />
            <span>px</span>
          </label>
          <p>Click any segment to offset its entire path. Hold Alt or Option for the opposite side.</p>
        </div>
      ))}

      {selectedNodes.length > 1 && (
        <div className="panel-section parametric-actions">
          <span className="section-label">BULK NODE ACTIONS</span>
          <div className="parametric-button-grid">
            <button onClick={() => onBulkNodeAction('horizontal')}>Align H</button>
            <button onClick={() => onBulkNodeAction('vertical')}>Align V</button>
            <button onClick={() => onBulkNodeAction('distribute')}>Distribute</button>
            <button onClick={() => onBulkNodeAction('symmetry')}>Symmetry</button>
          </div>
          <p>Actions are committed atomically and rejected if hard constraints cannot be satisfied.</p>
        </div>
      )}

      {(selectedSegments.length > 0 || visibleParametricGroups.length > 0) && (
        <div className="panel-section parametric-actions">
          <div className="constraint-section-heading">
            <span className="section-label">LIVE PARAMETRIC</span>
            <b>{visibleParametricGroups.length}</b>
          </div>
          {selectedSegments.length > 0 && (
            <div className="parametric-button-grid">
              <button onClick={() => onCreateMirror('x')}>Mirror X</button>
              <button onClick={() => onCreateMirror('y')}>Mirror Y</button>
              <button onClick={onCreateRadialRepeat}>Repeat ×6</button>
            </div>
          )}
          {visibleParametricGroups.map((group) => (
            <ParametricGroupEditor
              key={group.id}
              document={document}
              group={group}
              selectedSourcePathIds={selectedGeometryPathIds}
              onUpdate={onUpdateParametricTransform}
              onUpdateSources={onUpdateParametricSources}
              onRemove={onRemoveParametricGroup}
            />
          ))}
          <p>Instances are rendered virtually and remain linked to their source paths.</p>
        </div>
      )}

      <details className="panel-section inspector-section panel-help">
        <summary><span>Canvas shortcuts</span></summary>
        <div className="inspector-section-body shortcut-list">
          <ShortcutRow keys={['Space', 'Drag']} text="Pan viewport" />
          <ShortcutRow keys={['Scroll']} text="Zoom at cursor" />
          <ShortcutRow keys={['Shift', 'Click']} text="Multi-select" />
          <ShortcutRow keys={['Ctrl/⌘', 'C']} text="Copy objects" />
          <ShortcutRow keys={['Ctrl/⌘', 'X']} text="Cut objects" />
          <ShortcutRow keys={['Ctrl/⌘', 'V']} text="Paste objects" />
        </div>
      </details>
    </aside>
  );
}

function ParametricGroupEditor({
  document,
  group,
  selectedSourcePathIds,
  onUpdate,
  onUpdateSources,
  onRemove,
}: {
  document: VectorDocument;
  group: ParametricGroup;
  selectedSourcePathIds: EntityId[];
  onUpdate: (groupId: EntityId, transform: ParametricTransform) => void;
  onUpdateSources: (groupId: EntityId, sourcePathIds: EntityId[]) => void;
  onRemove: (groupId: EntityId) => void;
}) {
  const validation = validateParametricGroup(document, group);
  return (
    <div className="parametric-group-editor">
      <div className="parametric-group-row">
        <strong>{group.transform.type === 'mirror' ? 'Mirror' : 'Radial repeat'}</strong>
        <code>{shortId(group.id)}</code>
        <button type="button" title="Remove live group" aria-label="Remove live group" onClick={() => onRemove(group.id)}>×</button>
      </div>
      <div className="parametric-source-row">
        <span>{group.sourcePathIds.length} source path{group.sourcePathIds.length === 1 ? '' : 's'}</span>
        {selectedSourcePathIds.length > 0 && (
          <button type="button" onClick={() => onUpdateSources(group.id, selectedSourcePathIds)}>
            Use selected paths
          </button>
        )}
      </div>
      {!validation.valid && <p className="parametric-reference-error" role="alert">{validation.message}</p>}
      {group.transform.type === 'mirror' ? (
        <MirrorGroupFields document={document} group={group} transform={group.transform} onUpdate={onUpdate} />
      ) : (
        <RadialGroupFields document={document} group={group} transform={group.transform} onUpdate={onUpdate} />
      )}
    </div>
  );
}

type MirrorTransform = Extract<ParametricTransform, { type: 'mirror' }>;
type RadialTransform = Extract<ParametricTransform, { type: 'radial' }>;

function MirrorGroupFields({
  document,
  group,
  transform,
  onUpdate,
}: {
  document: VectorDocument;
  group: ParametricGroup;
  transform: MirrorTransform;
  onUpdate: (groupId: EntityId, transform: ParametricTransform) => void;
}) {
  const references = [...document.segments.values()].filter((segment) =>
    segment.role === 'construction' && segment.type === 'line' &&
    validateParametricGroup(document, {
      ...group,
      transform: { ...transform, axisSegmentId: segment.id },
    }).valid);
  return (
    <>
      <label className="parametric-reference-field">
        <span>Axis reference</span>
        <select
          value={transform.axisSegmentId ?? ''}
          onChange={(event) => onUpdate(group.id, {
            ...transform,
            axisSegmentId: event.target.value || undefined,
          })}
        >
          <option value="">Manual axis</option>
          {references.map((segment) => (
            <option key={segment.id} value={segment.id}>{referenceLabel(document, segment.id, 'Line')}</option>
          ))}
        </select>
      </label>
      <div className="segmented-control" role="group" aria-label="Mirror fallback axis">
        <ModeButton
          active={!transform.axisSegmentId && transform.axis === 'x'}
          label="Horizontal"
          title="Horizontal fallback axis"
          onClick={() => onUpdate(group.id, { ...transform, axis: 'x', angle: 0, axisSegmentId: undefined })}
        />
        <ModeButton
          active={!transform.axisSegmentId && transform.axis === 'y'}
          label="Vertical"
          title="Vertical fallback axis"
          onClick={() => onUpdate(group.id, { ...transform, axis: 'y', angle: 90, axisSegmentId: undefined })}
        />
      </div>
      <div className="numeric-field-grid">
        <NumericField
          label="Axis angle"
          value={transform.angle ?? (transform.axis === 'x' ? 0 : 90)}
          onCommit={(angle) => onUpdate(group.id, { ...transform, angle })}
        />
        <NumericField
          label="Origin X"
          value={transform.origin.x}
          onCommit={(x) => onUpdate(group.id, { ...transform, origin: { ...transform.origin, x } })}
        />
        <NumericField
          label="Origin Y"
          value={transform.origin.y}
          onCommit={(y) => onUpdate(group.id, { ...transform, origin: { ...transform.origin, y } })}
        />
      </div>
      {transform.axisSegmentId && <p>The referenced construction line drives axis position and angle live.</p>}
    </>
  );
}

function RadialGroupFields({
  document,
  group,
  transform,
  onUpdate,
}: {
  document: VectorDocument;
  group: ParametricGroup;
  transform: RadialTransform;
  onUpdate: (groupId: EntityId, transform: ParametricTransform) => void;
}) {
  const references = [...document.nodes.values()].filter((node) =>
    document.connectedSegments(node.id).some((segment) => segment.role === 'construction') &&
    validateParametricGroup(document, {
      ...group,
      transform: { ...transform, centerNodeId: node.id },
    }).valid);
  return (
    <>
      <label className="parametric-reference-field">
        <span>Center reference</span>
        <select
          value={transform.centerNodeId ?? ''}
          onChange={(event) => onUpdate(group.id, {
            ...transform,
            centerNodeId: event.target.value || undefined,
          })}
        >
          <option value="">Manual center</option>
          {references.map((node) => (
            <option key={node.id} value={node.id}>{referenceLabel(document, node.id, 'Anchor')}</option>
          ))}
        </select>
      </label>
      <div className="numeric-field-grid">
        <NumericField
          label="Copies"
          value={transform.count}
          min={2}
          max={64}
          onCommit={(count) => onUpdate(group.id, { ...transform, count: Math.round(count) })}
        />
        <NumericField
          label="Sweep °"
          value={transform.sweepAngle}
          onCommit={(sweepAngle) => onUpdate(group.id, { ...transform, sweepAngle })}
        />
        <NumericField
          label="Start °"
          value={transform.startAngle ?? 0}
          onCommit={(startAngle) => onUpdate(group.id, { ...transform, startAngle })}
        />
        <NumericField
          label="Center X"
          value={transform.center.x}
          onCommit={(x) => onUpdate(group.id, { ...transform, center: { ...transform.center, x } })}
        />
        <NumericField
          label="Center Y"
          value={transform.center.y}
          onCommit={(y) => onUpdate(group.id, { ...transform, center: { ...transform.center, y } })}
        />
      </div>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={transform.clockwise ?? true}
          onChange={(event) => onUpdate(group.id, { ...transform, clockwise: event.target.checked })}
        />
        <span>Clockwise</span>
      </label>
      {transform.centerNodeId && <p>The referenced construction anchor drives the repeat center live.</p>}
    </>
  );
}

function referenceLabel(document: VectorDocument, entityId: EntityId, kind: string): string {
  const object = document.getObjectForSegment(entityId) ?? document.getObjectForNode(entityId);
  return `${object?.name ?? kind} · ${shortId(entityId)}`;
}

function ConstructionLineToolInspector({
  extent,
  onExtentChange,
}: {
  extent: ConstructionExtent;
  onExtentChange: (extent: ConstructionExtent) => void;
}) {
  return (
    <div className="panel-section construction-semantics construction-tool-defaults">
      <span className="section-label">CONSTRUCTION LINE</span>
      <div className="semantic-control-row">
        <span>Default extent</span>
        <div className="segmented-control semantic-segments" role="group" aria-label="Default construction line extent">
          <ModeButton active={extent === 'finite'} label="Finite" title="Draw between the two anchors" onClick={() => onExtentChange('finite')} />
          <ModeButton active={extent === 'infinite'} label="Infinite" title="Draw an infinite guide through the two anchors" onClick={() => onExtentChange('infinite')} />
        </div>
      </div>
      <p>Drag to place two anchors. Hold Shift to constrain the direction to 45° increments.</p>
      <p className="construction-explanation">Construction lines constrain and snap but are excluded from regions and default exports.</p>
    </div>
  );
}

function SegmentSemanticInspector({
  document,
  segmentIds,
  defaultExtent,
  onApply,
}: {
  document: VectorDocument;
  segmentIds: EntityId[];
  defaultExtent: ConstructionExtent;
  onApply: (updates: SegmentRoleUpdate[]) => void;
}) {
  const segments = segmentIds
    .map((segmentId) => document.getSegment(segmentId))
    .filter((segment): segment is Segment => Boolean(segment));
  const allArtwork = segments.every((segment) => segment.role === 'geometry');
  const allConstruction = segments.every((segment) => segment.role === 'construction');
  const constructionSegments = segments.filter((segment) => segment.role === 'construction');
  const allFinite = constructionSegments.length > 0 && constructionSegments.every(
    (segment) => segment.role === 'construction' && segment.constructionExtent === 'finite',
  );
  const allInfinite = constructionSegments.length > 0 && constructionSegments.every(
    (segment) => segment.role === 'construction' && segment.constructionExtent === 'infinite',
  );
  const locked = segments.some((segment) => {
    const object = document.getObjectForSegment(segment.id);
    return object ? document.isObjectLocked(object.id) : false;
  });
  const hasCurves = segments.some((segment) => segment.type !== 'line');
  const hasVariableWidth = segments.some((segment) => Boolean(segment.widthProfile?.length));
  const disabledReason = locked
    ? 'Unlock the selected object before changing line roles.'
    : hasCurves
      ? 'Construction is available only for straight line segments; Bézier and arc segments are unsupported.'
      : hasVariableWidth
        ? 'Remove Variable Width before converting a line to construction.'
        : undefined;
  const mixedRole = !allArtwork && !allConstruction;
  const mixedExtent = constructionSegments.length > 0 && !allFinite && !allInfinite;

  const applyRole = (role: 'geometry' | 'construction') => {
    if (role === 'construction' && disabledReason) return;
    onApply(segments.map((segment) => role === 'construction'
      ? {
          segmentId: segment.id,
          role,
          constructionExtent: segment.role === 'construction' ? segment.constructionExtent : defaultExtent,
        }
      : { segmentId: segment.id, role }));
  };
  const applyExtent = (constructionExtent: ConstructionExtent) => {
    onApply(constructionSegments.map((segment) => ({
      segmentId: segment.id,
      role: 'construction' as const,
      constructionExtent,
    })));
  };

  return (
    <div className="panel-section construction-semantics" data-segment-count={segments.length}>
      <div className="constraint-section-heading">
        <span className="section-label">LINE SEMANTICS</span>
        <b>{segments.length}</b>
      </div>
      <div className="semantic-control-row">
        <span>Role {mixedRole && <output aria-label="Mixed line roles">Mixed</output>}</span>
        <div className="segmented-control semantic-segments" role="group" aria-label="Selected line role">
          <button type="button" className={allArtwork ? 'is-active' : ''} aria-pressed={allArtwork} onClick={() => applyRole('geometry')}>Artwork</button>
          <button
            type="button"
            className={allConstruction ? 'is-active' : ''}
            aria-pressed={allConstruction}
            disabled={Boolean(disabledReason)}
            title={disabledReason ?? 'Use selected straight lines as construction geometry'}
            onClick={() => applyRole('construction')}
          >Construction</button>
        </div>
      </div>
      {disabledReason && <p className="semantic-disabled-reason" role="note">{disabledReason}</p>}
      {constructionSegments.length > 0 && (
        <div className="semantic-control-row">
          <span>Extent {mixedExtent && <output aria-label="Mixed construction extents">Mixed</output>}</span>
          <div className="segmented-control semantic-segments" role="group" aria-label="Selected construction line extent">
            <button type="button" className={allFinite ? 'is-active' : ''} aria-pressed={allFinite} onClick={() => applyExtent('finite')}>Finite</button>
            <button type="button" className={allInfinite ? 'is-active' : ''} aria-pressed={allInfinite} onClick={() => applyExtent('infinite')}>Infinite</button>
          </div>
        </div>
      )}
      <p className="construction-explanation">Construction lines constrain and snap but are excluded from regions and default exports.</p>
    </div>
  );
}

function ConstructionActionUnavailable({ action }: { action: string }) {
  return (
    <div className="panel-section construction-action-unavailable" role="status">
      <span className="section-label">{action.toUpperCase()}</span>
      <p>{action} is unavailable for construction-only selections. Convert the line role to Artwork first.</p>
    </div>
  );
}

function ConstraintInspector({
  constraints,
  suggestions,
  showingDocumentConstraints,
  onApply,
  onUpdate,
  onBulkParameter,
  onRemove,
}: {
  constraints: Constraint[];
  suggestions: Array<{ type: ConstraintType; label: string; symbol: string }>;
  showingDocumentConstraints: boolean;
  onApply: (type: ConstraintType) => void;
  onUpdate: (constraintId: EntityId, updates: Partial<Constraint>) => void;
  onBulkParameter: (constraintIds: EntityId[], parameter: string, value: number) => void;
  onRemove: (constraintId: EntityId) => void;
}) {
  const parameterGroups = (['fixed_radius', 'fixed_distance', 'fixed_angle'] as const)
    .map((type) => constraints.filter((constraint) => constraint.type === type))
    .filter((group) => group.length > 1);
  return (
    <details
      className="panel-section inspector-section constraint-inspector"
      open={(suggestions.length > 0 || constraints.length > 0) || undefined}
    >
      <summary>
        <span>{showingDocumentConstraints ? 'Document constraints' : 'Constraints'}</span>
        <output>{constraints.length}</output>
      </summary>
      <div className="inspector-section-body constraint-inspector-body">
      {suggestions.length > 0 && (
        <div className="constraint-suggestions">
          <span>Suggested for this selection</span>
          <div>
            {suggestions.slice(0, 6).map((action) => (
              <button key={action.type} onClick={() => onApply(action.type)} title={`Apply ${action.label}`}>
                <i>{action.symbol}</i>{action.label}
              </button>
            ))}
          </div>
        </div>
      )}
      {parameterGroups.map((group) => {
        const parameter = parameterForConstraint(group[0])!;
        const values = group.map((constraint) => parameterForConstraint(constraint)!.value);
        const commonValue = values.every((value) => Math.abs(value - values[0]) < 1e-9) ? values[0] : undefined;
        return (
          <label className="bulk-constraint-parameter" key={group[0].type}>
            <span><strong>{constraintDisplayName(group[0].type)}</strong><small>{group.length} constraints</small></span>
            <input
              key={`${group[0].type}:${values.join(':')}`}
              type="number"
              defaultValue={commonValue === undefined ? '' : Number(commonValue.toFixed(4))}
              placeholder="Mixed"
              min={group[0].type === 'fixed_angle' ? undefined : 0}
              step="1"
              aria-label={`Set all ${constraintDisplayName(group[0].type)} values`}
              onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
              onBlur={(event) => {
                if (event.target.value.trim() === '') return;
                const value = Number(event.target.value);
                if (Number.isFinite(value)) onBulkParameter(group.map((constraint) => constraint.id), parameter.key, value);
              }}
            />
          </label>
        );
      })}
      {constraints.length === 0 ? (
        <p className="no-constraints">
          {showingDocumentConstraints
            ? <>No constraints in this document. Select geometry to see compatible suggestions, or press <kbd>K</kbd>.</>
            : <>No constraints on this selection. Use a suggestion above or press <kbd>K</kbd> for the full palette.</>}
        </p>
      ) : constraints.map((constraint) => {
        const parameter = parameterForConstraint(constraint);
        return (
          <article key={constraint.id} data-constraint-id={constraint.id} className={`constraint-card priority-${constraint.priority}`}>
            <div className="constraint-card-heading">
              <span>{constraintSymbol(constraint.type)}</span>
              <div><strong>{constraintDisplayName(constraint.type)}</strong><code>{shortId(constraint.id)}</code></div>
              <button onClick={() => onRemove(constraint.id)} title="Delete constraint">×</button>
            </div>
            <div className="constraint-card-controls">
              <select
                value={constraint.priority}
                aria-label="Constraint priority"
                onChange={(event) => onUpdate(constraint.id, { priority: event.target.value as Constraint['priority'] })}
              >
                <option value="hard">Hard</option>
                <option value="medium">Medium</option>
                <option value="soft">Soft</option>
              </select>
              {parameter && (
                <label>
                  {parameter.label}
                  <input
                    key={`${constraint.id}:${parameter.value}`}
                    type="number"
                    defaultValue={Number(parameter.value.toFixed(4))}
                    step="1"
                    onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
                    onBlur={(event) => {
                      const value = Number(event.target.value);
                      if (Number.isFinite(value)) {
                        onUpdate(constraint.id, {
                          parameters: { ...(constraint.parameters ?? {}), [parameter.key]: value },
                        });
                      }
                    }}
                  />
                </label>
              )}
            </div>
          </article>
        );
      })}
      </div>
    </details>
  );
}

function DrawingStyleInspector({
  tool,
  style,
  onChange,
}: {
  tool: 'pen' | 'pencil' | 'brush';
  style: DrawingStyle;
  onChange: (updates: Partial<DrawingStyle>) => void;
}) {
  return (
    <details className="panel-section inspector-section drawing-style-inspector" open>
      <summary>
        <span>{tool === 'pen' ? 'Pen style' : tool === 'brush' ? 'Brush style' : 'Pencil style'}</span>
        <output>{style.strokeEnabled ? `${formatNumber(style.strokeWidth)} px` : 'No stroke'}</output>
      </summary>
      <div className="inspector-section-body drawing-style-body">
        {style.strokeEnabled ? (
          <>
            <label className="appearance-color-row drawing-color-row">
              <span>Stroke</span>
              <input
                type="color"
                aria-label="Drawing stroke color"
                value={style.strokeColor}
                onChange={(event) => onChange({ strokeColor: event.target.value })}
              />
              <code>{style.strokeColor.toUpperCase()}</code>
            </label>
            <NumericField
              label="Width"
              value={style.strokeWidth}
              min={0.1}
              max={512}
              live
              onCommit={(strokeWidth) => onChange({ strokeWidth })}
            />
            <details className="inline-disclosure stroke-details">
              <summary><span>Cap &amp; join</span><output>{style.strokeCap} · {style.strokeJoin}</output></summary>
              <div className="appearance-select-grid">
                <label><span>Cap</span><select aria-label="Drawing stroke cap" value={style.strokeCap} onChange={(event) => onChange({ strokeCap: event.target.value as DrawingStyle['strokeCap'] })}><option value="butt">Butt</option><option value="round">Round</option><option value="square">Square</option></select></label>
                <label><span>Join</span><select aria-label="Drawing stroke join" value={style.strokeJoin} onChange={(event) => onChange({ strokeJoin: event.target.value as DrawingStyle['strokeJoin'] })}><option value="miter">Miter</option><option value="round">Round</option><option value="bevel">Bevel</option></select></label>
              </div>
            </details>
            {tool === 'pen' && (
              <StrokeAlignmentControl value={style.strokeAlignment} onChange={(strokeAlignment) => onChange({ strokeAlignment })} />
            )}
            <button type="button" className="remove-paint-button" onClick={() => onChange({ strokeEnabled: false })}>Remove stroke</button>
          </>
        ) : (
          <button type="button" className="add-fill-button" onClick={() => onChange({ strokeEnabled: true })}>Add stroke</button>
        )}
        {tool === 'pen' && (
          <div className="drawing-fill-row">
            <label className="checkbox-row"><input type="checkbox" checked={style.fillEnabled} onChange={(event) => onChange({ fillEnabled: event.target.checked })} /><span>Fill closed paths</span></label>
            <input type="color" aria-label="Drawing fill color" value={style.fillColor} disabled={!style.fillEnabled} onChange={(event) => onChange({ fillColor: event.target.value })} />
          </div>
        )}
        <p>{tool === 'pen'
          ? 'Style changes update the whole path you are drawing.'
          : tool === 'brush'
            ? 'Pressure and endpoint taper create editable variable-width graph segments.'
            : 'Drag once to create a smooth, editable vector path.'}</p>
      </div>
    </details>
  );
}

function StrokeAlignmentControl({
  value,
  onChange,
  alignedOptionsEnabled = true,
}: {
  value?: 'center' | 'inside' | 'outside';
  onChange: (value: 'center' | 'inside' | 'outside') => void;
  alignedOptionsEnabled?: boolean;
}) {
  return (
    <div className="stroke-alignment-control">
      <span>Alignment</span>
      <div className="segmented-control" role="group" aria-label="Stroke alignment">
        {(['inside', 'center', 'outside'] as const).map((alignment) => (
          <button
            key={alignment}
            type="button"
            aria-pressed={value === alignment}
            disabled={alignment !== 'center' && !alignedOptionsEnabled}
            title={alignment !== 'center' && !alignedOptionsEnabled ? 'Inside and outside alignment require a closed path.' : undefined}
            onClick={() => onChange(alignment)}
          >{alignment[0].toUpperCase()}{alignment.slice(1)}</button>
        ))}
      </div>
    </div>
  );
}

const ARTBOARD_PRESETS = [16, 20, 24, 32, 48, 64, 1024] as const;

function ArtboardFrameInspector({
  document,
  manager,
  onDuplicate,
  onDelete,
}: {
  document: VectorDocument;
  manager: OperationManager;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const artboard = document.activeArtboard;
  const [widthDraft, setWidthDraft] = useState(String(artboard.frame.width));
  const [heightDraft, setHeightDraft] = useState(String(artboard.frame.height));
  const editingRef = useRef<'width' | 'height'>();
  const transactionOpenRef = useRef(false);
  const artboardIdRef = useRef(artboard.id);

  useEffect(() => () => {
    if (transactionOpenRef.current) manager.commitTransaction();
  }, [manager]);

  useEffect(() => {
    if (artboardIdRef.current !== artboard.id) {
      if (transactionOpenRef.current) manager.commitTransaction();
      transactionOpenRef.current = false;
      editingRef.current = undefined;
      artboardIdRef.current = artboard.id;
    }
    if (!editingRef.current) {
      setWidthDraft(String(artboard.frame.width));
      setHeightDraft(String(artboard.frame.height));
    }
  }, [artboard.frame.height, artboard.frame.width, artboard.id, manager]);

  const beginEdit = (field: 'width' | 'height') => {
    editingRef.current = field;
    if (!transactionOpenRef.current) {
      manager.beginTransaction('Resize artboard');
      transactionOpenRef.current = true;
    }
  };

  const applyDimension = (field: 'width' | 'height', text: string) => {
    if (field === 'width') setWidthDraft(text); else setHeightDraft(text);
    const value = Number(text);
    if (!Number.isFinite(value) || value <= 0) return;
    manager.execute({
      type: 'UPDATE_ARTBOARD_DIMENSIONS',
      payload: {
        artboardId: artboard.id,
        width: field === 'width' ? value : document.activeArtboard.frame.width,
        height: field === 'height' ? value : document.activeArtboard.frame.height,
      },
    });
  };

  const finishEdit = (event: ReactFocusEvent<HTMLInputElement>) => {
    if (transactionOpenRef.current) manager.commitTransaction();
    transactionOpenRef.current = false;
    editingRef.current = undefined;
    setWidthDraft(String(document.activeArtboard.frame.width));
    setHeightDraft(String(document.activeArtboard.frame.height));
    event.currentTarget.value = String(
      event.currentTarget.dataset.dimension === 'width'
        ? document.activeArtboard.frame.width
        : document.activeArtboard.frame.height,
    );
  };

  const handleDimensionKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') event.currentTarget.blur();
    if (event.key !== 'Escape') return;
    event.preventDefault();
    if (transactionOpenRef.current) manager.rollbackTransaction();
    transactionOpenRef.current = false;
    editingRef.current = undefined;
    setWidthDraft(String(document.activeArtboard.frame.width));
    setHeightDraft(String(document.activeArtboard.frame.height));
    event.currentTarget.blur();
  };

  const preset = artboard.frame.width === artboard.frame.height &&
    ARTBOARD_PRESETS.includes(artboard.frame.width as typeof ARTBOARD_PRESETS[number])
    ? String(artboard.frame.width)
    : 'custom';

  return (
    <details className="panel-section artboard-frame-section" open>
      <summary>
        <span><strong>Frame</strong><small>{artboard.name}</small></span>
        <output>{formatNumber(artboard.frame.width)} × {formatNumber(artboard.frame.height)}</output>
      </summary>
      <div className="frame-inspector-body">
        <div className="numeric-field-grid frame-dimension-grid">
          <label className="numeric-field">
            <span>W</span>
            <input
              data-dimension="width"
              aria-label="Artboard width"
              type="number"
              min="1"
              step="1"
              value={widthDraft}
              onFocus={() => beginEdit('width')}
              onChange={(event) => applyDimension('width', event.target.value)}
              onBlur={finishEdit}
              onKeyDown={handleDimensionKeyDown}
            />
          </label>
          <label className="numeric-field">
            <span>H</span>
            <input
              data-dimension="height"
              aria-label="Artboard height"
              type="number"
              min="1"
              step="1"
              value={heightDraft}
              onFocus={() => beginEdit('height')}
              onChange={(event) => applyDimension('height', event.target.value)}
              onBlur={finishEdit}
              onKeyDown={handleDimensionKeyDown}
            />
          </label>
        </div>
        <label className="frame-preset-field">
          <span>Preset</span>
          <select
            aria-label="Artboard size preset"
            value={preset}
            onChange={(event) => {
              if (event.target.value === 'custom') return;
              const size = Number(event.target.value);
              manager.execute({
                type: 'UPDATE_ARTBOARD_DIMENSIONS',
                payload: { artboardId: artboard.id, width: size, height: size },
              });
            }}
          >
            <option value="custom">Custom</option>
            {ARTBOARD_PRESETS.map((size) => <option key={size} value={size}>{size} × {size}</option>)}
          </select>
        </label>
        <div className="artboard-action-row">
          <button type="button" className="duplicate-artboard-button" onClick={onDuplicate}>Duplicate Artboard</button>
          <button
            type="button"
            className="delete-artboard-button"
            disabled={Boolean(artboard.isCanvasRoot)}
            title={artboard.isCanvasRoot ? 'The Canvas is the page-level container.' : 'Delete artboard and its contents'}
            onClick={onDelete}
          >Delete Artboard</button>
        </div>
      </div>
    </details>
  );
}

function ObjectInspector({
  document,
  object,
  locked,
  appearanceExpanded,
  onEnterEdit,
  onUpdate,
  onUpdateAppearance,
  onBeginContinuousEdit,
  onCommitContinuousEdit,
  onRollbackContinuousEdit,
  onFlip,
}: {
  document: VectorDocument;
  object: NetworkObject;
  locked: boolean;
  appearanceExpanded: boolean;
  onEnterEdit: () => void;
  onUpdate: (objectId: EntityId, updates: Partial<NetworkObject>) => void;
  onUpdateAppearance: (appearanceId: EntityId, updates: Partial<Appearance>) => void;
  onBeginContinuousEdit: (label: string) => void;
  onCommitContinuousEdit: () => void;
  onRollbackContinuousEdit: () => void;
  onFlip: (axis: 'horizontal' | 'vertical') => void;
}) {
  const bounds = objectBounds(document, object.id, INTERACTION_BOUNDS_POLICY);
  const appearance = document.getAppearance(object.appearanceId);
  const stroke = appearance?.stroke;
  const fill = appearance?.fills[0];
  const network = document.getNetwork(object.networkId);
  const supportsAlignedStroke = Boolean(network?.pathIds.some((pathId) => {
    const path = document.getPath(pathId);
    return path?.isClosed && !path.segmentIds.some((segmentId) => Boolean(document.getSegment(segmentId)?.widthProfile?.length));
  }));
  const constructionOnly = objectConstructionComposition(document, object.id) === 'construction-only';
  // X and Y read from the frame's top-left corner, like every other design tool, not from the infinite page.
  const frameOrigin = (() => {
    const layer = document.getLayerForObject(object.id);
    const frame = layer ? document.getArtboard(layer.artboardId)?.frame : undefined;
    return frame && !document.getArtboard(layer!.artboardId)?.isCanvasRoot ? { x: frame.x, y: frame.y } : { x: 0, y: 0 };
  })();
  const updateTransform = (updates: Partial<NetworkObject['transform']>) => onUpdate(object.id, {
    transform: { ...object.transform, ...updates },
  });
  return (
    <fieldset className="object-inspector-fieldset" disabled={locked} aria-label={locked ? 'Locked object properties' : 'Object properties'}>
      {locked && <div className="locked-object-notice">Locked in Layers · properties are read-only</div>}
      <div className="panel-section object-summary object-selection-summary">
        <span className="object-glyph network-glyph" />
        <div>
          <input
            className="object-name-field"
            aria-label="Object name"
            defaultValue={object.name}
            key={object.name}
            onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
            onBlur={(event) => {
              const name = event.target.value.trim();
              if (name && name !== object.name) onUpdate(object.id, { name });
            }}
          />
          <span>Vector object · Enter or double-click</span>
        </div>
        <button type="button" className="edit-network-button" onClick={onEnterEdit}>Edit path</button>
      </div>
      <details className="panel-section inspector-section object-transform-inspector" open>
        <summary><span>Position &amp; size</span></summary>
        <div className="inspector-section-body object-transform-body">
        <div className="numeric-field-grid">
          <NumericField label="X" value={bounds.minX - frameOrigin.x} onCommit={(value) => updateTransform({ x: object.transform.x + value + frameOrigin.x - bounds.minX })} />
          <NumericField label="Y" value={bounds.minY - frameOrigin.y} onCommit={(value) => updateTransform({ y: object.transform.y + value + frameOrigin.y - bounds.minY })} />
          <NumericField
            label="W"
            value={bounds.width}
            min={0.001}
            onCommit={(value) => {
              if (bounds.width > 1e-9) updateTransform({ scaleX: object.transform.scaleX * value / bounds.width });
            }}
          />
          <NumericField
            label="H"
            value={bounds.height}
            min={0.001}
            onCommit={(value) => {
              if (bounds.height > 1e-9) updateTransform({ scaleY: object.transform.scaleY * value / bounds.height });
            }}
          />
        </div>
        <div className="transform-flip-actions" role="group" aria-label="Flip selection">
          <button type="button" onClick={() => onFlip('horizontal')} title="Flip horizontal · Shift+H"><FlipHorizontalIcon />Flip horizontal<kbd>⇧H</kbd></button>
          <button type="button" onClick={() => onFlip('vertical')} title="Flip vertical · Shift+V"><FlipVerticalIcon />Flip vertical<kbd>⇧V</kbd></button>
        </div>
        <details className="transform-advanced">
          <summary>Rotation &amp; scale</summary>
          <div className="numeric-field-grid transform-secondary-grid">
            <NumericField label="R°" value={object.transform.rotation} onCommit={(value) => updateTransform({ rotation: value })} />
            <NumericField label="SX" value={object.transform.scaleX} onCommit={(value) => updateTransform({ scaleX: value })} />
            <NumericField label="SY" value={object.transform.scaleY} onCommit={(value) => updateTransform({ scaleY: value })} />
          </div>
        </details>
        </div>
      </details>
      {appearance && (
        <details className="panel-section inspector-section object-appearance-inspector" open={appearanceExpanded || undefined}>
          <summary><span>Appearance</span></summary>
          <div className="inspector-section-body appearance-body">
          {constructionOnly ? (
            <p className="semantic-disabled-reason" role="note">Fill is unavailable because this object contains only construction geometry.</p>
          ) : fill ? (
            <div className="appearance-fill-control">
              <label className="appearance-color-row">
                <span>Fill</span>
                <input
                  type="color"
                  value={fill.color}
                  aria-label="Fill color"
                  onChange={(event) => onUpdateAppearance(appearance.id, {
                    fills: [{ ...fill, color: event.target.value }, ...appearance.fills.slice(1)],
                  })}
                />
                <code>{fill.color.toUpperCase()}</code>
              </label>
              <span className="fill-actions">
                <span><input
                  type="checkbox"
                  aria-label="Show fill"
                  checked={fill.visible}
                  onChange={(event) => onUpdateAppearance(appearance.id, {
                    fills: [{ ...fill, visible: event.target.checked }, ...appearance.fills.slice(1)],
                  })}
                />On</span>
                <button type="button" onClick={() => onUpdateAppearance(appearance.id, {
                  fills: appearance.fills.slice(1),
                })}>Remove</button>
              </span>
            </div>
          ) : (
            <button
              type="button"
              className="add-fill-button"
              onClick={() => onUpdateAppearance(appearance.id, {
                fills: [{ type: 'solid', color: '#8b6cf6', opacity: 1, visible: true }],
              })}
            >Add fill</button>
          )}
          {stroke?.visible ? (
            <div className="appearance-stroke-control">
              <label className="appearance-color-row">
                <span>Stroke</span>
                <input
                  type="color"
                  value={stroke.color}
                  aria-label="Stroke color"
                  onChange={(event) => onUpdateAppearance(appearance.id, {
                    stroke: { ...stroke, color: event.target.value },
                  })}
                />
                <code>{stroke.color.toUpperCase()}</code>
              </label>
              <div className="numeric-field-grid">
                <NumericField
                  label="Width"
                  value={stroke.width}
                  min={0}
                  live
                  onEditStart={() => onBeginContinuousEdit('Change stroke weight')}
                  onCommit={(width) => onUpdateAppearance(appearance.id, { stroke: { ...stroke, width } })}
                  onEditEnd={onCommitContinuousEdit}
                  onEditCancel={onRollbackContinuousEdit}
                />
                <NumericField label="Opacity" value={appearance.opacity * 100} min={0} max={100} onCommit={(value) => onUpdateAppearance(appearance.id, { opacity: value / 100 })} />
              </div>
              <details className="inline-disclosure stroke-details">
                <summary><span>Cap &amp; join</span><output>{stroke.cap} · {stroke.join}</output></summary>
                <div className="appearance-select-grid">
                  <label><span>Cap</span><select value={stroke.cap} onChange={(event) => onUpdateAppearance(appearance.id, { stroke: { ...stroke, cap: event.target.value as typeof stroke.cap } })}><option value="butt">Butt</option><option value="round">Round</option><option value="square">Square</option></select></label>
                  <label><span>Join</span><select value={stroke.join} onChange={(event) => onUpdateAppearance(appearance.id, { stroke: { ...stroke, join: event.target.value as typeof stroke.join } })}><option value="miter">Miter</option><option value="round">Round</option><option value="bevel">Bevel</option></select></label>
                </div>
              </details>
              <StrokeAlignmentControl
                value={stroke.alignment}
                alignedOptionsEnabled={supportsAlignedStroke}
                onChange={(alignment) => onUpdateAppearance(appearance.id, { stroke: { ...stroke, alignment } })}
              />
              <button type="button" className="remove-paint-button" onClick={() => onUpdateAppearance(appearance.id, { stroke: { ...stroke, visible: false } })}>Remove stroke</button>
            </div>
          ) : (
            <button
              type="button"
              className="add-fill-button"
              onClick={() => onUpdateAppearance(appearance.id, {
                stroke: stroke
                  ? { ...stroke, visible: true }
                  : { color: '#c8ced9', width: 1.25, cap: 'round', join: 'round', alignment: 'center', opacity: 1, dash: [], visible: true },
              })}
            >Add stroke</button>
          )}
          {!stroke?.visible && (
            <NumericField label="Opacity" value={appearance.opacity * 100} min={0} max={100} onCommit={(value) => onUpdateAppearance(appearance.id, { opacity: value / 100 })} />
          )}
          </div>
        </details>
      )}
    </fieldset>
  );
}

function NetworkEditSummary({ object, onExit }: { object?: NetworkObject; onExit: () => void }) {
  return (
    <div className="panel-section network-edit-summary">
      <span className="section-label">NETWORK EDIT MODE</span>
      <h3>{object?.name ?? 'Vector network'}</h3>
      <p>Select nodes and segments directly. Press Escape or use Done to return to object selection.</p>
      <button type="button" onClick={onExit}>Done editing</button>
    </div>
  );
}

function GeometryFamilyInspector({
  document,
  object,
  selectedObjectIds,
  onCreateVariant,
  onApplyPropagation,
  onImpactObjectsChange,
  onDetachVariant,
  onApplyQaFixes,
  geometryReviewRequested,
  onGeometryReviewOpened,
  onRename,
}: {
  document: VectorDocument;
  object: NetworkObject;
  selectedObjectIds: ReadonlySet<EntityId>;
  onCreateVariant: () => void;
  onApplyPropagation: (
    componentId: EntityId,
    includedObjectIds: EntityId[],
    resolutions: Array<{ objectId: EntityId; resolution: GeometryConflictResolution }>,
  ) => void;
  onImpactObjectsChange: (objectIds: EntityId[]) => void;
  onDetachVariant: () => void;
  onApplyQaFixes: (componentId: EntityId, issueIds: string[]) => Promise<void>;
  geometryReviewRequested: boolean;
  onGeometryReviewOpened: () => void;
  onRename: (componentId: EntityId, name: string) => void;
}) {
  const component = document.geometryComponentForObject(object.id);
  const variantResult = document.geometryVariantForObject(object.id);
  const isSource = component?.sourceObjectId === object.id;
  const preview = component ? previewGeometryPropagation(document, component.id) : null;
  const variantImpact = variantResult
    ? preview?.variants.find((variant) => variant.objectId === object.id)
    : undefined;
  const [impactOpen, setImpactOpen] = useState(false);
  const [qaOpen, setQaOpen] = useState(false);
  const [name, setName] = useState(component?.name ?? '');
  useEffect(() => setName(component?.name ?? ''), [component?.id, component?.name]);
  useEffect(() => () => onImpactObjectsChange([]), [onImpactObjectsChange]);
  const openImpact = () => {
    if (!component) return;
    onImpactObjectsChange([component.sourceObjectId, ...component.variants.map((variant) => variant.objectId)]);
    setImpactOpen(true);
  };
  const closeImpact = () => {
    onImpactObjectsChange([]);
    setImpactOpen(false);
  };
  useEffect(() => {
    if (!geometryReviewRequested || !component) return;
    onImpactObjectsChange([component.sourceObjectId, ...component.variants.map((variant) => variant.objectId)]);
    setImpactOpen(true);
    onGeometryReviewOpened();
  }, [component?.id, geometryReviewRequested, onGeometryReviewOpened, onImpactObjectsChange]);
  const commitName = () => {
    if (!component || !isSource) return;
    const trimmed = name.trim();
    if (!trimmed) setName(component.name);
    else if (trimmed !== component.name) onRename(component.id, trimmed);
  };

  return (
    <>
      <details className="panel-section inspector-section geometry-family-inspector" open>
        <summary>
          <span>Geometry family</span>
          {component && <span className={`geometry-state-chip is-${isSource ? 'source' : variantImpact?.state ?? 'inherited'}`}>{isSource ? 'Source' : variantImpact?.state ?? 'Inherited'}</span>}
        </summary>
        <div className="inspector-section-body">
          {!component ? (
            <>
              <p>Create a linked variant with stable node, segment, and path relationships.</p>
              <button type="button" className="primary-panel-action" onClick={onCreateVariant}>Create linked variant</button>
            </>
          ) : isSource ? (
            <>
              <label className="field-stack">
                <span>Family name</span>
                <input
                  aria-label="Geometry family name"
                  value={name}
                  onChange={(event) => setName(event.currentTarget.value)}
                  onBlur={commitName}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') event.currentTarget.blur();
                    if (event.key === 'Escape') {
                      setName(component.name);
                      event.currentTarget.blur();
                    }
                  }}
                />
              </label>
              <div className="geometry-family-status">
                <span className="geometry-source-glyph" aria-hidden="true">◆</span>
                <span>{component.variants.length} linked {component.variants.length === 1 ? 'variant' : 'variants'}</span>
              </div>
              <p>This artwork is authoritative. Review scope and local exceptions before updating the family.</p>
              <button
                type="button"
                className="primary-panel-action"
                disabled={component.variants.length === 0}
                onClick={openImpact}
              >Review geometry impact</button>
              <button type="button" onClick={onCreateVariant}>Create another variant</button>
            </>
          ) : (
            <>
              <div className="geometry-family-status">
                <span className="geometry-variant-glyph" aria-hidden="true">◇</span>
                <span>Variant of <strong>{component.name}</strong></span>
              </div>
              <p>
                {variantImpact?.state === 'conflicting'
                  ? 'Topology changed locally. This variant will be retained but skipped during propagation.'
                  : `${variantImpact?.overriddenNodeCount ?? 0} node and ${variantImpact?.overriddenSegmentCount ?? 0} segment overrides stay local.`}
              </p>
              <button type="button" onClick={onDetachVariant}>Detach geometry link</button>
            </>
          )}
          {component && (
            <>
              <button type="button" className="family-qa-launch" onClick={() => setQaOpen(true)}>Run family QA</button>
              {component.lastQa && (
                <small className="family-qa-last-run">
                  Last fix pass: {component.lastQa.remainingIssueCount} {component.lastQa.remainingIssueCount === 1 ? 'issue' : 'issues'} remaining
                </small>
              )}
            </>
          )}
        </div>
      </details>
      {impactOpen && component && (
        <GeometryImpactDialog
          document={document}
          componentId={component.id}
          selectedObjectIds={selectedObjectIds}
          onCancel={closeImpact}
          onApply={(includedObjectIds, resolutions) => {
            onApplyPropagation(component.id, includedObjectIds, resolutions);
            closeImpact();
          }}
        />
      )}
      {qaOpen && component && (
        <FamilyQaDialog
          document={document}
          componentId={component.id}
          onCancel={() => setQaOpen(false)}
          onReviewTopology={() => {
            setQaOpen(false);
            openImpact();
          }}
          onApply={async (issueIds) => {
            await onApplyQaFixes(component.id, issueIds);
            setQaOpen(false);
          }}
        />
      )}
    </>
  );
}

function GeometryOverrideInspector({
  document,
  objectId,
  selectedNodeIds,
  selectedSegmentIds,
  onSetOverrides,
}: {
  document: VectorDocument;
  objectId: EntityId;
  selectedNodeIds: EntityId[];
  selectedSegmentIds: EntityId[];
  onSetOverrides: (overridden: boolean) => void;
}) {
  const result = document.geometryVariantForObject(objectId);
  if (!result) return null;
  const targetNodes = new Set(Object.values(result.variant.nodeMap));
  const targetSegments = new Set(Object.values(result.variant.segmentMap));
  const mappedNodeCount = selectedNodeIds.filter((id) => targetNodes.has(id)).length;
  const mappedSegmentCount = selectedSegmentIds.filter((id) => targetSegments.has(id)).length;
  const selectedCount = mappedNodeCount + mappedSegmentCount;
  const overriddenNodeTargets = new Set(result.variant.overriddenNodeIds.map((id) => result.variant.nodeMap[id]));
  const overriddenSegmentTargets = new Set(result.variant.overriddenSegmentIds.map((id) => result.variant.segmentMap[id]));
  const overriddenCount = selectedNodeIds.filter((id) => overriddenNodeTargets.has(id)).length +
    selectedSegmentIds.filter((id) => overriddenSegmentTargets.has(id)).length;

  return (
    <details className="panel-section inspector-section geometry-override-inspector" open>
      <summary><span>Geometry inheritance</span><span className="geometry-state-chip is-overridden">{result.component.name}</span></summary>
      <div className="inspector-section-body">
        <p>{selectedCount > 0
          ? `${selectedCount} mapped ${selectedCount === 1 ? 'item' : 'items'} selected · ${overriddenCount} overridden`
          : 'Select mapped nodes or segments to make an explicit local exception.'}</p>
        <div className="inline-button-row">
          <button type="button" disabled={selectedCount === 0 || overriddenCount === selectedCount} onClick={() => onSetOverrides(true)}>Keep local</button>
          <button type="button" disabled={overriddenCount === 0} onClick={() => onSetOverrides(false)}>Resume inherited</button>
        </div>
        <small>Local exceptions survive later family updates. Resumed geometry updates on the next accepted propagation.</small>
      </div>
    </details>
  );
}

function GeometryImpactDialog({
  document,
  componentId,
  selectedObjectIds,
  onCancel,
  onApply,
}: {
  document: VectorDocument;
  componentId: EntityId;
  selectedObjectIds: ReadonlySet<EntityId>;
  onCancel: () => void;
  onApply: (
    includedObjectIds: EntityId[],
    resolutions: Array<{ objectId: EntityId; resolution: GeometryConflictResolution }>,
  ) => void;
}) {
  const initial = previewGeometryPropagation(document, componentId);
  const [excludedIds, setExcludedIds] = useState<Set<EntityId>>(() => new Set());
  const [resolutions, setResolutions] = useState<Map<EntityId, GeometryConflictResolution>>(
    () => new Map(),
  );
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const includedIds = new Set(initial?.variants
    .filter((variant) => !excludedIds.has(variant.objectId))
    .map((variant) => variant.objectId));
  const preview = previewGeometryPropagation(document, componentId, includedIds);
  useEffect(() => closeButtonRef.current?.focus(), []);
  if (!preview) return null;
  const members = preview.variants;
  const selectedVariantCount = members.filter((variant) => selectedObjectIds.has(variant.objectId)).length;
  const sourceSelected = selectedObjectIds.has(preview.sourceObject.id) ? 1 : 0;
  const selectedCount = sourceSelected + selectedVariantCount;
  const familyCount = members.length + 1;
  const additionalCount = familyCount - selectedCount;
  const resolutionFor = (variantId: EntityId): GeometryConflictResolution =>
    resolutions.get(variantId) ?? 'skip';
  const retainedCount = members.filter((variant) =>
    variant.included && resolutionFor(variant.variantId) !== 'detach').length;
  const detachedCount = members.length - retainedCount;
  const resolvedConflictCount = members.filter((variant) =>
    variant.state === 'conflicting' &&
    variant.included &&
    resolutionFor(variant.variantId) !== 'skip' &&
    resolutionFor(variant.variantId) !== 'detach').length;
  const unresolvedConflictCount = members.filter((variant) =>
    variant.state === 'conflicting' &&
    variant.included &&
    resolutionFor(variant.variantId) === 'skip').length;
  const acceptedMembers = members.filter((variant) =>
    variant.included &&
    resolutionFor(variant.variantId) !== 'detach' &&
    variant.state !== 'conflicting');
  const changedNodeCount = acceptedMembers.reduce((sum, variant) => sum + variant.changedNodeCount, 0);
  const changedSegmentCount = acceptedMembers.reduce((sum, variant) => sum + variant.changedSegmentCount, 0);
  const changedPathCount = acceptedMembers.reduce((sum, variant) => sum + variant.changedPathCount, 0);
  const localOverrideCount = acceptedMembers.reduce(
    (sum, variant) => sum + variant.overriddenNodeCount + variant.overriddenSegmentCount,
    0,
  );
  const objectLocation = (objectId: EntityId) => {
    const layer = document.getLayerForObject(objectId);
    const artboard = layer ? document.getArtboard(layer.artboardId) : undefined;
    return artboard?.isCanvasRoot ? 'Canvas' : artboard?.name ?? 'Unknown frame';
  };
  const stateLabel = (impact: GeometryVariantImpact) => impact.state[0].toUpperCase() + impact.state.slice(1);

  return (
    <div className="shared-style-impact-backdrop" onPointerDown={(event) => {
      if (event.currentTarget === event.target) onCancel();
    }}>
      <section
        ref={dialogRef}
        className="shared-style-impact-dialog geometry-impact-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="geometry-impact-title"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
            return;
          }
          if (event.key !== 'Tab') return;
          const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
          ) ?? [])].filter((element) => element.offsetParent !== null);
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (!first || !last) return;
          if (event.shiftKey && window.document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && window.document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <header>
          <div>
            <span className="eyebrow">GEOMETRY IMPACT</span>
            <h2 id="geometry-impact-title">Review {preview.component.name}</h2>
            <p>{familyCount} linked · {selectedCount} selected · {additionalCount} additional</p>
          </div>
          <button ref={closeButtonRef} type="button" className="impact-close" aria-label="Close geometry impact" onClick={onCancel}>×</button>
        </header>
        <div className="impact-dialog-grid">
          <section className="impact-editor" aria-labelledby="geometry-summary-heading">
            <h3 id="geometry-summary-heading">Accepted propagation</h3>
            <div className="geometry-source-card">
              <span className="geometry-state-chip is-source">Source</span>
              <strong>{preview.sourceObject.name}</strong>
              <small>{preview.sourceLayerName} · {objectLocation(preview.sourceObject.id)}</small>
            </div>
            <div className="geometry-impact-totals" aria-live="polite">
              <div><strong>{changedNodeCount}</strong><span>nodes update</span></div>
              <div><strong>{changedSegmentCount}</strong><span>segments update</span></div>
              <div><strong>{changedPathCount}</strong><span>paths update</span></div>
              <div><strong>{localOverrideCount}</strong><span>local overrides</span></div>
            </div>
            <div className="impact-diff">
              <h3>Result</h3>
              <p>{retainedCount} {retainedCount === 1 ? 'variant remains' : 'variants remain'} linked.</p>
              {detachedCount > 0 && <p>{detachedCount} {detachedCount === 1 ? 'variant detaches' : 'variants detach'} and keeps its current geometry.</p>}
              {resolvedConflictCount > 0 && <p>{resolvedConflictCount} topology {resolvedConflictCount === 1 ? 'conflict has' : 'conflicts have'} an explicit resolution.</p>}
              {unresolvedConflictCount > 0 && <p>{unresolvedConflictCount} unresolved {unresolvedConflictCount === 1 ? 'conflict is' : 'conflicts are'} retained and skipped.</p>}
              <p>One Undo restores all geometry, topology, and family links.</p>
            </div>
          </section>
          <section className="impact-members" aria-labelledby="geometry-members-heading">
            <div className="impact-members-heading">
              <div><h3 id="geometry-members-heading">Affected variants</h3><p>Uncheck an editable variant to detach it before applying.</p></div>
              <span>{retainedCount}/{members.length}</span>
            </div>
            <div className="impact-member-list">
              {members.map((impact) => (
                <div className={`impact-member-row geometry-member-row is-${impact.state}`} key={impact.variantId}>
                  <input
                    type="checkbox"
                    aria-label={`Include ${impact.objectName}`}
                    checked={impact.included}
                    disabled={impact.locked}
                    onChange={(event) => {
                      const checked = event.currentTarget.checked;
                      setExcludedIds((current) => {
                        const next = new Set(current);
                        if (checked) next.delete(impact.objectId);
                        else next.add(impact.objectId);
                        return next;
                      });
                    }}
                  />
                  <span className="impact-member-glyph" aria-hidden="true">◇</span>
                  <span>
                    <strong>{impact.objectName}</strong>
                    <small>{objectLocation(impact.objectId)} · {selectedObjectIds.has(impact.objectId) ? 'Selected' : 'Additional dependent'}{impact.locked ? ' · Locked' : ''}{impact.hidden ? ' · Hidden' : ''}</small>
                    <small>{impact.changedNodeCount} nodes · {impact.changedSegmentCount} segments · {impact.overriddenNodeCount + impact.overriddenSegmentCount} geometry overrides · {impact.topologyOverrideCount} topology overrides</small>
                    <GeometryDiffThumbnail
                      document={document}
                      sourceObjectId={preview.sourceObject.id}
                      variantObjectId={impact.objectId}
                    />
                    {impact.conflicts[0] && <small className="geometry-conflict-copy">{impact.conflicts.join(' ')}</small>}
                    {impact.state === 'conflicting' && (
                      <label className="geometry-resolution-field">
                        <span>Resolution</span>
                        <select
                          aria-label={`Topology resolution for ${impact.objectName}`}
                          value={resolutionFor(impact.variantId)}
                          disabled={impact.locked || !impact.included}
                          onChange={(event) => {
                            const resolution = event.currentTarget.value as GeometryConflictResolution;
                            setResolutions((current) => new Map(current).set(impact.variantId, resolution));
                          }}
                        >
                          <option value="skip">Skip for now</option>
                          <option value="replace">Update variant to source</option>
                          <option value="keep-local">Keep local topology</option>
                          {impact.canMapCompatibleTopology && <option value="map">Map matching topology</option>}
                          <option value="detach">Detach variant</option>
                        </select>
                      </label>
                    )}
                  </span>
                  <span className={`geometry-state-chip is-${impact.state}`}>{stateLabel(impact)}</span>
                </div>
              ))}
            </div>
          </section>
        </div>
        <footer>
          <p>{retainedCount} linked · {detachedCount} detached</p>
          <div><button type="button" onClick={onCancel}>Cancel</button><button type="button" className="impact-apply" onClick={() => onApply(
            [...includedIds],
            members
              .filter((impact) => impact.state === 'conflicting')
              .map((impact) => ({
                objectId: impact.objectId,
                resolution: resolutionFor(impact.variantId),
              })),
          )}>Apply geometry update</button></div>
        </footer>
      </section>
    </div>
  );
}

function GeometryDiffThumbnail({
  document,
  sourceObjectId,
  variantObjectId,
}: {
  document: VectorDocument;
  sourceObjectId: EntityId;
  variantObjectId: EntityId;
}) {
  const sourceLines = objectGeometryPolylines(document, sourceObjectId);
  const variantLines = objectGeometryPolylines(document, variantObjectId);
  const points = [...sourceLines, ...variantLines].flat();
  if (points.length === 0) return null;
  const minX = Math.min(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxX = Math.max(...points.map((point) => point.x));
  const maxY = Math.max(...points.map((point) => point.y));
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  const padding = Math.max(width, height) * 0.12 + 2;
  const viewBox = `${minX - padding} ${minY - padding} ${width + padding * 2} ${height + padding * 2}`;
  const pathData = (line: Array<{ x: number; y: number }>) =>
    line.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x} ${point.y}`).join(' ');
  return (
    <svg
      className="geometry-diff-thumbnail"
      viewBox={viewBox}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="Geometry comparison: current variant in rose and proposed source in blue"
    >
      <title>Current variant in rose; proposed source in blue</title>
      {variantLines.map((line, index) => <path key={`current-${index}`} className="geometry-diff-current" d={pathData(line)} />)}
      {sourceLines.map((line, index) => <path key={`source-${index}`} className="geometry-diff-source" d={pathData(line)} />)}
    </svg>
  );
}

function objectGeometryPolylines(
  document: VectorDocument,
  objectId: EntityId,
): Array<Array<{ x: number; y: number }>> {
  const object = document.getObject(objectId);
  const network = object ? document.getNetwork(object.networkId) : undefined;
  if (!network) return [];
  return network.pathIds.flatMap((pathId) => {
    const path = document.getPath(pathId);
    if (!path) return [];
    const lines = path.segmentIds.flatMap((segmentId) => {
      const segment = document.getSegment(segmentId);
      if (!segment || segment.role === 'construction') return [];
      const steps = segment.type === 'line' ? 1 : 16;
      return [Array.from({ length: steps + 1 }, (_, index) =>
        evaluateSegment(document, segment, index / steps))];
    });
    return lines;
  });
}

function SharedAppearanceRuleInspector({
  document,
  objects,
  onCreate,
  onApply,
  onApplyImpact,
  onDetach,
  onRename,
  onDelete,
}: {
  document: VectorDocument;
  objects: NetworkObject[];
  onCreate: (name: string) => void;
  onApply: (ruleId: EntityId) => void;
  onApplyImpact: (ruleId: EntityId, appearance: AppearanceRule['appearance'], detachObjectIds: EntityId[]) => void;
  onDetach: () => void;
  onRename: (ruleId: EntityId, name: string) => void;
  onDelete: (ruleId: EntityId) => void;
}) {
  const rules = [...document.appearanceRules.values()].sort((a, b) => a.name.localeCompare(b.name));
  const linkedIds = [...new Set(objects.map((object) => object.appearanceRuleId).filter((id): id is EntityId => Boolean(id)))];
  const commonRuleId = linkedIds.length === 1 && objects.every((object) => object.appearanceRuleId === linkedIds[0])
    ? linkedIds[0]
    : undefined;
  const commonRule = commonRuleId ? document.getAppearanceRule(commonRuleId) : undefined;
  const [newName, setNewName] = useState('');
  const [selectedRuleId, setSelectedRuleId] = useState(commonRuleId ?? rules[0]?.id ?? '');
  const [ruleName, setRuleName] = useState(commonRule?.name ?? '');
  const [impactOpen, setImpactOpen] = useState(false);
  useEffect(() => {
    if (commonRule) {
      setSelectedRuleId(commonRule.id);
      setRuleName(commonRule.name);
    }
  }, [commonRule?.id, commonRule?.name]);
  useEffect(() => {
    if (!selectedRuleId && rules[0]) setSelectedRuleId(rules[0].id);
  }, [rules.length, selectedRuleId]);
  const usageCount = commonRule ? document.objectsForAppearanceRule(commonRule.id).length : 0;
  const hasAnyLink = objects.some((object) => Boolean(object.appearanceRuleId));
  const commitName = () => {
    if (!commonRule) return;
    const trimmed = ruleName.trim();
    if (!trimmed) setRuleName(commonRule.name);
    else if (trimmed !== commonRule.name) onRename(commonRule.id, trimmed);
  };

  return (
    <>
    <details className="panel-section inspector-section shared-style-inspector" open>
      <summary><span>Shared style</span>{commonRule && <span className="section-count">{usageCount}</span>}</summary>
      <div className="inspector-section-body">
        {commonRule ? (
          <>
            <label className="field-stack">
              <span>Name</span>
              <input
                aria-label="Shared style name"
                value={ruleName}
                onChange={(event) => setRuleName(event.currentTarget.value)}
                onBlur={commitName}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                  if (event.key === 'Escape') {
                    setRuleName(commonRule.name);
                    event.currentTarget.blur();
                  }
                }}
              />
            </label>
            <div className="shared-style-status">
              <span className="shared-style-dot" aria-hidden="true" />
              <span>Linked to {usageCount} {usageCount === 1 ? 'object' : 'objects'}</span>
            </div>
            <p>Appearance edits update every object using this style. Geometry stays independent.</p>
            <button type="button" className="primary-panel-action" onClick={() => setImpactOpen(true)}>Review change impact</button>
            <div className="inline-button-row">
              <button type="button" onClick={onDetach}>Detach selected</button>
              <button type="button" className="danger-button" onClick={() => onDelete(commonRule.id)}>Delete style</button>
            </div>
          </>
        ) : (
          <>
            <p>{hasAnyLink ? 'The selection uses mixed shared styles.' : 'Link this selection to one reusable appearance rule.'}</p>
            {rules.length > 0 && (
              <div className="shared-style-apply-row">
                <label className="field-stack">
                  <span>Existing style</span>
                  <select aria-label="Existing shared style" value={selectedRuleId} onChange={(event) => setSelectedRuleId(event.currentTarget.value)}>
                    {rules.map((rule) => <option key={rule.id} value={rule.id}>{rule.name}</option>)}
                  </select>
                </label>
                <button type="button" disabled={!selectedRuleId} onClick={() => onApply(selectedRuleId)}>Apply</button>
              </div>
            )}
            <label className="field-stack">
              <span>New style</span>
              <input
                aria-label="New shared style name"
                value={newName}
                placeholder="e.g. Outline / 24"
                onChange={(event) => setNewName(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' || !newName.trim()) return;
                  onCreate(newName);
                  setNewName('');
                }}
              />
            </label>
            <button
              type="button"
              className="primary-panel-action"
              disabled={!newName.trim()}
              onClick={() => {
                onCreate(newName);
                setNewName('');
              }}
            >Create from selection</button>
            {hasAnyLink && <button type="button" onClick={onDetach}>Detach selected</button>}
          </>
        )}
      </div>
    </details>
    {impactOpen && commonRule && (
      <SharedAppearanceImpactDialog
        document={document}
        rule={commonRule}
        selectedObjectIds={new Set(objects.map((object) => object.id))}
        onCancel={() => setImpactOpen(false)}
        onApply={(appearance, detachObjectIds) => {
          onApplyImpact(commonRule.id, appearance, detachObjectIds);
          setImpactOpen(false);
        }}
      />
    )}
    </>
  );
}

function SharedAppearanceImpactDialog({
  document,
  rule,
  selectedObjectIds,
  onCancel,
  onApply,
}: {
  document: VectorDocument;
  rule: AppearanceRule;
  selectedObjectIds: Set<EntityId>;
  onCancel: () => void;
  onApply: (appearance: AppearanceRule['appearance'], detachObjectIds: EntityId[]) => void;
}) {
  const cloneAppearance = (appearance: AppearanceRule['appearance']): AppearanceRule['appearance'] => ({
    fills: appearance.fills.map((fill) => ({ ...fill })),
    stroke: appearance.stroke ? { ...appearance.stroke, dash: [...appearance.stroke.dash] } : undefined,
    opacity: appearance.opacity,
  });
  const [draft, setDraft] = useState(() => cloneAppearance(rule.appearance));
  const [excludedIds, setExcludedIds] = useState<Set<EntityId>>(() => new Set());
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const members = document.objectsForAppearanceRule(rule.id);
  const selectedCount = members.filter((object) => selectedObjectIds.has(object.id)).length;
  const additionalCount = members.length - selectedCount;
  const includedCount = members.length - excludedIds.size;
  const stroke = draft.stroke;
  const firstFill = draft.fills[0];
  const originalStroke = rule.appearance.stroke;
  const originalFill = rule.appearance.fills[0];
  const changes: Array<{ label: string; before: string; after: string }> = [];
  if (stroke && originalStroke && Math.abs(stroke.width - originalStroke.width) > 1e-9) {
    changes.push({ label: 'Stroke width', before: `${originalStroke.width}px`, after: `${stroke.width}px` });
  }
  if (stroke && originalStroke && stroke.color !== originalStroke.color) {
    changes.push({ label: 'Stroke color', before: originalStroke.color.toUpperCase(), after: stroke.color.toUpperCase() });
  }
  if (stroke && originalStroke && stroke.cap !== originalStroke.cap) {
    changes.push({ label: 'Cap', before: originalStroke.cap, after: stroke.cap });
  }
  if (stroke && originalStroke && stroke.join !== originalStroke.join) {
    changes.push({ label: 'Join', before: originalStroke.join, after: stroke.join });
  }
  if (stroke && originalStroke && stroke.alignment !== originalStroke.alignment) {
    changes.push({ label: 'Alignment', before: originalStroke.alignment, after: stroke.alignment });
  }
  if (firstFill && originalFill && firstFill.color !== originalFill.color) {
    changes.push({ label: 'Fill', before: originalFill.color.toUpperCase(), after: firstFill.color.toUpperCase() });
  }
  if (Math.abs(draft.opacity - rule.appearance.opacity) > 1e-9) {
    changes.push({ label: 'Opacity', before: `${Math.round(rule.appearance.opacity * 100)}%`, after: `${Math.round(draft.opacity * 100)}%` });
  }
  const hasScopeChange = excludedIds.size > 0;
  const canApply = includedCount > 0 && (changes.length > 0 || hasScopeChange);
  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);
  const updateStroke = (updates: Partial<NonNullable<AppearanceRule['appearance']['stroke']>>) => {
    if (!stroke) return;
    setDraft((current) => ({
      ...current,
      stroke: { ...stroke, ...updates, dash: updates.dash ? [...updates.dash] : [...stroke.dash] },
    }));
  };
  const objectLocation = (object: NetworkObject) => {
    const layer = document.getLayerForObject(object.id);
    const artboard = layer ? document.getArtboard(layer.artboardId) : undefined;
    return artboard?.isCanvasRoot ? 'Canvas' : artboard?.name ?? 'Unknown frame';
  };

  return (
    <div className="shared-style-impact-backdrop" onPointerDown={(event) => {
      if (event.currentTarget === event.target) onCancel();
    }}>
      <section
        ref={dialogRef}
        className="shared-style-impact-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shared-style-impact-title"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
            return;
          }
          if (event.key !== 'Tab') return;
          const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
          ) ?? [])].filter((element) => element.offsetParent !== null);
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (!first || !last) return;
          if (event.shiftKey && window.document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && window.document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <header>
          <div>
            <span className="eyebrow">CHANGE IMPACT</span>
            <h2 id="shared-style-impact-title">Review {rule.name}</h2>
            <p>{members.length} linked · {selectedCount} selected · {additionalCount} additional</p>
          </div>
          <button ref={closeButtonRef} type="button" className="impact-close" aria-label="Close change impact" onClick={onCancel}>×</button>
        </header>

        <div className="impact-dialog-grid">
          <section className="impact-editor" aria-labelledby="impact-change-heading">
            <h3 id="impact-change-heading">Proposed appearance</h3>
            {stroke && (
              <>
                <label className="impact-number-field">
                  <span>Stroke width</span>
                  <span><input aria-label="Impact stroke width" type="number" min="0" step="0.25" value={stroke.width} onChange={(event) => {
                    const width = Number(event.currentTarget.value);
                    if (Number.isFinite(width) && width >= 0) updateStroke({ width });
                  }} /><em>px</em></span>
                </label>
                <div className="impact-color-grid">
                  <label><span>Stroke</span><input aria-label="Impact stroke color" type="color" value={stroke.color} onChange={(event) => updateStroke({ color: event.currentTarget.value })} /><code>{stroke.color.toUpperCase()}</code></label>
                  {firstFill && <label><span>Fill</span><input aria-label="Impact fill color" type="color" value={firstFill.color} onChange={(event) => {
                    const color = event.currentTarget.value;
                    setDraft((current) => ({ ...current, fills: [{ ...firstFill, color }, ...current.fills.slice(1)] }));
                  }} /><code>{firstFill.color.toUpperCase()}</code></label>}
                </div>
                <div className="impact-select-grid">
                  <label><span>Cap</span><select aria-label="Impact stroke cap" value={stroke.cap} onChange={(event) => updateStroke({ cap: event.currentTarget.value as typeof stroke.cap })}><option value="butt">Butt</option><option value="round">Round</option><option value="square">Square</option></select></label>
                  <label><span>Join</span><select aria-label="Impact stroke join" value={stroke.join} onChange={(event) => updateStroke({ join: event.currentTarget.value as typeof stroke.join })}><option value="miter">Miter</option><option value="round">Round</option><option value="bevel">Bevel</option></select></label>
                </div>
                <fieldset className="impact-alignment">
                  <legend>Alignment</legend>
                  {(['inside', 'center', 'outside'] as const).map((alignment) => <label key={alignment}><input type="radio" name="impact-alignment" value={alignment} checked={stroke.alignment === alignment} onChange={() => updateStroke({ alignment })} />{alignment}</label>)}
                </fieldset>
              </>
            )}
            {!stroke && firstFill && (
              <div className="impact-color-grid impact-fill-only">
                <label><span>Fill</span><input aria-label="Impact fill color" type="color" value={firstFill.color} onChange={(event) => {
                  const color = event.currentTarget.value;
                  setDraft((current) => ({ ...current, fills: [{ ...firstFill, color }, ...current.fills.slice(1)] }));
                }} /><code>{firstFill.color.toUpperCase()}</code></label>
              </div>
            )}
            <label className="impact-number-field">
              <span>Opacity</span>
              <span><input aria-label="Impact opacity" type="number" min="0" max="100" step="1" value={Math.round(draft.opacity * 100)} onChange={(event) => {
                const opacity = Number(event.currentTarget.value);
                if (Number.isFinite(opacity) && opacity >= 0 && opacity <= 100) setDraft((current) => ({ ...current, opacity: opacity / 100 }));
              }} /><em>%</em></span>
            </label>

            <div className="impact-diff" aria-live="polite">
              <h3>Difference</h3>
              {changes.length > 0 ? changes.map((change) => (
                <div key={change.label}><span>{change.label}</span><code>{change.before}</code><b aria-hidden="true">→</b><code>{change.after}</code></div>
              )) : <p>No appearance values changed yet.</p>}
              {excludedIds.size > 0 && <p>{excludedIds.size} {excludedIds.size === 1 ? 'object will detach' : 'objects will detach'} and keep the current appearance.</p>}
            </div>
          </section>

          <section className="impact-members" aria-labelledby="impact-members-heading">
            <div className="impact-members-heading">
              <div><h3 id="impact-members-heading">Affected objects</h3><p>Uncheck an editable object to detach it before applying.</p></div>
              <span>{includedCount}/{members.length}</span>
            </div>
            <div className="impact-member-list">
              {members.map((object) => {
                const locked = document.isObjectLocked(object.id);
                const visible = document.isObjectVisible(object.id);
                const included = !excludedIds.has(object.id);
                const selected = selectedObjectIds.has(object.id);
                return (
                  <label className="impact-member-row" key={object.id}>
                    <input
                      type="checkbox"
                      checked={included}
                      disabled={locked}
                      onChange={(event) => {
                        const checked = event.currentTarget.checked;
                        setExcludedIds((current) => {
                          const next = new Set(current);
                          if (checked) next.delete(object.id);
                          else next.add(object.id);
                          return next;
                        });
                      }}
                    />
                    <span className="impact-member-glyph" aria-hidden="true">◇</span>
                    <span><strong>{object.name}</strong><small>{objectLocation(object)} · {selected ? 'Selected' : 'Additional dependent'}{locked ? ' · Locked' : ''}{!visible ? ' · Hidden' : ''}</small></span>
                  </label>
                );
              })}
            </div>
          </section>
        </div>

        <footer>
          <p>{includedCount} {includedCount === 1 ? 'object remains' : 'objects remain'} linked after this change.</p>
          <div><button type="button" onClick={onCancel}>Cancel</button><button type="button" className="impact-apply" disabled={!canApply} onClick={() => onApply(cloneAppearance(draft), [...excludedIds])}>Apply change</button></div>
        </footer>
      </section>
    </div>
  );
}

function MultiObjectInspector({
  document,
  objects,
  onUpdateObjects,
  onUpdateAppearances,
  onBeginContinuousEdit,
  onCommitContinuousEdit,
  onRollbackContinuousEdit,
  onAlign,
  onFlip,
  onSetLayerState,
}: {
  document: VectorDocument;
  objects: NetworkObject[];
  onUpdateObjects: (objectIds: EntityId[], updates: Partial<NetworkObject['transform']>) => void;
  onUpdateAppearances: (objectIds: EntityId[], updates: { opacity?: number; strokeWidth?: number; strokeVisible?: boolean; strokeAlignment?: 'center' | 'inside' | 'outside'; fillColor?: string }, continuous?: boolean) => void;
  onBeginContinuousEdit: (label: string) => void;
  onCommitContinuousEdit: () => void;
  onRollbackContinuousEdit: () => void;
  onAlign: (objectIds: EntityId[], alignment: 'left' | 'center-x' | 'right' | 'top' | 'center-y' | 'bottom') => void;
  onFlip: (axis: 'horizontal' | 'vertical') => void;
  onSetLayerState: (objectIds: EntityId[], updates: { locked?: boolean; visible?: boolean }) => void;
}) {
  const ids = objects.map((object) => object.id);
  const unlocked = objects.filter((object) => !document.isObjectLocked(object.id));
  const appearances = objects.map((object) => document.getAppearance(object.appearanceId)).filter((item): item is Appearance => Boolean(item));
  const common = (values: number[]) => values.length > 0 && values.every((value) => Math.abs(value - values[0]) < 1e-9) ? values[0] : undefined;
  const x = common(objects.map((object) => object.transform.x));
  const y = common(objects.map((object) => object.transform.y));
  const rotation = common(objects.map((object) => object.transform.rotation));
  const opacity = common(appearances.map((appearance) => appearance.opacity * 100));
  const strokeWidth = common(appearances.map((appearance) => appearance.stroke?.width ?? 0));
  const strokeVisibility = appearances.map((appearance) => Boolean(appearance.stroke?.visible));
  const allStrokesVisible = strokeVisibility.length === appearances.length && strokeVisibility.every(Boolean);
  const allStrokesHidden = strokeVisibility.length === appearances.length && strokeVisibility.every((visible) => !visible);
  const strokeAlignments = appearances.map((appearance) => appearance.stroke?.alignment ?? 'center');
  const strokeAlignment = strokeAlignments.length > 0 && strokeAlignments.every((alignment) => alignment === strokeAlignments[0])
    ? strokeAlignments[0]
    : undefined;
  const supportsAlignedStroke = objects.every((object) => {
    const network = document.getNetwork(object.networkId);
    return Boolean(network?.pathIds.some((pathId) => {
      const path = document.getPath(pathId);
      return path?.isClosed && path.segmentIds.every((segmentId) => !document.getSegment(segmentId)?.widthProfile?.length);
    }));
  });
  const fillColors = appearances.map((appearance) => appearance.fills[0]?.color).filter((value): value is string => Boolean(value));
  const fillColor = fillColors.length === appearances.length && fillColors.every((value) => value === fillColors[0])
    ? fillColors[0]
    : undefined;
  const allLocked = objects.every((object) => document.isObjectLocked(object.id));
  const anyLocked = objects.some((object) => document.isObjectLocked(object.id));
  const allVisible = objects.every((object) => document.isObjectVisible(object.id));
  const constructionOnly = objects.length > 0 && objects.every(
    (object) => objectConstructionComposition(document, object.id) === 'construction-only',
  );

  return (
    <fieldset className="multi-object-inspector">
      <legend className="sr-only">Multiple object properties</legend>
      <div className="panel-section multi-summary">
        <div className="multi-icon">{objects.length}</div>
        <h3>Multiple objects</h3>
        <p>{unlocked.length} editable · {objects.length - unlocked.length} locked</p>
      </div>
      <div className="panel-section object-transform-inspector">
        <span className="section-label">COMMON TRANSFORM</span>
        <div className="numeric-field-grid">
          <MixedNumericField label="X" value={x} onCommit={(value) => onUpdateObjects(ids, { x: value })} />
          <MixedNumericField label="Y" value={y} onCommit={(value) => onUpdateObjects(ids, { y: value })} />
          <MixedNumericField label="R°" value={rotation} onCommit={(value) => onUpdateObjects(ids, { rotation: value })} />
        </div>
      </div>
      <div className="panel-section multi-align-controls">
        <span className="section-label">ALIGN SELECTION</span>
        <div className="parametric-button-grid" role="group" aria-label="Align selected objects">
          <button type="button" onClick={() => onAlign(ids, 'left')}>Left</button>
          <button type="button" onClick={() => onAlign(ids, 'center-x')}>Center H</button>
          <button type="button" onClick={() => onAlign(ids, 'right')}>Right</button>
          <button type="button" onClick={() => onAlign(ids, 'top')}>Top</button>
          <button type="button" onClick={() => onAlign(ids, 'center-y')}>Center V</button>
          <button type="button" onClick={() => onAlign(ids, 'bottom')}>Bottom</button>
        </div>
        <div className="transform-flip-actions" role="group" aria-label="Flip selected objects">
          <button type="button" onClick={() => onFlip('horizontal')} title="Flip horizontal · Shift+H"><FlipHorizontalIcon />Flip horizontal<kbd>⇧H</kbd></button>
          <button type="button" onClick={() => onFlip('vertical')} title="Flip vertical · Shift+V"><FlipVerticalIcon />Flip vertical<kbd>⇧V</kbd></button>
        </div>
      </div>
      <div className="panel-section object-appearance-inspector">
        <span className="section-label">COMMON APPEARANCE</span>
        <div className="numeric-field-grid">
          <MixedNumericField label="Opacity" value={opacity} min={0} max={100} onCommit={(value) => onUpdateAppearances(ids, { opacity: value / 100 })} />
          {!allStrokesHidden && (
            <MixedNumericField
              label="Stroke"
              value={strokeWidth}
              min={0}
              live
              onEditStart={() => onBeginContinuousEdit('Change stroke weight')}
              onCommit={(value) => onUpdateAppearances(ids, { strokeWidth: value }, true)}
              onEditEnd={onCommitContinuousEdit}
              onEditCancel={onRollbackContinuousEdit}
            />
          )}
        </div>
        {!allStrokesHidden ? (
          <div className="multi-stroke-controls">
            <StrokeAlignmentControl
              value={strokeAlignment}
              alignedOptionsEnabled={supportsAlignedStroke}
              onChange={(alignment) => onUpdateAppearances(ids, { strokeAlignment: alignment })}
            />
            <button type="button" className="remove-paint-button" onClick={() => onUpdateAppearances(ids, { strokeVisible: false })}>
              {allStrokesVisible ? 'Remove strokes' : 'Remove all strokes'}
            </button>
          </div>
        ) : (
          <button type="button" className="add-fill-button" onClick={() => onUpdateAppearances(ids, { strokeVisible: true })}>Add strokes</button>
        )}
        {constructionOnly ? (
          <p className="semantic-disabled-reason" role="note">Fill is unavailable because these objects contain only construction geometry.</p>
        ) : (
          <label className="appearance-color-row">
            <span>Fill</span>
            <input type="color" value={fillColor ?? '#808080'} aria-label={fillColor ? 'Fill color' : 'Mixed fill colors'} onChange={(event) => onUpdateAppearances(ids, { fillColor: event.target.value })} />
            <code>{fillColor?.toUpperCase() ?? 'MIXED'}</code>
          </label>
        )}
      </div>
      <div className="panel-section multi-layer-state">
        <span className="section-label">LAYER STATE</span>
        <div className="parametric-button-grid">
          <button type="button" onClick={() => onSetLayerState(ids, { locked: !allLocked })}>{allLocked ? 'Unlock all' : anyLocked ? 'Lock all' : 'Lock all'}</button>
          <button type="button" onClick={() => onSetLayerState(ids, { visible: !allVisible })}>{allVisible ? 'Hide all' : 'Show all'}</button>
        </div>
      </div>
    </fieldset>
  );
}

function FlipHorizontalIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path d="M8 2v12M6 4 2 8l4 4M10 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function FlipVerticalIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path d="M2 8h12M4 6l4-4 4 4M4 10l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function NumericField({
  label,
  value,
  min,
  max,
  live = false,
  onCommit,
  onEditStart,
  onEditEnd,
  onEditCancel,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  live?: boolean;
  onCommit: (value: number) => void;
  onEditStart?: () => void;
  onEditEnd?: () => void;
  onEditCancel?: () => void;
}) {
  const formatted = String(Number(value.toFixed(3)));
  const [draft, setDraft] = useState(formatted);
  const editing = useRef(false);
  const editEndRef = useRef(onEditEnd);
  editEndRef.current = onEditEnd;
  useEffect(() => {
    if (!editing.current) setDraft(formatted);
  }, [formatted]);
  useEffect(() => () => {
    if (!editing.current) return;
    editing.current = false;
    editEndRef.current?.();
  }, []);
  const validValue = (text: string) => {
    const next = Number(text);
    return text.trim() !== '' && Number.isFinite(next) &&
      (min === undefined || next >= min) && (max === undefined || next <= max)
      ? next
      : undefined;
  };
  return (
    <label className="numeric-field">
      <span>{label}</span>
      <input
        type="number"
        value={draft}
        min={min}
        max={max}
        step="1"
        onFocus={(event) => {
          editing.current = true;
          onEditStart?.();
          event.currentTarget.select();
        }}
        onChange={(event) => {
          const nextDraft = event.currentTarget.value;
          setDraft(nextDraft);
          const next = validValue(nextDraft);
          if (live && next !== undefined && Math.abs(next - value) > 1e-9) onCommit(next);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
          else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            editing.current = false;
            setDraft(formatted);
            onEditCancel?.();
            event.currentTarget.blur();
          }
        }}
        onBlur={(event) => {
          if (!editing.current) return;
          editing.current = false;
          const next = validValue(event.currentTarget.value);
          if (next === undefined) {
            setDraft(formatted);
            onEditCancel?.();
            return;
          }
          if (!live && Math.abs(next - value) > 1e-9) onCommit(next);
          onEditEnd?.();
        }}
      />
    </label>
  );
}

function MixedNumericField({
  label,
  value,
  min,
  max,
  live = false,
  onCommit,
  onEditStart,
  onEditEnd,
  onEditCancel,
}: {
  label: string;
  value?: number;
  min?: number;
  max?: number;
  live?: boolean;
  onCommit: (value: number) => void;
  onEditStart?: () => void;
  onEditEnd?: () => void;
  onEditCancel?: () => void;
}) {
  const formatted = value === undefined ? '' : String(Number(value.toFixed(3)));
  const [draft, setDraft] = useState(formatted);
  const editing = useRef(false);
  const editEndRef = useRef(onEditEnd);
  editEndRef.current = onEditEnd;
  useEffect(() => {
    if (!editing.current) setDraft(formatted);
  }, [formatted]);
  useEffect(() => () => {
    if (!editing.current) return;
    editing.current = false;
    editEndRef.current?.();
  }, []);
  const validValue = (text: string) => {
    const next = Number(text);
    return text.trim() !== '' && Number.isFinite(next) &&
      (min === undefined || next >= min) && (max === undefined || next <= max)
      ? next
      : undefined;
  };
  return (
    <label className="numeric-field">
      <span>{label}</span>
      <input
        type="number"
        value={draft}
        placeholder="Mixed"
        min={min}
        max={max}
        step="1"
        onFocus={(event) => {
          editing.current = true;
          onEditStart?.();
          event.currentTarget.select();
        }}
        onChange={(event) => {
          const nextDraft = event.currentTarget.value;
          setDraft(nextDraft);
          const next = validValue(nextDraft);
          if (live && next !== undefined && (value === undefined || Math.abs(next - value) > 1e-9)) onCommit(next);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
          else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            editing.current = false;
            setDraft(formatted);
            onEditCancel?.();
            event.currentTarget.blur();
          }
        }}
        onBlur={(event) => {
          if (!editing.current) return;
          editing.current = false;
          const next = validValue(event.currentTarget.value);
          if (next === undefined) {
            setDraft(formatted);
            onEditCancel?.();
            return;
          }
          if (!live && (value === undefined || Math.abs(next - value) > 1e-9)) onCommit(next);
          onEditEnd?.();
        }}
      />
    </label>
  );
}

function EmptyInspector() {
  return (
    <div className="empty-inspector">
      <div className="empty-visual" aria-hidden="true">
        <span /><span /><span />
      </div>
      <h3>Nothing selected</h3>
      <p>Select a layer or object to edit its properties.</p>
    </div>
  );
}

function KeylineMultiNodeInspector({
  nodes,
  lockedRuleCount,
  verticalSuggested,
  onSetMode,
  onMoveAxis,
  onMakeVertical,
}: {
  nodes: VectorNode[];
  lockedRuleCount: number;
  verticalSuggested: boolean;
  onSetMode: (mode: 'corner' | 'smooth' | 'symmetric') => void;
  onMoveAxis: (axis: 'x' | 'y', value: number) => void;
  onMakeVertical: () => void;
}) {
  const selectionKey = nodes.map((node) => node.id).join(':');
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => setDismissed(false), [selectionKey]);
  const common = (axis: 'x' | 'y') => nodes.every((node) => Math.abs(node.position[axis] - nodes[0].position[axis]) < 1e-9)
    ? nodes[0].position[axis]
    : undefined;
  const nodeMode = (node: VectorNode) => node.handleMode ?? (node.handleIn || node.handleOut ? 'symmetric' : 'corner');
  const modes = nodes.map(nodeMode);
  const commonMode = modes.every((mode) => mode === modes[0]) ? modes[0] : undefined;
  return (
    <div className="keyline-node-inspector">
      <div className="multi-summary keyline-selection-compatibility"><h3>Multiple nodes</h3><p>{nodes.length} nodes</p></div>
      <div className="keyline-field-block">
        <span className="keyline-field-label">Position</span>
        <div className="keyline-position-grid">
          <MixedCoordinateField axis="X" value={common('x')} onCommit={(value) => onMoveAxis('x', value)} />
          <MixedCoordinateField axis="Y" value={common('y')} onCommit={(value) => onMoveAxis('y', value)} />
        </div>
      </div>
      <div className="keyline-field-block">
        <span className="keyline-field-label">Corner type</span>
        <div className="keyline-corner-control" role="group" aria-label="Selected point corner type">
          <ModeButton active={commonMode === 'corner'} label="Sharp" title="Sharp corners" onClick={() => onSetMode('corner')} />
          <ModeButton active={commonMode === 'smooth'} label="Smooth" title="Smooth handles" onClick={() => onSetMode('smooth')} />
          <ModeButton active={commonMode === 'symmetric'} label="Mirrored" title="Mirrored handles" onClick={() => onSetMode('symmetric')} />
        </div>
      </div>
      {verticalSuggested && !dismissed && (
        <div className="keyline-suggestion">
          <div className="keyline-suggestion-heading">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/><circle cx="12" cy="12" r="3"/></svg>
            Suggestion
          </div>
          <p>This line is almost vertical. Lock it so it stays vertical when you move the points.</p>
          <div className="keyline-suggestion-actions">
            <button type="button" className="is-primary" onClick={onMakeVertical}>Make vertical</button>
            <button type="button" onClick={() => setDismissed(true)}>Not now</button>
          </div>
        </div>
      )}
      <div className="keyline-locked-rules">
        <span>Locked rules</span>
        <output>{lockedRuleCount}</output>
      </div>
    </div>
  );
}

function MixedCoordinateField({ axis, value, onCommit }: { axis: string; value?: number; onCommit: (value: number) => void }) {
  const formatted = value === undefined ? '' : formatNumber(value);
  const [draft, setDraft] = useState(formatted);
  useEffect(() => setDraft(formatted), [formatted]);
  const commit = () => {
    const trimmed = draft.trim();
    if (!trimmed) { setDraft(formatted); return; }
    const baseline = value ?? 0;
    const result = evaluateNumericExpression(trimmed, baseline);
    if (!result) { setDraft(formatted); return; }
    if (value === undefined || Math.abs(result.value - value) > 1e-9) onCommit(result.value);
  };
  return (
    <label className="coordinate-field">
      <span>{axis}</span>
      <input
        type="text"
        inputMode="decimal"
        aria-label={`Selected points ${axis} position`}
        value={draft}
        placeholder="Mixed"
        spellCheck={false}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
          else if (event.key === 'Escape') { event.preventDefault(); setDraft(formatted); event.currentTarget.blur(); }
        }}
        onBlur={commit}
      />
    </label>
  );
}

function NodeInspector({ node, onSetMode, onMove, onDelete }: {
  node: NonNullable<ReturnType<VectorDocument['getNode']>>;
  onSetMode: (mode: 'corner' | 'smooth' | 'symmetric') => void;
  onMove: (position: { x: number; y: number }) => void;
  onDelete: () => void;
}) {
  const hasHandles = Boolean(node.handleIn || node.handleOut);
  const mode = node.handleMode ?? (hasHandles ? 'symmetric' : 'corner');
  return (
    <>
      <div className="panel-section object-summary node-selection-summary">
        <span className="object-glyph node-glyph" />
        <div><strong>Node</strong><span>{shortId(node.id)}</span></div>
        <button type="button" className="direct-delete-point" title="Delete selected point (Delete)" onClick={onDelete}>Delete</button>
      </div>
      <div className="panel-section">
        <span className="section-label">POSITION</span>
        <div className="field-grid">
          <CoordinateField axis="X" value={node.position.x} onCommit={(x) => onMove({ ...node.position, x })} />
          <CoordinateField axis="Y" value={node.position.y} onCommit={(y) => onMove({ ...node.position, y })} />
        </div>
        <p className="field-help">Use +15, -8, *2, /4, or x/2+6 for precise adjustments.</p>
      </div>
      <div className="panel-section">
        <span className="section-label">NODE MODE</span>
        <div className="segmented-control" role="group" aria-label="Node handle mode">
          <ModeButton active={mode === 'corner'} label="Corner" title="Independent corner handles" onClick={() => onSetMode('corner')} />
          <ModeButton active={mode === 'smooth'} label="Smooth" title="Collinear handles with independent lengths" onClick={() => onSetMode('smooth')} />
          <ModeButton active={mode === 'symmetric'} label="Symmetric" title="Collinear handles with equal lengths" onClick={() => onSetMode('symmetric')} />
        </div>
      </div>
      <details className="panel-section inspector-section node-details">
        <summary><span>Geometry details</span><output>{hasHandles ? 'Handles' : 'No handles'}</output></summary>
        <div className="inspector-section-body node-details-body">
          <div className="property-list">
            <PropertyRow name="Bézier handles" value={hasHandles ? mode : 'None'} />
            <PropertyRow name="Constraints" value={String(node.constraintIds.length)} />
          </div>
          {hasHandles && (
            <div className="handle-details">
              <span className="section-label">HANDLES</span>
              {node.handleIn && <PointRow label="In" x={node.handleIn.x} y={node.handleIn.y} />}
              {node.handleOut && <PointRow label="Out" x={node.handleOut.x} y={node.handleOut.y} />}
            </div>
          )}
        </div>
      </details>
    </>
  );
}

function SegmentInspector({ document, segmentId }: { document: VectorDocument; segmentId: string }) {
  const segment = document.getSegment(segmentId)!;
  const start = document.getNode(segment.startNodeId);
  const end = document.getNode(segment.endNodeId);
  const length = start && end ? Math.hypot(end.position.x - start.position.x, end.position.y - start.position.y) : 0;
  return (
    <>
      <div className="panel-section object-summary">
        <span className="object-glyph segment-glyph" />
        <div><strong>Segment</strong><span>{shortId(segment.id)}</span></div>
      </div>
      <div className="panel-section property-list segment-primary-details">
        <PropertyRow name="Type" value={segment.type === 'bezier' ? 'Bézier' : segment.type === 'arc' ? 'Circular arc' : 'Line'} />
        <PropertyRow name="Role" value={segment.role === 'construction' ? 'Construction' : 'Artwork'} />
        {segment.role === 'construction' && <PropertyRow name="Extent" value={segment.constructionExtent === 'infinite' ? 'Infinite' : 'Finite'} />}
        <PropertyRow name="Chord length" value={`${formatNumber(length)} px`} />
        {segment.type === 'arc' && <PropertyRow name="Radius" value={`${formatNumber(segment.radius ?? 0)} px`} />}
      </div>
      <details className="panel-section inspector-section segment-technical-details">
        <summary><span>Technical details</span><output>{segment.widthProfile?.length ?? 0} width points</output></summary>
        <div className="inspector-section-body property-list">
          <PropertyRow name="Start node" value={shortId(segment.startNodeId)} mono />
          <PropertyRow name="End node" value={shortId(segment.endNodeId)} mono />
        </div>
      </details>
    </>
  );
}

function MultiInspector({ nodeCount, segmentCount }: { nodeCount: number; segmentCount: number }) {
  return (
    <div className="panel-section multi-summary">
      <div className="multi-icon">{nodeCount + segmentCount}</div>
      <h3>{nodeCount > 0 && segmentCount > 0 ? 'Mixed network selection' : nodeCount > 0 ? 'Multiple nodes' : 'Multiple segments'}</h3>
      <p>{nodeCount > 0 && `${nodeCount} node${nodeCount === 1 ? '' : 's'}`}{nodeCount > 0 && segmentCount > 0 && ' · '}{segmentCount > 0 && `${segmentCount} segment${segmentCount === 1 ? '' : 's'}`}</p>
    </div>
  );
}

function CoordinateField({ axis, value, onCommit }: { axis: string; value: number; onCommit: (value: number) => void }) {
  const formatted = formatNumber(value);
  const [draft, setDraft] = useState(formatted);
  useEffect(() => setDraft(formatted), [formatted]);
  const commit = () => {
    const result = evaluateNumericExpression(draft, value);
    if (!result || Math.abs(result.value - value) <= 1e-9) {
      setDraft(formatted);
      return;
    }
    onCommit(result.value);
  };
  return (
    <label className="coordinate-field">
      <span>{axis}</span>
      <input
        type="text"
        inputMode="decimal"
        aria-label={`Point ${axis} position`}
        value={draft}
        spellCheck={false}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            event.currentTarget.blur();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            setDraft(formatted);
            event.currentTarget.blur();
          }
        }}
        onBlur={commit}
      />
    </label>
  );
}

function PointRow({ label, x, y }: { label: string; x: number; y: number }) {
  return <div className="point-row"><span>{label}</span><code>{formatNumber(x)}, {formatNumber(y)}</code></div>;
}

function PropertyRow({ name, value, mono = false }: { name: string; value: string; mono?: boolean }) {
  return <div className="property-row"><span>{name}</span><strong className={mono ? 'mono' : ''}>{value}</strong></div>;
}

function ShortcutRow({ keys, text }: { keys: string[]; text: string }) {
  return <div className="shortcut-row"><span>{text}</span><span>{keys.map((key) => <kbd key={key}>{key}</kbd>)}</span></div>;
}

function ModeButton({
  active,
  label,
  title,
  onClick,
}: { active: boolean; label: string; title: string; onClick: () => void }) {
  return <button type="button" className={active ? 'is-active' : ''} aria-pressed={active} title={title} onClick={onClick}>{label}</button>;
}

function parameterForConstraint(constraint: Constraint): { key: string; label: string; value: number } | null {
  if (constraint.type === 'fixed_distance') return { key: 'distance', label: 'px', value: constraint.parameters?.distance ?? 0 };
  if (constraint.type === 'fixed_angle') return { key: 'angle', label: '°', value: constraint.parameters?.angle ?? 90 };
  if (constraint.type === 'fixed_radius') return { key: 'radius', label: 'r', value: constraint.parameters?.radius ?? 0 };
  return null;
}

function constraintSymbol(type: Constraint['type']): string {
  const symbols: Record<Constraint['type'], string> = {
    parallel: '∥', perpendicular: '⊥', tangent: 'T', symmetric: '◇', equal_length: '=',
    fixed_distance: '↔', fixed_angle: '∠', fixed_radius: 'R', horizontal: 'H', vertical: 'V', coincident: '◎',
  };
  return symbols[type];
}

const shortId = (id: string): string => id.slice(-6).toUpperCase();
const formatNumber = (value: number): string => Number(value.toFixed(2)).toLocaleString('en-US', { maximumFractionDigits: 2 });
