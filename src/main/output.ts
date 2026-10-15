import { open, realpath, rename, stat, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class OutputInvalidated extends Error {
  constructor() { super('The document changed before export completed'); this.name = 'OutputInvalidated'; }
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/** Protect both path names and existing file identities, including hard links. */
export async function validateOutputPath(destination: string, protectedPaths: readonly string[]): Promise<void> {
  const absolute = path.resolve(destination);
  const parent = path.dirname(absolute);
  if (!(await stat(parent)).isDirectory()) throw new Error(`Output parent is not a directory: ${parent}`);
  const parentReal = await realpath(parent);
  const prospective = path.join(parentReal, path.basename(absolute));
  const destinationStat = await stat(absolute).catch(error => { if (missing(error)) return undefined; throw error; });
  if (destinationStat && !destinationStat.isFile()) throw new Error(`Output is not a regular file: ${absolute}`);
  const destinationReal = await realpath(absolute).catch(error => { if (missing(error)) return prospective; throw error; });
  for (const protectedPath of protectedPaths) {
    const protectedAbsolute = path.resolve(protectedPath);
    if (absolute === protectedAbsolute) throw new Error(`Output would overwrite an input or dependency: ${absolute}`);
    const protectedReal = await realpath(protectedAbsolute).catch(async error => {
      if (!missing(error)) throw error;
      try { return path.join(await realpath(path.dirname(protectedAbsolute)), path.basename(protectedAbsolute)); }
      catch (parentError) { if (missing(parentError)) return protectedAbsolute; throw parentError; }
    });
    if (destinationReal === protectedReal || prospective === protectedReal) throw new Error(`Output would overwrite an input or dependency: ${absolute}`);
    if (destinationStat) {
      const protectedStat = await stat(protectedAbsolute).catch(error => { if (missing(error)) return undefined; throw error; });
      if (protectedStat && destinationStat.dev === protectedStat.dev && destinationStat.ino === protectedStat.ino) {
        throw new Error(`Output would overwrite an input or dependency: ${absolute}`);
      }
    }
  }
}

/** A failed write or precommit guard never changes an existing destination. */
export async function writePdfAtomically(destination: string, bytes: Uint8Array, precommit?: () => Promise<boolean>): Promise<void> {
  const absolute = path.resolve(destination);
  const temporary = path.join(path.dirname(absolute), `.docm-${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  let created = false;
  try {
    handle = await open(temporary, 'wx', 0o600);
    created = true;
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (precommit && !await precommit()) throw new OutputInvalidated();
    await rename(temporary, absolute);
  } finally {
    try { await handle?.close(); }
    finally { if (created) await unlink(temporary).catch(error => { if (!missing(error)) throw error; }); }
  }
}

export function defaultOutputPath(sourcePath: string): string {
  const extension = path.extname(sourcePath);
  return `${extension ? sourcePath.slice(0, -extension.length) : sourcePath}.pdf`;
}
