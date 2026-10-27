import {spawnSync} from 'node:child_process';
import {readdir} from 'node:fs/promises';
import path from 'node:path';

function tool(executable,args){
  const result=spawnSync(executable,args,{encoding:'utf8'});
  if(result.status!==0)throw new Error(`${executable} ${args.join(' ')} exited ${result.status}: ${result.stderr.trim()}`);
  return result.stdout;
}

// Homebrew preserves @rpath install IDs (`preserve_rpath`) but rewrites any
// others to absolute Cellar paths, invalidating the bundle signature. Normalize
// Electron's loader-relative dylib IDs here, before electron-builder signs.
export default async function afterPack(context){
  if(context.electronPlatformName!=='darwin')return;
  const frameworks=path.join(context.appOutDir,`${context.packager.appInfo.productFilename}.app`,'Contents','Frameworks');
  for(const entry of await readdir(frameworks,{recursive:true,withFileTypes:true})){
    if(!entry.isFile()||!entry.name.endsWith('.dylib'))continue;
    const library=path.join(entry.parentPath,entry.name);
    const id=tool('/usr/bin/otool',['-D',library]).split('\n')[1]?.trim();
    if(id?.startsWith('@rpath/'))continue;
    if(!id?.startsWith('@loader_path/'))throw new Error(`Unexpected upstream dylib ID: ${library}: ${id}`);
    tool('/usr/bin/install_name_tool',['-id',`@rpath/${path.posix.basename(id)}`,library]);
  }
}
