import {mkdir,writeFile,copyFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
export async function createFixtures(root){
 const home=join(root,'home'),cwd=join(root,'invocation A'),documents=join(root,'documents B');
 const globalDirectory=join(home,'Library','Application Support','docm');
 for(const directory of [cwd,documents,join(globalDirectory,'assets'),join(cwd,'assets')])await mkdir(directory,{recursive:true});
 const logo=join(globalDirectory,'assets','logo space.svg');
 await writeFile(logo,'<svg xmlns="http://www.w3.org/2000/svg" width="180" height="80" viewBox="0 0 180 80"><rect width="180" height="80" rx="12" fill="#204060"/><text x="90" y="54" text-anchor="middle" font-family="sans-serif" font-size="46" font-weight="700" fill="#ffffff">DM</text></svg>');
 const font=join(globalDirectory,'assets','custom font.woff2');
 await copyFile(resolve('node_modules/@fontsource/source-sans-3/files/source-sans-3-latin-400-normal.woff2'),font);
 const image=join(documents,'local image.svg');
 await writeFile(image,'<svg xmlns="http://www.w3.org/2000/svg" width="300" height="70" viewBox="0 0 300 70"><rect x="1" y="1" width="298" height="68" rx="8" fill="#e8f0fa" stroke="#204060"/><text x="150" y="43" text-anchor="middle" font-family="sans-serif" font-size="22" fill="#204060">Authorized local image</text></svg>');
 const globalTheme=join(globalDirectory,'theme.toml'),cwdTheme=join(cwd,'theme.toml'),explicit=join(cwd,'explicit.toml');
 const globalText='[fonts]\nreport="assets/custom font.woff2"\n[body]\nfont="report"\ncolor="#111111"\n[header]\nleft="Engineering"\ncenter="{{title}}"\n[header.logo]\npath="assets/logo space.svg"\nposition="left"\nwidth="18mm"\nheight="8mm"\n[footer]\nleft="Internal"\ncenter="{{page}} / {{pages}}"\n';
 const cwdText='[body]\ncolor="#222222"\n[header]\nright="CWD"\n';
 const explicitText='[body]\ncolor="#333333"\n[header]\nright="{{filename}}"\n[footer]\nleft="Explicit"\n';
 await writeFile(globalTheme,globalText);await writeFile(cwdTheme,cwdText);await writeFile(explicit,explicitText);
 await writeFile(join(documents,'theme.toml'),'[header]\nleft="WRONG_DOCUMENT_DIRECTORY"\n');
 const source=join(documents,'technical notes.md');
 const frontmatter='+++\n[body]\ncolor="#183153"\n[header]\ncenter=""\n[document]\ntoc=true\nnumber_headings=true\n[math.macros.R]\nargs=0\nbody="\\\\mathbb{R}"\n[math.macros.pair]\nargs=1\nbody="\\\\left(#1\\\\right)"\n+++\n';
 const markdown=frontmatter+'# Technical notes\n\nA report with selectable prose, **bold**, *italic*, [external](https://example.com) and [internal](#technical-notes-1). A note[^one]. Inline $x_g$ and $\\pair{\\R}$.\n\n# Technical notes\n\n## Level two\n### Level three\n#### Level four\n##### Level five\n###### Level six\n\n| Name | Value |\n| --- | ---: |\n| Native | arm64 |\n| Offline | Yes |\n\n- [x] GFM task\n\n```unknown-language\n:::pagebreak\n```\n\n```typescript\nconst report: string = "'+('A wrapped highlighted code line. '.repeat(5))+'";\n```\n\n![Local image](local%20image.svg)\n\n$$\\begin{aligned}a&=b+c\\\\d&=e\\end{aligned}$$\n\n```mermaid\nflowchart LR\n A[Markdown] --> B[Offline PDF]\n```\n\n:::pagebreak\nAFTER_BREAK\n\n```mermaid\nsequenceDiagram\n participant A as Source\n participant B as PDF\n A->>B: Render revision\n B-->>A: Same bytes\n```\n\n[^one]: GFM endnote with a backlink.\n\n:::pagebreak\n# Last section\n\nLAST_SECTION\n';
 await writeFile(source,markdown);
 const plain=join(documents,'plain.md');await writeFile(plain,'# Plain defaults\n\nDefault-only selectable text $x_g$.\n');
 const longSource=join(documents,'200 pages.md');
 const chapters=Array.from({length:200},(_,index)=>{
  const number=index+1;const representative=[1,100,200].includes(number);
  return `# Chapter ${number}\n\nPAGE_${number} — A technical report with bounded PDF-page rendering.\n\n`+(representative?'| Item | Value |\n| --- | --- |\n| Representative | Page '+number+' |\n\nInline $x_g$.\n\n```typescript\nconst page = '+number+';\n```\n\n```mermaid\nflowchart LR\n A-->B\n```\n\n':'');
 });
 await writeFile(longSource,chapters.join(':::pagebreak\n'));
 const mathSource=join(documents,'mathjax math.md');
 const mathMarkdown=String.raw`+++
[header]
enabled=false
[footer]
enabled=false
[math]
font_size="11pt"
color="#183153"
[math.macros.R]
args=0
body='\mathbb{R}'
[math.macros.pair]
args=1
body='\left(#1\right)'
+++
# MathJax 4 offline math

BASELINE: before $x_g$ after; before $X^2$ after; before $\frac{1}{\frac{x_g}{y}}$ after.

RAISED BASELINE: before $\raise1em{x}$ after.

MACROS: $\pair{\R}$ and $\mathbb{ABCXYZ}$.

INTEGRAL:

$$
\int_0^\infty e^{-x}\,dx = 1
$$

ALIGNED:

$$
\begin{aligned} a&=b+c\\ d&=e \end{aligned}
$$

MATHTOOLS:

$$
\prescript{14}{2}{\mathrm C} \qquad \begin{dcases} x^2 & x\ge0\\ -x & x<0\end{dcases}
$$

FONT RANGES:

$$
\boldsymbol{\Omega} \quad \nVdash \quad \mathfrak{ABC} \quad \mathcal{XYZ} \quad \mathbb{012}
$$

LITERAL TEXT: $\text{url(https://example.com)}$.

TEXT AND COLOR:

$$
\text{normal \textbf{bold} \textit{italic}} \quad \color{red}{x_g}
$$
`;
 await writeFile(mathSource,mathMarkdown);
 return {root,home,cwd,documents,globalDirectory,globalTheme,cwdTheme,explicit,logo,font,image,source,plain,longSource,mathSource,mathMarkdown,globalText,cwdText,explicitText,markdown};
}
