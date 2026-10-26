import {test} from 'node:test';
import assert from 'node:assert/strict';
import {stringifySyml} from '@yarnpkg/parsers';
import {SCHEMA, parsePlan, validatePlan, isCompatible, parseYarnVersion, seedLockfile,
  parseLockfile, verifyLockfile, validateDirectUpdates, applyManifest} from './plan.js';
import {formatPlan} from './describe.js';

const baseline = stringifySyml({__metadata: {version: 8, cacheKey: '10c0'},
  'leaf@npm:^1.0.0': {version: '1.0.0', resolution: 'leaf@npm:1.0.0', checksum: 'old'},
  'alias@npm:leaf@~1.0.0': {version: '1.0.0', resolution: 'leaf@npm:1.0.0'}});
const createRecipe = () => ({schema: SCHEMA, lockfiles: {'yarn.lock': {
  'leaf@npm:^1.0.0': {from: '1.0.0', to: '1.1.0'}}}});

test('extracts exactly one recipe among prose and unrelated fences', () => {
  const body = 'Prose\n```js\nexample()\n```\n\n```yaml\n' +
    'schema: reviewable-dependency-updates/v1\nlockfiles:\n  yarn.lock:\n' +
    '    "leaf@npm:^1.0.0": {from: "1.0.0", to: "1.1.0"}\n```\nOther prose';
  assert.deepEqual(parsePlan(body), createRecipe());
  assert.throws(() => parsePlan(body + '\n' + body), /exactly one/);
  assert.deepEqual(parsePlan(formatPlan(createRecipe())), createRecipe());
});

test('rejects duplicate YAML keys, aliases, unknown schema and fields', () => {
  for (const yaml of [
    'schema: reviewable-dependency-updates/v1\nlockfiles: {}\nlockfiles: {}',
    'schema: reviewable-dependency-updates/v1\nlockfiles: &x {yarn.lock: *x}',
    'schema: reviewable-dependency-updates/v2\nlockfiles: {yarn.lock: {}}',
    'schema: reviewable-dependency-updates/v1\nlockfiles: {yarn.lock: {}}\ncommand: whoami',
  ]) assert.throws(() => parsePlan(`\`\`\`yaml\n${yaml}\n\`\`\``));
});

test('paths and versions cannot contain arbitrary commands or traverse directories', () => {
  for (const file of ['../yarn.lock', '/yarn.lock', 'C:/yarn.lock', 'x\\yarn.lock',
    '.git/yarn.lock', 'node_modules/yarn.lock', 'x/./yarn.lock']) {
    assert.throws(() => validatePlan({...createRecipe(), lockfiles: {[file]: {}}}), /Invalid/);
  }
  for (const version of [1.1, '^1.1.0', '1.1.0-beta.1', 'latest', '1.1.0+build']) {
    const plan = createRecipe();
    plan.lockfiles['yarn.lock']['leaf@npm:^1.0.0'].to = version;
    assert.throws(() => validatePlan(plan), /exact quoted stable/);
  }
});

test('semver uses pre-1.0 compatibility boundaries and rejects downgrades', () => {
  for (const [from, to] of [['1.0.0', '1.2.0'], ['0.2.1', '0.2.2']]) {
    assert.equal(isCompatible(from, to), true);
  }
  for (const [from, to] of [['1.0.0', '2.0.0'], ['0.2.1', '0.3.0'],
    ['0.0.1', '0.0.2'], ['1.1.0', '1.0.0']]) assert.equal(isCompatible(from, to), false);
});

test('seed targets individual descriptors and preserves other copies', () => {
  const seeded = parseLockfile(seedLockfile(baseline, createRecipe().lockfiles['yarn.lock']));
  assert.equal(seeded.entries.get('leaf@npm:^1.0.0').version, '1.1.0');
  assert.equal(seeded.entries.get('leaf@npm:^1.0.0').checksum, undefined);
  assert.equal(seeded.entries.get('alias@npm:leaf@~1.0.0').version, '1.0.0');
  assert.throws(() => seedLockfile(baseline, {
    'leaf@npm:^1.0.0': {from: '1.0.1', to: '1.1.0'}}), /Stale from/);
});

test('seeding allows transitive majors and descriptor replacements but not downgrades', () => {
  assert.doesNotThrow(() => seedLockfile(baseline, {
    'leaf@npm:^2.0.0': {from: null, to: '2.0.0'}}));
  assert.doesNotThrow(() => seedLockfile(baseline, {
    'new-package@npm:^1.0.0': {from: null, to: '1.0.0'},
    'leaf@npm:^1.0.0': {from: '1.0.0', to: null}}));
  assert.throws(() => seedLockfile(baseline, {
    'leaf@npm:^1.0.0': {from: '1.0.0', to: '0.9.0'}}), /downgrade/);
});

test('only direct descriptors must stay compatible, including workspace aliases and broad ranges',
  () => {
    for (const [from, to] of [['1.0.0', '2.0.0'], ['0.2.0', '0.3.0'], ['0.0.1', '0.0.2']]) {
      const before = parseLockfile(stringifySyml({__metadata: {version: 8},
        'root@workspace:.': {version: '0.0.0-use.local', resolution: 'root@workspace:.'},
        'child@workspace:packages/child': {version: '0.0.0-use.local',
          resolution: 'child@workspace:packages/child', dependencies: {alias: 'npm:leaf:*'}},
        'alias@npm:leaf:*': {version: from, resolution: `leaf@npm:${from}`},
        'leaf@npm:*': {version: from, resolution: `leaf@npm:${from}`}}));
      const after = structuredClone(before);
      after.entries.set('leaf@npm:*', {version: to, resolution: `leaf@npm:${to}`});
      assert.doesNotThrow(() => validateDirectUpdates(before, after));
      after.entries.set('alias@npm:leaf:*', {version: to, resolution: `leaf@npm:${to}`});
      assert.throws(() => validateDirectUpdates(before, after), /Breaking direct/);
      after.entries.delete('alias@npm:leaf:*');
      assert.throws(() => validateDirectUpdates(before, after), /removal/);
    }
  });

test('Yarn pins require the CLI features introduced in 4.0', () => {
  assert.equal(parseYarnVersion('yarn@4.0.0'), '4.0.0');
  assert.equal(parseYarnVersion('yarn@4.13.0+sha224.abcdef'), '4.13.0');
  assert.throws(() => parseYarnVersion('yarn@3.8.7'), /4.0.0/);
  assert.throws(() => parseYarnVersion('yarn@latest'), /exact/);
});

test('manifest-only recipes round-trip without a lockfile section', () => {
  const plan = {schema: SCHEMA, manifests: {'package.json': {
    packageManager: {from: 'yarn@4.0.0', to: 'yarn@4.13.0'}}}};
  assert.deepEqual(parsePlan(formatPlan(plan)), plan);
  assert.throws(() => validatePlan({schema: SCHEMA}), /At least one/);
});

test('proof requires every version change and byte-identical output', () => {
  const changes = createRecipe().lockfiles['yarn.lock'];
  const actual = seedLockfile(baseline, changes);
  assert.doesNotThrow(() => verifyLockfile(baseline, actual, actual, changes, 'yarn.lock'));
  assert.throws(() => verifyLockfile(baseline, actual, actual + '# tampered\n', changes,
    'yarn.lock'), /exactly match/);
  assert.throws(() => verifyLockfile(baseline, actual, actual, {}, 'yarn.lock'), /all generated/);
});

test('manifest edits preserve formatting and permit only publication patches and Yarn pins', () => {
  const before = '{\n  "version": "1.0.0",\n  "bundleDependencies": true,\n' +
    '  "packageManager": "yarn@4.13.0",\n  "scripts": {"version": "do-not-touch"}\n}\n';
  const changes = {version: {from: '1.0.0', to: '1.0.1'},
    packageManager: {from: 'yarn@4.13.0', to: 'yarn@4.18.1'}};
  assert.equal(applyManifest(before, changes, 'package.json'),
    before.replace('"1.0.0"', '"1.0.1"').replace('yarn@4.13.0', 'yarn@4.18.1'));
  assert.throws(() => applyManifest(before.replace('true', 'false'), changes, 'package.json'),
    /bundleDependencies/);
  assert.throws(() => applyManifest(before, {version: {from: '1.0.0', to: '1.1.0'}},
    'package.json'), /one patch/);
});
