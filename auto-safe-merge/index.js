'use strict';

const path = require('node:path').posix;
const {LOCKFILES, insist, checkLockfile} = require('./lockfiles');

const REVIEW_CONTEXT = 'code-review/reviewable';
const CI_EVENTS = new Set(['push', 'pull_request', 'pull_request_target', 'pull_request_review',
  'deployment', 'deployment_status']);

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

async function requirements(github, params, branch) {
  const rules = await github.paginate('GET /repos/{owner}/{repo}/rules/branches/{branch}',
    {...params, branch, per_page: 100});
  insist(!rules.some(rule => rule.type === 'workflows'),
    'Required-workflow rules need manual verification');
  const required = rules.filter(rule => rule.type === 'required_status_checks')
    .flatMap(rule => rule.parameters.required_status_checks)
    .map(check => ({context: check.context, app: check.integration_id}));
  try {
    const {data} = await github.rest.repos.getBranchProtection({...params, branch});
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

function checkCi({checks, statuses, runs, required}) {
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
  const requiredStatus = requirement => (!requirement.app || requirement.app === -1) &&
    [...latest.values()].some(value => (
      value.context === requirement.context && value.state === 'success'));
  // A standalone status is CI evidence only when the repository's policy requires it.
  insist(checks.some(check => check.conclusion === 'success') || required.some(requiredStatus),
    'CI contains only skipped/neutral checks or unrequired commit statuses');
  for (const requirement of required) {
    const matches = checks.filter(check => check.name === requirement.context &&
      (!requirement.app || requirement.app === -1 || check.app?.id === requirement.app));
    insist(matches.some(check => check.conclusion === 'success') || requiredStatus(requirement),
      `Required CI result missing or not successful: ${requirement.context}`);
  }
}

async function inspectCi(github, params, pr) {
  const required = await requirements(github, params, pr.base.ref);
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
    checks.push(...await github.paginate(github.rest.checks.listForRef,
      {...params, ref, filter: 'latest', per_page: 100}));
    const commitStatuses = await github.paginate(github.rest.repos.listCommitStatusesForRef,
      {...params, ref, per_page: 100});
    statuses.push(...commitStatuses.map(status => ({...status, sha: ref})));
    const workflows = await github.paginate(github.rest.actions.listWorkflowRunsForRepo,
      {...params, head_sha: ref, per_page: 100});
    insist(workflows.length < 1000, 'Workflow run history may be truncated');
    runs.push(...workflows);
  }
  checkCi({checks, statuses, runs, required});
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
  const files = await checkChanges(github, params, pull);
  await inspectCi(github, params, pull);
  await unchangedPr(github, params, pull);
  checkPurpose(await propertyValues());
  // Prefer squash, respecting repositories that disable it or require linear history.
  const method = repository.allow_squash_merge ? 'squash' :
    repository.allow_rebase_merge ? 'rebase' : repository.allow_merge_commit ? 'merge' : null;
  insist(method, 'No merge method is enabled');
  // The qualification comment commits us to the merge request; finish every check before posting.
  await github.rest.issues.createComment({...params, issue_number: params.pull_number,
    body: `This PR qualifies for auto-merge: repository purpose is \`${purpose}\`, ` +
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
