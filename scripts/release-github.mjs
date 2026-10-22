import {createReadStream,createWriteStream} from 'node:fs';
import {mkdir,readFile,stat,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {readVersion,validateTag} from './version.mjs';
import {fileDigest} from './prepare-formula.mjs';
import {verifyRelease} from './release.mjs';

export class GitHubApi{
  constructor(token,{base='https://api.github.com',uploads='https://uploads.github.com'}={}){
    if(!token)throw new Error('GITHUB_TOKEN is required');
    this.token=token;this.base=base;this.uploads=uploads;
  }
  async request(method,endpoint,body,{missing=false}={}){
    const response=await fetch(`${this.base}${endpoint}`,{method,headers:{authorization:`Bearer ${this.token}`,accept:'application/vnd.github+json','x-github-api-version':'2022-11-28',...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    if(missing&&response.status===404)return null;
    if(!response.ok)throw new Error(`GitHub ${method} ${endpoint}: HTTP ${response.status}: ${(await response.text()).slice(0,1500)}`);
    return response.status===204?null:response.json();
  }
  async upload(repository,id,file){
    const name=path.basename(file),size=(await stat(file)).size;
    if(size>=2**31)throw new Error(`Release asset exceeds GitHub's 2 GiB limit: ${name}`);
    const endpoint=`/repos/${repository}/releases/${id}/assets?name=${encodeURIComponent(name)}`;
    const response=await fetch(`${this.uploads}${endpoint}`,{method:'POST',headers:{authorization:`Bearer ${this.token}`,'content-type':'application/octet-stream','content-length':String(size),'x-github-api-version':'2022-11-28'},body:createReadStream(file),duplex:'half'});
    if(!response.ok)throw new Error(`GitHub asset upload ${name}: HTTP ${response.status}: ${(await response.text()).slice(0,1500)}`);
    const uploaded=await response.json();
    if(uploaded.name!==name||uploaded.size!==size)throw new Error(`GitHub asset upload metadata differs for ${name}`);
  }
}

function releaseFiles(manifest){return [...manifest.platforms.flatMap(target=>target.assets.map(asset=>asset.filename)),'release-manifest.json','docm.rb','SHA256SUMS'];}
function context({repository,tag,commit}){
  if(!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository||''))throw new Error('A valid OWNER/REPOSITORY is required');
  if(!/^[a-f0-9]{40}$/.test(commit||''))throw new Error('The full release source commit is required');
  return {repository,tag,commit};
}
async function checkTagCommit(api,{repository,tag,commit}){
  let object=(await api.request('GET',`/repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`)).object;
  for(let depth=0;object?.type==='tag'&&depth<8;depth++)object=(await api.request('GET',`/repos/${repository}/git/tags/${object.sha}`)).object;
  if(object?.type!=='commit'||object.sha!==commit)throw new Error(`Tag ${tag} does not identify release source ${commit}`);
}
export async function preflightRelease({api,repository,tag,commit,version}){
  const expected=context({repository,tag,commit});validateTag(tag,version);
  await checkTagCommit(api,expected);
  if(await api.request('GET',`/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`,undefined,{missing:true}))throw new Error(`Release ${tag} already exists; published assets will not be overwritten. Inspect any failed draft before retrying.`);
}
async function verified(directory,expected){
  const manifest=await verifyRelease(directory);context(expected);validateTag(expected.tag,manifest.version);
  for(const key of ['repository','tag','commit'])if(manifest[key]!==expected[key])throw new Error(`Release artifact ${key} does not match the workflow source`);
  if(manifest.platforms.map(target=>`${target.os}-${target.arch}`).join(',')!=='darwin-arm64,linux-x64')throw new Error('Public release operations require the merged darwin-arm64 and linux-x64 candidates');
  return manifest;
}
async function checkRemoteAssets(release,manifest,directory){
  const names=releaseFiles(manifest);
  if(!Array.isArray(release.assets)||release.assets.length!==names.length||release.assets.map(asset=>asset.name).sort().join(',')!==[...names].sort().join(','))throw new Error('GitHub release asset set differs from the verified candidate');
  for(const name of names){
    const asset=release.assets.find(item=>item.name===name),file=path.join(directory,name);
    if(asset.state!=='uploaded'||asset.size!==(await stat(file)).size||asset.digest!==`sha256:${await fileDigest(file)}`)throw new Error(`GitHub release asset metadata/checksum differs: ${name}`);
  }
}
export async function publishRelease({directory,api,...expected}){
  const manifest=await verified(directory,expected);
  await preflightRelease({api,...expected,version:manifest.version});
  const release=await api.request('POST',`/repos/${manifest.repository}/releases`,{tag_name:manifest.tag,target_commitish:manifest.commit,name:`docm ${manifest.version}`,draft:true,generate_release_notes:true});
  let publicationStarted=false;
  try{
    for(const name of releaseFiles(manifest))await api.upload(manifest.repository,release.id,path.join(directory,name));
    const uploaded=await api.request('GET',`/repos/${manifest.repository}/releases/${release.id}`);
    if(!uploaded.draft||uploaded.tag_name!==manifest.tag)throw new Error('Release draft identity changed during upload');
    await checkRemoteAssets(uploaded,manifest,directory);
    publicationStarted=true;
    const published=await api.request('PATCH',`/repos/${manifest.repository}/releases/${release.id}`,{draft:false,make_latest:'true'});
    console.log(`Published ${published.html_url}`);return published;
  }catch(error){
    const state=publicationStarted
      ? `Publication of ${manifest.tag} could not be confirmed; inspect release ${release.id} before rerunning`
      : `Release ${manifest.tag} was left as draft ${release.id}; no published asset was replaced`;
    throw new Error(`${state}. ${error.message}`,{cause:error});
  }
}
export async function downloadPublicRelease({directory,output,api,...expected}){
  const manifest=await verified(directory,expected);
  const release=await api.request('GET',`/repos/${manifest.repository}/releases/tags/${encodeURIComponent(manifest.tag)}`);
  if(release.draft||release.tag_name!==manifest.tag)throw new Error('A published release is required for public-download verification');
  await checkTagCommit(api,expected);
  await checkRemoteAssets(release,manifest,directory);
  await mkdir(output,{recursive:false});
  for(const filename of releaseFiles(manifest)){
    const url=`https://github.com/${manifest.repository}/releases/download/${manifest.tag}/${filename}`;
    // Deliberately unauthenticated: consumers must be able to download these files.
    const response=await fetch(url);
    if(!response.ok||!response.body)throw new Error(`Public release download failed: ${filename}: HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body),createWriteStream(path.join(output,filename),{flags:'wx'}));
  }
  const downloaded=await verified(output,expected);
  if(JSON.stringify(downloaded)!==JSON.stringify(manifest))throw new Error('The public release manifest differs from the verified candidate');
  console.log(`Verified public downloads for ${manifest.tag}`);return downloaded;
}

async function content(api,repository,file,ref){
  const response=await api.request('GET',`/repos/${repository}/contents/${file}?ref=${encodeURIComponent(ref)}`,undefined,{missing:true});
  if(response===null)return null;
  if(response.encoding!=='base64'||typeof response.content!=='string')throw new Error(`Unexpected GitHub contents response: ${file}`);
  return Buffer.from(response.content,'base64').toString('utf8');
}
export async function openFormulaPullRequest({directory,api,...expected}){
  const manifest=await verified(directory,expected);
  const release=await api.request('GET',`/repos/${manifest.repository}/releases/tags/${encodeURIComponent(manifest.tag)}`);
  if(release.draft||release.tag_name!==manifest.tag)throw new Error('Refusing a formula PR for an unpublished or mismatched release');
  await checkTagCommit(api,expected);
  await checkRemoteAssets(release,manifest,directory);
  const repository=manifest.repository,owner=repository.split('/')[0];
  const {default_branch:base}=await api.request('GET',`/repos/${repository}`);
  const baseRef=await api.request('GET',`/repos/${repository}/git/ref/heads/${encodeURIComponent(base)}`);
  const metadata=JSON.parse(await content(api,repository,'package.json',baseRef.object.sha));
  validateTag(manifest.tag,metadata.version);
  const formula=await readFile(path.join(directory,'docm.rb'),'utf8');
  if(await content(api,repository,'Formula/docm.rb',baseRef.object.sha)===formula){console.log('The default branch already contains this formula');return null;}
  const branch=`homebrew/${manifest.tag}`;
  let head=await api.request('GET',`/repos/${repository}/git/ref/heads/${encodeURIComponent(branch)}`,undefined,{missing:true});
  if(head){
    const comparison=await api.request('GET',`/repos/${repository}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}`);
    if(comparison.files?.length!==1||comparison.files[0].filename!=='Formula/docm.rb'||await content(api,repository,'Formula/docm.rb',head.object.sha)!==formula)throw new Error(`Existing branch ${branch} does not contain only the verified formula; refusing to overwrite it`);
  }else{
    const baseCommit=await api.request('GET',`/repos/${repository}/git/commits/${baseRef.object.sha}`);
    const blob=await api.request('POST',`/repos/${repository}/git/blobs`,{content:formula,encoding:'utf-8'});
    const tree=await api.request('POST',`/repos/${repository}/git/trees`,{base_tree:baseCommit.tree.sha,tree:[{path:'Formula/docm.rb',mode:'100644',type:'blob',sha:blob.sha}]});
    const commit=await api.request('POST',`/repos/${repository}/git/commits`,{message:`chore(homebrew): release docm ${manifest.version}`,tree:tree.sha,parents:[baseRef.object.sha]});
    head=await api.request('POST',`/repos/${repository}/git/refs`,{ref:`refs/heads/${branch}`,sha:commit.sha});
  }
  const existing=await api.request('GET',`/repos/${repository}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&base=${encodeURIComponent(base)}`);
  const pull=existing[0]??await api.request('POST',`/repos/${repository}/pulls`,{title:`Homebrew: docm ${manifest.version}`,head:branch,base,body:`Publishes the macOS arm64 and Linux x64 source formula for [${manifest.tag}](${release.html_url}).\n\nBoth native source builds and Homebrew installations are verified by the release workflow. The complete merged asset set is checksummed against this formula's portable receipt. No changes are made to the default branch until this PR is merged.`});
  // GITHUB_TOKEN-originated events cannot be relied on to start unapproved CI.
  // workflow_dispatch is explicitly supported without an additional PAT.
  await api.request('POST',`/repos/${repository}/actions/workflows/ci.yml/dispatches`,{ref:branch});
  console.log(`Formula pull request: ${pull.html_url}`);return pull;
}

async function main(){
  const {values,positionals}=parseArgs({allowPositionals:true,options:{directory:{type:'string',default:'.build/release'},output:{type:'string',default:'.build/release-public'}}});
  if(positionals.length!==1||!['preflight','publish','verify-public','pull-request'].includes(positionals[0]))throw new Error('Usage: mise run release:github -- preflight|publish|verify-public|pull-request [--directory DIR]');
  const expected={repository:process.env.GITHUB_REPOSITORY,tag:process.env.RELEASE_TAG,commit:process.env.RELEASE_COMMIT};
  const api=new GitHubApi(process.env.GITHUB_TOKEN),directory=path.resolve(values.directory);
  switch(positionals[0]){
    case 'preflight':await preflightRelease({api,...expected,version:await readVersion()});break;
    case 'publish':await publishRelease({directory,api,...expected});break;
    case 'verify-public':await downloadPublicRelease({directory,output:path.resolve(values.output),api,...expected});break;
    case 'pull-request':await openFormulaPullRequest({directory,api,...expected});break;
  }
  if(process.env.GITHUB_STEP_SUMMARY)await writeFile(process.env.GITHUB_STEP_SUMMARY,`Release operation **${positionals[0]}** completed for **${expected.tag}**.\n`,{flag:'a'});
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
