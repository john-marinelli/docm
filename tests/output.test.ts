import { afterEach, describe, expect, it } from 'vitest';
import { link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defaultOutputPath, OutputInvalidated, validateOutputPath, writePdfAtomically } from '../src/main/output.js';

const directories: string[] = [];
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'docm output '));
  directories.push(directory);
  return directory;
}
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe('PDF output protection', () => {
  it('requires an existing output parent without creating directories', async () => {
    const directory = await fixture();
    const destination = path.join(directory, 'missing', 'result.pdf');
    await expect(validateOutputPath(destination, [])).rejects.toThrow();
    await expect(writePdfAtomically(destination, Buffer.from('%PDF-new'))).rejects.toThrow();
    expect(await readdir(directory)).toEqual([]);
  });

  it('rejects lexical, symlink, symlink-parent and hard-link aliases of protected inputs', async () => {
    const directory = await fixture();
    const source = path.join(directory, 'notes.md');
    await writeFile(source, 'original');
    const symlinkPath = path.join(directory, 'symbol.pdf');
    const hardlinkPath = path.join(directory, 'hard.pdf');
    await symlink(source, symlinkPath);
    await link(source, hardlinkPath);
    const alias = path.join(directory, 'directory alias');
    await symlink(directory, alias);
    for (const destination of [source, symlinkPath, hardlinkPath, path.join(alias, 'notes.md')]) {
      await expect(validateOutputPath(destination, [source])).rejects.toThrow(/overwrite/);
    }
    expect(await readFile(source, 'utf8')).toBe('original');
  });

  it('protects absent watched dependencies and accepts an unrelated existing output', async () => {
    const directory = await fixture();
    const dependency = path.join(directory, 'theme.toml');
    const alias = path.join(directory, 'alias');
    await symlink(directory, alias);
    await expect(validateOutputPath(path.join(alias, 'theme.toml'), [dependency])).rejects.toThrow(/overwrite/);
    const destination = path.join(directory, 'notes.pdf');
    await writeFile(destination, 'old');
    await expect(validateOutputPath(destination, [dependency])).resolves.toBeUndefined();
  });

  it('places the default PDF beside the source and removes only its final extension', () => {
    expect(defaultOutputPath('/notes/my.report.md')).toBe('/notes/my.report.pdf');
    expect(defaultOutputPath('/notes/README')).toBe('/notes/README.pdf');
    expect(defaultOutputPath('/notes/.notes')).toBe('/notes/.notes.pdf');
  });
});

describe('atomic PDF replacement', () => {
  it('writes complete bytes before precommit and only then replaces the old PDF', async () => {
    const directory = await fixture();
    const destination = path.join(directory, 'notes.pdf');
    const bytes = Buffer.from('%PDF-new exact bytes');
    await writeFile(destination, 'old PDF');
    await writePdfAtomically(destination, bytes, async () => {
      expect(await readFile(destination, 'utf8')).toBe('old PDF');
      const temporary = (await readdir(directory)).find(name => name.endsWith('.tmp'))!;
      expect(await readFile(path.join(directory, temporary))).toEqual(bytes);
      expect((await stat(path.join(directory, temporary))).mode & 0o777).toBe(0o600);
      return true;
    });
    expect(await readFile(destination)).toEqual(bytes);
    expect(await readdir(directory)).toEqual(['notes.pdf']);
  });

  it('preserves the old PDF and removes temporary bytes when a revision is invalidated', async () => {
    const directory = await fixture();
    const destination = path.join(directory, 'notes.pdf');
    await writeFile(destination, 'old PDF');
    await expect(writePdfAtomically(destination, Buffer.from('%PDF-new'), async () => false)).rejects.toBeInstanceOf(OutputInvalidated);
    expect(await readFile(destination, 'utf8')).toBe('old PDF');
    expect(await readdir(directory)).toEqual(['notes.pdf']);
  });

  it('preserves the old PDF after a failing precommit dependency check', async () => {
    const directory = await fixture();
    const destination = path.join(directory, 'notes.pdf');
    await writeFile(destination, 'old PDF');
    await expect(writePdfAtomically(destination, Buffer.from('%PDF-new'), async () => { throw new Error('dependency unreadable'); })).rejects.toThrow('dependency unreadable');
    expect(await readFile(destination, 'utf8')).toBe('old PDF');
    expect(await readdir(directory)).toEqual(['notes.pdf']);
  });

  it('cleans its temporary file when the final rename fails', async () => {
    const directory = await fixture();
    const destination = path.join(directory, 'notes.pdf');
    await mkdir(destination);
    await writeFile(path.join(destination, 'sentinel'), 'keep');
    await expect(writePdfAtomically(destination, Buffer.from('%PDF-new'))).rejects.toThrow();
    expect(await readFile(path.join(destination, 'sentinel'), 'utf8')).toBe('keep');
    expect(await readdir(directory)).toEqual(['notes.pdf']);
  });
});
