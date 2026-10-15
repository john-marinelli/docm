import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { PreviewBridge, PreviewUpdate } from '../shared/types.js';

const bridge: PreviewBridge = {
  onUpdate(callback) {
    if (typeof callback !== 'function') throw new TypeError('onUpdate requires a callback');
    const listener = (_event: IpcRendererEvent, update: PreviewUpdate) => callback(update);
    ipcRenderer.on('docm:preview:update', listener);
    // Subscribe before announcing readiness, so the initial PDF cannot race UI load.
    ipcRenderer.send('docm:preview:ready');
    return () => ipcRenderer.removeListener('docm:preview:update', listener);
  },
  exportPdf: () => ipcRenderer.invoke('docm:preview:export'),
};
contextBridge.exposeInMainWorld('docm', bridge);
