# actions

Reusable GitHub action workflows.

## Auto safe merge

Manually dispatch **Auto safe merge** (`auto-safe-merge.yaml`) on the default branch
with `repo: Reviewable/<repository>` and `pr: <number>`. There are no automatic or
reusable-workflow triggers. The authoring agent checks that the PR looks mergeable
and that CI has passed on the current changes before dispatching. The workflow
leaves branch-policy and required-check enforcement to GitHub's merge API.

All authenticated GitHub operations in this workflow use `REVIEWABLE_GITHUB_TOKEN`.
It must authenticate as `reviewable-ops`, with repository access, permission to read
organization membership, and the existing exemption from code-review requirements.
The workflow never changes protections or falls back to another token.

### Eligible changes

All Reviewable repositories qualify, without custom-property checks. The PR author
must be an active organization member, and the PR must be open, ready, and target
the default branch. Changes are limited to existing modern Yarn lockfiles and these
optional manifest edits:

- One patch-level publication version bump for a package already declaring
  `bundleDependencies: true` on the default branch.
- A non-breaking change to an exact Corepack Yarn pin. Replay requires Yarn 4.13.0
  or newer and uses the resulting pin, including its integrity suffix when present.

Direct and transitive version changes must be non-breaking and cannot downgrade.
For pre-1.0 releases, `0.2.1 -> 0.3.0` and `0.0.1 -> 0.0.2` count as breaking.
Security fixes use the same eligibility rules. No human review is requested for
qualifying updates. Code, generated bundles, dependency ranges, configuration,
package-manager migrations, and unsupported lockfile formats are outside this path.

### Proof by construction

1. Fetch the PR's complete changed-file list and head/base SHAs in the same GraphQL
   request, checking consistency across pages. Read its files at the captured head.
2. Parse exactly one [versioned YAML recipe](auto-safe-merge/recipe.md) in the PR
   description. Download the current default-branch snapshot; never check out or
   run configuration or scripts from the target PR.
3. Apply only the declared manifest value replacements. Seed exact npm resolutions
   for the declared Yarn descriptors, retaining all other baseline entries. Reject
   stale original versions, breaking replacements, and new descriptors that move
   an existing package across a compatibility boundary.
4. Run the selected Corepack Yarn with `--refresh-lockfile --check-resolutions`
   in `--mode=update-lockfile`. Yarn reconstructs registry metadata, dependency
   edges, checksums, and descriptor grouping. Linking and builds are skipped;
   child processes receive a restricted environment without GitHub credentials.
   Caches and the checkout are disposable. Baseline Git dependencies may need
   source packing, so baseline configuration and tool pins remain trusted inputs.
5. Run again and require stable bytes. Yarn forbids combining `--immutable` with
   this mode, so the code checks stability itself. Check unchanged manifest content,
   complete version-change coverage, and exact equality of each generated lockfile
   with the PR. Formatting and checksums are not normalized away.
6. Recheck the head and default-branch SHAs, then attempt a merge bound to the
   verified head SHA. GitHub makes the final merge decision. Post a confirmation
   only after success. A failed comment produces a warning without retrying the merge.

Added/removed transitive descriptors and deduplication are supported when replay
reproduces them. PR metadata cannot supply arbitrary commands, URLs, patches, or
package metadata. Unchanged non-registry entries can remain in a lockfile; selecting
a non-registry update in the recipe is unsupported. A new package with no previous
version is accepted only if Yarn derives it from the unchanged manifests or an
accepted dependency update. A new descriptor for an existing package must have a
compatible baseline version. Failure is reported, never converted into a review bypass.

### Agent tooling and tests

From `auto-safe-merge`, install with Corepack's pinned Yarn and run:

```bash
yarn install --immutable
yarn lint
yarn test
node describe.js /path/to/checkout origin/master HEAD --verify
```

The helper reads committed Git blobs, prints a recipe, and with `--verify` uses the
same replay implementation in a disposable directory. Refresh the default-branch
ref first, substituting its actual name when different. No working-tree changes,
credentials, or installed dependencies from that checkout are used. Without
`--verify`, output is a proposed recipe, not evidence that reconstruction passed.

Tests cover parser/schema failures, semver boundaries, permitted manifest changes,
pagination and SHA races, membership, merge/comment ordering, and actual Corepack
Yarn replay against a temporary local registry. The registry fixture exercises
transitive updates, duplicate versions, aliases, pre-1.0 updates, additions/removals,
platform-optional packages, future releases, range violations, and checksum tampering.
The integration test downloads the pinned Yarn through Corepack and needs network
access for that download. Normal PR CI uses its read-only GitHub token and does not
receive the privileged merge token.
