import { BrowserWindow, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import { loadConfig } from '../config/load.js';
import { RenderError } from '../shared/errors.js';
import type { RenderResult } from '../shared/types.js';
import type { PrintModel } from './model.js';
import type { LayoutResult, ValidationResult } from '../preload/print.js';
import { prepareMarkdown } from './markdown.js';
import { documentCss } from './styles.js';
import { loadAssets, snapshotMatches } from './assets.js';
import { renderMath } from './math.js';
import { lockWindow, rendererUrl } from '../main/protocol.js';
const windows=new Set<BrowserWindow>();
let printQueue:Promise<void>=Promise.resolve();
export function closePrintWindows():void{for(const window of windows)if(!window.isDestroyed())window.destroy();windows.clear();}
export async function renderDocument(sourcePath:string,options:{cwd:string;globalThemePath:string;configPath?:string;signal:AbortSignal}):Promise<RenderResult>{
 const absoluteSource=path.resolve(options.cwd,sourcePath);
 const dependencies=new Set<string>([absoluteSource,path.resolve(options.cwd,options.globalThemePath),path.join(options.cwd,'theme.toml'),...(options.configPath?[path.resolve(options.cwd,options.configPath)]:[])]);
 const abort=()=>{if(options.signal.aborted)throw new DOMException('Rendering aborted','AbortError');};
 const prior=printQueue;const {promise:queued,resolve:release}=Promise.withResolvers<void>();printQueue=queued;await prior;
 let window:BrowserWindow|undefined;
 let cleanup=()=>{};
 try{
  abort();
  const loaded=await loadConfig(sourcePath,options);for(const file of loaded.dependencies)dependencies.add(file);
  const markdown=await prepareMarkdown(loaded.markdown,{sourcePath:absoluteSource,lineOffset:loaded.lineOffset,config:loaded.config});abort();
  const assets=await loadAssets(markdown,loaded.config,absoluteSource,dependencies,loaded.snapshot);abort();
  const math=markdown.math.length ? await renderMath(markdown.math,loaded.config.math,{signal:options.signal}) : [];abort();
  if(Number(process.versions.chrome.split('.')[0])<131)throw new Error('PDF page decorations require Chromium 131 or newer');
  const model:PrintModel={markdown,config:loaded.config,filename:path.basename(sourcePath),css:documentCss(loaded.config),...assets,math};
  window=new BrowserWindow({show:false,width:1000,height:1200,webPreferences:{preload:path.resolve(import.meta.dirname,'../preload/print.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,backgroundThrottling:false}});windows.add(window);lockWindow(window);
  const current=window;
  const authorized=(event:IpcMainEvent|IpcMainInvokeEvent)=>event.sender===current.webContents && event.senderFrame===current.webContents.mainFrame;
  const {promise:layout,resolve:resolveLayout}=Promise.withResolvers<LayoutResult>();
  const {promise:validated,resolve:resolveValidation}=Promise.withResolvers<ValidationResult>();
  const onComplete=(event:IpcMainEvent,result:LayoutResult)=>{if(authorized(event) && result && typeof result.ok==='boolean')resolveLayout(result);};
  const onValidated=(event:IpcMainEvent,result:ValidationResult)=>{if(authorized(event) && result?.id===1 && typeof result.ok==='boolean')resolveValidation(result);};
  ipcMain.handle('docm:print:model',event=>{if(!authorized(event))throw new Error('Unauthorized print sender');return model;});
  ipcMain.on('docm:print:complete',onComplete);ipcMain.on('docm:print:validated',onValidated);
  const {promise:failure,reject:rejectFailure}=Promise.withResolvers<never>();
  const timeout=setTimeout(()=>rejectFailure(new Error('Print renderer timed out after 60 seconds')),60_000);
  const onAbort=()=>{rejectFailure(new DOMException('Rendering aborted','AbortError'));if(!current.isDestroyed())current.destroy();};options.signal.addEventListener('abort',onAbort,{once:true});
  const onGone=()=>rejectFailure(new Error('Print renderer exited before PDF completion'));
  current.webContents.on('render-process-gone',onGone);
  current.webContents.on('console-message',(_event,...args)=>console.error('[print]',...args));
  cleanup=()=>{clearTimeout(timeout);options.signal.removeEventListener('abort',onAbort);ipcMain.removeHandler('docm:print:model');ipcMain.removeListener('docm:print:complete',onComplete);ipcMain.removeListener('docm:print:validated',onValidated);};
  await Promise.race([current.loadURL(rendererUrl('print')),failure]);
  const response=await Promise.race([layout,failure]);if(!response.ok)throw new RenderError(response.message,[...dependencies],response.source);
  abort();
  const pdf=await Promise.race([current.webContents.printToPDF({printBackground:true,preferCSSPageSize:true,generateTaggedPDF:true,generateDocumentOutline:true,margins:{top:0,bottom:0,left:0,right:0},displayHeaderFooter:false}),failure]);
  current.webContents.send('docm:print:validate',{id:1,pdf:new Uint8Array(pdf)});
  const validation=await Promise.race([validated,failure]);if(!validation.ok)throw new Error(validation.message);
  abort();if(!await snapshotMatches(loaded.snapshot))throw new RenderError('Source or dependency changed during rendering; waiting for the latest revision',[...dependencies]);
  return {pdf,dependencies:[...dependencies],snapshot:loaded.snapshot};
 }catch(error){
  if(error instanceof DOMException && error.name==='AbortError')throw error;
  if(error instanceof RenderError){error.dependencies=[...new Set([...dependencies,...error.dependencies])];throw error;}
  throw new RenderError(error instanceof Error?error.message:String(error),[...dependencies],undefined,{cause:error});
 }finally{cleanup();if(window){windows.delete(window);if(!window.isDestroyed())window.destroy();}release();}
}
