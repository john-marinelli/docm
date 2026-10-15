import { app, protocol, session, shell, type BrowserWindow } from 'electron';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

protocol.registerSchemesAsPrivileged([{scheme:'docm',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}]);
const mime:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.woff2':'font/woff2','.woff':'font/woff','.ttf':'font/ttf','.otf':'font/otf','.svg':'image/svg+xml','.png':'image/png','.json':'application/json'};
const csp="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'";
let installed=false;
export async function installProtocol(rendererRoot=path.resolve(import.meta.dirname,'../renderer')):Promise<void> {
  if(installed)return;
  const allowed=new Map<string,string>();
  async function collect(directory:string,prefix:string):Promise<void>{
    for(const entry of await readdir(directory,{withFileTypes:true})){
      if(entry.isSymbolicLink())continue;
      const file=path.join(directory,entry.name),name=prefix+entry.name;
      if(entry.isDirectory())await collect(file,`${name}/`);
      else if(entry.isFile() && mime[path.extname(entry.name)])allowed.set(name,file);
    }
  }
  await collect(rendererRoot,'');
  protocol.handle('docm',async request=>{
    try{
      const url=new URL(request.url),name=decodeURIComponent(url.pathname).slice(1);
      if(url.hostname!=='bundle' || url.search || url.hash || name.includes('\\') || name.split('/').some(part=>part==='..'||part==='.') || !allowed.has(name))return new Response('Not found',{status:404});
      const bytes=await readFile(allowed.get(name)!);
      return new Response(bytes,{headers:{'content-type':mime[path.extname(name)],'content-security-policy':csp,'x-content-type-options':'nosniff'}});
    }catch{return new Response('Not found',{status:404});}
  });
  session.defaultSession.setPermissionRequestHandler((_webContents,_permission,callback)=>callback(false));
  session.defaultSession.setPermissionCheckHandler(()=>false);
  session.defaultSession.webRequest.onBeforeRequest((details,callback)=>{
    const url=new URL(details.url);
    const dev=process.env.ELECTRON_RENDERER_URL;
    const allowedDev=!app.isPackaged && dev && url.origin===new URL(dev).origin;
    callback({cancel:!(['docm:','data:','blob:','devtools:'].includes(url.protocol)||allowedDev)});
  });
  installed=true;
}
export function lockWindow(window:BrowserWindow,externalLinks=false):void {
  const open=(url:string)=>{
    try{if(externalLinks && ['http:','https:','mailto:'].includes(new URL(url).protocol))void shell.openExternal(url).catch(error=>console.error(`Cannot open link: ${error.message}`));}catch{}
  };
  window.webContents.setWindowOpenHandler(({url})=>{open(url);return {action:'deny'};});
  window.webContents.on('will-navigate',(event,url)=>{event.preventDefault();open(url);});
  window.webContents.on('will-attach-webview',event=>event.preventDefault());
}
export function rendererUrl(page:'print'|'preview'):string {
  const dev=process.env.ELECTRON_RENDERER_URL;
  return !app.isPackaged && dev ? `${dev}/${page}/index.html` : `docm://bundle/${page}/index.html`;
}
