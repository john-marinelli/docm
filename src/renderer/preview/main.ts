import '@fontsource/source-sans-3/400.css';
import '@fontsource/source-sans-3/600.css';
import type { PreviewUpdate, SourceLocation } from '../../shared/types.js';
import { PdfPreview, type ReadingState } from './pdf-preview.js';
import './preview.css';

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing preview element: ${id}`);
  return found as T;
}

const sourceTitle = element<HTMLHeadingElement>('source-title');
const previousPage = element<HTMLButtonElement>('previous-page');
const nextPage = element<HTMLButtonElement>('next-page');
const pageNumber = element<HTMLInputElement>('page-number');
const pageCount = element<HTMLSpanElement>('page-count');
const pageIndicator = element<HTMLSpanElement>('page-indicator');
const zoomOut = element<HTMLButtonElement>('zoom-out');
const zoomIn = element<HTMLButtonElement>('zoom-in');
const zoomPercentage = element<HTMLOutputElement>('zoom-percentage');
const fitWidth = element<HTMLButtonElement>('fit-width');
const fitPage = element<HTMLButtonElement>('fit-page');
const exportButton = element<HTMLButtonElement>('export-pdf');
const statusBanner = element<HTMLDivElement>('preview-status');
const statusMessage = element<HTMLSpanElement>('status-message');
const sourceDiagnostic = element<HTMLSpanElement>('source-diagnostic');
const exportStatus = element<HTMLDivElement>('export-status');
const emptyState = element<HTMLDivElement>('empty-state');
const emptyTitle = element<HTMLHeadingElement>('empty-title');
const emptyMessage = element<HTMLParagraphElement>('empty-message');
const container = element<HTMLDivElement>('viewer-container');
let latestRevision = -1;
let exporting = false;
let renderStatus: 'rendering' | 'ready' | 'error' = 'rendering';
let diagnostic: { message: string; source?: SourceLocation } | undefined;

const preview = new PdfPreview(container, element<HTMLDivElement>('pdf-viewer'), updateControls, (message) => {
  renderStatus = 'error';
  diagnostic = { message: `Cannot display PDF: ${message}` };
  updateStatus();
});

function updateControls(state: ReadingState): void {
  const ready = state.pages > 0;
  previousPage.disabled = !ready || state.page <= 1;
  nextPage.disabled = !ready || state.page >= state.pages;
  pageNumber.disabled = !ready;
  pageNumber.max = String(Math.max(1, state.pages));
  if (document.activeElement !== pageNumber || pageNumber.valueAsNumber > state.pages) pageNumber.value = String(state.page || 1);
  pageCount.textContent = `of ${state.pages}`;
  pageIndicator.textContent = ready ? `Page ${state.page} of ${state.pages}` : 'No pages';
  zoomOut.disabled = !ready || state.scale <= 0.1;
  zoomIn.disabled = !ready || state.scale >= 10;
  zoomPercentage.value = `${Math.round(state.scale * 100)}%`;
  fitWidth.disabled = !ready;
  fitPage.disabled = !ready;
  fitWidth.setAttribute('aria-pressed', String(state.scaleValue === 'page-width'));
  fitPage.setAttribute('aria-pressed', String(state.scaleValue === 'page-fit'));
  exportButton.disabled = !ready || exporting;
  emptyState.hidden = ready;
}

function updateStatus(): void {
  const hasPdf = preview.hasDocument;
  statusBanner.dataset.kind = renderStatus;
  container.setAttribute('aria-busy', String(renderStatus === 'rendering'));
  sourceDiagnostic.hidden = !diagnostic?.source;
  sourceDiagnostic.textContent = diagnostic?.source
    ? `${diagnostic.source.path}:${diagnostic.source.line}:${diagnostic.source.column}`
    : '';
  if (renderStatus === 'error') {
    statusMessage.textContent = `${hasPdf ? 'Preview is stale' : 'Cannot render preview'} — ${diagnostic?.message ?? 'Unknown render error'}`;
    emptyTitle.textContent = 'No PDF to display';
    emptyMessage.textContent = 'Resolve the diagnostic above and save the document. The preview will recover automatically.';
  } else if (renderStatus === 'rendering') {
    statusMessage.textContent = hasPdf ? 'Updating preview… Showing the last successful PDF.' : 'Rendering document…';
    emptyTitle.textContent = 'Rendering document…';
    emptyMessage.textContent = 'The generated PDF will appear here when it is ready.';
  } else {
    statusMessage.textContent = 'Preview is up to date';
  }
  updateControls(preview.state);
}

async function receiveUpdate(update: PreviewUpdate): Promise<void> {
  if (update.revision < latestRevision) return;
  latestRevision = update.revision;
  preview.invalidate(update.revision);
  if ('status' in update) {
    renderStatus = update.status;
    diagnostic = update.status === 'error' ? { message: update.message, source: update.source } : undefined;
    updateStatus();
    return;
  }
  renderStatus = 'rendering';
  diagnostic = undefined;
  updateStatus();
  statusMessage.textContent = preview.hasDocument ? 'Loading updated PDF… Showing the last successful PDF.' : 'Loading PDF preview…';
  try {
    const displayed = await preview.load(update.pdf, update.revision);
    if (!displayed || update.revision !== latestRevision) return;
    renderStatus = 'ready';
    diagnostic = undefined;
  } catch (cause) {
    if (update.revision !== latestRevision) return;
    renderStatus = 'error';
    diagnostic = { message: `Cannot display PDF: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
  updateStatus();
}

async function exportPdf(): Promise<void> {
  if (exporting || !preview.hasDocument) return;
  exporting = true;
  exportButton.textContent = 'Exporting…';
  exportButton.setAttribute('aria-busy', 'true');
  exportStatus.hidden = true;
  updateControls(preview.state);
  try {
    const result = await window.docm.exportPdf();
    exportStatus.dataset.kind = result.status;
    exportStatus.textContent = result.status === 'saved'
      ? `Saved PDF to ${result.path}`
      : result.status === 'error' ? `Export failed — ${result.message}` : 'Export cancelled.';
  } catch (cause) {
    exportStatus.dataset.kind = 'error';
    exportStatus.textContent = `Export failed — ${cause instanceof Error ? cause.message : String(cause)}`;
  } finally {
    exporting = false;
    exportButton.textContent = 'Export PDF';
    exportButton.removeAttribute('aria-busy');
    exportStatus.hidden = false;
    updateControls(preview.state);
  }
}

previousPage.addEventListener('click', () => preview.goToPage(preview.state.page - 1));
nextPage.addEventListener('click', () => preview.goToPage(preview.state.page + 1));
pageNumber.addEventListener('change', () => {
  preview.goToPage(pageNumber.valueAsNumber);
  pageNumber.value = String(preview.state.page || 1);
});
pageNumber.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    preview.goToPage(pageNumber.valueAsNumber);
    pageNumber.value = String(preview.state.page || 1);
    container.focus();
  }
});
zoomOut.addEventListener('click', () => preview.zoom('out'));
zoomIn.addEventListener('click', () => preview.zoom('in'));
fitWidth.addEventListener('click', () => preview.fit('page-width'));
fitPage.addEventListener('click', () => preview.fit('page-fit'));
exportButton.addEventListener('click', () => { void exportPdf(); });
window.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's' && !event.altKey) {
    event.preventDefault();
    void exportPdf();
  }
});

const titleElement = document.querySelector('title');
const updateTitle = (): void => {
  const filename = document.title || 'docm';
  sourceTitle.textContent = filename;
  sourceTitle.title = filename;
};
const titleObserver = new MutationObserver(updateTitle);
if (titleElement) titleObserver.observe(titleElement, { childList: true, characterData: true, subtree: true });
updateTitle();
updateStatus();
const unsubscribe = window.docm.onUpdate((update) => { void receiveUpdate(update); });
window.addEventListener('pagehide', () => {
  unsubscribe();
  titleObserver.disconnect();
  void preview.close();
}, { once: true });
