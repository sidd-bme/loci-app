# Start or hand off a Loci task

Use the actual project folder in your chosen app. These prompts load live state;
they do not assume that chat history, main, or another model's summary is current.
Use [COLLABORATION.md](COLLABORATION.md) for the work-package/evidence templates.

## Astra in Codex — lead a milestone

```text
Act as Loci's integration lead for this milestone: [concrete outcome].
Read AGENTS.md, the current handoff in docs/PROJECT_STATE.md, and the relevant
sections of docs/COLLABORATION.md and docs/MODEL_ROLES.md. Inspect current Git,
PR, dirty work and affected contracts. Preserve unrelated work.
Choose the plan and UI/UX/DX implementation details. Define done as an integrated,
working user journey with appropriate source/numerical checks, actual app visual
and interaction review where affected, defect repair and an accurate handoff.
Use bounded task-fit workers only when worthwhile. Retain ownership of scientific
and architectural decisions and inspect their actual diffs/evidence.
Continue through completion under repository boundaries. Do not stop at an audit
or first patch. If useful, prepare one concrete Gemini work package or a ChatGPT
Pro review packet; identify any independent work you can do while it is reviewed.
Keep docs/PROJECT_STATE.md current. Report remaining real qualification gaps.
```

## Gemini in Antigravity — implement an assigned slice

Select Gemini 3.8 Flash High for a demanding slice (Medium for straightforward
work). Use New Worktree for concurrent editing and verify its starting commit;
use Local only for an explicitly exclusive sequential handoff.

```text
Read GEMINI.md, AGENTS.md, docs/MODEL_ROLES.md (Gemini role) and the current
handoff. Work only on the filled-in Loci work package below:
[paste the exact contract prepared by Astra, including repo/base/allowed files]
First verify origin, HEAD, branch, worktree and dirty files against the assignment.
Implement and repair within that scope, preserving all scientific/trust invariants.
Do not add silent fallbacks. Do not expand scope, change policy/acceptance, push
or merge unless the owner explicitly reassigns that authority.
Run the assigned checks and return the actual patch/commits, tested identity,
commands/results, real UI evidence when required, failures and remaining work.
If a boundary must change, describe the smallest needed extension to Astra.
```

## GPT-6 Pro in ChatGPT — independent advice

```text
You are advising Loci's Astra integration lead. Review only the attached dated
source/evidence packet, identified by repository and commit/dirty patch. If you
cannot access a referenced file, say so; do not claim to have reviewed it.
Question: [specific design decision or review objective].
Identify concrete risks, alternatives and acceptance checks, cite packet files,
and distinguish established behavior from assumptions and proposals. Consider
scientific correctness, UI/UX, maintainability and resource limits as relevant.
Do not reopen scientific assumptions or treat a test pass as biological validation.
Return a concise recommendation and any must-fix findings with reproduction or
verification steps. The Codex lead decides adoption after checking current code.
```

## Astra — accept the handoff

```text
Reconcile this worker/adviser handoff with Loci's current tree and task contract.
Inspect the actual changes and decisive evidence, including changes since its
recorded base. Accept, amend or reject with reasons; repair and run the affected
integration checks. Complete the authorized milestone and normal PR workflow,
update the current handoff, and preserve unresolved release/qualification gaps.
```

If only onboarding was requested, remain read-only and summarize the actual repo,
branch/PR, dirty work, qualification gaps and next safe action. No prompt changes
the model picker, shares another subscription's quota or grants access to data.
