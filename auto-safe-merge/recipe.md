# Dependency-update recipe v1

Place exactly one fenced `yaml` block with this schema in the PR description.
Prose, test evidence, security backports, and other code blocks can surround it.

```yaml
schema: reviewable-dependency-updates/v1
lockfiles:
  yarn.lock:
    "body-parser@npm:^2.3.0": {from: "2.3.0", to: "2.4.0"}
    "undici@npm:^8.7.0": {from: "8.7.0", to: "8.12.2"}
  tools/yarn.lock:
    "markdown-it@npm:^14.1.0": {from: "14.3.2", to: "14.3.3"}
manifests:
  package.json:
    version: {from: "1.3.3", to: "1.3.4"}
    packageManager: {from: "yarn@4.13.0", to: "yarn@4.18.1"}
```

- Paths are relative to the repository root, with `/` separators. Every changed
  file must be declared. Omit either `manifests` or `lockfiles` when unnecessary.
  For manifest-only edits, the owning lockfile is discovered automatically and
  must remain byte-identical. An unchanged lockfile can also be declared with `{}`.
- Each key is one exact Yarn descriptor, including its range and alias if any,
  such as `alias@npm:undici@^8.7.0`. Split grouped lockfile stanzas into individual
  descriptors. Separate lockfile paths distinguish independent nested projects;
  workspaces use their owning lockfile.
- List **every** descriptor whose resolved version or presence changes, including
  transitives, optional dependencies, duplicates, and deduplication. Use exact
  quoted stable versions; no ranges, tags, prereleases, or build metadata.
- Use `from: null` for an added descriptor and `to: null` for a removed descriptor.
  A range relocation is a removal and an addition, even if the version stays equal.
  Do not list unchanged descriptors or same-version metadata changes: Yarn must
  derive those itself, and the full lockfile still must match exactly.
- Direct dependencies must stay compatible, including workspace dev and optional
  dependencies. Transitive updates may cross major versions when their parents'
  ranges allow them; Yarn validates every resolution during replay.
- Manifest entries describe only an allowed publication patch bump or exact
  compatible Corepack pin update. Dependency ranges, bundle flags, engines, and
  all other fields remain unchanged. Include the owning lockfile only if it changes.
  Edited workspace pins are also exercised from their own directories and must
  preserve the lockfile reconstructed by the owning project's pin.
- Duplicate keys, YAML aliases, unknown fields, multiple recipes, stale `from`
  versions, and undeclared version changes are rejected. Do not include SHAs or
  executable commands; the workflow obtains SHAs from GitHub itself.

Generate and verify this block with `describe.js`; see the repository README.
If the default branch advances, regenerate against the new baseline and verify
again. A passing recipe proves reconstruction, not completion of application tests,
CI, cooldown checks, security-fix research, or publication checks. The authoring
agent still performs those checks before dispatch.
