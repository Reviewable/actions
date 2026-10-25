'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {target, checkPurpose, checkCi, run} = require('./index');

function fixture() {
  const calls = [];
  const state = {
    purpose: 'tool', actor: 'reviewable-ops',
    pr: {state: 'open', merged: false, draft: false, mergeable: true, changed_files: 1,
      user: {login: 'dependency-author'},
      head: {sha: 'head'},
      base: {sha: 'base', ref: 'master', repo: {full_name: 'Reviewable/example'}},
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
    {path: state.lockfile || 'nested/yarn.lock', type: 'blob', mode: state.mode || '100644',
      sha: sha === 'ancestor' ? 'old-blob' : 'new-blob', size: 200},
    ...(state.manifest ? [{path: 'nested/package.json', type: 'blob',
      mode: state.manifestMode || '100644', sha: 'manifest-blob', size: 200}] : []),
  ];
  const github = {rest: {
    users: {getAuthenticated: endpoint('actor', () => ({login: state.actor}))},
    orgs: {getMembershipForUser: endpoint('membership', () => {
      if (state.membershipError) throw state.membershipError;
      return state.membership || {state: 'active', role: 'member'};
    })},
    repos: {
      get: endpoint('repo', () => ({allow_squash_merge: true, ...state.repository})),
      compareCommitsWithBasehead: endpoint('compare', () => (
        {merge_base_commit: {sha: 'ancestor'}})),
      getBranchProtection: endpoint('protection', () => {
        if (state.protectionError) throw state.protectionError;
        return state.protection || {};
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
      getTree: endpoint('tree', args => (
        {tree: tree(args.tree_sha), truncated: Boolean(state.truncated)})),
      getBlob: endpoint('blob', args => {
        const contents = args.file_sha === 'manifest-blob' ? JSON.stringify(state.manifest) :
          state.blobs?.[args.file_sha];
        if (contents) {
          return {encoding: 'base64', content: Buffer.from(contents).toString('base64')};
        }
        const version = args.file_sha === 'old-blob' ? '1.20.8' : state.version;
        const text = `# yarn lockfile v1\n\n"body-parser@^1.20.0":\n  version "${version}"\n` +
          `  resolved "https://registry.npmjs.org/body-parser/-/body-parser-${version}.tgz"\n`;
        const extra = state.extraEntryOn === args.file_sha ? '\n"a@^1.0.0":\n' +
          '  version "1.0.0"\n  resolved "https://registry.npmjs.org/a/-/a-1.0.0.tgz"\n' : '';
        return {encoding: 'base64', content: Buffer.from(text + extra).toString('base64')};
      }),
      getCommit: endpoint('commit', () => (
        {parents: [{sha: state.staleMerge ? 'old-base' : 'base'}, {sha: 'head'}]})),
    },
    checks: {
      listForRef: endpoint('checks', args => (
        args.ref === 'head' ? state.checks : state.mergeChecks || [])),
      listSuitesForRef: endpoint('suites', args => {
        assert.equal(args.per_page, 1);
        if (state.suitesError) throw state.suitesError;
        return {total_count: state.suiteCounts ? state.suiteCounts[args.ref] : 1};
      }),
    },
    actions: {listWorkflowRunsForRepo: endpoint('runs', args => (
      args.head_sha === 'head' ? state.runs : state.mergeRuns || []))},
    issues: {createComment: endpoint('comment', args => {
      if (state.commentError) throw state.commentError;
      state.comment = true;
      state.commentBody = args.body;
      if (state.baseChangesAfterComment) state.pr.base.sha = 'new-base';
      if (state.ciFailsAfterComment) state.checks[0].conclusion = 'failure';
      return {};
    })},
  },
  request: async (route, args) => {
    if (route === 'GET /repos/{owner}/{repo}/rulesets/{ruleset_id}') {
      calls.push({name: 'ruleset', args});
      assert.equal(args.includes_parents, true);
      if (state.rulesetError) throw state.rulesetError;
      return {data: state.rulesets?.[args.ruleset_id] ||
        {name: 'Extra gate', current_user_can_bypass: 'never'}};
    }
    assert.equal(route, 'GET /repos/{owner}/{repo}/properties/values');
    calls.push({name: 'properties', args});
    return {data: [{property_name: 'purpose', value: state.purpose}]};
  },
  paginate: async (method, args) => {
    assert.equal(args.per_page, 100);
    return typeof method === 'string' ? state.required : (await method(args)).data;
  }};
  const core = {
    info(message) {state.info = message;},
    summary: {
      addRaw(message) {
        state.summary = message;
        return this;
      },
      async write() {state.summaryWritten = true;}
    }
  };
  return {state, calls, execute: () => run({github, core, repo: 'Reviewable/example', pr: '12'})};
}

function npmFixture(format, filename, range) {
  const f = fixture();
  f.state.lockfile = `nested/${filename}`;
  f.state.files = [{filename: f.state.lockfile, status: 'modified'}];
  f.state.manifest = {dependencies: {a: range}};
  const lock = version => {
    const entry = {version, resolved: `https://registry.npmjs.org/a/-/a-${version}.tgz`};
    return JSON.stringify({lockfileVersion: format, ...(format === 1 ? {dependencies: {a: entry}} :
      {packages: {'node_modules/a': entry}})});
  };
  f.state.blobs = {'old-blob': lock('1.0.0'), 'new-blob': lock('1.0.1')};
  return f;
}

for (const format of [1, 2, 3]) {
  for (const filename of ['package-lock.json', 'npm-shrinkwrap.json']) {
    test(`npm v${format} ${filename} checks the manifest before comment or merge`, async () => {
      const f = npmFixture(format, filename, '1.0.0');
      await assert.rejects(f.execute(), /Resolution violates dependency range: package.json -> a/);
      assert.ok(f.calls.some(call => (
        call.name === 'blob' && call.args.file_sha === 'manifest-blob')));
      assert.equal(f.state.comment, false);
      assert.equal(f.state.merged, false);
    });
  }
}

test('a compatible npm resolution satisfying its manifest can qualify', async () => {
  const f = npmFixture(3, 'package-lock.json', '^1.0.0');
  await f.execute();
  assert.equal(f.state.merged, true);
});

test('npm range verification refuses missing and symlinked manifests', async () => {
  for (const manifestMode of [undefined, '120000']) {
    const f = npmFixture(1, 'package-lock.json', '^1.0.0');
    f.state.manifestMode = manifestMode;
    if (!manifestMode) delete f.state.manifest;
    await assert.rejects(f.execute(), /Not a regular package manifest: nested\/package.json/);
    assert.equal(f.state.comment, false);
    assert.equal(f.state.merged, false);
  }
});

test('only explicit Reviewable repo names and positive PR numbers are accepted', () => {
  assert.equal(target('reviewable/a', '12').pull_number, 12);
  for (const [repo, pr] of [
    ['other/a', '1'], ['Reviewable/../a', '1'], ['Reviewable/a', '1; echo x'],
    ['Reviewable/a', '0'], ['Reviewable/a', '9007199254740992']]) {
    assert.throws(() => target(repo, pr));
  }
});

test('purpose is the exact custom property value, not a topic or partial match', () => {
  for (const purpose of ['tool', 'library']) {
    assert.equal(checkPurpose([{property_name: 'purpose', value: purpose}]), purpose);
  }
  for (const value of ['production', 'tool,library', ['tool'], null]) {
    assert.throws(() => checkPurpose([{property_name: 'purpose', value}]));
  }
});

for (const role of ['member', 'admin']) {
  test(`an active organization ${role} author can qualify`, async () => {
    const f = fixture();
    f.state.membership = {state: 'active', role};
    f.state.pr.author_association = 'NONE';
    await f.execute();
    const membershipIndex = f.calls.findIndex(call => call.name === 'membership');
    assert.deepEqual(f.calls[membershipIndex].args,
      {org: 'Reviewable', username: 'dependency-author'});
    assert.ok(membershipIndex < f.calls.findIndex(call => call.name === 'files'));
    assert.match(f.state.commentBody, /@dependency-author.*active member of Reviewable/);
    assert.equal(f.state.merged, true);
  });
}

for (const state of ['pending', undefined, 'unrecognized']) {
  test(`an author with ${state} membership refuses before inspecting files or commenting`,
    async () => {
      const f = fixture();
      f.state.membership = {state};
      f.state.pr.author_association = 'MEMBER';
      await assert.rejects(f.execute(), /PR author @dependency-author.*active member of Reviewable/);
      assert.equal(f.calls.some(call => call.name === 'files'), false);
      assert.equal(f.state.comment, false);
      assert.equal(f.state.merged, false);
    });
}

for (const status of [403, 404, 500]) {
  test(`author membership lookup failure ${status} cannot qualify a collaborator`, async () => {
    const f = fixture();
    f.state.membershipError = Object.assign(new Error(`Membership lookup ${status}`), {status});
    f.state.pr.author_association = 'COLLABORATOR';
    await assert.rejects(f.execute(), error => {
      assert.match(error.message, /Cannot verify Reviewable membership for PR author @dependency-author/);
      assert.equal(error.cause.status, status);
      return true;
    });
    assert.equal(f.calls.some(call => call.name === 'files'), false);
    assert.equal(f.state.comment, false);
    assert.equal(f.state.merged, false);
  });
}

test('a missing PR author cannot qualify', async () => {
  for (const user of [null, {login: ''}]) {
    const f = fixture();
    f.state.pr.user = user;
    await assert.rejects(f.execute(), /PR author is unavailable/);
    assert.equal(f.calls.some(call => call.name === 'membership' || call.name === 'files'), false);
    assert.equal(f.state.comment, false);
    assert.equal(f.state.merged, false);
  }
});

test('head-only CI qualifies and merges exactly the validated head', async () => {
  const f = fixture();
  await f.execute();
  assert.equal(f.state.merged, true);
  assert.match(f.state.commentBody, /qualifies for auto-merge/);
  assert.match(f.state.commentBody, /head/);
  assert.equal(f.calls.filter(call => call.name === 'merge').length, 1);
  assert.equal(f.calls.find(call => call.name === 'compare').args.basehead, 'base...head');
  assert.equal(f.calls.filter(call => call.name === 'checks').length, 2);
  const commentIndex = f.calls.findIndex(call => call.name === 'comment');
  assert.deepEqual(f.calls.slice(commentIndex).map(call => call.name), ['comment', 'merge']);
});

test('required check runs cannot be combined across head and test-merge commits', async () => {
  const f = fixture();
  f.state.mergeChecks = [{...f.state.checks[0], name: 'Lint'}];
  f.state.required[0].parameters.required_status_checks.push({context: 'Lint'});
  await assert.rejects(f.execute(), /Required CI result missing or not successful: Build/);
  assert.equal(f.state.comment, false);
  assert.equal(f.state.merged, false);
});

test('required statuses cannot be combined across head and test-merge commits', async () => {
  const f = fixture();
  f.state.checks = [];
  f.state.statuses = [{context: 'Build', state: 'success'}];
  f.state.mergeStatuses = [{context: 'Lint', state: 'success'}];
  f.state.required[0].parameters.required_status_checks = [{context: 'Build'}, {context: 'Lint'}];
  await assert.rejects(f.execute(), /Required CI result missing or not successful: Build/);
  assert.equal(f.state.comment, false);
  assert.equal(f.state.merged, false);
});

test('head check from the required app cannot replace a test-merge check from another app',
  async () => {
    const f = fixture();
    f.state.mergeChecks = [{...f.state.checks[0], app: {id: 456}}];
    await assert.rejects(f.execute(), /Required CI result missing or not successful: Build/);
    assert.equal(f.state.comment, false);
    assert.equal(f.state.merged, false);
  });

test('successful head CI cannot qualify an all-skipped test merge', async () => {
  const f = fixture();
  f.state.mergeChecks = [{...f.state.checks[0], conclusion: 'skipped'}];
  await assert.rejects(f.execute(), /only skipped/);
  assert.equal(f.state.comment, false);
  assert.equal(f.state.merged, false);
});

test('complete test-merge CI qualifies without duplicated head results', async () => {
  const f = fixture();
  f.state.mergeChecks = f.state.checks;
  f.state.checks = [];
  await f.execute();
  assert.equal(f.state.merged, true);
});

test('complete test-merge CI does not require every context on the head as well', async () => {
  const f = fixture();
  f.state.mergeChecks = [{...f.state.checks[0]}];
  f.state.checks[0].name = 'Other check';
  await f.execute();
  assert.equal(f.state.merged, true);
});

test('exempt review and ineligible manual checks do not select test-merge CI', async () => {
  const f = fixture();
  f.state.mergeStatuses = [{context: 'code-review/reviewable', state: 'pending'}];
  f.state.mergeChecks = [{...f.state.checks[0], app: {slug: 'github-actions'},
    check_suite: {id: 42}}];
  f.state.mergeRuns = [{id: 2, check_suite_id: 42, head_sha: 'merge', workflow_id: 11,
    event: 'workflow_dispatch', status: 'completed', conclusion: 'success'}];
  await f.execute();
  assert.equal(f.state.merged, true);
});

test('head CI qualifies when there is no test-merge commit', async () => {
  const f = fixture();
  f.state.pr.merge_commit_sha = null;
  await f.execute();
  assert.equal(f.state.merged, true);
  assert.equal(f.calls.filter(call => call.name === 'checks').length, 1);
});

for (const ref of ['head', 'merge']) {
  for (const count of [1000, 1001, undefined, -1]) {
    test(`${ref} with ${count} check suites refuses even with few successful checks`, async () => {
      const f = fixture();
      f.state.suiteCounts = {head: 1, merge: 1, [ref]: count};
      f.state.mergeChecks = [{...f.state.checks[0]}];
      await assert.rejects(f.execute(), new RegExp(`Check-run history.*${ref}`));
      assert.equal(f.state.comment, false);
      assert.equal(f.state.merged, false);
    });
  }
}

test('suite counts below the cap permit complete check results on both commits', async () => {
  const f = fixture();
  f.state.suiteCounts = {head: 999, merge: 999};
  f.state.mergeChecks = [{...f.state.checks[0]}];
  await f.execute();
  assert.equal(f.state.merged, true);
  for (const ref of ['head', 'merge']) {
    const checksIndex = f.calls.findIndex(call => call.name === 'checks' && call.args.ref === ref);
    const suitesIndex = f.calls.findIndex(call => call.name === 'suites' && call.args.ref === ref);
    assert.ok(suitesIndex > checksIndex);
    assert.equal(f.calls[suitesIndex].args.app_id, undefined);
    assert.equal(f.calls[suitesIndex].args.check_name, undefined);
  }
});

test('an unreadable check-suite count refuses before commenting or merging', async () => {
  const f = fixture();
  f.state.suitesError = new Error('Check suites unavailable');
  await assert.rejects(f.execute(), /Check suites unavailable/);
  assert.equal(f.state.comment, false);
  assert.equal(f.state.merged, false);
});

for (const [name, modify, error] of [
  ['wrong identity', s => {s.actor = 'pkaminski';}, /reviewable-ops/],
  ['production repository', s => {s.purpose = 'production';}, /purpose/],
  ['draft', s => {s.pr.draft = true;}, /ready for review/],
  ['closed', s => {s.pr.state = 'closed';}, /open/],
  ['unknown mergeability', s => {s.pr.mergeable = null;}, /Mergeability/],
  ['source change', s => {s.files[0].filename = 'index.js';}, /lockfile-only/],
  ['new lockfile', s => {s.files[0].status = 'added';}, /lockfile-only/],
  ['renamed lockfile', s => {s.files[0].previous_filename = 'yarn.lock';}, /lockfile-only/],
  ['truncated files', s => {s.pr.changed_files = 2;}, /incomplete/],
  ['truncated tree', s => {s.truncated = true;}, /truncated/],
  ['symlink', s => {s.mode = '120000';}, /regular lockfile/],
  ['breaking update', s => {s.version = '2.4.0';}, /Breaking/],
  ['failed CI', s => {s.checks[0].conclusion = 'failure';}, /CI check/],
  ['pending CI', s => {s.checks[0].status = 'in_progress';}, /CI check/],
  ['no CI', s => {s.checks = []; s.runs = [];}, /No CI/],
  ['all skipped', s => {s.checks[0].conclusion = 'skipped';}, /only skipped/],
  ['unrequired status only', s => {
    s.checks = []; s.runs = []; s.required = [];
    s.statuses.push({context: 'Looks good', state: 'success'});
  }, /unrequired commit statuses/],
  ['wrong CI app', s => {s.checks[0].app.id = 456;}, /Required CI/],
  ['missing required check', s => {
    s.required[0].parameters.required_status_checks.push({context: 'Lint'});
  }, /Required CI/],
  ['pending workflow', s => {s.runs[0].status = 'queued';}, /CI workflow/],
  ['stale test merge', s => {s.staleMerge = true;}, /Test merge is stale/],
  ['head race', s => {s.changeOnRead = 2;}, /changed during/],
  ['base race', s => {s.baseChangeOnRead = 2;}, /changed during/],
  ['unreadable protection', s => {
    s.protectionError = Object.assign(new Error('Forbidden'), {status: 403});
  }, /Forbidden/],
  ['ambiguous protection 404', s => {
    s.protectionError = Object.assign(new Error('Not Found'), {status: 404});
  }, /Not Found/],
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

for (const [name, protection] of [
  ['required_pull_request_reviews.required_approving_review_count',
    {required_pull_request_reviews: {required_approving_review_count: 1}}],
  ['required_pull_request_reviews.require_code_owner_reviews',
    {required_pull_request_reviews: {require_code_owner_reviews: true}}],
  ['required_pull_request_reviews.require_last_push_approval',
    {required_pull_request_reviews: {require_last_push_approval: true}}],
  ['required_pull_request_reviews.future_review_gate',
    {required_pull_request_reviews: {future_review_gate: true}}],
  ['required_status_checks.strict', {required_status_checks: {strict: true}}],
  ...['required_conversation_resolution', 'required_signatures', 'lock_branch',
    'future_merge_gate'].map(name => [name, {[name]: {enabled: true}}]),
  ['restrictions', {restrictions: {users: [], teams: [], apps: []}}],
]) {
  test(`classic ${name} refuses before commenting or merging`, async () => {
    const f = fixture();
    f.state.protection = {...protection, enforce_admins: {enabled: false}};
    // A ruleset exemption does not waive classic protection.
    f.state.required.push({type: 'pull_request', ruleset_id: 42,
      parameters: {required_approving_review_count: 1}});
    f.state.rulesets = {42: {name: 'Reviews', current_user_can_bypass: 'always'}};
    await assert.rejects(f.execute(), error => {
      assert.ok(error.message.includes(`classic branch protection ${name} on "master"`));
      assert.match(error.message, /Verify and merge manually/);
      return true;
    });
    assert.equal(f.state.comment, false);
    assert.equal(f.state.merged, false);
  });
}

for (const method of ['squash', 'rebase', 'merge']) {
  test(`classic linear history checks the selected ${method} merge method`, async () => {
    const f = fixture();
    f.state.repository = {allow_squash_merge: method === 'squash',
      allow_rebase_merge: method === 'rebase', allow_merge_commit: method === 'merge'};
    f.state.protection = {required_linear_history: {enabled: true}};
    if (method === 'merge') {
      await assert.rejects(f.execute(), /classic branch protection required_linear_history/);
      assert.equal(f.state.comment, false);
      assert.equal(f.state.merged, false);
    } else {
      await f.execute();
      assert.equal(f.calls.find(call => call.name === 'merge').args.merge_method, method);
    }
  });
}

test('supported classic protections retain required checks and allow a normal PR merge',
  async () => {
    const f = fixture();
    f.state.required = [];
    f.state.protection = {
      url: 'protection', enforce_admins: {enabled: true},
      allow_force_pushes: {enabled: false}, allow_deletions: {enabled: false},
      block_creations: {enabled: true}, allow_fork_syncing: {enabled: false},
      required_signatures: {enabled: false}, required_conversation_resolution: {enabled: false},
      lock_branch: {enabled: false}, required_linear_history: {enabled: true}, restrictions: null,
      required_status_checks: {strict: false, checks: [{context: 'Build', app_id: 123}],
        contexts: ['Build', 'External CI', 'code-review/reviewable']},
      required_pull_request_reviews: {url: 'reviews', required_approving_review_count: 0,
        require_code_owner_reviews: false, require_last_push_approval: false,
        dismiss_stale_reviews: true, dismissal_restrictions: {users: [], teams: [], apps: []},
        bypass_pull_request_allowances: {users: [], teams: [], apps: []}},
    };
    await assert.rejects(f.execute(), /Required CI result missing or not successful: External CI/);
    assert.equal(f.state.comment, false);
    f.state.statuses.push({context: 'External CI', state: 'success'});
    f.state.checks[0].app.id = 456;
    await assert.rejects(f.execute(), /Required CI result missing or not successful: Build/);
    assert.equal(f.state.comment, false);
    f.state.checks[0].app.id = 123;
    await f.execute();
    assert.equal(f.state.merged, true);
    assert.equal(f.calls.some(call => call.name === 'ruleset'), false);
  });

for (const type of ['required_deployments', 'code_scanning', 'workflows', 'merge_queue',
  'required_signatures', 'commit_message_pattern', 'future_merge_gate']) {
  test(`unsupported ${type} reports its ruleset before commenting or merging`, async () => {
    const f = fixture();
    f.state.required.push({type, ruleset_id: 42});
    await assert.rejects(f.execute(), error => {
      assert.ok(error.message.includes(type));
      assert.match(error.message, /Extra gate.*#42.*reviewable-ops cannot bypass/);
      return true;
    });
    assert.equal(f.state.comment, false);
    assert.equal(f.state.merged, false);
  });
}

for (const bypass of ['always', 'pull_requests_only', 'exempt']) {
  test(`GitHub-confirmed ${bypass} bypass permits unsupported rules`, async () => {
    const f = fixture();
    f.state.required.push({type: 'required_deployments', ruleset_id: 42},
      {type: 'code_scanning', ruleset_id: 42});
    f.state.rulesets = {42: {name: 'Extra gates', current_user_can_bypass: bypass}};
    await f.execute();
    assert.equal(f.state.merged, true);
    assert.equal(f.calls.filter(call => call.name === 'ruleset').length, 1);
  });
}

for (const bypass of [undefined, 'unrecognized']) {
  test(`missing or unknown bypass permission (${bypass}) requires manual handling`, async () => {
    const f = fixture();
    f.state.required.push({type: 'required_deployments', ruleset_id: 42});
    f.state.rulesets = {42: {name: 'Extra gate', current_user_can_bypass: bypass}};
    await assert.rejects(f.execute(),
      /required_deployments.*Extra gate.*#42.*permission is unknown/);
    assert.equal(f.state.comment, false);
    assert.equal(f.state.merged, false);
  });
}

test('bypass permission for one ruleset does not apply to another', async () => {
  const f = fixture();
  f.state.required.push({type: 'required_deployments', ruleset_id: 42},
    {type: 'code_scanning', ruleset_id: 43});
  f.state.rulesets = {42: {name: 'Bypassed gate', current_user_can_bypass: 'always'}};
  await assert.rejects(f.execute(), /code_scanning.*#43.*cannot bypass/);
  assert.equal(f.state.comment, false);
  assert.equal(f.state.merged, false);
});

test('unreadable ruleset produces a contextual error before commenting or merging', async () => {
  const f = fixture();
  f.state.required.push({type: 'code_scanning', ruleset_id: 42});
  f.state.rulesetError = Object.assign(new Error('Forbidden'), {status: 403});
  await assert.rejects(f.execute(), /Cannot read ruleset #42 for code_scanning: Forbidden/);
  assert.equal(f.state.comment, false);
  assert.equal(f.state.merged, false);
});

test('an unsupported rule without a ruleset ID cannot be silently ignored', async () => {
  const f = fixture();
  f.state.required.push({type: 'code_scanning'});
  await assert.rejects(f.execute(), /Cannot identify ruleset.*code_scanning/);
  assert.equal(f.state.comment, false);
  assert.equal(f.state.merged, false);
});

test('ruleset bypass does not bypass the workflow CI requirement', async () => {
  const f = fixture();
  f.state.required.push({type: 'workflows', ruleset_id: 42});
  f.state.rulesets = {42: {name: 'Bypassed workflow', current_user_can_bypass: 'exempt'}};
  f.state.checks[0].conclusion = 'failure';
  await assert.rejects(f.execute(), /CI check/);
  assert.equal(f.state.comment, false);
  assert.equal(f.state.merged, false);
});

test('rules satisfied by a normal squash PR merge need no bypass lookup', async () => {
  const f = fixture();
  f.state.required.push(...['creation', 'deletion', 'non_fast_forward', 'required_linear_history']
    .map(type => ({type, ruleset_id: 42})));
  f.state.required.push({type: 'pull_request', ruleset_id: 43, parameters: {
    required_approving_review_count: 0, required_reviewers: [], dismiss_stale_reviews_on_push: true,
    require_code_owner_review: false, require_last_push_approval: false,
    required_review_thread_resolution: false,
    require_extra_approval_for_unattributed_changes: false,
    allowed_merge_methods: ['squash', 'rebase'],
  }});
  await f.execute();
  assert.equal(f.state.merged, true);
  assert.equal(f.calls.some(call => call.name === 'ruleset'), false);
});

for (const parameters of [{required_approving_review_count: 1},
  {required_review_thread_resolution: true}, {allowed_merge_methods: ['rebase']},
  {future_review_gate: true}]) {
  test(`PR constraint ${Object.keys(parameters)[0]} requires manual review`, async () => {
    const f = fixture();
    f.state.required.push({type: 'pull_request', ruleset_id: 42, parameters});
    await assert.rejects(f.execute(), /pull_request.*#42.*cannot bypass/);
    assert.equal(f.state.comment, false);
    assert.equal(f.state.merged, false);
  });
}

test('linear history blocks a merge-commit-only repository before commenting', async () => {
  const f = fixture();
  f.state.repository = {allow_squash_merge: false, allow_merge_commit: true};
  f.state.required.push({type: 'required_linear_history', ruleset_id: 42});
  await assert.rejects(f.execute(), /required_linear_history.*#42.*cannot bypass/);
  assert.equal(f.state.comment, false);
  assert.equal(f.state.merged, false);
});

test('strict up-to-date policy requires manual verification', async () => {
  const f = fixture();
  f.state.required[0].ruleset_id = 42;
  f.state.required[0].parameters.strict_required_status_checks_policy = true;
  await assert.rejects(f.execute(), /required_status_checks.*#42.*cannot bypass/);
  assert.equal(f.state.comment, false);
  assert.equal(f.state.merged, false);
});

for (const [blob, change] of [['old-blob', 'removed'], ['new-blob', 'added']]) {
  test(`a package ${change} with passing CI refuses before commenting or merging`, async () => {
    const f = fixture();
    f.state.extraEntryOn = blob;
    await assert.rejects(f.execute(), new RegExp(`Package entry ${change}`));
    assert.equal(f.state.comment, false);
    assert.equal(f.state.merged, false);
  });
}

test('unchanged resolved versions do not require a version bump', async () => {
  const f = fixture();
  f.state.version = '1.20.8';
  await f.execute();
  assert.equal(f.state.merged, true);
});

test('a base change while posting the comment does not delay the merge request', async () => {
  const f = fixture();
  f.state.baseChangesAfterComment = true;
  await f.execute();
  assert.equal(f.state.comment, true);
  assert.equal(f.state.pr.base.sha, 'new-base');
  assert.equal(f.state.reads, 2);
  assert.equal(f.state.merged, true);
});

test('a CI change while posting the comment does not delay the merge request', async () => {
  const f = fixture();
  f.state.ciFailsAfterComment = true;
  await f.execute();
  assert.equal(f.state.checks[0].conclusion, 'failure');
  assert.equal(f.calls.filter(call => call.name === 'checks').length, 2);
  assert.equal(f.state.merged, true);
});

test('a failed qualification comment prevents the merge request', async () => {
  const f = fixture();
  f.state.commentError = new Error('Comment failed');
  await assert.rejects(f.execute(), /Comment failed/);
  assert.equal(f.state.comment, false);
  assert.equal(f.state.merged, false);
  assert.equal(f.calls.some(call => call.name === 'merge'), false);
});

test('a refused merge is reported as a failure', async () => {
  const f = fixture();
  f.state.mergeRefused = true;
  await assert.rejects(f.execute(), /did not merge/);
});

test('a passing head status cannot hide a failed merge status without a SHA field', async () => {
  const f = fixture();
  f.state.statuses = [{context: 'External CI', state: 'success'}];
  f.state.mergeStatuses = [{context: 'External CI', state: 'failure'}];
  await assert.rejects(f.execute(), /CI status/);
  assert.equal(f.state.comment, false);
  assert.equal(f.state.merged, false);
});

test('latest statuses/runs replace older failures but unrelated failures remain blocking', () => {
  const data = {checks: [], required: [{context: 'Build'}], statuses: [
    {sha: 'head', context: 'Build', state: 'success'},
    {sha: 'head', context: 'Build', state: 'failure'},
  ], runs: [
    {id: 2, head_sha: 'head', workflow_id: 1, event: 'push',
      status: 'completed', conclusion: 'success'},
    {id: 1, head_sha: 'head', workflow_id: 1, event: 'push',
      status: 'completed', conclusion: 'failure'},
  ]};
  assert.doesNotThrow(() => checkCi(data));
  data.statuses.push({sha: 'head', context: 'Lint', state: 'failure'});
  assert.throws(() => checkCi(data), /CI status/);
});

test('status-only CI must be explicitly required without an app restriction', () => {
  const data = {checks: [], runs: [], statuses: [{context: 'External CI', state: 'success'}],
    required: [{context: 'External CI'}]};
  assert.doesNotThrow(() => checkCi(data));
  data.required[0].app = -1;
  assert.doesNotThrow(() => checkCi(data));
  data.required[0].app = 123;
  assert.throws(() => checkCi(data), /unrequired commit statuses/);
  data.required = [{context: 'Different CI'}];
  assert.throws(() => checkCi(data), /unrequired commit statuses/);
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
