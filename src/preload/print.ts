import { contextBridge, ipcRenderer } from 'electron';
import type { PrintModel } from '../render/model.js';
import type { SourceLocation } from '../shared/types.js';
export type LayoutResult={ok:true}|{ok:false;message:string;source?:SourceLocation};
export type ValidationRequest={id:number;pdf:Uint8Array};
export type ValidationResult={id:number;ok:true}|{id:number;ok:false;message:string};
export type PrintBridge={getModel():Promise<PrintModel>;complete(result:LayoutResult):void;onValidate(callback:(request:ValidationRequest)=>Promise<void>):()=>void;validated(result:ValidationResult):void};
const bridge:PrintBridge={
 getModel:()=>ipcRenderer.invoke('docm:print:model'),
 complete:result=>ipcRenderer.send('docm:print:complete',result),
 onValidate:callback=>{const listener=(_event:Electron.IpcRendererEvent,request:ValidationRequest)=>{void callback(request);};ipcRenderer.on('docm:print:validate',listener);return()=>ipcRenderer.removeListener('docm:print:validate',listener);},
 validated:result=>ipcRenderer.send('docm:print:validated',result)
};
contextBridge.exposeInMainWorld('docmPrint',bridge);
declare global{interface Window{docmPrint:PrintBridge}}
