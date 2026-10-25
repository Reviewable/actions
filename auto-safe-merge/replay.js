'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {isDeepStrictEqual: equal} = require('node:util');
const tar = require('tar');
const {insist, yarnVersion, seedLockfile, verifyLockfile, applyManifest} = require('./plan');

const execute = promisify(execFile);

async function regularFile(root, name) {
  const file = path.resolve(root, name);
  insist(file.startsWith(root + path.sep), `Path escapes checkout: ${name}`);
  let current = root;
  for (const part of name.split('/')) {
    current = path.join(current, part);
    insist(!(await fs.lstat(current)).isSymbolicLink(), `Symlink in replay input: ${name}`);
  }
  insist((await fs.stat(file)).isFile(), `Not a file: ${name}`);
  return file;
}

function replayEnvironment(scratch) {
  // No GitHub credentials, NODE_OPTIONS, or package-manager overrides reach the child process.
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return {...env, HOME: scratch, USERPROFILE: scratch,
    COREPACK_HOME: path.join(scratch, 'corepack'),
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', COREPACK_ENABLE_AUTO_PIN: '0',
    YARN_ENABLE_SCRIPTS: 'false', YARN_ENABLE_TELEMETRY: 'false', YARN_IGNORE_PATH: 'true',
    YARN_ENABLE_IMMUTABLE_INSTALLS: 'false', YARN_ENABLE_GLOBAL_CACHE: 'true',
    YARN_GLOBAL_FOLDER: path.join(scratch, 'yarn-global'),
    YARN_CACHE_FOLDER: path.join(scratch, 'yarn-cache'),
    npm_config_ignore_scripts: 'true', npm_config_cache: path.join(scratch, 'npm-cache'),
    CI: 'true'};
}

async function runYarn({cwd, pin, scratch, immutable = false}) {
  yarnVersion(pin);
  const args = [pin, 'install', '--mode=update-lockfile',
    '--check-resolutions', '--refresh-lockfile'];
  // Yarn forbids --immutable with update-lockfile. Compare bytes without linking/building.
  const before = immutable ? await fs.readFile(path.join(cwd, 'yarn.lock'), 'utf8') : null;
  const windows = process.platform === 'win32';
  const command = windows ? process.execPath : 'corepack';
  if (windows) {
    args.unshift(path.join(path.dirname(process.execPath),
      'node_modules/corepack/dist/corepack.js'));
  }
  try {
    const result = await execute(command, args, {cwd, env: replayEnvironment(scratch),
      timeout: 5 * 60 * 1000, maxBuffer: 4 * 1024 * 1024, windowsHide: true});
    insist(!immutable || before === await fs.readFile(path.join(cwd, 'yarn.lock'), 'utf8'),
      'Yarn changed the reconstructed lockfile on validation');
    return result;
  } catch (error) {
    throw new Error(`Yarn replay failed in ${path.basename(cwd)}: ` +
      `${error.stdout || ''}\n${error.stderr || error.message}`, {cause: error});
  }
}

async function reconstruct({root, scratch, plan, expected, yarn = runYarn}) {
  root = path.resolve(root);
  const originals = new Map();
  const projects = Object.keys(plan.lockfiles).map(file => path.posix.dirname(file));
  for (const [file, changes] of Object.entries(plan.manifests || {})) {
    const manifest = await regularFile(root, file);
    // A workspace publication bump belongs to its nearest owning lockfile.
    let directory = path.posix.dirname(file);
    while (!projects.includes(directory)) {
      insist(directory !== '.', `No owning lockfile declared for ${file}`);
      insist(!(await fs.stat(path.join(root, directory, 'yarn.lock')).catch(() => null)),
        `Owning lockfile omitted for ${file}`);
      directory = path.posix.dirname(directory);
    }
    const updated = applyManifest(await fs.readFile(manifest, 'utf8'), changes, file);
    insist(updated === expected.get(file), `Manifest contains undeclared changes: ${file}`);
    await fs.writeFile(manifest, updated);
  }
  for (const [file, changes] of Object.entries(plan.lockfiles)) {
    const lock = await regularFile(root, file);
    const before = await fs.readFile(lock, 'utf8');
    originals.set(file, before);
    await fs.writeFile(lock, seedLockfile(before, changes));
  }
  const manifests = new Map();
  async function rememberManifests(directory) {
    for (const entry of await fs.readdir(directory, {withFileTypes: true})) {
      if (['.git', '.yarn', 'node_modules'].includes(entry.name)) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await rememberManifests(file);
      } else if (entry.isFile() && entry.name === 'package.json') {
        manifests.set(file, JSON.parse(await fs.readFile(file, 'utf8')));
      }
    }
  }
  await rememberManifests(root);
  for (const file of Object.keys(plan.lockfiles)) {
    const cwd = path.join(root, path.posix.dirname(file));
    const manifest = JSON.parse(await fs.readFile(await regularFile(root,
      path.posix.join(path.posix.dirname(file), 'package.json')), 'utf8'));
    yarnVersion(manifest.packageManager);
    await yarn({cwd, pin: manifest.packageManager, scratch});
    await yarn({cwd, pin: manifest.packageManager, scratch, immutable: true});
  }
  for (const [file, changes] of Object.entries(plan.lockfiles)) {
    verifyLockfile(originals.get(file), await fs.readFile(path.join(root, file), 'utf8'),
      expected.get(file), changes, file);
  }
  for (const file of Object.keys(plan.manifests || {})) {
    insist(await fs.readFile(path.join(root, file), 'utf8') === expected.get(file),
      `Yarn changed the declared manifest: ${file}`);
  }
  for (const [file, value] of manifests) {
    insist(equal(JSON.parse(await fs.readFile(file, 'utf8')), value),
      `Yarn changed manifest content during replay: ${path.relative(root, file)}`);
  }
}

async function replay({github, owner, repo, baseSha, plan, expected}) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-safe-merge-'));
  try {
    const root = path.join(scratch, 'repository');
    await fs.mkdir(root);
    const archive = path.join(scratch, 'baseline.tar.gz');
    const {data} = await github.rest.repos.downloadTarballArchive({owner, repo, ref: baseSha});
    await fs.writeFile(archive, Buffer.from(data));
    await tar.x({file: archive, cwd: root, strip: 1, strict: true,
      filter: (name, entry) => {
        insist(['File', 'Directory'].includes(entry.type),
          `Unsupported archive entry: ${name} (${entry.type})`);
        insist(!name.split('/').includes('..') && !name.includes('\\') &&
          !path.posix.isAbsolute(name), `Unsafe archive path: ${name}`);
        return !name.split('/').some(part => ['.git', 'node_modules'].includes(part));
      }});
    await reconstruct({root, scratch, plan, expected});
  } finally {
    await fs.rm(scratch, {recursive: true, force: true});
  }
}

module.exports = {replayEnvironment, runYarn, reconstruct, replay};
