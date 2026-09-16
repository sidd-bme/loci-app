# Shared development and handoff

This protocol applies to development in Codex, Antigravity, Claude, Gemini and
human editors. Repository files and verified Git state carry continuity; private
chat history is not required. The current user request governs task scope.

## One source of truth

| Information | Canonical location |
| --- | --- |
| Repository boundaries | `AGENTS.md` |
| Current editor, task, next action, unresolved work, latest qualified app | Current handoff at the top of `docs/PROJECT_STATE.md` |
| Product direction and supported behavior | `README.md`, `docs/CAPABILITY_MATRIX.md`, relevant contracts/ADRs |
| Shared task-fit design skills | `.agents/skills/README.md` |
| Build commands and artifact evidence requirements | `docs/BUILDING.md` |
| Durable code changes | Git commits and the existing PR for that branch |
| Test logs, large screenshots, app bundles and fixture outputs | Local output directory outside Git or under `.loci/` |

`CLAUDE.md` and `GEMINI.md` are pointers to this protocol. Do not copy policy or
status into them. Tool-specific automatic loading is not assumed: explicitly
read the canonical files when adopting an existing thread. `docs/AGENT_ACCESS.md`
describes assistants operating the app, not this development protocol.

## Start or resume

1. Read `AGENTS.md`, the current handoff in `docs/PROJECT_STATE.md`, and the
   affected contracts. For builds, read `docs/BUILDING.md`.
2. Inspect `git status -sb`, `git log -5 --oneline`, `git diff --stat`,
   `git diff --cached --stat` and `git worktree list`. Fetch origin when available;
   inspect the branch's upstream difference and current PR/base. Never assume
   that `main`, a chat's old commit, or a recently built app is current.
3. Compare the last handoff commit with HEAD and inspect the intervening diff.
   Account for staged, unstaged and untracked work separately. Validate another
   agent's changes from code and appropriate tests, not its completion message.
4. Set a concrete completion criterion. Update the current handoff with editor,
   task, branch/base, touched scope and a UTC timestamp before substantial edits.
   Record unknown ownership explicitly instead of claiming the checkout is idle.

### Optional read-only observation

From the repository root, run `python3 scripts/dev_snapshot.py`. It reports the
current branch/commit, local upstream difference, worktrees and staged/unstaged/
untracked paths without fetching, changing files or launching anything. Ignored
files and source contents are not included. Add `--app /absolute/path/Loci.app`
to hash the three recorded macOS app artifacts; this does not validate a build.
Use `--repo /absolute/path/to/worktree` when inspecting a different checkout.
Output is JSON on stdout; retain it in a named local evidence folder if useful,
then link it from the handoff. It does not replace `PROJECT_STATE.md`, test receipts,
manual diff review or editor coordination. A missing upstream is not a clean remote,
and the helper never asserts remote freshness or an atomic dirty-tree identity.

## Shared checkout and ownership

Use one active writer and one build/test owner per checkout. Switching tools is
sequential: finish or stop the previous writer and publish its handoff before the
next writes. A note is coordination, not an enforced filesystem lock. If another
writer is active or ownership is uncertain, inspect read-only and resolve ownership
before overlapping edits. Do not kill another editor's app, test or build process.
For intentional parallel implementation use separate worktrees and explicit file
ownership; coordinate shared dependencies, output directories and integration.

Preserve unrelated changes. Never stash everything, reset, clean, switch branches
under another writer, overwrite an open app, force-push, or delete branches to make
a dashboard appear clean. Reconcile unique commits first. A dirty tree is acceptable
at handoff only when each outstanding change and its owner/status is recorded.

## Implement and validate

Keep changes coherent and fit the shared product direction. Record decisions that
change behavior, scientific meaning or support boundaries in the relevant contract
or decision document. Do not turn subjective suggestions into factual guarantees.
Follow `AGENTS.md` for tests and safety; do not run application suites for prose-only
edits. Keep failures and unchanged test limits visible. Historical green runs apply
only to their recorded source and artifact identities.

Use `docs/BUILDING.md` for packaging and build records. A source commit, frozen
worker, packaged app, currently running app and installed app can all differ.
Report them separately. On the 8 GB Mac, serialize heavyweight verification,
packaging, engine suites and Electron performance QA; do not run signature scans
concurrently with timing tests. Never silently synchronize away optional runtimes.

## Finish, pause or switch models

Update the current handoff in place; retain dated completed evidence below it.
Use this compact structure, including explicit `none` or `not verified` values:

```text
Updated (UTC):
Editor/tool and task reference:
Status: active / handoff-ready / blocked
Objective and completion criterion:
Branch, base and PR:
Starting commit; latest implementation commit:
Changed behavior and relevant files:
Checks: command, result, tested commit/tree, log/receipt location:
Build: worker source identity; desktop source identity; app path and hashes:
Working tree: staged / unstaged / untracked changes, ownership and disposition:
Open failures, decisions, constraints and next action:
Git sync: pushed commit or local-only; fetch/offline status:
```

For an uncommitted tested tree, retain its patch (including relevant untracked
source), hash and starting commit in the local evidence folder. Do not include
protected data or credentials. Prefer committing the reviewed source before
building so the identity is unambiguous. A later documentation-only commit does
not retroactively become the runtime's tested commit.

Stage only reviewed files, check the staged diff, and commit coherent changes.
Update the existing PR rather than creating duplicate PRs for every model switch.
Push when authorized and read back the remote head/body. Preserve the current
hosted-CI/Windows pause; use `[skip ci]` while that pause applies. Do not merge past
existing review/release gates or describe a draft as released. When offline, leave
an explicit local-only handoff. Keep binaries and large qualification artifacts
out of Git; record which evidence requires this shared Mac rather than a fresh
GitHub clone. The final chat response links to the shared handoff and states the
next action; it is not the only record of work.

Keep active builds, evidence, and local scratch files outside Git to preserve repository hygiene.
