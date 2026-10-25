'use strict';

const path = require('node:path').posix;
const {isDeepStrictEqual: equal} = require('node:util');
const {parseDocument} = require('yaml');
const {parseSyml, stringifySyml} = require('@yarnpkg/parsers');
const semver = require('semver');

const SCHEMA = 'reviewable-dependency-updates/v1';

function insist(condition, message) {
  if (!condition) throw new Error(message);
}

function mapping(value, label) {
  insist(value && typeof value === 'object' && !Array.isArray(value), `${label} must be a mapping`);
  return value;
}

function keys(value, allowed, label) {
  mapping(value, label);
  insist(Object.keys(value).every(key => allowed.includes(key)), `Unknown field in ${label}`);
}

function filename(value, basename) {
  insist(typeof value === 'string' && path.basename(value) === basename &&
    !/[\\:]/.test(value) && [...value].every(char => char.charCodeAt(0) >= 32) &&
    !path.isAbsolute(value) &&
    value.split('/').every(part => part && !['.', '..', '.git', 'node_modules'].includes(part)),
  `Invalid ${basename} path: ${value}`);
}

function stable(version) {
  return typeof version === 'string' && semver.valid(version) === version &&
    !semver.prerelease(version) && !version.includes('+');
}

function compatible(before, after) {
  return stable(before) && stable(after) && semver.gte(after, before) &&
    semver.satisfies(after, `^${before}`);
}

function yarnVersion(pin) {
  const match = typeof pin === 'string' && pin.match(/^yarn@([^+]+)(?:\+sha(?:224|512)\.[a-f0-9]+)?$/);
  insist(match && stable(match[1]) && semver.gte(match[1], '4.13.0'),
    'Replay requires an exact Corepack Yarn pin, version 4.13.0 or later');
  return match[1];
}

function descriptor(value) {
  const match = value.match(/^(@[^/@\s]+\/[^@\s]+|[^@/\s]+)@npm:(?:(@[^/@\s]+\/[^@\s]+|[^@/\s]+)@)?(.+)$/);
  insist(match, `Only npm Yarn descriptors can be selected: ${value}`);
  return {name: match[2] || match[1], range: match[3]};
}

function transition(value, label, nullable = false) {
  keys(value, ['from', 'to'], label);
  for (const field of ['from', 'to']) {
    insist((nullable && value[field] === null) || stable(value[field]),
      `${label}.${field} must be an exact quoted stable version${nullable ? ' or null' : ''}`);
  }
  insist(value.from !== value.to, `No change declared for ${label}`);
}

function validatePlan(plan) {
  keys(plan, ['schema', 'lockfiles', 'manifests'], 'recipe');
  insist(plan.schema === SCHEMA, `Expected schema: ${SCHEMA}`);
  mapping(plan.lockfiles, 'lockfiles');
  insist(Object.keys(plan.lockfiles).length > 0, 'At least one owning lockfile is required');
  for (const [file, changes] of Object.entries(plan.lockfiles)) {
    filename(file, 'yarn.lock');
    mapping(changes, file);
    for (const [selector, change] of Object.entries(changes)) {
      descriptor(selector);
      transition(change, `${file}: ${selector}`, true);
    }
  }
  if (plan.manifests !== undefined) mapping(plan.manifests, 'manifests');
  for (const [file, changes] of Object.entries(plan.manifests || {})) {
    filename(file, 'package.json');
    keys(changes, ['version', 'packageManager'], file);
    insist(Object.keys(changes).length > 0, `Empty manifest change: ${file}`);
    if (changes.version) transition(changes.version, `${file}.version`);
    if (changes.packageManager) {
      keys(changes.packageManager, ['from', 'to'], `${file}.packageManager`);
      const {from, to} = changes.packageManager;
      insist(compatible(yarnVersion(from), yarnVersion(to)) && from !== to,
        `Breaking or unchanged Yarn pin: ${file}`);
    }
  }
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

function lockfile(text) {
  const data = parseSyml(text);
  insist(data.__metadata && /^[1-9][0-9]*$/.test(String(data.__metadata.version)),
    'Only modern Yarn lockfiles can be replayed');
  const entries = new Map();
  for (const [selectors, value] of Object.entries(data)) {
    if (selectors === '__metadata') continue;
    mapping(value, `Lock entry ${selectors}`);
    for (const selector of selectors.split(/,\s+/)) {
      insist(!entries.has(selector), `Duplicate Yarn descriptor: ${selector}`);
      entries.set(selector, value);
    }
  }
  return {metadata: data.__metadata, entries};
}

function registryEntry(entry) {
  const match = entry?.resolution?.match(/^(@[^/]+\/[^@]+|[^@]+)@npm:([^:]+)$/);
  return match && match[2] === entry.version ? {name: match[1], version: match[2]} : null;
}

// This also serves the agent's recipe generator. Metadata is deliberately not copied into recipes.
function changesBetween(before, after) {
  const changes = {};
  for (const selector of [...new Set([...before.entries.keys(), ...after.entries.keys()])].sort()) {
    const oldEntry = before.entries.get(selector), newEntry = after.entries.get(selector);
    if (oldEntry?.version === newEntry?.version) continue;
    insist((!oldEntry || registryEntry(oldEntry)) && (!newEntry || registryEntry(newEntry)),
      `Cannot declare a non-registry update: ${selector}`);
    changes[selector] = {from: oldEntry?.version ?? null, to: newEntry?.version ?? null};
  }
  return changes;
}

function seedLockfile(beforeText, changes) {
  const before = lockfile(beforeText);
  const seeded = new Map(before.entries);
  for (const [selector, change] of Object.entries(changes)) {
    const oldEntry = before.entries.get(selector);
    insist((oldEntry?.version ?? null) === change.from, `Stale from version: ${selector}`);
    const {name} = descriptor(selector);
    if (oldEntry) {
      insist(registryEntry(oldEntry)?.name === name,
        `Unexpected baseline resolution: ${selector}`);
    }
    if (change.from && change.to) {
      insist(compatible(change.from, change.to), `Breaking update or downgrade: ${selector}`);
    } else if (change.to) {
      const previous = [...before.entries.values()].map(registryEntry)
        .filter(entry => entry?.name === name);
      insist(!previous.length || previous.some(entry => compatible(entry.version, change.to)),
        `New descriptor crosses an existing major/0.x boundary: ${selector}`);
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
  insist(equal(changesBetween(lockfile(beforeText), lockfile(actualText)), changes),
    `Recipe does not describe all generated version changes: ${file}`);
  insist(actualText === expectedText, `Replayed lockfile does not exactly match the PR: ${file}`);
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

module.exports = {SCHEMA, insist, filename, compatible, yarnVersion, validatePlan, parsePlan,
  lockfile, changesBetween, seedLockfile, verifyLockfile, applyManifest};
