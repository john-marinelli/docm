import {chmod,lstat,readdir} from 'node:fs/promises';
import path from 'node:path';

// Permit the packager to replace read-only directories in its own prior output.
// Never change source resources or anything outside the generated output tree.
export default async function beforePack(context){
  const relative=path.relative(context.packager.projectDir,context.appOutDir);
  if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw new Error('Package output must stay inside the project');
  async function writable(directory){
    let info;try{info=await lstat(directory);}catch(error){if(error.code==='ENOENT')return;throw error;}
    if(info.isSymbolicLink())throw new Error(`Refusing symlink packaging directory: ${directory}`);
    if(!info.isDirectory())return;
    await chmod(directory,(info.mode&0o777)|0o700);
    for(const entry of await readdir(directory,{withFileTypes:true}))if(entry.isDirectory()&&!entry.isSymbolicLink())await writable(path.join(directory,entry.name));
  }
  await writable(context.appOutDir);
}
