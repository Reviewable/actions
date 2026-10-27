# actions

Reusable GitHub action workflows.

## Auto safe merge

Manually dispatch **Auto safe merge** (`auto-safe-merge.yaml`) on the default branch
with `repo: Reviewable/<repository>` and `pr: <number>`. There are no automatic or
reusable-workflow triggers. The authoring agent checks that the PR looks mergeable
and that CI has passed on the current changes before dispatching. The workflow
leaves branch-policy and required-check enforcement to GitHub's merge API.

The dispatching agent records the exact workflow run ID and monitors that run
through completion using the Actions API. A new dispatch for the same repository
cancels earlier pending or running dispatches, even for a different PR. Agents
should finish one run before dispatching another for that repository. If the run's
`conclusion` is `cancelled`, report the interruption and possible competing dispatch
with the run URL; do not automatically redispatch and cancel the other agent's run.
Always check the PR's actual merge state, including after cancellation: a merge
request may have succeeded before cancellation prevented the confirmation comment.
Before retrying, resolve the competing operation and recheck the base, head, proof,
and CI. Cancellation is observed through the API, not a callback from a canceled job.

All authenticated GitHub operations in this workflow use `REVIEWABLE_GITHUB_TOKEN`.
It must authenticate as `reviewable-ops`, with repository access, permission to read
organization membership, and the existing exemption from code-review requirements.
The workflow never changes protections or falls back to another token.

### Eligible changes

All Reviewable repositories qualify, without custom-property checks. The PR author
must be an active organization member, and the PR must be open, ready, and target
the default branch, with at most 100 changed files. Changes are limited to existing
modern Yarn lockfiles and these manifest edits (which can also appear on their own):

- One patch-level publication version bump for a package already declaring
  `bundleDependencies: true` on the default branch.
- A non-breaking change to an exact Corepack Yarn pin. Replay requires Yarn 4.0.0
  or newer, which introduced `--refresh-lockfile` and `--check-resolutions`, and uses
  the resulting pin, including its integrity suffix when present.

Direct version changes must be non-breaking; transitive changes may cross major
versions when accepted by their parents' ranges. Version replacements cannot downgrade.
For pre-1.0 releases, `0.2.1 -> 0.3.0` and `0.0.1 -> 0.0.2` count as breaking.
Security fixes use the same eligibility rules. No human review is requested for
qualifying updates. Code, generated bundles, dependency ranges, configuration,
package-manager migrations, and unsupported lockfile formats are outside this path.

### Proof by construction

1. Fetch up to 100 changed files and the head/base SHAs in one GraphQL request.
   Reject larger PRs. Read the declared files at the captured head through REST's raw
   content endpoint, avoiding GraphQL's truncation of large lockfiles.
2. Parse exactly one [versioned YAML recipe](auto-safe-merge/recipe.md) in the PR
   description. Download the current default-branch snapshot; never check out or
   run configuration or scripts from the target PR.
3. Apply only the declared manifest value replacements. Seed exact npm resolutions
   for the declared Yarn descriptors, retaining other baseline entries except built-in
   compatibility patches, which Yarn regenerates from their npm sources. Reject
   stale original versions and downgrades. For manifest-only edits, find the owning
   lockfile automatically and require it to remain byte-identical.
4. Run the selected Corepack Yarn with `--refresh-lockfile --check-resolutions`
   in `--mode=update-lockfile`. Yarn reconstructs registry metadata, dependency
   edges, checksums, and descriptor grouping. Linking and builds are skipped;
   child processes receive a restricted environment without GitHub credentials.
   Corepack caches are isolated by complete pin so a cached version cannot hide
   an invalid integrity suffix. Caches and the checkout are disposable. Baseline
   Git dependencies may need source packing, so baseline configuration and tool
   pins remain trusted inputs.
5. Run again and require stable bytes. Yarn forbids combining `--immutable` with
   this mode, so the code checks stability itself. Exercise edited workspace pins
   from their own directories and require the shared lockfile to remain unchanged.
   Check unchanged manifest content, complete version-change coverage, and exact
   equality of each generated lockfile
   with the PR. Use baseline workspace entries to identify direct descriptors,
   including dev and optional dependencies, and require their versions to remain
   compatible. Formatting and checksums are not normalized away.
6. Attempt a merge bound to the verified head SHA without rereading the PR.
   GitHub makes the final merge decision. Post a confirmation
   only after success. A failed comment produces a warning without retrying the merge.

The proof applies to the captured default-branch snapshot. The merge API pins the
PR head, but does not freeze the base branch between reconstruction and merging.
Competing auto-merge runs are canceled per repository; this is not a merge lock
or a FIFO queue. Cancellation cannot undo an already-issued merge request. Other
workflows and human merges can also move the base during reconstruction.
GitHub rejects conflicts; nonconflicting concurrent changes can still affect the
combined result, as with other PR merges.

Added/removed transitive descriptors and deduplication are supported when replay
reproduces them. PR metadata cannot supply arbitrary commands, URLs, patches, or
package metadata. Unchanged non-registry entries can remain in a lockfile; selecting
a non-registry update in the recipe is unsupported. Yarn's built-in compatibility
patches for TypeScript, resolve, and fsevents are derived from their matching npm
updates; agents must not list patch selectors in recipes. Direct patched dependencies
still have to stay semver-compatible. A new package with no previous
version is accepted only if Yarn derives it from the unchanged manifests or an
accepted dependency update. Major transitive updates do not relax range validation
or exact reconstruction. Failure is reported, never converted into a review bypass.

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
the file-count limit and pinned merge, membership, merge/comment ordering, and actual Corepack
Yarn replay against a temporary local registry. The registry fixture exercises
transitive majors, direct workspace dev dependencies, duplicate versions, aliases,
pre-1.0 updates, additions/removals, platform-optional packages, future releases,
range violations, checksum tampering, and manifest-only pin updates, including
workspace pins with shared lockfiles, invalid integrity hashes, and native built-in
compatibility patches. Large raw file responses retain their full content. Replay is
exercised with Yarn 4.0.0 as well as newer pins, without normalizing their lock formats.
Archive rejection tests use a child process to verify that unsupported links and
unsafe paths reject normally and remove the temporary checkout, including after
valid files have been extracted.
The integration test downloads the pinned Yarn through Corepack and needs network
access for that download. Normal PR CI uses its read-only GitHub token and does not
receive the privileged merge token.
