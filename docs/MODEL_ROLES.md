# Model roles for Loci

These are starting heuristics for this project, not model benchmarks. User task
scope and AGENTS.md apply to every role. Do not claim to change a running model
or reasoning setting through prose. Use the app's supported model control.
These are agent instructions; human contributors do not need any AI subscription.
If a model is unavailable, report that and use an explicitly assigned alternative
without pretending it has identical capability or authority.

## Lead and workers

| Role | Starting setting | Owns |
| --- | --- | --- |
| Codex integration lead | Astra Medium, Standard | Product/architecture decisions, UI/UX/DX, decomposition, integration and final verification |
| Complex implementation / hard design or final high-value review | Astra High / Extra High | Ambiguous scientific semantics, persistence/trust boundaries, cross-stack failures |
| Bounded complex implementer | Sol High | A defined feature slice, difficult regression, integration-sensitive tests |
| Routine implementer | Terra Medium | Localized engineering from a clear plan with known contracts and objective acceptance |
| Evidence scout | Luna Medium (Low for trivial extraction) | File/symbol inventory, exact passages, log extraction; read-only by default |
| Antigravity implementer | Gemini 3.8 Flash High | One assigned work package with explicit paths, base and acceptance checks |
| ChatGPT adviser | GPT-6 Pro / Astra Pro as available | Read-only architecture alternatives, plan critique or high-value review of a pinned evidence packet |

Astra Medium is the usage-conscious project default. Low can suit straightforward
coordination or follow-ups. Select High for difficult sustained implementation and
cross-system reasoning; Extra High for ambiguous architecture, scientific meaning
or consequential final review. Max/Ultra are deliberate, not everyday settings.
The lead should recommend a higher setting when needed; it must not pretend that
prose changes the running effort or block independently tractable work to demand it.
For simple Gemini tasks, Medium is a reasonable lower-cost choice; use the app's
model/effort selector. API thinking parameters are not desktop configuration.

Sol is the usual choice for difficult implementation, not every edit. Terra
remains useful; Luna Max is not assumed equivalent to Terra or Sol. Route by
observed accepted work and correction burden. After a substantive worker failure,
diagnose before retrying. After two unsuccessful repair approaches to the same
underlying bug, stop that worker and escalate to Sol/Astra with the preserved
diff and failure evidence; do not blindly repeat or reset other work. A normal
red test during implementation is not itself a failed repair approach. For
repetitive edits assigned to Luna, review one representative result before
expanding the batch. A failed sample is a reason to narrow or reroute the job.
No fixed savings percentage is promised.

## Astra's authority and completion

Within the owner's requested milestone, Astra makes engineering, design and
prioritization decisions and continues through implementation, relevant checks,
real-app inspection where affected, repairs and integration. Do not stop at a
plan or first patch when a finished milestone is requested. Preserve privacy,
scientific invariants, costs, licensing and release boundaries. Choose a coherent
user journey over accumulating unrelated features. Record meaningful boundary
changes in the relevant existing ADR/contract, not a model-specific plan log.

For UI work, inspect actual supported application states: normal, empty, error,
loading, keyboard/focus and relevant sizing/theme/reduced-motion states. Use the
existing theme/icon system and task-fit shared design skills if present. Couple
visual checks with behavioral and numerical checks; a screenshot cannot qualify
persistence or scientific correctness. Never substitute generated artwork for
app evidence. DX work should keep documented setup and errors usable by a fresh
contributor without quietly changing dependency or release contracts.

## Delegation contract

Use up to two concurrent Codex workers, only for useful independent tasks. This
is a ceiling, not a requirement. Prefer read-heavy parallel work; use exclusive
file ownership or separate worktrees for edits. Heavy tests/builds and timing QA
are serialized on constrained hardware. No recursive worker delegation or routine
reviewer chains. Avoid polling unchanged work; use completion notifications and
the host's supported event waits within its timing rules.

Custom Codex roles are in `.codex/agents/`: `loci_scout`, `loci_worker` and
`loci_implementer`. If the host cannot select a named role, explicitly choose its
model/effort and provide its bounded instructions. Use bounded context when the
host requires it for overrides. The default worker is Terra Medium; ambiguous
or invariant-sensitive tasks require explicit Sol/Astra routing. The lead keeps
the task if a suitable worker/control is unavailable.

Every assignment names the repo/visibility, base commit, objective, allowed paths,
forbidden scope, interfaces/invariants, acceptance checks and required handoff.
Workers return evidence and proposed changes. Astra reads decisive sources/diffs,
resolves disagreements, reruns affected integration checks and decides acceptance.
A second review is for a concrete unresolved risk, not a ritual after each edit.

## Gemini in Antigravity 2.0

Gemini may decide implementation details within its assigned slice and repair its
own failures there. It must not expand product scope, reinterpret scientific
quantities, redesign shared architecture, loosen checks, change agent policy or
release settings, merge, or publish unless the owner explicitly reassigns that
authority. If another boundary/file must change, report the smallest proposed
extension to Astra. Never turn a failed operation into success using a silent
fallback, empty result, swallowed exception or weakened assertion.

Before editing, verify checkout, origin, HEAD, branch, dirty files and assigned
base. No assignment means read-only reconnaissance and a proposed bounded task.
For concurrent work use New Worktree mode or an explicitly prepared worktree;
verify its starting SHA rather than assuming Antigravity copied the active branch
or its uncommitted edits. Local mode is suitable for an exclusive sequential
handoff. Worktree isolation does not isolate non-Git data, running apps or shared
build caches. One owner controls shared builds and the designated app.

Return a patch or narrowly scoped commits (only when assigned), with exact checks,
failures, evidence locations and next action. Do not push/merge by default. Workers
report to the lead instead of concurrently rewriting the shared current handoff.
Astra integrates and updates that handoff. These instructions guide behavior;
they are not an OS sandbox or a guarantee against mistakes.

## ChatGPT Pro planning and review

Use it when an independent view can change a consequential decision, not for every
small diff. Astra prepares a minimal task-relevant packet using the template in
COLLABORATION.md. The adviser identifies assumptions, competing approaches,
concrete failure modes and acceptance checks. It must name missing files instead
of pretending it inspected them. Advice is proposed, not adopted policy.

Astra checks the proposal against the current tree before implementation. If HEAD
or dirty state changed, reconcile the delta or regenerate the affected packet.
Do not send protected research data, secrets, local paths or private development
material to a public issue or repository. Repository access in one product does
not imply access in another. No subscription-to-API bridge or new harness is used.

## Setup and source basis

Codex uses `.codex/config.toml` in a trusted checkout; explicit app/session choices
may override defaults. Reopen a task and check the picker after setup. Existing
skills, plugins and permission settings are not replaced by these roles.
Antigravity workspace guidance is `.agents/rules/loci-coordination.md`; select
Always On in Customizations -> Rules if needed, or explicitly read GEMINI.md in
the task prompt. Do not assume root GEMINI.md alone auto-loads in every desktop
version. The owner's machine may also have a scoped global entry pointer.

Source basis, checked 2026-09-19:
- [OpenAI model guidance](https://learn.chatgpt.com/docs/models) and
  [subagents/custom agents](https://learn.chatgpt.com/docs/agent-configuration/subagents).
- [OpenAI developer effort calibration](https://x.com/thsottiaux/status/2096688770523467947)
  supports trying Low/Medium when Sol High was sufficient; it is not a universal
  orchestration or Loci benchmark.
- [OpenAI developer guidance on narrow context, skills and completion](https://learn.chatgpt.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra).
- [Google Antigravity rules](https://antigravity.google/docs/rules-workflows),
  [projects/worktrees](https://antigravity.google/docs/projects) and
  [Gemini 3.8 Flash guidance](https://ai.google.dev/gemini-api/docs/latest-model).

Provider guidance establishes mechanisms, not the best routing for Loci.
Community reports disagree about Luna Max and orchestration savings; neither
popularity nor coding benchmarks establish biomedical correctness. Revisit these
choices when actual correction effort or model availability warrants it.
