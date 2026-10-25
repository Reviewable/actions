'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {parseSyml, stringifySyml} = require('@yarnpkg/parsers');
const {compatible, checkLockfile} = require('./lockfiles');

const npmEntry = (name, version, extra = {}) => ({version,
  resolved: `https://registry.npmjs.org/${name}/-/${name.split('/').pop()}-${version}.tgz`,
  integrity: `sha512-${version}`, ...extra});
const npmLock = (version, packages, legacy) => JSON.stringify({name: 'example', version: '1.0.0',
  lockfileVersion: version, ...(version === 1 ? {dependencies: packages} : {packages}),
  ...(legacy ? {dependencies: legacy} : {})});
const berry = entries => stringifySyml({__metadata: {version: '8', cacheKey: '10c0'}, ...entries});
const yarnEntry = (name, version, extra = {}) => ({version, resolution: `${name}@npm:${version}`,
  checksum: `10c0/${version}`, languageName: 'node', linkType: 'hard', ...extra});
const classic = version =>
  `# yarn lockfile v1\n\n"body-parser@^1.20.0":\n  version "${version}"\n` +
  `  resolved "https://registry.yarnpkg.com/body-parser/-/body-parser-${version}.tgz#hash"\n` +
  `  integrity sha512-${version}\n`;

test('semver boundaries include zero-major versions and reject downgrades/prereleases', () => {
  for (const [from, to] of [['1.2.3', '1.9.0'], ['0.2.3', '0.2.9'], ['0.0.3', '0.0.3']]) {
    assert.equal(compatible(from, to), true);
  }
  for (const [from, to] of [['1.2.3', '2.0.0'], ['0.2.3', '0.3.0'], ['0.0.3', '0.0.4'],
    ['1.2.3', '1.2.2'], ['1.2.3', '1.3.0-beta.1'], ['x', '1.0.0']]) {
    assert.equal(compatible(from, to), false);
  }
});

test('Yarn Classic and modern lockfiles accept compatible security releases', () => {
  assert.equal(checkLockfile('nested/yarn.lock', classic('1.20.8'), classic('1.20.9')), 1);
  assert.equal(checkLockfile('yarn.lock',
    berry({'undici@npm:^6.0.0': yarnEntry('undici', '6.27.0')}),
    berry({'undici@npm:^6.0.0': yarnEntry('undici', '6.29.1')})), 1);
});

for (const format of [1, 2, 3]) {
  test(`npm format ${format} accepts compatible nested updates and rejects majors`, () => {
    const lock = version => {
      const entry = npmEntry('body-parser', version);
      return format === 1 ? npmLock(1, {'body-parser': entry}) :
        npmLock(
          format, {'': {name: 'example', version: '1.0.0'}, 'node_modules/body-parser': entry},
          format === 2 ? {'body-parser': entry} : undefined);
    };
    assert.equal(checkLockfile('tools/package-lock.json', lock('1.20.8'), lock('1.20.9')), 1);
    assert.throws(() => checkLockfile('npm-shrinkwrap.json', lock('1.20.8'), lock('2.4.0')),
      /Breaking/);
  });
}

test('changes to duplicate transitive versions are checked independently', () => {
  const lock = version => npmLock(3, {
    'node_modules/undici': npmEntry('undici', '8.12.2'),
    'node_modules/a/node_modules/undici': npmEntry('undici', version),
  });
  assert.throws(() => checkLockfile('package-lock.json', lock('6.27.0'), lock('8.12.2')),
    /Breaking/);
});

test('renaming Yarn descriptors cannot disguise a breaking update', () => {
  assert.throws(() => checkLockfile('yarn.lock', berry({'a@npm:^0.2.0': yarnEntry('a', '0.2.3')}),
    berry({'a@npm:^0.3.0': yarnEntry('a', '0.3.1')})), /incompatible version line/);
});

test('changed edges cannot switch to an already present incompatible Yarn copy', () => {
  const lock = range => berry({
    'parent@npm:^1.0.0': yarnEntry('parent', '1.1.0', {dependencies: {child: `npm:${range}`}}),
    'child@npm:^1.0.0': yarnEntry('child', '1.2.0'),
    'child@npm:^2.0.0': yarnEntry('child', '2.1.0'),
  });
  assert.throws(() => checkLockfile('yarn.lock', lock('^1.0.0'), lock('^2.0.0')),
    /Breaking dependency edge/);
});

test('npm hoisting cannot hide a switch to an existing incompatible copy', () => {
  const before = npmLock(3, {
    'node_modules/parent': npmEntry('parent', '1.1.0', {dependencies: {child: '*'}}),
    'node_modules/child': npmEntry('child', '2.1.0'),
    'node_modules/parent/node_modules/child': npmEntry('child', '1.2.0'),
  });
  const after = JSON.parse(before);
  delete after.packages['node_modules/parent/node_modules/child'];
  assert.throws(() => checkLockfile('package-lock.json', before, JSON.stringify(after)),
    /Breaking dependency edge/);
});

test('workspace and Git entries can remain unchanged but cannot be changed', () => {
  const make = git => berry({
    'root@workspace:.': {
      version: '0.0.0-use.local', resolution: 'root@workspace:.', linkType: 'soft'},
    'git-dependency@git:abc': {version: '1.0.0', resolution: git},
    'a@npm:^1.0.0': yarnEntry('a', git === 'abc' ? '1.0.0' : '1.1.0'),
  });
  const after = parseSyml(make('abc'));
  after['a@npm:^1.0.0'] = yarnEntry('a', '1.1.0');
  assert.equal(checkLockfile('yarn.lock', make('abc'), stringifySyml(after)), 1);
  assert.throws(() => checkLockfile('yarn.lock', make('abc'), make('def')),
    /stable registry update/);
});

test('aliases retain package identity and registry URLs cannot change hosts', () => {
  const lock = (name, version) => npmLock(3, {
    'node_modules/alias': npmEntry(name, version, {name})});
  assert.equal(checkLockfile('package-lock.json', lock('@scope/original', '1.0.0'),
    lock('@scope/original', '1.1.0')), 1);
  assert.throws(() => checkLockfile('package-lock.json', lock('original', '1.0.0'),
    lock('replacement', '1.1.0')), /Breaking/);
  const after = JSON.parse(lock('original', '1.1.0'));
  after.packages['node_modules/alias'].resolved = 'https://evil.example/original-1.1.0.tgz';
  assert.throws(() => checkLockfile('package-lock.json', lock('original', '1.0.0'),
    JSON.stringify(after)), /stable registry update/);
});

test('checksum-only edits and format migrations are not version upgrades', () => {
  const before = berry({'a@npm:^1.0.0': yarnEntry('a', '1.0.0')});
  assert.throws(() => checkLockfile('yarn.lock', before, before.replace('10c0/1.0.0', '10c0/evil')),
    /Artifact changed/);
  assert.throws(
    () => checkLockfile('yarn.lock', before, before.replace('version: 8', 'version: 9')),
    /metadata changed/);
  assert.throws(() => checkLockfile('pnpm-lock.yaml', before, before), /Not a supported/);
});

test('same-version executable metadata edits require manual review', () => {
  const lock = bin => npmLock(3, {'node_modules/a': npmEntry('a', '1.0.0', {bin})});
  assert.throws(() => checkLockfile('package-lock.json', lock({a: 'bin.js'}),
    lock({a: '../../other/bin.js'})), /metadata changed without a version update/);
});

test('deduplicating a compatible nested npm copy is non-breaking', () => {
  const packages = {
    'node_modules/a': npmEntry('a', '1.0.0', {dependencies: {b: '^1.0.0'}}),
    'node_modules/b': npmEntry('b', '1.1.0'),
    'node_modules/a/node_modules/b': npmEntry('b', '1.0.0'),
  };
  const before = npmLock(3, packages);
  delete packages['node_modules/a/node_modules/b'];
  assert.doesNotThrow(() => checkLockfile('package-lock.json', before, npmLock(3, packages)));
});

test('npm v2 legacy data is validated as well as the packages map', () => {
  const packages = {'node_modules/a': npmEntry('a', '1.0.0')};
  assert.throws(() => checkLockfile('package-lock.json',
    npmLock(2, packages, {a: npmEntry('a', '1.0.0')}),
    npmLock(2, packages, {a: npmEntry('a', '2.0.0')})), /Breaking/);
});

test('new transitive dependencies and compatible descriptor regrouping are allowed', () => {
  const before = berry({'a@npm:^1.0.0': yarnEntry('a', '1.0.0')});
  const after = berry({
    'a@npm:^1.0.0, a@npm:^1.1.0': yarnEntry('a', '1.1.0', {dependencies: {b: 'npm:^1.0.0'}}),
    'b@npm:^1.0.0': yarnEntry('b', '1.0.0'),
  });
  assert.ok(checkLockfile('yarn.lock', before, after) > 0);
});
