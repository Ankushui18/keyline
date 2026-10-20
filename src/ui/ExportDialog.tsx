import { drawnObjectsForArtboard } from '../core/real-content';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { VectorDocument } from '../core/document';
import { createEntityId } from '../core/ids';
import type { OperationManager } from '../core/operations';
import type {
  Artboard,
  DeliveryExportFormat,
  DeliveryPngScale,
  ExportDeliverySettings,
  ExportPreset,
  ExportVariable,
  ExportVariableBinding,
} from '../core/types';
import { exportCssVariables, exportReactComponent } from '../export/code-export';
import {
  archiveFilename,
  cloneDeliverySettings,
  createZipBlob,
  downloadBlob,
  normalizeDeliverySettings,
  planDeliveryExports,
} from '../export/delivery-export';
import { exportArtboardToPngBlob } from '../export/png-export';
import {
  constructionLinesExcludedCount,
  downloadTextFile,
  exportDocumentToSvg,
} from '../export/svg-export';

type ExportTab = 'svg' | 'react' | 'css';

export function ExportDialog({
  document,
  manager,
  onClose,
}: {
  document: VectorDocument;
  manager: OperationManager;
  onClose: () => void;
}) {
  const artboards = useMemo(() => document.pages
    .flatMap((page) => page.artboardIds)
    .map((artboardId) => document.getArtboard(artboardId))
    .filter((artboard): artboard is Artboard => Boolean(artboard) && !artboard?.isCanvasRoot), [document]);
  const initialArtboard = !document.activeArtboard.isCanvasRoot
    ? document.activeArtboard
    : artboards[0];
  const [format, setFormat] = useState<ExportTab>('svg');
  const [settings, setSettings] = useState<ExportDeliverySettings>(() =>
    normalizeDeliverySettings(document.exportMetadata.lastUsed));
  const [selectedArtboardIds, setSelectedArtboardIds] = useState<Set<string>>(() =>
    new Set(initialArtboard ? [initialArtboard.id] : []));
  const [artboardQuery, setArtboardQuery] = useState('');
  const [presetName, setPresetName] = useState('');
  const [selectedPresetId, setSelectedPresetId] = useState('');
  const [componentName, setComponentName] = useState('VectorAsset');
  const [selectedVariableIds, setSelectedVariableIds] = useState<Set<string>>(() => new Set(document.exportVariables.keys()));
  const [copied, setCopied] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [previewTheme, setPreviewTheme] = useState<'light' | 'dark'>('light');
  const [inheritColor, setInheritColor] = useState(true);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previousFocus = documentActiveElement();
    const backdrop = dialogRef.current?.closest('.modal-backdrop');
    const shell = backdrop?.parentElement;
    const background = shell
      ? [...shell.children].filter((element): element is HTMLElement => element instanceof HTMLElement && element !== backdrop)
      : [];
    const previousStates = background.map((element) => ({
      element,
      inert: element.inert,
      ariaHidden: element.getAttribute('aria-hidden'),
    }));
    background.forEach((element) => {
      element.inert = true;
      element.setAttribute('aria-hidden', 'true');
    });
    closeRef.current?.focus();
    return () => {
      previousStates.forEach(({ element, inert, ariaHidden }) => {
        element.inert = inert;
        if (ariaHidden === null) element.removeAttribute('aria-hidden');
        else element.setAttribute('aria-hidden', ariaHidden);
      });
      previousFocus?.focus();
    };
  }, []);

  const handleDialogKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ) ?? [])].filter((element) => element.offsetParent !== null);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && window.document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && window.document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const handleTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const order: ExportTab[] = ['svg', 'react', 'css'];
    const current = order.indexOf(format);
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? order.length - 1
        : (current + (event.key === 'ArrowRight' ? 1 : -1) + order.length) % order.length;
    setFormat(order[next]);
    window.requestAnimationFrame(() => dialogRef.current?.querySelector<HTMLElement>(`#export-tab-${order[next]}`)?.focus());
  };

  const updateSettings = (updates: Partial<ExportDeliverySettings>) => {
    setError('');
    setSettings((current) => ({
      ...current,
      ...updates,
      formats: updates.formats ? [...updates.formats] : current.formats,
      pngScales: updates.pngScales ? [...updates.pngScales] : current.pngScales,
      customSize: Object.prototype.hasOwnProperty.call(updates, 'customSize')
        ? updates.customSize ? { ...updates.customSize } : undefined
        : current.customSize,
    }));
  };
  const selectedArtboards = artboards.filter((artboard) => selectedArtboardIds.has(artboard.id));
  const filteredArtboards = artboards.filter((artboard) =>
    artboard.name.toLocaleLowerCase().includes(artboardQuery.trim().toLocaleLowerCase()));
  const plan = planDeliveryExports(selectedArtboards, settings);
  const previewArtboard = selectedArtboards[0] ?? initialArtboard;
  const previewSvg = previewArtboard
    ? exportDocumentToSvg(document, {
        artboardId: previewArtboard.id,
        exportBoundsMode: settings.boundsMode,
        backgroundColor: settings.includeBackground ? previewArtboard.background : undefined,
        includeMetadata: false,
        ...(inheritColor ? { strokeColor: 'currentColor', fillColor: 'currentColor' } : {}),
      })
    : '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1" width="1" height="1"/>';
  const drawnStyles = previewArtboard
    ? drawnObjectsForArtboard(document, previewArtboard.id).flatMap((object) => {
      const stroke = document.getAppearance(object.appearanceId)?.stroke;
      return stroke?.visible ? [stroke] : [];
    })
    : [];
  const drawnColours = [...new Set(drawnStyles.map((stroke) => stroke.color.replace('#', '').toUpperCase()))];
  const drawnWidths = [...new Set(drawnStyles.map((stroke) => Math.round(stroke.width * 100) / 100))];
  const previewViewBox = previewSvg.match(/\bviewBox="([^"]+)"/)?.[1] ?? 'Unavailable';
  const variables = [...document.exportVariables.values()].sort((a, b) => a.name.localeCompare(b.name));
  const excludedConstructionLines = constructionLinesExcludedCount(document);
  const codeContent = format === 'svg'
    ? previewSvg
    : format === 'react'
      ? exportReactComponent(document, { componentName, variableIds: selectedVariableIds })
      : exportCssVariables(document, selectedVariableIds);
  const codeFilename = format === 'react' ? `${safeFilename(componentName)}.tsx` : 'vector-asset.css';

  const addVariable = (binding: ExportVariableBinding) => {
    const presets: Record<ExportVariableBinding, Omit<ExportVariable, 'id'>> = {
      strokeWidth: { name: 'strokeWidth', label: 'Stroke width', type: 'number', binding, value: 1.25, min: 0.25, max: 24 },
      fillColor: { name: 'assetColor', label: 'Asset color', type: 'color', binding, value: '#c8ced9' },
      scale: { name: 'scale', label: 'Scale', type: 'number', binding, value: 1, min: 0.25, max: 4 },
      opacity: { name: 'opacity', label: 'Opacity', type: 'number', binding, value: 1, min: 0, max: 1 },
    };
    if (variables.some((variable) => variable.binding === binding)) return;
    const variable = { id: createEntityId(), ...presets[binding] };
    manager.execute({ type: 'ADD_EXPORT_VARIABLE', payload: { variable } });
    setSelectedVariableIds((current) => new Set([...current, variable.id]));
  };

  const updateVariable = (variableId: string, updates: Partial<ExportVariable>) => {
    manager.execute({ type: 'UPDATE_EXPORT_VARIABLE', payload: { variableId, updates } });
  };

  const removeVariable = (variableId: string) => {
    manager.execute({ type: 'REMOVE_EXPORT_VARIABLE', payload: { variableId } });
    setSelectedVariableIds((current) => {
      const next = new Set(current);
      next.delete(variableId);
      return next;
    });
  };

  const persistLastUsed = () => {
    const next = {
      ...document.exportMetadata,
      lastUsed: cloneDeliverySettings(settings),
      presets: document.exportMetadata.presets.map(clonePreset),
    };
    if (JSON.stringify(next) === JSON.stringify(document.exportMetadata)) return;
    manager.beginTransaction('Remember export settings');
    try {
      manager.execute({ type: 'UPDATE_EXPORT_METADATA', payload: { metadata: next } });
      manager.commitTransaction();
    } catch (caught) {
      manager.rollbackTransaction();
      throw caught;
    }
  };

  const savePreset = () => {
    const name = presetName.trim();
    if (!name) {
      setError('Enter a preset name before saving.');
      return;
    }
    const id = selectedPresetId || createEntityId();
    const preset: ExportPreset = { id, name, settings: cloneDeliverySettings(settings) };
    const presets = document.exportMetadata.presets.some((item) => item.id === id)
      ? document.exportMetadata.presets.map((item) => item.id === id ? preset : clonePreset(item))
      : [...document.exportMetadata.presets.map(clonePreset), preset];
    manager.beginTransaction(selectedPresetId ? 'Update export preset' : 'Save export preset');
    try {
      manager.execute({
        type: 'UPDATE_EXPORT_METADATA',
        payload: { metadata: { lastUsed: cloneDeliverySettings(settings), presets } },
      });
      manager.commitTransaction();
      setSelectedPresetId(id);
      setError('');
    } catch (caught) {
      manager.rollbackTransaction();
      setError(errorMessage(caught));
    }
  };

  const deletePreset = () => {
    if (!selectedPresetId) return;
    manager.execute({
      type: 'UPDATE_EXPORT_METADATA',
      payload: {
        metadata: {
          lastUsed: cloneDeliverySettings(settings),
          presets: document.exportMetadata.presets.filter((preset) => preset.id !== selectedPresetId).map(clonePreset),
        },
      },
    });
    setSelectedPresetId('');
    setPresetName('');
  };

  const runDeliveryExport = async () => {
    if (selectedArtboards.length === 0) {
      setError('Select at least one artboard to export.');
      return;
    }
    if (plan.targets.length === 0) {
      setError('Choose at least one output format and PNG size.');
      return;
    }
    if (plan.collisions.length > 0) {
      setError(`Resolve filename collisions before exporting: ${plan.collisions.join(', ')}`);
      return;
    }
    setError('');
    setExporting(true);
    try {
      persistLastUsed();
      const files: Array<{ filename: string; data: string | Blob }> = [];
      for (const [index, target] of plan.targets.entries()) {
        setProgress(`Preparing ${index + 1} of ${plan.targets.length}: ${target.filename}`);
        const artboard = document.getArtboard(target.artboardId);
        if (!artboard) throw new Error(`Artboard “${target.artboardName}” is no longer available.`);
        if (target.format === 'svg') {
          const svg = exportDocumentToSvg(document, {
            artboardId: artboard.id,
            exportBoundsMode: settings.boundsMode,
            backgroundColor: settings.includeBackground ? artboard.background : undefined,
            includeMetadata: false,
            ...(inheritColor ? { strokeColor: 'currentColor', fillColor: 'currentColor' } : {}),
          });
          files.push({ filename: target.filename, data: svg });
        } else {
          const rendered = await exportArtboardToPngBlob(document, target.customSize
            ? {
                artboardId: artboard.id,
                boundsMode: settings.boundsMode,
                includeBackground: settings.includeBackground,
                customSize: target.customSize,
              }
            : {
                artboardId: artboard.id,
                boundsMode: settings.boundsMode,
                includeBackground: settings.includeBackground,
                scale: target.scale ?? 1,
              });
          files.push({ filename: target.filename, data: rendered.blob });
        }
      }
      if (settings.includeManifest) {
        setProgress('Preparing family change manifest…');
        const { exportFamilyChangeManifest } = await import('../export/family-manifest');
        files.push({
          filename: 'family-change-manifest.md',
          data: exportFamilyChangeManifest(document, { artboardIds: selectedArtboardIds }),
        });
      }
      if (files.length === 1) {
        const file = files[0];
        if (typeof file.data === 'string') downloadTextFile(file.data, file.filename, 'image/svg+xml');
        else downloadBlob(file.data, file.filename);
      } else {
        setProgress(`Compressing ${files.length} files…`);
        const zip = await createZipBlob(files);
        downloadBlob(zip, archiveFilename(selectedArtboards));
      }
      setProgress(`${files.length} file${files.length === 1 ? '' : 's'} ready`);
    } catch (caught) {
      setError(errorMessage(caught));
      setProgress('');
    } finally {
      setExporting(false);
    }
  };

  const toggleFormat = (nextFormat: DeliveryExportFormat) => {
    const selected = settings.formats.includes(nextFormat);
    const next = selected
      ? settings.formats.filter((item) => item !== nextFormat)
      : [...settings.formats, nextFormat];
    if (next.length > 0) updateSettings({ formats: next });
  };
  const toggleScale = (scale: DeliveryPngScale) => {
    const next = settings.pngScales.includes(scale)
      ? settings.pngScales.filter((item) => item !== scale)
      : [...settings.pngScales, scale];
    if (next.length > 0 || settings.customSize) updateSettings({ pngScales: next });
  };
  const toggleArtboard = (artboardId: string, checked: boolean) => {
    setSelectedArtboardIds((current) => {
      const next = new Set(current);
      if (checked) next.add(artboardId); else next.delete(artboardId);
      return next;
    });
    setError('');
  };
  const allFilteredSelected = filteredArtboards.length > 0 &&
    filteredArtboards.every((artboard) => selectedArtboardIds.has(artboard.id));

  const deliveryFileCount = plan.targets.length + (settings.includeManifest ? 1 : 0);
  const primaryLabel = format === 'svg'
    ? exporting ? 'Exporting…'
      : deliveryFileCount > 1 ? `Export ${deliveryFileCount} files as ZIP`
        : plan.targets[0]?.format === 'png' ? 'Download PNG' : 'Download SVG'
    : `Download ${format === 'react' ? 'TSX' : 'CSS'}`;
  const deliveryMode: 'svg' | 'react' | 'css' | 'png' = format !== 'svg'
    ? format
    : settings.formats.length === 1 && settings.formats[0] === 'png' ? 'png' : 'svg';
  const activeName = previewArtboard?.name ?? 'Icon 24';
  // A fill needs a closed shape. Count filled shapes that still have an open path.
  const openFilledCount = previewArtboard
    ? drawnObjectsForArtboard(document, previewArtboard.id).filter((object) => {
      const hasFill = document.getAppearance(object.appearanceId)?.fills.some((fill) => fill.visible !== false);
      const network = document.getNetwork(object.networkId);
      const hasOpenPath = network?.pathIds.some((pathId) => document.getPath(pathId)?.isClosed === false);
      return Boolean(hasFill && hasOpenPath);
    }).length
    : 0;

  return (
    <div className="modal-backdrop keyline-export-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section ref={dialogRef} className="export-dialog keyline-export-dialog" role="dialog" aria-modal="true" aria-labelledby="export-title" onKeyDown={handleDialogKeyDown}>
        <header className="keyline-export-header">
          <h2 id="export-title">Export <span>{activeName} · Product icons</span></h2>
          <button ref={closeRef} className="dialog-close" onClick={onClose} aria-label="Close export dialog">×</button>
        </header>

        <div className="keyline-export-body">
          <section className="keyline-export-preview-column" aria-label="Export preview and code">
            <div className="keyline-export-section-heading">
              <span>Preview</span>
              <div className="keyline-theme-toggle" role="group" aria-label="Preview background">
                <button type="button" className={previewTheme === 'light' ? 'is-active' : ''} onClick={() => setPreviewTheme('light')}>Light</button>
                <button type="button" className={previewTheme === 'dark' ? 'is-active' : ''} onClick={() => setPreviewTheme('dark')}>Dark</button>
              </div>
            </div>
            <div className={`keyline-export-artwork-preview is-${previewTheme}`}>
              {[48, 24, 16].map((size) => (
                <figure key={size}>
                  <span className="keyline-export-svg" style={{ width: size, height: size }} dangerouslySetInnerHTML={{ __html: previewSvg }} />
                  <figcaption>{size}</figcaption>
                </figure>
              ))}
            </div>
            <div className="keyline-export-code-heading">
              <span>Code</span>
              <code>{`${(new Blob([codeContent]).size / 1024).toFixed(1)} KB`}</code>
            </div>
            <textarea className="keyline-export-code" readOnly value={codeContent} aria-label="Exported code preview" spellCheck={false} />
          </section>

          <section className="keyline-export-options-column" aria-label="Export options">
            <div className="keyline-reference-format">
              <span>Format</span>
              <div className="keyline-reference-segmented" role="group" aria-label="Visible export format">
                <button type="button" className={deliveryMode === 'svg' ? 'is-active' : ''} onClick={() => { setFormat('svg'); updateSettings({ formats: ['svg'] }); }}>SVG</button>
                <button type="button" className={deliveryMode === 'react' ? 'is-active' : ''} onClick={() => setFormat('react')}>React</button>
                <button type="button" className={deliveryMode === 'css' ? 'is-active' : ''} onClick={() => setFormat('css')}>CSS</button>
                <button type="button" className={deliveryMode === 'png' ? 'is-active' : ''} onClick={() => { setFormat('svg'); updateSettings({ formats: ['png'] }); }}>PNG</button>
              </div>
            </div>

            {format === 'svg' ? (
              <>
                <div className="keyline-colour-options">
                  <span>Colour</span>
                  <button type="button" className={inheritColor ? 'is-active' : ''} onClick={() => setInheritColor(true)}>
                    <i />
                    <strong>Inherit text colour</strong>
                    <small>Stroke uses currentColor, so the icon matches the text around it.</small>
                  </button>
                  <button type="button" className={!inheritColor ? 'is-active' : ''} onClick={() => setInheritColor(false)}>
                    <i />
                    <strong>Keep drawn colours</strong>
                    <small>{drawnColours.length === 0 ? 'No lines drawn' : drawnColours.length === 1 ? `#${drawnColours[0]}` : `${drawnColours.length} colours`}</small>
                  </button>
                </div>
                <div className="keyline-wiring-option">
                  <span>Line width in this file</span>
                  <div><strong>Stroke width</strong><code>{drawnWidths.length === 0 ? 'none' : drawnWidths.length === 1 ? `${drawnWidths[0]} px` : 'mixed'}</code></div>
                </div>
                <button type="button" className="keyline-export-advanced-trigger" aria-expanded={advancedOpen} onClick={() => setAdvancedOpen((open) => !open)}>
                  Advanced: bounds, background, file name <span>{advancedOpen ? '⌃' : '⌄'}</span>
                </button>
                {advancedOpen && (
                  <div className="keyline-export-advanced-panel">
                    <label><input type="checkbox" checked={settings.boundsMode === 'artboard'} onChange={(event) => updateSettings({ boundsMode: event.target.checked ? 'artboard' : 'artwork' })} />Use artboard bounds</label>
                    <label><input type="checkbox" checked={settings.includeBackground} onChange={(event) => updateSettings({ includeBackground: event.target.checked })} />Include background</label>
                    <label>File name<input value={settings.namingPattern} onChange={(event) => updateSettings({ namingPattern: event.target.value })} /></label>
                  </div>
                )}
              </>
            ) : (
              <div className="keyline-code-export-options">
                <CodeExportControls
                  format={format}
                  componentName={componentName}
                  onComponentNameChange={setComponentName}
                  variables={variables}
                  selectedIds={selectedVariableIds}
                  onSelectedIdsChange={setSelectedVariableIds}
                  onAddVariable={addVariable}
                  onUpdateVariable={updateVariable}
                  onRemoveVariable={removeVariable}
                />
              </div>
            )}
          </section>
        </div>

        <footer className="keyline-export-footer">
          <div className="delivery-status" aria-live="polite">
            {excludedConstructionLines > 0 && <span>{excludedConstructionLines} construction lines excluded</span>}
            {error && <span className="delivery-error" role="alert">{error}</span>}
            {!error && plan.collisions.length > 0 && <span className="delivery-error" role="alert">Filename collision: {plan.collisions.join(', ')}</span>}
            {!error && openFilledCount > 0 && <span className="delivery-warning" role="status">{openFilledCount} open {openFilledCount === 1 ? 'path won’t' : 'paths won’t'} fill. Close {openFilledCount === 1 ? 'it' : 'them'}, or export as lines.</span>}
            {!error && progress && <span>{progress}</span>}
            {!error && !progress && openFilledCount === 0 && <span>{deliveryFileCount || 1} icon · {plan.targets[0]?.filename ?? `${activeName.toLowerCase().replaceAll(' ', '-')}.svg`}</span>}
          </div>
          <button className="secondary-button" onClick={() => {
            void navigator.clipboard.writeText(codeContent).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1200);
            });
          }}>{copied ? 'Copied' : 'Copy code'}</button>
          <button
            className="primary-button"
            disabled={exporting || (format === 'svg' && (plan.targets.length === 0 || plan.collisions.length > 0))}
            onClick={() => {
              if (format === 'svg') void runDeliveryExport();
              else downloadTextFile(codeContent, codeFilename, 'text/plain;charset=utf-8');
            }}
          >{primaryLabel}</button>
        </footer>

        <div className="export-compatibility-controls" data-construction-excluded={excludedConstructionLines}>
          <div className="export-tabs" role="tablist" aria-label="Export format">
            <button id="export-tab-svg" role="tab" aria-selected={format === 'svg'} aria-controls="export-panel-svg" tabIndex={format === 'svg' ? 0 : -1} className={format === 'svg' ? 'is-active' : ''} onKeyDown={handleTabKeyDown} onClick={() => setFormat('svg')}>SVG &amp; PNG</button>
            <button id="export-tab-react" role="tab" aria-selected={format === 'react'} aria-controls="export-panel-react" tabIndex={format === 'react' ? 0 : -1} className={format === 'react' ? 'is-active' : ''} onKeyDown={handleTabKeyDown} onClick={() => setFormat('react')}>React Component</button>
            <button id="export-tab-css" role="tab" aria-selected={format === 'css'} aria-controls="export-panel-css" tabIndex={format === 'css' ? 0 : -1} className={format === 'css' ? 'is-active' : ''} onKeyDown={handleTabKeyDown} onClick={() => setFormat('css')}>CSS Variables</button>
          </div>
          <span id="export-panel-svg" hidden />
          <span id="export-panel-react" hidden />
          <span id="export-panel-css" hidden />
          {format === 'svg' && (
            <DeliveryControls
              document={document}
              artboards={artboards}
              filteredArtboards={filteredArtboards}
              selectedIds={selectedArtboardIds}
              query={artboardQuery}
              settings={settings}
              presets={document.exportMetadata.presets}
              selectedPresetId={selectedPresetId}
              presetName={presetName}
              plan={plan}
              allFilteredSelected={allFilteredSelected}
              onQueryChange={setArtboardQuery}
              onToggleArtboard={toggleArtboard}
              onToggleAll={() => setSelectedArtboardIds((current) => {
                const next = new Set(current);
                for (const artboard of filteredArtboards) {
                  if (allFilteredSelected) next.delete(artboard.id); else next.add(artboard.id);
                }
                return next;
              })}
              onSettingsChange={updateSettings}
              onToggleFormat={toggleFormat}
              onToggleScale={toggleScale}
              onPresetSelect={(presetId) => {
                setSelectedPresetId(presetId);
                const preset = document.exportMetadata.presets.find((item) => item.id === presetId);
                if (preset) {
                  setSettings(normalizeDeliverySettings(preset.settings));
                  setPresetName(preset.name);
                } else setPresetName('');
                setError('');
              }}
              onPresetNameChange={setPresetName}
              onSavePreset={savePreset}
              onDeletePreset={deletePreset}
              previewViewBox={previewViewBox}
            />
          )}
        </div>
      </section>
    </div>
  );
}

function DeliveryControls({
  document,
  artboards,
  filteredArtboards,
  selectedIds,
  query,
  settings,
  presets,
  selectedPresetId,
  presetName,
  plan,
  allFilteredSelected,
  onQueryChange,
  onToggleArtboard,
  onToggleAll,
  onSettingsChange,
  onToggleFormat,
  onToggleScale,
  onPresetSelect,
  onPresetNameChange,
  onSavePreset,
  onDeletePreset,
  previewViewBox,
}: {
  document: VectorDocument;
  artboards: Artboard[];
  filteredArtboards: Artboard[];
  selectedIds: Set<string>;
  query: string;
  settings: ExportDeliverySettings;
  presets: ExportPreset[];
  selectedPresetId: string;
  presetName: string;
  plan: ReturnType<typeof planDeliveryExports>;
  allFilteredSelected: boolean;
  onQueryChange: (value: string) => void;
  onToggleArtboard: (artboardId: string, checked: boolean) => void;
  onToggleAll: () => void;
  onSettingsChange: (updates: Partial<ExportDeliverySettings>) => void;
  onToggleFormat: (format: DeliveryExportFormat) => void;
  onToggleScale: (scale: DeliveryPngScale) => void;
  onPresetSelect: (presetId: string) => void;
  onPresetNameChange: (name: string) => void;
  onSavePreset: () => void;
  onDeletePreset: () => void;
  previewViewBox: string;
}) {
  const customEnabled = Boolean(settings.customSize);
  const customFallback = artboards.find((artboard) => selectedIds.has(artboard.id))?.frame ?? { width: 1024, height: 1024 };
  return (
    <div className="delivery-controls">
      <section className="delivery-section" aria-labelledby="delivery-preset-heading">
        <div className="delivery-section-heading"><strong id="delivery-preset-heading">Preset</strong></div>
        <select aria-label="Export preset" value={selectedPresetId} onChange={(event) => onPresetSelect(event.target.value)}>
          <option value="">Custom settings</option>
          {presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
        </select>
        <div className="delivery-preset-save">
          <input aria-label="Preset name" placeholder="Icon Set Delivery" value={presetName} onChange={(event) => onPresetNameChange(event.target.value)} />
          <button type="button" onClick={onSavePreset}>Save</button>
          {selectedPresetId && <button type="button" onClick={onDeletePreset} aria-label="Delete selected export preset">×</button>}
        </div>
      </section>

      <section className="delivery-section" aria-labelledby="delivery-artboards-heading">
        <div className="delivery-section-heading">
          <strong id="delivery-artboards-heading">Artboards</strong>
          <button type="button" onClick={onToggleAll}>{allFilteredSelected ? 'Clear shown' : 'Select All'}</button>
        </div>
        <label className="delivery-search"><span className="sr-only">Search artboards</span><input type="search" placeholder="Search artboards" value={query} onChange={(event) => onQueryChange(event.target.value)} /></label>
        <div className="delivery-artboard-list" role="group" aria-label="Artboards to export">
          {filteredArtboards.length === 0 && <p>No artboards match “{query}”.</p>}
          {filteredArtboards.map((artboard) => {
            const thumbnail = exportDocumentToSvg(document, { artboardId: artboard.id, exportBoundsMode: 'artboard', includeMetadata: false });
            return (
              <label key={artboard.id} className="delivery-artboard-row">
                <input type="checkbox" checked={selectedIds.has(artboard.id)} onChange={(event) => onToggleArtboard(artboard.id, event.target.checked)} />
                <span className="delivery-artboard-thumb" aria-hidden="true"><img alt="" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(thumbnail)}`} /></span>
                <span><strong>{artboard.name}</strong><small>{Math.round(artboard.frame.width)} × {Math.round(artboard.frame.height)}</small></span>
              </label>
            );
          })}
        </div>
      </section>

      <section className="delivery-section" aria-labelledby="delivery-output-heading">
        <div className="delivery-section-heading"><strong id="delivery-output-heading">Output</strong><span>{plan.targets.length + (settings.includeManifest ? 1 : 0)} files</span></div>
        <div className="delivery-format-grid" role="group" aria-label="Output formats">
          <label><input type="checkbox" checked={settings.formats.includes('svg')} onChange={() => onToggleFormat('svg')} />SVG</label>
          <label><input type="checkbox" checked={settings.formats.includes('png')} onChange={() => onToggleFormat('png')} />PNG</label>
        </div>
        {settings.formats.includes('png') && (
          <fieldset className="delivery-scale-fieldset">
            <legend>PNG sizes</legend>
            <div className="delivery-scale-grid">
              {([1, 2, 3] as DeliveryPngScale[]).map((scale) => (
                <label key={scale}><input type="checkbox" checked={settings.pngScales.includes(scale)} onChange={() => onToggleScale(scale)} />{scale}×</label>
              ))}
              <label><input type="checkbox" checked={customEnabled} onChange={(event) => onSettingsChange({
                customSize: event.target.checked
                  ? { width: Math.round(customFallback.width), height: Math.round(customFallback.height) }
                  : undefined,
              })} />Custom</label>
            </div>
            {settings.customSize && (
              <div className="delivery-custom-size">
                <label>Width<input aria-label="Custom PNG width" type="number" min="1" step="1" value={settings.customSize.width} onChange={(event) => onSettingsChange({ customSize: { ...settings.customSize!, width: Number(event.target.value) } })} /></label>
                <span aria-hidden="true">×</span>
                <label>Height<input aria-label="Custom PNG height" type="number" min="1" step="1" value={settings.customSize.height} onChange={(event) => onSettingsChange({ customSize: { ...settings.customSize!, height: Number(event.target.value) } })} /></label>
              </div>
            )}
          </fieldset>
        )}
      </section>

      <section className="delivery-section svg-export-controls" aria-labelledby="delivery-bounds-heading">
        <div className="delivery-section-heading"><strong id="delivery-bounds-heading">Bounds &amp; background</strong></div>
        <label className="export-toggle-row">
          <span><strong>Use Artboard Bounds</strong><small>{settings.boundsMode === 'artboard' ? 'Preserves transparent frame padding' : 'Tightly fits visible artwork'}</small></span>
          <input type="checkbox" checked={settings.boundsMode === 'artboard'} onChange={(event) => onSettingsChange({ boundsMode: event.target.checked ? 'artboard' : 'artwork' })} />
        </label>
        <label className="export-toggle-row">
          <span><strong>Include Background</strong><small>{settings.includeBackground ? 'Use each artboard background' : 'Transparent'}</small></span>
          <input type="checkbox" checked={settings.includeBackground} onChange={(event) => onSettingsChange({ includeBackground: event.target.checked })} />
        </label>
        <label className="export-toggle-row">
          <span><strong>Family change manifest</strong><small>Human-readable QA status and intentional differences</small></span>
          <input type="checkbox" checked={Boolean(settings.includeManifest)} onChange={(event) => onSettingsChange({ includeManifest: event.target.checked })} />
        </label>
      </section>

      <section className="delivery-section" aria-labelledby="delivery-name-heading">
        <div className="delivery-section-heading"><strong id="delivery-name-heading">File naming</strong></div>
        <label className="export-field">Pattern<input aria-label="Export filename pattern" value={settings.namingPattern} onChange={(event) => onSettingsChange({ namingPattern: event.target.value })} /></label>
        <p className="delivery-token-help"><code>{'{name}'}</code> <code>{'{scale}'}</code> <code>{'{format}'}</code> · Example: search-24-2x.png</p>
      </section>

      <div className="export-viewbox-card" aria-live="polite"><span>PREVIEW VIEWBOX</span><code>{previewViewBox}</code></div>
    </div>
  );
}

function CodeExportControls({
  format,
  componentName,
  onComponentNameChange,
  variables,
  selectedIds,
  onSelectedIdsChange,
  onAddVariable,
  onUpdateVariable,
  onRemoveVariable,
}: {
  format: 'react' | 'css';
  componentName: string;
  onComponentNameChange: (value: string) => void;
  variables: ExportVariable[];
  selectedIds: Set<string>;
  onSelectedIdsChange: (ids: Set<string>) => void;
  onAddVariable: (binding: ExportVariableBinding) => void;
  onUpdateVariable: (variableId: string, updates: Partial<ExportVariable>) => void;
  onRemoveVariable: (variableId: string) => void;
}) {
  return (
    <>
      {format === 'react' && <label className="export-field">Component name<input value={componentName} onChange={(event) => onComponentNameChange(event.target.value)} /></label>}
      <span className="section-label">EXPOSED VARIABLES</span>
      <div className="export-preset-grid">
        <button onClick={() => onAddVariable('strokeWidth')}>+ Stroke</button>
        <button onClick={() => onAddVariable('fillColor')}>+ Color</button>
        <button onClick={() => onAddVariable('scale')}>+ Scale</button>
        <button onClick={() => onAddVariable('opacity')}>+ Opacity</button>
      </div>
      <div className="export-variable-list">
        {variables.length === 0 && <p>No variables exposed. Add only the runtime controls this component should support.</p>}
        {variables.map((variable) => (
          <article key={variable.id}>
            <label className="variable-toggle">
              <input type="checkbox" checked={selectedIds.has(variable.id)} onChange={(event) => {
                const next = new Set(selectedIds);
                if (event.target.checked) next.add(variable.id); else next.delete(variable.id);
                onSelectedIdsChange(next);
              }} />
              <input aria-label="Variable name" value={variable.name} onChange={(event) => onUpdateVariable(variable.id, { name: event.target.value })} />
            </label>
            <div className="variable-value-row">
              {variable.type === 'color' ? (
                <input type="color" value={String(variable.value)} onChange={(event) => onUpdateVariable(variable.id, { value: event.target.value })} />
              ) : (
                <input type="number" value={Number(variable.value)} min={variable.min} max={variable.max} step="0.1" onChange={(event) => onUpdateVariable(variable.id, { value: Number(event.target.value) })} />
              )}
              <code>{variable.binding}</code>
              <button onClick={() => onRemoveVariable(variable.id)} title="Remove exposed variable">×</button>
            </div>
          </article>
        ))}
      </div>
      <p className="export-note">Generated components contain solved SVG only—never the constraint solver.</p>
    </>
  );
}

function clonePreset(preset: ExportPreset): ExportPreset {
  return { ...preset, settings: cloneDeliverySettings(preset.settings) };
}

function documentActiveElement(): HTMLElement | null {
  return window.document.activeElement instanceof HTMLElement ? window.document.activeElement : null;
}

function safeFilename(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_-]+/g, '-') || 'VectorAsset';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Export failed. Try a smaller output or fewer files.';
}
