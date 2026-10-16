import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,realpath,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {verifyRelease} from './release.mjs';
import {root,run} from './prepare-formula.mjs';
import {smokeSource,verifyPackagedCli} from './source-smoke.mjs';

export async function smokeRelease(directory){
  const manifest=await verifyRelease(directory);
  const local=asset=>({...asset,archive:path.join(directory,asset.filename)});
  const inputs={version:manifest.version,tools:manifest.tools,source:local(manifest.assets.find(asset=>asset.name==='source')),resources:manifest.assets.filter(asset=>asset.name!=='source').map(local)};
  return smokeSource(inputs,{artifacts:path.join(root,'.build','release-smoke')});
}
export async function smokeHomebrew(directory){
  // This command intentionally installs/uninstalls a formula. Never run it against
  // a developer's existing Homebrew installation as an incidental local check.
  if(process.env.GITHUB_ACTIONS!=='true')throw new Error('Homebrew release installation checks require a disposable GitHub Actions runner');
  const manifest=await verifyRelease(directory);
  if(manifest.repository!==process.env.GITHUB_REPOSITORY)throw new Error('Release repository does not match this workflow');
  const env={...process.env,HOMEBREW_NO_AUTO_UPDATE:'1',HOMEBREW_NO_INSTALL_CLEANUP:'1'};
  const installedNames=await run('brew',['list','--formula','--versions'],{env,capture:true});
  if(installedNames.split(/\r?\n/).some(line=>/^(?:\S+\/)?docm\s/.test(line)))throw new Error('Refusing to replace a preexisting docm installation');
  const tap='docm/release-ci',formula=`${tap}/docm`;
  if((await run('brew',['tap'],{env,capture:true})).split(/\r?\n/).includes(tap))throw new Error(`Refusing to replace preexisting tap ${tap}`);
  const stage=await realpath(await mkdtemp(path.join(tmpdir(),'docm public homebrew ')));
  const artifacts=path.join(root,'.build','release-homebrew');await mkdir(artifacts,{recursive:true});
  let tapped=false,installed=false;
  try{
    const repository=path.join(stage,'tap');await mkdir(path.join(repository,'Formula'),{recursive:true});
    await writeFile(path.join(repository,'Formula','docm.rb'),await readFile(path.join(directory,'docm.rb')));
    await run('git',['init','--initial-branch=main',repository],{env});
    await run('git',['-C',repository,'add','Formula/docm.rb'],{env});
    await run('git',['-C',repository,'-c','user.name=docm release CI','-c','user.email=release-ci@users.noreply.github.com','commit','-m',`Verify ${manifest.tag}`],{env});
    await run('brew',['tap',tap,pathToFileURL(repository).href],{env});tapped=true;
    await run('brew',['install','--formula','--build-from-source',formula],{env});installed=true;
    const prefix=await run('brew',['--prefix',formula],{env,capture:true});
    const runtime=await verifyPackagedCli(path.join(prefix,'libexec','Docm.app'),{stage,artifacts,version:manifest.version});
    await run('brew',['uninstall','--formula',formula],{env});installed=false;
    await assert.rejects(stat(path.join(prefix,'libexec','Docm.app')),error=>error.code==='ENOENT');
    const report={tag:manifest.tag,commit:manifest.commit,checks:{publicAssetFormula:true,normalHomebrewSandbox:true,installedCli:true,packageVersion:true,pdfContents:true,uninstalled:true},...runtime};
    await writeFile(path.join(artifacts,'report.json'),JSON.stringify(report,null,2)+'\n');console.error(JSON.stringify(report,null,2));return report;
  }finally{
    try{if(installed)await run('brew',['uninstall','--formula',formula],{env});}
    finally{try{if(tapped)await run('brew',['untap',tap],{env});}finally{await rm(stage,{recursive:true,force:true});}}
  }
}
async function main(){
  const {values,positionals}=parseArgs({allowPositionals:true,options:{directory:{type:'string',default:'.build/release'}}});
  if(positionals.length!==1||!['source','homebrew'].includes(positionals[0]))throw new Error('Usage: mise run release:smoke | release:homebrew [--directory DIR]');
  const directory=path.resolve(values.directory);
  if(positionals[0]==='source')await smokeRelease(directory);else await smokeHomebrew(directory);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
