import { AnnotationEditorType, AnnotationMode, getDocument, GlobalWorkerOptions, type PDFDocumentLoadingTask, type PDFDocumentProxy } from 'pdfjs-dist';
import { EventBus, LinkTarget, PDFLinkService, PDFViewer, ScrollMode, SpreadMode } from 'pdfjs-dist/web/pdf_viewer.mjs';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export type ReadingState = { page: number; pages: number; scale: number; scaleValue: string };
type ReadingPosition = { page: number; fraction: number; scaleValue: string; scrollLeft: number };
type LoadedDocument = { task: PDFDocumentLoadingTask; pdf: PDFDocumentProxy; revision: number };
type PendingDocument = { task: PDFDocumentLoadingTask; revision: number; controller: AbortController };

/** PDFViewer owns its lazy render queue and bounded page buffer; only published PDF bytes enter here. */
export class PdfPreview {
  readonly eventBus = new EventBus();
  readonly linkService = new PDFLinkService({
    eventBus: this.eventBus,
    externalLinkTarget: LinkTarget.BLANK,
    externalLinkRel: 'noopener noreferrer',
    ignoreDestinationZoom: true,
  });
  readonly viewer: PDFViewer;
  private readonly lifetime = new AbortController();
  private readonly resizeObserver: ResizeObserver;
  private readonly releasedTasks = new WeakMap<PDFDocumentLoadingTask, Promise<void>>();
  private requestedRevision = -1;
  private active?: LoadedDocument;
  private pending?: PendingDocument;
  private installation?: AbortController;
  private disposed = false;

  constructor(
    private readonly container: HTMLDivElement,
    viewerElement: HTMLDivElement,
    private readonly onChange: (state: ReadingState) => void,
    private readonly onError: (message: string) => void,
  ) {
    // The runtime's public abortSignal option also disposes its scroll/resize observers.
    const options: ConstructorParameters<typeof PDFViewer>[0] & { abortSignal: AbortSignal } = {
      container,
      viewer: viewerElement,
      eventBus: this.eventBus,
      linkService: this.linkService,
      textLayerMode: 1,
      annotationMode: AnnotationMode.ENABLE,
      annotationEditorMode: AnnotationEditorType.DISABLE,
      removePageBorders: true,
      enableAutoLinking: false,
      abortSignal: this.lifetime.signal,
    };
    this.viewer = new PDFViewer(options);
    this.viewer.scrollMode = ScrollMode.VERTICAL;
    this.viewer.spreadMode = SpreadMode.NONE;
    this.linkService.setViewer(this.viewer);
    for (const event of ['pagesinit', 'pagechanging', 'scalechanging', 'updateviewarea']) {
      this.eventBus.on(event, this.notify, { signal: this.lifetime.signal });
    }
    this.eventBus.on('pagerendered', this.onPageRendered, { signal: this.lifetime.signal });
    this.resizeObserver = new ResizeObserver(() => {
      if (!this.hasDocument) return;
      const scale = this.viewer.currentScaleValue;
      if (scale === 'page-width' || scale === 'page-fit') this.viewer.currentScaleValue = scale;
      this.viewer.update();
    });
    this.resizeObserver.observe(container);
  }

  get hasDocument(): boolean { return !!this.active && this.viewer.pagesCount > 0; }
  get state(): ReadingState {
    return {
      page: this.hasDocument ? this.viewer.currentPageNumber : 0,
      pages: this.viewer.pagesCount,
      scale: this.viewer.currentScale,
      scaleValue: this.viewer.currentScaleValue || 'page-width',
    };
  }

  /** A newer source revision cancels PDF parsing, but leaves the last displayed PDF alive. */
  invalidate(revision: number): void {
    if (revision <= this.requestedRevision) return;
    this.requestedRevision = revision;
    if (this.pending && this.pending.revision < revision) {
      this.pending.controller.abort();
      void this.release(this.pending.task);
      this.pending = undefined;
    }
  }

  async load(bytes: Uint8Array, revision: number): Promise<boolean> {
    this.invalidate(revision);
    if (this.disposed || revision !== this.requestedRevision) return false;
    if (this.active?.revision === revision && !this.pending) return true;
    if (this.pending) {
      this.pending.controller.abort();
      void this.release(this.pending.task);
    }
    const controller = new AbortController();
    // PDF.js transfers this buffer to its worker. IPC supplied a renderer-owned byte array.
    const task = getDocument({ data: bytes, isEvalSupported: false });
    const pending: PendingDocument = { task, revision, controller };
    this.pending = pending;
    let installed = false;
    try {
      const pdf = await task.promise;
      await pdf.getPage(1);
      if (this.disposed || controller.signal.aborted || this.pending !== pending || revision !== this.requestedRevision) return false;

      const previous = this.active;
      const position = this.capturePosition();
      const candidate: LoadedDocument = { task, pdf, revision };
      const installation = new AbortController();
      this.installation?.abort();
      this.installation = installation;
      this.pending = undefined;
      this.active = candidate;
      installed = true;
      const initialized = this.whenInitialized(pdf, installation.signal);
      this.linkService.setDocument(pdf);
      this.viewer.setDocument(pdf);
      this.watchInitializationFailure(initialized);
      try {
        await initialized.promise;
        if (this.active !== candidate || this.disposed) return false;
        this.restorePosition(position);
        this.notify();
        return revision === this.requestedRevision;
      } catch (cause) {
        // A decoding/layout failure must not discard an already readable PDF.
        if (this.active === candidate && !this.disposed) {
          this.active = previous;
          if (previous) {
            const restored = this.whenInitialized(previous.pdf, this.lifetime.signal);
            this.linkService.setDocument(previous.pdf);
            this.viewer.setDocument(previous.pdf);
            this.watchInitializationFailure(restored);
            await restored.promise;
            this.restorePosition(position);
          } else {
            this.linkService.setDocument(null);
            // PDF.js implements null reset; its published viewer types omit null.
            this.viewer.setDocument(null!);
          }
          this.notify();
        }
        throw cause;
      } finally {
        if (this.active !== candidate) void this.release(task);
        if (previous && this.active !== previous) void this.release(previous.task);
        if (this.installation === installation) this.installation = undefined;
      }
    } catch (cause) {
      if (controller.signal.aborted || this.disposed || revision !== this.requestedRevision) return false;
      throw cause;
    } finally {
      if (this.pending === pending) this.pending = undefined;
      if (!installed) void this.release(task);
    }
  }

  goToPage(page: number): void {
    if (!this.hasDocument || !Number.isInteger(page)) return;
    this.viewer.currentPageNumber = Math.min(this.viewer.pagesCount, Math.max(1, page));
  }

  zoom(direction: 'in' | 'out'): void {
    if (!this.hasDocument) return;
    if (direction === 'in') this.viewer.increaseScale();
    else this.viewer.decreaseScale();
  }

  fit(mode: 'page-width' | 'page-fit'): void {
    if (this.hasDocument) this.viewer.currentScaleValue = mode;
  }

  async close(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.lifetime.abort();
    this.installation?.abort();
    this.pending?.controller.abort();
    this.resizeObserver.disconnect();
    this.linkService.setDocument(null);
    this.viewer.setDocument(null!);
    const tasks = [this.pending?.task, this.active?.task];
    this.pending = undefined;
    this.active = undefined;
    await Promise.all(tasks.map((task) => task ? this.release(task) : Promise.resolve()));
  }

  private readonly notify = (): void => { if (!this.disposed) this.onChange(this.state); };
  private readonly onPageRendered = (event: { source: unknown; pageNumber: number; error?: unknown }): void => {
    if (!event.error || event.source !== this.viewer.getPageView(event.pageNumber - 1) || this.disposed) return;
    this.onError(event.error instanceof Error ? event.error.message : String(event.error));
  };

  private capturePosition(): ReadingPosition {
    if (!this.hasDocument) return { page: 1, fraction: 0, scaleValue: 'page-width', scrollLeft: 0 };
    const top = this.container.getBoundingClientRect().top + this.container.clientTop;
    let page = this.viewer.currentPageNumber;
    let div = this.pageElement(page);
    // currentPageNumber is the most visible page; retain the page at the viewport's top edge.
    while (page > 1 && this.pageElement(page - 1).getBoundingClientRect().bottom > top) div = this.pageElement(--page);
    while (page < this.viewer.pagesCount && div.getBoundingClientRect().bottom <= top) div = this.pageElement(++page);
    const bounds = div.getBoundingClientRect();
    return {
      page,
      fraction: Math.min(1, Math.max(0, (top - bounds.top) / bounds.height)),
      scaleValue: this.viewer.currentScaleValue || String(this.viewer.currentScale),
      scrollLeft: this.container.scrollLeft,
    };
  }

  private restorePosition(position: ReadingPosition): void {
    const page = Math.min(position.page, this.viewer.pagesCount);
    this.viewer.currentPageNumber = page;
    this.viewer.currentScaleValue = position.scaleValue;
    const bounds = this.pageElement(page).getBoundingClientRect();
    const top = this.container.getBoundingClientRect().top + this.container.clientTop;
    this.container.scrollTop += bounds.top - top + position.fraction * bounds.height;
    this.container.scrollLeft = position.scrollLeft;
    this.viewer.update();
  }

  private pageElement(page: number): HTMLDivElement {
    // getPageView and its div are public PDF.js geometry, not its private page array/buffer.
    return this.viewer.getPageView(page - 1).div as HTMLDivElement;
  }

  private whenInitialized(pdf: PDFDocumentProxy, signal: AbortSignal): { promise: Promise<void>; reject: (cause: unknown) => void } {
    let reject!: (cause: unknown) => void;
    const promise = new Promise<void>((resolve, rejectPromise) => {
      const cleanup = (): void => {
        this.eventBus.off('pagesinit', ready);
        signal.removeEventListener('abort', aborted);
      };
      const ready = (): void => {
        if (this.viewer.pdfDocument !== pdf) return;
        cleanup();
        resolve();
      };
      reject = (cause): void => { cleanup(); rejectPromise(cause); };
      const aborted = (): void => reject(new DOMException('PDF load superseded', 'AbortError'));
      this.eventBus.on('pagesinit', ready);
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) aborted();
    });
    return { promise, reject };
  }

  private watchInitializationFailure(initialized: { reject: (cause: unknown) => void }): void {
    const pages: Promise<unknown> | null = this.viewer.pagesPromise;
    if (pages) void pages.catch(initialized.reject);
  }

  private release(task: PDFDocumentLoadingTask): Promise<void> {
    let released = this.releasedTasks.get(task);
    if (!released) {
      // The loading task owns its worker and document resources.
      released = task.destroy().catch((cause: unknown) => { console.warn('Cannot release PDF preview resources:', cause); });
      this.releasedTasks.set(task, released);
    }
    return released;
  }
}
