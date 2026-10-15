import type { SourceLocation } from './types.js';
export class RenderError extends Error {
  constructor(message: string, public dependencies: string[] = [], public source?: SourceLocation, options?: ErrorOptions) { super(message, options); this.name = 'RenderError'; }
}
