'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {parseSyml, stringifySyml} = require('@yarnpkg/parsers');
const {compatible, checkLockfile: validateLockfile} = require('./lockfiles');

// Most fixtures exercise transitive entries only, with no root dependencies.
const checkLockfile = (filename, before, after, manifest = {}) =>
  validateLockfile(filename, before, after, manifest);

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
    berry({'a@npm:^0.3.0': yarnEntry('a', '0.3.1')})), /Package entry removed/);
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
    /Package entry removed/);
});

for (const name of ['parent', '@scope/parent']) {
  test(`hoisting ${name} requires manual review even with compatible peers`, () => {
    const parent = npmEntry(name, '1.0.0', {peerDependencies: {child: '*'}});
    const packages = {
      'node_modules/child': npmEntry('child', '2.0.0'),
      [`node_modules/container/node_modules/${name}`]: parent,
      'node_modules/container/node_modules/child': npmEntry('child', '1.0.0'),
      // A nested regular dependency must not mask the ancestor peer's transition.
      [`node_modules/container/node_modules/${name}/node_modules/child`]:
        npmEntry('child', '1.0.0'),
    };
    const before = npmLock(3, packages);
    delete packages[`node_modules/container/node_modules/${name}`];
    delete packages[`node_modules/container/node_modules/${name}/node_modules/child`];
    packages[`node_modules/${name}`] = parent;
    packages[`node_modules/${name}/node_modules/child`] = npmEntry('child', '1.0.0');
    assert.throws(() => checkLockfile('package-lock.json', before, npmLock(3, packages)),
      /Package entry removed/);

    packages['node_modules/child'] = npmEntry('child', '1.1.0');
    const compatibleBefore = JSON.parse(before);
    compatibleBefore.packages['node_modules/child'] = npmEntry('child', '1.1.0');
    assert.throws(() => checkLockfile('package-lock.json',
      JSON.stringify(compatibleBefore), npmLock(3, packages)), /Package entry removed/);
  });
}

test('replacing an npm peer at the same path still rejects a major upgrade', () => {
  const packages = {
    'node_modules/parent': npmEntry('parent', '1.0.0', {peerDependencies: {child: '*'}}),
    'node_modules/child': npmEntry('child', '1.0.0'),
    'node_modules/container/node_modules/child': npmEntry('child', '2.0.0'),
  };
  const before = npmLock(3, packages);
  packages['node_modules/child'] = packages['node_modules/container/node_modules/child'];
  assert.throws(() => checkLockfile('package-lock.json', before, npmLock(3, packages)),
    /Breaking/);
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

for (const flag of ['dev', 'peer', 'optional', 'devOptional']) {
  for (const value of [false, undefined]) {
    test(`same-version ${flag} cannot become ${value}, including during relocation`, () => {
      const entry = npmEntry('a', '1.0.0', {[flag]: true});
      const before = npmLock(3, {'node_modules/a': entry});
      const changed = {...entry, [flag]: value};
      for (const key of ['node_modules/a', 'node_modules/parent/node_modules/a']) {
        assert.throws(
          () => checkLockfile('package-lock.json', before, npmLock(3, {[key]: changed})),
          key === 'node_modules/a' ? /metadata changed without a version update/ :
          /Package entry removed/);
      }
    });
  }
}

for (const format of [1, 2]) {
  for (const value of [false, undefined]) {
    test(`npm v${format} legacy dev flag cannot become ${value}`, () => {
      const entry = npmEntry('a', '1.0.0', {dev: true, hasInstallScript: true});
      const changed = {...entry, dev: value};
      const packages = {'node_modules/a': entry};
      const lock = dependencies => format === 1 ? npmLock(1, dependencies) :
        npmLock(2, packages, dependencies);
      for (const dependencies of [{a: changed},
        {parent: npmEntry('parent', '1.0.0', {dependencies: {a: changed}})}]) {
        assert.throws(
          () => checkLockfile('npm-shrinkwrap.json', lock({a: entry}), lock(dependencies)),
          dependencies.a ? /metadata changed without a version update/ : /Package entry removed/);
      }
    });
  }
}

test('unchanged installation flags permit version updates but not relocation', () => {
  for (const flag of ['dev', 'peer', 'optional', 'devOptional']) {
    const entry = npmEntry('a', '1.0.0', {[flag]: true});
    const before = npmLock(3, {'node_modules/a': entry});
    assert.throws(() => checkLockfile('package-lock.json', before,
      npmLock(3, {'node_modules/parent/node_modules/a': entry})), /Package entry removed/);
    assert.equal(checkLockfile('package-lock.json', before,
      npmLock(3, {'node_modules/a': npmEntry('a', '1.1.0', {[flag]: true})})), 1);
  }
});

for (const format of [1, 2, 3]) {
  for (const flag of ['dev', 'peer', 'optional', 'devOptional']) {
    test(`npm v${format} upgrades must preserve the ${flag} installation flag`, () => {
      const lock = (version, value) => {
        const entry = npmEntry('a', version, {[flag]: value, hasInstallScript: true});
        return format === 1 ? npmLock(1, {a: entry}) :
          npmLock(format, {'node_modules/a': entry}, format === 2 ? {a: entry} : undefined);
      };
      for (const [before, after] of [[true, false], [true, undefined], [undefined, true]]) {
        assert.throws(() => checkLockfile('package-lock.json',
          lock('1.0.0', before), lock('1.1.0', after)),
        new RegExp(`Installation scope changed: .*${flag}`));
      }
      assert.equal(checkLockfile('package-lock.json', lock('1.0.0', true), lock('1.1.0', true)), 1);
    });
  }
}

test('npm v2 upgrades also preserve installation flags in legacy data', () => {
  for (const flag of ['dev', 'peer', 'optional', 'devOptional']) {
    const before = npmEntry('a', '1.0.0', {[flag]: true});
    const after = npmEntry('a', '1.1.0', {[flag]: true});
    assert.throws(() => checkLockfile('npm-shrinkwrap.json',
      npmLock(2, {'node_modules/a': before}, {a: before}),
      npmLock(2, {'node_modules/a': after}, {a: {...after, [flag]: undefined}})),
    new RegExp(`Installation scope changed: .*${flag}`));
  }
});

for (const extra of [{bin: {a: '../../other/bin.js'}}, {dependencies: {other: '^1.0.0'}}]) {
  test(`relocating an npm entry cannot change ${Object.keys(extra)[0]} metadata`, () => {
    const entry = npmEntry('a', '1.0.0');
    const before = npmLock(3, {'node_modules/a': entry});
    const after = npmLock(3, {'node_modules/parent/node_modules/a': {...entry, ...extra}});
    assert.throws(() => checkLockfile('package-lock.json', before, after),
      /Package entry removed/);
  });
}

test('renaming a Yarn descriptor cannot change same-version dependency metadata', () => {
  const before = berry({'a@npm:^1.0.0': yarnEntry('a', '1.0.0')});
  const after = berry({'a@npm:~1.0.0':
    yarnEntry('a', '1.0.0', {dependencies: {b: 'npm:^1.0.0'}})});
  assert.throws(() => checkLockfile('yarn.lock', before, after),
    /Package entry removed/);
});

test('deduplicating a compatible nested npm copy requires manual review', () => {
  const packages = {
    'node_modules/a': npmEntry('a', '1.0.0', {dependencies: {b: '^1.0.0'}}),
    'node_modules/b': npmEntry('b', '1.1.0'),
    'node_modules/a/node_modules/b': npmEntry('b', '1.0.0'),
  };
  const before = npmLock(3, packages);
  delete packages['node_modules/a/node_modules/b'];
  assert.throws(() => checkLockfile('package-lock.json', before, npmLock(3, packages)),
    /Package entry removed/);
});

test('npm v2 legacy data is validated as well as the packages map', () => {
  const packages = {'node_modules/a': npmEntry('a', '1.0.0')};
  assert.throws(() => checkLockfile('package-lock.json',
    npmLock(2, packages, {a: npmEntry('a', '1.0.0')}),
    npmLock(2, packages, {a: npmEntry('a', '2.0.0')})), /Breaking/);
});

test('new transitive dependencies and descriptors require manual review', () => {
  const before = berry({'a@npm:^1.0.0': yarnEntry('a', '1.0.0')});
  const after = berry({
    'a@npm:^1.0.0, a@npm:^1.1.0': yarnEntry('a', '1.1.0', {dependencies: {b: 'npm:^1.0.0'}}),
    'b@npm:^1.0.0': yarnEntry('b', '1.0.0'),
  });
  assert.throws(() => checkLockfile('yarn.lock', before, after), /Package entry added/);
});

test('fabricated parent metadata cannot authorize new transitive npm packages', () => {
  const before = npmLock(3, {'node_modules/a': npmEntry('a', '1.0.0')});
  const after = npmLock(3, {
    'node_modules/a': npmEntry('a', '1.1.0', {dependencies: {b: '^1.0.0'}}),
    'node_modules/b': npmEntry('b', '1.0.0', {bin: {b: 'bin/cli.js'},
      dependencies: {c: '^1.0.0'}}),
    'node_modules/c': npmEntry('c', '1.0.0'),
  });
  assert.throws(() => checkLockfile('package-lock.json', before, after), /Package entry added/);
});

test('removing obsolete registry dependencies requires manual review', () => {
  const before = berry({
    'a@npm:^1.0.0': yarnEntry('a', '1.0.0', {dependencies: {b: 'npm:^1.0.0'}}),
    'b@npm:^1.0.0': yarnEntry('b', '1.0.0'),
  });
  const after = berry({'a@npm:^1.0.0': yarnEntry('a', '1.1.0')});
  assert.throws(() => checkLockfile('yarn.lock', before, after), /Package entry removed/);
});

for (const format of [1, 2, 3]) {
  test(`npm format ${format} rejects additions, removals, and equal-count replacements`, () => {
    const lock = entries => format === 1 ? npmLock(1, entries) : npmLock(format,
      Object.fromEntries(Object.entries(entries).map(([name, entry]) => (
        [`node_modules/${name}`, entry]))), format === 2 ? entries : undefined);
    const a = npmEntry('a', '1.0.0'), b = npmEntry('b', '1.0.0');
    const before = lock({a});
    assert.throws(() => checkLockfile('package-lock.json', before, lock({a, b})),
      /Package entry added/);
    assert.throws(() => checkLockfile('package-lock.json', before, lock({})),
      /Package entry removed/);
    assert.throws(() => checkLockfile('package-lock.json', before, lock({b})),
      /Package entry removed/);
  });
}

test('npm v2 legacy additions and removals are rejected even with unchanged packages', () => {
  const a = npmEntry('a', '1.0.0'), b = npmEntry('b', '1.0.0');
  const packages = {'node_modules/a': a};
  const before = npmLock(2, packages, {a});
  assert.throws(() => checkLockfile('npm-shrinkwrap.json', before,
    npmLock(2, packages, {a, b})), /Package entry added/);
  assert.throws(() => checkLockfile('npm-shrinkwrap.json', before,
    npmLock(2, packages, {})), /Package entry removed/);
});

test('adding another installed copy of an existing npm package requires manual review', () => {
  const a = npmEntry('a', '1.0.0');
  const packages = {'node_modules/a': a};
  const before = npmLock(3, packages);
  packages['node_modules/parent/node_modules/a'] = a;
  assert.throws(() => checkLockfile('package-lock.json', before, npmLock(3, packages)),
    /Package entry added/);
});

test('Yarn Classic additions and removals require manual review', () => {
  const before = classic('1.20.8');
  const extra = '\n"a@^1.0.0":\n  version "1.0.0"\n' +
    '  resolved "https://registry.npmjs.org/a/-/a-1.0.0.tgz"\n';
  assert.throws(() => checkLockfile('yarn.lock', before, classic('1.20.9') + extra),
    /Package entry added/);
  assert.throws(() => checkLockfile('yarn.lock', before + extra, classic('1.20.9')),
    /Package entry removed/);
});

test('regrouping existing Yarn descriptors preserves the entry set', () => {
  const before = berry({
    'a@npm:^1.0.0': yarnEntry('a', '1.1.0'),
    'a@npm:^1.1.0': yarnEntry('a', '1.1.0'),
  });
  const after = berry({'a@npm:^1.0.0, a@npm:^1.1.0': yarnEntry('a', '1.2.0')});
  assert.equal(checkLockfile('yarn.lock', before, after), 2);
});

for (const modern of [false, true]) {
  for (const range of ['1.20.8', '>=1.20.0 <1.20.9', '~1.19.0 || 1.20.8']) {
    test(`Yarn ${modern ? 'modern' : 'Classic'} enforces descriptor range ${range}`, () => {
      const lock = version => modern ?
        berry({[`body-parser@npm:${range}`]: yarnEntry('body-parser', version)}) :
        classic(version).replace('^1.20.0', range);
      assert.throws(() => checkLockfile('yarn.lock', lock('1.20.8'), lock('1.20.9')),
        /Resolution violates dependency range/);
    });
  }

  test(`Yarn ${modern ? 'modern' : 'Classic'} validates aliases`, () => {
    const lock = (version, range) => modern ?
      berry({[`alias@npm:@scope/original@${range}`]: yarnEntry('@scope/original', version)}) :
      `# yarn lockfile v1\n\n"alias@npm:@scope/original@${range}":\n  version "${version}"\n` +
      `  resolved "https://registry.npmjs.org/@scope/original/-/original-${version}.tgz"\n`;
    assert.equal(checkLockfile('yarn.lock', lock('1.0.0', '^1.0.0'), lock('1.1.0', '^1.0.0')), 1);
    assert.throws(() => checkLockfile('yarn.lock', lock('1.0.0', '1.0.0'), lock('1.1.0', '1.0.0')),
      /Resolution violates dependency range/);
  });
}

test('every descriptor in a grouped Yarn entry must allow the new version', () => {
  const lock = version => berry({'a@npm:^1.0.0, a@npm:1.0.0': yarnEntry('a', version)});
  assert.throws(() => checkLockfile('yarn.lock', lock('1.0.0'), lock('1.0.1')),
    /Resolution violates dependency range: a@npm:1.0.0/);
});

test('Yarn cannot resolve a descriptor to a different registry package', () => {
  const lock = version => berry({'alias@npm:^1.0.0': yarnEntry('original', version)});
  assert.throws(() => checkLockfile('yarn.lock', lock('1.0.0'), lock('1.1.0')),
    /Resolution violates dependency range/);
});

for (const format of [1, 2, 3]) {
  for (const field of [
    'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    test(`npm v${format} checks direct ${field} against the adjacent manifest`, () => {
      const lock = version => format === 1 ? npmLock(1, {a: npmEntry('a', version)}) :
        npmLock(format, {'node_modules/a': npmEntry('a', version)});
      const before = lock('1.0.0'), after = lock('1.0.1');
      assert.throws(
        () => checkLockfile('package-lock.json', before, after, {[field]: {a: '1.0.0'}}),
        /Resolution violates dependency range: package.json -> a/);
      assert.equal(checkLockfile('package-lock.json', before, after, {[field]: {a: '^1.0.0'}}), 1);
    });
  }

  test(`npm v${format} validates alias identity and range`, () => {
    const lock = version => {
      const entry = npmEntry('@scope/real', version,
        format === 1 ? {version: `npm:@scope/real@${version}`} : {name: '@scope/real'});
      return format === 1 ? npmLock(1, {alias: entry}) :
        npmLock(format, {'node_modules/alias': entry});
    };
    const before = lock('1.0.0'), after = lock('1.0.1');
    assert.equal(checkLockfile('package-lock.json', before, after,
      {dependencies: {alias: 'npm:@scope/real@^1.0.0'}}), 1);
    for (const spec of ['npm:@scope/real@1.0.0', 'npm:other@^1.0.0', '^1.0.0']) {
      assert.throws(() => checkLockfile('package-lock.json', before, after,
        {dependencies: {alias: spec}}), /Resolution violates dependency range/);
    }
  });

  test(`npm v${format} checks transitive ranges at the installed child path`, () => {
    const lock = version => {
      const child = npmEntry('child', version);
      return format === 1 ? npmLock(1, {
        parent: npmEntry('parent', '1.0.0', {requires: {child: '1.0.0'}, dependencies: {child}}),
        child: npmEntry('child', '1.0.0'),
      }) : npmLock(format, {
        'node_modules/parent': npmEntry('parent', '1.0.0', {dependencies: {child: '1.0.0'}}),
        'node_modules/parent/node_modules/child': child,
        'node_modules/child': npmEntry('child', '1.0.0'),
      });
    };
    assert.throws(() => checkLockfile('package-lock.json', lock('1.0.0'), lock('1.0.1')),
      /Resolution violates dependency range: node_modules\/parent -> child/);
  });
}

for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
  test(`npm validates new ${field} ranges with an unchanged child version`, () => {
    const lock = (version, range) => npmLock(3, {
      'node_modules/parent': npmEntry('parent', version, {[field]: {child: range}}),
      'node_modules/child': npmEntry('child', '1.1.0'),
      // A matching nested copy must not mask the incompatible ancestor peer.
      ...(field === 'peerDependencies' ?
        {'node_modules/parent/node_modules/child': npmEntry('child', '1.0.0')} : {}),
    });
    assert.throws(() => checkLockfile('package-lock.json',
      lock('1.0.0', '^1.0.0'), lock('1.0.1', '1.0.0')),
    /Resolution violates dependency range/);
  });
}

test('a newly added npm edge cannot reference an existing incompatible resolution', () => {
  const lock = (version, dependencies) => npmLock(3, {
    'node_modules/parent': npmEntry('parent', version, {dependencies}),
    'node_modules/child': npmEntry('child', '1.1.0'),
  });
  assert.throws(() => checkLockfile('package-lock.json',
    lock('1.0.0', {}), lock('1.0.1', {child: '1.0.0'})), /Resolution violates dependency range/);
});

test('npm optional ranges override ordinary ranges, with absent optionals allowed', () => {
  const lock = version => npmLock(3, {'node_modules/a': npmEntry('a', version)});
  assert.equal(checkLockfile('package-lock.json', lock('1.0.0'), lock('1.0.1'),
    {dependencies: {a: '1.0.0'}, optionalDependencies: {a: '^1.0.0', missing: '1.0.0'}}), 1);
});

test('npm v2 legacy resolutions must also satisfy root and transitive ranges', () => {
  const packages = {'node_modules/a': npmEntry('a', '1.0.0')};
  const before = npmLock(2, packages, {a: npmEntry('a', '1.0.0')});
  const after = npmLock(2, packages, {a: npmEntry('a', '1.0.1')});
  assert.throws(() => checkLockfile('package-lock.json', before, after,
    {dependencies: {a: '1.0.0'}}), /Resolution violates dependency range/);
  const parent = npmEntry('parent', '1.0.0', {requires: {a: '1.0.0'}});
  assert.throws(() => checkLockfile('package-lock.json',
    npmLock(2, packages, {parent, a: npmEntry('a', '1.0.0')}),
    npmLock(2, packages, {parent, a: npmEntry('a', '1.0.1')})),
  /Resolution violates dependency range/);
});

test('registry tags, missing npm manifests and npm overrides require manual verification', () => {
  const yarn = version => berry({'a@npm:latest': yarnEntry('a', version)});
  assert.throws(() => checkLockfile('yarn.lock', yarn('1.0.0'), yarn('1.0.1')),
    /Cannot verify dependency range/);
  const npm = version => npmLock(3, {'node_modules/a': npmEntry('a', version)});
  assert.throws(() => checkLockfile('package-lock.json', npm('1.0.0'), npm('1.0.1'),
    {dependencies: {a: 'latest'}}), /Cannot verify dependency range/);
  assert.throws(() => validateLockfile('package-lock.json', npm('1.0.0'), npm('1.0.1')),
    /Missing adjacent package.json/);
  assert.throws(() => checkLockfile('package-lock.json', npm('1.0.0'), npm('1.0.1'),
    {overrides: {a: '1.0.0'}}), /npm overrides require manual/);
});
