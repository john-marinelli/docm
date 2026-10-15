import {cp,mkdir,readdir,readFile,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';

const root=path.resolve(import.meta.dirname,'..');
const output=path.join(root,'.build','third-party-notices');
const store=path.join(root,'node_modules','.pnpm');
const packages=new Map();
for(const entry of await readdir(store,{withFileTypes:true})){
  if(!entry.isDirectory()||entry.name==='node_modules')continue;
  const modules=path.join(store,entry.name,'node_modules');
  for(const candidate of await readdir(modules,{withFileTypes:true})){
    if(!candidate.isDirectory()||candidate.isSymbolicLink())continue;
    const directory=path.join(modules,candidate.name);
    const directories=candidate.name.startsWith('@')?(await readdir(directory,{withFileTypes:true})).filter(child=>child.isDirectory()&&!child.isSymbolicLink()).map(child=>path.join(directory,child.name)):[directory];
    for(const packageRoot of directories){
      let metadata;try{metadata=JSON.parse(await readFile(path.join(packageRoot,'package.json'),'utf8'));}catch(error){if(error.code==='ENOENT')continue;throw error;}
      if(metadata.name&&metadata.version)packages.set(`${metadata.name}@${metadata.version}`,{root:packageRoot,metadata});
    }
  }
}
if(!packages.size)throw new Error('No installed package notices found; install project dependencies first');
const mathjax=[...packages.values()].find(entry=>entry.metadata.name==='@mathjax/src');
const mathFont=[...packages.values()].find(entry=>entry.metadata.name==='@mathjax/mathjax-newcm-font');
if(!mathjax||!mathFont||mathjax.metadata.license!=='Apache-2.0'||mathFont.metadata.license!=='Apache-2.0')throw new Error('Installed MathJax and NewCM Apache-2.0 package metadata is required');
const apacheLicense=path.join(mathjax.root,'LICENSE');
await readFile(apacheLicense);
await rm(output,{recursive:true,force:true});await mkdir(output,{recursive:true});
const index=[];
for(const [identity,entry] of [...packages].sort(([left],[right])=>left.localeCompare(right))){
  const directory=path.join(output,encodeURIComponent(identity));await mkdir(directory);
  const notices=(await readdir(entry.root)).filter(name=>/^(?:licen[cs]e|copying|copyright|notice)(?:[._-]|s?$)/i.test(name));
  for(const name of notices)await cp(path.join(entry.root,name),path.join(directory,name),{recursive:true});
  await writeFile(path.join(directory,'package.json'),JSON.stringify(entry.metadata,null,2)+'\n');
  if(entry.metadata.name==='dompurify')await cp(path.join(entry.root,'src'),path.join(directory,'src'),{recursive:true});
  if(entry.metadata.name==='@mathjax/mathjax-newcm-font'){
    // The published font package declares Apache-2.0 but omits a license file.
    // Preserve that license and its shipped definition's MathJax attribution.
    if(!notices.includes('LICENSE')){await cp(apacheLicense,path.join(directory,'LICENSE'));notices.push('LICENSE');}
    await mkdir(path.join(directory,'def'));
    await cp(path.join(entry.root,'def','mathjax-newcm.ts'),path.join(directory,'def','mathjax-newcm.ts'));
  }
  index.push({name:entry.metadata.name,version:entry.metadata.version,license:entry.metadata.license??null,notices,source:entry.metadata.name==='dompurify'?'src':entry.metadata.name==='@mathjax/mathjax-newcm-font'?'def/mathjax-newcm.ts':undefined});
}
await writeFile(path.join(output,'index.json'),JSON.stringify(index,null,2)+'\n');
await writeFile(path.join(output,'NOTICE.txt'),'Docm bundles third-party JavaScript and fonts. This directory preserves exact installed package metadata and published license/notice files, including a conservative superset of build-time packages. Packages listed here are not all runtime components. DOMPurify corresponding TypeScript source is included without modification. Source Sans 3 and Source Code Pro font licenses are included in their package directories. MathJax and the MathJax NewComputerModern SVG font data are declared Apache-2.0 by their exact installed packages; the Apache license and the font definition containing the MathJax copyright attribution are preserved. Electron/Chromium notices remain in the application bundle.\n');
console.error(`Prepared redistribution metadata/notices for ${index.length} exact package versions at ${output}`);
