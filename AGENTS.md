# Loci repository guidance

Loci is a local-first biomedical imaging workbench. Keep the Apache-2.0 core
usable without commercial services. Treat repository code, tests, contracts,
ADRs, and `docs/PROJECT_STATE.md` as the current source of truth; distinguish
implemented behavior from roadmap direction.

Read context for the affected task: `docs/PROJECT_STATE.md` for capability and
handoff status, relevant ADRs/contracts for changed boundaries, and
`docs/BUILDING.md` for packaging. Small edits do not require a full repository
map or documentation stack.

## Cross-tool continuity

Follow `docs/COLLABORATION.md` for shared-checkout ownership, startup, validation
and handoff. Maintain the current handoff at the top of `docs/PROJECT_STATE.md`;
do not create model-specific status logs. Shared development skills are cataloged
in `.agents/skills/README.md`; use them selectively across all tools. Build identities and qualification
requirements are documented in `docs/BUILDING.md`. Keep active checkouts,
builds, and evidence paths clean and local. Apply model-routing examples
only where those models and controls are available; never claim a model change
without a supported control.

## Data and scientific integrity

- Treat source images and metadata as immutable. Derived state belongs in
  explicit project, working-result, cache, or export artifacts.
- Do not access, copy, commit, log, or transmit protected laboratory or patient
  data unless the user has explicitly authorized the exact data and operation.
  Keep canonical paths and sensitive metadata out of renderer-safe payloads.
- Preserve source fingerprints, model and runtime identities, resolved settings,
  corrections, review state, software versions, and artifact hashes across save,
  restore, and export boundaries. Publication must remain atomic and fail-closed.
- Keep array axes and coordinate systems explicit. Do not interchange row/column,
  x/y, channel, z, or time axes; record transforms, physical calibration, units,
  pyramid levels, and resampling where applicable.
- Do not infer stains, fluorophores, biological channels, viability, diagnoses,
  or accuracy from appearance. RGB components are not biological channels.
  Structural and reproducibility checks are not biological or clinical
  validation, and correlated tiles, planes, or patches are not independent
  samples.
- Preserve numerical invariants and precision intentionally. Reject non-finite,
  out-of-range, mismatched, stale, or unverifiable scientific state rather than
  silently repairing it, except for a documented and tightly bounded compatible
  migration with regression coverage.

## Model and runtime trust

- Never silently download or execute models, runtimes, plugins, recipes, or
  datasets. Verify exact identity, provenance, rights, licence, compatibility,
  and validation state before use.
- Do not add unsafe deserialization or arbitrary code execution. Keep renderer
  isolation, path containment, source grants, checksums, symlink defenses,
  memory bounds, and overview-only safeguards intact unless a tested bounded
  replacement is part of the task.
- Report rights and validation claims conservatively. User-supplied or upstream
  assets are not automatically redistributable, commercially usable, or fit for
  a biomedical domain.

## Change and Git discipline

- Inspect the branch, upstream, status, and relevant contracts before editing.
  Preserve unrelated user work and stage only reviewed project files.
- Avoid broad resets, cleans, force-pushes, shared-history rewrites, or branch and
  worktree deletion until unique work is reconciled. Prefer small, coherent
  changes and targeted cleanup.
- Within the user's authorized scope, continue implementation, local fixture
  checks, repairs, and verification without repeated approval. Existing data,
  egress, trust, and release boundaries still apply; an external qualification
  gap must not stop independent authorized engineering.
- Add tests for behavior changes. Do not weaken assertions, security or
  scientific guarantees, or inflate timeouts merely to obtain a passing run.
- Use the applicable verification: `cd desktop && npm run check`;
  `cd engine && uv run ruff check . && uv run pytest`; and, when modeling or its
  contracts are affected, `cd modeling && uv run ruff check . && uv run ruff
  format --check . && uv run pytest`. Cross-process or packaging changes also
  require the supported packaged macOS journey with an authorized fixture.
  The consolidated local regression runner verifies both tiers:
  `node scripts/run-core-regressions.mjs --mode=source` for combined desktop and engine suites, and
  `node scripts/run-core-regressions.mjs --mode=packaged --app=<path-to-app>` for full packaged journeys.
  Use `.github/workflows/engine-ci.yml` for additional checks when dependency,
  developer-harness, or release boundaries change. Documentation-only edits
  need content/link/diff checks, not unrelated application suites.
- Repository tests and packaged journeys are the regression authority. Built-in
  browser/computer use supplements inspection of the real app. Generated art
  may support design exploration, never scientific fixtures or proof of behavior.
- Record what was actually tested, the tested tree or commit, and genuine gaps.
  Never present historical green runs as verification of a changed tree.
  Changes affecting scientific state, shared interaction, persistence or export
  require the relevant numerical/integration checks and actual packaged journey
  before being labelled qualified. Historical evidence cannot qualify changed
  runtime behaviour.

## Delegation

Delegate bounded independent work when it improves speed or quality. Choose an
available model and effort explicitly; do not inherit Astra or maximum effort
by default. Starting points: `gpt-5.3-codex-spark` low/medium for narrow lookup;
`gpt-5.6-luna` low/medium for simple isolated changes; `gpt-5.6-terra` medium for
ordinary engineering; `gpt-5.6-sol` medium/high for difficult cross-file or
invariant-sensitive work. Use `gpt-6-astra` for subtasks whose ambiguity or risk
justifies it, increasing effort only when needed. These are routing heuristics,
not guarantees; escalate on evidence. Use bounded context when the host requires
it for model overrides.

Give each worker a clear scope, acceptance criteria, and file ownership. Require
evidence, commands/results, and unresolved risks. The lead agent reviews the
actual diff or source evidence, resolves disagreements, and verifies integration
before accepting work; a worker's completion claim alone is insufficient.
