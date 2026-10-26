import {posix as path} from 'node:path';
import {isDeepStrictEqual as equal} from 'node:util';
import {parseDocument} from 'yaml';
import {parseSyml, stringifySyml} from '@yarnpkg/parsers';
import semver from 'semver';

const SCHEMA = 'reviewable-dependency-updates/v1';

function insist(condition, message) {
  if (!condition) throw new Error(message);
}

function requireMapping(value, label) {
  insist(value && typeof value === 'object' && !Array.isArray(value), `${label} must be a mapping`);
  return value;
}

function validateKeys(value, allowed, label) {
  requireMapping(value, label);
  insist(Object.keys(value).every(key => allowed.includes(key)), `Unknown field in ${label}`);
}

function validateFilename(value, basename) {
  insist(
    typeof value === 'string' && path.basename(value) === basename &&
      !/[\\:]/.test(value) && [...value].every(char => char.charCodeAt(0) >= 32) &&
      !path.isAbsolute(value) &&
      value.split('/').every(part => part && !['.', '..', '.git', 'node_modules'].includes(part)),
    `Invalid ${basename} path: ${value}`);
}

function isStableVersion(version) {
  return typeof version === 'string' && semver.valid(version) === version &&
    !semver.prerelease(version) && !version.includes('+');
}

function isCompatible(before, after) {
  return isStableVersion(before) && isStableVersion(after) && semver.gte(after, before) &&
    semver.satisfies(after, `^${before}`);
}

function parseYarnVersion(pin) {
  const match = typeof pin === 'string' &&
    pin.match(/^yarn@([^+]+)(?:\+sha(?:224|512)\.[a-f0-9]+)?$/);
  // Yarn 4.0 introduced --check-resolutions and --refresh-lockfile (hardened mode).
  insist(match && isStableVersion(match[1]) && semver.gte(match[1], '4.0.0'),
    'Replay requires an exact Corepack Yarn pin, version 4.0.0 or later');
  return match[1];
}

function parseDescriptor(value) {
  const match = value.match(
    /^(@[^/@\s]+\/[^@\s]+|[^@/\s]+)@npm:(?:(@[^/@\s]+\/[^@\s]+|[^@/\s]+)@)?(.+)$/);
  insist(match, `Only npm Yarn descriptors can be selected: ${value}`);
  return {name: match[2] || match[1], range: match[3]};
}

function validateTransition(value, label, nullable = false) {
  validateKeys(value, ['from', 'to'], label);
  for (const field of ['from', 'to']) {
    insist((nullable && value[field] === null) || isStableVersion(value[field]),
      `${label}.${field} must be an exact quoted stable version${nullable ? ' or null' : ''}`);
  }
  insist(value.from !== value.to, `No change declared for ${label}`);
}

function validatePlan(plan) {
  validateKeys(plan, ['schema', 'lockfiles', 'manifests'], 'recipe');
  insist(plan.schema === SCHEMA, `Expected schema: ${SCHEMA}`);
  if (plan.lockfiles !== undefined) requireMapping(plan.lockfiles, 'lockfiles');
  for (const [file, changes] of Object.entries(plan.lockfiles || {})) {
    validateFilename(file, 'yarn.lock');
    requireMapping(changes, file);
    for (const [selector, change] of Object.entries(changes)) {
      parseDescriptor(selector);
      validateTransition(change, `${file}: ${selector}`, true);
    }
  }
  if (plan.manifests !== undefined) requireMapping(plan.manifests, 'manifests');
  for (const [file, changes] of Object.entries(plan.manifests || {})) {
    validateFilename(file, 'package.json');
    validateKeys(changes, ['version', 'packageManager'], file);
    insist(Object.keys(changes).length > 0, `Empty manifest change: ${file}`);
    if (changes.version) validateTransition(changes.version, `${file}.version`);
    if (changes.packageManager) {
      validateKeys(changes.packageManager, ['from', 'to'], `${file}.packageManager`);
      const {from, to} = changes.packageManager;
      insist(isCompatible(parseYarnVersion(from), parseYarnVersion(to)) && from !== to,
        `Breaking or unchanged Yarn pin: ${file}`);
    }
  }
  insist(Object.keys(plan.lockfiles || {}).length || Object.keys(plan.manifests || {}).length,
    'At least one lockfile or manifest is required');
  return plan;
}

function parsePlan(body) {
  insist(typeof body === 'string' && body.length <= 65536, 'Missing or oversized PR description');
  const recipes = [];
  const fences = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?\n([\s\S]*?)^ {0,3}\1[ \t]*\r?$/gm;
  for (const match of body.matchAll(fences)) {
    if (!/^ya?ml\s*$/i.test(match[2].trim()) ||
      !match[3].includes('reviewable-dependency-updates/')) continue;
    const document = parseDocument(match[3], {uniqueKeys: true});
    insist(!document.errors.length && !document.warnings.length,
      `Invalid recipe YAML: ${[...document.errors, ...document.warnings].join('; ')}`);
    recipes.push(validatePlan(document.toJS({maxAliasCount: 0})));
  }
  insist(recipes.length === 1, 'Expected exactly one dependency-update YAML recipe');
  return recipes[0];
}

function parseLockfile(text) {
  const data = parseSyml(text);
  insist(data.__metadata && /^[1-9][0-9]*$/.test(String(data.__metadata.version)),
    'Only modern Yarn lockfiles can be replayed');
  const entries = new Map();
  for (const [selectors, value] of Object.entries(data)) {
    if (selectors === '__metadata') continue;
    requireMapping(value, `Lock entry ${selectors}`);
    for (const selector of selectors.split(/,\s+/)) {
      insist(!entries.has(selector), `Duplicate Yarn descriptor: ${selector}`);
      entries.set(selector, value);
    }
  }
  return {metadata: data.__metadata, entries};
}

function parseRegistryEntry(entry) {
  const match = entry?.resolution?.match(/^(@[^/]+\/[^@]+|[^@]+)@npm:([^:]+)$/);
  return match && match[2] === entry.version ? {name: match[1], version: match[2]} : null;
}

// This also serves the agent's recipe generator. Metadata is deliberately not copied into recipes.
function describeChanges(before, after) {
  const changes = {};
  for (const selector of [...new Set([...before.entries.keys(), ...after.entries.keys()])].sort()) {
    const oldEntry = before.entries.get(selector), newEntry = after.entries.get(selector);
    if (oldEntry?.version === newEntry?.version) continue;
    insist(
      (!oldEntry || parseRegistryEntry(oldEntry)) && (!newEntry || parseRegistryEntry(newEntry)),
      `Cannot declare a non-registry update: ${selector}`);
    changes[selector] = {from: oldEntry?.version ?? null, to: newEntry?.version ?? null};
  }
  return changes;
}

function seedLockfile(beforeText, changes) {
  const before = parseLockfile(beforeText);
  const seeded = new Map(before.entries);
  for (const [selector, change] of Object.entries(changes)) {
    const oldEntry = before.entries.get(selector);
    insist((oldEntry?.version ?? null) === change.from, `Stale from version: ${selector}`);
    const {name} = parseDescriptor(selector);
    if (oldEntry) {
      insist(parseRegistryEntry(oldEntry)?.name === name,
        `Unexpected baseline resolution: ${selector}`);
    }
    if (change.from && change.to) {
      insist(semver.gte(change.to, change.from), `Dependency downgrade: ${selector}`);
    }
    if (change.to === null) {seeded.delete(selector);} else {
      // Yarn replaces this seed with registry metadata and computes the archive checksum.
      seeded.set(selector, {version: change.to, resolution: `${name}@npm:${change.to}`,
        languageName: 'node', linkType: 'hard'});
    }
  }
  const text = stringifySyml({__metadata: before.metadata, ...Object.fromEntries(seeded)});
  return beforeText.includes('\r\n') ? text.replace(/\n/g, '\r\n') : text;
}

function verifyLockfile(beforeText, actualText, expectedText, changes, file) {
  const before = parseLockfile(beforeText), actual = parseLockfile(actualText);
  validateDirectUpdates(before, actual);
  insist(equal(describeChanges(before, actual), changes),
    `Recipe does not describe all generated version changes: ${file}`);
  insist(actualText === expectedText, `Replayed lockfile does not exactly match the PR: ${file}`);
}

function validateDirectUpdates(before, after) {
  // Yarn records each workspace's direct dependencies (including dev/optional) in its entry.
  // Compare descriptors, not package names: another copy may be solely transitive.
  for (const workspace of before.entries.values()) {
    if (!workspace.resolution.includes('@workspace:')) continue;
    for (const [name, range] of Object.entries(workspace.dependencies || {})) {
      const selector = `${name}@${range}`;
      const oldEntry = parseRegistryEntry(before.entries.get(selector));
      if (!oldEntry) continue;
      const newEntry = parseRegistryEntry(after.entries.get(selector));
      if (equal(oldEntry, newEntry)) continue;
      insist(
        newEntry && newEntry.name === oldEntry.name &&
          isCompatible(oldEntry.version, newEntry.version),
        `Breaking direct dependency update or removal: ${selector}`);
    }
  }
}

function applyManifest(beforeText, changes, file) {
  const manifest = JSON.parse(beforeText);
  if (changes.version) {
    insist(manifest.bundleDependencies === true,
      `Publication version bump requires bundleDependencies: true in the baseline: ${file}`);
    insist(changes.version.to === semver.inc(changes.version.from, 'patch'),
      `Publication version must advance by one patch: ${file}`);
  }
  const document = parseDocument(beforeText);
  const replacements = [];
  for (const [field, change] of Object.entries(changes)) {
    insist(manifest[field] === change.from, `Stale ${field} in ${file}`);
    const node = document.get(field, true);
    insist(node?.range, `Missing ${field} in ${file}`);
    replacements.push({start: node.range[0], end: node.range[1], text: JSON.stringify(change.to)});
  }
  let result = beforeText;
  for (const edit of replacements.sort((a, b) => b.start - a.start)) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  return result;
}

export {SCHEMA, insist, validateFilename, isCompatible, parseYarnVersion, validatePlan,
  parsePlan, parseLockfile, describeChanges, seedLockfile, verifyLockfile, validateDirectUpdates,
  applyManifest};
