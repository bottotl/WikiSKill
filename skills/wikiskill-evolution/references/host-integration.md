# Host and Domain Integration

## Ownership

The standalone WikiSkill repository owns the evolution algorithm, workspace layout, role boundaries, dataset contract, gating, candidate publication, and this meta Skill.

A host platform may provide:

- repository and workspace identity;
- carrier resolution and frozen context preparation;
- Provider execution and run monitoring;
- durable delivery records and user review surfaces.

A domain adapter may provide:

- realistic domain tasks and fixtures;
- task environment materialization;
- domain scorers and capability references;
- real-system acceptance evidence.

Hosts and adapters must not copy or redefine the generic evolution method. Distribute this Skill from the WikiSkill package or a pinned repository revision.

Use the official `wikiskill experiment audit` and `wikiskill run audit` commands. The bundled scripts exist only as compatibility entry points.

## Required Host Behavior

- Preserve the complete active Skill inventory and bundle digest, target Skill, Wiki, dataset, model, and runtime digests through launch. Pass the baseline active Skill-set digest into `evolve`; a context receipt alone is not a launch-time drift guard.
- Give an Inference Agent only its current task and keep ground truth, private scorer inputs, other tasks, and the Wiki out of its context. Keep validation/test tasks and trajectories out of the Maintainer and Proposer contexts.
- Inject the complete materialized active Skill bundle into every Inference rollout, or record that the host is evaluating retrieval as an additional variable.
- Record Provider launches and enforce the frozen budget before each launch.
- Keep task workspaces independent and clean them after Raw evidence is durable.
- Expose `no_action`, rejection, Wiki-only growth, candidate creation, publication, and rollback as different states.
- Do not treat a successful query or Mission status call as evidence that evolution improved a Skill.
- Persist Raw trajectories under the workspace's immutable evolution authority and record the resulting manifest digest in the terminal run receipt.
- Produce terminal run evidence showing that Proposer trace reads resolve only to the matching iteration and attempt's training trajectories and test launches occur only in the final evaluation phase.

## Required Domain Behavior

- Use stable public tools or injected fixtures rather than ad hoc private calls.
- Make write scopes match the task instructions.
- Keep customer-specific commands, identifiers, and business rules in the domain package.
- Validate deterministic runner behavior outside the evolution score, then use real task outcomes to measure whether Skill guidance helps.
