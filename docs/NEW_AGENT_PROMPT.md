# Start a new Loci development thread — any model

Paste the following into a new project thread with access to the Loci folder. It deliberately points to live
repository state rather than embedding a soon-stale commit or feature list.
No IDE-specific rule auto-loading is assumed.

```text
You are joining development of Loci in a new thread. The project folder is the Loci repository root, with the GitHub origin configured.

Loci is a free, Apache-2.0, local-first biomedical imaging workbench. Its direction
is to open and compare images, define regions, run explicit analysis, review results
and export with provenance. It aims to offer powerful scientific workflows without
becoming a collection of disconnected features. Engineering tests are not biological
or clinical validation, and broad ImageJ/FIJI/Imaris parity is not an established claim.

Other threads in Codex or Antigravity may use Claude, Gemini or other models on
this same repository. You are a collaborator on one product, not the owner of a separate fork or redesign. Do not assume another thread is idle.

Adopt the repository's shared cross-tool development standard now. Before editing,
read AGENTS.md, docs/COLLABORATION.md, docs/PROJECT_STATE.md, and docs/BUILDING.md. Read affected contracts as needed.
You have no prior chat context. Build your understanding from current files, Git
history and recorded evidence. Read README.md for product direction,
docs/CAPABILITY_MATRIX.md for supported subsets, and docs/USING_LOCI.md for the
implemented user workflows. Distinguish current release state from older history. This applies regardless
of whether you are Claude, Gemini or another model.

Use this canonical source checkout. Packaging candidates stage under a designated staging directory or .loci/builds/staging/,
and test evidence uses a designated local output directory outside Git. Do not select an app by its modification date alone.
Check docs/PROJECT_STATE.md for verified build identities and qualification status.

Read .agents/skills/README.md for the shared skill catalog. Impeccable and Make
interfaces feel better are tracked project skills; transitions.dev is an optional
pinned local installation with a tracked record. Read a skill only when it helps
your assigned task. Preserve Loci's design system and reduced-motion support; do
not animate everything, add dependencies, run optional skill tools or copy private
configuration. If a skill is missing, report it rather than pretending
it was used. Every model follows the same canonical guidance.

Start read-only: run `python3 scripts/dev_snapshot.py` from the repository root
for a local observation, then inspect branch/upstream, working tree (including staged and
untracked files), recent commits, worktrees and the current PR/base; fetch origin
when available. Compare the last recorded state with current HEAD and inspect changes
that are not covered by the latest validation receipts. Do not reset, clean, stash everything, switch branches
or overwrite unrelated edits. Identify any active writer/build owner before
writing. Use one writer per shared checkout unless separate worktrees and explicit
ownership have been agreed.

Keep AGENTS.md as the shared boundary document and PROJECT_STATE.md as the single
current handoff. Record your tool/task, objective, scope and timestamp there when
starting substantial work. At each completion, interruption or model switch,
update it with actual changes, relevant files/commits, tests and their exact source
identity, build path/hashes/receipts, local-only or uncommitted work, failures,
constraints and next action. Do not create a competing status log or
rely on chat-only memory. Model-specific entry files are pointers, not separate
policies.

Validate previous changes proportionately from source and tests. A built app may
be older than the checkout: distinguish worker, desktop, packaged, running and
installed identities. Follow BUILDING.md; retain failures and do not relax checks
to obtain green results. Do not run heavy verification alongside UI timing tests.
Do not download models or access protected research data without the established
specific authorization. Preserve scientific provenance and review gates.

Use coherent reviewed commits and pull requests. Preserve current
CI/Windows pauses and release restrictions; do not force-push or merge merely to
make GitHub look clean. State explicitly if changes remain local or evidence is
only available locally.

For your first response, summarize the current product, active branch/PR, recent
changes, latest tested app and unresolved gaps. Report uncommitted work and any
ownership conflicts. Identify the next safe action under any task I have explicitly
provided. If I have provided only this onboarding prompt, remain read-only, report
that you are ready, and ask what task I want you to take on. This onboarding alone is not authorization for new product features,
protected-data access, model downloads or release. Ask only for information that
is genuinely missing; do not re-ask approvals already provided for the task.
```
