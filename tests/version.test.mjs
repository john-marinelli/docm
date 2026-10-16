import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach,expect,it} from 'vitest';
import {bumpVersion,readVersion,validateTag} from '../scripts/version.mjs';

const roots=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function project(text){
  const root=await mkdtemp(path.join(tmpdir(),'docm version '));
  roots.push(root);
  await writeFile(path.join(root,'package.json'),text);
  return root;
}

it.each([
  ['patch','3.8.9','3.8.10'],
  ['minor','3.8.9','3.9.0'],
  ['major','3.8.9','4.0.0'],
])('bumps %s and returns the same version subsequently read from the package',async(kind,initial,next)=>{
  const root=await project(JSON.stringify({name:'fixture',version:initial}));
  expect(await bumpVersion(kind,root)).toBe(next);
  expect(await readVersion(root)).toBe(next);
});

it.each([
  '{\r\n\t"description": "version: preserve \\\"quoted\\\" text",\r\n\t"nested": {"version":"8.7.6"},\r\n\t"version" : "1.2.3",\r\n\t"author": {"name":"Unchanged"}\r\n}\r\n',
  '{"nested":{"version":"8.7.6"},"version":"1.2.3","scripts":{"version":"keep"}}',
  '{\n  "vers\\u0069on": "1.2.3",\n  "license": "MIT"\n}\n',
])('changes only the top-level version value, preserving all other bytes',async text=>{
  const root=await project(text);
  await bumpVersion('patch',root);
  expect(await readFile(path.join(root,'package.json'),'utf8')).toBe(text.replace('"1.2.3"','"1.2.4"'));
});

it('rejects unsupported bump kinds without writing the package',async()=>{
  const text='{"version":"1.2.3","private":true}\n';
  const root=await project(text);
  await expect(bumpVersion('prerelease',root)).rejects.toThrow(/patch, minor, or major/);
  expect(await readFile(path.join(root,'package.json'),'utf8')).toBe(text);
});

it.each(['1.2','01.2.3','1.2.3-beta.1','1.2.3\n','9007199254740992.0.0',123])('rejects invalid or unsafe package versions: %s',async version=>{
  const text=JSON.stringify({version});
  const root=await project(text);
  await expect(readVersion(root)).rejects.toThrow(/version/i);
  await expect(bumpVersion('patch',root)).rejects.toThrow(/version/i);
  expect(await readFile(path.join(root,'package.json'),'utf8')).toBe(text);
});

it.each(['{}','{"version":"1.2.3","version":"2.3.4"}'])('rejects missing or ambiguous top-level versions',async text=>{
  const root=await project(text);
  await expect(readVersion(root)).rejects.toThrow(/version/i);
  await expect(bumpVersion('major',root)).rejects.toThrow(/version/i);
  expect(await readFile(path.join(root,'package.json'),'utf8')).toBe(text);
});

it('rejects component overflow without writing',async()=>{
  const version='1.2.9007199254740991';
  const text=JSON.stringify({version});
  const root=await project(text);
  await expect(bumpVersion('patch',root)).rejects.toThrow(/safe integer/);
  expect(await readFile(path.join(root,'package.json'),'utf8')).toBe(text);
});

it('accepts only the exact stable tag matching its supplied package version',()=>{
  expect(()=>validateTag('v12.34.57','12.34.56')).toThrow(/exactly v12\.34\.56/);
  expect(()=>validateTag('v1.2.3-beta','1.2.3-beta')).toThrow(/stable SemVer/);
});
