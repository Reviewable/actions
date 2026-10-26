import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {parseDocument} from 'yaml';
import {run} from './index.js';

function createFixture() {
  const calls = [];
  const state = {actor: 'reviewable-ops', membership: 'active', head: 'head', base: 'base',
    file: 'yarn.lock', changeType: 'MODIFIED', merge: true, fileCount: 1};
  const body = '```yaml\nschema: reviewable-dependency-updates/v1\n' +
    'lockfiles:\n  yarn.lock:\n    "leaf@npm:^1.0.0": {from: "1.0.0", to: "1.1.0"}\n```';
  const github = {
    graphql: async (_query, args) => {
      calls.push({kind: 'query', args});
      if (args.expression) return {repository: {object: {text: 'expected', byteSize: 8}}};
      return {repository: {squashMergeAllowed: true, defaultBranchRef: {name: 'master',
        target: {oid: state.base}}, pullRequest: {state: 'OPEN', isDraft: false,
        body: state.body || body, author: {login: 'author'}, baseRefName: 'master',
        baseRefOid: state.base, headRefOid: state.head, changedFiles: state.fileCount,
        files: {nodes: [{path: state.file, changeType: state.changeType}]}}}};
    },
    rest: {
      users: {getAuthenticated: async () => ({data: {login: state.actor}})},
      orgs: {getMembershipForUser: async () => ({data: {state: state.membership}})},
      pulls: {merge: async args => {
        calls.push({kind: 'merge', args});
        if (args.sha !== state.head) throw new Error('Head changed');
        return {data: {merged: state.merge, sha: 'merged', message: 'GitHub refused'}};
      }},
      issues: {createComment: async args => {
        calls.push({kind: 'comment', args});
        if (state.commentFails) throw new Error('unavailable');
      }}
    }
  };
  const core = {info() {/* Logging is not part of the API call sequence. */},
    warning(message) {calls.push({kind: 'warning', message});},
    summary: {addRaw() {return this;}, async write() {/* No Actions runner in unit tests. */}}};
  const reconstruct = async input => {
    calls.push({kind: 'replay', input});
    if (state.replayFails) throw new Error('Replay mismatch');
  };
  return {state, calls, github, core, reconstruct, repo: 'Reviewable/example', pr: '1'};
}

test('replays, merges the verified head, then comments', async () => {
  const context = createFixture();
  await run(context);
  assert.deepEqual(context.calls.filter(call => call.kind !== 'query').map(call => call.kind),
    ['replay', 'merge', 'comment']);
  assert.equal(context.calls.find(call => call.kind === 'merge').args.sha, 'head');
  assert.equal(context.calls.find(call => call.kind === 'replay').input.baseSha, 'base');
  assert.equal(
    context.calls.filter(call => call.kind === 'query' && !call.args.expression).length, 1);
});

test('leaves merge policy to GitHub and never comments after a refused merge', async () => {
  const context = createFixture();
  context.state.merge = false;
  await assert.rejects(run(context), /GitHub refused/);
  assert.equal(context.calls.some(call => call.kind === 'comment'), false);
});

test('comment failure reports the successful merge without retrying it', async () => {
  const context = createFixture();
  context.state.commentFails = true;
  await run(context);
  assert.equal(context.calls.filter(call => call.kind === 'merge').length, 1);
  assert.match(context.calls.find(call => call.kind === 'warning').message, /Merge succeeded/);
});

test('refuses wrong identity, nonmembers, arbitrary changes, and failed proof', async () => {
  for (const update of [{actor: 'someone-else'}, {membership: 'pending'}, {file: 'index.js'},
    {changeType: 'ADDED'}, {replayFails: true}]) {
    const context = createFixture();
    Object.assign(context.state, update);
    await assert.rejects(run(context));
    assert.equal(context.calls.some(call => call.kind === 'merge'), false);
  }
});

test('rejects more than 100 changed files without paging', async () => {
  const context = createFixture();
  context.state.fileCount = 101;
  await assert.rejects(run(context), /1 to 100/);
  assert.equal(context.calls.filter(call => call.kind === 'query').length, 1);
  assert.equal(context.calls.some(call => call.kind === 'merge'), false);
});

test('lets the pinned merge reject head changes after replay', async () => {
  const context = createFixture();
  context.reconstruct = async () => {context.state.head = 'different';};
  await assert.rejects(run(context), /Head changed/);
  assert.equal(context.calls.find(call => call.kind === 'merge').args.sha, 'head');
  assert.equal(context.calls.some(call => call.kind === 'comment'), false);
});

test('accepts a manifest-only Yarn pin recipe', async () => {
  const context = createFixture();
  context.state.file = 'package.json';
  context.state.body = '```yaml\nschema: reviewable-dependency-updates/v1\n' +
    'manifests:\n  package.json:\n' +
    '    packageManager: {from: "yarn@4.0.0", to: "yarn@4.13.0"}\n```';
  await run(context);
  assert.equal(context.calls.find(call => call.kind === 'replay').input.plan.lockfiles, undefined);
});

test('the github-script entrypoint imports ESM and reaches validation', async t => {
  const workflow = parseDocument(await readFile(
    new URL('../.github/workflows/auto-safe-merge.yaml', import.meta.url), 'utf8')).toJS();
  const script = workflow.jobs.merge.steps.find(step => step.with?.script).with.script;
  const previous = {};
  for (const [key, value] of Object.entries({
    GITHUB_WORKSPACE: fileURLToPath(new URL('..', import.meta.url)),
    TARGET_REPO: 'Reviewable/example', TARGET_PR: '1'
  })) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {delete process.env[key];} else {process.env[key] = value;}
    }
  });
  const context = createFixture();
  context.state.actor = 'wrong-identity';
  const AsyncFunction = Object.getPrototypeOf(async () => null).constructor;
  await assert.rejects(new AsyncFunction('github', 'core', script)(context.github, context.core),
    /REVIEWABLE_GITHUB_TOKEN must authenticate as reviewable-ops/);
});
