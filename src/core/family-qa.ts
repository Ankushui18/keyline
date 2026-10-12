import type { VectorDocument } from './document';
import { ARTWORK_BOUNDS_POLICY, objectBounds } from './object-geometry';
import type { OperationInput } from './operations';
import { previewGeometryPropagation } from './geometry-components';
import type { Appearance, EntityId, GeometryComponent, NetworkObject } from './types';

export type FamilyQaCategory = 'topology' | 'naming' | 'size' | 'stroke' | 'bounds';
export type FamilyQaSeverity = 'error' | 'warning';

export type FamilyQaFix =
  | { kind: 'rename'; objectId: EntityId; name: string }
  | { kind: 'match-size'; objectId: EntityId; sourceObjectId: EntityId }
  | { kind: 'match-stroke'; objectId: EntityId; sourceObjectId: EntityId }
  | { kind: 'fit-bounds'; objectId: EntityId };

export interface FamilyQaIssue {
  id: string;
  category: FamilyQaCategory;
  severity: FamilyQaSeverity;
  objectId: EntityId;
  objectName: string;
  title: string;
  detail: string;
  fixLabel?: string;
  fix?: FamilyQaFix;
  requiresTopologyReview?: boolean;
}

export interface FamilyQaReport {
  component: GeometryComponent;
  sourceObject: NetworkObject;
  memberCount: number;
  issues: FamilyQaIssue[];
  errorCount: number;
  warningCount: number;
  fixableCount: number;
  passed: boolean;
}

export interface PreparedFamilyQaFix {
  operations: OperationInput[];
  summary: string;
}

export function auditGeometryComponent(
  document: VectorDocument,
  componentId: EntityId,
): FamilyQaReport | null {
  const component = document.getGeometryComponent(componentId);
  const sourceObject = component ? document.getObject(component.sourceObjectId) : undefined;
  if (!component || !sourceObject) return null;
  const members = [sourceObject, ...component.variants
    .map((variant) => document.getObject(variant.objectId))
    .filter((object): object is NetworkObject => Boolean(object))];
  const issues: FamilyQaIssue[] = [];
  const impact = previewGeometryPropagation(document, componentId);

  for (const variantImpact of impact?.variants ?? []) {
    if (variantImpact.state !== 'conflicting') continue;
    issues.push({
      id: issueId(component.id, 'topology', variantImpact.objectId),
      category: 'topology',
      severity: 'error',
      objectId: variantImpact.objectId,
      objectName: variantImpact.objectName,
      title: 'Unresolved topology conflict',
      detail: variantImpact.conflicts.join(' '),
      requiresTopologyReview: true,
    });
  }

  const names = new Map<string, NetworkObject[]>();
  for (const member of members) {
    const key = member.name.trim().toLocaleLowerCase('en-US');
    if (!key) {
      const variantIndex = component.variants.findIndex((variant) => variant.objectId === member.id);
      const name = member.id === sourceObject.id
        ? `${component.name} source`
        : uniqueVariantName(sourceObject.name || component.name, Math.max(0, variantIndex), members);
      issues.push({
        id: issueId(component.id, 'naming', member.id),
        category: 'naming',
        severity: 'warning',
        objectId: member.id,
        objectName: 'Unnamed member',
        title: 'Blank family member name',
        detail: 'Every delivered family member needs a readable, unambiguous name.',
        fixLabel: `Rename to “${name}”`,
        fix: { kind: 'rename', objectId: member.id, name },
      });
      continue;
    }
    const list = names.get(key) ?? [];
    list.push(member);
    names.set(key, list);
  }
  for (const duplicates of names.values()) {
    if (duplicates.length < 2) continue;
    duplicates.slice(1).forEach((object) => {
      const variantIndex = component.variants.findIndex((variant) => variant.objectId === object.id);
      const name = uniqueVariantName(sourceObject.name, Math.max(0, variantIndex), members);
      issues.push({
        id: issueId(component.id, 'naming', object.id),
        category: 'naming',
        severity: 'warning',
        objectId: object.id,
        objectName: object.name,
        title: 'Duplicate family member name',
        detail: `“${object.name}” is used by more than one family member. Delivery names should be unambiguous.`,
        fixLabel: `Rename to “${name}”`,
        fix: { kind: 'rename', objectId: object.id, name },
      });
    });
  }

  const sourceBounds = objectBounds(document, sourceObject.id, ARTWORK_BOUNDS_POLICY);
  const sourceAppearance = document.getAppearance(sourceObject.appearanceId);
  for (const variant of component.variants) {
    const object = document.getObject(variant.objectId);
    if (!object) continue;
    const bounds = objectBounds(document, object.id, ARTWORK_BOUNDS_POLICY);
    if (dimensionsDiffer(sourceBounds, bounds)) {
      issues.push({
        id: issueId(component.id, 'size', object.id),
        category: 'size',
        severity: 'warning',
        objectId: object.id,
        objectName: object.name,
        title: 'Size differs from source',
        detail: `${formatSize(bounds.width, bounds.height)} instead of source ${formatSize(sourceBounds.width, sourceBounds.height)}.`,
        fixLabel: 'Match source size',
        fix: { kind: 'match-size', objectId: object.id, sourceObjectId: sourceObject.id },
      });
    }
    const appearance = document.getAppearance(object.appearanceId);
    if (sourceAppearance && appearance && !strokeEqual(sourceAppearance.stroke, appearance.stroke)) {
      issues.push({
        id: issueId(component.id, 'stroke', object.id),
        category: 'stroke',
        severity: 'warning',
        objectId: object.id,
        objectName: object.name,
        title: 'Stroke rule differs from source',
        detail: object.appearanceRuleId
          ? 'Matching the source stroke will detach this object from its current shared style.'
          : 'Width, color, cap, join, alignment, dash, visibility, or opacity differs.',
        fixLabel: 'Match source stroke',
        fix: { kind: 'match-stroke', objectId: object.id, sourceObjectId: sourceObject.id },
      });
    }
  }

  for (const object of members) {
    const layer = document.getLayerForObject(object.id);
    const artboard = layer ? document.getArtboard(layer.artboardId) : undefined;
    if (!artboard || artboard.isCanvasRoot) continue;
    const bounds = objectBounds(document, object.id, ARTWORK_BOUNDS_POLICY);
    if (!outsideFrame(bounds, artboard.frame)) continue;
    issues.push({
      id: issueId(component.id, 'bounds', object.id),
      category: 'bounds',
      severity: 'warning',
      objectId: object.id,
      objectName: object.name,
      title: 'Artwork exceeds its frame',
      detail: `Artwork extends outside “${artboard.name}” and may be clipped or exported unexpectedly.`,
      fixLabel: 'Move inside frame',
      fix: { kind: 'fit-bounds', objectId: object.id },
    });
  }

  const errorCount = issues.filter((issue) => issue.severity === 'error').length;
  const warningCount = issues.length - errorCount;
  return {
    component,
    sourceObject,
    memberCount: members.length,
    issues,
    errorCount,
    warningCount,
    fixableCount: issues.filter((issue) => Boolean(issue.fix)).length,
    passed: issues.length === 0,
  };
}

export function prepareFamilyQaFix(
  document: VectorDocument,
  fix: FamilyQaFix,
): PreparedFamilyQaFix | null {
  const object = document.getObject(fix.objectId);
  if (!object || document.isObjectLocked(object.id)) return null;
  if (fix.kind === 'rename') {
    return {
      operations: [{ type: 'UPDATE_OBJECT', payload: { objectId: object.id, updates: { name: fix.name } } }],
      summary: `Renamed ${object.name} to ${fix.name}`,
    };
  }
  if (fix.kind === 'match-size') {
    const sourceBounds = objectBounds(document, fix.sourceObjectId, ARTWORK_BOUNDS_POLICY);
    const targetBounds = objectBounds(document, object.id, ARTWORK_BOUNDS_POLICY);
    const canScaleX = sourceBounds.width > 1e-9 && targetBounds.width > 1e-9;
    const canScaleY = sourceBounds.height > 1e-9 && targetBounds.height > 1e-9;
    if (!canScaleX && !canScaleY) return null;
    const transform = {
      ...object.transform,
      scaleX: canScaleX ? object.transform.scaleX * sourceBounds.width / targetBounds.width : object.transform.scaleX,
      scaleY: canScaleY ? object.transform.scaleY * sourceBounds.height / targetBounds.height : object.transform.scaleY,
    };
    return {
      operations: [{ type: 'UPDATE_OBJECT', payload: { objectId: object.id, updates: { transform } } }],
      summary: `Matched ${object.name} to the source size`,
    };
  }
  if (fix.kind === 'match-stroke') {
    const source = document.getObject(fix.sourceObjectId);
    const sourceAppearance = source ? document.getAppearance(source.appearanceId) : undefined;
    const targetAppearance = document.getAppearance(object.appearanceId);
    if (!sourceAppearance || !targetAppearance) return null;
    const operations: OperationInput[] = [];
    if (object.appearanceRuleId) {
      operations.push({
        type: 'UPDATE_OBJECT',
        payload: { objectId: object.id, updates: { appearanceRuleId: undefined } },
      });
    }
    operations.push({
      type: 'UPDATE_APPEARANCE',
      payload: {
        appearanceId: targetAppearance.id,
        updates: {
          stroke: sourceAppearance.stroke
            ? { ...sourceAppearance.stroke, dash: [...sourceAppearance.stroke.dash] }
            : undefined,
        },
      },
    });
    return { operations, summary: `Matched ${object.name} to the source stroke rule` };
  }

  const layer = document.getLayerForObject(object.id);
  const artboard = layer ? document.getArtboard(layer.artboardId) : undefined;
  if (!artboard || artboard.isCanvasRoot) return null;
  const bounds = objectBounds(document, object.id, ARTWORK_BOUNDS_POLICY);
  const frame = artboard.frame;
  let dx = 0;
  let dy = 0;
  if (bounds.width > frame.width) dx = frame.x + frame.width / 2 - (bounds.minX + bounds.maxX) / 2;
  else if (bounds.minX < frame.x) dx = frame.x - bounds.minX;
  else if (bounds.maxX > frame.x + frame.width) dx = frame.x + frame.width - bounds.maxX;
  if (bounds.height > frame.height) dy = frame.y + frame.height / 2 - (bounds.minY + bounds.maxY) / 2;
  else if (bounds.minY < frame.y) dy = frame.y - bounds.minY;
  else if (bounds.maxY > frame.y + frame.height) dy = frame.y + frame.height - bounds.maxY;
  return {
    operations: [{
      type: 'UPDATE_OBJECT',
      payload: {
        objectId: object.id,
        updates: { transform: { ...object.transform, x: object.transform.x + dx, y: object.transform.y + dy } },
      },
    }],
    summary: `Moved ${object.name} inside ${artboard.name}`,
  };
}

function issueId(componentId: EntityId, category: FamilyQaCategory, objectId: EntityId): string {
  return `${componentId}:${category}:${objectId}`;
}

function uniqueVariantName(sourceName: string, index: number, members: NetworkObject[]): string {
  const used = new Set(members.map((object) => object.name.toLocaleLowerCase('en-US')));
  let suffix = index + 1;
  let name = `${sourceName} variant ${suffix}`;
  while (used.has(name.toLocaleLowerCase('en-US'))) name = `${sourceName} variant ${++suffix}`;
  return name;
}

function dimensionsDiffer(
  source: { width: number; height: number },
  target: { width: number; height: number },
): boolean {
  const tolerance = (expected: number) => Math.max(0.5, Math.abs(expected) * 0.01);
  return Math.abs(source.width - target.width) > tolerance(source.width) ||
    Math.abs(source.height - target.height) > tolerance(source.height);
}

function outsideFrame(
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  frame: { x: number; y: number; width: number; height: number },
): boolean {
  const tolerance = 0.5;
  return bounds.minX < frame.x - tolerance || bounds.minY < frame.y - tolerance ||
    bounds.maxX > frame.x + frame.width + tolerance ||
    bounds.maxY > frame.y + frame.height + tolerance;
}

function strokeEqual(a: Appearance['stroke'], b: Appearance['stroke']): boolean {
  if (!a || !b) return a === b;
  return a.color === b.color && a.width === b.width && a.cap === b.cap &&
    a.join === b.join && a.alignment === b.alignment && a.opacity === b.opacity &&
    a.visible === b.visible && a.dash.length === b.dash.length &&
    a.dash.every((value, index) => value === b.dash[index]);
}

function formatSize(width: number, height: number): string {
  const format = (value: number) => Number(value.toFixed(2));
  return `${format(width)} × ${format(height)}`;
}
