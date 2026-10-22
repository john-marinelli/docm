import {cp,lstat,mkdir,readFile,realpath,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {discoverTools,inside,lockedElectron,root,run,tree,validateElectron,validateElectronMetadata,validateStoreMetadata} from './prepare-formula.mjs';
import {hostPlatform,packageDirectory} from './platform.mjs';

async function absent(file){
  try{await lstat(file);}catch(error){if(error.code==='ENOENT')return;throw error;}
  throw new Error(`Formula builds require a clean source tree; refusing existing ${file}`);
}
async function resource(variable,name){
  const directory=process.env[variable],expected=path.join(root,name);
  if(!directory||path.resolve(directory)!==expected||(await lstat(directory)).isSymbolicLink()||!inside(await realpath(root),await realpath(directory)))throw new Error(`${variable} must identify the staged ${name} resource in this source tree`);
  await tree(directory);
  return directory;
}

const platform=hostPlatform();
// Never reuse a checkout's output, installed dependency tree, or a previous app.
for(const name of ['node_modules','out','dist'])await absent(path.join(root,name));
await absent(path.join(root,'.build','third-party-notices'));
const tools=await discoverTools();
const store=await resource('DOCM_FORMULA_STORE','.formula-store');
const electron=await resource('DOCM_FORMULA_ELECTRON','.formula-electron');
const storeMetadata=JSON.parse(await readFile(path.join(store,'.docm-store.json'),'utf8'));
const lock=await readFile(path.join(root,'pnpm-lock.yaml'));
const workspace=await readFile(path.join(root,'pnpm-workspace.yaml'));
validateStoreMetadata(storeMetadata,lock,workspace,platform);
const electronVersion=await lockedElectron();
const runtimeMetadata=JSON.parse(await readFile(path.join(electron,'.docm-electron.json'),'utf8'));
validateElectronMetadata(runtimeMetadata,electronVersion,platform);
await validateElectron(electron,electronVersion,platform);

const state=path.join(root,'.formula-build');
await mkdir(state,{recursive:true});
const npmrc=path.join(state,'empty.npmrc');await writeFile(npmrc,'');
const env={...process.env,CI:'1',ELECTRON_SKIP_BINARY_DOWNLOAD:'1',ELECTRON_BUILDER_CACHE:path.join(state,'electron-builder-cache'),npm_config_ignore_scripts:'true',npm_config_offline:'true'};
for(const key of Object.keys(env))if(key.startsWith('CSC_')||key.startsWith('APPLE_'))delete env[key];
delete env.ELECTRON_OVERRIDE_DIST_PATH;
delete env.ELECTRON_RUN_AS_NODE;
// Dependency tarballs (including native optional packages) come solely from the
// frozen resource. Lifecycle scripts cannot fetch Electron or any other binary.
await run(tools.pnpm,['install','--offline','--frozen-lockfile','--ignore-scripts','--ignore-pnpmfile','--store-dir',store,`--config.cache-dir=${path.join(store,'.docm-pnpm-cache')}`,'--config.side-effects-cache=false','--config.manage-package-manager-versions=false','--config.package-manager-strict=false','--userconfig',npmrc],{env});
const packageRoot=await realpath(path.join(root,'node_modules','electron'));
if(!inside(await realpath(path.join(root,'node_modules')),packageRoot))throw new Error('Installed Electron package escapes staged node_modules');
const packageMetadata=JSON.parse(await readFile(path.join(packageRoot,'package.json'),'utf8'));
if(packageMetadata.name!=='electron'||packageMetadata.version!==electronVersion)throw new Error('Offline dependency install produced the wrong Electron version');
const dist=path.join(packageRoot,'dist');
await absent(dist);
await cp(electron,dist,{recursive:true,dereference:false,verbatimSymlinks:true,filter:source=>path.basename(source)!=='.docm-electron.json'});
await writeFile(path.join(packageRoot,'path.txt'),platform.os==='darwin'?'Electron.app/Contents/MacOS/Electron':'electron');
await validateElectron(dist,electronVersion,platform);
// Homebrew preserves @rpath IDs, but otherwise rewrites them to long absolute
// Cellar paths. Normalize copied loader-relative IDs before packaging re-signs
// the bundle; dependency load commands and the upstream resource stay intact.
if(platform.os==='darwin'){
  for(const entry of await tree(dist)){
    if(entry.type!=='file'||!entry.name.endsWith('.dylib'))continue;
    const library=path.join(dist,entry.name);
    const id=(await run('/usr/bin/otool',['-D',library],{capture:true})).split('\n')[1]?.trim();
    if(id?.startsWith('@rpath/'))continue;
    if(!id?.startsWith('@loader_path/'))throw new Error(`Unexpected upstream dylib ID: ${library}: ${id}`);
    await run('/usr/bin/install_name_tool',['-id',`@rpath/${path.posix.basename(id)}`,library]);
  }
}
await run(tools.pnpm,['run','typecheck'],{env});
if(platform.os==='darwin'){
  // PR signing is enabled only here, without credentials and with ad-hoc identity forced.
  await run(tools.pnpm,['run','package','--config.mac.identity=-','--config.mac.notarize=false'],{env:{...env,CSC_IDENTITY_AUTO_DISCOVERY:'false',CSC_FOR_PULL_REQUEST:'true'}});
}else await run(tools.pnpm,['run','package:linux'],{env});
const output=packageDirectory(platform),app=path.join(root,output);
if(!(await lstat(app)).isDirectory()||(await lstat(app)).isSymbolicLink())throw new Error(`Source packaging did not produce ${output}`);
console.error(`Built docm from clean frozen source: ${app}`);
