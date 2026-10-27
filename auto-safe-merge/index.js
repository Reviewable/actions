import {insist, parsePlan, validateFilename} from './plan.js';
import {replay} from './replay.js';

const SNAPSHOT = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    isArchived, isDisabled, squashMergeAllowed, rebaseMergeAllowed, mergeCommitAllowed,
    defaultBranchRef { name, target { oid } },
    pullRequest(number: $number) {
      state, isDraft, body, author { login }, baseRefName, baseRefOid, headRefOid, changedFiles,
      files(first: 100) {
        nodes { path, changeType }
      }
    }
  }
}`;

function parseTarget(repo, pr) {
  insist(/^Reviewable\/[A-Za-z0-9_.-]+$/i.test(repo), 'repo must be Reviewable/name');
  insist(/^[1-9][0-9]*$/.test(pr) && Number.isSafeInteger(Number(pr)),
    'pr must be a positive integer');
  return {owner: 'Reviewable', repo: repo.split('/')[1], number: Number(pr)};
}

async function fetchSnapshot(github, params) {
  // Capture the files and commit IDs together; larger PRs are outside this workflow.
  const {repository} = await github.graphql(SNAPSHOT, params);
  const pull = repository.pullRequest;
  insist(pull && pull.state === 'OPEN' && !pull.isDraft, 'PR must be open and ready for review');
  insist(!repository.isArchived && !repository.isDisabled, 'Repository is archived or disabled');
  insist(
    pull.baseRefName === repository.defaultBranchRef.name &&
      pull.baseRefOid === repository.defaultBranchRef.target.oid,
    'PR must target the current default branch');
  insist(pull.changedFiles > 0 && pull.changedFiles <= 100, 'PR must change 1 to 100 files');
  return {repository, pull, files: pull.files.nodes};
}

async function readFile(github, params, sha, file) {
  // GraphQL Blob.text truncates large lockfiles. REST raw content preserves their bytes.
  const {data} = await github.rest.repos.getContent({owner: params.owner, repo: params.repo,
    ref: sha, path: file, mediaType: {format: 'raw'}});
  insist(
    typeof data === 'string' && data.length > 0 && !data.includes('\0') &&
      Buffer.byteLength(data) <= 10 * 1024 * 1024,
    `Missing, binary, or oversized file: ${file}`);
  return data;
}

async function run({github, core, repo, pr, reconstruct = replay}) {
  const params = parseTarget(repo, pr);
  const {data: actor} = await github.rest.users.getAuthenticated();
  insist(actor.login.toLowerCase() === 'reviewable-ops',
    'REVIEWABLE_GITHUB_TOKEN must authenticate as reviewable-ops');
  const {repository, pull, files} = await fetchSnapshot(github, params);
  const author = pull.author?.login;
  insist(author, 'PR author is unavailable');
  const {data: membership} = await github.rest.orgs.getMembershipForUser({
    org: params.owner, username: author});
  insist(membership.state === 'active',
    `PR author @${author} must be an active organization member`);
  const plan = parsePlan(pull.body);
  const declared = new Set([
    ...Object.keys(plan.lockfiles || {}), ...Object.keys(plan.manifests || {})]);
  for (const file of files) {
    insist(file.changeType === 'MODIFIED' && declared.has(file.path),
      `Not a declared existing lockfile/manifest modification: ${file.path}`);
    validateFilename(file.path, file.path.endsWith('yarn.lock') ? 'yarn.lock' : 'package.json');
  }
  for (const file of Object.keys(plan.manifests || {})) {
    insist(files.some(changed => changed.path === file), `Manifest is not changed: ${file}`);
  }
  const expected = new Map();
  for (const file of declared) {
    expected.set(file, await readFile(github, params, pull.headRefOid, file));
  }
  await reconstruct({github, ...params, baseSha: pull.baseRefOid, plan, expected});
  const method = repository.squashMergeAllowed ? 'squash' :
    repository.rebaseMergeAllowed ? 'rebase' : repository.mergeCommitAllowed ? 'merge' : null;
  insist(method, 'No merge method is enabled');
  // GitHub owns branch policies, required checks, and the final mergeability decision.
  const {data: merged} = await github.rest.pulls.merge({owner: params.owner, repo: params.repo,
    pull_number: params.number, sha: pull.headRefOid, merge_method: method});
  insist(merged.merged === true, `GitHub did not merge the PR: ${merged.message}`);
  const summary = `Merged ${repo}#${pr} at ${merged.sha}; verified head ${pull.headRefOid}`;
  core.info(summary);
  await core.summary.addRaw(summary).write();
  try {
    await github.rest.issues.createComment({owner: params.owner, repo: params.repo,
      issue_number: params.number, body: 'This PR qualified for automated dependency merging. ' +
        'Its declared non-breaking updates were replayed from the default branch and the ' +
        'generated lockfiles matched the PR exactly. ' +
        `Author @${author} is an active organization member.\n\n` +
        `Merged verified head \`${pull.headRefOid}\` as reviewable-ops (\`${merged.sha}\`).`});
  } catch (error) {
    core.warning(`Merge succeeded, but the confirmation comment failed: ${error.message}`);
  }
}

export {parseTarget, fetchSnapshot, run};
