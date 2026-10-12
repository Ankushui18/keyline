import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { VectorDocument } from '../core/document';
import {
  analyzeFamilyCollection,
  type FamilyCollectionEntry,
  type FamilyDeliveryStatus,
  type UnlinkedAssetEntry,
} from '../core/family-collection';
import type { EntityId } from '../core/types';
import { FamilyQaDialog } from './FamilyQaDialog';

type CollectionFilter = 'all' | 'attention' | 'ready' | 'unlinked';

export function FamilyCollectionDialog({
  document,
  onClose,
  onApplyFamilyQaFixes,
  onSelectObject,
  onReviewGeometry,
}: {
  document: VectorDocument;
  onClose: () => void;
  onApplyFamilyQaFixes: (componentId: EntityId, issueIds: string[]) => Promise<void>;
  onSelectObject: (objectId: EntityId) => void;
  onReviewGeometry: (componentId: EntityId, sourceObjectId: EntityId) => void;
}) {
  const collection = analyzeFamilyCollection(document);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<CollectionFilter>('all');
  const [selectedKey, setSelectedKey] = useState<string>(() =>
    collection.families[0] ? `family:${collection.families[0].componentId}`
      : collection.unlinkedAssets[0] ? `asset:${collection.unlinkedAssets[0].objectId}` : '');
  const [qaComponentId, setQaComponentId] = useState<EntityId>();
  const [lastRunAt, setLastRunAt] = useState(() => Date.now());
  const [refreshMessage, setRefreshMessage] = useState('');
  const dialogRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const normalizedQuery = query.trim().toLocaleLowerCase('en-US');
  const matchesQuery = (values: string[]) => !normalizedQuery || values.some((value) =>
    value.toLocaleLowerCase('en-US').includes(normalizedQuery));
  const visibleFamilies = collection.families.filter((family) => {
    if (filter === 'unlinked') return false;
    if (filter === 'attention' && family.status === 'ready') return false;
    if (filter === 'ready' && family.status !== 'ready') return false;
    return matchesQuery([family.name, family.sourceName, ...family.memberNames, ...family.locations]);
  });
  const visibleAssets = (filter === 'all' || filter === 'unlinked')
    ? collection.unlinkedAssets.filter((asset) => matchesQuery([
      asset.name,
      asset.layerName,
      asset.artboardName,
    ]))
    : [];
  const matchedFamily = visibleFamilies.find((family) => `family:${family.componentId}` === selectedKey);
  const matchedAsset = visibleAssets.find((asset) => `asset:${asset.objectId}` === selectedKey);
  const selectedFamily = matchedFamily ?? (matchedAsset ? undefined : visibleFamilies[0]);
  const selectedAsset = matchedAsset ?? (!selectedFamily ? visibleAssets[0] : undefined);
  const resultCount = visibleFamilies.length + visibleAssets.length;

  useEffect(() => searchRef.current?.focus(), []);

  if (qaComponentId) {
    const family = collection.families.find((entry) => entry.componentId === qaComponentId);
    return (
      <FamilyQaDialog
        document={document}
        componentId={qaComponentId}
        onCancel={() => setQaComponentId(undefined)}
        onReviewTopology={() => {
          if (family) onReviewGeometry(family.componentId, family.sourceObjectId);
          onClose();
        }}
        onApply={async (issueIds) => {
          await onApplyFamilyQaFixes(qaComponentId, issueIds);
          setQaComponentId(undefined);
          setLastRunAt(Date.now());
        }}
      />
    );
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
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
  };

  return (
    <div className="shared-style-impact-backdrop" onPointerDown={(event) => {
      if (event.currentTarget === event.target) onClose();
    }}>
      <section
        ref={dialogRef}
        className="shared-style-impact-dialog family-collection-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="family-collection-title"
        onKeyDown={handleKeyDown}
      >
        <div className="family-collection-header">
          <div>
            <span className="eyebrow">FAMILY MODE</span>
            <h2 id="family-collection-title">Family collection</h2>
            <p>{collection.families.length} {collection.families.length === 1 ? 'family' : 'families'} · {collection.unlinkedAssets.length} unlinked {collection.unlinkedAssets.length === 1 ? 'asset' : 'assets'}</p>
          </div>
          <div className="family-collection-header-actions">
            <button type="button" className="family-batch-run" onClick={() => {
              setLastRunAt(Date.now());
              setRefreshMessage(`Preflight refreshed · ${collection.issueCount} findings`);
            }}>Run batch preflight</button>
            <button type="button" className="impact-close" aria-label="Close family collection" onClick={onClose}>×</button>
          </div>
        </div>

        <div className="family-collection-summary" aria-label="Family delivery status">
          <StatusSummary label="Blocked" value={collection.blockedCount} tone="blocked" />
          <StatusSummary label="Needs review" value={collection.reviewCount} tone="review" />
          <StatusSummary label="Ready" value={collection.readyCount} tone="ready" />
          <StatusSummary label="Unlinked" value={collection.unlinkedAssets.length} tone="unlinked" />
          <span className="family-preflight-time">Checked {new Date(lastRunAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
          <span className="sr-only" aria-live="polite">{refreshMessage}</span>
        </div>

        <div className="family-collection-controls">
          <label className="family-collection-search">
            <span className="sr-only">Search families and assets</span>
            <input
              ref={searchRef}
              type="search"
              placeholder="Search families and assets"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </label>
          <div className="family-collection-filters" role="group" aria-label="Collection filter">
            <FilterButton label="All" count={collection.families.length + collection.unlinkedAssets.length} active={filter === 'all'} onClick={() => setFilter('all')} />
            <FilterButton label="Needs attention" count={collection.blockedCount + collection.reviewCount} active={filter === 'attention'} onClick={() => setFilter('attention')} />
            <FilterButton label="Ready" count={collection.readyCount} active={filter === 'ready'} onClick={() => setFilter('ready')} />
            <FilterButton label="Unlinked" count={collection.unlinkedAssets.length} active={filter === 'unlinked'} onClick={() => setFilter('unlinked')} />
          </div>
        </div>

        <div className="family-collection-grid">
          <section className="family-collection-list" aria-label={`${resultCount} collection results`}>
            {resultCount === 0 && (
              <div className="family-collection-empty">
                <strong>No matching items</strong>
                <span>Try another search or status filter.</span>
              </div>
            )}
            {visibleFamilies.length > 0 && <h3>Families</h3>}
            {visibleFamilies.map((family) => (
              <button
                type="button"
                className={`family-collection-row is-${family.status}`}
                aria-pressed={selectedFamily?.componentId === family.componentId}
                key={family.componentId}
                onClick={() => setSelectedKey(`family:${family.componentId}`)}
              >
                <span className="family-collection-glyph" aria-hidden="true">◆</span>
                <span>
                  <strong>{family.name}</strong>
                  <small>{family.memberCount} members · {family.locations.join(', ')}</small>
                </span>
                <StatusBadge status={family.status} />
                <span className="family-row-findings">{family.report.issues.length + family.pendingVariantCount}</span>
              </button>
            ))}
            {visibleAssets.length > 0 && <h3>Unlinked assets</h3>}
            {visibleAssets.map((asset) => (
              <button
                type="button"
                className="family-collection-row is-unlinked"
                aria-pressed={selectedAsset?.objectId === asset.objectId}
                key={asset.objectId}
                onClick={() => setSelectedKey(`asset:${asset.objectId}`)}
              >
                <span className="family-collection-glyph" aria-hidden="true">◇</span>
                <span>
                  <strong>{asset.name}</strong>
                  <small>{asset.artboardName} · {formatSize(asset.width, asset.height)}</small>
                </span>
                <span className="family-status-badge is-unlinked">Unlinked</span>
              </button>
            ))}
          </section>

          <section className="family-collection-detail" aria-label="Selected collection item">
            {selectedFamily ? (
              <FamilyDetail
                family={selectedFamily}
                onReviewQa={() => setQaComponentId(selectedFamily.componentId)}
                onReviewGeometry={() => {
                  onReviewGeometry(selectedFamily.componentId, selectedFamily.sourceObjectId);
                  onClose();
                }}
                onSelectSource={() => {
                  onSelectObject(selectedFamily.sourceObjectId);
                  onClose();
                }}
              />
            ) : selectedAsset ? (
              <UnlinkedDetail asset={selectedAsset} onSelect={() => {
                onSelectObject(selectedAsset.objectId);
                onClose();
              }} />
            ) : (
              <div className="family-collection-empty is-detail">
                <strong>No reusable families yet</strong>
                <span>Create a linked variant from an asset to establish its first family relationship.</span>
              </div>
            )}
          </section>
        </div>

        <div className="family-collection-footer">
          <p>Batch preflight is read-only. Fixes remain explicit and family-scoped.</p>
          <div><button type="button" onClick={onClose}>Done</button></div>
        </div>
      </section>
    </div>
  );
}

function FamilyDetail({
  family,
  onReviewQa,
  onReviewGeometry,
  onSelectSource,
}: {
  family: FamilyCollectionEntry;
  onReviewQa: () => void;
  onReviewGeometry: () => void;
  onSelectSource: () => void;
}) {
  return (
    <>
      <div className="family-detail-heading">
        <span className="family-detail-glyph" aria-hidden="true">◆</span>
        <div><span className="eyebrow">GEOMETRY FAMILY</span><h3>{family.name}</h3><p>Source: {family.sourceName}</p></div>
        <StatusBadge status={family.status} />
      </div>
      <div className="family-detail-metrics">
        <div><strong>{family.memberCount}</strong><span>members</span></div>
        <div><strong>{family.report.issues.length}</strong><span>QA findings</span></div>
        <div><strong>{family.pendingVariantCount}</strong><span>updates pending</span></div>
        <div><strong>{family.overriddenVariantCount}</strong><span>with overrides</span></div>
      </div>
      <div className="family-detail-section">
        <div className="family-detail-section-heading"><h3>Delivery preflight</h3><span>{family.locations.join(' · ')}</span></div>
        {family.report.passed && family.pendingVariantCount === 0 ? (
          <div className="family-detail-pass"><strong>Ready for delivery</strong><span>No current QA findings or pending inherited geometry.</span></div>
        ) : (
          <div className="family-detail-findings">
            {family.report.issues.map((issue) => (
              <div key={issue.id} className={`is-${issue.severity}`}>
                <span>{issue.category}</span>
                <strong>{issue.title}</strong>
                <small>{issue.objectName}</small>
              </div>
            ))}
            {family.pendingVariantCount > 0 && (
              <div className="is-warning">
                <span>geometry</span>
                <strong>{family.pendingVariantCount} {family.pendingVariantCount === 1 ? 'variant has' : 'variants have'} pending source changes</strong>
                <small>Review geometry impact before delivery.</small>
              </div>
            )}
          </div>
        )}
      </div>
      {family.issueCategories.length > 0 && (
        <div className="family-category-chips" aria-label="Finding categories">
          {family.issueCategories.map((category) => <span key={category}>{category}</span>)}
        </div>
      )}
      {family.lastQaCheckedAt && (
        <p className="family-detail-history">Last fix pass {new Date(family.lastQaCheckedAt).toLocaleString()}</p>
      )}
      <div className="family-detail-actions">
        <button type="button" className="family-detail-primary" onClick={onReviewQa}>Review family QA</button>
        <button type="button" onClick={onReviewGeometry}>Review geometry impact</button>
        <button type="button" onClick={onSelectSource}>Select source</button>
      </div>
    </>
  );
}

function UnlinkedDetail({ asset, onSelect }: { asset: UnlinkedAssetEntry; onSelect: () => void }) {
  return (
    <>
      <div className="family-detail-heading">
        <span className="family-detail-glyph is-unlinked" aria-hidden="true">◇</span>
        <div><span className="eyebrow">UNLINKED ASSET</span><h3>{asset.name}</h3><p>{asset.layerName} · {asset.artboardName}</p></div>
        <span className="family-status-badge is-unlinked">Unlinked</span>
      </div>
      <div className="family-detail-metrics is-asset">
        <div><strong>{formatNumber(asset.width)}</strong><span>width</span></div>
        <div><strong>{formatNumber(asset.height)}</strong><span>height</span></div>
        <div><strong>{asset.locked ? 'Locked' : 'Editable'}</strong><span>access</span></div>
        <div><strong>{asset.hidden ? 'Hidden' : 'Visible'}</strong><span>visibility</span></div>
      </div>
      <div className="family-unlinked-guidance">
        <strong>This asset has no reusable geometry relationship.</strong>
        <span>Select it in the editor, then create a linked variant to establish a family source while preserving the current artwork.</span>
      </div>
      <div className="family-detail-actions">
        <button type="button" className="family-detail-primary" onClick={onSelect}>Select in editor</button>
      </div>
    </>
  );
}

function StatusSummary({ label, value, tone }: { label: string; value: number; tone: string }) {
  return <div className={`family-status-summary is-${tone}`}><strong>{value}</strong><span>{label}</span></div>;
}

function StatusBadge({ status }: { status: FamilyDeliveryStatus }) {
  return <span className={`family-status-badge is-${status}`}>{status === 'review' ? 'Review' : status[0].toUpperCase() + status.slice(1)}</span>;
}

function FilterButton({ label, count, active, onClick }: { label: string; count: number; active: boolean; onClick: () => void }) {
  return <button type="button" aria-pressed={active} onClick={onClick}>{label}<span>{count}</span></button>;
}

function formatNumber(value: number): string {
  return String(Number(value.toFixed(2)));
}

function formatSize(width: number, height: number): string {
  return `${formatNumber(width)} × ${formatNumber(height)}`;
}
