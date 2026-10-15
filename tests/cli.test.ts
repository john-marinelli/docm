import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommanderError } from 'commander';
import { parseCliArgs } from '../src/main/cli.js';

beforeEach(() => { vi.spyOn(process.stderr, 'write').mockImplementation(() => true); });
afterEach(() => { vi.restoreAllMocks(); });

describe('CLI document requests', () => {
  it('previews a document with spaces and preserves path resolution for the invoking cwd', () => {
    expect(parseCliArgs(['notes with spaces.md', '--config', 'shared theme.toml'])).toEqual({ mode: 'preview', sourcePath: 'notes with spaces.md', configPath: 'shared theme.toml' });
    expect(parseCliArgs(['--config=shared.toml', 'relative/notes.md'])).toEqual({ mode: 'preview', sourcePath: 'relative/notes.md', configPath: 'shared.toml' });
  });

  it('renders to adjacent output, an explicit path, or clean stdout', () => {
    expect(parseCliArgs(['r', 'notes.md'])).toEqual({ mode: 'render', sourcePath: 'notes.md' });
    expect(parseCliArgs(['r', 'notes.md', '-o', 'somewhere/result.pdf', '--config', 'theme.toml'])).toEqual({ mode: 'render', sourcePath: 'notes.md', outputPath: 'somewhere/result.pdf', configPath: 'theme.toml' });
    expect(parseCliArgs(['r', 'notes.md', '--output=-'])).toEqual({ mode: 'render', sourcePath: 'notes.md', outputPath: '-' });
    expect(parseCliArgs(['--config', 'global.toml', 'r', 'notes.md'])).toEqual({ mode: 'render', sourcePath: 'notes.md', configPath: 'global.toml' });
  });

  it('uses -- for literal command names and dash-prefixed filenames', () => {
    expect(parseCliArgs(['--', 'r'])).toEqual({ mode: 'preview', sourcePath: 'r' });
    expect(parseCliArgs(['--config', 'r', '--', 'r'])).toEqual({ mode: 'preview', sourcePath: 'r', configPath: 'r' });
    expect(parseCliArgs(['--', '-draft.md'])).toEqual({ mode: 'preview', sourcePath: '-draft.md' });
    expect(parseCliArgs(['r', '-o', 'out.pdf', '--', '-draft.md'])).toEqual({ mode: 'render', sourcePath: '-draft.md', outputPath: 'out.pdf' });
    expect(parseCliArgs(['r', '--', 'r'])).toEqual({ mode: 'render', sourcePath: 'r' });
  });

  it.each([
    [], ['r'], ['one.md', 'two.md'], ['r', 'one.md', 'two.md'],
    ['notes.md', '-o', 'out.pdf'], ['notes.md', '--output', 'out.pdf'],
    ['notes.md', '--unknown'], ['--config'], ['r', 'notes.md', '-o'], ['-draft.md'],
  ].map(argv => ({ argv })))('rejects incomplete, extra, or invalid arguments with usage exit code 2: $argv', ({ argv }) => {
    let failure: unknown;
    try { parseCliArgs(argv); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(CommanderError);
    expect((failure as CommanderError).exitCode).toBe(2);
  });

  it.each([['--help'], ['--version'], ['r', '--help']].map(argv => ({ argv })))('prints help/version on stderr and exits successfully: $argv', ({ argv }) => {
    let failure: unknown;
    try { parseCliArgs(argv); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(CommanderError);
    expect((failure as CommanderError).exitCode).toBe(0);
    expect(process.stderr.write).toHaveBeenCalled();
  });
});
