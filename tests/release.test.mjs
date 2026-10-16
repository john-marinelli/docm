import {createHash} from 'node:crypto';
import {mkdir,readFile,readdir,rm,symlink,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {afterEach,expect,it} from 'vitest';
import {assembleRelease,prepareRelease,verifyRelease} from '../scripts/release.mjs';
import {readVersion} from '../scripts/version.mjs';
import {frozenReleaseFixture,releaseOptions as options} from './helpers/release-fixture.mjs';

const roots=[];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function fixture(){
  const result=await frozenReleaseFixture();roots.push(result.root);return result;
}
async function assembled(){
  const result=await fixture();
  result.manifest=await assembleRelease(result.frozen,{...options,output:result.output});
  return result;
}
async function rewriteChecksums(output){
  const manifest=JSON.parse(await readFile(path.join(output,'release-manifest.json'),'utf8'));
  const names=[...manifest.assets.map(asset=>asset.filename),'release-manifest.json','docm.rb'];
  const lines=[];
  for(const name of names)lines.push(`${hash(await readFile(path.join(output,name)))}  ${name}\n`);
  await writeFile(path.join(output,'SHA256SUMS'),lines.join(''));
}


it('refuses a nonempty output rather than overwriting a previous release',async()=>{
  const {frozen,output}=await assembled();
  const before=await readFile(path.join(output,'SHA256SUMS'));
  await expect(assembleRelease(frozen,{...options,output})).rejects.toThrow(/not empty.*--output/);
  expect(await readFile(path.join(output,'SHA256SUMS'))).toEqual(before);
});

it('rejects a replaced checksum list',async()=>{
  const {output}=await assembled();
  await writeFile(path.join(output,'SHA256SUMS'),'a'.repeat(64)+'  docm-2.3.4-source.tar.gz\n');
  await expect(verifyRelease(output)).rejects.toThrow(/SHA256SUMS mismatch/);
});

it('rejects asset corruption even when SHA256SUMS has been regenerated',async()=>{
  const {output,manifest}=await assembled();
  await writeFile(path.join(output,manifest.assets[0].filename),'replacement');
  await rewriteChecksums(output);
  await expect(verifyRelease(output)).rejects.toThrow(/asset checksum mismatch/);
});

it('rejects recipe substitution even when SHA256SUMS has been regenerated',async()=>{
  const {output}=await assembled();
  await writeFile(path.join(output,'docm.rb'),'class Different < Formula\nend\n');
  await rewriteChecksums(output);
  await expect(verifyRelease(output)).rejects.toThrow(/formula does not match/);
});

it.each([
  manifest=>{manifest.assets[0].filename='../outside.tar.gz';},
  manifest=>{manifest.project='/maintainer/private/checkout';},
  manifest=>{manifest.platform.arch='x64';},
  manifest=>{manifest.repository='../docm';},
  manifest=>{manifest.tag='v9.9.9';},
  manifest=>{manifest.schema=2;},
  manifest=>{manifest.toolResources[0].url='https://example.com/node.tar.xz';},
  manifest=>{manifest.assets[1].name='source';},
])('rejects unsafe or unexpected manifest metadata %#',async mutate=>{
  const {output,manifest}=await assembled();
  mutate(manifest);
  await writeFile(path.join(output,'release-manifest.json'),JSON.stringify(manifest)+'\n');
  await expect(verifyRelease(output)).rejects.toThrow();
});

it('rejects symlink substitution even when it references the correct bytes',async()=>{
  const {output,frozen,manifest}=await assembled();
  const file=path.join(output,manifest.assets[0].filename);
  await rm(file);
  await symlink(frozen.source.archive,file);
  await expect(verifyRelease(output)).rejects.toThrow(/regular file/);
});

it('rejects missing and unexpected release files',async()=>{
  const {output}=await assembled();
  await mkdir(path.join(output,'unexpected'));
  await expect(verifyRelease(output)).rejects.toThrow(/unexpected files/);
  await rm(path.join(output,'unexpected'),{recursive:true});
  await rm(path.join(output,'docm.rb'));
  await expect(verifyRelease(output)).rejects.toThrow(/missing/);
});

it('rejects a changed frozen resource before creating output',async()=>{
  const {output,frozen}=await fixture();
  await writeFile(frozen.source.archive,'changed input');
  await expect(assembleRelease(frozen,{...options,output})).rejects.toThrow(/Frozen asset checksum differs/);
  await expect(readdir(output)).rejects.toThrow();
});

it('rejects a mismatched tag before creating output',async()=>{
  const {output,frozen}=await fixture();
  await expect(assembleRelease(frozen,{...options,tag:'v2.3.5',output})).rejects.toThrow();
  await expect(readdir(output)).rejects.toThrow();
});

it('rejects a real preparation tag mismatch before acquiring or executing any tools',async()=>{
  await expect(prepareRelease({...options,tag:`v${await readVersion()}-invalid`})).rejects.toThrow();
});
