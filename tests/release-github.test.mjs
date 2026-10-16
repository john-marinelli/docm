import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {readFile,readdir,rm} from 'node:fs/promises';
import path from 'node:path';
import {afterEach,expect,it} from 'vitest';
import {assembleRelease} from '../scripts/release.mjs';
import {GitHubApi,openFormulaPullRequest,publishRelease} from '../scripts/release-github.mjs';
import {frozenReleaseFixture,releaseOptions} from './helpers/release-fixture.mjs';

const cleanups=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();});
async function fixture({existing=false,failUpload=false,failPublish=false,conflictingBranch=false}={}){
  const files=await frozenReleaseFixture();cleanups.push(()=>rm(files.root,{recursive:true,force:true}));
  await assembleRelease(files.frozen,{...releaseOptions,output:files.output});
  const expected=new Map();
  for(const name of await readdir(files.output))expected.set(name,createHash('sha256').update(await readFile(path.join(files.output,name))).digest('hex'));
  const state={created:false,draft:!existing,uploaded:new Set(),mutations:[]};
  const server=createServer(async(request,response)=>{
    try{
      const url=new URL(request.url,'http://localhost'),route=decodeURIComponent(url.pathname),method=request.method;
      const prefix='/repos/john-marinelli/docm';
      const json=(status,value)=>{response.writeHead(status,{'content-type':'application/json'});response.end(JSON.stringify(value));};
      const release={id:1,tag_name:releaseOptions.tag,draft:state.draft,html_url:'https://github.com/john-marinelli/docm/releases/tag/v2.3.4'};
      if(method==='GET'&&route===`${prefix}/git/ref/tags/v2.3.4`)return json(200,{object:{type:'commit',sha:releaseOptions.commit}});
      if(method==='GET'&&route===`${prefix}/releases/tags/v2.3.4`)return existing||state.created?json(200,release):json(404,{});
      if(method==='GET'&&conflictingBranch){
        if(route===prefix)return json(200,{default_branch:'main'});
        if(route===`${prefix}/git/ref/heads/main`)return json(200,{object:{sha:'b'.repeat(40)}});
        if(route===`${prefix}/contents/package.json`)return json(200,{encoding:'base64',content:Buffer.from('{"version":"2.3.4"}').toString('base64')});
        if(route===`${prefix}/contents/Formula/docm.rb`)return json(404,{});
        if(route===`${prefix}/git/ref/heads/homebrew/v2.3.4`)return json(200,{object:{sha:'c'.repeat(40)}});
        if(route===`${prefix}/compare/main...homebrew/v2.3.4`)return json(200,{files:[{filename:'Formula/docm.rb'},{filename:'unrelated.txt'}]});
      }
      if(method!=='GET'){
        state.mutations.push({method,route});
        const chunks=[];for await(const bytes of request)chunks.push(bytes);const bytes=Buffer.concat(chunks);
        if(method==='POST'&&route===`${prefix}/releases`){state.created=true;return json(201,release);}
        if(method==='POST'&&route===`${prefix}/releases/1/assets`){
          const name=url.searchParams.get('name');
          if(failUpload)return json(500,{message:'upload failure'});
          if(expected.get(name)!==createHash('sha256').update(bytes).digest('hex'))return json(422,{message:'wrong asset bytes'});
          state.uploaded.add(name);return json(201,{name,size:bytes.length});
        }
        if(method==='PATCH'&&route===`${prefix}/releases/1`){
          if(state.uploaded.size!==expected.size)return json(409,{message:'incomplete release'});
          state.draft=JSON.parse(bytes).draft;
          if(failPublish)return json(500,{message:'publication response failed after state changed'});
          return json(200,{...release,draft:state.draft});
        }
      }
      return json(404,{message:'unexpected request'});
    }catch(error){response.writeHead(500);response.end(error.message);}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  cleanups.push(()=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve())));
  const address=`http://127.0.0.1:${server.address().port}`;
  return {...files,state,expected,api:new GitHubApi('isolated-test-token',{base:address,uploads:address}),...releaseOptions};
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
it('publishes only after all release asset bytes have arrived intact',async()=>{
  const f=await fixture();
  await publishRelease({...f,directory:f.output});
  expect(f.state.draft).toBe(false);expect([...f.state.uploaded].sort()).toEqual([...f.expected.keys()].sort());
});
it('refuses a candidate for a different source commit before any remote mutation',async()=>{
  const f=await fixture();
  await expect(publishRelease({...f,directory:f.output,commit:'f'.repeat(40)})).rejects.toThrow(/artifact commit/);
  expect(f.state.mutations).toEqual([]);
});
it('does not overwrite or propose an existing release branch containing unrelated changes',async()=>{
  const f=await fixture({existing:true,conflictingBranch:true});
  await expect(openFormulaPullRequest({...f,directory:f.output})).rejects.toThrow(/refusing to overwrite/);
  expect(f.state.mutations).toEqual([]);
});
