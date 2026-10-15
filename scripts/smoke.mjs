import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile,rename,rm,copyFile,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {performance} from 'node:perf_hooks';
import electron from 'electron';
import {_electron as electronDriver} from '@playwright/test';
import {getDocument,OPS} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {createFixtures} from './fixtures.mjs';

export async function runSmoke({executable=electron,packaged=false,artifactsPath}={}){
 const root=await mkdtemp(path.join(tmpdir(),'docm smoke ')), fixture=await createFixtures(root);
 const artifacts=path.resolve(artifactsPath??(packaged?'.build/package-smoke':'.build/smoke'));await mkdir(artifacts,{recursive:true});
 const cleanEnv={...process.env,HOME:fixture.home,PATH:packaged?'/usr/bin:/bin:/usr/sbin:/sbin':process.env.PATH};
 delete cleanEnv.ELECTRON_RUN_AS_NODE;delete cleanEnv.ELECTRON_ENABLE_LOGGING;delete cleanEnv.ELECTRON_RENDERER_URL;
 const prefix=packaged?[]:[path.resolve('.'),'--cli'];
 const report={packaged,executable,resolvedExecutable:await realpath(executable),runtimePath:cleanEnv.PATH,scenarios:[],screenshots:[],timing:{},memory:[]};const apps=[];
 const run=async(args,{cwd=fixture.cwd,home=fixture.home,brokenPipe=false}={})=>{
  const child=spawn(executable,[...prefix,...args],{cwd,env:{...cleanEnv,HOME:home},stdio:['ignore','pipe','pipe']});
  const output=[];let stderr='';const timer=setTimeout(()=>child.kill('SIGKILL'),90_000);
  if(brokenPipe)child.stdout.destroy();else child.stdout.on('data',bytes=>output.push(bytes));child.stderr.on('data',bytes=>stderr+=bytes);
  const result=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',(code,signal)=>resolve({code,signal,stdout:Buffer.concat(output),stderr}));});clearTimeout(timer);return result;
 };
 const inspect=async bytes=>{
  assert.equal(Buffer.from(bytes).subarray(0,5).toString(),'%PDF-');const loading=getDocument({data:new Uint8Array(bytes),isEvalSupported:false});const pdf=await loading.promise;
  const pages=[];for(let number=1;number<=pdf.numPages;number++){const page=await pdf.getPage(number);const content=await page.getTextContent();pages.push({text:content.items.map(item=>item.str??'').join(' '),items:content.items.filter(item=>'str'in item),view:page.view,annotations:await page.getAnnotations()});}
  const operators=await (await pdf.getPage(1)).getOperatorList();const colors=[];for(let index=0;index<operators.fnArray.length;index++){if(operators.fnArray[index]===OPS.setFillRGBColor)colors.push(operators.argsArray[index]);}
  const outline=await pdf.getOutline();await loading.destroy();return {pages,outline,colors};
 };
 const render=async(source,args=[],options)=>{const result=await run(['r',source,...args],options);assert.equal(result.code,0,result.stderr);return result;};
 try{
  const mainPath=path.join(artifacts,'main.pdf');await render(fixture.source,['--config',fixture.explicit,'-o',mainPath]);const main=await inspect(await readFile(mainPath));
  assert(main.pages.length>=3);const bookmarks=[...(main.outline??[])];for(let index=0;index<bookmarks.length;index++)bookmarks.push(...(bookmarks[index].items??[]));for(const title of ['Technical notes','Level two','Level three','Level four','Level five','Level six','Last section'])assert(bookmarks.some(bookmark=>bookmark.title.includes(title)));const duplicates=bookmarks.filter(bookmark=>bookmark.title.includes('Technical notes'));assert.equal(duplicates.length,2);assert.notDeepEqual(duplicates[0].dest,duplicates[1].dest);assert(main.pages.every(page=>page.text.includes('Engineering')&&page.text.includes('Explicit')&&page.text.includes('technical notes.md')&&!page.text.includes('WRONG_DOCUMENT_DIRECTORY')));
  assert(main.colors.some(args=>args[0]==='#183153'||(Array.isArray(args[0])&&args[0].join(',')==='24,49,83')||args.join(',')==='24,49,83'),'Frontmatter body color is absent from the generated PDF operators: '+JSON.stringify(main.colors));
  assert(main.pages[0].text.includes('1 / '+main.pages.length));assert(main.pages.at(-1).text.includes(main.pages.length+' / '+main.pages.length));
  assert(main.pages.findIndex(page=>page.text.includes('AFTER_BREAK'))>0);assert(main.pages.some(page=>page.text.includes(':::pagebreak')));assert(main.pages.some(page=>page.text.includes('GFM endnote')));
  for(const page of main.pages)for(const item of page.items)if(item.str.trim())assert(item.transform[4]+item.width<=page.view[2]-20*72/25.4+1,'Text overflows the printable right margin: '+JSON.stringify({text:item.str,x:item.transform[4],width:item.width,page:page.view}));
  assert(main.pages.flatMap(page=>page.annotations).some(annotation=>annotation.url==='https://example.com/'));assert(main.pages.flatMap(page=>page.annotations).some(annotation=>annotation.dest));
  const pdfBytes=await readFile(mainPath);assert(/SourceSans3/.test(pdfBytes.toString('latin1')));assert(/SourceCodePro/.test(pdfBytes.toString('latin1')));
  const {createCanvas}=createRequire(import.meta.resolve('pdfjs-dist/package.json'))('@napi-rs/canvas');
  const independent=getDocument({data:new Uint8Array(pdfBytes),isEvalSupported:false});const opened=await independent.promise;
  for(let number=1;number<=opened.numPages;number++){const page=await opened.getPage(number),viewport=page.getViewport({scale:1.5}),canvas=createCanvas(Math.ceil(viewport.width),Math.ceil(viewport.height));await page.render({canvas,canvasContext:canvas.getContext('2d'),viewport}).promise;const name=`independent-page-${number}.png`;await writeFile(path.join(artifacts,name),canvas.toBuffer('image/png'));report.screenshots.push(name);}
  await independent.destroy();
  report.scenarios.push('layered frontmatter/header/logo/font origins, all heading levels/outline, endnotes and links, code/math/Mermaid/images, page break and counters');
  const alignmentSvg=path.join(root,'alignment.svg'),alignmentPng=path.join(root,'alignment.png');
  await writeFile(alignmentSvg,'<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><rect width="100" height="100" fill="#ff00ff"/></svg>');
  const square=createCanvas(100,100),squareContext=square.getContext('2d');squareContext.fillStyle='#ff00ff';squareContext.fillRect(0,0,100,100);await writeFile(alignmentPng,square.toBuffer('image/png'));
  for(const position of ['left','center','right']){
   const source=path.join(root,`alignment-${position}.md`),output=path.join(artifacts,`alignment-${position}.pdf`);
   const rows=[['header',alignmentSvg],['footer',alignmentPng]];
   await writeFile(source,'+++\n'+rows.map(([row,logo])=>`[${row}]\nleft=""\ncenter=""\nright=""\n[${row}.logo]\npath=${JSON.stringify(logo)}\nposition="${position}"\nwidth="18mm"\nheight="8mm"\n`).join('')+'+++\n# Logo alignment\n');
   await render(source,['-o',output]);
   const loading=getDocument({data:new Uint8Array(await readFile(output)),isEvalSupported:false}),pdf=await loading.promise;
   try{
    const page=await pdf.getPage(1),viewport=page.getViewport({scale:1.5}),canvas=createCanvas(Math.ceil(viewport.width),Math.ceil(viewport.height));
    await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise;
    const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data,margin=20*72/25.4*1.5,logoSize=8*72/25.4*1.5;
    const expectedLeft=position==='left'?margin:position==='right'?viewport.width-margin-logoSize:(viewport.width-logoSize)/2;
    for(const [row] of rows){
     let minX=canvas.width,maxX=-1,minY=canvas.height,maxY=-1;
     const from=row==='header'?0:Math.floor(viewport.height-margin),to=row==='header'?Math.ceil(margin):canvas.height;
     for(let y=from;y<to;y++)for(let x=0;x<canvas.width;x++){
      const offset=(y*canvas.width+x)*4;
      if(pixels[offset]>200&&pixels[offset+1]<60&&pixels[offset+2]>200){minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);}
     }
     assert(Math.abs(minX-expectedLeft)<=2,`${row} ${position} logo left edge: expected ${expectedLeft}, got ${minX}`);
     assert(Math.abs(maxX-minX+1-logoSize)<=2&&Math.abs(maxY-minY+1-logoSize)<=2,`${row} ${position} logo was cropped or stretched`);
    }
    await writeFile(path.join(artifacts,`alignment-${position}.png`),canvas.toBuffer('image/png'));
   }finally{await loading.destroy();}
  }
  report.scenarios.push('left/center/right logo artwork alignment and preserved aspect ratio in SVG headers and raster footers');
  await exerciseMermaid({root,artifacts,render,inspect,createCanvas,report});
  const mathPath=path.join(artifacts,'mathjax.pdf');await render(fixture.mathSource,['-o',mathPath]);const mathBytes=await readFile(mathPath),mathPdf=await inspect(mathBytes);
  assert(mathPdf.pages.some(page=>page.text.includes('MATHTOOLS')));assert(mathPdf.colors.some(args=>args[0]==='#183153'||args.join(',')==='24,49,83'),'Math color missing from PDF');
  const mathLoading=getDocument({data:new Uint8Array(mathBytes),isEvalSupported:false}),mathDocument=await mathLoading.promise;
  for(let number=1;number<=mathDocument.numPages;number++){const page=await mathDocument.getPage(number),viewport=page.getViewport({scale:1.5}),canvas=createCanvas(Math.ceil(viewport.width),Math.ceil(viewport.height));await page.render({canvas,canvasContext:canvas.getContext('2d'),viewport}).promise;const name=`mathjax-page-${number}.png`;await writeFile(path.join(artifacts,name),canvas.toBuffer('image/png'));report.screenshots.push(name);}
  await mathLoading.destroy();
  const badMath=path.join(root,'invalid math.md'),badOutput=path.join(root,'invalid math.pdf'),oldMath=Buffer.from('UNCHANGED MATH OUTPUT');await writeFile(badOutput,oldMath);
  for(const expression of ['\\DefinitelyNotADocmMacro','\\input{/etc/passwd}','\\write18{touch forbidden}','\\require{html}','\\def\\loop{\\loop}\\loop']){
    await writeFile(badMath,'# Invalid math\n\n$'+expression+'$\n');const result=await run(['r',badMath,'-o',badOutput]);assert.equal(result.code,1,result.stderr);assert(result.stderr.includes(badMath+':3:'));assert.deepEqual(await readFile(badOutput),oldMath);
  }
  report.scenarios.push('offline MathJax SVG fractions/baselines, integrals, AMS/mathtools, parameter macros, extra font ranges, text/color; unsupported executable/package commands and recursive expansion refuse output with source diagnostics');
  await render(fixture.plain);await inspect(await readFile(fixture.plain.replace(/\.md$/,'.pdf')));
  const stdout=await render(fixture.source,['--config',fixture.explicit,'-o','-']);await inspect(stdout.stdout);assert.equal(stdout.stdout.subarray(0,5).toString(),'%PDF-');report.scenarios.push('adjacent, explicit and clean stdout PDF outputs');
  const isolated=path.join(root,'isolated'),emptyHome=path.join(root,'empty home');await mkdir(isolated);await mkdir(emptyHome);
  const defaultsPath=path.join(artifacts,'defaults.pdf');await render(fixture.plain,['-o',defaultsPath],{cwd:isolated,home:emptyHome});const defaults=await inspect(await readFile(defaultsPath));assert(!defaults.pages[0].text.includes('Engineering'));assert(defaults.pages[0].text.includes('1 / 1'));
  for(const source of [fixture.plain,fixture.source]){const output=path.join(root,path.basename(source)+'.global.pdf');await render(source,['-o',output],{cwd:isolated});const globalOnly=await inspect(await readFile(output));assert(globalOnly.pages.every(page=>page.text.includes('Engineering')));}
  const duplicateOutput=path.join(root,'duplicate.pdf');await render(fixture.plain,['--config',fixture.globalTheme,'-o',duplicateOutput]);const duplicate=await inspect(await readFile(duplicateOutput));assert(duplicate.pages[0].text.includes('Engineering'));
  report.scenarios.push('default-only, invocation A not document B, global-only on two documents, explicit duplicate automatic layer');
  const toggle=path.join(root,'toggle.md'),toggleOutput=path.join(root,'toggle.pdf');
  await writeFile(toggle,'+++\n[header]\nenabled=false\n[footer]\nenabled=false\n+++\n# Decorations disabled\n');await render(toggle,['-o',toggleOutput]);const disabled=await inspect(await readFile(toggleOutput));assert(!disabled.pages[0].text.includes('Engineering'));assert(!disabled.pages[0].text.includes('1 / 1'));
  await writeFile(toggle,'+++\n[header]\nleft="A fitting wrapped header with a deliberate\\nsecond line"\ncenter=""\nlogo=false\n+++\n# Wrapped header\n');await render(toggle,['-o',toggleOutput]);const wrapped=await inspect(await readFile(toggleOutput));assert(wrapped.pages[0].text.includes('second line'));
  await writeFile(toggle,'+++\n[header]\nenabled=false\n[footer]\nenabled=false\n[code]\nline_numbers=true\n+++\n```text\nalpha\nbeta\n```\n');await render(toggle,['-o',toggleOutput]);const numbered=await inspect(await readFile(toggleOutput));assert(!/(?:^| )1(?: |$)|(?:^| )2(?: |$)/.test(numbered.pages[0].text),'Code line numbers became selectable/copied PDF text: '+numbered.pages[0].text);
  await copyFile(toggleOutput,path.join(artifacts,'numbered-code.pdf'));const numberedLoading=getDocument({data:new Uint8Array(await readFile(toggleOutput)),isEvalSupported:false}),numberedPdf=await numberedLoading.promise,numberedPage=await numberedPdf.getPage(1),numberedViewport=numberedPage.getViewport({scale:1.5}),numberedCanvas=createCanvas(Math.ceil(numberedViewport.width),Math.ceil(numberedViewport.height));await numberedPage.render({canvas:numberedCanvas,canvasContext:numberedCanvas.getContext('2d'),viewport:numberedViewport}).promise;await writeFile(path.join(artifacts,'numbered-code.png'),numberedCanvas.toBuffer('image/png'));await numberedLoading.destroy();report.screenshots.push('numbered-code.png');
  const sentinel=Buffer.from('OLD PDF SENTINEL');await writeFile(toggleOutput,sentinel);
  await writeFile(toggle,'+++\n[header]\nleft="'+('overflow\\n'.repeat(30))+'"\n+++\n# Overflow\n');const overflow=await run(['r',toggle,'-o',toggleOutput]);assert.equal(overflow.code,1);assert(/header.*overflows/.test(overflow.stderr));assert.deepEqual(await readFile(toggleOutput),sentinel);
  for(const [args,code] of [[['r',fixture.source,'-o',path.join(root,'absent','out.pdf')],1],[['r',fixture.source,'-o',fixture.source],1],[['r',fixture.source,'--config',path.join(root,'missing.toml')],1],[['r'],2],[['r',fixture.source,'extra'],2],[[fixture.source,'-o','x.pdf'],2]]){const result=await run(args);assert.equal(result.code,code,result.stderr);}
  const originalGlobal=await readFile(fixture.globalTheme);await writeFile(fixture.globalTheme,'[body]\nunknown=true\n');const malformed=await run(['r',fixture.plain]);assert.equal(malformed.code,1);await writeFile(fixture.globalTheme,originalGlobal);
  report.scenarios.push('cleared/disabled decorations and logo, fitting wrap, overflow preserves output, unsafe output/missing parent/config/invalid theme and CLI exit codes');

  await exercisePreview({fixture,root,artifacts,executable,packaged,prefix,cleanEnv,apps,report,inspect});
  const longStdout=await run(['r',fixture.longSource,'-o','-'],{brokenPipe:true});assert.notEqual(longStdout.code,0);report.scenarios.push('broken stdout pipe is a handled nonzero exit');
  await writeFile(path.join(artifacts,'report.json'),JSON.stringify(report,null,2)+'\n');console.error(JSON.stringify(report,null,2));
 }catch(error){for(let index=0;index<apps.length;index++){try{for(const page of apps[index].windows()){console.error('[smoke surface]',JSON.stringify(await page.evaluate(()=>({status:document.querySelector('#preview-status')?.textContent,kind:document.querySelector('#preview-status')?.dataset.kind,page:document.querySelector('#page-number')?.value,zoom:document.querySelector('#zoom-percentage')?.textContent,updates:window.__docmSmoke?.updates.slice(-8)}))));await page.screenshot({path:path.join(artifacts,`failure-${index}.png`)});}}catch{}}throw error;
 }finally{for(const app of apps){try{await app.close();}catch{}}await rm(root,{recursive:true,force:true});}
 return report;
}

async function exerciseMermaid({root,artifacts,render,inspect,createCanvas,report}){
 const scale=2,margin=20*72/25.4;
 const common='[header]\nenabled=false\n[footer]\nenabled=false\n[paragraph]\nspace_before=0\nspace_after=0\n';
 const diagram='```mermaid\nflowchart LR\n A["SIZING WWW"]:::probe\n classDef probe fill:#e000e0,stroke:#e000e0\n```\n';
 // Keep the reference and sized charts identical: colored PDF artwork, not
 // invisible SVG dimensions, is the consumer-visible aspect/scale oracle.
 const probe=async(name,settings,body)=>{
  const source=path.join(root,`${name}.md`),destination=path.join(artifacts,`${name}.pdf`);
  await writeFile(source,`+++\n${common}${settings}\n+++\n${body}`);
  await render(source,['-o',destination],{cwd:root,home:root});
  const bytes=await readFile(destination),metadata=await inspect(bytes),loading=getDocument({data:new Uint8Array(bytes),isEvalSupported:false}),pdf=await loading.promise,pages=[];
  try{
   for(let number=1;number<=pdf.numPages;number++){
    const page=await pdf.getPage(number),viewport=page.getViewport({scale}),canvas=createCanvas(Math.ceil(viewport.width),Math.ceil(viewport.height)),context=canvas.getContext('2d');
    await page.render({canvas,canvasContext:context,viewport}).promise;
    const filename=`${name}-page-${number}.png`;await writeFile(path.join(artifacts,filename),canvas.toBuffer('image/png'));report.screenshots.push(filename);
    pages.push({...metadata.pages[number-1],width:canvas.width,height:canvas.height,pixels:context.getImageData(0,0,canvas.width,canvas.height).data});
   }
  }finally{await loading.destroy();}
  return pages;
 };
 const bounds=page=>{
  let left=page.width,right=-1,top=page.height,bottom=-1;
  for(let y=0;y<page.height;y++)for(let x=0;x<page.width;x++){
   const offset=(y*page.width+x)*4;
   if(page.pixels[offset]>180&&page.pixels[offset+1]<60&&page.pixels[offset+2]>180){left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);}
  }
  assert(right>=left,'Mermaid sizing probe is absent from PDF pixels');
  return {left:left/scale,right:(right+1)/scale,top:top/scale,bottom:(bottom+1)/scale,width:(right-left+1)/scale,height:(bottom-top+1)/scale};
 };
 const base='[mermaid]\nfont="sans"\nfont_size="11pt"\npadding=0\nspace_before=0\nspace_after=0\n';
 const [naturalPage]=await probe('mermaid-natural',base,diagram),natural=bounds(naturalPage);
 const tall='```mermaid\nflowchart TB\n A["SIZING WWW"] --> B["SIZING WWW"] --> C["SIZING WWW"] --> D["SIZING WWW"] --> E["SIZING WWW"] --> F["SIZING WWW"] --> G["SIZING WWW"] --> H["SIZING WWW"]\n classDef default fill:#e000e0,stroke:#e000e0\n```\n';
 const sized=await probe('mermaid-sizes',base+'width="48pt"\n[mermaid.charts.2]\nwidth="192pt"\n[mermaid.charts.4]\nwidth="144pt"\nheight="24pt"\n[mermaid.charts.5]\nwidth="9999pt"\nheight="9999pt"\n',
  '```text\nNOT A MERMAID CHART\n```\n\n'+diagram+'\n:::pagebreak\n\n```javascript\nconst unrelated = 2;\n```\n\n'+diagram+'\n:::pagebreak\n\n'+diagram+'\n:::pagebreak\n\n'+diagram+'\n:::pagebreak\n\n'+tall);
 assert.equal(sized.length,5,'Sized Mermaid fixture unexpectedly paginated');
 const measured=sized.map(bounds),[small,large,following,bounded,printable]=measured;
 assert(small.width<natural.width-5&&large.width>natural.width+20,'Explicit Mermaid widths must shrink and enlarge natural artwork');
 assert(Math.abs(large.width/small.width-4)<.08&&Math.abs(large.height/small.height-4)<.15,'Chart 2 width override did not scale uniformly, or non-Mermaid fences counted as charts');
 assert(Math.abs(following.width-small.width)<=1&&Math.abs(following.height-small.height)<=1,'Chart 2 dimensions leaked into chart 3');
 const aspect=natural.width/natural.height;
 for(const box of [small,large,following,bounded])assert(Math.abs(box.width/box.height/aspect-1)<.06,'Mermaid artwork was stretched: '+JSON.stringify(box));
 assert(bounded.width<=145&&bounded.height<=25&&bounded.height<natural.height-2&&bounded.height>10,'Width/height bounding box did not shrink the artwork to its tighter height');
 for(let index=0;index<sized.length;index++){
  const page=sized[index],box=measured[index];
  assert(box.left>=margin-1&&box.right<=page.view[2]-margin+1&&box.top>=margin-1&&box.bottom<=page.view[3]-margin+1,'Mermaid artwork escaped printable area: '+JSON.stringify(box));
 }
 assert(printable.height>sized[4].view[3]-2*margin-25,'Oversized tall Mermaid did not enlarge to the printable height limit');
 const [heightPage]=await probe('mermaid-height',base+'height="72pt"\n',diagram),heightOnly=bounds(heightPage);
 assert(heightOnly.height>natural.height+15&&heightOnly.height<=73,'Global height-only Mermaid size did not enlarge the artwork');
 assert(Math.abs(heightOnly.width/heightOnly.height/aspect-1)<.04,'Height-only Mermaid sizing stretched the artwork');

 const styleSettings='[mermaid]\nfont="sans"\nfont_size="11pt"\ntheme="neutral"\nbackground="#ffeecc"\npadding="3pt"\nspace_before="4pt"\nspace_after="4pt"\n[mermaid.charts.2]\nfont="mono"\nfont_size="18pt"\ntheme="dark"\nbackground="#cceeff"\npadding="12pt"\nspace_before="24pt"\nspace_after="20pt"\n';
 const styleDiagram='```mermaid\nflowchart LR\n A["MMMM iii"]\n```\n';
 const styles=await probe('mermaid-styles',styleSettings,[1,2,3].map(number=>`BEFORE${number}\n\n${styleDiagram}\nAFTER${number}\n`).join('\n'));
 assert.equal(styles.length,1,'Mermaid style-isolation fixture should fit one page');
 const page=styles[0],labels=page.items.filter(item=>item.str.includes('MMMM'));
 assert.equal(labels.length,3,'Mermaid labels are not independently selectable PDF text');
 assert(Math.abs(labels[0].width-labels[2].width)<.5&&Math.abs(labels[0].height-labels[2].height)<.5,'Chart-specific font or size leaked into the following Mermaid chart');
 assert(labels[1].height>labels[0].height*1.4&&Math.abs(labels[1].width/labels[1].height/labels[1].str.length-.6)<.02&&labels[1].fontName!==labels[0].fontName,'Chart-specific mono font and font size are absent from PDF text geometry');
 const rgb=(x,y)=>{const offset=(Math.floor(y)*page.width+Math.floor(x))*4;return Array.from(page.pixels.subarray(offset,offset+3));};
 const near=(actual,expected)=>actual.every((value,index)=>Math.abs(value-expected[index])<=8);
 const bands=color=>{
  const found=[];let start=-1;
  for(let y=0;y<=page.height;y++){
   const matches=y<page.height&&near(rgb((margin+1)*scale,y),color);
   if(matches&&start<0)start=y;
   if(!matches&&start>=0){if(y-start>3)found.push({top:start/scale,bottom:y/scale,height:(y-start)/scale});start=-1;}
  }
  return found;
 };
 const globalBands=bands([255,238,204]),overrideBands=bands([204,238,255]);
 assert.equal(globalBands.length,2,'Global Mermaid background must return after chart 2');assert.equal(overrideBands.length,1,'Chart-specific background must affect only chart 2');
 const boxes=[globalBands[0],overrideBands[0],globalBands[1]],nodeHeights=[];
 for(let index=0;index<labels.length;index++){
  const label=labels[index],box=boxes[index],x=(label.transform[4]-4)*scale,y=(page.view[3]-label.transform[5]-label.height*.3)*scale,color=rgb(x,y);
  assert(index===1?color.every(channel=>channel<100):color.every(channel=>channel>180),'Chart-specific dark theme leaked or was not applied: '+JSON.stringify(color));
  let top=page.height,bottom=-1;
  for(let row=Math.ceil(box.top*scale);row<Math.floor(box.bottom*scale);row++)if(near(rgb(x,row),color)){top=Math.min(top,row);bottom=Math.max(bottom,row);}
  assert(bottom>=top,'Mermaid node fill missing inside its background');nodeHeights.push((bottom-top+1)/scale);
  const before=page.items.find(item=>item.str===`BEFORE${index+1}`),after=page.items.find(item=>item.str===`AFTER${index+1}`);
  assert(before&&after,'Mermaid spacing markers missing from PDF text');
  box.before=box.top-(page.view[3]-before.transform[5]);box.after=(page.view[3]-after.transform[5])-box.bottom;
 }
 assert(Math.abs((boxes[1].height-nodeHeights[1])-(boxes[0].height-nodeHeights[0])-18)<3,'Chart-specific padding did not add 9pt on each edge');
 assert(Math.abs(boxes[0].height-boxes[2].height)<1,'Chart-specific padding leaked into the following chart');
 assert(Math.abs(boxes[1].before-boxes[0].before-20)<2&&Math.abs(boxes[1].after-boxes[0].after-16)<2,'Chart-specific before/after spacing missing from measured PDF layout');
 assert(Math.abs(boxes[2].before-boxes[0].before)<1&&Math.abs(boxes[2].after-boxes[0].after)<1,'Chart-specific spacing leaked into the following chart');
 report.scenarios.push('Mermaid-only chart numbering through unrelated fences; global width/height enlargement and shrinkage, bounded box aspect preservation and printable-height cap; isolated per-chart themes/fonts/background/padding/spacing measured from PDF pixels and selectable text');
}

async function exercisePreview(context){
 const {fixture,root,artifacts,executable,packaged,prefix,cleanEnv,apps,report,inspect}=context;
 // The CLI scenarios exercise the actual launcher. Its prepended --cli marker
 // intentionally keeps user arguments intact, so Playwright's debug switches
 // must instead precede --cli on the same packaged native executable.
 const previewExecutable=packaged?path.resolve(path.dirname(await realpath(executable)),'../../MacOS/docm'):executable;
 const previewPrefix=packaged?['--cli']:prefix;
 report.cliExecutable=executable;report.previewExecutable=previewExecutable;
 const launch=async(source,args=[])=>{const application=await electronDriver.launch({executablePath:previewExecutable,args:[...previewPrefix,source,...args],cwd:fixture.cwd,env:cleanEnv,timeout:30_000});apps.push(application);const page=await application.firstWindow();page.on('pageerror',error=>console.error('[preview]',error));return {application,page};};
 const waitGood=async(page)=>{await page.locator('.textLayer').first().waitFor({timeout:60_000});await page.waitForFunction(()=>document.querySelectorAll('.textLayer span').length>0,{},{timeout:60_000});};
 const first=await launch(fixture.source,['--config',fixture.explicit]);await waitGood(first.page);
 await first.page.evaluate(()=>{window.__docmSmoke={latest:null,updates:[]};window.docm.onUpdate(update=>{window.__docmSmoke.updates.push({revision:update.revision,status:'status'in update?update.status:'pdf'});if('pdf'in update)window.__docmSmoke.latest={revision:update.revision,bytes:Array.from(update.pdf)};});});
 await first.page.screenshot({path:path.join(artifacts,'preview-main.png')});report.screenshots.push('preview-main.png');
 await first.application.evaluate(({shell})=>{globalThis.docmSmokeOpenExternal=shell.openExternal;globalThis.docmSmokeUrls=[];shell.openExternal=async url=>{globalThis.docmSmokeUrls.push(url);};});
 try{await first.page.locator('.annotationLayer a[href="https://example.com/"]').click();assert.deepEqual(await first.application.evaluate(()=>globalThis.docmSmokeUrls),['https://example.com/']);}finally{await first.application.evaluate(({shell})=>{shell.openExternal=globalThis.docmSmokeOpenExternal;delete globalThis.docmSmokeOpenExternal;delete globalThis.docmSmokeUrls;});}
 const internal=first.page.locator('.annotationLayer [data-internal-link] a').nth(7);await internal.click();await first.page.waitForFunction(()=>document.querySelector('#page-number').value===document.querySelector('#page-count').textContent.replace('of ',''));assert.equal(first.page.url(),'docm://bundle/preview/index.html');
 report.scenarios.push('real PDF internal link navigation and external link main-process dispatch; independent PDF-file raster opening');
 await first.page.getByRole('button',{name:/zoom in/i}).click();const zoomBefore=await first.page.getByRole('button',{name:/fit width/i}).count();assert(zoomBefore>0);
 await first.page.getByRole('button',{name:/fit page/i}).click();await first.page.getByRole('button',{name:/fit width/i}).click();
 await first.page.getByRole('button',{name:/zoom in/i}).click();await first.page.getByRole('spinbutton',{name:'Page number'}).fill('2');await first.page.getByRole('spinbutton',{name:'Page number'}).press('Enter');
 await first.page.evaluate(()=>{const container=document.querySelector('#viewer-container'),bounds=document.querySelector('.page[data-page-number="2"]').getBoundingClientRect();container.scrollTop+=bounds.top-container.getBoundingClientRect().top-container.clientTop+bounds.height*.3;});await first.page.waitForFunction(()=>document.querySelector('#page-number').value==='2');
 const fraction=await first.page.evaluate(()=>{const container=document.querySelector('#viewer-container'),bounds=document.querySelector('.page[data-page-number="2"]').getBoundingClientRect();return (container.getBoundingClientRect().top+container.clientTop-bounds.top)/bounds.height;});
 const position=await first.page.evaluate(()=>({page:document.querySelector('#page-number').value,zoom:document.querySelector('#zoom-percentage').textContent}));
 await first.page.waitForFunction(()=>window.__docmSmoke.latest!==null);const initialRevision=await first.page.evaluate(()=>window.__docmSmoke.latest.revision);
 await writeFile(fixture.source,fixture.markdown+'\nLATEST_REVISION\n');await first.page.waitForFunction(revision=>window.__docmSmoke.latest?.revision>revision,initialRevision,{timeout:60_000});
 const current=await first.page.evaluate(()=>window.__docmSmoke.latest);assert((await inspect(Buffer.from(current.bytes))).pages.some(page=>page.text.includes('LATEST_REVISION')));
 await first.page.waitForFunction(()=>document.querySelector('#preview-status').dataset.kind==='ready');
 assert.deepEqual(await first.page.evaluate(()=>({page:document.querySelector('#page-number').value,zoom:document.querySelector('#zoom-percentage').textContent})),position);
 const replacementFraction=await first.page.evaluate(()=>{const container=document.querySelector('#viewer-container'),bounds=document.querySelector('.page[data-page-number="2"]').getBoundingClientRect();return (container.getBoundingClientRect().top+container.clientTop-bounds.top)/bounds.height;});assert(Math.abs(replacementFraction-fraction)<.005,`Within-page reading position changed: ${fraction} -> ${replacementFraction}`);
 await writeFile(fixture.source,'+++\n[body]\nnot_valid=true\n+++\n# Invalid\n');await first.page.waitForFunction(()=>window.__docmSmoke.updates.at(-1)?.status==='error',{},{timeout:60_000});assert.equal(await first.page.evaluate(()=>window.__docmSmoke.latest.revision),current.revision);
 await first.page.screenshot({path:path.join(artifacts,'preview-stale.png')});report.screenshots.push('preview-stale.png');
 const temp=fixture.source+'.save';await writeFile(temp,fixture.markdown+'\nATOMIC_RECOVERY\n');await rename(temp,fixture.source);await first.page.waitForFunction(revision=>window.__docmSmoke.latest?.revision>revision,current.revision,{timeout:60_000});
 const beforeBurst=await first.page.evaluate(()=>window.__docmSmoke.latest.revision);for(let index=0;index<6;index++)await writeFile(fixture.source,fixture.markdown+'\nBURST_'+index+'\n');await first.page.waitForFunction(revision=>window.__docmSmoke.latest?.revision>revision&&window.__docmSmoke.updates.at(-1)?.status==='pdf',beforeBurst,{timeout:60_000});
 const burst=await first.page.evaluate(()=>window.__docmSmoke.latest);assert((await inspect(Buffer.from(burst.bytes))).pages.some(page=>page.text.includes('BURST_5')));
 await rm(fixture.source);await first.page.waitForFunction(()=>window.__docmSmoke.updates.at(-1)?.status==='error',{},{timeout:60_000});await writeFile(fixture.source,fixture.markdown);await first.page.waitForFunction(revision=>window.__docmSmoke.latest?.revision>revision,burst.revision,{timeout:60_000});
 const changeAndRecover=async(change)=>{const previous=await first.page.evaluate(()=>window.__docmSmoke.latest.revision);await change();await first.page.waitForFunction(revision=>window.__docmSmoke.latest?.revision>revision,previous,{timeout:60_000});await first.page.waitForFunction(()=>document.querySelector('#preview-status').dataset.kind==='ready',{},{timeout:60_000});return await first.page.evaluate(()=>window.__docmSmoke.latest);};
 const changeAndFail=async(change)=>{const previous=await first.page.evaluate(()=>window.__docmSmoke.latest.revision);await change();await first.page.waitForFunction(revision=>window.__docmSmoke.updates.at(-1)?.status==='error'&&window.__docmSmoke.updates.at(-1)?.revision>revision,previous,{timeout:60_000});assert.equal(await first.page.evaluate(()=>window.__docmSmoke.latest.revision),previous);};
 const removedGlobal=await changeAndRecover(()=>rm(fixture.globalTheme));assert(!(await inspect(Buffer.from(removedGlobal.bytes))).pages[0].text.includes('Engineering'));
 await changeAndRecover(()=>writeFile(fixture.globalTheme,fixture.globalText));
 await changeAndRecover(()=>rm(fixture.cwdTheme));await changeAndRecover(()=>writeFile(fixture.cwdTheme,fixture.cwdText));
 const explicitEdit=await changeAndRecover(()=>writeFile(fixture.explicit,fixture.explicitText.replace('Explicit','THEME_CHANGED')));assert((await inspect(Buffer.from(explicitEdit.bytes))).pages[0].text.includes('THEME_CHANGED'));
 await changeAndFail(()=>rm(fixture.explicit));await changeAndRecover(()=>writeFile(fixture.explicit,fixture.explicitText));
 const imageBytes=await readFile(fixture.image),logoBytes=await readFile(fixture.logo),fontBytes=await readFile(fixture.font);
 await changeAndRecover(()=>writeFile(fixture.image,imageBytes.toString().replace('Authorized local image','Changed local image')));
 await changeAndFail(()=>rename(fixture.logo,fixture.logo+'.held'));await changeAndRecover(()=>rename(fixture.logo+'.held',fixture.logo));
 await changeAndRecover(()=>writeFile(fixture.logo,logoBytes.toString().replace('#204060','#256340')));
 await first.page.screenshot({path:path.join(artifacts,'preview-assets-changed.png')});report.screenshots.push('preview-assets-changed.png');
 await changeAndFail(()=>writeFile(fixture.font,Buffer.from('corrupt font')));await changeAndRecover(()=>writeFile(fixture.font,fontBytes));
 await changeAndFail(()=>writeFile(fixture.source,fixture.markdown+'\n$\\DefinitelyNotADocmMacro$\n'));await changeAndRecover(()=>writeFile(fixture.source,fixture.markdown));
 await changeAndFail(()=>writeFile(fixture.source,fixture.markdown+'\n```mermaid\nnot-a-mermaid-diagram\n```\n'));await changeAndRecover(()=>writeFile(fixture.source,fixture.markdown));
 await changeAndRecover(()=>writeFile(fixture.image,imageBytes));await changeAndRecover(()=>writeFile(fixture.logo,logoBytes));
 report.scenarios.push('automatic theme deletion/creation, cwd/explicit theme edits and explicit deletion repair, image/logo/font edits and missing/corrupt asset repair, invalid math/Mermaid retention and recovery, page/zoom preservation');
 const second=await launch(fixture.plain);await waitGood(second.page);await second.page.evaluate(()=>{window.__docmSmoke={latest:null,updates:[]};window.docm.onUpdate(update=>{if('pdf'in update)window.__docmSmoke.latest={revision:update.revision,bytes:Array.from(update.pdf)};});});
 await second.page.waitForFunction(()=>window.__docmSmoke.latest!==null);const secondBefore=await second.page.evaluate(()=>window.__docmSmoke.latest.revision);
 const before=await first.page.evaluate(()=>window.__docmSmoke.latest.revision);await writeFile(fixture.globalTheme,fixture.globalText.replace('Engineering','GLOBAL_CHANGED'));
 await first.page.waitForFunction(revision=>window.__docmSmoke.latest?.revision>revision,before,{timeout:60_000});await second.page.waitForFunction(revision=>window.__docmSmoke.latest?.revision>revision,secondBefore,{timeout:60_000});
 for(const page of [first.page,second.page]){const latest=await page.evaluate(()=>window.__docmSmoke.latest);assert((await inspect(Buffer.from(latest.bytes))).pages.some(page=>page.text.includes('GLOBAL_CHANGED')));}
 await writeFile(fixture.globalTheme,fixture.globalText);await second.application.close();apps.splice(apps.indexOf(second.application),1);
 report.scenarios.push('actual preview controls/selectable text, stale/error retention, atomic save, burst latest revision, deletion/recreation, shared global edit updates separate windows');

 const largeStart=performance.now();const large=await launch(fixture.longSource);await waitGood(large.page);report.timing.startup200Ms=performance.now()-largeStart;
 await large.page.evaluate(()=>{window.__docmSmoke={latest:null,updates:[]};window.docm.onUpdate(update=>{if('pdf'in update)window.__docmSmoke.latest={revision:update.revision,bytes:Array.from(update.pdf)};});});
 const memory=async()=>await large.application.evaluate(async({app})=>({main:await process.getProcessMemoryInfo(),processes:app.getAppMetrics().map(metric=>({type:metric.type,memory:metric.memory}))}));
 report.memory.push(await memory());
 for(const number of [1,100,200]){await large.page.evaluate(number=>{const target=document.querySelector(`.page[data-page-number="${number}"]`);target?.scrollIntoView();},number);await large.page.waitForFunction(number=>document.querySelector(`.page[data-page-number="${number}"] .textLayer span`),number,{timeout:60_000});await large.page.screenshot({path:path.join(artifacts,`preview-200-page-${number}.png`)});report.screenshots.push(`preview-200-page-${number}.png`);assert(await large.page.locator('canvas').count()<25);}
 const selected=await large.page.evaluate(()=>{const span=document.querySelector('.page[data-page-number="200"] .textLayer span');const range=document.createRange();range.selectNodeContents(span);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);return selection.toString();});assert(selected.length>0);
 await large.page.getByRole('button',{name:/zoom in/i}).click();await large.page.getByRole('button',{name:/fit width/i}).click();
 await large.page.waitForFunction(()=>window.__docmSmoke.latest!==null);const longRevision=await large.page.evaluate(()=>window.__docmSmoke.latest.revision);
 const longOriginal=await readFile(fixture.longSource,'utf8');const updateStart=performance.now();await writeFile(fixture.longSource,longOriginal+'\nLATEST_200\n');await large.page.waitForFunction(revision=>window.__docmSmoke.latest?.revision>revision,longRevision,{timeout:60_000});report.timing.rerender200Ms=performance.now()-updateStart;
 const longLatest=await large.page.evaluate(()=>window.__docmSmoke.latest);const longPdf=await inspect(Buffer.from(longLatest.bytes));assert.equal(longPdf.pages.length,200);for(const number of [1,100,200]){assert(longPdf.pages[number-1].text.includes('PAGE_'+number));assert(longPdf.pages[number-1].text.includes(number+' / 200'));}
 assert(longPdf.pages[199].text.includes('LATEST_200'));
 await writeFile(path.join(artifacts,'200-pages.pdf'),Buffer.from(longLatest.bytes));
 for(let index=0;index<12;index++){const revision=await large.page.evaluate(()=>window.__docmSmoke.latest.revision);await writeFile(fixture.longSource,longOriginal+'\nUPDATE_'+index+'\n');await large.page.waitForFunction(revision=>window.__docmSmoke.latest?.revision>revision&&document.querySelector('#preview-status').dataset.kind==='ready',revision,{timeout:60_000});assert(await large.page.locator('canvas').count()<25);report.memory.push(await memory());}
 report.scenarios.push('exactly 200 pages, first/middle/last rendering and counters, native text selection, zoom, edit responsiveness, bounded canvas buffer across repeated updates');
 await exerciseExport(large.application,large.page,path.join(artifacts,'exported-200.pdf'),fixture.longSource,longOriginal,inspect,report);
 const shrinkRevision=await large.page.evaluate(()=>window.__docmSmoke.latest.revision);await writeFile(fixture.longSource,'# Shortened\n\nOne page after shrink.\n');await large.page.waitForFunction(revision=>window.__docmSmoke.latest?.revision>revision&&document.querySelector('#preview-status').dataset.kind==='ready',shrinkRevision,{timeout:60_000});assert.equal(await large.page.locator('#page-number').inputValue(),'1');assert.equal(await large.page.locator('#page-count').textContent(),'of 1');
 const child=large.application.process();const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));child.kill('SIGINT');const stopped=await exited;assert.equal(stopped.code,130,JSON.stringify(stopped));apps.splice(apps.indexOf(large.application),1);report.scenarios.push('page-count shrink clamps navigation; terminal SIGINT exits 130');
 await exerciseExport(first.application,first.page,path.join(artifacts,'exported.pdf'),fixture.source,fixture.markdown,inspect,report);
 await first.application.close();apps.splice(apps.indexOf(first.application),1);
}

// Only the native dialog response is controlled. The real bridge, sender checks,
// snapshot revalidation, latest-revision wait and atomic write remain exercised.
// This does not claim macOS Save-panel interaction coverage.
async function exerciseExport(application,page,destination,source,markdown,inspect,report){
 await application.evaluate(({dialog})=>{globalThis.docmSmokeDialog=dialog.showSaveDialog;dialog.showSaveDialog=async()=>await new Promise(resolve=>{globalThis.docmSmokeSelect=resolve;});});
 const begin=async()=>{await page.getByRole('button',{name:'Export PDF',exact:true}).click();await application.evaluate(async()=>{while(!globalThis.docmSmokeSelect)await new Promise(resolve=>setTimeout(resolve,10));});};
 const select=async(result)=>{await application.evaluate((_,result)=>{globalThis.docmSmokeSelect(result);delete globalThis.docmSmokeSelect;},result);await page.waitForFunction(()=>!document.querySelector('#export-pdf').hasAttribute('aria-busy'),{},{timeout:60_000});};
 try{
  await begin();await select({canceled:true,filePath:undefined});assert.equal(await page.locator('#export-status').getAttribute('data-kind'),'cancelled');
  await begin();await writeFile(source,markdown+'\nEXPORT_LATEST\n');await select({canceled:false,filePath:destination});assert.equal(await page.locator('#export-status').getAttribute('data-kind'),'saved',await page.locator('#export-status').textContent());
  const bytes=await readFile(destination),latest=await page.evaluate(()=>window.__docmSmoke.latest);assert.deepEqual(bytes,Buffer.from(latest.bytes));assert((await inspect(bytes)).pages.some(page=>page.text.includes('EXPORT_LATEST')));
  await begin();await writeFile(source,'+++\n[body]\nunknown=true\n+++\n# Invalid export\n');await select({canceled:false,filePath:destination});assert.equal(await page.locator('#export-status').getAttribute('data-kind'),'error');assert.deepEqual(await readFile(destination),bytes);
  const revision=await page.evaluate(()=>window.__docmSmoke.latest.revision);await writeFile(source,markdown);await page.waitForFunction(revision=>window.__docmSmoke.latest?.revision>revision,revision,{timeout:60_000});await page.waitForFunction(()=>document.querySelector('#preview-status').dataset.kind==='ready',{},{timeout:60_000});
  await page.keyboard.press('Meta+s');await application.evaluate(async()=>{while(!globalThis.docmSmokeSelect)await new Promise(resolve=>setTimeout(resolve,10));});await select({canceled:false,filePath:source});assert.equal(await page.locator('#export-status').getAttribute('data-kind'),'error');assert.equal(await readFile(source,'utf8'),markdown);
  report.scenarios.push('Export button/Cmd-S real IPC: cancellation, latest edit while dialog is pending, exact published PDF bytes, failed latest revision preserves output, protected source refusal (dialog response controlled; native panel not automated)');
 }finally{await application.evaluate(({dialog})=>{dialog.showSaveDialog=globalThis.docmSmokeDialog;delete globalThis.docmSmokeDialog;delete globalThis.docmSmokeSelect;});}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){await runSmoke(process.argv.includes('--packaged')?{executable:path.resolve('dist/mac-arm64/Docm.app/Contents/Resources/bin/docm'),packaged:true,artifactsPath:'.build/package-smoke'}:{});}
