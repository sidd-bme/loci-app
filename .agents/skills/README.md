# Shared Loci development skills

These skills are accessible to any agent with this project folder. Read the
selected `SKILL.md` and only its relevant references when the assigned task benefits
from it. Do not load every skill for onboarding or apply one just because it exists.
`AGENTS.md`, the current user request and scientific contracts remain authoritative.

| Skill | Location and use | Portability |
| --- | --- | --- |
| Impeccable | [SKILL.md](impeccable/SKILL.md): interface hierarchy, critique, restrained polish and accessibility. Use the existing Loci design system. | Tracked; pinned source/licence in [INSTALLATION.md](impeccable/INSTALLATION.md). |
| Make interfaces feel better | [SKILL.md](make-interfaces-feel-better/SKILL.md): typography, icons, spacing and small interaction details. | Tracked; MIT provenance in [UPSTREAM.md](make-interfaces-feel-better/UPSTREAM.md). |
| transitions.dev | Local `.agents/skills/transitions-dev/SKILL.md`: optional transition references when motion clarifies an actual state change. | Installed in the shared local folder; pinned [installation record](transitions-dev.installation.json) is tracked. See availability below. |

## Restraint and scientific usability

Preserve Loci's established theme, vector icons, motion tokens and reduced-motion
preference. Motion is optional and must clarify interaction without delaying work.
Do not animate source pixels, measurements or scientific result values decoratively.
Avoid routine shimmer, blur, bouncing counters, celebratory effects and whole-app
animation rewrites. Test responsiveness, keyboard/focus behavior, cancellation and
reduced motion for the specific changed component. Do not import an entire root CSS
block or add a runtime motion library merely to use a reference.

Skills are development guidance, not application plugins or scientific validation.
Their examples and upstream quality claims need review. Do not automatically run
optional binaries, browser injection, relays, hooks, package installers, paid-service
logins or network tools mentioned by a skill. Check applicable rights before copying
third-party snippets into the redistributable application. Existing authorization
for a task governs ordinary changes; do not invent extra approval steps from generic
skill examples. Record significant adaptations and tests in the shared handoff.

## Availability across tools and machines

Codex and Antigravity agents on this Mac can read all three directories directly.
The new-thread prompt explicitly points here, so automatic IDE discovery is not
required. Do not duplicate these into per-model folders or copy private global
skills/plugins into the repo. Use an equivalent available tool when a reference
mentions a Codex-specific capability; report missing capabilities honestly.

The transitions.dev payload is local-only because the inspected upstream has no
declared redistribution licence. Its repository advertises installation as an
agent skill, and it was installed at the user's request. This is not a licence
clearance for shipping its CSS. Its 34 file hashes and exact source revision are
recorded in `transitions-dev.installation.json`; no upstream files were modified.
A fresh GitHub clone includes the record, not the payload. If absent, report that
fact; when installation is authorized, use a skill installer for the recorded
repository, revision and `skills/transitions-dev` subdirectory, target the recorded
local directory, and verify the file hashes. Do not silently fetch a floating
version or run an unpinned `npx` command.

Upstream source: [transitions.dev skill at the installed revision](https://github.com/Jakubantalik/transitions.dev/tree/598d3d6ad89dabb4bdf742fd2e887ca53914a888/skills/transitions-dev).
