# OmniPilot product requirements

OmniPilot is a **project-centred AI workspace** for work, coding, research, scientific exploration and learning.
It keeps a project's context, decisions, execution, evidence and handoffs connected. It is not "several
chatbots in a dashboard".

Progress against every item below is tracked in [STATUS.md](STATUS.md). Design choices are in
[DECISIONS.md](DECISIONS.md), and the checks behind each claim are in [VERIFICATION.md](VERIFICATION.md).

## Architecture

- **One Router**, with a replaceable decision-model interface. Until a trained decision model exists, the router
  is a clearly labelled *baseline* (keyword rules plus an optional language-model call). It is never described as
  a trained model.
- **Six specialists:** InfraPilot, Helper, CodePilot, PromptPilot, ScienceLab, ScriptScholar.
- Shared product features are not agents. The router calls only the specialists a request needs, runs
  independent work in parallel and dependent work in order, and every specialist works within the current
  project's access rules.

## Structure

- **Workspace:** Home, Projects, Connections, Templates / Recipes, Activity & Approvals, Settings.
- **Home:** recent projects, recent activity, pending approvals, blocked work, and next actions derived from
  recorded state.
- **Each project:** Overview, Conversations, Files, Tasks & Runs, Project DNA, Change Radar, Evidence, Learn,
  Handoffs, Settings & Permissions. These are disclosed progressively, so navigation doesn't overwhelm.

## Project foundation

- Create, rename, archive, restore, export, duplicate and delete. Deletion is confirmed, and its scope is
  explained first.
- Fields: name, description, type, optional deadline, requirements, constraints, milestones, acceptance criteria.
- Each project has its own files, conversations, memory, tasks, runs, evidence, connections, permissions and
  progress, with search scoped to the project and multiple conversations per project.
- Everything persists across page refreshes and server restarts, with empty, loading, error and success states.
- Duplication shows a preview of what is copied, and never copies secrets, credentials, approval grants or the
  authority to take external actions. Copying between projects is previewed and explicitly confirmed.
- Personal preferences are kept separate from project facts.

## Project Overview

Shows the goal, current state, acceptance checks ("6 of 9 checks passed", never an invented percentage),
blockers, the next useful action, and pending questions and approvals.

## The seven core improvements

1. **Project DNA:** goals, requirements, confirmed constraints, important files and references, decisions with
   rationale, open questions, known problems, assumptions. Each entry records its source, timestamps,
   confirmation status and author. User-confirmed facts, file-derived observations and suggestions are kept
   distinct; guesses never silently become facts; decision history is kept.
2. **Change Radar:** meaningful changes and their possible effects on code, tests, documentation, configuration,
   requirements and research conclusions. Each alert shows the trigger, what is affected, whether the link is
   confirmed or suspected, the evidence, a next step, and a status (open / resolved / dismissed / postponed). It
   starts from deterministic references and makes no claim of full semantic analysis.
3. **Outcome Contracts:** a goal, acceptance checks, constraints, required approvals and what is out of scope,
   all editable. Checks are pending / passed / failed / blocked / not applicable, and "passed" requires real
   evidence.
4. **Evidence Receipts:** the claim or action, its source (file, test, observation or tool output), timestamp,
   run, result, and limitations. Proposed, applied and tested changes are kept distinct. Nothing is fabricated,
   and each receipt is linked to the exact artifact version it supports where feasible.
5. **Recovery Mode:** persisted task and run states (pending, running, awaiting approval, blocked, completed,
   failed, cancelled, interrupted) with their steps, inputs, outputs, errors and external ids. Supports resume,
   retrying eligible steps, cancelling, and viewing past attempts. Uses idempotency keys and reconciles
   uncertain external actions before retrying. No claim of universal undo.
6. **Teach-Back (in CodePilot's opt-in Learn Mode):** explain this, adjust the depth, give a hint, ask a targeted
   question, check my explanation, prepare me to present. Learning notes stay separate from project facts.
7. **Handoff Capsules:** previewable JSON and Markdown exports with presets (quick summary, teammate handoff,
   teacher / presentation brief, technical continuation). They exclude credentials and secrets, and the user can
   remove items before exporting.

## Additional differentiators

8. **Project Branches:** separate proposed changes, decisions, tasks and evidence; comparison with the original;
   a preview of selective merges; conflict detection.
9. **Comparison Bench:** two approaches compared on the same inputs and criteria, recording actual measurements
   and costs only. Execution is sandboxed.
10. **Assumption Inbox:** each assumption with its reason, source, affected work and status (unverified /
    confirmed / corrected / dismissed). Confirmed assumptions can become Project DNA, keeping their source.
11. **Return Briefing:** what changed since the last visit, built from event history only.
12. **Readiness Check:** requirement coverage, configured tests, research sourcing, configuration, handoff
    documentation and export privacy, each passed / failed / not checked / not applicable. It is not proof of
    correctness or security.
13. **Portable Recipes:** a recipe is a reusable workflow, a routine is a trigger for it, and a run is one
    execution. Reusing a recipe carries no private project data or approval grants.
14. **Permission Preview:** before any external change, shows the exact action, target, changes, scope, what
    won't change, and whether it can be undone. Approval is bound to the exact payload and target, so any change
    needs fresh approval. Secrets are hidden in the UI without weakening the server-side binding.
15. **Research-to-Build links:** source → finding → decision → task → changed artifact → verification. No
    rationale is invented after the fact.
16. **Collaboration & ownership:** task owner, reviewer, approver and read-only roles, built on real accounts
    only. While OmniPilot is single-user, this is labelled as not yet functional.
17. **Challenge My Plan:** a weak assumption, why it matters, the missing evidence, the smallest useful test, and
    the result that would change the plan.

## Security, execution, usage

- Connections are defined centrally and granted per project, with access enforced in the backend (not only in
  the UI or prompts) and read, write and delete kept distinct. Secrets stay in existing storage and are never
  sent to the browser.
- No arbitrary local paths or URLs are fetched, and paths are protected against traversal. Retrieved content is
  untrusted data, never instructions. External actions go through approval, and approval authority never comes
  from model-generated text. Consequential events are audited.
- Untrusted code never runs unsandboxed. When execution is unavailable, OmniPilot says so and never pretends.
- Usage and cost are shown per project and run. If data is unavailable, it is shown as "unavailable", not zero.
  Configurable budgets require approval to be exceeded.
