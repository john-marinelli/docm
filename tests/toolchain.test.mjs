import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach,expect,it} from 'vitest';
import {readToolPins} from '../scripts/prepare-formula.mjs';

const roots=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function config(text){
  const root=await mkdtemp(path.join(tmpdir(),'docm tool pins '));roots.push(root);
  const file=path.join(root,'mise.toml');await writeFile(file,text);return file;
}

it('reads exact tool versions from the tools table without taking values from task definitions',async()=>{
  const file=await config("[tools] # build versions\r\nnode = '28.2.3' # exact pin\r\npnpm = \"14.5.6\"\r\n[tasks.example]\r\nnode = \"99.0.0\"\r\n");
  expect(await readToolPins(file)).toEqual({node:'28.2.3',pnpm:'14.5.6'});
});

it('rejects version ranges instead of choosing an installed version',async()=>{
  const file=await config('[tools]\nnode = "^26.10.0"\npnpm = "12.10.1"\n');
  await expect(readToolPins(file)).rejects.toThrow(/node must be a quoted exact version/);
});

it.each([
  ['[tools]\nnode = "26.10.0"\n','missing a quoted exact [tools].pnpm'],
  ['[tools]\npnpm = "12.10.1"\n','missing a quoted exact [tools].node'],
  ['[tools]\nnode = "26.10.0"\nnode = "28.0.0"\npnpm = "12.10.1"\n','node must be declared exactly once'],
  ['[tools]\nnode = { version = "26.10.0" }\npnpm = "12.10.1"\n','node must be a quoted exact version'],
])('rejects ambiguous or missing version declarations',async(text,message)=>{
  await expect(readToolPins(await config(text))).rejects.toThrow(message);
});
