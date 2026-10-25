'use strict';

const path = require('node:path').posix;
const {LOCKFILES, insist, checkLockfile} = require('./lockfiles');

const REVIEW_CONTEXT = 'code-review/reviewable';
const CI_EVENTS = new Set(['push', 'pull_request', 'pull_request_target', 'pull_request_review',
  'deployment', 'deployment_status']);
const BYPASS_MODES = new Set(['always', 'pull_requests_only', 'exempt']);

function target(repo, pr) {
  insist(/^Reviewable\/[A-Za-z0-9_.-]+$/i.test(repo), 'repo must be Reviewable/name');
  insist(/^[1-9][0-9]*$/.test(pr) && Number.isSafeInteger(Number(pr)),
    'pr must be a positive integer');
  return {owner: 'Reviewable', repo: repo.split('/')[1], pull_number: Number(pr)};
}

function checkPr(pr, params) {
  insist(pr.state === 'open' && !pr.merged && !pr.draft, 'PR must be open and ready for review');
  insist(pr.base.repo.full_name.toLowerCase() === `${params.owner}/${params.repo}`.toLowerCase(),
    'Unexpected target repository');
  insist(pr.mergeable === true,
    'Mergeability is unknown or the PR has conflicts; retry once resolved');
}

async function checkAuthor(github, params, pr) {
  const username = pr.user?.login;
  insist(typeof username === 'string' && username.length > 0,
    'PR author is unavailable; verify and merge manually');
  let membership;
  try {
    ({data: membership} = await github.rest.orgs.getMembershipForUser({
      org: params.owner, username}));
  } catch (error) {
    throw new Error(`Cannot verify ${params.owner} membership for PR author @${username}: ` +
      error.message, {cause: error});
  }
  insist(membership?.state === 'active',
    `PR author @${username} must be an active member of ${params.owner}; ` +
      'verify and merge manually');
}

function checkPurpose(properties) {
  const purpose = properties.find(property => property.property_name === 'purpose')?.value;
  insist(purpose === 'tool' || purpose === 'library', 'Repository purpose must be tool or library');
  return purpose;
}

async function readTree(github, params, sha) {
  const {data} = await github.rest.git.getTree({...params, tree_sha: sha, recursive: '1'});
  insist(!data.truncated, 'Cannot verify a truncated repository tree');
  return new Map(data.tree.map(entry => [entry.path, entry]));
}

async function readLockfile(github, params, tree, filename) {
  const entry = tree.get(filename);
  insist(entry?.type === 'blob' && entry.mode === '100644', `Not a regular lockfile: ${filename}`);
  insist(entry.size > 0 && entry.size <= 5 * 1024 * 1024, `Unsupported lockfile size: ${filename}`);
  const {data} = await github.rest.git.getBlob({...params, file_sha: entry.sha});
  insist(data.encoding === 'base64', `Unexpected blob encoding: ${filename}`);
  return Buffer.from(data.content, 'base64').toString('utf8');
}

async function checkChanges(github, params, pr) {
  const files = await github.paginate(github.rest.pulls.listFiles, {...params, per_page: 100});
  insist(files.length > 0 && files.length === pr.changed_files && files.length < 3000,
    'PR file list is empty or incomplete');
  for (const file of files) {
    insist(
      file.status === 'modified' && !file.previous_filename &&
        LOCKFILES.has(path.basename(file.filename)),
      `Not an existing lockfile-only change: ${file.filename}`);
  }
  const {data: comparison} = await github.rest.repos.compareCommitsWithBasehead({
    ...params, basehead: `${pr.base.sha}...${pr.head.sha}`, per_page: 1});
  const mergeBase = comparison.merge_base_commit.sha;
  const beforeTree = await readTree(github, params, mergeBase);
  const afterTree = await readTree(github, params, pr.head.sha);
  // Compare complete trees too: do not trust an incomplete or racing PR file list.
  const changed = [...new Set([...beforeTree.keys(), ...afterTree.keys()])].filter(name => {
    const before = beforeTree.get(name), after = afterTree.get(name);
    return (before?.type !== 'tree' || after?.type !== 'tree') &&
      (before?.sha !== after?.sha || before?.mode !== after?.mode);
  });
  insist(
    changed.length === files.length &&
      changed.every(name => files.some(file => file.filename === name)),
    'PR file list does not match the inspected commit trees');
  for (const file of files) {
    const before = await readLockfile(github, params, beforeTree, file.filename);
    const after = await readLockfile(github, params, afterTree, file.filename);
    checkLockfile(file.filename, before, after);
  }
  return files.map(file => file.filename);
}

function supportsRule(rule, method) {
  switch (rule.type) {
    // Merging an open PR neither creates/deletes the base branch nor force-pushes it.
    case 'creation': case 'deletion': case 'non_fast_forward': return true;
    case 'required_status_checks':
      return !rule.parameters?.strict_required_status_checks_policy;
    case 'required_linear_history': return method === 'squash' || method === 'rebase';
    case 'pull_request':
      return Object.entries(rule.parameters || {}).every(([name, value]) => {
        switch (name) {
          case 'allowed_merge_methods': return value.includes(method);
          case 'dismiss_stale_reviews_on_push': return true;
          case 'required_approving_review_count': return value === 0;
          case 'required_reviewers': return value.length === 0;
          case 'require_code_owner_review': case 'require_last_push_approval':
          case 'required_review_thread_resolution':
          case 'require_extra_approval_for_unattributed_changes':
            return value === false;
          default: return false;
        }
      });
    default: return false;
  }
}

async function checkRules(github, params, rules, method) {
  const rulesets = new Map();
  for (const rule of rules.filter(value => !supportsRule(value, method))) {
    const id = rule.ruleset_id;
    insist(Number.isSafeInteger(id) && id > 0,
      `Cannot identify ruleset for unsupported merge requirement: ${rule.type}`);
    if (!rulesets.has(id)) {
      try {
        const {data} = await github.request('GET /repos/{owner}/{repo}/rulesets/{ruleset_id}',
          {...params, ruleset_id: id, includes_parents: true});
        rulesets.set(id, data);
      } catch (error) {
        throw new Error(`Cannot read ruleset #${id} for ${rule.type}: ${error.message}`,
          {cause: error});
      }
    }
    const ruleset = rulesets.get(id);
    if (BYPASS_MODES.has(ruleset.current_user_can_bypass)) continue;
    const reason = ruleset.current_user_can_bypass === 'never' ?
      'reviewable-ops cannot bypass this ruleset' : 'reviewable-ops bypass permission is unknown';
    throw new Error(`Unsupported merge requirement ${rule.type} in ruleset ` +
      `"${ruleset.name}" (#${id}): ${reason}. Verify and merge manually.`);
  }
}

function checkProtection(protection, branch, method) {
  const unsupported = requirement => {
    throw new Error(`Unsupported classic branch protection ${requirement} on "${branch}". ` +
      'Verify and merge manually.');
  };
  // reviewable-ops is neither an admin nor a custom-role bypass actor: every gate applies.
  for (const [name, value] of Object.entries(protection)) {
    if (value === null) continue;
    switch (name) {
      // Metadata and permissions unrelated to merging an existing PR.
      case 'url': case 'enforce_admins': case 'allow_force_pushes': case 'allow_deletions':
      case 'block_creations': case 'allow_fork_syncing': break;
      case 'required_status_checks':
        if (value.strict) unsupported(`${name}.strict`);
        break;
      case 'required_pull_request_reviews':
        for (const [setting, enabled] of Object.entries(value)) {
          switch (setting) {
            case 'url': case 'dismissal_restrictions': case 'dismiss_stale_reviews':
            case 'bypass_pull_request_allowances': break;
            case 'required_approving_review_count':
              if (enabled !== 0) unsupported(`${name}.${setting}`);
              break;
            case 'require_code_owner_reviews': case 'require_last_push_approval':
              if (enabled !== false) unsupported(`${name}.${setting}`);
              break;
            default: unsupported(`${name}.${setting}`);
          }
        }
        break;
      case 'required_linear_history':
        if (value.enabled && !['squash', 'rebase'].includes(method)) unsupported(name);
        break;
      case 'required_signatures': case 'required_conversation_resolution': case 'lock_branch':
        if (value.enabled) unsupported(name);
        break;
      // Push restrictions and unknown protection fields need manual verification.
      default: unsupported(name);
    }
  }
}

async function requirements(github, params, branch, method) {
  const rules = await github.paginate('GET /repos/{owner}/{repo}/rules/branches/{branch}',
    {...params, branch, per_page: 100});
  await checkRules(github, params, rules, method);
  const required = rules.filter(rule => rule.type === 'required_status_checks')
    .flatMap(rule => rule.parameters.required_status_checks)
    .map(check => ({context: check.context, app: check.integration_id}));
  try {
    const {data} = await github.rest.repos.getBranchProtection({...params, branch});
    checkProtection(data, branch, method);
    const legacy = data.required_status_checks;
    if (legacy) {
      required.push(...(legacy.checks || []).map(check => (
        {context: check.context, app: check.app_id})));
      required.push(...(legacy.contexts || []).map(context => ({context})));
    }
  } catch (error) {
    // An inaccessible policy must not be mistaken for an absent one.
    if (error.status !== 404 || error.response?.data?.message !== 'Branch not protected') {
      throw error;
    }
  }
  return required.filter(check => check.context !== REVIEW_CONTEXT);
}

function checkCi({checks, statuses, runs, required, headSha, mergeSha}) {
  const eligibleSuites = new Set(runs.filter(workflow => CI_EVENTS.has(workflow.event))
    .map(workflow => workflow.check_suite_id));
  checks = checks.filter(check => check.app?.slug !== 'github-actions' ||
    (check.check_suite?.id && eligibleSuites.has(check.check_suite.id)));
  checks = checks.filter(check => check.name !== REVIEW_CONTEXT);
  statuses = statuses.filter(status => status.context !== REVIEW_CONTEXT);
  insist(checks.length + statuses.length > 0, 'No CI results found');
  for (const check of checks) {
    insist(
      check.status === 'completed' &&
        ['success', 'neutral', 'skipped'].includes(check.conclusion),
      `CI check has not passed: ${check.name} (${check.status}/${check.conclusion})`);
  }
  // The status endpoint returns newest first. Keep the latest per SHA/context.
  const latest = new Map();
  for (const status of statuses) {
    const key = `${status.sha}:${status.context}`;
    if (!latest.has(key)) latest.set(key, status);
  }
  for (const status of latest.values()) {
    insist(status.state === 'success',
      `CI status has not passed: ${status.context} (${status.state})`);
  }
  const latestRuns = new Map();
  for (const workflow of runs.filter(workflow => CI_EVENTS.has(workflow.event))) {
    const key = `${workflow.head_sha}:${workflow.workflow_id}:${workflow.event}`;
    if (!latestRuns.has(key) || workflow.id > latestRuns.get(key).id) latestRuns.set(key, workflow);
  }
  for (const workflow of latestRuns.values()) {
    insist(workflow.status === 'completed' && workflow.conclusion === 'success',
      `CI workflow has not passed: ${workflow.name} (${workflow.status}/${workflow.conclusion})`);
  }
  // Prefer test-merge results when present, as GitHub does. Require the entire set on one SHA.
  const requiredSha = mergeSha && (checks.some(check => check.sha === mergeSha) ||
    statuses.some(status => status.sha === mergeSha)) ? mergeSha : headSha;
  const requiredChecks = checks.filter(check => !requiredSha || check.sha === requiredSha);
  const requiredStatuses = [...latest.values()].filter(status => (
    !requiredSha || status.sha === requiredSha));
  const requiredStatus = requirement => (!requirement.app || requirement.app === -1) &&
    requiredStatuses.some(value => (
      value.context === requirement.context && value.state === 'success'));
  // A standalone status is CI evidence only when the repository's policy requires it.
  insist(
    requiredChecks.some(check => check.conclusion === 'success') || required.some(requiredStatus),
    'CI contains only skipped/neutral checks or unrequired commit statuses');
  for (const requirement of required) {
    const matches = requiredChecks.filter(check => check.name === requirement.context &&
      (!requirement.app || requirement.app === -1 || check.app?.id === requirement.app));
    insist(matches.some(check => check.conclusion === 'success') || requiredStatus(requirement),
      `Required CI result missing or not successful: ${requirement.context}`);
  }
}

async function inspectCi(github, params, pr, method) {
  const required = await requirements(github, params, pr.base.ref, method);
  const checks = [], statuses = [], runs = [];
  const refs = [pr.head.sha];
  if (pr.merge_commit_sha) {
    const {data: merge} = await github.rest.git.getCommit({
      ...params, commit_sha: pr.merge_commit_sha});
    insist(
      merge.parents.length === 2 && merge.parents[0].sha === pr.base.sha &&
        merge.parents[1].sha === pr.head.sha,
      'Test merge is stale; wait for GitHub to regenerate it');
    refs.push(pr.merge_commit_sha);
  }
  for (const ref of refs) {
    const commitChecks = await github.paginate(github.rest.checks.listForRef,
      {...params, ref, filter: 'latest', per_page: 100});
    // The ref endpoint caps suites, not runs. Read the unfiltered count after collecting runs.
    const {data: suites} = await github.rest.checks.listSuitesForRef({...params, ref, per_page: 1});
    insist(
      Number.isSafeInteger(suites.total_count) && suites.total_count >= 0 &&
        suites.total_count < 1000,
      `Check-run history may be truncated for ${ref}; verify and merge manually`);
    checks.push(...commitChecks.map(check => ({...check, sha: ref})));
    const commitStatuses = await github.paginate(github.rest.repos.listCommitStatusesForRef,
      {...params, ref, per_page: 100});
    statuses.push(...commitStatuses.map(status => ({...status, sha: ref})));
    const workflows = await github.paginate(github.rest.actions.listWorkflowRunsForRepo,
      {...params, head_sha: ref, per_page: 100});
    insist(workflows.length < 1000, 'Workflow run history may be truncated');
    runs.push(...workflows);
  }
  checkCi({checks, statuses, runs, required, headSha: pr.head.sha, mergeSha: pr.merge_commit_sha});
}

async function unchangedPr(github, params, original) {
  const {data: current} = await github.rest.pulls.get(params);
  checkPr(current, params);
  insist(
    current.head.sha === original.head.sha && current.base.sha === original.base.sha &&
      current.base.ref === original.base.ref &&
      current.merge_commit_sha === original.merge_commit_sha,
    'PR head, base, or test merge changed during validation; dispatch again');
  return current;
}

async function run({github, core, repo, pr}) {
  const params = target(repo, pr);
  const {data: actor} = await github.rest.users.getAuthenticated();
  insist(actor.login.toLowerCase() === 'reviewable-ops',
    'REVIEWABLE_GITHUB_TOKEN must authenticate as reviewable-ops');
  const {data: repository} = await github.rest.repos.get(params);
  insist(!repository.archived && !repository.disabled, 'Repository is archived or disabled');
  const propertyValues = async () => (await github.request(
    'GET /repos/{owner}/{repo}/properties/values', params)).data;
  const purpose = checkPurpose(await propertyValues());
  const {data: pull} = await github.rest.pulls.get(params);
  checkPr(pull, params);
  await checkAuthor(github, params, pull);
  const files = await checkChanges(github, params, pull);
  // Prefer squash, respecting repositories that disable it or require linear history.
  const method = repository.allow_squash_merge ? 'squash' :
    repository.allow_rebase_merge ? 'rebase' : repository.allow_merge_commit ? 'merge' : null;
  insist(method, 'No merge method is enabled');
  await inspectCi(github, params, pull, method);
  await unchangedPr(github, params, pull);
  checkPurpose(await propertyValues());
  // The qualification comment commits us to the merge request; finish every check before posting.
  await github.rest.issues.createComment({...params, issue_number: params.pull_number,
    body: `This PR qualifies for auto-merge: repository purpose is \`${purpose}\`, ` +
      `author @${pull.user.login} is an active member of ${params.owner}, ` +
      `only existing lockfiles changed (${files.map(file => `\`${file}\``).join(', ')}), ` +
      'all dependency version updates are non-breaking under semver (including 0.x), ' +
      'and CI passed.\n\n' +
      `Merging verified commit \`${pull.head.sha}\` as reviewable-ops. ` +
      `The code-review/reviewable status is intentionally exempt from the CI gate.`});
  const {data: merged} = await github.rest.pulls.merge({
    ...params, sha: pull.head.sha, merge_method: method});
  insist(merged.merged === true, `GitHub did not merge the PR: ${merged.message}`);
  core.info(`Merged ${repo}#${pr} at ${merged.sha}`);
  await core.summary.addRaw(`Merged ${repo}#${pr}: ${merged.sha}`).write();
}

module.exports = {target, checkPurpose, checkCi, checkChanges, run};
