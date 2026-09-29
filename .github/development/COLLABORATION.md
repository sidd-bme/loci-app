# Shared development and handoff

Repository files and verified Git state carry continuity across Codex,
Antigravity and advisory ChatGPT sessions. The current user request defines scope.
.github/development/AGENTS.md supplies common boundaries; MODEL_ROLES.md adds role-specific authority.

## One source of truth per repository

| Information | Canonical location |
| --- | --- |
| Boundaries | `.github/development/AGENTS.md` |
| Current integration owner, task, branch/PR, next action, failures | Top of `docs/PROJECT_STATE.md` |
| Model authority and effort routing | [MODEL_ROLES.md](MODEL_ROLES.md) |
| Product behavior and design decisions | README, relevant contracts and ADRs |
| Build commands and qualification | [BUILDING.md](../../docs/BUILDING.md) and existing receipts |
| Active work-package contract | Existing task/PR body; compact reference in current handoff |
| Source changes | Reviewed commits and the existing PR for that work |
| Large logs, screenshots, generated data and bundles | Ignored local evidence/build directories, never source Git |

.github/development/GEMINI.md and any tool-specific rule are entry pointers, not separate policy or
status copies. Use `.agents/skills/README.md` and `docs/WORKSPACE_LAYOUT.md` when
present on this branch; older branches may not contain them. Read selected skill
references only when relevant. `docs/AGENT_ACCESS.md` governs operating the app,
not development-agent coordination.

## Start or resume

Start substantive work read-only: inspect origin, branch, HEAD, upstream and base,
`git status -sb`, staged/unstaged diffs, relevant untracked paths, recent commits,
worktrees and the actual PR. Fetch when available; say when offline. Use
`scripts/dev_snapshot.py` if it exists on this branch. Read the current handoff
and affected contracts. Compare their recorded source with the actual tree;
never assume main or a recently built app contains the latest work.

Define a concrete completion criterion. The integration owner records task,
branch/base, owned scope and UTC time at the top of PROJECT_STATE before substantial
work. Preserve earlier evidence below it. Do not replace verified history with an
optimistic completion summary. Small documentation edits need no full repository
map, broad test run or separate planning artifact.

## Ownership and concurrency

Astra is the integration owner unless the user assigns otherwise. One writer and
one build/test owner per checkout. Sequential model switching is the default:
finish or stop the previous writer and publish its handoff before the next writes.
Ownership notes are coordination, not filesystem locks. Unknown ownership means
read-only inspection until reconciled; never terminate another editor's work.

For deliberate parallel implementation, pin each worker's base commit, owned files
and worktree. Temporary worktrees are permitted; they are not competing canonical
products. Workers do not write the integration handoff or shared build output.
Astra reviews and integrates patches into the designated branch; untested worker
commits are not accepted merely because they merge. Do not run heavy verification
or packaging alongside Electron timing tests on constrained hardware.

Preserve unrelated changes: no blanket stash, reset/clean, force-push, branch switch
under another writer, deletion of unique work or replacement of an in-use app.
Before removing a temporary worktree, reconcile tracked, untracked and ignored
artifacts. Use the existing layout/build procedure where available.

## Work-package contract and return

Astra fills this in for Gemini, a Codex worker or an external adviser. Keep it in
the current task/PR, linking from the handoff; do not create a second task ledger.

```text
Task and role; repo URL/visibility; checkout/worktree:
Starting commit; target branch/PR/base; dirty-state exclusions:
User-visible outcome and why it matters:
Allowed paths and interfaces; forbidden scope:
Relevant files/contracts/decisions (only those needed):
Acceptance checks; numerical expectations and UI states when relevant:
Commit/push authority; owner of integration and shared builds:
Stop/escalate if: base mismatch, new boundary needed, meaningful repeated failure:
Return: changed files + diff/commit, commands/results and tested tree, receipts,
        failures/limitations, remaining local work, next action:
```

Unfilled critical fields mean read-only scoping, not inferred permission to edit
unrelated files. Workers can fix within the assigned boundary without asking for
every implementation choice. Stop only the dependent action when a real ambiguity
needs resolution; continue independent authorized work.

## ChatGPT Pro evidence packet

Use a dated, task-specific packet when the adviser cannot inspect the exact repo.
Record repository/visibility, commit and branch, relevant dirty patch identity,
question to decide, current behavior/constraints, proposed alternatives, exact
relevant source/contract excerpts, real screenshots if UI is involved, test/failure
evidence, unresolved assumptions, and explicit excluded/missing material. Use
permalinks pinned to the commit for accessible GitHub files. The adviser receives
only content authorized for that service; public work never receives private
history or laboratory data. A summary without the relevant code supports planning,
not a claim of exhaustive code review.

Label the reply as a proposal. Astra verifies file references and rechecks the
diff since the packet before adopting it. Reuse current contracts and state;
regenerate changed portions rather than uploading the entire repository each turn.
No tool automatically synchronizes chat memory between subscriptions.

## Implement, verify, finish

Complete the requested user journey, proportionate source/numerical checks and
real app inspection where affected, fix relevant defects, review the resulting
diff and integrate under the task's authority. Apply .github/development/AGENTS.md and BUILDING.md;
do not weaken checks or inflate timeouts to obtain green results. Keep source,
worker, package, running and installed identities distinct. Retain failures and
record exact tested commits/patches and artifact hashes. Historical green checks
cannot qualify changed behavior. A blocked external qualification does not stop
independent authorized engineering and remains a visible limitation.

At completion, interruption or model switch update the single current handoff:

```text
Updated (UTC); editor/tool/task; status (active/handoff-ready/blocked):
Objective and completion criterion; repo/branch/base/PR:
Starting commit; latest implementation commit; accepted/pending work packages:
Changed behavior and relevant files:
Checks: commands/results, tested commit or dirty-patch hash, receipt locations:
Build: worker/desktop identities, app path/hashes or not built:
Working tree: staged/unstaged/untracked paths, ownership/disposition:
Failures, decisions, constraints, next action and next owner:
Git sync: pushed SHA/local-only, remote freshness; counterpart transfer if any:
```

Use coherent reviewed commits, explicit path staging and the existing PR for the
work. Read back remote HEAD and PR base/diff. Keep draft/acceptance state honest.
Astra may commit, push and merge completed authorized development through normal
PRs when applicable gates pass; this does not authorize release, paid capacity,
visibility changes or bypassing protections. Preserve current repo-specific CI
and platform pauses; use `[skip ci]` while required. Check actual rulesets and
branch protections rather than inferring them from prose. Git policy files are
not server-side enforcement.

## Public and development repositories

Verify the origin before every push or transfer. The public repository owns its
published sources, issues, contribution docs and release claims. A development
checkout may contain newer or divergent experiments; never replace the public
tree with it wholesale or mirror private Git history.

Move fixes deliberately in either direction: identify source commit and target
base, inspect the complete diff and dependencies, exclude private paths/data and
unapproved assets, apply a reviewed patch or appropriate cherry-pick, then validate
in the target tree. Record source/target commit mapping in the relevant PR/handoff.
A public bug fix may need a development backport; a development feature is not
public until it passes the public repository's applicable gates. Keep state and
release evidence specific to each repo; synchronize only the portable shared
protocol where appropriate. Do not merge unrelated open PRs as housekeeping.
