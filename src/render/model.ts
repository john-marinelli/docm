import type { Config } from '../config/schema.js';
import type { MathExpression, MathSvg, SourceLocation } from '../shared/types.js';
export type MarkdownModel = {
  html: string; title: string;
  headings: { id: string; level: number; text: string }[];
  math: MathExpression[];
  diagrams: { id: string; code: string; source: SourceLocation }[];
  images: { id: string; url: string; source: SourceLocation }[];
};
export type ImageAsset = { dataUrl: string; svg?: string; path: string };
export type PrintModel = { markdown: MarkdownModel; config: Config; filename: string; css: string; fonts: { family:string; dataUrl:string; weight:number; style:string }[]; images: Record<string, ImageAsset>; logos: Partial<Record<'header'|'footer',ImageAsset>>; math: MathSvg[] };
