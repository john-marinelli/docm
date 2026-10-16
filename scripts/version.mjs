import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const repoRoot=fileURLToPath(new URL('../',import.meta.url));
const stableVersion=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?![\s\S])/;

function components(version){
  if(typeof version!=='string'||!stableVersion.test(version))throw new Error('Package version must be stable SemVer (X.Y.Z without leading zeros)');
  const parts=version.split('.').map(Number);
  if(parts.some(part=>!Number.isSafeInteger(part)))throw new Error('Package version components exceed the safe integer range');
  return parts;
}

// Locate the top-level value in the original JSON so a bump never reformats or
// rewrites unrelated package metadata, including its indentation and line endings.
function versionRange(text){
  let depth=0;
  const ranges=[];
  for(let index=0;index<text.length;index++){
    const character=text[index];
    if(character==='{'||character==='['){depth++;continue;}
    if(character==='}'||character===']'){depth--;continue;}
    if(character!=='"')continue;
    const start=index;
    for(index++;index<text.length;index++){
      if(text[index]==='\\'){index++;continue;}
      if(text[index]==='"')break;
    }
    if(depth!==1||JSON.parse(text.slice(start,index+1))!=='version')continue;
    let cursor=index+1;
    while(/\s/.test(text[cursor]??'')&&cursor<text.length)cursor++;
    if(text[cursor]!==':')continue;
    cursor++;
    while(/\s/.test(text[cursor]??'')&&cursor<text.length)cursor++;
    const valueStart=cursor;
    if(text[cursor]!=='"')throw new Error('Package version must be a string');
    for(cursor++;cursor<text.length;cursor++){
      if(text[cursor]==='\\'){cursor++;continue;}
      if(text[cursor]==='"')break;
    }
    ranges.push([valueStart,cursor+1]);
  }
  if(ranges.length!==1)throw new Error('package.json must contain exactly one top-level version field');
  return ranges[0];
}

async function packageVersion(projectRoot){
  const file=path.join(projectRoot,'package.json');
  const text=await readFile(file,'utf8');
  const metadata=JSON.parse(text);
  components(metadata?.version);
  const range=versionRange(text);
  return {file,text,range,version:metadata.version};
}

export async function readVersion(projectRoot=repoRoot){
  return (await packageVersion(projectRoot)).version;
}

export function validateTag(tag,version){
  components(version);
  if(tag!==`v${version}`)throw new Error(`Release tag must be exactly v${version}; received ${String(tag)}`);
}

export async function bumpVersion(kind,projectRoot=repoRoot){
  if(!['patch','minor','major'].includes(kind))throw new Error('Version bump must be patch, minor, or major');
  const {file,text,range,version}=await packageVersion(projectRoot);
  const parts=components(version);
  const index={major:0,minor:1,patch:2}[kind];
  if(parts[index]===Number.MAX_SAFE_INTEGER)throw new Error('Version bump would exceed the safe integer range');
  parts[index]++;
  for(let cursor=index+1;cursor<parts.length;cursor++)parts[cursor]=0;
  const next=parts.join('.');
  await writeFile(file,text.slice(0,range[0])+JSON.stringify(next)+text.slice(range[1]));
  return next;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const [command,argument,...extra]=process.argv.slice(2);
    if(extra.length||!argument||!['bump','check-tag'].includes(command))throw new Error('Usage: node scripts/version.mjs bump patch|minor|major OR check-tag vX.Y.Z');
    if(command==='bump')console.log(await bumpVersion(argument));
    else{const version=await readVersion();validateTag(argument,version);console.log(version);}
  }catch(error){console.error(error.message);process.exitCode=1;}
}
