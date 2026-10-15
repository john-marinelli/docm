import mermaid from 'mermaid';
import type { MermaidConfig } from '../config/schema.js';
import type { MarkdownModel } from './model.js';
import { RenderError } from '../shared/errors.js';
import { sanitizeSvg, svgGeometry } from '../renderer/print/sanitize-svg.js';
import { cssString } from '../renderer/print/page-decoration.js';

export function mermaidFontFamily(alias: string): string {
  return cssString(alias === 'sans' ? 'Source Sans 3' : alias === 'mono' ? 'Source Code Pro' : `docm-font-${alias}`);
}

/** Typed theme settings are authoritative; diagram-authored configuration cannot override them. */
export function validateMermaidSource(code: string): void {
  if (!code.trim()) throw new Error('Mermaid diagram is empty');
  if (/%%\s*\{/.test(code) || /^\s*---(?:\r?\n|$)/.test(code)) throw new Error('Mermaid directives and configuration frontmatter are not allowed; use TOML settings');
}

export async function renderMermaid(diagram: MarkdownModel['diagrams'][number], config: MermaidConfig, fontSizePx: number): Promise<SVGSVGElement> {
  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:-100000px;top:0;visibility:hidden;pointer-events:none;';
  document.body.append(container);
  try {
    validateMermaidSource(diagram.code);
    await document.fonts.ready;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: config.theme,
      fontFamily: mermaidFontFamily(config.font),
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      themeVariables: { fontFamily: mermaidFontFamily(config.font), fontSize: `${fontSizePx}px` },
      // These security settings remain immutable even if upstream adds another directive path.
      secure: ['securityLevel', 'startOnLoad', 'htmlLabels', 'fontFamily', 'theme', 'themeVariables', 'flowchart'],
      suppressErrorRendering: true,
    });
    const result = await mermaid.render(`docm-diagram-${diagram.id}`, diagram.code, container);
    // Never invoke bindFunctions: document-authored callbacks are not part of the print model.
    const svg = sanitizeSvg(result.svg);
    svgGeometry(svg);
    return svg;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new RenderError(`Mermaid: ${message}`, [], diagram.source, { cause });
  } finally {
    container.remove();
  }
}
