export type SourceLocation = { path: string; line: number; column: number };
export type MathExpression = { id: string; tex: string; display: boolean; source: SourceLocation };
/** Depth is signed relative to the baseline; raised ink can have negative depth. */
export type MathSvg = { id: string; svg: string; widthPx: number; heightPx: number; depthPx: number };
export type Snapshot = { path: string; sha256: string | null }[];
export type RenderResult = { pdf: Buffer; dependencies: string[]; snapshot: Snapshot };
export type PreviewUpdate = { revision: number; pdf: Uint8Array } | { revision: number; status: 'rendering' } | { revision: number; status: 'error'; message: string; source?: SourceLocation };
export type ExportResult = { status: 'saved'; path: string } | { status: 'cancelled' } | { status: 'error'; message: string };
export type PreviewBridge = { onUpdate(callback: (update: PreviewUpdate) => void): () => void; exportPdf(): Promise<ExportResult> };
declare global { interface Window { docm: PreviewBridge } }
