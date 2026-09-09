# Host and Domain Integration

## Ownership

The standalone WikiSkill repository owns the evolution algorithm, workspace layout, role boundaries, dataset contract, gating, and candidate publication.

A host platform may provide repository and workspace identity, frozen context delivery, Provider execution, run monitoring, durable delivery records, and user review surfaces. A domain adapter may provide realistic tasks and fixtures, environment materialization, domain scorers, and real-system acceptance evidence.

Hosts and adapters must consume the generic WikiSkill contracts rather than copy or redefine the evolution method. Use `wikiskill experiment run` as the standard automated entry point. Use separate `experiment prepare`, `experiment audit`, `evolve --experiment`, and `run audit` commands when an external review boundary must sit between preparation and execution.

## Host Contract

- Preserve the active Skill set, target Skill, Wiki, dataset, model, and runtime identities through launch.
- Give an Inference Agent only its current task and keep ground truth, private scorer inputs, other tasks, and the Wiki out of its context.
- Keep validation and test tasks and trajectories out of the Maintainer and Proposer contexts.
- Inject the complete materialized active Skill bundle into every Inference rollout, or record that retrieval is an additional experimental variable.
- Record Provider launches and enforce the selected budget.
- Keep task workspaces independent and clean them after Raw evidence is durable.
- Preserve `no_action`, rejection, Wiki-only growth, candidate creation, publication, and rollback as distinct states.
- Persist Raw trajectories under the workspace evolution authority and record the manifest digest in the terminal run receipt.
- Record typed phases so terminal evidence can demonstrate that Proposer reads resolve to the current training trajectories and test runs only in final evaluation.

## Domain Contract

- Use stable public tools or injected fixtures rather than ad hoc private calls.
- Make write scopes match task instructions.
- Keep customer-specific commands, identifiers, and business rules in the domain package.
- Validate deterministic runner behavior outside the evolution score, then use real task outcomes to measure whether Skill guidance helps.
