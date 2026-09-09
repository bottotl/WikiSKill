# Experiment Design

## Role Separation

WikiSkill has four distinct responsibilities:

1. The Inference Agent solves a domain task using the active Skill and available task tools.
2. The Wiki Maintainer consolidates successful and failing training trajectories into persistent patterns.
3. The Skill Proposer reads the training evidence and Wiki, then proposes one atomic change to one Skill.
4. The validation gate accepts only a strict score improvement; otherwise it restores the prior Skill while retaining the Wiki.

An Inference task such as “optimize this Skill and runner” collapses roles 1 and 3. It measures how well an Agent rewrites the evaluation system, rather than how well the active Skill helps with domain work.

The paper injects the full content of every active Skill into each Inference Agent prompt. This removes triggering and retrieval as experimental variables. If a production host instead uses progressive disclosure, record that deviation and do not compare its result as a direct reproduction.

## Define the Task Distribution

Write tasks in the language of the work users need completed. Examples of valid shapes include:

- diagnose a failed build from supplied logs and produce the supported recovery action;
- transform a spreadsheet while preserving formulas and formatting;
- retrieve evidence from a documented source and return a cited answer;
- operate an application workflow through its public tools and report the resulting state.

Each task must have an observable result that a domain scorer can judge without reading the Agent's hidden reasoning.

## Separate Product Engineering

Treat a deterministic platform defect as infrastructure work when the same input always produces the wrong result regardless of Skill guidance. Repair it with ordinary tests before freezing the experiment. Examples include truncated parser input, broken CLI argument forwarding, incorrect file locking, or a scorer that evaluates the wrong artifact.

A Skill may contain executable scripts, but the Inference Agent should consume their frozen versions during a rollout. The proposer may later change those resources as part of an atomic candidate. Do not let the task checkout silently edit the live Skill authority.

## Freeze Before Running

Record and verify:

- complete active Skill inventory, every Skill digest, and the combined Skill-set digest;
- target Skill digest or explicit empty target baseline;
- persistent Wiki digest;
- dataset digest and scorer identity;
- Provider, model, reasoning effort, and tool profile;
- iteration count, Provider launch budget, and any non-default runner timeout;
- domain adapter and runtime capability digests.

Any drift requires a new preparation step. Do not update an in-flight experiment to match an observed result.

`context prepare` and `evolution baseline` use the same per-Skill and Skill-set digest algorithm. A publishable preflight must compare them, and `evolve` must receive the baseline's active Skill-set digest so context-Skill drift is blocked both before and during snapshot creation.

The paper starts from `(S0, W0) = (empty, empty)`. Seeded evolution of an existing Skill is useful engineering practice supported by WikiSkill, but it is an extension of the reported experimental setup. Use an actual empty Skill and Wiki authority for reproduction claims.
