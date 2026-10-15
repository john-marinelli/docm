import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { RenderError } from '../shared/errors.js';
import type { Snapshot, SourceLocation } from '../shared/types.js';
import type { Config } from '../config/schema.js';
import type { ImageAsset, MarkdownModel, PrintModel } from './model.js';

export function localImagePath(url: string, sourcePath: string): string {
  if (/^[a-z][a-z\d+.-]*:/i.test(url) || url.startsWith('//') || url.includes('\0')) throw new Error('Images must be local filesystem paths; URL schemes are not allowed');
  let decoded: string;
  try { decoded = decodeURIComponent(url); } catch { throw new Error(`Invalid percent escape in image path: ${url}`); }
  return path.resolve(path.dirname(sourcePath), decoded);
}
export async function fingerprint(file: string): Promise<string | null> {
  try { return createHash('sha256').update(await readFile(file)).digest('hex'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
export async function snapshotMatches(snapshot: Snapshot): Promise<boolean> {
  for (const entry of snapshot) { try { if (await fingerprint(entry.path) !== entry.sha256) return false; } catch { return false; } }
  return true;
}
export async function loadAssets(model: MarkdownModel, config: Config, sourcePath: string, dependencies: Set<string>, snapshot: Snapshot): Promise<Pick<PrintModel,'images'|'logos'|'fonts'>> {
  const read = async (file: string, source?:SourceLocation) => {
    dependencies.add(file);
    try {
      const bytes=await readFile(file);
      snapshot.push({path:file,sha256:createHash('sha256').update(bytes).digest('hex')});
      return bytes;
    } catch(error) { throw new RenderError(`Cannot read asset ${file}: ${error instanceof Error ? error.message : error}`, [...dependencies],source,{cause:error}); }
  };
  const image = async (file:string,source?:SourceLocation):Promise<ImageAsset> => {
    const bytes=await read(file,source), extension=path.extname(file).toLowerCase();
    let mime:string|undefined;
    if (extension==='.png' && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) mime='image/png';
    if (['.jpg','.jpeg'].includes(extension) && bytes[0]===255 && bytes[1]===216 && bytes[2]===255) mime='image/jpeg';
    if (extension==='.gif' && /^GIF8[79]a$/.test(bytes.subarray(0,6).toString())) mime='image/gif';
    if (extension==='.webp' && bytes.subarray(0,4).toString()==='RIFF' && bytes.subarray(8,12).toString()==='WEBP') mime='image/webp';
    if (extension==='.svg') {
      let svg:string;
      try { svg=new TextDecoder('utf-8',{fatal:true}).decode(bytes); } catch(error) { throw new RenderError(`Invalid SVG UTF-8: ${file}`,[...dependencies],source,{cause:error}); }
      return {path:file,dataUrl:'',svg};
    }
    if (!mime) throw new RenderError(`Unsupported or corrupt image: ${file}`,[...dependencies],source);
    return {path:file,dataUrl:`data:${mime};base64,${bytes.toString('base64')}`};
  };
  const images:Record<string,ImageAsset>={},logos:Partial<Record<'header'|'footer',ImageAsset>>={},fonts:PrintModel['fonts']=[];
  for (const node of model.images) {
    let file:string;
    try { file=localImagePath(node.url,sourcePath); } catch(error) { throw new RenderError(String(error instanceof Error ? error.message : error),[...dependencies],node.source,{cause:error}); }
    images[node.id]=await image(file,node.source);
  }
  for (const slot of ['header','footer'] as const) { const logo=config[slot].logo; if (logo!==false) logos[slot]=await image(logo.path); }
  for (const [alias,file] of Object.entries(config.fonts)) {
    const bytes=await read(file), signature=bytes.subarray(0,4), label=signature.toString();
    if (!(signature.equals(Buffer.from([0,1,0,0])) || ['OTTO','true','typ1','wOFF','wOF2'].includes(label))) throw new RenderError(`Unsupported or corrupt font: ${file}`,[...dependencies]);
    const mime=label==='wOF2'?'font/woff2':label==='wOFF'?'font/woff':label==='OTTO'?'font/otf':'font/ttf';
    fonts.push({family:`docm-font-${alias}`,dataUrl:`data:${mime};base64,${bytes.toString('base64')}`,weight:400,style:'normal'});
  }
  return {images,logos,fonts};
}
