---
name: wikiskill-evolution
description: Design, audit, run, interpret, and publish WikiSkill evolution experiments. Use when asked to improve or evolve a Skill with WikiSkill, prepare train/validation/test datasets, diagnose no_action or rejected candidates, or review validation gating. Do not use for ordinary product fixes that only require code and tests.
---

# WikiSkill Evolution

Use WikiSkill to improve reusable Agent procedure from task experience while keeping product engineering, task execution, and Skill proposal as separate responsibilities.

## Choose the Mode

| Available evidence | Mode | Outcome |
| --- | --- | --- |
| One task, incident, or commit | Evidence collection | Episode record and reusable hypothesis; no evolved candidate claim |
| Several independent episodes | Skill evolution | Validation-gated candidate |
| Independent benchmark with empty initial state | Paper reproduction | Comparable experiment result |

For evidence collection, complete the real task with the normal engineering workflow. Preserve the original request and environment, commands and outcomes, failure and recovery evidence, and the possible reusable procedure. Classify deterministic parser, runner, CLI, schema, or infrastructure defects as product fixes. Do not manufacture train/validation/test variants from one episode or start `experiment prepare` until independent tasks exist.

## Required Flow

Use this flow only for Skill evolution or paper reproduction:

1. Read [evolution-guidelines.md](references/evolution-guidelines.md). Define real domain tasks for the Inference Agent and align task text, fixtures, scorer expectations, and write scope. Use the dataset template there. The task must ask the Agent to do the work, not to optimize the Skill.
2. Prepare one experiment artifact before any Provider rollout. This command validates the dataset through the selected scorer, freezes the complete active Skill context and evolution baseline, and runs the experiment audit:

   ```sh
   wikiskill experiment prepare \
     --workspace <workspace> \
     --dataset <dataset.json> \
     --target <skill-id> \
     --scorer <scorer-ref> \
     [--empty] \
     --json > <experiment.json>
   ```

   Resolve blockers and review sample-size warnings. Task semantics, write scope, and split provenance require human or source-level review. Use `wikiskill experiment audit --experiment <experiment.json> --json` to recheck a stored artifact.
3. A known-fix RED-to-GREEN check is optional diagnostic evidence, not an evolution prerequisite, and its patch must remain hidden from Inference Agents.
4. Start `wikiskill evolve --experiment <experiment.json>` with explicit Provider, model, reasoning effort, tool profile, iteration count, launch budget, and run id. The CLI reads the prepared authority fields and blocks any dataset, Skill, or Wiki drift. Use `--runner-timeout-ms` only when the task duration justifies a frozen non-default timeout.
5. Audit the terminal run before interpretation or publication:

   ```sh
   wikiskill run audit --run-root <run-root> --workspace <workspace> --json
   ```

6. Interpret the result with the decision table in [evolution-guidelines.md](references/evolution-guidelines.md), then review and publish an accepted candidate when appropriate.

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

For evidence collection, report the episode facts, product defects, reusable hypothesis, and what independent evidence is still needed. For evolution, report the frozen active Skill bundle, inputs, split-independence evidence, Provider launches, validation and test scores, Wiki changes, candidate state, run-audit result, and publication receipt when one exists.
