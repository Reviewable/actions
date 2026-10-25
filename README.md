# actions
Reusable GitHub action workflows

## Auto safe merge

Manually run **Auto safe merge** (`auto-safe-merge.yaml`) on the default branch,
with `repo` set to `Reviewable/<repository>` and `pr` set to the PR number.
Wait for the target PR's CI to finish first. No push, PR, schedule, reusable-workflow,
or comment event can trigger this workflow.

The workflow uses the `REVIEWABLE_GITHUB_TOKEN` secret for checkout, GitHub API
access, its eligibility comment, and the merge. It verifies that the token belongs
to `reviewable-ops`. That account must have access to the target repository and its
branch-protection settings, permission to comment and merge, and the existing code
review ruleset exemption. The workflow does not change repository protections or
fall back to `GITHUB_TOKEN`.

Eligibility is checked independently of the PR's title or author:

- The repository's `purpose` custom property is `tool` or `library`.
- The PR is open, ready for review, and mergeable, with only modifications to
  existing `yarn.lock`, `package-lock.json`, or `npm-shrinkwrap.json` files, including
  nested packages. Yarn Classic/modern and npm lockfile formats 1–3 are supported.
- Direct and transitive resolved-version updates are non-breaking: stable major
  versions remain the same, `0.x` minors remain the same, and `0.0.x` patches remain
  the same. Downgrades, prereleases, changed non-registry entries, artifact changes
  without a version change, and unverifiable lockfile migrations require manual review.
  Npm peer edges use ancestor resolution. Same-version metadata edits require manual
  review, including executable/dependency metadata and the `dev`, `peer`, `optional`,
  and `devOptional` installation flags.
- No package entries are added or removed. Parsed npm paths and Yarn descriptors
  must stay the same, including duplicate copies and npm v2 legacy dependency data.
  Relocation, deduplication that removes entries, and descriptor additions/removals
  require manual review. Regrouping existing Yarn descriptors is allowed only when
  it preserves the parsed entry set and passes the other checks.
- Reported CI on the current head and any current test-merge commit has passed.
  Required checks from active rulesets and legacy branch protection must all pass
  on the test-merge commit when it has eligible CI results, otherwise on the head.
  Results from different commits cannot combine to satisfy requirements. Missing,
  pending, failed, or all-skipped CI does not qualify. Only the review status
  `code-review/reviewable` is excluded.
  A successful commit status alone counts as CI evidence only when branch policy
  explicitly requires that context without an app restriction.
- Unsupported ruleset requirements, including deployments, code scanning, merge
  queues, required workflows, and strict up-to-date policies, require manual handling
  unless GitHub confirms that the token can bypass that specific ruleset. The workflow
  checks `current_user_can_bypass` using the repository-level ruleset API, including
  inherited rulesets. Errors identify the rule type, ruleset name, and ID before the
  qualification comment is posted. Bypass permissions do not waive this workflow's
  own lockfile or CI eligibility checks.
- Classic branch protections are assumed to apply to `reviewable-ops`, which is
  neither a repository admin nor a custom-role bypass actor. Unsupported approval,
  conversation-resolution, signature, push-restriction, branch-lock, strict-update,
  or unknown protection settings stop the workflow before its qualification comment.
  Linear history is supported with squash or rebase merges; required status checks
  retain their context and app requirements.

Package additions and removals require manual review even when CI passes. The validator
compares existing entries; it does not authenticate package metadata against the registry.

The workflow reads target files as data through the GitHub API; it never checks
out the target PR, installs its dependencies, or executes its scripts. It posts
the qualification comment and immediately requests merging the verified head using
squash when enabled, otherwise rebase or merge. All eligibility checks and head/base
rechecks finish before posting; no checks run between the comment and merge request.
The request still specifies the verified head SHA, and a merge refused by GitHub is
reported as a failure. Security updates can qualify under the same rules. A successful
dispatch merges immediately rather than enabling GitHub's deferred auto-merge setting.

From `auto-safe-merge/`, run `npm ci --ignore-scripts`, `npm run lint`, and `npm test`.
ESLint uses the shared `reviewable-configs` baseline for the validator, tests, and
lint configuration, with Node/CommonJS settings for JavaScript files. CI runs both
lint and tests; the merge workflow installs only runtime dependencies.
