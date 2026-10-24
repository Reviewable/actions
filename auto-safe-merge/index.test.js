const {test} = require('node:test');
const assert = require('node:assert/strict');
const {target, checkPurpose, checkCi, run} = require('./index');

function fixture() {
  const calls = [];
  const state = {
    purpose: 'tool', actor: 'reviewable-ops',
    pr: {state: 'open', merged: false, draft: false, mergeable: true, changed_files: 1,
      head: {sha: 'head'}, base: {sha: 'base', ref: 'master', repo: {full_name: 'Reviewable/example'}},
      merge_commit_sha: 'merge'},
    files: [{filename: 'nested/yarn.lock', status: 'modified'}],
    checks: [{id: 1, name: 'Build', status: 'completed', conclusion: 'success', app: {id: 123}}],
    statuses: [{sha: 'head', context: 'code-review/reviewable', state: 'pending'}],
    runs: [{id: 1, head_sha: 'head', workflow_id: 10, event: 'pull_request', name: 'Build',
      status: 'completed', conclusion: 'success'}],
    required: [{type: 'required_status_checks', parameters: {required_status_checks:
      [{context: 'Build', integration_id: 123}, {context: 'code-review/reviewable'}]}}],
    version: '1.20.9', comment: false, merged: false, reads: 0,
  };
  const endpoint = (name, body) => Object.assign(async args => {
    calls.push({name, args});
    return {data: await body(args)};
  }, {endpointName: name});
  const tree = sha => [
    {path: 'nested', type: 'tree', mode: '040000', sha: `directory-${sha}`},
    {path: 'nested/yarn.lock', type: 'blob', mode: state.mode || '100644',
      sha: sha === 'ancestor' ? 'old-blob' : 'new-blob', size: 200},
  ];
  const github = {rest: {
    users: {getAuthenticated: endpoint('actor', () => ({login: state.actor}))},
    repos: {
      get: endpoint('repo', () => ({allow_squash_merge: true})),
      compareCommitsWithBasehead: endpoint('compare', () => ({merge_base_commit: {sha: 'ancestor'}})),
      getBranchProtection: endpoint('protection', () => {
        if (state.protectionError) throw state.protectionError;
        return {};
      }),
      listCommitStatusesForRef: endpoint('statuses', args => args.ref === 'head' ? state.statuses :
        state.mergeStatuses || []),
    },
    pulls: {
      get: endpoint('pr', () => {
        state.reads++;
        const result = structuredClone(state.pr);
        if (state.changeOnRead === state.reads) result.head.sha = 'new-head';
        if (state.baseChangeOnRead === state.reads) result.base.sha = 'new-base';
        return result;
      }),
      listFiles: endpoint('files', () => state.files),
      merge: endpoint('merge', args => {
        assert.equal(args.sha, 'head');
        assert.equal(state.comment, true);
        state.merged = true;
        return {merged: !state.mergeRefused, sha: 'merged-sha', message: 'result'};
      }),
    },
    git: {
      getTree: endpoint('tree', args => ({tree: tree(args.tree_sha), truncated: Boolean(state.truncated)})),
      getBlob: endpoint('blob', args => {
        const version = args.file_sha === 'old-blob' ? '1.20.8' : state.version;
        const text = `# yarn lockfile v1\n\n"body-parser@^1.20.0":\n  version "${version}"\n` +
          `  resolved "https://registry.npmjs.org/body-parser/-/body-parser-${version}.tgz"\n`;
        return {encoding: 'base64', content: Buffer.from(text).toString('base64')};
      }),
      getCommit: endpoint('commit', () => ({parents: [{sha: state.staleMerge ? 'old-base' : 'base'}, {sha: 'head'}]})),
    },
    checks: {listForRef: endpoint('checks', args => args.ref === 'head' ? state.checks : [])},
    actions: {listWorkflowRunsForRepo: endpoint('runs', args => args.head_sha === 'head' ? state.runs : [])},
    issues: {createComment: endpoint('comment', args => {
      state.comment = true;
      state.commentBody = args.body;
      if (state.ciFailsAfterComment) state.checks[0].conclusion = 'failure';
      return {};
    })},
  },
  request: endpoint('properties', () => [{property_name: 'purpose', value: state.purpose}]),
  paginate: async (method, args) => {
    assert.equal(args.per_page, 100);
    return typeof method === 'string' ? state.required : (await method(args)).data;
  }};
  const core = {info() {}, summary: {addRaw() { return this; }, async write() {}}};
  return {state, calls, execute: () => run({github, core, repo: 'Reviewable/example', pr: '12'})};
}

test('only explicit Reviewable repo names and positive PR numbers are accepted', () => {
  assert.equal(target('reviewable/a', '12').pull_number, 12);
  for (const [repo, pr] of [['other/a', '1'], ['Reviewable/../a', '1'], ['Reviewable/a', '1; echo x'],
    ['Reviewable/a', '0'], ['Reviewable/a', '9007199254740992']]) {
    assert.throws(() => target(repo, pr));
  }
});

test('purpose is the exact custom property value, not a topic or partial match', () => {
  for (const purpose of ['tool', 'library']) assert.equal(checkPurpose([{property_name: 'purpose', value: purpose}]), purpose);
  for (const value of ['production', 'tool,library', ['tool'], null]) {
    assert.throws(() => checkPurpose([{property_name: 'purpose', value}]));
  }
});

test('eligible PR comments and merges exactly the validated head', async () => {
  const f = fixture();
  await f.execute();
  assert.equal(f.state.merged, true);
  assert.match(f.state.commentBody, /qualifies for auto-merge/);
  assert.match(f.state.commentBody, /head/);
  assert.equal(f.calls.filter(call => call.name === 'merge').length, 1);
  assert.equal(f.calls.find(call => call.name === 'compare').args.basehead, 'base...head');
  assert.equal(f.calls.filter(call => call.name === 'checks').length, 4);
});

for (const [name, modify, error] of [
  ['wrong identity', s => { s.actor = 'pkaminski'; }, /reviewable-ops/],
  ['production repository', s => { s.purpose = 'production'; }, /purpose/],
  ['draft', s => { s.pr.draft = true; }, /ready for review/],
  ['closed', s => { s.pr.state = 'closed'; }, /open/],
  ['unknown mergeability', s => { s.pr.mergeable = null; }, /Mergeability/],
  ['source change', s => { s.files[0].filename = 'index.js'; }, /lockfile-only/],
  ['new lockfile', s => { s.files[0].status = 'added'; }, /lockfile-only/],
  ['renamed lockfile', s => { s.files[0].previous_filename = 'yarn.lock'; }, /lockfile-only/],
  ['truncated files', s => { s.pr.changed_files = 2; }, /incomplete/],
  ['truncated tree', s => { s.truncated = true; }, /truncated/],
  ['symlink', s => { s.mode = '120000'; }, /regular lockfile/],
  ['breaking update', s => { s.version = '2.4.0'; }, /Breaking/],
  ['failed CI', s => { s.checks[0].conclusion = 'failure'; }, /CI check/],
  ['pending CI', s => { s.checks[0].status = 'in_progress'; }, /CI check/],
  ['no CI', s => { s.checks = []; s.runs = []; }, /No CI/],
  ['all skipped', s => { s.checks[0].conclusion = 'skipped'; }, /only skipped/],
  ['wrong CI app', s => { s.checks[0].app.id = 456; }, /Required CI/],
  ['missing required check', s => { s.required[0].parameters.required_status_checks.push({context: 'Lint'}); }, /Required CI/],
  ['pending workflow', s => { s.runs[0].status = 'queued'; }, /CI workflow/],
  ['stale test merge', s => { s.staleMerge = true; }, /Test merge is stale/],
  ['head race', s => { s.changeOnRead = 2; }, /changed during/],
  ['base race', s => { s.baseChangeOnRead = 2; }, /changed during/],
  ['unreadable protection', s => { s.protectionError = Object.assign(new Error('Forbidden'), {status: 403}); }, /Forbidden/],
  ['ambiguous protection 404', s => { s.protectionError = Object.assign(new Error('Not Found'), {status: 404}); }, /Not Found/],
]) {
  test(`${name} refuses before commenting or merging`, async () => {
    const f = fixture();
    modify(f.state);
    await assert.rejects(f.execute(), error);
    assert.equal(f.state.comment, false);
    assert.equal(f.state.merged, false);
  });
}

test('unprotected branch is accepted only on the explicit API response', async () => {
  const f = fixture();
  f.state.protectionError = Object.assign(new Error('Branch not protected'),
    {status: 404, response: {data: {message: 'Branch not protected'}}});
  await f.execute();
  assert.equal(f.state.merged, true);
});

test('non-breaking lockfile deduplication does not require a version bump', async () => {
  const f = fixture();
  f.state.version = '1.20.8';
  await f.execute();
  assert.equal(f.state.merged, true);
});

test('a changed head after the comment still prevents merging', async () => {
  const f = fixture();
  f.state.changeOnRead = 3;
  await assert.rejects(f.execute(), /changed during/);
  assert.equal(f.state.comment, true);
  assert.equal(f.state.merged, false);
});

test('a CI rerun after the comment still prevents merging', async () => {
  const f = fixture();
  f.state.ciFailsAfterComment = true;
  await assert.rejects(f.execute(), /CI check/);
  assert.equal(f.state.merged, false);
});

test('a refused merge is reported as a failure', async () => {
  const f = fixture();
  f.state.mergeRefused = true;
  await assert.rejects(f.execute(), /did not merge/);
});

test('a passing head status does not hide a failed test-merge status without a SHA field', async () => {
  const f = fixture();
  f.state.statuses = [{context: 'External CI', state: 'success'}];
  f.state.mergeStatuses = [{context: 'External CI', state: 'failure'}];
  await assert.rejects(f.execute(), /CI status/);
  assert.equal(f.state.comment, false);
  assert.equal(f.state.merged, false);
});

test('latest statuses/runs replace older failures but unrelated failures remain blocking', () => {
  const data = {checks: [], required: [], statuses: [
    {sha: 'head', context: 'Build', state: 'success'}, {sha: 'head', context: 'Build', state: 'failure'},
  ], runs: [
    {id: 2, head_sha: 'head', workflow_id: 1, event: 'push', status: 'completed', conclusion: 'success'},
    {id: 1, head_sha: 'head', workflow_id: 1, event: 'push', status: 'completed', conclusion: 'failure'},
  ]};
  assert.doesNotThrow(() => checkCi(data));
  data.statuses.push({sha: 'head', context: 'Lint', state: 'failure'});
  assert.throws(() => checkCi(data), /CI status/);
});

test('manual workflow checks cannot substitute for required PR CI', () => {
  const data = {statuses: [], required: [{context: 'Build'}],
    checks: [{name: 'Build', status: 'completed', conclusion: 'success',
      app: {slug: 'github-actions'}, check_suite: {id: 42}}],
    runs: [{id: 1, check_suite_id: 42, head_sha: 'head', workflow_id: 1,
      event: 'workflow_dispatch', status: 'completed', conclusion: 'success'}]};
  assert.throws(() => checkCi(data), /No CI/);
  data.runs[0].event = 'pull_request';
  assert.doesNotThrow(() => checkCi(data));
});
