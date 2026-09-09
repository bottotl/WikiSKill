---
name: wikiskill-evolution
description: Design, audit, run, interpret, and publish WikiSkill evolution experiments. Use when asked to improve or evolve a Skill with WikiSkill, prepare train/validation/test datasets, diagnose no_action or rejected candidates, or review validation gating. Do not use for ordinary product fixes that only require code and tests.
---

# WikiSkill Evolution

Use WikiSkill to improve reusable Agent procedure from task experience while keeping product engineering, task execution, and Skill proposal as separate responsibilities.

## Classify the Work First

- Fix deterministic defects in parsers, runners, CLIs, schemas, or infrastructure through the normal code-and-test workflow. Preserve their executions as evidence, but do not ask an Inference Agent to repair the evolution system it is being evaluated with.
- Use Skill evolution for reusable decisions and procedures that can improve performance across a task distribution.
- If both are present, stabilize the deterministic execution surface first, then freeze it for the experiment.

## Required Flow

1. Read [evolution-guidelines.md](references/evolution-guidelines.md). Define real domain tasks for the Inference Agent and align task text, fixtures, scorer expectations, and write scope. The task must ask the Agent to do the work, not to optimize the Skill.
2. Run `wikiskill dataset validate --dataset <dataset.json> --scorer <scorer-ref> --json`. Treat this command as the canonical dataset structure and scorer-contract validator.
3. Freeze the complete active Skill set with `wikiskill context prepare --workspace <workspace> --json > <skill-context.json>`, then freeze the evolution authority with `wikiskill evolution baseline --workspace <workspace> --target <skill-id> [--empty] --json > <baseline.json>`. The two outputs must describe the same workspace and active Skill-set digest. An empty baseline requires an empty active context.
4. Run the preflight audit before any Provider rollout:

   ```sh
   node skills/wikiskill-evolution/scripts/audit-experiment.js \
     --dataset <dataset.json> \
     --target-skill <skill-id> \
     --skill-context <skill-context.json> \
     --baseline <baseline.json> \
     --mode publishable \
     --json
   ```

   Resolve contract blockers. Review suspicious write-scope and sample-size warnings; task semantics and split provenance require human or source-level review rather than keyword-based rejection.
   Use `--mode smoke` only for harness diagnosis. Smoke warnings may be reviewed, but a smoke run must never publish a candidate.
5. A known-fix RED-to-GREEN check is optional diagnostic evidence, not an evolution prerequisite, and its patch must remain hidden from Inference Agents.
6. Start `wikiskill evolve` with the prepared workspace, dataset, target Skill, complete active Skill-set, and Wiki digests plus explicit Provider, model, reasoning effort, scorer, tool profile, iteration count, launch budget, and run id. Pass `--expected-active-skill-set-digest <baseline-active-skill-set-digest>` in addition to the target and Wiki digests. Use `--runner-timeout-ms` only when the task duration justifies a frozen non-default timeout.
7. Audit the terminal run before interpretation or publication:

   ```sh
   node skills/wikiskill-evolution/scripts/audit-run.js --run-root <run-root> --workspace <workspace> --json
   ```

8. Interpret and publish the result using [evolution-guidelines.md](references/evolution-guidelines.md). Strict validation gain is required. `no_action`, rejection, and Wiki-only growth are valid outcomes.

## Boundaries

- Inference Agents use the active Skill and solve tasks. Wiki Maintainers consolidate training traces. Skill Proposers alone propose atomic Skill changes.
- Inject the complete materialized content of every active Skill into each Inference rollout. A trigger-only or filename-only prompt is a different experiment and must be reported as such.
- Validation selects candidates. Test never selects, repairs, or tunes them.
- Freeze and report the complete active Skill inventory, per-Skill digests, and combined bundle digest. The target Skill digest alone is insufficient.
- Give each Inference Agent only its current task, active Skills, tools, and output contract; hide ground truth, private scorer data, reference patches, other tasks, candidate decisions, and the evolution Wiki. Keep validation/test trajectories out of the Maintainer and Proposer contexts.
- Do not change the dataset, scorer, model, baseline, or budget after observing a candidate score. Prepare a new auditable experiment instead.
- A host platform may bind workspaces and launch runs, but it must not redefine WikiSkill roles or acceptance rules. Read [host-integration.md](references/host-integration.md) when integrating a host or domain adapter.
- The paper initializes `S0` and `W0` as empty. WikiSkill's seeded-target mode is a production extension; use `--empty` with an empty Wiki for reproduction claims, and label seeded experiments explicitly.

## Completion

Report the frozen active Skill bundle, inputs, split-independence evidence, Provider launches, baseline and candidate validation scores, final test score, Wiki changes, candidate state, run-audit result, and publication receipt when one exists. Never describe `completed` alone as Skill improvement.
