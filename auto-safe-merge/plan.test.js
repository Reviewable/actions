'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {stringifySyml} = require('@yarnpkg/parsers');
const {SCHEMA, parsePlan, validatePlan, compatible, seedLockfile, lockfile,
  verifyLockfile, applyManifest} = require('./plan');
const {format} = require('./describe');

const baseline = stringifySyml({__metadata: {version: 8, cacheKey: '10c0'},
  'leaf@npm:^1.0.0': {version: '1.0.0', resolution: 'leaf@npm:1.0.0', checksum: 'old'},
  'alias@npm:leaf@~1.0.0': {version: '1.0.0', resolution: 'leaf@npm:1.0.0'}});
const recipe = () => ({schema: SCHEMA, lockfiles: {'yarn.lock': {
  'leaf@npm:^1.0.0': {from: '1.0.0', to: '1.1.0'}}}});

test('extracts exactly one recipe among prose and unrelated fences', () => {
  const body = 'Prose\n```js\nexample()\n```\n\n```yaml\n' +
    'schema: reviewable-dependency-updates/v1\nlockfiles:\n  yarn.lock:\n' +
    '    "leaf@npm:^1.0.0": {from: "1.0.0", to: "1.1.0"}\n```\nOther prose';
  assert.deepEqual(parsePlan(body), recipe());
  assert.throws(() => parsePlan(body + '\n' + body), /exactly one/);
  assert.deepEqual(parsePlan(format(recipe())), recipe());
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
    assert.throws(() => validatePlan({...recipe(), lockfiles: {[file]: {}}}), /Invalid/);
  }
  for (const version of [1.1, '^1.1.0', '1.1.0-beta.1', 'latest', '1.1.0+build']) {
    const plan = recipe();
    plan.lockfiles['yarn.lock']['leaf@npm:^1.0.0'].to = version;
    assert.throws(() => validatePlan(plan), /exact quoted stable/);
  }
});

test('semver uses pre-1.0 compatibility boundaries and rejects downgrades', () => {
  for (const [from, to] of [['1.0.0', '1.2.0'], ['0.2.1', '0.2.2']]) {
    assert.equal(compatible(from, to), true);
  }
  for (const [from, to] of [['1.0.0', '2.0.0'], ['0.2.1', '0.3.0'],
    ['0.0.1', '0.0.2'], ['1.1.0', '1.0.0']]) assert.equal(compatible(from, to), false);
});

test('seed targets individual descriptors and preserves other copies', () => {
  const seeded = lockfile(seedLockfile(baseline, recipe().lockfiles['yarn.lock']));
  assert.equal(seeded.entries.get('leaf@npm:^1.0.0').version, '1.1.0');
  assert.equal(seeded.entries.get('leaf@npm:^1.0.0').checksum, undefined);
  assert.equal(seeded.entries.get('alias@npm:leaf@~1.0.0').version, '1.0.0');
  assert.throws(() => seedLockfile(baseline, {
    'leaf@npm:^1.0.0': {from: '1.0.1', to: '1.1.0'}}), /Stale from/);
});

test('new descriptors cannot conceal a major upgrade to an existing package', () => {
  assert.throws(() => seedLockfile(baseline, {
    'leaf@npm:^2.0.0': {from: null, to: '2.0.0'}}), /crosses/);
  assert.doesNotThrow(() => seedLockfile(baseline, {
    'new-package@npm:^1.0.0': {from: null, to: '1.0.0'},
    'leaf@npm:^1.0.0': {from: '1.0.0', to: null}}));
});

test('proof requires every version change and byte-identical output', () => {
  const changes = recipe().lockfiles['yarn.lock'];
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
