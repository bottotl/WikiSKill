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
2. Run the standard one-shot command. It prepares the frozen experiment, executes the complete evolution loop, and audits the terminal evidence. It never publishes the staged candidate:

   ```sh
   wikiskill experiment run \
     --workspace <workspace> \
     --dataset <dataset.json> \
     --target <skill-id> \
     --scorer <scorer-ref> \
     --runtime-profile <profile.json> \
     [--empty] \
     --json-events
   ```

   Resolve blockers and review sample-size warnings. Task semantics, write scope, and split provenance require human or source-level review. For a one-off run, the profile fields may be supplied as explicit CLI flags instead.
3. When preparation and execution require separate review, use `wikiskill experiment prepare ... > experiment.json`, optionally recheck it with `wikiskill experiment audit --experiment experiment.json`, then run `wikiskill evolve --experiment experiment.json ...` followed by:

   ```sh
   wikiskill run audit --run-root <run-root> --workspace <workspace> --json
   ```

4. Interpret the result with the decision table in [evolution-guidelines.md](references/evolution-guidelines.md), then review and publish an accepted candidate when appropriate.

## Boundaries

- Inference Agents use the active Skill and solve tasks. Wiki Maintainers consolidate training traces. Skill Proposers alone propose atomic Skill changes.
- Inject the complete materialized content of every active Skill into each Inference rollout. A trigger-only or filename-only prompt is a different experiment and must be reported as such.
- Validation selects candidates. Test never selects, repairs, or tunes them.
- Freeze and report the complete active Skill inventory, per-Skill digests, and combined bundle digest. The target Skill digest alone is insufficient.
- Give each Inference Agent only its current task, active Skills, tools, and output contract; hide ground truth, private scorer data, reference patches, other tasks, candidate decisions, and the evolution Wiki. Keep validation/test trajectories out of the Maintainer and Proposer contexts.
- Do not change the dataset, scorer, model, baseline, or budget after observing a candidate score. Prepare a new auditable experiment instead.
- When implementing a host or domain adapter, follow the repository's [host integration architecture](../../docs/architecture/host-integration.md).
- The paper initializes `S0` and `W0` as empty. WikiSkill's seeded-target mode is a production extension; use `--empty` with an empty Wiki for reproduction claims, and label seeded experiments explicitly.

## Completion

For evidence collection, report the episode facts, product defects, reusable hypothesis, and what independent evidence is still needed. For evolution, report the frozen active Skill bundle, inputs, split-independence evidence, Provider launches, validation and test scores, Wiki changes, candidate state, run-audit result, and publication receipt when one exists.
