import {createHash} from 'node:crypto';
import {mkdir,readFile,readdir,rm,symlink,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {afterEach,expect,it} from 'vitest';
import {assembleRelease,mergeReleases,prepareRelease,releasePlatform,verifyRelease} from '../scripts/release.mjs';
import {nodeResourceUrl,platformKey,pnpmResourceUrl} from '../scripts/platform.mjs';
import {readVersion} from '../scripts/version.mjs';
import {frozenReleaseFixture,releaseOptions as options} from './helpers/release-fixture.mjs';

const roots=[];
const platforms=[{os:'darwin',arch:'arm64'},{os:'linux',arch:'x64'}];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function fixture(settings){
  const result=await frozenReleaseFixture(settings);roots.push(result.root);return result;
}
async function assembled(settings,identity={}){
  const result=await fixture(settings);
  result.manifest=await assembleRelease(result.frozen,{...options,...identity,output:result.output});
  return result;
}
async function candidates(){return Promise.all(platforms.map(platform=>assembled({platform})));}
async function rewriteChecksums(output){
  const manifest=JSON.parse(await readFile(path.join(output,'release-manifest.json'),'utf8'));
  const names=[...manifest.platforms.flatMap(target=>target.assets.map(asset=>asset.filename)),'release-manifest.json','docm.rb'];
  const lines=[];
  for(const name of names)lines.push(`${hash(await readFile(path.join(output,name)))}  ${name}\n`);
  await writeFile(path.join(output,'SHA256SUMS'),lines.join(''));
}

it.each(platforms)('assembles and verifies portable $os $arch native candidate bytes',async platform=>{
  const {output,manifest,frozen}=await assembled({platform});
  expect(manifest.schema).toBe(2);
  expect(await verifyRelease(output)).toEqual(manifest);
  const target=releasePlatform(manifest,platform);
  expect(manifest.platforms).toEqual([target]);
  expect(target.toolResources.map(item=>item.url)).toEqual([nodeResourceUrl(frozen.tools.node,platform),pnpmResourceUrl(frozen.tools.pnpm,platform)]);
  for(const [index,asset] of target.assets.entries()){
    expect(asset.filename).toBe(`docm-2.3.4-${asset.name}-${platformKey(platform)}.tar.gz`);
    const input=index===0?frozen.source:frozen.resources[index-1];
    expect(await readFile(path.join(output,asset.filename))).toEqual(await readFile(input.archive));
  }
  expect(JSON.parse(await readFile(path.join(output,'release-manifest.json'),'utf8'))).toEqual(manifest);
  expect(JSON.stringify(manifest)).not.toContain(output);
  const other=platforms.find(item=>item.os!==platform.os);
  expect(()=>releasePlatform(manifest,other)).toThrow(/does not contain native platform/);
});

it('merges complete native candidates deterministically without changing either input',async()=>{
  const [mac,linux]=await candidates(),output=path.join(mac.root,'merged'),reversed=path.join(mac.root,'reversed');
  const before=await Promise.all([mac,linux].map(item=>readFile(path.join(item.output,'SHA256SUMS'))));
  const manifest=await mergeReleases([linux.output,mac.output],{output});
  await mergeReleases([mac.output,linux.output],{output:reversed});
  expect(manifest.platforms.map(platformKey)).toEqual(['darwin-arm64','linux-x64']);
  expect(await verifyRelease(output)).toEqual(manifest);
  expect((await readdir(output)).length).toBe(9);
  for(const name of await readdir(output))expect(await readFile(path.join(output,name))).toEqual(await readFile(path.join(reversed,name)));
  for(const [index,input] of [mac,linux].entries()){
    expect(await readFile(path.join(input.output,'SHA256SUMS'))).toEqual(before[index]);
    for(const asset of input.manifest.platforms[0].assets)expect(await readFile(path.join(output,asset.filename))).toEqual(await readFile(path.join(input.output,asset.filename)));
  }
});

it('rejects duplicate native candidates before creating merged output',async()=>{
  const mac=await assembled(),output=path.join(mac.root,'merged');
  await expect(mergeReleases([mac.output,mac.output],{output})).rejects.toThrow(/unique/);
  await expect(readdir(output)).rejects.toThrow();
});

it.each([
  ['commit',{commit:'f'.repeat(40)},{}],
  ['repository',{repository:'other/docm'},{}],
  ['version',{tag:'v2.3.5'},{version:'2.3.5'}],
  ['tools',{}, {tools:{node:'26.9.0',pnpm:'12.10.1'}}],
])('rejects mismatched candidate %s before creating merged output',async(_key,identity,settings)=>{
  const mac=await assembled(),linux=await assembled({...settings,platform:platforms[1]},identity),output=path.join(mac.root,'merged');
  await expect(mergeReleases([mac.output,linux.output],{output})).rejects.toThrow(/mismatched/);
  await expect(readdir(output)).rejects.toThrow();
});

it('verifies all candidate input bytes before creating merged output',async()=>{
  const [mac,linux]=await candidates(),output=path.join(mac.root,'merged');
  await writeFile(path.join(linux.output,linux.manifest.platforms[0].assets[0].filename),'changed');
  await rewriteChecksums(linux.output);
  await expect(mergeReleases([mac.output,linux.output],{output})).rejects.toThrow(/asset checksum mismatch/);
  await expect(readdir(output)).rejects.toThrow();
});

it('requires exactly two single-target candidates, not a previously merged release',async()=>{
  const [mac,linux]=await candidates(),output=path.join(mac.root,'merged');
  await expect(mergeReleases([mac.output],{output})).rejects.toThrow(/exactly two/);
  await mergeReleases([mac.output,linux.output],{output});
  await expect(mergeReleases([output,mac.output],{output:path.join(mac.root,'another')})).rejects.toThrow(/one native platform/);
});

it('refuses a nonempty output rather than overwriting a previous release',async()=>{
  const {frozen,output}=await assembled();
  const before=await readFile(path.join(output,'SHA256SUMS'));
  await expect(assembleRelease(frozen,{...options,output})).rejects.toThrow(/not empty.*--output/);
  expect(await readFile(path.join(output,'SHA256SUMS'))).toEqual(before);
});

it('rejects a replaced checksum list',async()=>{
  const {output}=await assembled();
  await writeFile(path.join(output,'SHA256SUMS'),'a'.repeat(64)+'  wrong.tar.gz\n');
  await expect(verifyRelease(output)).rejects.toThrow(/SHA256SUMS mismatch/);
});

it('rejects asset corruption even when SHA256SUMS has been regenerated',async()=>{
  const {output,manifest}=await assembled();
  await writeFile(path.join(output,manifest.platforms[0].assets[0].filename),'replacement');
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
  manifest=>{manifest.platforms[0].assets[0].filename='../outside.tar.gz';},
  manifest=>{manifest.project='/maintainer/private/checkout';},
  manifest=>{manifest.platforms[0].arch='x64';},
  manifest=>{manifest.repository='../docm';},
  manifest=>{manifest.tag='v9.9.9';},
  manifest=>{manifest.schema=1;},
  manifest=>{manifest.platforms[0].toolResources[0].url='https://example.com/node.tar.xz';},
  manifest=>{manifest.platforms[0].assets[1].name='source';},
  manifest=>{manifest.platforms.push(manifest.platforms[0]);},
  manifest=>{manifest.platforms=[];},
])('rejects unsafe or unexpected manifest metadata %#',async mutate=>{
  const {output,manifest}=await assembled();
  mutate(manifest);
  await writeFile(path.join(output,'release-manifest.json'),JSON.stringify(manifest)+'\n');
  await expect(verifyRelease(output)).rejects.toThrow();
});

it('rejects symlink substitution even when it references the correct bytes',async()=>{
  const {output,frozen,manifest}=await assembled();
  const file=path.join(output,manifest.platforms[0].assets[0].filename);
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

it('requires frozen native platform metadata before creating output',async()=>{
  const {output,frozen}=await fixture();delete frozen.platform;
  await expect(assembleRelease(frozen,{...options,output})).rejects.toThrow(/frozen platform/);
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
