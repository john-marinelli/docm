import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {constants} from 'node:fs';
import {access,mkdir,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {discoverTools,root,run} from './prepare-formula.mjs';

export function isolatedEnvironment(home,buildPath){
  const env={...process.env,HOME:home,PATH:buildPath,CI:'1',XDG_CONFIG_HOME:path.join(home,'.config'),XDG_CACHE_HOME:path.join(home,'.cache'),XDG_DATA_HOME:path.join(home,'.local','share')};
  for(const key of Object.keys(env))if(key.startsWith('MISE_')||key.startsWith('DOCM_FORMULA_')||['ELECTRON_RUN_AS_NODE','ELECTRON_OVERRIDE_DIST_PATH','ELECTRON_RENDERER_URL','ELECTRON_ENABLE_LOGGING','NODE_OPTIONS'].includes(key))delete env[key];
  return env;
}
function versionOutput(executable,env,cwd){
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,['--version'],{cwd,env,stdio:['ignore','pipe','pipe']});let output='';
    const timer=setTimeout(()=>child.kill('SIGKILL'),90_000);
    child.stdout.on('data',bytes=>output+=bytes);child.stderr.on('data',bytes=>output+=bytes);
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('close',(code,signal)=>{clearTimeout(timer);code===0?resolve(output):reject(new Error(`Packaged CLI version exited ${code??signal}: ${output}`));});
  });
}
export async function verifyPackagedCli(bundle,{stage,artifacts,version}){
  await mkdir(artifacts,{recursive:true});
  const home=path.join(stage,'runtime-home');await mkdir(home);
  const env=isolatedEnvironment(home,'/usr/bin:/bin:/usr/sbin:/sbin');
  await run('/usr/bin/codesign',['--verify','--deep','--strict',bundle],{env});
  const executable=path.join(bundle,'Contents','Resources','bin','docm');
  const output=await versionOutput(executable,env,stage);
  assert(output.split(/\r?\n/).includes(version),`CLI did not report package version ${version}: ${output}`);
  const markdown=path.join(stage,'build proof.md'),pdf=path.join(artifacts,'build-proof.pdf');
  await writeFile(markdown,'# Node and pnpm build\n\nBuilt without mise on PATH.\n\n$E = mc^2$\n');
  await run(executable,['r',markdown,'-o',pdf],{cwd:stage,env});
  const bytes=await readFile(pdf);assert.equal(bytes.subarray(0,5).toString(),'%PDF-');
  const loading=getDocument({data:new Uint8Array(bytes),isEvalSupported:false});let pages;
  try{
    const document=await loading.promise;pages=document.numPages;
    const text=await (await document.getPage(1)).getTextContent();
    const content=text.items.map(item=>'str'in item?item.str:'').join(' ');
    assert.match(content,/Node and pnpm build/);assert.match(content,/Built without mise on PATH\./);
  }finally{await loading.destroy();}
  return {pdf,pages,version};
}
export async function smokeSource(inputs,{artifacts=path.join(root,'.build','build-smoke')}={}){
  const tools=await discoverTools();
  const stage=await realpath(await mkdtemp(path.join(tmpdir(),'docm node pnpm build ')));
  try{
    const home=path.join(stage,'home');await mkdir(home);
    const buildPath=[...new Set([path.dirname(tools.node),path.dirname(tools.pnpm),'/usr/bin','/bin','/usr/sbin','/sbin'])].join(path.delimiter);
    for(const directory of buildPath.split(path.delimiter))await assert.rejects(access(path.join(directory,'mise'),constants.X_OK),error=>error.code==='ENOENT');
    const env=isolatedEnvironment(home,buildPath);
    await run('/usr/bin/tar',['-xf',inputs.source.archive,'-C',stage],{env});
    const source=path.join(stage,`docm-${inputs.version}`);
    for(const [name,directory] of [['pnpm-store','.formula-store'],['electron','.formula-electron']]){
      const resource=inputs.resources.find(item=>item.name===name);assert(resource,`Missing ${name} resource`);
      const destination=path.join(source,directory);await mkdir(destination);
      await run('/usr/bin/tar',['-xf',resource.archive,'--strip-components','1','-C',destination],{env});
    }
    env.DOCM_FORMULA_STORE=path.join(source,'.formula-store');env.DOCM_FORMULA_ELECTRON=path.join(source,'.formula-electron');
    console.error('Building clean source with only existing Node/pnpm and macOS system tools on PATH');
    await run(tools.pnpm,['run','formula:build'],{cwd:source,env});
    const result=await verifyPackagedCli(path.join(source,'dist','mac-arm64','Docm.app'),{stage,artifacts,version:inputs.version});
    const report={tools:inputs.tools,source:inputs.source.sha256,buildPath,checks:{miseAbsentFromBuildPath:true,freshHome:true,cleanSourceBuild:true,deepSignature:true,packagedCliWithoutDeveloperTools:true,packageVersion:true,pdfContents:true},...result};
    await writeFile(path.join(artifacts,'report.json'),JSON.stringify(report,null,2)+'\n');console.error(JSON.stringify(report,null,2));return report;
  }finally{await rm(stage,{recursive:true,force:true});}
}
