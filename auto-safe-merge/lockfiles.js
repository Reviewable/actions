const {isDeepStrictEqual: equal} = require('node:util');
const path = require('node:path').posix;
const {parseSyml} = require('@yarnpkg/parsers');
const semver = require('semver');

const LOCKFILES = new Set(['yarn.lock', 'package-lock.json', 'npm-shrinkwrap.json']);

function insist(condition, message) {
  if (!condition) throw new Error(message);
}

function compatible(before, after) {
  return Boolean(semver.valid(before) && semver.valid(after) &&
    !semver.prerelease(before) && !semver.prerelease(after) &&
    semver.gte(after, before) && semver.satisfies(after, `^${before}`));
}

function registryTarball(source, name, version) {
  if (typeof source !== 'string') return false;
  const url = URL.parse(source);
  const basename = name.split('/').pop();
  return Boolean(url && url.protocol === 'https:' && !url.username && !url.password &&
    !url.port && !url.search && ['registry.npmjs.org', 'registry.yarnpkg.com'].includes(url.hostname) &&
    decodeURIComponent(url.pathname) === `/${name}/-/${basename}-${version}.tgz`);
}

function yarnEntries(text) {
  const data = parseSyml(text);
  const entries = new Map();
  for (const [selectors, value] of Object.entries(data)) {
    if (selectors === '__metadata') continue;
    insist(value && typeof value === 'object', 'Invalid Yarn lock entry');
    const descriptors = selectors.split(/,\s+/);
    for (const descriptor of descriptors) {
      insist(!entries.has(descriptor), `Duplicate Yarn descriptor: ${descriptor}`);
      const match = descriptor.match(/^(@[^/]+\/[^@]+|[^@]+)@(.+)$/);
      insist(match, `Invalid Yarn descriptor: ${descriptor}`);
      let name = match[1];
      let registry = false;
      if (data.__metadata) {
        const resolution = value.resolution?.match(/^(@[^/]+\/[^@]+|[^@]+)@npm:([^:]+)$/);
        if (resolution) {
          name = resolution[1];
          registry = resolution[2] === value.version;
        }
      } else {
        const alias = match[2].match(/^npm:(@[^/]+\/[^@]+|[^@]+)@/);
        if (alias) name = alias[1];
        registry = registryTarball(value.resolved, name, value.version);
      }
      entries.set(descriptor, {name, version: value.version, registry, value,
        artifact: [value.resolution, value.resolved, value.integrity, value.checksum]});
    }
  }
  return {entries, metadata: data.__metadata || {format: 'yarn-v1'},
    resolve: (_key, name, range) => entries.get(`${name}@${range}`) ||
      entries.get(`${name}@npm:${range}`)};
}

function npmEntries(text) {
  const data = JSON.parse(text);
  insist([1, 2, 3].includes(data.lockfileVersion), 'Unsupported npm lockfile format');
  const entries = new Map();
  const add = (key, name, value) => {
    // Aliases in v2/v3 have a name field; v1 aliases encode the identity in version.
    const alias = value.version?.match(/^npm:(@[^/]+\/[^@]+|[^@]+)@(.+)$/);
    name = value.name || alias?.[1] || name;
    const version = alias?.[2] || value.version;
    entries.set(key, {name, version, value,
      registry: registryTarball(value.resolved, name, version),
      artifact: [value.resolved, value.integrity]});
  };
  const walk = (dependencies, prefix = '') => {
    for (const [name, value] of Object.entries(dependencies || {})) {
      const key = `${prefix}node_modules/${name}`;
      const {dependencies: nested, ...flat} = value;
      add(key, name, flat);
      walk(nested, `${key}/`);
    }
  };
  if (data.lockfileVersion === 1) {
    walk(data.dependencies);
  } else {
    insist(data.packages && typeof data.packages === 'object', 'Missing npm packages');
    for (const [key, value] of Object.entries(data.packages)) {
      const name = key.split('node_modules/').pop();
      add(key, name, value);
    }
  }
  const {packages, dependencies, ...metadata} = data;
  const resolve = (key, name) => {
    let prefix = key;
    while (true) {
      const candidate = entries.get(`${prefix ? `${prefix}/` : ''}node_modules/${name}`);
      if (candidate) return candidate;
      if (!prefix) return undefined;
      const index = prefix.lastIndexOf('/node_modules/');
      prefix = index < 0 ? '' : prefix.slice(0, index);
    }
  };
  return {entries, metadata, resolve, legacy: data.lockfileVersion === 2 && dependencies ?
    npmEntries(JSON.stringify({...metadata, lockfileVersion: 1, dependencies})) : null};
}

function checkEdges(before, after, oldKey, newKey) {
  const previous = before.entries.get(oldKey), next = after.entries.get(newKey);
  const dependencies = value => ({...value.requires, ...value.dependencies, ...value.optionalDependencies});
  const oldDeps = dependencies(previous.value), newDeps = dependencies(next.value);
  for (const name of Object.keys(oldDeps)) {
    if (!Object.hasOwn(newDeps, name)) continue;
    const oldChild = before.resolve(oldKey, name, oldDeps[name]);
    const newChild = after.resolve(newKey, name, newDeps[name]);
    // Optional/platform dependencies may be absent; new or removed packages have no version transition.
    if (!oldChild || !newChild) continue;
    insist(oldChild.name === newChild.name, `Dependency identity changed: ${newKey} -> ${name}`);
    if (oldChild.version === newChild.version) continue;
    insist(oldChild.registry && newChild.registry && compatible(oldChild.version, newChild.version),
      `Breaking dependency edge: ${newKey} -> ${name} (${oldChild.version} -> ${newChild.version})`);
  }
}

function checkEntries(before, after) {
  insist(equal(before.metadata, after.metadata), 'Lockfile format or root metadata changed');
  const byName = new Map();
  for (const [key, entry] of before.entries) {
    if (!byName.has(entry.name)) byName.set(entry.name, []);
    byName.get(entry.name).push({...entry, key});
  }
  let upgrades = 0;
  for (const [key, next] of after.entries) {
    const previous = before.entries.get(key);
    if (previous) checkEdges(before, after, key, key);
    if (previous && equal(previous.value, next.value)) continue;
    insist(next.registry && semver.valid(next.version) && !semver.prerelease(next.version),
      `Cannot establish a stable registry update for ${key}`);
    if (previous) {
      insist(previous.registry && previous.name === next.name && compatible(previous.version, next.version),
        `Breaking or unverified update: ${key} (${previous.version} -> ${next.version})`);
      if (previous.version === next.version) {
        insist(equal(previous.artifact, next.artifact), `Artifact changed without a version update: ${key}`);
        const metadata = ({dev, optional, devOptional, peer, ...rest}) => rest;
        insist(equal(metadata(previous.value), metadata(next.value)),
          `Package metadata changed without a version update: ${key}`);
      } else {
        upgrades++;
      }
    } else {
      // Entries can move during hoisting/deduplication or change range descriptors.
      // Never let a renamed descriptor disguise a new incompatible version line.
      const candidates = byName.get(next.name) || [];
      insist(!candidates.length || candidates.some(old => old.registry && compatible(old.version, next.version)),
        `New incompatible version line: ${next.name}@${next.version}`);
      for (const old of candidates.filter(old => old.registry && compatible(old.version, next.version))) {
        checkEdges(before, after, old.key, key);
        if (old.version === next.version) {
          insist(equal(old.artifact, next.artifact), `Artifact changed for relocated entry: ${key}`);
        }
      }
      if (candidates.length && !candidates.some(old => old.version === next.version)) upgrades++;
    }
  }
  for (const [key, previous] of before.entries) {
    insist(after.entries.has(key) || previous.registry, `Non-registry entry removed: ${key}`);
  }
  if (before.legacy || after.legacy) {
    insist(before.legacy && after.legacy, 'npm legacy dependency data removed or added');
    checkEntries(before.legacy, after.legacy);
  }
  return upgrades;
}

function checkLockfile(filename, before, after) {
  insist(LOCKFILES.has(path.basename(filename)), `Not a supported lockfile: ${filename}`);
  const parse = path.basename(filename) === 'yarn.lock' ? yarnEntries : npmEntries;
  return checkEntries(parse(before), parse(after));
}

module.exports = {LOCKFILES, insist, compatible, checkLockfile};
