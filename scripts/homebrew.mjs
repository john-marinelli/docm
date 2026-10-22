import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import { access, lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pins } from './prepare-formula.mjs';
import { executableRelative, hostPlatform, launcherRelative, nodeResourceUrl, platformKey, pnpmResourceUrl } from './platform.mjs';
import { renderFormula } from './formula.mjs';
import { readVersion, validateTag } from './version.mjs';

const project = await realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const build = path.join(project, '.build');
const manifestPath = path.join(build, 'docm-local-distribution.json');
const inputsPath = path.join(build, 'formula-inputs/manifest.json');
const generatedTap = path.join(build, 'homebrew-tap');
const generatedFormula = path.join(generatedTap, 'Formula/docm.rb');
const legacyCask = path.join(generatedTap, 'Casks/docm.rb');
const legacyAppdir = path.join(build, 'cask-apps');
const tapName = 'docm/local';
const formulaName = `${tapName}/docm`;
const brewEnv = { ...process.env, HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_INSTALL_CLEANUP: '1', HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK: '1' };
delete brewEnv.HOMEBREW_CASK_OPTS;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const validIdentity = value => value && Number.isSafeInteger(value.dev) && Number.isSafeInteger(value.ino);
const platform = hostPlatform();
const macOS = platform.os === 'darwin';
const installedDirectory = macOS ? 'Docm.app' : 'docm-linux';

function conflict(location, reason) {
  throw new Error(`Refusing local docm formula: ${location}: ${reason}. No unrelated installation will be adopted or replaced.`);
}
async function exists(location) {
  try { return await lstat(location); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function regular(location) {
  const info = await lstat(location);
  if (!info.isFile() || info.isSymbolicLink()) conflict(location, 'expected a regular file');
}
async function hashFile(location) {
  await regular(location);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(location)) hash.update(chunk);
  return hash.digest('hex');
}
async function run(command, args, { env = brewEnv, cwd = project, timeout = 120_000, inherit = false, includeStderr = false } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; if (inherit) process.stdout.write(bytes); });
    child.stderr.on('data', bytes => { stderr += bytes; if (inherit) process.stderr.write(bytes); });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`${command} ${args.join(' ')} exited ${code ?? signal}: ${stderr.trim()}${stdout.trim() ? `\n${stdout.trim()}` : ''}`));
      else resolve([stdout, ...(includeStderr ? [stderr] : [])].join('\n').trim());
    });
  });
}
async function findExecutable(name) {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.resolve(directory || '.', name);
    try { await access(candidate, constants.X_OK); if ((await stat(candidate)).isFile()) return await realpath(candidate); }
    catch (error) { if (!['ENOENT', 'EACCES', 'ENOTDIR'].includes(error.code)) throw error; }
  }
  throw new Error(`${name} is missing; developer tooling will not be installed automatically.`);
}
async function identity(location) {
  const info = await lstat(location);
  if (!info.isDirectory() || info.isSymbolicLink()) conflict(location, 'expected an owned real directory');
  return { dev: info.dev, ino: info.ino };
}
async function sameIdentity(location, expected) {
  if (!validIdentity(expected)) conflict(location, 'missing recorded directory identity');
  const actual = await identity(location);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) conflict(location, 'owned directory was replaced');
}
// This is also the schema1 checksum algorithm: preserve literal symlink targets and executable modes.
async function treeHash(directory, skipGit = false) {
  const hash = createHash('sha256');
  async function visit(relative) {
    for (const name of (await readdir(path.join(directory, relative))).sort()) {
      if (skipGit && !relative && name === '.git') continue;
      const item = path.join(relative, name), absolute = path.join(directory, item), info = await lstat(absolute);
      if (info.isSymbolicLink()) hash.update(JSON.stringify(['link', item, await readlink(absolute)]) + '\n');
      else if (info.isDirectory()) { hash.update(JSON.stringify(['directory', item]) + '\n'); await visit(item); }
      else if (info.isFile()) hash.update(JSON.stringify(['file', item, info.mode & 0o111, await hashFile(absolute)]) + '\n');
      else conflict(absolute, 'unexpected non-file in owned tree');
    }
  }
  await visit('');
  return hash.digest('hex');
}
async function atomicJson(location, value) {
  const bytes = JSON.stringify(value, null, 2) + '\n';
  if (await exists(location) && await readFile(location, 'utf8') === bytes) return;
  const temporary = `${location}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 }); await rename(temporary, location); }
  finally { await rm(temporary, { force: true }); }
}
const saveManifest = value => atomicJson(manifestPath, value);
async function readJson(location) { await regular(location); return JSON.parse(await readFile(location, 'utf8')); }
async function readManifest() {
  if (!await exists(manifestPath)) return null;
  const value = await readJson(manifestPath);
  if (value.project !== project || value.tapName !== tapName) conflict(manifestPath, 'ownership belongs to another project/tap');
  if (value.schema === 1) {
    if (!macOS) conflict(manifestPath, 'legacy cask ownership can migrate only on macOS arm64');
    if (value.state !== 'installed' || value.generatedCask !== legacyCask || value.appdir !== legacyAppdir) conflict(manifestPath, 'only a complete recorded schema1 installation can migrate');
    for (const field of ['archiveSha256', 'sourceAppSha256', 'caskSha256', 'generatedTapSha256', 'tapSha256']) if (!validHash(value[field])) conflict(manifestPath, `invalid legacy ${field}`);
    for (const field of ['generatedTapIdentity', 'tapIdentity', 'appdirIdentity', 'appIdentity']) if (!validIdentity(value[field])) conflict(manifestPath, `invalid legacy ${field}`);
    return value;
  }
  if (value.schema !== 2 || value.generatedFormula !== generatedFormula || !['prepared', 'installed', 'mutating', 'mutation-failed'].includes(value.state)) conflict(manifestPath, 'invalid source-formula ownership record');
  if (value.platform ? value.platform.os !== platform.os || value.platform.arch !== platform.arch : !macOS) conflict(manifestPath, 'ownership was prepared for another platform or lacks native platform identity');
  if (value.inputs?.platform && (value.inputs.platform.os !== platform.os || value.inputs.platform.arch !== platform.arch)) conflict(manifestPath, 'recorded source/resource platform differs from the native host');
  if (['mutating', 'mutation-failed'].includes(value.state)) conflict(manifestPath, `interrupted ${value.transaction?.kind ?? 'mutation'} at ${value.transaction?.stage ?? 'unknown stage'}; inspect recorded failure before further mutation`);
  for (const field of ['inputsSha256', 'formulaSha256', 'generatedTapSha256']) if (!validHash(value[field])) conflict(manifestPath, `invalid ${field}`);
  if (!value.inputs || sha(JSON.stringify(value.inputs)) !== value.inputsSha256) conflict(manifestPath, 'recorded source/resource inputs checksum changed');
  if (!validIdentity(value.generatedTapIdentity) || value.tapIdentity && (!validIdentity(value.tapIdentity) || !validHash(value.tapSha256))) conflict(manifestPath, 'invalid recorded tap identity/checksum');
  return value;
}
async function distribution() {
  const inputs = await readJson(inputsPath);
  try { validateTag(`v${inputs.version}`, inputs.version); } catch { conflict(inputsPath, 'invalid stable application version'); }
  const tools = pins;
  if (inputs.version !== await readVersion()) conflict(inputsPath, 'application version changed; regenerate formula inputs for explicit refresh');
  if (inputs.schema !== 1 || inputs.project !== project || inputs.tools?.node !== tools.node || inputs.tools?.pnpm !== tools.pnpm || Object.keys(inputs.tools).sort().join(',') !== 'node,pnpm') conflict(inputsPath, 'invalid source/resource/tool contract; regenerate formula inputs');
  if (inputs.platform?.os !== platform.os || inputs.platform?.arch !== platform.arch || Object.keys(inputs.platform).sort().join(',') !== 'arch,os') conflict(inputsPath, 'source/resources must be prepared for the native platform');
  for (const version of Object.values(tools)) {
    try { validateTag(`v${version}`, version); } catch { conflict(inputsPath, 'invalid pinned tool version'); }
  }
  if (!Array.isArray(inputs.resources) || inputs.resources.length !== 2 || inputs.resources.map(item => item.name).sort().join(',') !== 'electron,pnpm-store') conflict(inputsPath, 'expected exactly electron and pnpm-store resources');
  if (!Array.isArray(inputs.toolResources) || inputs.toolResources.length !== 2 || inputs.toolResources.map(item => item?.name).sort().join(',') !== 'node,pnpm') conflict(inputsPath, 'expected exactly node and pnpm tool resources; regenerate formula inputs');
  const toolUrls = {
    node: nodeResourceUrl(tools.node, platform),
    pnpm: pnpmResourceUrl(tools.pnpm, platform),
  };
  for (const item of inputs.toolResources) {
    if (Object.keys(item).sort().join(',') !== 'name,sha256,url' || item.url !== toolUrls[item.name] || !validHash(item.sha256)) conflict(inputsPath, 'invalid official pinned tool resource URL/checksum');
  }
  for (const item of [inputs.source, ...inputs.resources]) {
    if (!item || !path.isAbsolute(item.archive ?? '') || !validHash(item.sha256)) conflict(inputsPath, 'invalid archive location/checksum');
    if (await hashFile(item.archive) !== item.sha256) conflict(item.archive, 'source/resource checksum differs from preparation manifest');
  }
  const inputsSha256 = sha(JSON.stringify(inputs));
  const provenance = { schema: 1, project, platform, version: inputs.version, inputsSha256, source: inputs.source, resources: inputs.resources, tools: inputs.tools, toolResources: inputs.toolResources };
  const formula = renderFormula({
    version: inputs.version,
    homepage: pathToFileURL(project + path.sep).href,
    targets: [{
      platform,
      source: { url: pathToFileURL(inputs.source.archive).href, sha256: inputs.source.sha256 },
      resources: [...inputs.resources.map(item => ({ ...item, url: pathToFileURL(item.archive).href })), ...inputs.toolResources],
    }],
    receipt: provenance,
  });
  return { inputs, inputsSha256, formula, formulaSha256: sha(formula), provenance };
}
async function brewContext() {
  const brew = await findExecutable('brew');
  const prefix = await run(brew, ['--prefix']);
  const repository = await run(brew, ['--repository']);
  const caskroom = macOS ? await run(brew, ['--caskroom']) : path.join(prefix, 'Caskroom');
  const cellar = await run(brew, ['--cellar']);
  const tap = path.join(repository, 'Library/Taps/docm/homebrew-local');
  return { brew, prefix, repository, caskroom, cellar, tap, tapFormula: path.join(tap, 'Formula/docm.rb'), tapCask: path.join(tap, 'Casks/docm.rb'), binary: path.join(prefix, 'bin/docm') };
}
async function symlinkDestination(location) {
  let current = location;
  const seen = new Set();
  for (let count = 0; count < 64; count++) {
    if (seen.has(current)) conflict(location, 'symlink cycle');
    seen.add(current);
    const info = await exists(current);
    if (!info) conflict(location, `broken symlink chain at ${current}`);
    if (!info.isSymbolicLink()) return await realpath(current);
    current = path.resolve(path.dirname(current), await readlink(current));
  }
  conflict(location, 'symlink chain is too long');
}
async function verifyLink(location, target) {
  if (!(await lstat(location)).isSymbolicLink() || await symlinkDestination(location) !== await realpath(target)) conflict(location, 'launcher is not the recorded Homebrew symlink');
}
async function verifyTrees(context, record) {
  await sameIdentity(generatedTap, record.generatedTapIdentity);
  if (await treeHash(generatedTap) !== record.generatedTapSha256) conflict(generatedTap, 'generated tap has changed/unowned files');
  if (record.tapIdentity) {
    await sameIdentity(context.tap, record.tapIdentity);
    if (await treeHash(context.tap, true) !== record.tapSha256) conflict(context.tap, 'dedicated tap has changed/unowned files');
  } else if (await exists(context.tap)) conflict(context.tap, 'existing dedicated tap has no ownership record');
}
function verifyContext(context, record) {
  for (const field of ['brew', 'prefix', 'tap', 'binary', 'caskroom']) if (record[field] !== context[field]) conflict(manifestPath, `Homebrew ${field} changed`);
  if (record.schema === 2 && record.cellar !== context.cellar) conflict(manifestPath, 'Homebrew Cellar changed');
}
async function verifyLegacy(context, legacy, { generatedTree = true } = {}) {
  verifyContext(context, legacy);
  if (generatedTree) await verifyTrees(context, legacy);
  else {
    await sameIdentity(context.tap, legacy.tapIdentity);
    if (await treeHash(context.tap, true) !== legacy.tapSha256) conflict(context.tap, 'legacy tap changed');
  }
  for (const recipe of [legacyCask, context.tapCask]) if (await hashFile(recipe) !== legacy.caskSha256) conflict(recipe, 'legacy recipe checksum changed');
  if ((generatedTree && await exists(generatedFormula)) || await exists(context.tapFormula)) conflict(context.tapFormula, 'existing formula has no recorded ownership');
  await sameIdentity(legacyAppdir, legacy.appdirIdentity);
  if ((await readdir(legacyAppdir)).some(name => name !== 'Docm.app')) conflict(legacyAppdir, 'unrelated items in legacy app directory');
  const bundle = path.join(legacyAppdir, 'Docm.app');
  await sameIdentity(bundle, legacy.appIdentity);
  if (await treeHash(bundle) !== legacy.sourceAppSha256) conflict(bundle, 'legacy installed app changed');
  if (await hashFile(legacy.archive) !== legacy.archiveSha256 || await treeHash(legacy.sourceApp) !== legacy.sourceAppSha256) conflict(legacy.archive, 'recorded legacy package identity changed');
  await verifyLink(context.binary, path.join(bundle, 'Contents/Resources/bin/docm'));
  const data = JSON.parse(await run(context.brew, ['info', '--json=v2', '--cask', formulaName]));
  const item = data.casks?.[0];
  if (data.casks?.length !== 1 || item.tap !== tapName || item.token !== 'docm' || item.installed !== legacy.version || item.sha256 !== legacy.archiveSha256 || item.url !== pathToFileURL(legacy.archive).href) conflict(context.caskroom, 'legacy installed Homebrew identity does not match the full recorded cask');
}
async function installedNames(context, kind) {
  if (!macOS && kind === '--cask') return [];
  return (await run(context.brew, ['list', kind, '--versions'])).split('\n').filter(line => /^(?:\S+\/)?docm(?:\s|$)/.test(line));
}
async function preflight(context, record) {
  if (record) verifyContext(context, record);
  const legacy = record?.schema === 1 ? record : record?.legacy;
  if (record?.schema === 1) await verifyLegacy(context, record);
  else if (record) {
    await verifyTrees(context, record);
    if (await hashFile(generatedFormula) !== record.formulaSha256) conflict(generatedFormula, 'generated formula changed');
    if (record.tapIdentity && !legacy && await hashFile(context.tapFormula) !== record.formulaSha256) conflict(context.tapFormula, 'dedicated formula changed');
    if (legacy) await verifyLegacy(context, legacy, { generatedTree: false });
  } else {
    for (const location of [generatedTap, context.tap, legacyAppdir]) if (await exists(location)) conflict(location, 'existing distribution has no ownership record');
  }
  const formulae = await installedNames(context, '--formula');
  const casks = await installedNames(context, '--cask');
  if (formulae.length && (record?.schema !== 2 || record.state !== 'installed' || legacy)) conflict(context.cellar, 'existing formula is not a complete recorded installation');
  if (casks.length && !legacy) conflict(context.caskroom, 'existing cask is not the recorded legacy installation');
  if (legacy && !casks.length) conflict(context.caskroom, 'recorded legacy cask is missing');
  if (record?.state === 'installed' && record.schema === 2) await verifyInstalled(context, record);
  else if (!legacy) {
    for (const location of [context.binary, path.join(context.cellar, 'docm'), path.join(context.caskroom, 'docm')]) if (await exists(location)) conflict(location, 'partial/unowned installation cannot be adopted');
  }
  if (macOS) for (const candidate of ['/Applications/Docm.app', path.join(homedir(), 'Applications/Docm.app'), path.join(context.prefix, 'Applications/Docm.app')]) if (await exists(candidate)) conflict(candidate, 'unrelated Docm.app exists');
  if (!legacy && await exists(legacyAppdir) && (await readdir(legacyAppdir)).length) conflict(legacyAppdir, 'unrecorded legacy app contents');
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.resolve(directory || '.', 'docm');
    if (candidate !== context.binary && await exists(candidate)) conflict(candidate, 'unrelated docm executable in PATH');
  }
  const taps = (await run(context.brew, ['tap'])).split(/\s+/);
  if (taps.includes(tapName) && !record?.tapIdentity) conflict(context.tap, 'tap exists without recorded ownership');
  for (const location of [build, path.dirname(context.binary), context.cellar, path.dirname(context.tap)]) {
    let ancestor = location;
    while (!await exists(ancestor)) ancestor = path.dirname(ancestor);
    await identity(ancestor);
    await access(ancestor, constants.W_OK | constants.X_OK);
  }
}
async function verifyBundle(bundle, version) {
  const resources = macOS ? 'Contents/Resources' : 'resources';
  for (const relative of ['texlive', 'runtime-lock.json', 'node_modules']) if (await exists(path.join(bundle, resources, relative))) conflict(bundle, `obsolete runtime resource ${relative}`);
  for (const relative of ['app.asar', 'bin/docm', 'third-party-notices/index.json']) await regular(path.join(bundle, resources, relative));
  if (!macOS) {
    const executable = path.join(bundle, executableRelative(platform));
    await regular(executable);
    await access(executable, constants.X_OK);
    const handle = await open(executable, 'r');
    try {
      const header = Buffer.alloc(20);
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      if (bytesRead !== header.length || header.subarray(0, 4).toString('hex') !== '7f454c46' || header[4] !== 2 || header[5] !== 1 || header.readUInt16LE(18) !== 62) conflict(bundle, 'Electron is not a native Linux x64 ELF executable');
    } finally { await handle.close(); }
    return;
  }
  const plist = path.join(bundle, 'Contents/Info.plist');
  for (const [key, expected] of [['CFBundleIdentifier', 'local.docm'], ['CFBundleShortVersionString', version], ['CFBundleExecutable', 'docm']]) if (await run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist]) !== expected) conflict(bundle, `unexpected ${key}`);
  if (await run('/usr/bin/lipo', ['-archs', path.join(bundle, 'Contents/MacOS/docm')]) !== 'arm64') conflict(bundle, 'Electron is not arm64-only');
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  if (!/^Signature=adhoc$/m.test(await run('/usr/bin/codesign', ['--display', '--verbose=2', bundle], { includeStderr: true }))) conflict(bundle, 'expected ad-hoc signature');
  const attributes = await run('/usr/bin/xattr', ['-r', bundle]);
  if (attributes.includes('com.apple.quarantine')) conflict(bundle, 'source-built bundle is quarantined; no quarantine removal or Gatekeeper bypass is permitted');
}
async function verifyInstalled(context, record, { capture = false } = {}) {
  const data = JSON.parse(await run(context.brew, ['info', '--json=v2', '--formula', formulaName]));
  const item = data.formulae?.[0];
  if (data.formulae?.length !== 1 || item.full_name !== formulaName || item.tap !== tapName || item.installed?.length !== 1 || item.installed[0].version !== record.inputs.version || item.installed[0].poured_from_bottle !== false) conflict(context.cellar, 'installed formula identity/version/source-build status differs');
  if (item.urls?.stable?.url !== pathToFileURL(record.inputs.source.archive).href || item.urls?.stable?.checksum !== record.inputs.source.sha256) conflict(context.tapFormula, 'Homebrew source URL/checksum differs');
  const keg = path.join(context.cellar, 'docm', item.installed[0].version);
  if ((await readdir(path.join(context.cellar, 'docm'))).some(name => name !== item.installed[0].version)) conflict(context.cellar, 'unrecorded docm keg or files exist');
  await identity(keg);
  const bundle = path.join(keg, 'libexec', installedDirectory);
  const launcher = path.join(bundle, launcherRelative(platform));
  const receiptPath = path.join(keg, 'INSTALL_RECEIPT.json');
  const receipt = await readJson(receiptPath);
  if (receipt.poured_from_bottle !== false || receipt.source?.tap !== tapName || receipt.source?.versions?.stable !== record.inputs.version) conflict(receiptPath, 'receipt is not this tap/version built from source');
  if (await hashFile(path.join(keg, '.brew/docm.rb')) !== record.formulaSha256) conflict(keg, 'installed formula differs from owned source recipe');
  const sourceReceipt = await readJson(path.join(keg, 'libexec/docm-source-receipt.json'));
  const expected = { schema: 1, project, ...(record.inputs.platform ? { platform: record.inputs.platform } : {}), version: record.inputs.version, inputsSha256: record.inputsSha256, source: record.inputs.source, resources: record.inputs.resources, tools: record.inputs.tools, toolResources: record.inputs.toolResources };
  if (JSON.stringify(sourceReceipt) !== JSON.stringify(expected)) conflict(keg, 'installed source/resource provenance differs');
  await verifyLink(context.binary, launcher);
  await verifyLink(path.join(keg, 'bin/docm'), launcher);
  await access(launcher, constants.X_OK);
  await verifyBundle(bundle, record.inputs.version);
  const installation = { keg, bundle, launcher, kegIdentity: await identity(keg), bundleIdentity: await identity(bundle), appSha256: await treeHash(bundle), kegSha256: await treeHash(keg), receiptSha256: await hashFile(receiptPath), provenanceSha256: await hashFile(path.join(keg, 'libexec/docm-source-receipt.json')) };
  if (!capture) {
    if (!record.installation) conflict(manifestPath, 'missing installed ownership');
    await sameIdentity(keg, record.installation.kegIdentity);
    await sameIdentity(bundle, record.installation.bundleIdentity);
    for (const field of ['keg', 'bundle', 'launcher', 'appSha256', 'kegSha256', 'receiptSha256', 'provenanceSha256']) if (installation[field] !== record.installation[field]) conflict(keg, `installed ${field} changed`);
  }
  return installation;
}
async function transaction(record, kind, action) {
  record.state = 'mutating';
  record.transaction = { kind, stage: 'validated', startedAt: new Date().toISOString() };
  await saveManifest(record);
  const stage = async value => { record.transaction.stage = value; await saveManifest(record); };
  try {
    await action(stage);
    delete record.transaction;
    await saveManifest(record);
  } catch (error) {
    record.state = 'mutation-failed';
    record.transaction.error = error.message;
    await saveManifest(record);
    throw new Error(`${error.message}\n${kind} stopped at ${record.transaction.stage}; inspect ${manifestPath} before retrying. No automatic adoption, tooling installation or security bypass was attempted.`);
  }
}
async function updateTreeRecords(context, record) {
  record.generatedTapIdentity = await identity(generatedTap);
  record.generatedTapSha256 = await treeHash(generatedTap);
  if (await exists(context.tap)) { record.tapIdentity = await identity(context.tap); record.tapSha256 = await treeHash(context.tap, true); }
}
async function prepare(context, previous, details) {
  if (previous?.schema === 2) {
    if (previous.inputsSha256 !== details.inputsSha256 || previous.formulaSha256 !== details.formulaSha256) conflict(manifestPath, 'source/resources changed; use explicit formula:refresh for an installed formula');
    return previous;
  }
  const record = { schema: 2, project, platform, tapName, generatedFormula, ...context, state: 'prepared', inputs: details.inputs, inputsSha256: details.inputsSha256, formulaSha256: details.formulaSha256 };
  if (previous) {
    record.legacy = previous;
    for (const field of ['generatedTapIdentity', 'generatedTapSha256', 'tapIdentity', 'tapSha256']) record[field] = previous[field];
    const historical = path.join(build, 'cask-verification.json');
    if (await exists(historical)) record.legacyVerification = { path: historical, sha256: await hashFile(historical), report: await readJson(historical) };
  }
  await mkdir(build, { recursive: true });
  await transaction(record, 'prepare', async stage => {
    await stage('writing-generated-formula');
    if (await exists(generatedFormula)) conflict(generatedFormula, 'no recorded ownership for existing formula');
    await mkdir(path.dirname(generatedFormula), { recursive: true });
    await writeFile(generatedFormula, details.formula, { flag: 'wx' });
    await updateTreeRecords(context, record);
    record.state = 'prepared';
  });
  return record;
}
async function writeOwnedFormula(location, content, expectedHash) {
  if (await hashFile(location) !== expectedHash) conflict(location, 'formula changed before replacement');
  const temporary = `${location}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, content, { flag: 'wx' }); await rename(temporary, location); }
  finally { await rm(temporary, { force: true }); }
}
async function install(context, record, details) {
  if (record.state === 'installed') { console.error(`Already installed source-built ${formulaName}: ${context.binary}`); return; }
  await preflight(context, record);
  await transaction(record, 'install', async stage => {
    if (record.legacy) {
      await stage('removing-recorded-legacy-installation');
      await run(context.brew, ['uninstall', '--cask', formulaName], { inherit: true, timeout: 600_000 });
      for (const location of [path.join(legacyAppdir, 'Docm.app'), context.binary, path.join(context.caskroom, 'docm')]) if (await exists(location)) conflict(location, 'legacy uninstall left an incomplete installation');
      await stage('removing-recorded-legacy-recipes');
      for (const location of [legacyCask, context.tapCask]) {
        if (await hashFile(location) !== record.legacy.caskSha256) conflict(location, 'legacy recipe changed during removal');
        await rm(location);
      }
      record.migration = { completedAt: new Date().toISOString(), previous: record.legacy };
      delete record.legacy;
      await updateTreeRecords(context, record);
    }
    if (!record.tapIdentity) {
      await stage('creating-owned-tap');
      await run(context.brew, ['tap-new', tapName], { inherit: true, env: { ...brewEnv, HOMEBREW_DEVELOPER: '1' } });
      record.tapIdentity = await identity(context.tap);
      await updateTreeRecords(context, record);
    }
    await stage('writing-dedicated-formula');
    if (await exists(context.tapFormula)) {
      if (await hashFile(context.tapFormula) !== record.formulaSha256) conflict(context.tapFormula, 'existing formula differs from its recorded ownership');
    } else {
      await mkdir(path.dirname(context.tapFormula), { recursive: true });
      await writeFile(context.tapFormula, details.formula, { flag: 'wx' });
    }
    await updateTreeRecords(context, record);
    await stage('building-from-source');
    await run(context.brew, ['install', '--formula', '--build-from-source', '--ignore-dependencies', formulaName], { timeout: 3_600_000, inherit: true });
    await stage('verifying-source-installation');
    record.installation = await verifyInstalled(context, record, { capture: true });
    await verifyTrees(context, record);
    record.state = 'installed';
  });
}
async function refresh(context, record, details) {
  if (record?.schema !== 2 || !['prepared', 'installed'].includes(record.state) || record.legacy) throw new Error('Explicit refresh requires a complete recorded source formula or prepared recipe.');
  const installed = record.state === 'installed';
  if (record.inputsSha256 === details.inputsSha256 && record.formulaSha256 === details.formulaSha256) { console.error('Source/resource inputs unchanged; no reinstall needed.'); return; }
  await transaction(record, 'refresh', async stage => {
    record.transaction.previous = { inputs: record.inputs, inputsSha256: record.inputsSha256, formulaSha256: record.formulaSha256, installation: record.installation };
    record.transaction.target = { inputs: details.inputs, inputsSha256: details.inputsSha256, formulaSha256: details.formulaSha256 };
    await stage('replacing-owned-formulas');
    await writeOwnedFormula(generatedFormula, details.formula, record.formulaSha256);
    if (record.tapIdentity) await writeOwnedFormula(context.tapFormula, details.formula, record.formulaSha256);
    record.platform = platform;
    record.inputs = details.inputs; record.inputsSha256 = details.inputsSha256; record.formulaSha256 = details.formulaSha256;
    await updateTreeRecords(context, record);
    if (!installed) { record.state = 'prepared'; return; }
    await stage('rebuilding-from-source');
    // Reinstall upgrades outdated build dependencies even when already present.
    // Reuse the install path that explicitly leaves the proven tools untouched.
    await run(context.brew, ['uninstall', '--formula', formulaName], { timeout: 600_000, inherit: true });
    await run(context.brew, ['install', '--formula', '--build-from-source', '--ignore-dependencies', formulaName], { timeout: 3_600_000, inherit: true });
    await stage('verifying-source-replacement');
    record.installation = await verifyInstalled(context, record, { capture: true });
    await verifyTrees(context, record);
    record.state = 'installed';
  });
}
async function smoke(context, record) {
  if (record?.schema !== 2 || record.state !== 'installed' || record.legacy) throw new Error('Source-built installed formula required; run mise run formula:install first.');
  const installation = await verifyInstalled(context, record);
  const reportPath = path.join(build, 'formula-verification.json');
  const report = { kind: 'source-formula-installed-smoke', platform, verifiedAt: new Date().toISOString(), formula: formulaName, inputsSha256: record.inputsSha256, source: record.inputs.source, resources: record.inputs.resources, installation, executable: context.binary, checks: { sourceBuildReceipt: true, sourceResourceProvenance: true, ownership: true, homebrewLauncherLink: true, nativePlatform: platformKey(platform), ...(macOS ? { nativeArm64: true, adHocDeepSignature: true, quarantineAbsent: true } : { nativeLinuxX64: true }) }, smoke: { status: 'running' } };
  await atomicJson(reportPath, report);
  try {
    const { runSmoke } = await import('./smoke.mjs');
    await runSmoke({ executable: context.binary, packaged: true, artifactsPath: path.join(build, 'formula-smoke') });
    report.smoke = { status: 'passed', artifactsPath: path.join(build, 'formula-smoke') };
  } catch (error) { report.smoke = { status: 'failed', error: error.message }; throw error; }
  finally { await atomicJson(reportPath, report); }
}
async function main() {
  const command = process.argv[2];
  if (!['prepare', 'install', 'refresh', 'smoke'].includes(command) || process.argv.length !== 3) throw new Error('Usage: mise run formula:prepare | formula:install | formula:refresh | formula:smoke');
  const context = await brewContext();
  let record = await readManifest();
  await preflight(context, record);
  const details = await distribution();
  if (command === 'refresh') await refresh(context, record, details);
  else if (command === 'smoke') {
    if (record?.inputsSha256 !== details.inputsSha256 || record?.formulaSha256 !== details.formulaSha256) conflict(inputsPath, 'inputs differ from installed ownership; explicit refresh required');
    await smoke(context, record);
  } else {
    record = await prepare(context, record, details);
    if (command === 'install') await install(context, record, details);
    console.error(`Source formula ${record.state}: ${generatedFormula}\nsource=${record.inputs.source.sha256}\nlauncher=${context.binary}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
