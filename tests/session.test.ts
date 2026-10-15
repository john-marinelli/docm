import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/load.js';
import { PreviewSession } from '../src/main/session.js';
import { writePdfAtomically } from '../src/main/output.js';
import { fingerprint } from '../src/render/assets.js';
import type { renderDocument } from '../src/render/pdf.js';
import { RenderError } from '../src/shared/errors.js';
import type { PreviewUpdate, RenderResult } from '../src/shared/types.js';

const roots: string[] = [];
const sessions: PreviewSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type SessionFixture = {
  root: string;
  cwd: string;
  sourcePath: string;
  globalThemePath: string;
  documentDirectory: string;
  session: PreviewSession;
  updates: PreviewUpdate[];
  waitFor: (predicate: () => boolean) => Promise<void>;
  waitForGood: () => Promise<void>;
};

// This renderer seam exercises scheduling against real source/config/asset bytes.
// PDF production itself is covered by the math tests and actual application smoke.
const readRevision: typeof renderDocument = async (sourcePath, options): Promise<RenderResult> => {
  const loaded = await loadConfig(sourcePath, options);
  for (const file of loaded.dependencies) {
    if (loaded.snapshot.some((entry) => entry.path === file)) continue;
    const sha256 = await fingerprint(file);
    if (sha256 === null) throw new RenderError(`Missing asset: ${file}`, loaded.dependencies, { path: sourcePath, line: 1, column: 1 });
    loaded.snapshot.push({ path: file, sha256 });
  }
  return {
    pdf: Buffer.from(JSON.stringify({ markdown: loaded.markdown, color: loaded.config.body.color, header: loaded.config.header, snapshot: loaded.snapshot })),
    dependencies: loaded.dependencies,
    snapshot: loaded.snapshot,
  };
};

async function fixture(render: typeof renderDocument = readRevision, configPath?: string, write?: typeof writePdfAtomically): Promise<SessionFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'docm-session-'));
  roots.push(root);
  const cwd = path.join(root, 'invocation');
  const documentDirectory = path.join(root, 'documents');
  const globalThemePath = path.join(root, 'user', 'support', 'docm', 'theme.toml');
  const sourcePath = path.join(documentDirectory, 'notes.md');
  await Promise.all([mkdir(cwd), mkdir(documentDirectory)]);
  await writeFile(sourcePath, '# Initial\n');
  const updates: PreviewUpdate[] = [];
  const listeners = new Set<() => void>();
  const session = new PreviewSession({
    sourcePath, cwd, globalThemePath, render, ...(configPath ? { configPath } : {}), ...(write ? { write } : {}),
    publish: (update) => { updates.push(update); for (const listener of listeners) listener(); },
  });
  sessions.push(session);
  const waitFor = (predicate: () => boolean) => new Promise<void>((resolve, reject) => {
    // These are real filesystem integration tests: Chokidar must consume OS
    // notifications and its atomic-save timers. This timer is only a failure deadline.
    const timeout = setTimeout(() => { listeners.delete(check); reject(new Error('Timed out waiting for session state')); }, 8_000);
    const check = () => {
      if (!predicate()) return;
      clearTimeout(timeout);
      listeners.delete(check);
      resolve();
    };
    listeners.add(check);
    check();
  });
  const waitForGood = () => waitFor(() => !!session.lastGood && session.displayedRevision === session.requestedRevision && !session.error);
  return { root, cwd, sourcePath, globalThemePath, documentDirectory, session, updates, waitFor, waitForGood };
}

// Only negative filesystem assertions use a real observation interval; fake clocks
// cannot establish that macOS delivered no unwanted watch notifications.
const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function editAndObserve(f: SessionFixture, text: string) {
  const revision = f.session.requestedRevision;
  await writeFile(f.sourcePath, text);
  await f.waitFor(() => f.session.requestedRevision > revision);
}

describe('latest revision preview session', () => {
  it.each(['completion', 'error'])('discards an obsolete %s, aborts promptly, and runs only the newest pending edit', async (obsolete) => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const calls: string[] = [];
    let firstSignal: AbortSignal | undefined;
    let active = 0;
    let maximumActive = 0;
    const f = await fixture(async (source, options) => {
      active++;
      maximumActive = Math.max(maximumActive, active);
      try {
        const result = await readRevision(source, options);
        calls.push(JSON.parse(result.pdf.toString()).markdown);
        if (calls.length === 1) {
          firstSignal = options.signal;
          entered.resolve();
          await release.promise;
          if (obsolete === 'error') throw new RenderError('Obsolete diagnostic', [source]);
        }
        return result;
      } finally { active--; }
    });
    try {
      await f.session.start();
      await entered.promise;
      expect(f.updates[0]).toEqual({ revision: 1, status: 'rendering' });
      await editAndObserve(f, '# Middle\n');
      expect(firstSignal?.aborted).toBe(true);
      await writeFile(f.sourcePath, '# Newest\n');
      expect(calls).toHaveLength(1);
      release.resolve();
      await f.waitForGood();
      expect(calls).toEqual(['# Initial\n', '# Newest\n']);
      expect(maximumActive).toBe(1);
      expect(f.updates.filter((update) => 'pdf' in update)).toHaveLength(1);
      expect(f.updates.some((update) => 'status' in update && update.status === 'error')).toBe(false);
      expect(f.session.lastGood?.pdf.toString()).toContain('Newest');
      await expect(access(path.join(f.documentDirectory, 'notes.pdf'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { release.resolve(); }
  });

  it('retains last good pages and diagnostics, watches a newly missing asset, and recovers on repair', async () => {
    const f = await fixture();
    await f.session.start();
    await f.waitForGood();
    const good = f.session.lastGood;
    const displayed = f.session.displayedRevision;
    const logo = path.join(f.documentDirectory, 'missing logo.png');
    await editAndObserve(f, '+++\n[header.logo]\npath = "missing logo.png"\n+++\n# With logo\n');
    await f.waitFor(() => !!f.session.error);
    expect(f.session.lastGood).toBe(good);
    expect(f.session.displayedRevision).toBe(displayed);
    expect(f.session.currentUpdate()).toMatchObject({ status: 'error', source: { path: f.sourcePath, line: 1, column: 1 } });
    const output = path.join(f.root, 'existing.pdf');
    await writeFile(output, 'old output');
    expect(await f.session.exportLatest(output)).toMatchObject({ status: 'error', message: expect.stringContaining('Missing asset') });
    expect(await readFile(output, 'utf8')).toBe('old output');
    await writeFile(logo, 'repaired asset');
    await f.waitForGood();
    expect(f.session.error).toBeUndefined();
    expect(f.session.lastGood?.dependencies).toContain(logo);
    expect(f.session.lastGood).not.toBe(good);
    await editAndObserve(f, '# Removed logo\n');
    await f.waitForGood();
    const revision = f.session.requestedRevision;
    await writeFile(logo, 'unused edit');
    await delay(400);
    expect(f.session.requestedRevision).toBe(revision);
  });

  it('watches absent automatic themes through only their parent chain and handles theme/source replacement and recreation', async () => {
    const f = await fixture();
    await f.session.start();
    await f.waitForGood();
    await expect(access(path.dirname(f.globalThemePath))).rejects.toMatchObject({ code: 'ENOENT' });
    const beforeUnrelated = f.session.requestedRevision;
    await mkdir(path.join(f.root, 'unrelated'));
    await writeFile(path.join(f.root, 'unrelated', 'theme.toml'), '[unknown]\ninvalid = true\n');
    await delay(400);
    expect(f.session.requestedRevision).toBe(beforeUnrelated);
    await mkdir(path.dirname(f.globalThemePath), { recursive: true });
    await writeFile(f.globalThemePath, '[header]\nleft = "Global header"\n');
    await f.waitFor(() => !!f.session.lastGood?.pdf.toString().includes('Global header') && f.session.displayedRevision === f.session.requestedRevision);
    const staged = path.join(f.documentDirectory, 'editor-save.tmp');
    await writeFile(staged, '# Atomic replacement\n');
    await rename(staged, f.sourcePath);
    await f.waitFor(() => !!f.session.lastGood?.pdf.toString().includes('Atomic replacement') && f.session.displayedRevision === f.session.requestedRevision);
    const beforeDeletion = f.session.requestedRevision;
    await rm(f.sourcePath);
    await f.waitFor(() => f.session.requestedRevision > beforeDeletion && !!f.session.error);
    await writeFile(f.sourcePath, '# Recreated\n');
    await f.waitFor(() => !!f.session.lastGood?.pdf.toString().includes('Recreated') && f.session.displayedRevision === f.session.requestedRevision);
    const beforeThemeDeletion = f.session.requestedRevision;
    await rm(path.join(f.root, 'user'), { recursive: true });
    await f.waitFor(() => f.session.requestedRevision > beforeThemeDeletion && f.session.displayedRevision === f.session.requestedRevision && !f.session.error);
    expect(f.session.lastGood?.pdf.toString()).not.toContain('Global header');
    await mkdir(path.dirname(f.globalThemePath), { recursive: true });
    await writeFile(f.globalThemePath, '[header]\nleft = "Recreated global"\n');
    await f.waitFor(() => !!f.session.lastGood?.pdf.toString().includes('Recreated global') && f.session.displayedRevision === f.session.requestedRevision);
    const cwdTheme = path.join(f.cwd, 'theme.toml');
    await writeFile(cwdTheme, '[body]\ncolor = "#123456"\n');
    await f.waitFor(() => !!f.session.lastGood?.pdf.toString().includes('#123456') && f.session.displayedRevision === f.session.requestedRevision);
    await rm(cwdTheme);
    await f.waitFor(() => !f.session.lastGood?.pdf.toString().includes('#123456') && f.session.displayedRevision === f.session.requestedRevision);
  });

  it('exports edits not yet delivered by the watcher, protects source aliases, and refuses a failed newest revision', async () => {
    const f = await fixture();
    await f.session.start();
    await f.waitForGood();
    const output = path.join(f.root, 'saved.pdf');
    await writeFile(f.sourcePath, '# Edited after dialog\n');
    expect(await f.session.exportLatest(output)).toEqual({ status: 'saved', path: output });
    expect(await readFile(output)).toEqual(f.session.lastGood?.pdf);
    expect((await readFile(output, 'utf8'))).toContain('Edited after dialog');
    const sourceBytes = await readFile(f.sourcePath);
    const alias = path.join(f.root, 'source alias.pdf');
    await symlink(f.sourcePath, alias);
    expect(await f.session.exportLatest(alias)).toMatchObject({ status: 'error' });
    expect(await readFile(f.sourcePath)).toEqual(sourceBytes);
    expect(await f.session.exportLatest(f.sourcePath)).toMatchObject({ status: 'error' });
    expect(await readFile(f.sourcePath)).toEqual(sourceBytes);
    const oldOutput = await readFile(output);
    await writeFile(f.sourcePath, '+++\n[body]\nunknown_key = true\n+++\n# Invalid\n');
    expect(await f.session.exportLatest(output)).toMatchObject({ status: 'error' });
    expect(await readFile(output)).toEqual(oldOutput);
    await writeFile(f.sourcePath, '# Repaired before watcher\n');
    expect(await f.session.exportLatest(output)).toEqual({ status: 'saved', path: output });
    expect((await readFile(output, 'utf8'))).toContain('Repaired before watcher');
  });

  it('keeps export waiting across invalidated renders and saves the newest published bytes without rerendering for export', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let calls = 0;
    let interrupted: AbortSignal | undefined;
    const f = await fixture(async (source, options) => {
      const result = await readRevision(source, options);
      calls++;
      if (calls === 2) { interrupted = options.signal; entered.resolve(); await release.promise; }
      return result;
    });
    try {
      await f.session.start();
      await f.waitForGood();
      await editAndObserve(f, '# Waiting export\n');
      await entered.promise;
      const output = path.join(f.root, 'latest.pdf');
      const exported = f.session.exportLatest(output);
      await editAndObserve(f, '# Latest while waiting\n');
      expect(interrupted?.aborted).toBe(true);
      release.resolve();
      expect(await exported).toEqual({ status: 'saved', path: output });
      expect(await readFile(output)).toEqual(f.session.lastGood?.pdf);
      expect((await readFile(output, 'utf8'))).toContain('Latest while waiting');
      const afterExport = calls;
      expect(await f.session.exportLatest(output)).toEqual({ status: 'saved', path: output });
      expect(calls).toBe(afterExport);
    } finally { release.resolve(); }
  });

  it('watches explicit configuration and declared font/logo bytes, retaining dependencies across errors', async () => {
    const f = await fixture(readRevision, 'shared.toml');
    const config = path.join(f.cwd, 'shared.toml');
    const assets = path.join(f.cwd, 'assets');
    const font = path.join(assets, 'custom.woff2');
    const logo = path.join(assets, 'logo.png');
    await mkdir(assets);
    await Promise.all([writeFile(font, 'font bytes one'), writeFile(logo, 'logo bytes one')]);
    const theme = '[fonts]\ncustom = "assets/custom.woff2"\n[body]\nfont = "custom"\ncolor = "#112233"\n[header.logo]\npath = "assets/logo.png"\n';
    await writeFile(config, theme);
    await f.session.start();
    await f.waitForGood();
    const fontHash = f.session.lastGood?.snapshot.find((entry) => entry.path === font)?.sha256;
    await writeFile(font, 'font bytes two');
    await f.waitFor(() => !!f.session.lastGood && f.session.displayedRevision === f.session.requestedRevision &&
      f.session.lastGood.snapshot.find((entry) => entry.path === font)?.sha256 !== fontHash);
    const logoHash = f.session.lastGood?.snapshot.find((entry) => entry.path === logo)?.sha256;
    await writeFile(logo, 'logo bytes two');
    await f.waitFor(() => !!f.session.lastGood && f.session.displayedRevision === f.session.requestedRevision &&
      f.session.lastGood.snapshot.find((entry) => entry.path === logo)?.sha256 !== logoHash);
    const previous = f.session.lastGood;
    await rm(config);
    await f.waitFor(() => !!f.session.error);
    expect(f.session.lastGood).toBe(previous);
    await writeFile(config, theme.replace('#112233', '#445566'));
    await f.waitFor(() => !!f.session.lastGood?.pdf.toString().includes('#445566') && f.session.displayedRevision === f.session.requestedRevision);
    expect(f.session.error).toBeUndefined();
  });

  it('invalidates a fully written temporary export when a dependency changes before commit', async () => {
    let changed = false;
    let sourcePath = '';
    const f = await fixture(readRevision, undefined, (destination, bytes, precommit) =>
      writePdfAtomically(destination, bytes, async () => {
        // This executes after the real write/sync/close, before the real rename.
        if (!changed) {
          changed = true;
          await writeFile(sourcePath, '# Changed during export write\n');
        }
        return await precommit?.() ?? true;
      }),
    );
    sourcePath = f.sourcePath;
    await f.session.start();
    await f.waitForGood();
    const output = path.join(f.root, 'commit.pdf');
    await writeFile(output, 'previous output');
    const entries = (await readdir(f.root)).sort();
    expect(await f.session.exportLatest(output)).toEqual({ status: 'saved', path: output });
    expect(await readFile(output)).toEqual(f.session.lastGood?.pdf);
    expect((await readFile(output, 'utf8'))).toContain('Changed during export write');
    expect((await readdir(f.root)).sort()).toEqual(entries);
  });

  it('closes watchers, aborts active rendering, settles waiting exports, and ignores late completions', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let signal: AbortSignal | undefined;
    const f = await fixture(async (source, options) => {
      signal = options.signal;
      entered.resolve();
      await release.promise;
      return readRevision(source, options);
    });
    try {
      await f.session.start();
      await entered.promise;
      const exported = f.session.exportLatest(path.join(f.root, 'closed.pdf'));
      const close = f.session.close();
      expect(signal?.aborted).toBe(true);
      release.resolve();
      await close;
      expect(await exported).toMatchObject({ status: 'error' });
      expect(f.session.lastGood).toBeUndefined();
      const updates = f.updates.length;
      await writeFile(f.sourcePath, '# After close\n');
      await delay(400);
      expect(f.updates).toHaveLength(updates);
      await expect(access(path.join(f.root, 'closed.pdf'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { release.resolve(); }
  });

  it('can close during initial watcher setup without leaving start or export pending', async () => {
    const f = await fixture();
    const starting = f.session.start();
    const exported = f.session.exportLatest(path.join(f.root, 'never-written.pdf'));
    await f.session.close();
    await starting;
    expect(await exported).toMatchObject({ status: 'error' });
    expect(f.session.lastGood).toBeUndefined();
  });
});
