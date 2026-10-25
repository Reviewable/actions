'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {run, target, snapshot} = require('./index');

function fixture() {
  const calls = [];
  const state = {actor: 'reviewable-ops', membership: 'active', head: 'head', base: 'base',
    file: 'yarn.lock', changeType: 'MODIFIED', merge: true, pages: 1, reads: 0};
  const body = '```yaml\nschema: reviewable-dependency-updates/v1\n' +
    'lockfiles:\n  yarn.lock:\n    "leaf@npm:^1.0.0": {from: "1.0.0", to: "1.1.0"}\n```';
  const github = {
    graphql: async (_query, args) => {
      calls.push({kind: 'query', args});
      if (args.expression) return {repository: {object: {text: 'expected', byteSize: 8}}};
      state.reads++;
      const head = state.changeHeadOnRead === state.reads ? 'different' : state.head;
      const base = state.changeBaseOnRead === state.reads ? 'different' : state.base;
      return {repository: {squashMergeAllowed: true, defaultBranchRef: {name: 'master',
        target: {oid: base}}, pullRequest: {state: 'OPEN', isDraft: false,
        body: state.body || body, author: {login: 'author'}, baseRefName: 'master',
        baseRefOid: base, headRefOid: head, changedFiles: state.pages,
        files: {nodes: [{path: args.cursor ? 'tools/yarn.lock' : state.file,
          changeType: state.changeType}], pageInfo: {
          hasNextPage: state.pages > 1 && !args.cursor, endCursor: 'next'}}}}};
    },
    rest: {
      users: {getAuthenticated: async () => ({data: {login: state.actor}})},
      orgs: {getMembershipForUser: async () => ({data: {state: state.membership}})},
      pulls: {merge: async args => {
        calls.push({kind: 'merge', args});
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
  const context = fixture();
  await run(context);
  assert.deepEqual(context.calls.filter(call => call.kind !== 'query').map(call => call.kind),
    ['replay', 'merge', 'comment']);
  assert.equal(context.calls.find(call => call.kind === 'merge').args.sha, 'head');
  assert.equal(context.calls.find(call => call.kind === 'replay').input.baseSha, 'base');
});

test('leaves merge policy to GitHub and never comments after a refused merge', async () => {
  const context = fixture();
  context.state.merge = false;
  await assert.rejects(run(context), /GitHub refused/);
  assert.equal(context.calls.some(call => call.kind === 'comment'), false);
});

test('comment failure reports the successful merge without retrying it', async () => {
  const context = fixture();
  context.state.commentFails = true;
  await run(context);
  assert.equal(context.calls.filter(call => call.kind === 'merge').length, 1);
  assert.match(context.calls.find(call => call.kind === 'warning').message, /Merge succeeded/);
});

test('refuses wrong identity, nonmembers, arbitrary changes, and failed proof', async () => {
  for (const update of [{actor: 'someone-else'}, {membership: 'pending'}, {file: 'index.js'},
    {changeType: 'ADDED'}, {replayFails: true}]) {
    const context = fixture();
    Object.assign(context.state, update);
    await assert.rejects(run(context));
    assert.equal(context.calls.some(call => call.kind === 'merge'), false);
  }
});

test('detects head/base changes after replay and during pagination', async () => {
  for (const update of [{changeHeadOnRead: 2}, {changeBaseOnRead: 2}]) {
    const context = fixture();
    Object.assign(context.state, update);
    await assert.rejects(run(context), /changed/);
    assert.equal(context.calls.some(call => call.kind === 'merge'), false);
  }
  const context = fixture();
  context.state.pages = 2;
  assert.equal((await snapshot(context.github, target(context.repo, context.pr))).files.length, 2);
  context.state.reads = 0;
  context.state.changeHeadOnRead = 2;
  await assert.rejects(snapshot(context.github, target(context.repo, context.pr)), /pagination/);
});
