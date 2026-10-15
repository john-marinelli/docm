import { stat } from 'node:fs/promises';
import path from 'node:path';
import chokidar from 'chokidar';
import type { FSWatcher } from 'chokidar';
import { fingerprint, snapshotMatches } from '../render/assets.js';
import type { renderDocument } from '../render/pdf.js';
import { clearMathCache } from '../render/math.js';
import { RenderError } from '../shared/errors.js';
import type { ExportResult, PreviewUpdate, RenderResult, Snapshot } from '../shared/types.js';
import { OutputInvalidated, validateOutputPath, writePdfAtomically } from './output.js';

const debounceMs = 250;
type SessionOptions = {
  sourcePath: string;
  cwd: string;
  globalThemePath: string;
  configPath?: string;
  publish: (update: PreviewUpdate) => void;
  render?: typeof renderDocument;
  write?: typeof writePdfAtomically;
};
type WatchPlan = { roots: string[]; chain: Set<string> };

async function watchPlan(files: ReadonlySet<string>): Promise<WatchPlan> {
  const roots = new Set<string>();
  const chain = new Set<string>();
  for (const file of files) {
    let directory = path.dirname(file);
    chain.add(file);
    for (;;) {
      chain.add(directory);
      try {
        if ((await stat(directory)).isDirectory()) break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      }
      const parent = path.dirname(directory);
      if (parent === directory) throw new Error(`No existing watch parent for ${file}`);
      directory = parent;
    }
    roots.add(directory);
  }
  // An already watched ancestor covers another root, but only along approved chains.
  const minimalRoots = [...roots].filter((root) => ![...roots].some((other) =>
    other !== root && root.startsWith(other.endsWith(path.sep) ? other : `${other}${path.sep}`),
  ));
  for (const file of files) {
    let entry = file;
    const root = minimalRoots.find((candidate) => file.startsWith(candidate.endsWith(path.sep) ? candidate : `${candidate}${path.sep}`))!;
    while (entry !== root) { chain.add(entry); entry = path.dirname(entry); }
    chain.add(root);
  }
  return { roots: minimalRoots.sort(), chain };
}

async function dependencySnapshot(files: ReadonlySet<string>): Promise<Snapshot> {
  return Promise.all([...files].map(async (file) => {
    try { return { path: file, sha256: await fingerprint(file) }; }
    catch { return { path: file, sha256: null }; }
  }));
}

export class PreviewSession {
  requestedRevision = 0;
  runningRevision = 0;
  displayedRevision = 0;
  lastGood?: RenderResult;
  error?: RenderError;

  private readonly options: SessionOptions;
  private readonly basePaths: Set<string>;
  private watchedPaths: Set<string>;
  private watcher?: FSWatcher;
  private watchRoots: string[] = [];
  private readonly watchers = new Set<FSWatcher>();
  private watchWork: Promise<void> = Promise.resolve();
  private startWork?: Promise<void>;
  private closeWork?: Promise<void>;
  private closed = false;
  private readonly lifetime = new AbortController();
  private timer?: NodeJS.Timeout;
  private controller?: AbortController;
  private renderWork?: Promise<void>;
  private errorSnapshot?: Snapshot;
  private readonly waiters = new Set<() => void>();
  private readonly exports = new Set<Promise<ExportResult>>();

  constructor(options: SessionOptions) {
    const cwd = path.resolve(options.cwd);
    this.options = {
      ...options, cwd,
      sourcePath: path.resolve(cwd, options.sourcePath),
      globalThemePath: path.resolve(cwd, options.globalThemePath),
      ...(options.configPath ? { configPath: path.resolve(cwd, options.configPath) } : {}),
    };
    this.basePaths = new Set([
      this.options.sourcePath,
      this.options.globalThemePath,
      path.join(cwd, 'theme.toml'),
      ...(this.options.configPath ? [this.options.configPath] : []),
    ]);
    this.watchedPaths = new Set(this.basePaths);
  }

  start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Preview session is closed'));
    this.startWork ??= this.startSession();
    return this.startWork;
  }

  private async startSession(): Promise<void> {
    this.requestRevision(false);
    try { await this.updateWatches(this.watchedPaths); }
    catch (error) { this.reportError(error); }
    if (!this.closed && !this.error) this.beginRender();
  }

  currentUpdate(): PreviewUpdate {
    if (this.error) return {
      revision: this.requestedRevision, status: 'error', message: this.error.message,
      ...(this.error.source ? { source: this.error.source } : {}),
    };
    if (this.lastGood && this.displayedRevision === this.requestedRevision) {
      return { revision: this.displayedRevision, pdf: this.lastGood.pdf };
    }
    return { revision: this.requestedRevision, status: 'rendering' };
  }

  private announce(): void {
    this.options.publish(this.currentUpdate());
    for (const notify of this.waiters) notify();
    this.waiters.clear();
  }

  private requestRevision(debounce = true): void {
    if (this.closed) return;
    this.requestedRevision++;
    this.error = undefined;
    this.errorSnapshot = undefined;
    this.controller?.abort();
    clearTimeout(this.timer);
    this.timer = undefined;
    this.announce();
    if (debounce) this.timer = setTimeout(() => {
      this.timer = undefined;
      this.beginRender();
    }, debounceMs);
  }

  private invalidateImmediately(): void {
    this.requestRevision(false);
    this.beginRender();
  }

  private beginRender(): void {
    if (this.closed || this.renderWork || this.timer || this.displayedRevision === this.requestedRevision) return;
    const revision = this.requestedRevision;
    const controller = new AbortController();
    this.controller = controller;
    this.runningRevision = revision;
    const work = this.renderRevision(revision, controller);
    this.renderWork = work;
    void work.finally(() => {
      if (this.renderWork !== work) return;
      this.renderWork = undefined;
      this.runningRevision = 0;
      this.controller = undefined;
      if (!this.closed && revision !== this.requestedRevision && !this.timer) this.beginRender();
    });
  }

  private async renderRevision(revision: number, controller: AbortController): Promise<void> {
    const current = () => !this.closed && revision === this.requestedRevision && !controller.signal.aborted;
    try {
      // The Electron-only renderer cannot be imported in a plain Node test process.
      // Session boundary tests supply the renderer without loading Electron.
      const render = this.options.render ?? (await import('../render/pdf.js')).renderDocument;
      if (!current()) return;
      const result = await render(this.options.sourcePath, {
        cwd: this.options.cwd,
        globalThemePath: this.options.globalThemePath,
        ...(this.options.configPath ? { configPath: this.options.configPath } : {}),
        signal: controller.signal,
      });
      if (!current()) return;
      const files = new Set([...this.basePaths, ...result.dependencies, ...result.snapshot.map((entry) => entry.path)].map((file) => path.resolve(this.options.cwd, file)));
      await this.updateWatches(files);
      if (!current()) return;
      if (!await snapshotMatches(result.snapshot)) {
        if (current()) this.invalidateImmediately();
        return;
      }
      if (!current()) return;
      this.lastGood = result;
      this.displayedRevision = revision;
      this.error = undefined;
      this.announce();
    } catch (error) {
      if (!current()) return;
      const failure = this.asRenderError(error);
      const files = new Set([...this.watchedPaths, ...failure.dependencies].map((file) => path.resolve(this.options.cwd, file)));
      const newlyDiscovered = [...files].some((file) => !this.watchedPaths.has(file));
      try { await this.updateWatches(files); }
      catch (watchError) {
        if (current()) this.reportError(watchError);
        return;
      }
      if (!current()) return;
      // A newly discovered asset may have been repaired before its watch existed.
      // Read once again with the new watches installed instead of losing that edit.
      if (newlyDiscovered) {
        this.invalidateImmediately();
        return;
      }
      const failureSnapshot = await dependencySnapshot(files);
      if (!current()) return;
      this.errorSnapshot = failureSnapshot;
      this.error = failure;
      this.announce();
    }
  }

  private asRenderError(error: unknown): RenderError {
    return error instanceof RenderError ? error : new RenderError(
      error instanceof Error ? error.message : String(error), [...this.watchedPaths], undefined, { cause: error },
    );
  }

  private reportError(error: unknown): void {
    if (this.closed) return;
    this.error = this.asRenderError(error);
    this.controller?.abort();
    clearTimeout(this.timer);
    this.timer = undefined;
    this.announce();
  }

  private updateWatches(files: Set<string>, refresh = false): Promise<void> {
    const work = this.watchWork.then(async () => {
      if (this.closed) return;
      const sameFiles = files.size === this.watchedPaths.size && [...files].every((file) => this.watchedPaths.has(file));
      if (this.watcher && sameFiles && !refresh) return;
      const plan = await watchPlan(files);
      if (this.closed) return;
      if (this.watcher && sameFiles && plan.roots.join('\0') === this.watchRoots.join('\0')) return;
      const watcher = chokidar.watch(plan.roots, {
        persistent: true, ignoreInitial: true, atomic: true,
        ignored: (file) => !plan.chain.has(path.resolve(file)),
      });
      this.watchers.add(watcher);
      watcher.on('error', (error) => this.reportError(error));
      watcher.on('all', (event, file) => {
        if (this.closed || !plan.chain.has(path.resolve(file))) return;
        this.requestRevision();
        if (event === 'addDir' || event === 'unlinkDir') {
          void this.updateWatches(this.watchedPaths, true).catch((error) => this.reportError(error));
        }
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            watcher.removeListener('ready', onReady);
            watcher.removeListener('error', onError);
            this.lifetime.signal.removeEventListener('abort', onClose);
          };
          const onReady = () => { cleanup(); resolve(); };
          const onError = (error: unknown) => { cleanup(); reject(error); };
          const onClose = () => { cleanup(); reject(new Error('Preview session is closed')); };
          watcher.once('ready', onReady);
          watcher.once('error', onError);
          this.lifetime.signal.addEventListener('abort', onClose, { once: true });
          if (this.closed) onClose();
        });
      } catch (error) {
        await watcher.close();
        this.watchers.delete(watcher);
        throw error;
      }
      if (this.closed) { await watcher.close(); this.watchers.delete(watcher); return; }
      const previous = this.watcher;
      this.watcher = watcher;
      this.watchedPaths = files;
      this.watchRoots = plan.roots;
      if (previous) { await previous.close(); this.watchers.delete(previous); }
    });
    // Keep later directory-repair work runnable after an earlier watch failure.
    this.watchWork = work.catch(() => {});
    return work;
  }

  exportLatest(destination: string): Promise<ExportResult> {
    const work = this.exportRevision(path.resolve(this.options.cwd, destination));
    this.exports.add(work);
    void work.finally(() => this.exports.delete(work));
    return work;
  }

  private async exportRevision(destination: string): Promise<ExportResult> {
    try {
      await this.start();
      const write = this.options.write ?? writePdfAtomically;
      for (;;) {
        if (this.closed) return { status: 'error', message: 'Preview session is closed' };
        // Editors can write after the save dialog closes but before Chokidar delivers.
        const beforeCheck = this.requestedRevision;
        const snapshot = this.error ? this.errorSnapshot
          : this.displayedRevision === beforeCheck ? this.lastGood?.snapshot : undefined;
        if (snapshot && !await snapshotMatches(snapshot) && beforeCheck === this.requestedRevision) {
          this.invalidateImmediately();
        }
        while (!this.closed && !this.error && this.displayedRevision !== this.requestedRevision) {
          await new Promise<void>((resolve) => this.waiters.add(resolve));
        }
        if (this.closed) return { status: 'error', message: 'Preview session is closed' };
        if (this.error) return { status: 'error', message: this.error.message };
        const result = this.lastGood;
        const revision = this.displayedRevision;
        if (!result || revision !== this.requestedRevision) continue;
        if (!await snapshotMatches(result.snapshot)) { this.invalidateImmediately(); continue; }
        if (revision !== this.requestedRevision) continue;
        await validateOutputPath(destination, [...this.watchedPaths, ...result.dependencies, ...result.snapshot.map((entry) => entry.path)]);
        try {
          await write(destination, result.pdf, async () => {
            if (this.closed || revision !== this.requestedRevision || result !== this.lastGood) return false;
            const matches = await snapshotMatches(result.snapshot);
            if (this.closed || revision !== this.requestedRevision || result !== this.lastGood) return false;
            if (!matches) { this.invalidateImmediately(); return false; }
            return true;
          });
          return { status: 'saved', path: destination };
        } catch (error) {
          if (error instanceof OutputInvalidated) continue;
          throw error;
        }
      }
    } catch (error) {
      return { status: 'error', message: error instanceof Error ? error.message : String(error) };
    }
  }

  close(): Promise<void> {
    this.closeWork ??= this.closeSession();
    return this.closeWork;
  }

  private async closeSession(): Promise<void> {
    this.closed = true;
    this.lifetime.abort();
    clearTimeout(this.timer);
    this.timer = undefined;
    this.controller?.abort();
    for (const notify of this.waiters) notify();
    this.waiters.clear();
    await Promise.all([...this.watchers].map((watcher) => watcher.close()));
    await this.watchWork;
    await this.renderWork;
    await Promise.all(this.exports);
    this.watchers.clear();
    clearMathCache();
  }
}
