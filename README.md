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
- CI on the current head and any current test-merge commit has passed, including
  required checks from active rulesets and legacy branch protection. Missing,
  pending, failed, or all-skipped CI does not qualify. Only the review status
  `code-review/reviewable` is excluded. Required-workflow rules need manual review.

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
