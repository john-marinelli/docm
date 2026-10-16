import {createHash} from 'node:crypto';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

export const releaseOptions={tag:'v2.3.4',commit:'0123456789abcdef0123456789abcdef01234567',repository:'john-marinelli/docm'};
export async function frozenReleaseFixture(){
  const root=await mkdtemp(path.join(tmpdir(),'docm release assets '));
  const assets=[];
  for(const name of ['source','pnpm-store','electron']){
    const bytes=Buffer.from(`isolated ${name} bytes\n`),archive=path.join(root,`${name}.tar.gz`);
    await writeFile(archive,bytes);assets.push({name,archive,sha256:createHash('sha256').update(bytes).digest('hex')});
  }
  const tools={node:'26.10.0',pnpm:'12.10.1'};
  const frozen={version:'2.3.4',source:{archive:assets[0].archive,sha256:assets[0].sha256},resources:assets.slice(1),tools,toolResources:[{name:'node',url:`https://nodejs.org/dist/v${tools.node}/node-v${tools.node}-darwin-arm64.tar.xz`,sha256:'a'.repeat(64)},{name:'pnpm',url:`https://registry.npmjs.org/pnpm/-/pnpm-${tools.pnpm}.tgz`,sha256:'b'.repeat(64)}]};
  return {root,frozen,output:path.join(root,'release')};
}
