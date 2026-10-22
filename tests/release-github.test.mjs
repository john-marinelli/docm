import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {readFile,readdir,rm} from 'node:fs/promises';
import path from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
import {assembleRelease,mergeReleases} from '../scripts/release.mjs';
import {GitHubApi,downloadPublicRelease,openFormulaPullRequest,publishRelease} from '../scripts/release-github.mjs';
import {frozenReleaseFixture,releaseOptions} from './helpers/release-fixture.mjs';

const cleanups=[];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
afterEach(async()=>{vi.unstubAllGlobals();for(const cleanup of cleanups.splice(0).reverse())await cleanup();});
async function fixture({existing=false,failUpload=false,failPublish=false,conflictingBranch=false,singleTarget=false}={}){
  const files=await frozenReleaseFixture();cleanups.push(()=>rm(files.root,{recursive:true,force:true}));
  const native=files.output;
  await assembleRelease(files.frozen,{...releaseOptions,output:native});
  if(!singleTarget){
    const linux=await frozenReleaseFixture({platform:{os:'linux',arch:'x64'}});cleanups.push(()=>rm(linux.root,{recursive:true,force:true}));
    await assembleRelease(linux.frozen,{...releaseOptions,output:linux.output});
    files.output=path.join(files.root,'merged');
    await mergeReleases([linux.output,native],{output:files.output});
  }
  const expected=new Map(),sizes=new Map();
  for(const name of await readdir(files.output)){
    const bytes=await readFile(path.join(files.output,name));expected.set(name,hash(bytes));sizes.set(name,bytes.length);
  }
  const state={created:false,draft:!existing,uploaded:new Set(existing?expected.keys():[]),mutations:[],publicDownloads:[],missingAsset:false,badDigest:false,corruptDownload:false,blob:null};
  const server=createServer(async(request,response)=>{
    try{
      const url=new URL(request.url,'http://localhost'),route=decodeURIComponent(url.pathname),method=request.method;
      const prefix='/repos/john-marinelli/docm';
      const json=(status,value)=>{response.writeHead(status,{'content-type':'application/json'});response.end(JSON.stringify(value));};
      const assets=[...state.uploaded].map(name=>({name,size:sizes.get(name),state:'uploaded',digest:`sha256:${state.badDigest?'0'.repeat(64):expected.get(name)}`}));
      if(state.missingAsset)assets.pop();
      const release={id:1,tag_name:releaseOptions.tag,draft:state.draft,assets,html_url:'https://github.com/john-marinelli/docm/releases/tag/v2.3.4'};
      if(method==='GET'&&route===`${prefix}/git/ref/tags/v2.3.4`)return json(200,{object:{type:'commit',sha:releaseOptions.commit}});
      if(method==='GET'&&route===`${prefix}/releases/tags/v2.3.4`)return existing||state.created?json(200,release):json(404,{});
      if(method==='GET'&&route===`${prefix}/releases/1`)return json(200,release);
      if(method==='GET'&&route.startsWith('/public/')){
        const name=route.slice('/public/'.length);
        state.publicDownloads.push({name,authorization:request.headers.authorization});
        if(!expected.has(name)){response.writeHead(404);return response.end();}
        response.writeHead(200);return response.end(state.corruptDownload&&name.includes('-electron-linux-')?Buffer.from('corrupt archive'):await readFile(path.join(files.output,name)));
      }
      if(method==='GET'){
        if(route===prefix)return json(200,{default_branch:'main'});
        if(route===`${prefix}/git/ref/heads/main`)return json(200,{object:{sha:'b'.repeat(40)}});
        if(route===`${prefix}/contents/package.json`)return json(200,{encoding:'base64',content:Buffer.from('{"version":"2.3.4"}').toString('base64')});
        if(route===`${prefix}/contents/Formula/docm.rb`)return json(404,{});
        if(route===`${prefix}/git/ref/heads/homebrew/v2.3.4`)return conflictingBranch?json(200,{object:{sha:'c'.repeat(40)}}):json(404,{});
        if(route===`${prefix}/compare/main...homebrew/v2.3.4`)return json(200,{files:[{filename:'Formula/docm.rb'},{filename:'unrelated.txt'}]});
        if(route===`${prefix}/git/commits/${'b'.repeat(40)}`)return json(200,{tree:{sha:'base-tree'}});
        if(route===`${prefix}/pulls`)return json(200,[]);
      }
      if(method!=='GET'){
        const chunks=[];for await(const bytes of request)chunks.push(bytes);const bytes=Buffer.concat(chunks);
        const body=route.endsWith('/assets')?null:JSON.parse(bytes.toString()||'null');
        state.mutations.push({method,route,body});
        if(method==='POST'&&route===`${prefix}/releases`){state.created=true;return json(201,release);}
        if(method==='POST'&&route===`${prefix}/releases/1/assets`){
          const name=url.searchParams.get('name');
          if(failUpload)return json(500,{message:'upload failure'});
          if(expected.get(name)!==hash(bytes))return json(422,{message:'wrong asset bytes'});
          state.uploaded.add(name);return json(201,{name,size:bytes.length});
        }
        if(method==='PATCH'&&route===`${prefix}/releases/1`){
          if(state.uploaded.size!==expected.size)return json(409,{message:'incomplete release'});
          state.draft=body.draft;
          if(failPublish)return json(500,{message:'publication response failed after state changed'});
          return json(200,{...release,draft:state.draft});
        }
        if(method==='POST'&&route===`${prefix}/git/blobs`){state.blob=body.content;return json(201,{sha:'formula-blob'});}
        if(method==='POST'&&route===`${prefix}/git/trees`)return json(201,{sha:'formula-tree'});
        if(method==='POST'&&route===`${prefix}/git/commits`)return json(201,{sha:'formula-commit'});
        if(method==='POST'&&route===`${prefix}/git/refs`)return json(201,{object:{sha:body.sha}});
        if(method==='POST'&&route===`${prefix}/pulls`)return json(201,{html_url:'https://github.com/john-marinelli/docm/pull/123'});
        if(method==='POST'&&route===`${prefix}/actions/workflows/ci.yml/dispatches`){response.writeHead(204);return response.end();}
      }
      return json(404,{message:'unexpected request'});
    }catch(error){response.writeHead(500);response.end(error.message);}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  cleanups.push(()=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve())));
  const address=`http://127.0.0.1:${server.address().port}`;
  const originalFetch=globalThis.fetch;
  const publicPrefix=`https://github.com/${releaseOptions.repository}/releases/download/${releaseOptions.tag}/`;
  vi.stubGlobal('fetch',(url,options)=>originalFetch(typeof url==='string'&&url.startsWith(publicPrefix)?`${address}/public/${url.slice(publicPrefix.length)}`:url,options));
  return {...files,native,state,expected,api:new GitHubApi('isolated-test-token',{base:address,uploads:address}),...releaseOptions};
}

it('refuses an existing release without mutating it or replacing assets',async()=>{
  const f=await fixture({existing:true});
  await expect(publishRelease({...f,directory:f.output})).rejects.toThrow(/already exists/);
  expect(f.state.mutations).toEqual([]);expect(f.state.draft).toBe(false);
});
it('keeps a failed asset upload in draft rather than exposing an incomplete release',async()=>{
  const f=await fixture({failUpload:true});
  await expect(publishRelease({...f,directory:f.output})).rejects.toThrow(/left as draft/);
  expect(f.state.created).toBe(true);expect(f.state.draft).toBe(true);
});
it('does not tell operators to treat an unconfirmed publication as an unpublished draft',async()=>{
  const f=await fixture({failPublish:true});
  await expect(publishRelease({...f,directory:f.output})).rejects.toThrow(/could not be confirmed.*inspect release/i);
  expect(f.state.draft).toBe(false);
});
it('publishes both native asset sets only after all bytes arrived intact',async()=>{
  const f=await fixture();
  await publishRelease({...f,directory:f.output});
  expect(f.expected.size).toBe(9);
  expect(f.state.draft).toBe(false);expect([...f.state.uploaded].sort()).toEqual([...f.expected.keys()].sort());
});
it.each(['missingAsset','badDigest'])('keeps a remotely inconsistent %s release unpublished',async field=>{
  const f=await fixture();f.state[field]=true;
  await expect(publishRelease({...f,directory:f.output})).rejects.toThrow(/left as draft.*asset/);
  expect(f.state.draft).toBe(true);
  expect(f.state.mutations.some(item=>item.method==='PATCH')).toBe(false);
});
it('refuses a candidate for a different source commit before any remote mutation',async()=>{
  const f=await fixture();
  await expect(publishRelease({...f,directory:f.output,commit:'f'.repeat(40)})).rejects.toThrow(/artifact commit/);
  expect(f.state.mutations).toEqual([]);
});
it('refuses to publish or propose a single-target candidate',async()=>{
  const f=await fixture({singleTarget:true});
  await expect(publishRelease({...f,directory:f.output})).rejects.toThrow(/merged/);
  await expect(openFormulaPullRequest({...f,directory:f.output})).rejects.toThrow(/merged/);
  expect(f.state.mutations).toEqual([]);
});
it('downloads and verifies every public asset without authentication',async()=>{
  const f=await fixture({existing:true}),output=path.join(f.root,'public');
  const downloaded=await downloadPublicRelease({...f,directory:f.output,output});
  expect(downloaded.platforms.map(item=>`${item.os}-${item.arch}`)).toEqual(['darwin-arm64','linux-x64']);
  expect(f.state.publicDownloads.map(item=>item.name).sort()).toEqual([...f.expected.keys()].sort());
  expect(f.state.publicDownloads.every(item=>item.authorization===undefined)).toBe(true);
  for(const name of f.expected.keys())expect(hash(await readFile(path.join(output,name)))).toBe(f.expected.get(name));
});
it('rejects corrupted public Linux bytes despite correct remote metadata',async()=>{
  const f=await fixture({existing:true});f.state.corruptDownload=true;
  await expect(downloadPublicRelease({...f,directory:f.output,output:path.join(f.root,'public')})).rejects.toThrow(/SHA256SUMS mismatch/);
});
it.each(['missingAsset','badDigest'])('refuses public verification and formula PR for remote %s',async field=>{
  const f=await fixture({existing:true});f.state[field]=true;
  await expect(downloadPublicRelease({...f,directory:f.output,output:path.join(f.root,'public')})).rejects.toThrow(/asset/);
  await expect(openFormulaPullRequest({...f,directory:f.output})).rejects.toThrow(/asset/);
  expect(f.state.mutations).toEqual([]);expect(f.state.publicDownloads).toEqual([]);
});
it('does not overwrite or propose an existing release branch containing unrelated changes',async()=>{
  const f=await fixture({existing:true,conflictingBranch:true});
  await expect(openFormulaPullRequest({...f,directory:f.output})).rejects.toThrow(/refusing to overwrite/);
  expect(f.state.mutations).toEqual([]);
});
it('proposes exactly the verified cross-platform formula without changing the default branch',async()=>{
  const f=await fixture({existing:true});
  const pull=await openFormulaPullRequest({...f,directory:f.output});
  expect(pull.html_url).toBe('https://github.com/john-marinelli/docm/pull/123');
  expect(f.state.blob).toBe(await readFile(path.join(f.output,'docm.rb'),'utf8'));
  const mutation=ending=>f.state.mutations.find(item=>item.route.endsWith(ending));
  expect(mutation('/git/trees').body).toEqual({base_tree:'base-tree',tree:[{path:'Formula/docm.rb',mode:'100644',type:'blob',sha:'formula-blob'}]});
  expect(mutation('/git/commits').body.parents).toEqual(['b'.repeat(40)]);
  expect(mutation('/git/refs').body).toEqual({ref:'refs/heads/homebrew/v2.3.4',sha:'formula-commit'});
  expect(mutation('/pulls').body).toMatchObject({head:'homebrew/v2.3.4',base:'main'});
  expect(mutation('/actions/workflows/ci.yml/dispatches').body).toEqual({ref:'homebrew/v2.3.4'});
  expect(f.state.mutations.every(item=>item.method==='POST')).toBe(true);
});
