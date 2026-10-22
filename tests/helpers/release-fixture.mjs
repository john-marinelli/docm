import {createHash} from 'node:crypto';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {nodeResourceUrl,platformKey,pnpmResourceUrl} from '../../scripts/platform.mjs';

export const releaseOptions={tag:'v2.3.4',commit:'0123456789abcdef0123456789abcdef01234567',repository:'john-marinelli/docm'};
export async function frozenReleaseFixture({platform={os:'darwin',arch:'arm64'},tools={node:'26.10.0',pnpm:'12.10.1'},version='2.3.4'}={}){
  const root=await mkdtemp(path.join(tmpdir(),'docm release assets '));
  const assets=[];
  for(const name of ['source','pnpm-store','electron']){
    const bytes=Buffer.from(`isolated ${platformKey(platform)} ${name} bytes\n`),archive=path.join(root,`${name}.tar.gz`);
    await writeFile(archive,bytes);assets.push({name,archive,sha256:createHash('sha256').update(bytes).digest('hex')});
  }
  const frozen={version,platform:{...platform},source:{archive:assets[0].archive,sha256:assets[0].sha256},resources:assets.slice(1),tools:{...tools},toolResources:[{name:'node',url:nodeResourceUrl(tools.node,platform),sha256:'a'.repeat(64)},{name:'pnpm',url:pnpmResourceUrl(tools.pnpm,platform),sha256:'b'.repeat(64)}]};
  return {root,frozen,output:path.join(root,'release')};
}
