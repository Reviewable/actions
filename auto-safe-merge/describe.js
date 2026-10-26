// Read-only agent helper. --verify reconstructs in a disposable directory, never in the checkout.
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {SCHEMA, insist, validateFilename, validatePlan, parseLockfile, describeChanges,
  seedLockfile, validateDirectUpdates, applyManifest} from './plan.js';
import {replay} from './replay.js';

function describeUpdates(root, base, head) {
  const git = args => execFileSync('git', args, {cwd: root, encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024, windowsHide: true});
  const read = (ref, file) => git(['show', `${ref}:${file}`]);
  const changes = git(['diff', '--name-status', `${base}...${head}`]).trim().split('\n');
  const plan = {schema: SCHEMA, lockfiles: {}, manifests: {}};
  const expected = new Map();
  for (const line of changes) {
    const [status, file] = line.split('\t');
    insist(status === 'M' && /(?:^|\/)(yarn.lock|package.json)$/.test(file),
      `Unsupported PR change: ${line}`);
    validateFilename(file, path.posix.basename(file));
    const before = read(base, file), after = read(head, file);
    expected.set(file, after);
    if (file.endsWith('yarn.lock')) {
      const oldLock = parseLockfile(before), newLock = parseLockfile(after);
      validateDirectUpdates(oldLock, newLock);
      plan.lockfiles[file] = describeChanges(oldLock, newLock);
      seedLockfile(before, plan.lockfiles[file]);
    } else {
      const oldManifest = JSON.parse(before), newManifest = JSON.parse(after);
      const edits = {};
      for (const field of ['version', 'packageManager']) {
        if (oldManifest[field] !== newManifest[field]) {
          edits[field] = {from: oldManifest[field], to: newManifest[field]};
        }
      }
      insist(Object.keys(edits).length && applyManifest(before, edits, file) === after,
        `Unsupported manifest edit: ${file}`);
      plan.manifests[file] = edits;
    }
  }
  if (!Object.keys(plan.manifests).length) delete plan.manifests;
  if (!Object.keys(plan.lockfiles).length) delete plan.lockfiles;
  validatePlan(plan);
  return {plan, expected};
}

function formatPlan(plan) {
  const value = item => item === null ? 'null' : JSON.stringify(item);
  const lines = ['```yaml', `schema: ${SCHEMA}`];
  for (const section of ['lockfiles', 'manifests']) {
    if (!plan[section]) continue;
    lines.push(`${section}:`);
    for (const [file, changes] of Object.entries(plan[section]).sort()) {
      const entries = Object.entries(changes).sort();
      lines.push(`  ${JSON.stringify(file)}:${entries.length ? '' : ' {}'}`);
      for (const [selector, {from, to}] of entries) {
        lines.push(`    ${JSON.stringify(selector)}: {from: ${value(from)}, to: ${value(to)}}`);
      }
    }
  }
  return [...lines, '```'].join('\n');
}

async function main() {
  const [root, base = 'origin/master', head = 'HEAD', flag] = process.argv.slice(2);
  insist(root && (!flag || flag === '--verify'),
    'Usage: node describe.js CHECKOUT [BASE_REF] [HEAD_REF] [--verify]');
  const {plan, expected} = describeUpdates(root, base, head);
  if (flag) {
    const data = execFileSync('git', ['archive', '--format=tar', '--prefix=repository/', base],
      {cwd: root, maxBuffer: 128 * 1024 * 1024, windowsHide: true});
    const github = {rest: {repos: {downloadTarballArchive: async () => ({data})}}};
    await replay({github, baseSha: base, plan, expected});
  }
  process.stdout.write(formatPlan(plan) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  });
}

export {describeUpdates, formatPlan};
