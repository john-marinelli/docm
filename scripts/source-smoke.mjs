import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {constants,createWriteStream} from 'node:fs';
import {access,chmod,mkdir,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {discoverTools,fileDigest,root,run} from './prepare-formula.mjs';
import {hostPlatform,launcherRelative,packageDirectory,platformKey,pnpmResourceUrl} from './platform.mjs';

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
export async function verifyPackagedCli(bundle,{stage,artifacts,version,platform=hostPlatform()}){
  assert.deepEqual(platform,hostPlatform(),'Packaged verification requires a native supported target');
  await mkdir(artifacts,{recursive:true});
  const home=path.join(stage,'runtime-home');await mkdir(home);
  const env=isolatedEnvironment(home,'/usr/bin:/bin:/usr/sbin:/sbin');
  if(platform.os==='darwin')await run('/usr/bin/codesign',['--verify','--deep','--strict',bundle],{env});
  const executable=path.join(bundle,launcherRelative(platform));
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
async function stagePnpmResource(inputs,stage,env){
  const resource=inputs.toolResources?.find(item=>item.name==='pnpm');
  assert(resource,'Smoke builds require the pinned pnpm resource');
  assert.equal(resource.url,pnpmResourceUrl(inputs.tools.pnpm,inputs.platform));
  const archive=path.join(stage,'pnpm-resource.tgz');
  const response=await fetch(resource.url);
  if(!response.ok||!response.body)throw new Error(`Cannot fetch pinned pnpm resource: HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body),createWriteStream(archive,{flags:'wx'}));
  assert.equal(await fileDigest(archive),resource.sha256,'Pinned pnpm resource checksum mismatch');
  const destination=path.join(stage,'.formula-pnpm');await mkdir(destination);
  await run('/usr/bin/tar',['-xf',archive,'--strip-components','1','-C',destination],{env});
  const metadata=JSON.parse(await readFile(path.join(destination,'package.json'),'utf8'));
  assert.equal(metadata.name,`@pnpm/exe.${platformKey(inputs.platform)}`);
  assert.equal(metadata.version,inputs.tools.pnpm);
  const executable=path.join(destination,'pnpm');await chmod(executable,0o755);
  assert.equal(await run(executable,['--version'],{cwd:stage,env,capture:true}),inputs.tools.pnpm);
  return executable;
}
export async function smokeSource(inputs,{artifacts=path.join(root,'.build','build-smoke')}={}){
  const platform=hostPlatform();
  assert.deepEqual(inputs.platform,platform,'Source verification requires frozen inputs for the native platform');
  const tools=await discoverTools();
  const stage=await realpath(await mkdtemp(path.join(tmpdir(),'docm node pnpm build ')));
  try{
    const home=path.join(stage,'home');await mkdir(home);
    const bootstrapPath=[path.dirname(tools.node),'/usr/bin','/bin','/usr/sbin','/sbin'].join(path.delimiter);
    tools.pnpm=await stagePnpmResource(inputs,stage,isolatedEnvironment(home,bootstrapPath));
    const buildPath=[...new Set([path.dirname(tools.node),path.dirname(tools.pnpm),'/usr/bin','/bin','/usr/sbin','/sbin'])].join(path.delimiter);
    for(const directory of buildPath.split(path.delimiter))await assert.rejects(access(path.join(directory,'mise'),constants.X_OK),error=>error.code==='ENOENT');
    const env=isolatedEnvironment(home,buildPath);
    // Exercise electron-builder's PR signing gate even on local and main-branch runs.
    env.GITHUB_BASE_REF||='main';
    await run('/usr/bin/tar',['-xf',inputs.source.archive,'-C',stage],{env});
    const source=path.join(stage,`docm-${inputs.version}`);
    for(const [name,directory] of [['pnpm-store','.formula-store'],['electron','.formula-electron']]){
      const resource=inputs.resources.find(item=>item.name===name);assert(resource,`Missing ${name} resource`);
      const destination=path.join(source,directory);await mkdir(destination);
      await run('/usr/bin/tar',['-xf',resource.archive,'--strip-components','1','-C',destination],{env});
    }
    env.DOCM_FORMULA_STORE=path.join(source,'.formula-store');env.DOCM_FORMULA_ELECTRON=path.join(source,'.formula-electron');
    console.error(`Building clean source with the checksummed pnpm resource, pinned Node, and ${platform.os==='darwin'?'macOS':'Linux'} system tools on PATH`);
    await run(tools.pnpm,['run','formula:build'],{cwd:source,env});
    const result=await verifyPackagedCli(path.join(source,packageDirectory(platform)),{stage,artifacts,version:inputs.version,platform});
    const report={platform,tools:inputs.tools,source:inputs.source.sha256,buildPath,pnpmResource:inputs.toolResources.find(item=>item.name==='pnpm'),checks:{pnpmResourceExecuted:true,miseAbsentFromBuildPath:true,freshHome:true,cleanSourceBuild:true,...(platform.os==='darwin'?{pullRequestSigning:true,deepSignature:true}:{}),packagedCliWithoutDeveloperTools:true,packageVersion:true,pdfContents:true},...result};
    await writeFile(path.join(artifacts,'report.json'),JSON.stringify(report,null,2)+'\n');console.error(JSON.stringify(report,null,2));return report;
  }finally{await rm(stage,{recursive:true,force:true});}
}
