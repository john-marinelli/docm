import {constants} from 'node:fs';
import {copyFile,lstat,mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {fileDigest,prepare,root} from './prepare-formula.mjs';
import {hostPlatform,nodeResourceUrl,platformKey,pnpmResourceUrl} from './platform.mjs';
import {renderFormula} from './formula.mjs';
import {readVersion,validateTag} from './version.mjs';

const assetNames=['source','pnpm-store','electron'];
const platformKeys=['darwin-arm64','linux-x64'];
const metadataNames=['release-manifest.json','docm.rb'];
const validHash=value=>typeof value==='string'&&/^[a-f0-9]{64}(?![\s\S])/.test(value);
const json=value=>JSON.stringify(value,null,2)+'\n';
function exact(value,keys,label){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==[...keys].sort().join(','))throw new Error(`Invalid ${label} fields`);
}
export function validateRepository(repository){
  if(typeof repository!=='string'||!repository.split('/').every(part=>/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?(?![\s\S])/.test(part))||repository.split('/').length!==2)throw new Error('Repository must be an OWNER/REPO GitHub name');
  return repository;
}
function validateIdentity({tag,version,repository,commit}){
  validateTag(tag,version);
  validateRepository(repository);
  if(typeof commit!=='string'||!(/^[a-f0-9]{40}(?![\s\S])/).test(commit))throw new Error('Release commit must be a full 40-character lowercase hexadecimal commit');
}
function filename(name,version,platform){return `docm-${version}-${name}-${platformKey(platform)}.tar.gz`;}
function validateManifest(manifest){
  exact(manifest,['schema','name','version','tag','repository','commit','tools','platforms'],'release manifest');
  if(manifest.schema!==2||manifest.name!=='docm')throw new Error('Unsupported release manifest schema/name');
  validateIdentity(manifest);
  exact(manifest.tools,['node','pnpm'],'tools');
  for(const version of Object.values(manifest.tools))validateTag(`v${version}`,version);
  if(!Array.isArray(manifest.platforms)||manifest.platforms.length<1||manifest.platforms.length>2)throw new Error('Release requires one or two supported platforms');
  let previous=-1;
  for(const target of manifest.platforms){
    exact(target,['os','arch','assets','toolResources'],'release platform');
    const index=platformKeys.indexOf(platformKey(target));
    if(index<0||index<=previous)throw new Error('Release platforms must be unique and in darwin-arm64, linux-x64 order');
    previous=index;
    if(!Array.isArray(target.assets)||target.assets.length!==3||target.assets.map(item=>item?.name).join(',')!==assetNames.join(','))throw new Error('Release requires exactly source, pnpm-store and electron assets in order');
    for(const asset of target.assets){
      exact(asset,['name','filename','sha256'],'asset');
      if(asset.filename!==filename(asset.name,manifest.version,target)||!validHash(asset.sha256))throw new Error(`Invalid asset filename/checksum: ${asset.name}`);
    }
    const urls={node:nodeResourceUrl(manifest.tools.node,target),pnpm:pnpmResourceUrl(manifest.tools.pnpm,target)};
    if(!Array.isArray(target.toolResources)||target.toolResources.length!==2||target.toolResources.map(item=>item?.name).join(',')!=='node,pnpm')throw new Error('Release requires exactly official node and pnpm resources in order');
    for(const resource of target.toolResources){
      exact(resource,['name','url','sha256'],'tool resource');
      if(resource.url!==urls[resource.name]||!validHash(resource.sha256))throw new Error(`Invalid official tool resource: ${resource.name}`);
    }
  }
  return manifest;
}
export function releasePlatform(manifest,platform=hostPlatform()){
  validateManifest(manifest);
  const key=platformKey(platform),target=manifest.platforms.find(item=>platformKey(item)===key);
  if(!target)throw new Error(`Release does not contain native platform ${key}`);
  return target;
}
export function releaseFormula(manifest,{assetDirectory}={}){
  validateManifest(manifest);
  const base=`https://github.com/${manifest.repository}/releases/download/${manifest.tag}/`;
  const targets=manifest.platforms.map(target=>{
    const [source,...assets]=target.assets.map(asset=>({name:asset.name,url:assetDirectory?pathToFileURL(path.join(assetDirectory,asset.filename)).href:base+asset.filename,sha256:asset.sha256}));
    return {platform:{os:target.os,arch:target.arch},source,resources:[...assets,...target.toolResources]};
  });
  return renderFormula({version:manifest.version,homepage:`https://github.com/${manifest.repository}`,targets,receipt:manifest});
}
async function regular(file){
  const info=await lstat(file);
  if(!info.isFile()||info.isSymbolicLink()||info.size===0)throw new Error(`Release input must be a nonempty regular file: ${file}`);
  return info;
}
function releaseFiles(manifest){return [...manifest.platforms.flatMap(target=>target.assets.map(asset=>asset.filename)),...metadataNames];}
async function checksums(directory,files){
  const lines=[];
  for(const name of files){await regular(path.join(directory,name));lines.push(`${await fileDigest(path.join(directory,name))}  ${name}\n`);}
  return lines.join('');
}
async function outputDirectory(output){
  const destination=path.resolve(output);
  await mkdir(destination,{recursive:true});
  const info=await lstat(destination);
  if(!info.isDirectory()||info.isSymbolicLink())throw new Error('Release output must be an actual directory');
  if((await readdir(destination)).length)throw new Error(`Release output is not empty: ${destination}; use --output with a fresh directory`);
  return destination;
}
async function copyAsset(source,destination,asset){
  const original=await regular(source);
  await copyFile(source,path.join(destination,asset.filename),constants.COPYFILE_EXCL);
  const copied=path.join(destination,asset.filename);
  if((await regular(copied)).size!==original.size||await fileDigest(copied)!==asset.sha256)throw new Error(`Release asset changed while copying: ${asset.filename}`);
}
async function writeMetadata(destination,manifest){
  await writeFile(path.join(destination,'release-manifest.json'),json(manifest),{flag:'wx'});
  await writeFile(path.join(destination,'docm.rb'),releaseFormula(manifest),{flag:'wx'});
  await writeFile(path.join(destination,'SHA256SUMS'),await checksums(destination,releaseFiles(manifest)),{flag:'wx'});
}

// Verify frozen inputs at the consumer boundary before creating any release output.
export async function assembleRelease(frozen,{tag,commit,repository,output=path.join(root,'.build','release')}){
  validateIdentity({tag,commit,repository,version:frozen.version});
  exact(frozen.platform,['os','arch'],'frozen platform');
  platformKey(frozen.platform);
  if(!Array.isArray(frozen.resources)||frozen.resources.length!==2||frozen.resources.map(item=>item?.name).sort().join(',')!=='electron,pnpm-store')throw new Error('Frozen inputs require electron and pnpm-store');
  const originals=[frozen.source,...['pnpm-store','electron'].map(name=>frozen.resources.find(item=>item.name===name))];
  const manifest=validateManifest({schema:2,name:'docm',version:frozen.version,tag,repository,commit,tools:{...frozen.tools},platforms:[{...frozen.platform,assets:assetNames.map((name,index)=>({name,filename:filename(name,frozen.version,frozen.platform),sha256:originals[index]?.sha256})),toolResources:frozen.toolResources?.map(item=>({...item}))}]});
  for(const item of originals){
    if(typeof item?.archive!=='string'||!path.isAbsolute(item.archive))throw new Error('Frozen asset requires an absolute archive path');
    await regular(item.archive);
    if(await fileDigest(item.archive)!==item.sha256)throw new Error(`Frozen asset checksum differs: ${item.archive}`);
  }
  const destination=await outputDirectory(output);
  for(const [index,asset] of manifest.platforms[0].assets.entries())await copyAsset(originals[index].archive,destination,asset);
  await writeMetadata(destination,manifest);
  return manifest;
}

export async function prepareRelease({tag,commit,repository,output}={}){
  validateIdentity({tag,commit,repository,version:await readVersion()});
  return assembleRelease(await prepare(),{tag,commit,repository,output});
}

export async function verifyRelease(directory){
  const destination=path.resolve(directory);
  const info=await lstat(destination);
  if(!info.isDirectory()||info.isSymbolicLink())throw new Error('Release must be an actual directory');
  await regular(path.join(destination,'release-manifest.json'));
  const manifest=validateManifest(JSON.parse(await readFile(path.join(destination,'release-manifest.json'),'utf8')));
  const files=releaseFiles(manifest);
  if((await readdir(destination)).sort().join(',')!==[...files,'SHA256SUMS'].sort().join(','))throw new Error('Release directory contains missing or unexpected files');
  await regular(path.join(destination,'SHA256SUMS'));
  if(await readFile(path.join(destination,'SHA256SUMS'),'utf8')!==await checksums(destination,files))throw new Error('Release SHA256SUMS mismatch');
  for(const target of manifest.platforms)for(const asset of target.assets)if(await fileDigest(path.join(destination,asset.filename))!==asset.sha256)throw new Error(`Release asset checksum mismatch: ${asset.filename}`);
  if(await readFile(path.join(destination,'docm.rb'),'utf8')!==releaseFormula(manifest))throw new Error('Release formula does not match manifest');
  return manifest;
}

export async function mergeReleases(directories,{output=path.join(root,'.build','release')}={}){
  if(!Array.isArray(directories)||directories.length!==2)throw new Error('Merge requires exactly two native release candidates');
  const inputs=[];
  for(const directory of directories)inputs.push({directory:path.resolve(directory),manifest:await verifyRelease(directory)});
  const first=inputs[0].manifest;
  for(const {manifest} of inputs){
    if(manifest.platforms.length!==1)throw new Error('Merge inputs must each contain one native platform');
    for(const key of ['name','version','tag','repository','commit'])if(manifest[key]!==first[key])throw new Error(`Release candidates have mismatched ${key}`);
    for(const tool of ['node','pnpm'])if(manifest.tools[tool]!==first.tools[tool])throw new Error(`Release candidates have mismatched tools: ${tool}`);
  }
  inputs.sort((a,b)=>platformKeys.indexOf(platformKey(a.manifest.platforms[0]))-platformKeys.indexOf(platformKey(b.manifest.platforms[0])));
  const targets=inputs.map(input=>{
    const {os,arch,assets,toolResources}=input.manifest.platforms[0];
    return {os,arch,assets:assets.map(({name,filename,sha256})=>({name,filename,sha256})),toolResources:toolResources.map(({name,url,sha256})=>({name,url,sha256}))};
  });
  const manifest=validateManifest({schema:2,name:first.name,version:first.version,tag:first.tag,repository:first.repository,commit:first.commit,tools:{node:first.tools.node,pnpm:first.tools.pnpm},platforms:targets});
  const destination=await outputDirectory(output);
  for(const input of inputs)for(const asset of input.manifest.platforms[0].assets)await copyAsset(path.join(input.directory,asset.filename),destination,asset);
  await writeMetadata(destination,manifest);
  return manifest;
}

async function main(){
  const [command,...args]=process.argv.slice(2),options={},directories=[];
  if(!['prepare','merge'].includes(command))throw new Error('Usage: node scripts/release.mjs prepare --tag vX.Y.Z --commit FULL40HEX --repository OWNER/REPO [--output DIR] | merge --output DIR CANDIDATE CANDIDATE');
  const flags=command==='prepare'?['--tag','--commit','--repository','--output']:['--output'];
  for(let index=0;index<args.length;index++){
    const flag=args[index];
    if(command==='merge'&&!flag.startsWith('--')){directories.push(flag);continue;}
    if(!flags.includes(flag)||!args[index+1]||args[index+1].startsWith('--')||Object.hasOwn(options,flag.slice(2)))throw new Error(`Invalid or repeated release option: ${flag}`);
    options[flag.slice(2)]=args[++index];
  }
  const manifest=command==='merge'?await mergeReleases(directories,options):await prepareRelease(options);
  console.error(`Prepared ${manifest.tag} in ${path.resolve(options.output??path.join(root,'.build','release'))}`);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{await main();}catch(error){console.error(error.message);process.exitCode=1;}
}
