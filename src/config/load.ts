import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'smol-toml';
import { RenderError } from '../shared/errors.js';
import type { SourceLocation } from '../shared/types.js';
import { defaults } from './defaults.js';
import { finalizeConfig, parseLayer, type Config } from './schema.js';

export interface LoadConfigOptions {
  cwd: string;
  globalThemePath: string;
  configPath?: string;
}

export interface LoadedConfig {
  config: Config;
  markdown: string;
  /** Number of original source lines removed before the Markdown body. */
  lineOffset: number;
  dependencies: string[];
  snapshot: { path: string; sha256: string | null }[];
}

type Table = Record<string, unknown>;

function isTable(value: unknown): value is Table {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Arrays and scalar values replace; only tables merge recursively. */
function merge(lower: unknown, upper: unknown): unknown {
  if (!isTable(lower) || !isTable(upper)) return upper;
  const entries = new Map(Object.entries(lower));
  for (const [key, value] of Object.entries(upper)) {
    entries.set(key, merge(entries.get(key), value));
  }
  return Object.fromEntries(entries);
}


function errorPosition(error: unknown, file: string, offset = 0): SourceLocation {
  const detail = isTable(error) ? error : {};
  const line = typeof detail.line === 'number' && Number.isInteger(detail.line) && detail.line > 0
    ? detail.line : 1;
  const column = typeof detail.column === 'number' && Number.isInteger(detail.column) && detail.column > 0
    ? detail.column : 1;
  return { path: file, line: line + offset, column };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveLayerPaths(layer: unknown, directory: string, dependencies: Set<string>): unknown {
  if (!isTable(layer)) return layer;
  const result = { ...layer };
  const resolveLocal = (value: unknown): string => {
    if (typeof value !== 'string' || /^[a-z][a-z\d+.-]*:/i.test(value)) {
      throw new Error('Configuration assets must use local filesystem paths, not URLs');
    }
    const resolved = path.resolve(directory, value);
    dependencies.add(resolved);
    return resolved;
  };
  if (isTable(result.fonts)) {
    result.fonts = Object.fromEntries(Object.entries(result.fonts).map(([alias, file]) => [alias, resolveLocal(file)]));
  }
  for (const name of ['header', 'footer']) {
    const decoration = result[name];
    if (isTable(decoration) && isTable(decoration.logo) && decoration.logo.path !== undefined) {
      result[name] = { ...decoration, logo: { ...decoration.logo, path: resolveLocal(decoration.logo.path) } };
    }
  }
  return result;
}

/** Load only the captured invocation cwd's theme; never search source/ancestor directories. */
export async function loadConfig(sourcePath: string, options: LoadConfigOptions): Promise<LoadedConfig> {
  const cwd = path.resolve(options.cwd);
  const source = path.resolve(cwd, sourcePath);
  const globalTheme = path.resolve(cwd, options.globalThemePath);
  const cwdTheme = path.join(cwd, 'theme.toml');
  const explicitTheme = options.configPath === undefined ? undefined : path.resolve(cwd, options.configPath);
  const dependencies = new Set([source, globalTheme, cwdTheme]);
  if (explicitTheme !== undefined) dependencies.add(explicitTheme);
  const snapshot: LoadedConfig['snapshot'] = [];

  const failure = (message: string, cause: unknown, location: SourceLocation): RenderError =>
    new RenderError(message, [...dependencies], location, { cause });

  const read = async (file: string, optional: boolean): Promise<string | undefined> => {
    try {
      const bytes = await readFile(file);
      snapshot.push({ path: file, sha256: createHash('sha256').update(bytes).digest('hex') });
      // Reject malformed UTF-8 rather than quietly changing authored TOML/Markdown bytes.
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch (error) {
      if (optional && isTable(error) && error.code === 'ENOENT') {
        snapshot.push({ path: file, sha256: null });
        return undefined;
      }
      throw failure(`Cannot read ${file}: ${describe(error)}`, error, { path: file, line: 1, column: 1 });
    }
  };

  const layer = (text: string, file: string, offset = 0): unknown => {
    let parsed: unknown;
    try {
      parsed = parse(text.startsWith('\uFEFF') ? text.slice(1) : text);
    } catch (error) {
      throw failure(`Invalid TOML in ${file}: ${describe(error)}`, error, errorPosition(error, file, offset));
    }
    try {
      return resolveLayerPaths(parseLayer(parsed), path.dirname(file), dependencies);
    } catch (error) {
      throw failure(`Invalid configuration in ${file}: ${describe(error)}`, error, {
        path: file, line: offset + 1, column: 1,
      });
    }
  };

  const rawSource = await read(source, false);
  const text = rawSource!.startsWith('\uFEFF') ? rawSource!.slice(1) : rawSource!;
  let markdown = text;
  let lineOffset = 0;
  let frontmatter: unknown;
  // Delimiters occupy an entire line, and the opener must be the first line.
  const opening = /^\+\+\+(?:\r?\n|$)/.exec(text);
  if (opening !== null) {
    const bodyStart = opening[0].length;
    const remainder = text.slice(bodyStart);
    const closing = /^\+\+\+(?:\r?\n|$)/m.exec(remainder);
    if (closing === null || !opening[0].endsWith('\n')) {
      throw failure('Unterminated TOML frontmatter; expected a closing +++ line', undefined, {
        path: source, line: 1, column: 1,
      });
    }
    const removed = text.slice(0, bodyStart + closing.index + closing[0].length);
    lineOffset = (removed.match(/\n/g) ?? []).length;
    // A closing delimiter at EOF still occupies a source line.
    if (!removed.endsWith('\n')) lineOffset += 1;
    markdown = text.slice(removed.length);
    frontmatter = layer(remainder.slice(0, closing.index), source, 1);
  }

  let merged: unknown = defaults;
  // Do not deduplicate layers: an explicit global-theme path must apply again here.
  for (const candidate of [
    { file: globalTheme, optional: true },
    { file: cwdTheme, optional: true },
    ...(explicitTheme === undefined ? [] : [{ file: explicitTheme, optional: false }]),
  ]) {
    const content = await read(candidate.file, candidate.optional);
    if (content !== undefined) merged = merge(merged, layer(content, candidate.file));
  }
  if (frontmatter !== undefined) merged = merge(merged, frontmatter);

  let config: Config;
  try {
    config = finalizeConfig(merged);
  } catch (error) {
    throw failure(`Invalid merged configuration: ${describe(error)}`, error, {
      path: source, line: frontmatter === undefined ? 1 : 2, column: 1,
    });
  }
  return { config, markdown, lineOffset, dependencies: [...dependencies], snapshot };
}
