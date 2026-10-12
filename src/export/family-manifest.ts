import type { VectorDocument } from '../core/document';
import { auditGeometryComponent } from '../core/family-qa';
import { previewGeometryPropagation } from '../core/geometry-components';
import type { EntityId, GeometryVariantLink } from '../core/types';

export interface FamilyManifestOptions {
  artboardIds?: ReadonlySet<EntityId>;
  generatedAt?: number;
}

/** Human-readable delivery companion. Internal entity IDs are intentionally omitted. */
export function exportFamilyChangeManifest(
  document: VectorDocument,
  options: FamilyManifestOptions = {},
): string {
  const generatedAt = options.generatedAt ?? Date.now();
  const components = [...document.geometryComponents.values()]
    .filter((component) => familyTouchesArtboards(document, component.sourceObjectId, component.variants, options.artboardIds))
    .sort((a, b) => a.name.localeCompare(b.name));
  const lines = [
    '# Family Delivery Change Manifest',
    '',
    `Generated: ${new Date(generatedAt).toISOString()}`,
    `Families: ${components.length}`,
    '',
  ];
  if (components.length === 0) {
    lines.push('No reusable geometry families are included in this delivery.', '');
    return `${lines.join('\n')}\n`;
  }

  for (const component of components) {
    const report = auditGeometryComponent(document, component.id);
    const preview = previewGeometryPropagation(document, component.id);
    if (!report || !preview) continue;
    lines.push(`## ${clean(component.name)}`, '');
    lines.push(`- Source: ${clean(report.sourceObject.name)}`);
    lines.push(`- Members: ${report.memberCount}`);
    lines.push(`- QA: ${report.passed ? 'Pass' : `${report.errorCount} errors, ${report.warningCount} warnings`}`);
    lines.push(`- Unresolved topology conflicts: ${preview.conflictCount}`);
    if (component.lastQa) {
      lines.push(`- Last QA fix pass: ${new Date(component.lastQa.checkedAt).toISOString()}`);
      lines.push(`- Issues remaining after that pass: ${component.lastQa.remainingIssueCount}`);
    }
    lines.push('', '### Variants', '');
    if (preview.variants.length === 0) lines.push('- No linked variants.');
    for (const impact of preview.variants) {
      lines.push(`- **${clean(impact.objectName)}** — ${impact.state}`);
      lines.push(`  - Geometry overrides: ${impact.overriddenNodeCount + impact.overriddenSegmentCount}`);
      lines.push(`  - Topology overrides: ${impact.topologyOverrideCount}`);
      lines.push(`  - Pending geometry differences: ${impact.changedNodeCount} nodes, ${impact.changedSegmentCount} segments, ${impact.changedPathCount} paths`);
      if (impact.conflicts.length > 0) lines.push(`  - Conflict: ${clean(impact.conflicts.join(' '))}`);
    }
    lines.push('', '### QA findings', '');
    if (report.issues.length === 0) lines.push('- None.');
    for (const issue of report.issues) {
      lines.push(`- **${issue.severity.toUpperCase()} · ${categoryLabel(issue.category)} · ${clean(issue.objectName)}**`);
      lines.push(`  - ${clean(issue.title)}: ${clean(issue.detail)}`);
    }
    if (component.lastQa?.appliedFixes.length) {
      lines.push('', '### Last applied QA fixes', '');
      for (const summary of component.lastQa.appliedFixes) lines.push(`- ${clean(summary)}`);
    }
    lines.push('');
  }
  lines.push('---', '', 'This manifest contains human-readable family status only. Production SVG and PNG files remain free of editor metadata.', '');
  return `${lines.join('\n')}\n`;
}

function familyTouchesArtboards(
  document: VectorDocument,
  sourceObjectId: EntityId,
  variants: GeometryVariantLink[],
  selectedArtboardIds: ReadonlySet<EntityId> | undefined,
): boolean {
  if (!selectedArtboardIds || selectedArtboardIds.size === 0) return true;
  return [sourceObjectId, ...variants.map((variant) => variant.objectId)].some((objectId) => {
    const layer = document.getLayerForObject(objectId);
    return Boolean(layer && selectedArtboardIds.has(layer.artboardId));
  });
}

function categoryLabel(category: string): string {
  return category[0].toUpperCase() + category.slice(1);
}

function clean(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}
