import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import * as tar from 'tar';
import {SCHEMA, parseLockfile, describeChanges, seedLockfile} from './plan.js';
import {runYarn, reconstruct, createReplayEnvironment} from './replay.js';

test('replay children receive no GitHub credentials or arbitrary Node options', () => {
  const env = createReplayEnvironment('/scratch');
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.REVIEWABLE_GITHUB_TOKEN, undefined);
  assert.equal(env.YARN_ENABLE_SCRIPTS, 'false');
});

test('invalid archive entries reject normally and remove the replay directory', async t => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-rejection-test-'));
  t.after(() => fs.rm(scratch, {recursive: true, force: true}));
  // Isolate the stream callback: an uncaught exception must fail the child, not this test runner.
  await promisify(execFile)(process.execPath,
    [fileURLToPath(new URL('./fixtures/archive-rejection.js', import.meta.url))], {
      env: {...process.env, TMPDIR: scratch, TEMP: scratch, TMP: scratch},
      timeout: 10000, windowsHide: true,
    });
});

test('real Yarn compatibility patches replay from their underlying npm selections',
  {timeout: 180000}, async t => {
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'yarn-patches-test-'));
    t.after(() => fs.rm(scratch, {recursive: true, force: true}));
    const versions = {resolve: ['1.22.10', '1.22.11'], typescript: ['5.4.4', '5.4.5'],
      fsevents: ['2.3.2', '2.3.3']};
    const manifest = JSON.stringify({name: 'patch-fixture', private: true,
      packageManager: 'yarn@4.13.0', dependencies: {resolve: '^1.22.10'},
      devDependencies: {typescript: '^5.4.4'}, optionalDependencies: {fsevents: '^2.3.2'}});
    async function project(name, stage) {
      const root = path.join(scratch, name);
      await fs.mkdir(root);
      await fs.writeFile(path.join(root, 'package.json'), manifest);
      await fs.writeFile(path.join(root, '.yarnrc.yml'), 'nodeLinker: node-modules\n');
      const selections = Object.fromEntries(Object.entries(versions).map(([pkg, pair]) =>
        [`${pkg}@npm:^${pair[0]}`, {from: null, to: pair[stage]}]));
      await fs.writeFile(path.join(root, 'yarn.lock'),
        seedLockfile('__metadata:\n  version: 8\n', selections));
      await runYarn({cwd: root, pin: 'yarn@4.13.0', scratch});
      return root;
    }
    const root = await project('baseline', 0);
    const expectedRoot = await project('expected', 1);
    const before = await fs.readFile(path.join(root, 'yarn.lock'), 'utf8');
    const after = await fs.readFile(path.join(expectedRoot, 'yarn.lock'), 'utf8');
    const changes = describeChanges(parseLockfile(before), parseLockfile(after));
    assert.equal(Object.keys(changes).some(selector => selector.includes('@patch:')), false);
    for (const [name, [from, to]] of Object.entries(versions)) {
      assert.deepEqual(changes[`${name}@npm:^${from}`], {from, to});
      const wrapper = `${name}@patch:${name}@npm%3A^${from}#optional!builtin<compat/${name}>`;
      assert.equal(parseLockfile(after).entries.get(wrapper).version, to);
    }
    await reconstruct({root, scratch, plan: {schema: SCHEMA, lockfiles: {'yarn.lock': changes}},
      expected: new Map([['yarn.lock', after]])});
  });

test('real Corepack Yarn replay: transitive majors, aliases, additions and future releases',
  {timeout: 180000}, async t => {
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'yarn-replay-test-'));
    t.after(() => fs.rm(scratch, {recursive: true, force: true}));
    let stage = 0;
    const packages = {}, archives = new Map();
    const server = http.createServer((request, response) => {
      if (archives.has(request.url)) return response.end(archives.get(request.url));
      const name = decodeURIComponent(request.url.slice(1));
      const versions = Object.fromEntries(Object.entries(packages[name] || {})
        .filter(([, pkg]) => pkg.stage <= stage).map(([version, pkg]) => [version, pkg.value]));
      if (!Object.keys(versions).length) {
        response.writeHead(404);
        return response.end('{}');
      }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({name, versions,
        'dist-tags': {latest: Object.keys(versions).at(-1)}}));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const registry = `http://127.0.0.1:${server.address().port}`;
    async function publish(name, version, release, extra = {}) {
      const value = {name, version, ...extra};
      const source = path.join(scratch, 'sources', `${name}-${version}`);
      await fs.mkdir(path.join(source, 'package'), {recursive: true});
      await fs.writeFile(path.join(source, 'package/package.json'), JSON.stringify(value));
      const archive = path.join(source, 'archive.tgz');
      await tar.c({gzip: true, file: archive, cwd: source}, ['package']);
      const bytes = await fs.readFile(archive);
      const url = `/${name}/-/${name}-${version}.tgz`;
      archives.set(url, bytes);
      (packages[name] ||= {})[version] = {stage: release, value: {...value, dist: {
        tarball: registry + url,
        shasum: crypto.createHash('sha1').update(bytes).digest('hex'),
        integrity: 'sha512-' + crypto.createHash('sha512').update(bytes).digest('base64'),
      }}};
    }
    for (const [version, release] of [['1.0.0', 0], ['1.1.0', 1], ['1.2.0', 2]]) {
      await publish('leaf', version, release, {scripts: {postinstall: 'exit 42'}});
    }
    await publish('leaf', '2.0.0', 1);
    await publish('broad', '1.0.0', 0);
    await publish('broad', '2.0.0', 1);
    await publish('obsolete', '1.0.0', 0);
    await publish('zero', '0.2.0', 0);
    await publish('zero', '0.2.1', 1);
    await publish('platform', '1.0.0', 0, {os: ['darwin']});
    await publish('platform', '1.0.1', 1, {os: ['darwin']});
    await publish('parent', '1.0.0', 0,
      {dependencies: {leaf: '^1.0.0', obsolete: '^1.0.0', broad: '*'}});
    await publish('parent', '1.1.0', 1, {dependencies: {leaf: '^2.0.0', broad: '*'}});
    const manifest = JSON.stringify({name: 'fixture', version: '1.0.0', private: true,
      packageManager: 'yarn@4.13.0', dependencies: {parent: '^1.0.0', alias: 'npm:leaf@^1.0.0',
        pinned: 'npm:leaf@~1.0.0', zero: '^0.2.0'}, optionalDependencies: {platform: '^1.0.0'}});
    async function createProject(name, lock) {
      const root = path.join(scratch, name);
      await fs.mkdir(root);
      await fs.writeFile(path.join(root, 'package.json'), manifest);
      await fs.writeFile(path.join(root, '.yarnrc.yml'),
        `nodeLinker: node-modules\nnpmRegistryServer: ${registry}\n` +
        'unsafeHttpWhitelist: [127.0.0.1]\n');
      if (lock) await fs.writeFile(path.join(root, 'yarn.lock'), lock);
      return root;
    }
    const baselineRoot = await createProject('baseline');
    await runYarn({cwd: baselineRoot, pin: 'yarn@4.13.0', scratch});
    const before = await fs.readFile(path.join(baselineRoot, 'yarn.lock'), 'utf8');
    stage = 1;
    const expectedRoot = await createProject('expected');
    await runYarn({cwd: expectedRoot, pin: 'yarn@4.13.0', scratch});
    const after = await fs.readFile(path.join(expectedRoot, 'yarn.lock'), 'utf8');
    const changes = describeChanges(parseLockfile(before), parseLockfile(after));
    assert.deepEqual(changes['obsolete@npm:^1.0.0'], {from: '1.0.0', to: null});
    assert.deepEqual(changes['leaf@npm:^2.0.0'], {from: null, to: '2.0.0'});
    assert.deepEqual(changes['broad@npm:*'], {from: '1.0.0', to: '2.0.0'});
    const plan = {schema: SCHEMA, lockfiles: {'yarn.lock': changes}};
    stage = 2;
    const root = await createProject('replay', before);
    const expected = new Map([['yarn.lock', after]]);
    try {
      await reconstruct({root, scratch, plan, expected});
    } catch (error) {
      assert.equal(await fs.readFile(path.join(root, 'yarn.lock'), 'utf8'), after, error.message);
      throw error;
    }
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')),
      JSON.parse(manifest));
    assert.equal(await fs.stat(path.join(root, 'node_modules')).catch(() => null), null);
    // A syntactically valid but out-of-range resolution must fail Yarn's native check.
    const invalid = await createProject('invalid', seedLockfile(before, {
      'pinned@npm:leaf@~1.0.0': {from: '1.0.0', to: '1.1.0'}}));
    await assert.rejects(runYarn({cwd: invalid, pin: 'yarn@4.13.0', scratch}), /YN0078/);
    const tampered = await createProject('tampered', before);
    expected.set('yarn.lock', after.replace(/checksum: [^\n]+/, 'checksum: bad'));
    await assert.rejects(reconstruct({root: tampered, scratch, plan, expected}), /exactly match/);

    // A publication bump and a new Corepack pin, plus an independent nested Yarn project.
    const bundled = JSON.parse(await fs.readFile(path.join(baselineRoot, 'package.json'), 'utf8'));
    bundled.bundleDependencies = true;
    const originalManifest = JSON.stringify(bundled, null, 2) + '\n';
    bundled.version = '1.0.1';
    bundled.packageManager = 'yarn@4.18.1';
    const newManifest = JSON.stringify(bundled, null, 2) + '\n';
    const metadataExpected = await createProject('metadata-expected', after);
    await fs.writeFile(path.join(metadataExpected, 'package.json'), newManifest);
    await runYarn({cwd: metadataExpected, pin: bundled.packageManager, scratch});
    const newLock = await fs.readFile(path.join(metadataExpected, 'yarn.lock'), 'utf8');
    const metadataRoot = await createProject('metadata-replay', before);
    await fs.writeFile(path.join(metadataRoot, 'package.json'), originalManifest);
    const nested = await createProject('nested', before);
    const nestedManifest = JSON.stringify(JSON.parse(
      await fs.readFile(path.join(baselineRoot, 'package.json'), 'utf8')), null, 2) + '\n';
    await fs.writeFile(path.join(nested, 'package.json'), nestedManifest);
    await fs.rename(nested, path.join(metadataRoot, 'tools'));
    const metadataPlan = {schema: SCHEMA, lockfiles: {
      'yarn.lock': describeChanges(parseLockfile(before), parseLockfile(newLock)),
      'tools/yarn.lock': describeChanges(parseLockfile(before), parseLockfile(newLock)),
    }, manifests: {'package.json': {
      version: {from: '1.0.0', to: '1.0.1'},
      packageManager: {from: 'yarn@4.13.0', to: 'yarn@4.18.1'},
    }, 'tools/package.json': {
      packageManager: {from: 'yarn@4.13.0', to: 'yarn@4.18.1'},
    }}};
    await reconstruct({root: metadataRoot, scratch, plan: metadataPlan,
      expected: new Map([['yarn.lock', newLock], ['tools/yarn.lock', newLock],
        ['package.json', newManifest], ['tools/package.json',
          nestedManifest.replace('yarn@4.13.0', 'yarn@4.18.1')]])});

    // Exercise the minimum CLI version against its own native checksum formatting.
    const minimum = await createProject('minimum', before);
    const minimumManifest = manifest.replace('yarn@4.13.0', 'yarn@4.0.0');
    await fs.writeFile(path.join(minimum, 'package.json'), minimumManifest);
    await runYarn({cwd: minimum, pin: 'yarn@4.0.0', scratch});
    const minimumExpected = await createProject('minimum-expected', after);
    await fs.writeFile(path.join(minimumExpected, 'package.json'), minimumManifest);
    await runYarn({cwd: minimumExpected, pin: 'yarn@4.0.0', scratch});
    const minimumAfter = await fs.readFile(path.join(minimumExpected, 'yarn.lock'), 'utf8');
    await reconstruct({root: minimum, scratch, plan,
      expected: new Map([['yarn.lock', minimumAfter]])});
    const minimumInvalid = await createProject('minimum-invalid', seedLockfile(minimumAfter, {
      'pinned@npm:leaf@~1.0.0': {from: '1.0.0', to: '1.1.0'}}));
    await fs.writeFile(path.join(minimumInvalid, 'package.json'), minimumManifest);
    await assert.rejects(runYarn({cwd: minimumInvalid, pin: 'yarn@4.0.0', scratch}), /YN0078/);

    // Pin-only updates still verify that their omitted lockfile remains unchanged.
    const pinRoot = await createProject('pin-only', newLock);
    const pinBeforeManifest = manifest.replace('yarn@4.13.0', 'yarn@4.18.0');
    await fs.writeFile(path.join(pinRoot, 'package.json'), pinBeforeManifest);
    await runYarn({cwd: pinRoot, pin: 'yarn@4.18.0', scratch});
    const pinManifest = await fs.readFile(path.join(pinRoot, 'package.json'), 'utf8');
    const pinBeforeLock = await fs.readFile(path.join(pinRoot, 'yarn.lock'), 'utf8');
    const pinOnly = {schema: SCHEMA, manifests: {'package.json': {
      packageManager: {from: 'yarn@4.18.0', to: 'yarn@4.18.1'}}}};
    await reconstruct({root: pinRoot, scratch, plan: pinOnly,
      expected: new Map([['package.json', pinManifest.replace('yarn@4.18.0', 'yarn@4.18.1')]])});
    assert.equal(await fs.readFile(path.join(pinRoot, 'yarn.lock'), 'utf8'), pinBeforeLock);
    const minimumBeforePin = await fs.readFile(path.join(minimum, 'package.json'), 'utf8');
    await assert.rejects(
      reconstruct({root: minimum, scratch,
        plan: {schema: SCHEMA, manifests: {'package.json': {
          packageManager: {from: 'yarn@4.0.0', to: 'yarn@4.13.0'}}}},
        expected: new Map([
          ['package.json', minimumBeforePin.replace('yarn@4.0.0', 'yarn@4.13.0')]])}),
      /exactly match/);

    async function createWorkspacePinUpdate(name, ownerPin, from, to) {
      const projectRoot = await createProject(name, after);
      await fs.writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
        ...JSON.parse(manifest), packageManager: ownerPin, workspaces: ['packages/*']}));
      const file = 'packages/child/package.json';
      await fs.mkdir(path.dirname(path.join(projectRoot, file)), {recursive: true});
      const child = JSON.stringify({name: 'child', private: true, packageManager: from});
      await fs.writeFile(path.join(projectRoot, file), child);
      await runYarn({cwd: projectRoot, pin: ownerPin, scratch});
      const beforeManifest = await fs.readFile(path.join(projectRoot, file), 'utf8');
      return {root: projectRoot, scratch, plan: {schema: SCHEMA, manifests: {
        [file]: {packageManager: {from, to}}}},
      expected: new Map([[file, beforeManifest.replace(from, to)]])};
    }
    await t.test('a nested workspace pin can preserve its shared lockfile', async () => {
      const fixture = await createWorkspacePinUpdate(
        'workspace-pin', 'yarn@4.18.0', 'yarn@4.18.0', 'yarn@4.18.1');
      const lock = await fs.readFile(path.join(fixture.root, 'yarn.lock'), 'utf8');
      await reconstruct(fixture);
      assert.equal(await fs.readFile(path.join(fixture.root, 'yarn.lock'), 'utf8'), lock);
      assert.equal(await fs.stat(path.join(fixture.root, 'packages/child/yarn.lock'))
        .catch(() => null), null);
    });
    await t.test('an invalid nested pin integrity hash fails Corepack', async () => {
      const fixture = await createWorkspacePinUpdate('workspace-bad-pin', 'yarn@4.18.1',
        'yarn@4.18.1', 'yarn@4.18.1+sha512.' + '0'.repeat(128));
      // The owner has already cached this version; that must not hide the invalid new hash.
      await assert.rejects(reconstruct(fixture), /Mismatch hashes/);
    });
    await t.test('a nested pin must preserve the owner pin\'s lockfile bytes', async () => {
      const fixture = await createWorkspacePinUpdate(
        'workspace-format', 'yarn@4.0.0', 'yarn@4.0.0', 'yarn@4.13.0');
      await assert.rejects(reconstruct(fixture), /changed the reconstructed lockfile/);
    });

    // The same broad transitive descriptor becomes direct when a workspace devDependency uses it.
    stage = 0;
    const workspaceRoot = await createProject('workspace');
    const workspaceManifest = JSON.stringify({...JSON.parse(manifest), workspaces: ['packages/*']});
    await fs.writeFile(path.join(workspaceRoot, 'package.json'), workspaceManifest);
    await fs.mkdir(path.join(workspaceRoot, 'packages/child'), {recursive: true});
    await fs.writeFile(path.join(workspaceRoot, 'packages/child/package.json'),
      JSON.stringify({name: 'child', version: '1.0.0', devDependencies: {broad: '*'}}));
    await runYarn({cwd: workspaceRoot, pin: 'yarn@4.13.0', scratch});
    const workspaceBefore = await fs.readFile(path.join(workspaceRoot, 'yarn.lock'), 'utf8');
    stage = 1;
    await fs.writeFile(path.join(workspaceRoot, 'yarn.lock'), '');
    await runYarn({cwd: workspaceRoot, pin: 'yarn@4.13.0', scratch});
    const workspaceAfter = await fs.readFile(path.join(workspaceRoot, 'yarn.lock'), 'utf8');
    await fs.writeFile(path.join(workspaceRoot, 'yarn.lock'), workspaceBefore);
    await assert.rejects(reconstruct({root: workspaceRoot, scratch,
      plan: {schema: SCHEMA, lockfiles: {'yarn.lock':
        describeChanges(parseLockfile(workspaceBefore), parseLockfile(workspaceAfter))}},
      expected: new Map([['yarn.lock', workspaceAfter]])}), /Breaking direct.*broad/);
  });
