import {chmod,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach,expect,it} from 'vitest';
import {validateElectron,validateElf} from '../scripts/prepare-formula.mjs';

const roots=[],platform={os:'linux',arch:'x64'},version='42.0.0';
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
function elf({machine=62,elfClass=2,endianness=1,type=3}={}){
  const header=Buffer.alloc(64);
  header.write('\x7fELF',0,'binary');
  header[4]=elfClass;header[5]=endianness;header[6]=1;
  header.writeUInt16LE(type,16);header.writeUInt16LE(machine,18);header.writeUInt32LE(1,20);header.writeUInt16LE(64,52);
  return header;
}
async function runtime(){
  const root=await mkdtemp(path.join(tmpdir(),'docm Linux runtime '));roots.push(root);
  for(const [name,content] of [['version',version],['LICENSE','Electron license'],['LICENSES.chromium.html','Chromium licenses'],['electron',elf()],['chrome-sandbox',elf()],['libffmpeg.so',elf()],['libvulkan.so.1',elf()]]){
    await writeFile(path.join(root,name),content,{mode:['electron','chrome-sandbox'].includes(name)?0o755:0o644});
  }
  return root;
}


it.each([
  ['arm64',elf({machine:183})],
  ['32-bit',elf({elfClass:1})],
  ['big-endian',elf({endianness:2})],
  ['relocatable object',elf({type:1})],
  ['truncated',elf().subarray(0,63)],
  ['Mach-O',Buffer.alloc(64,0xcf)],
])('rejects %s binaries before execution',async(_name,content)=>{
  const root=await runtime(),binary=path.join(root,'electron');
  await writeFile(binary,content);
  await expect(validateElf(binary)).rejects.toThrow(/Expected x64 ELF/);
  await expect(validateElectron(root,version,platform)).rejects.toThrow(/Expected x64 ELF/);
});

it.each(['chrome-sandbox','libffmpeg.so','libvulkan.so.1'])('rejects a wrong-architecture %s in an otherwise native runtime',async name=>{
  const root=await runtime();await writeFile(path.join(root,name),elf({machine:183}));
  await expect(validateElectron(root,version,platform)).rejects.toThrow(/Expected x64 ELF/);
});

it('rejects mismatched runtime versions and missing licenses',async()=>{
  const root=await runtime();
  await expect(validateElectron(root,'41.0.0',platform)).rejects.toThrow(/must be exactly/);
  await rm(path.join(root,'LICENSE'));
  await expect(validateElectron(root,version,platform)).rejects.toThrow();
});

it('requires executable permissions for the Electron binary and sandbox',async()=>{
  const root=await runtime();await chmod(path.join(root,'electron'),0o644);
  await expect(validateElectron(root,version,platform)).rejects.toThrow(/missing executable electron/);
  await chmod(path.join(root,'electron'),0o755);await chmod(path.join(root,'chrome-sandbox'),0o644);
  await expect(validateElectron(root,version,platform)).rejects.toThrow(/missing executable chrome-sandbox/);
});
