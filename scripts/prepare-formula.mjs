import {createHash} from 'node:crypto';
import {createReadStream,createWriteStream} from 'node:fs';
import {chmod,copyFile,lstat,mkdir,mkdtemp,readFile,readdir,readlink,realpath,rename,rm,symlink,utimes,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {pipeline} from 'node:stream/promises';
import {fileURLToPath} from 'node:url';
import {createGzip} from 'node:zlib';

export const root=path.resolve(import.meta.dirname,'..');
export const pins={node:'26.10.0',pnpm:'12.10.1'};
const inputs=path.join(root,'.build','formula-inputs');
const sourceDirectories=['src','tests','scripts','bin'];
const sourceNames=['package.json','pnpm-lock.yaml','pnpm-workspace.yaml','mise.toml','tsconfig.json','electron.vite.config.ts','README.md','LLM_README.md'];
const forbidden=new Set(['.build','dist','out','node_modules','.git']);

export function run(executable,args,{cwd=root,env=process.env,capture=false}={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,args,{cwd,env,stdio:capture?['ignore','pipe','pipe']:['ignore','inherit','inherit']});
    const stdout=[],stderr=[];
    if(capture){child.stdout.on('data',chunk=>stdout.push(chunk));child.stderr.on('data',chunk=>stderr.push(chunk));}
    child.once('error',reject);
    child.once('close',code=>code===0?resolve(Buffer.concat(stdout).toString().trim()):reject(new Error(`${executable} ${args.join(' ')} exited ${code}${capture?`: ${Buffer.concat(stderr).toString().trim()}`:''}`)));
  });
}

export const digest=value=>createHash('sha256').update(value).digest('hex');
export async function fileDigest(file){
  const hash=createHash('sha256');
  for await(const chunk of createReadStream(file))hash.update(chunk);
  return hash.digest('hex');
}
export function inside(parent,child){
  const relative=path.relative(parent,child);
  return relative===''||(!relative.startsWith(`..${path.sep}`)&&relative!=='..'&&!path.isAbsolute(relative));
}
async function exists(file){
  try{await lstat(file);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}
}

export async function discoverTools(cwd=root){
  const env={...process.env,MISE_AUTO_INSTALL:'false'};
  const mise=process.env.DOCM_FORMULA_MISE||'mise';
  const miseDataDir=process.env.MISE_DATA_DIR||JSON.parse(await run(mise,['doctor','--json'],{cwd,env,capture:true})).dirs?.data;
  if(!miseDataDir||!path.isAbsolute(miseDataDir)||!(await lstat(await realpath(miseDataDir))).isDirectory())throw new Error('An existing mise data directory is required');
  const tools={};
  for(const [name,version] of Object.entries(pins)){
    const executable=await run(mise,['which',name],{cwd,env,capture:true});
    if(!path.isAbsolute(executable)||!inside(await realpath(miseDataDir),await realpath(executable)))throw new Error(`${name} must already exist in the selected mise data directory`);
    const actual=await run(executable,['--version'],{cwd,env,capture:true});
    if(actual.replace(/^v/,'')!==version)throw new Error(`Expected existing ${name} ${version}, found ${actual}`);
    tools[name]=executable;
  }
  if(process.platform!=='darwin'||process.arch!=='arm64')throw new Error('Formula preparation/build requires native macOS arm64');
  return {...tools,mise,miseDataDir};
}

export async function lockedElectron(project=root){
  const lock=await readFile(path.join(project,'pnpm-lock.yaml'),'utf8');
  const importer=lock.split(/^packages:\s*$/m)[0];
  const match=importer.match(/^      electron:\n        specifier: [^\n]+\n        version: (\d+\.\d+\.\d+)(?:\([^\n]*\))?\s*$/m);
  if(!match)throw new Error('The frozen lockfile must identify one exact Electron dependency');
  if(/(?:^|\s)(?:file:|link:|workspace:)|^\s+directory:/m.test(lock))throw new Error('Local/host-path lockfile dependencies cannot be archived as formula inputs');
  return match[1];
}

// All archive links must remain inside the resource after relocation, including
// their final resolved target. Framework version symlinks are preserved.
export async function tree(directory){
  const base=await realpath(directory),entries=[];
  if((await lstat(directory)).isSymbolicLink())throw new Error(`Archive root cannot be a symlink: ${directory}`);
  async function visit(relative){
    const file=path.join(directory,relative),info=await lstat(file);
    if(info.isSymbolicLink()){
      const target=await readlink(file);
      if(path.isAbsolute(target)||!inside(directory,path.resolve(path.dirname(file),target))||!inside(base,await realpath(file)))throw new Error(`Unsafe archive symlink: ${file} -> ${target}`);
      entries.push({name:relative,type:'link',target,mode:0o777});
    }else if(info.isDirectory()){
      entries.push({name:relative,type:'directory',mode:0o755});
      for(const name of (await readdir(file)).sort())await visit(path.join(relative,name));
    }else if(info.isFile())entries.push({name:relative,type:'file',mode:info.mode&0o111?0o755:0o644,sha256:await fileDigest(file)});
    else throw new Error(`Unsupported archive entry: ${file}`);
  }
  await visit('');
  return entries;
}

export async function validateElectron(directory,version){
  if((await readFile(path.join(directory,'version'),'utf8')).trim()!==version)throw new Error(`Electron resource must be exactly ${version}`);
  for(const license of ['LICENSE','LICENSES.chromium.html'])if(!(await lstat(path.join(directory,license))).isFile())throw new Error(`Electron runtime is missing ${license}`);
  const executable=path.join(directory,'Electron.app','Contents','MacOS','Electron');
  const framework=path.join(directory,'Electron.app','Contents','Frameworks','Electron Framework.framework','Electron Framework');
  for(const binary of [executable,framework]){
    const architectures=await run('/usr/bin/lipo',['-archs',binary],{capture:true});
    if(architectures!=='arm64')throw new Error(`Expected arm64-only upstream Electron binary: ${binary} (${architectures})`);
  }
  const actual=await run('/usr/libexec/PlistBuddy',['-c','Print :CFBundleShortVersionString',path.join(directory,'Electron.app','Contents','Info.plist')],{capture:true});
  if(actual!==version)throw new Error(`Electron bundle version ${actual} does not match frozen ${version}`);
}

async function copyEntries(from,to,entries){
  for(const entry of entries){
    const source=path.join(from,entry.name),destination=path.join(to,entry.name);
    if(entry.type==='directory')await mkdir(destination,{recursive:true,mode:0o755});
    else if(entry.type==='link')await symlink(entry.target,destination);
    else {await copyFile(source,destination);await chmod(destination,entry.mode);}
  }
  for(const entry of [...entries].reverse())if(entry.type!=='link')await utimes(path.join(to,entry.name),0,0);
}

async function archive(directory,name,label){
  const entries=await tree(directory),identity=digest(JSON.stringify(entries));
  const destination=path.join(inputs,`${label}-${identity}.tar.gz`),receipt=`${destination}.json`;
  if(await exists(destination)){
    const recorded=JSON.parse(await readFile(receipt,'utf8'));
    if(recorded.treeSha256!==identity||recorded.sha256!==await fileDigest(destination))throw new Error(`Frozen archive was modified: ${destination}`);
    return {archive:destination,sha256:recorded.sha256};
  }
  const stage=await mkdtemp(path.join(inputs,'.archive-'));
  try{
    await copyEntries(directory,path.join(stage,name),entries);
    const list=path.join(stage,'entries');
    await writeFile(list,entries.map(entry=>path.posix.join(name,entry.name)).join('\0')+'\0');
    const tar=path.join(stage,'archive.tar'),compressed=path.join(stage,'archive.tar.gz');
    await run('/usr/bin/tar',['-c','--format','pax','--no-xattrs','--no-acls','--no-fflags','--uid','0','--gid','0','--uname','root','--gname','wheel','--no-recursion','-f',tar,'-C',stage,'--null','-T',list]);
    await pipeline(createReadStream(tar),createGzip({level:9}),createWriteStream(compressed,{flags:'wx'}));
    const sha256=await fileDigest(compressed);
    await rename(compressed,destination);
    await writeFile(receipt,JSON.stringify({schema:1,treeSha256:identity,sha256})+'\n',{flag:'wx'});
    return {archive:destination,sha256};
  }finally{await rm(stage,{recursive:true,force:true});}
}

async function sourceSnapshot(stage,version){
  const selected=[],names=[...sourceNames];
  if(await exists(path.join(root,'LICENSE')))names.push('LICENSE');
  for(const name of names){
    const file=path.join(root,name),info=await lstat(file);
    if(!info.isFile()||info.isSymbolicLink())throw new Error(`Source input must be an actual file: ${name}`);
    selected.push({name,type:'file',mode:info.mode&0o111?0o755:0o644,sha256:await fileDigest(file)});
  }
  for(const directory of sourceDirectories){
    for(const entry of await tree(path.join(root,directory))){
      const name=path.join(directory,entry.name);
      if(name.split(path.sep).some(segment=>forbidden.has(segment)||segment.endsWith('.app')))throw new Error(`Generated output cannot be part of source: ${name}`);
      if(entry.type==='link')throw new Error(`Source snapshot must contain actual files, not symlinks: ${name}`);
      selected.push({...entry,name});
    }
  }
  selected.sort((left,right)=>left.name<right.name?-1:left.name>right.name?1:0);
  const directory=path.join(stage,`docm-${version}`);
  await mkdir(directory);
  await copyEntries(root,directory,selected);
  return {directory,sourceFiles:selected.filter(entry=>entry.type==='file').map(entry=>entry.name)};
}

async function storeResource(stage,tools){
  const lock=await readFile(path.join(root,'pnpm-lock.yaml'));
  const workspace=await readFile(path.join(root,'pnpm-workspace.yaml'));
  const metadata={schema:1,lockSha256:digest(lock),workspaceSha256:digest(workspace),...pins,platform:'darwin',arch:'arm64'};
  // A helper change can alter acquisition semantics even if the lock is unchanged.
  const key=digest(JSON.stringify(metadata)+await fileDigest(fileURLToPath(import.meta.url)));
  const receipt=path.join(inputs,`store-${key}.json`);
  if(await exists(receipt)){
    const result=JSON.parse(await readFile(receipt,'utf8'));
    if(!inside(inputs,result.archive)||result.sha256!==await fileDigest(result.archive))throw new Error('Frozen pnpm resource was modified');
    return result;
  }
  const fetch=path.join(stage,'fetch'),store=path.join(stage,'store');
  await mkdir(fetch);await mkdir(store);
  for(const name of ['package.json','pnpm-lock.yaml','pnpm-workspace.yaml'])await copyFile(path.join(root,name),path.join(fetch,name));
  const config=path.join(stage,'empty.npmrc');await writeFile(config,'');
  // A fresh metadata cache carries pnpm's supply-chain policy inputs alongside
  // package content, without copying any unrelated user cache or credentials.
  const cache=path.join(store,'.docm-pnpm-cache');
  await run(tools.pnpm,['fetch','--ignore-scripts','--ignore-pnpmfile','--store-dir',store,`--config.cache-dir=${cache}`,'--config.side-effects-cache=false','--config.manage-package-manager-versions=false','--config.package-manager-strict=false','--userconfig',config],{cwd:fetch,env:{...process.env,CI:'1',MISE_AUTO_INSTALL:'false',npm_config_ignore_scripts:'true'}});
  if(!lock.equals(await readFile(path.join(fetch,'pnpm-lock.yaml'))))throw new Error('pnpm fetch changed the frozen lockfile');
  // pnpm's project registry points to the fetch staging directory. It is local
  // cache bookkeeping, not package content; never ship those host-path links.
  await rm(path.join(store,'v11','projects'),{recursive:true,force:true});
  await writeFile(path.join(store,'.docm-store.json'),JSON.stringify(metadata,null,2)+'\n');
  const result=await archive(store,'store','pnpm-store');
  await writeFile(receipt,JSON.stringify(result)+'\n',{flag:'wx'});
  return result;
}

export async function prepare(){
  const tools=await discoverTools();
  const metadata=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
  if(metadata.name!=='docm'||metadata.version!=='0.1.0')throw new Error('Expected docm version 0.1.0');
  const version=await lockedElectron();
  const electronPackage=await realpath(path.join(root,'node_modules','electron'));
  const electronMetadata=JSON.parse(await readFile(path.join(electronPackage,'package.json'),'utf8'));
  if(electronMetadata.name!=='electron'||electronMetadata.version!==version)throw new Error('Installed Electron package does not match the frozen lockfile');
  const electronDist=path.join(electronPackage,'dist');
  await validateElectron(electronDist,version);
  await mkdir(inputs,{recursive:true});
  const stage=await mkdtemp(path.join(inputs,'.prepare-'));
  try{
    const pnpm=await storeResource(stage,tools);
    const electron=path.join(stage,'electron');
    await copyEntries(electronDist,electron,await tree(electronDist));
    await writeFile(path.join(electron,'.docm-electron.json'),JSON.stringify({schema:1,name:'electron',version,platform:'darwin',arch:'arm64',upstream:'https://github.com/electron/electron',package:electronMetadata},null,2)+'\n');
    const runtime=await archive(electron,'electron',`electron-${version}-darwin-arm64`);
    const source=await sourceSnapshot(stage,metadata.version);
    const sourceArchive=await archive(source.directory,`docm-${metadata.version}`,`docm-${metadata.version}-source`);
    const manifest={schema:1,project:root,version:metadata.version,source:sourceArchive,resources:[{name:'pnpm-store',...pnpm},{name:'electron',...runtime}],tools:{...pins,miseDataDir:tools.miseDataDir},sourceFiles:source.sourceFiles};
    const destination=path.join(inputs,'manifest.json'),bytes=JSON.stringify(manifest,null,2)+'\n';
    if(!await exists(destination)||await readFile(destination,'utf8')!==bytes){
      await writeFile(path.join(stage,'manifest.json'),bytes);
      await rename(path.join(stage,'manifest.json'),destination);
    }
    console.error(`Prepared frozen source/formula resources: ${destination}`);
    return manifest;
  }finally{await rm(stage,{recursive:true,force:true});}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await prepare();
