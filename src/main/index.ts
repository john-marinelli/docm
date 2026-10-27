import { app, BrowserWindow, dialog, ipcMain, Menu, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { CommanderError } from 'commander';
import { spawn } from 'node:child_process';
import { Console } from 'node:console';
import os from 'node:os';
import path from 'node:path';
import { parseCliArgs, type CliRequest } from './cli.js';
import { defaultOutputPath, validateOutputPath, writePdfAtomically } from './output.js';
import { PreviewSession } from './session.js';
import { installProtocol, lockWindow, rendererUrl } from './protocol.js';
import { closePrintWindows, renderDocument } from '../render/pdf.js';
import { clearMathCache } from '../render/math.js';
import { RenderError } from '../shared/errors.js';
import type { ExportResult, PreviewUpdate } from '../shared/types.js';

// Stdout belongs exclusively to `r -o -`, including in dependency code.
console = new Console({ stdout: process.stderr, stderr: process.stderr });
app.commandLine.appendSwitch('enable-logging', 'stderr');
const invocationCwd = process.cwd();
const xdgConfigHome = process.env.XDG_CONFIG_HOME;
const configDirectory = process.platform === 'linux'
  ? xdgConfigHome && path.isAbsolute(xdgConfigHome) ? xdgConfigHome : path.join(os.homedir(), '.config')
  : path.join(os.homedir(), 'Library', 'Application Support');
const globalThemePath = path.join(configDirectory, 'docm', 'theme.toml');
const nativeArguments = process.argv.slice(process.defaultApp ? 2 : 1);
const markerIndex = nativeArguments.indexOf('--cli');
const separatorIndex = nativeArguments.indexOf('--');
const attached = markerIndex >= 0 && (separatorIndex < 0 || markerIndex < separatorIndex);
const arguments_ = attached ? nativeArguments.slice(markerIndex + 1) : nativeArguments;
let request: CliRequest | undefined;
let parseExit: number | undefined;
try {
  if (attached || arguments_.length) request = parseCliArgs(arguments_);
} catch (error) {
  if (error instanceof CommanderError) parseExit = error.exitCode;
  else { console.error(error instanceof Error ? error.message : String(error)); parseExit = 2; }
}
if (process.platform === 'darwin' && (request?.mode === 'render' || parseExit !== undefined)) app.setActivationPolicy('prohibited');
// Printing uses a hidden window, which otherwise needs an X11/Wayland display.
if (process.platform === 'linux' && request?.mode === 'render' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
  app.commandLine.appendSwitch('ozone-platform', 'headless');
}

// Finder delivers documents as events, not arguments. The first one received
// before launch is decided becomes this instance's document; later ones each
// get their own process, like separate terminal invocations.
let launchDocument: string | undefined;
let launchDecided = false;
app.on('open-file', (event, file) => {
  event.preventDefault();
  if (!launchDecided && !request) { launchDocument ??= file; return; }
  spawn(process.execPath, [file], { detached: true, stdio: 'ignore' }).unref();
});

let previewWindow: BrowserWindow | undefined;
let previewSession: PreviewSession | undefined;
const renderController = new AbortController();
let renderWork: Promise<unknown> | undefined;
let stopping: Promise<void> | undefined;
let exitCode = 0;

async function shutdown(code: number): Promise<void> {
  if (code !== 0) exitCode = code;
  if (stopping) return stopping;
  stopping = (async () => {
    renderController.abort();
    closePrintWindows();
    try {
      await previewSession?.close();
      await renderWork?.catch(() => {});
    } catch (error) {
      console.error('Cannot finish shutdown:', error instanceof Error ? error.message : String(error));
      if (exitCode === 0) exitCode = 1;
    } finally {
      clearMathCache();
      ipcMain.removeHandler('docm:preview:export');
      ipcMain.removeAllListeners('docm:preview:ready');
      if (previewWindow && !previewWindow.isDestroyed()) previewWindow.destroy();
      app.exit(exitCode);
    }
  })();
  return stopping;
}
// A writable may emit its error after invoking its failed write callback.
// Keep a process-lifetime listener so an EPIPE can never become unhandled.
process.stdout.on('error', error => {
  console.error(`Cannot write PDF to stdout: ${error.message}`);
  void shutdown(1);
});
app.on('before-quit', event => { event.preventDefault(); void shutdown(0); });
app.on('window-all-closed', () => { if (previewWindow) void shutdown(0); });

async function writeStdout(bytes: Uint8Array): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => { process.stdout.removeListener('error', onError); reject(error); };
    process.stdout.on('error', onError);
    process.stdout.write(bytes, error => {
      if (error) { onError(error); return; }
      process.stdout.end(() => { process.stdout.removeListener('error', onError); resolve(); });
    });
  });
}

async function openPreview(sourcePath: string, cwd: string, configPath?: string): Promise<void> {
  const window = new BrowserWindow({
    title: `${path.basename(sourcePath)} — docm`, width: 1100, height: 900, minWidth: 640, minHeight: 480, show: false,
    webPreferences: { preload: path.resolve(import.meta.dirname, '../preload/index.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
  });
  previewWindow = window;
  lockWindow(window, true);
  window.webContents.on('console-message', (_event, ...details) => console.error('[preview]', ...details));
  window.webContents.on('render-process-gone', (_event, details) => {
    if (!stopping) { console.error(`Preview renderer exited: ${details.reason}`); void shutdown(1); }
  });
  window.on('close', event => { event.preventDefault(); void shutdown(0); });
  const pageUrl = rendererUrl('preview');
  const authorized = (event: IpcMainEvent | IpcMainInvokeEvent) => !window.isDestroyed()
    && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame
    && event.senderFrame.url === pageUrl;
  let subscribed = false;
  const publish = (update: PreviewUpdate) => {
    if (subscribed && !window.isDestroyed()) window.webContents.send('docm:preview:update', update);
  };
  const session = new PreviewSession({ sourcePath, cwd, globalThemePath, ...(configPath !== undefined ? { configPath } : {}), publish });
  previewSession = session;
  ipcMain.on('docm:preview:ready', (event: IpcMainEvent) => {
    if (!authorized(event)) return;
    subscribed = true;
    publish(session.currentUpdate());
  });
  let exporting: Promise<ExportResult> | undefined;
  ipcMain.handle('docm:preview:export', (event: IpcMainInvokeEvent) => {
    if (!authorized(event)) throw new Error('Unauthorized preview sender');
    if (stopping) return { status: 'error', message: 'The preview is closing' } satisfies ExportResult;
    if (exporting) return exporting;
    exporting = (async (): Promise<ExportResult> => {
      try {
        const result = await dialog.showSaveDialog(window, {
          title: 'Export PDF', buttonLabel: 'Export', defaultPath: defaultOutputPath(sourcePath),
          filters: [{ name: 'PDF document', extensions: ['pdf'] }], properties: ['showOverwriteConfirmation'],
        });
        if (result.canceled || !result.filePath || stopping) return { status: 'cancelled' };
        return await session.exportLatest(result.filePath);
      } catch (error) { return { status: 'error', message: error instanceof Error ? error.message : String(error) }; }
      finally { exporting = undefined; }
    })();
    return exporting;
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    process.platform === 'darwin' ? { role: 'appMenu' } : { label: 'File', submenu: [{ role: 'quit' }] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { role: 'windowMenu' },
  ]));
  window.webContents.on('did-finish-load', () => {
    void window.webContents.executeJavaScript(`document.title = ${JSON.stringify(path.basename(sourcePath))}`).catch(error => console.error('Cannot set preview title:', error));
  });
  await Promise.all([session.start(), window.loadURL(pageUrl)]);
  if (!stopping && !window.isDestroyed()) window.show();
}

async function run(): Promise<void> {
  if (stopping) return;
  // Electron installs native quit handlers after evaluating the entry module.
  // Register after readiness so Node receives the signal and preserves CLI exit codes.
  process.on('SIGINT', () => { void shutdown(130); });
  process.on('SIGTERM', () => { void shutdown(143); });
  if (parseExit !== undefined) { await shutdown(parseExit); return; }
  await installProtocol();
  if (stopping) return;
  launchDecided = true;
  if (!request) {
    let sourcePath = launchDocument;
    if (sourcePath === undefined) {
      const selected = await dialog.showOpenDialog({ title: 'Open Markdown', properties: ['openFile'], filters: [{ name: 'Markdown documents', extensions: ['md', 'markdown', 'mdown', 'mkd'] }] });
      if (stopping) return;
      if (selected.canceled || !selected.filePaths[0]) { await shutdown(0); return; }
      sourcePath = selected.filePaths[0];
    }
    await openPreview(sourcePath, path.dirname(sourcePath));
    return;
  }
  const invocation = request;
  const sourcePath = path.resolve(invocationCwd, invocation.sourcePath);
  const configPath = invocation.configPath !== undefined ? path.resolve(invocationCwd, invocation.configPath) : undefined;
  // A desktop launch (Linux .desktop `%f`) has no meaningful working directory:
  // discover themes beside the document, as the Markdown picker does.
  if (invocation.mode === 'preview') { await openPreview(sourcePath, attached ? invocationCwd : path.dirname(sourcePath), configPath); return; }
  const rendering = renderDocument(sourcePath, { cwd: invocationCwd, globalThemePath, ...(configPath !== undefined ? { configPath } : {}), signal: renderController.signal });
  renderWork = rendering;
  const rendered = await rendering;
  if (stopping) return;
  const writing = (async () => {
    if (invocation.outputPath === '-') await writeStdout(rendered.pdf);
    else {
      const destination = invocation.outputPath !== undefined ? path.resolve(invocationCwd, invocation.outputPath) : defaultOutputPath(sourcePath);
      await validateOutputPath(destination, [sourcePath, ...(configPath !== undefined ? [configPath] : []), ...rendered.dependencies]);
      if (stopping) return;
      await writePdfAtomically(destination, rendered.pdf);
    }
  })();
  renderWork = writing;
  await writing;
  await shutdown(0);
}

// Electron's ESM readiness waits on entry-module evaluation: never await it at top level.
void app.whenReady().then(run).catch(async error => {
  if (stopping) return;
  const diagnostic = error instanceof RenderError && error.source
    ? `${error.source.path}:${error.source.line}:${error.source.column}: ${error.message}`
    : error instanceof Error ? error.message : String(error);
  console.error(diagnostic);
  await shutdown(1);
});
